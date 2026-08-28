# `artifacts/api-server` — DRE FastAPI backend

This is the entire production backend: one Python module,
`fastapi_app.py` (~680 lines), run under Uvicorn. There is no other server
process in production — this file serves the compiled frontend, the chat
agent, the terminal, and the activity stream, and owns all SQLite state.

This README documents exactly what the current code does. See the root
[README.md § Known drift](../../README.md#known-codedocumentation-drift)
for places where other parts of the repo (docs, tests, frontend, OpenAPI
spec) have not yet caught up to this file.

## Responsibilities

- Serve the compiled React SPA (static files + catch-all route).
- Authenticate every non-public route with a shared bearer token.
- Run an OpenAI Responses API chat loop with an optional shell tool.
- Execute Bash shell commands (from the AI or a manual terminal request) and
  record every one of them.
- Persist chat messages and shell events to SQLite.
- Stream chat responses and live activity to the browser over SSE.
- Load optional TinyMemory context without letting its failure affect a
  normal request.

## Startup

Production command (also documented in the root README):

```sh
python -m uvicorn fastapi_app:app --app-dir artifacts/api-server \
  --host 0.0.0.0 --port "${PORT:-8000}"
```

`app-dir` is required because `fastapi_app.py` is not part of an installed
Python package — it is imported by file location. The FastAPI `lifespan`
context calls `initialize_database()` once at startup, before the app
starts accepting traffic that depends on SQLite.

## FastAPI / Uvicorn

- `app = FastAPI(title="DRE Server Copilot", version="2.0.0", lifespan=lifespan)`.
- CORS is wide open (`allow_origins=["*"]`, `allow_credentials=False`,
  methods `GET`/`POST`, headers `Authorization`/`Content-Type`) — acceptable
  because the only credential is a bearer token in a header, never a cookie.
- All routes are defined directly on `app`; there is no router module split.

## Auth

`require_agent_token()` is a FastAPI dependency attached to every route
except `/api/healthz` and its legacy alias `/health`:

1. If `settings.agent_token` (`DRE_AGENT_TOKEN`) is empty, raise `503` —
   the server refuses to pretend it is "open" when unconfigured.
2. Otherwise, read the `Authorization` header, strip a leading `Bearer `,
   and compare with `hmac.compare_digest` against the configured token.
3. Any mismatch or missing header raises `401`.

There is no session/user concept beyond the client-generated `sessionId`
string (a UUID used purely to partition SQLite rows and SSE delivery — it is
**not** itself a secret or a second factor).

## OpenAI Responses flow

`agent_event_stream()` drives one chat turn end-to-end and yields SSE frames
as it goes:

1. Save the incoming user message to SQLite.
2. Emit `{"type": "agent", "status": "thinking"}` (both as an SSE frame to
   the caller and as an activity-hub broadcast for `/api/events` listeners).
3. Build the `tools` list: `[]` unless `message.executeCommands` is `true`,
   in which case it is a single `run_shell_command` function tool
   (`command`, `reason` arguments).
4. Call `get_openai_client()` (raises if `OPENAI_API_KEY`/
   `AI_INTEGRATIONS_OPENAI_API_KEY` is unset) and build the request:
   `model`, `instructions` (system prompt + optional TinyMemory), `input`
   (flattened conversation history as plain text — see
   `build_openai_input()`), and `tools`.
5. Stream the response via `client.responses.create(..., stream=True)`.
   `stream_openai_response()` yields text deltas as they arrive and
   collects any `function_call` output items plus the final `response`
   object.
6. If the model requested tool calls, run each one through
   `run_shell_command()`, feed the results back as
   `function_call_output` items using `previous_response_id`, and loop.
   This repeats until the model stops requesting tools or
   `DRE_AGENT_MAX_TOOL_ROUNDS` (default `50`, minimum enforced `1`) is
   reached.
7. Once there are no more tool calls, save the final assistant text to
   SQLite and emit a `{"type": "done", "messageId": ...}` frame.
8. On any exception anywhere in this flow, log it, save a generic system
   error message to SQLite, and emit `{"type": "error", "error": ...}`
   instead of raising through the SSE response.

## Request history

- `save_message()` inserts one row per turn into `chat_messages`.
- `get_history()` is the only thing shaping what the model actually sees:
  read the newest `DRE_HISTORY_MAX_MESSAGES` rows (ordered oldest→newest
  after reversal), then walk backwards from the newest message accumulating
  character counts and drop anything once the running total exceeds
  `DRE_HISTORY_MAX_CHARS`. The result is returned in chronological order.
- This means a single very long message can cause older messages to be
  dropped even if the message-count limit hasn't been hit.

## Server Tools gate

`AgentMessageInput.executeCommands: bool = False` is the single flag that
decides whether `tools` is non-empty for a given `/api/agent/chat` (or
`/ask`) call. This is set by the Chat screen's checkbox (labeled "Guarded
checks" in the UI today — see
[Known legacy naming/debt](#known-legacy-namingdebt)). There is no
server-side override, allow-list, or additional confirmation step: if the
flag is `true`, the model can call `run_shell_command` on any turn.

## Bash execution behavior

`run_shell_command(session_id, origin, command)`:

1. `create_shell_event()` inserts a `shell_events` row with
   `status="running"` and broadcasts it over the activity hub immediately —
   before the command runs — so the terminal/activity UI shows commands as
   "running" in near real time.
2. `is_guarded_command(command)` is called. Despite the name, it currently
   only checks `command.strip()` is non-empty; there is no other filtering
   (see [Known legacy naming/debt](#known-legacy-namingdebt)). A blank
   command is recorded with `status="blocked"` and exit code `126`, and
   never reaches a shell.
3. Otherwise, the command runs via
   `asyncio.create_subprocess_shell(command, executable="/bin/bash",
   cwd=Path.cwd())`, capturing merged stdout+stderr.
4. Execution is bounded by `asyncio.wait_for(..., timeout=
   settings.shell_timeout_seconds)`. On timeout, the process is killed and
   whatever output was buffered is kept, annotated with a timeout message;
   the resulting exit code defaults to `124` if the process never reported
   one.
5. Output is decoded as UTF-8 with `errors="replace"`, defaulted to
   `"(No output)"` if empty after stripping, and truncated (with an
   `[Output truncated]` marker) past `DRE_SHELL_MAX_OUTPUT_CHARS`.
6. `status` is `"completed"` only if `exit_code == 0` and the command did
   not time out; otherwise `"error"`.
7. Any exception raised while spawning/communicating with the subprocess is
   caught and recorded as `status="error"`, exit code `1`, with a generic
   message — this is a "the command could not even start" path, distinct
   from the command itself failing.
8. `finish_shell_event()` updates the same SQLite row in place and the
   activity hub is broadcast again with the final state.

This function is shared, unmodified, between AI-invoked commands
(`origin="ai"`) and manual terminal commands (`origin="user"`). There is no
process isolation, container, chroot, or privilege drop applied here — the
command runs with whatever privileges the Uvicorn process itself has, which
on current DRE images is root.

## Command timeout / output / tool-round limits

| Limit | Setting | Default | Enforced by |
| --- | --- | --- | --- |
| Shell command wall-clock timeout | `DRE_SHELL_TIMEOUT_SECONDS` | `300` | `asyncio.wait_for` around `process.communicate()` |
| Captured shell output size | `DRE_SHELL_MAX_OUTPUT_CHARS` | `50000` | String slice + truncation marker after decode |
| Manual terminal command input length | n/a (Pydantic field constraint) | `50000` chars | `TerminalCommandInput.command` `max_length` |
| Model↔tool round-trips per chat turn | `DRE_AGENT_MAX_TOOL_ROUNDS` | `50` (min `1`) | `for _ in range(settings.agent_max_tool_rounds)` loop bound in `agent_event_stream` |

## SQLite tables

See [SCHEMATICS.md § SQLite / history / activity](../../SCHEMATICS.md#2-sqlite--history--activity)
for the full diagram. Summary:

- `chat_messages(id, session_id, role, content, created_at)` —
  `role ∈ {user, assistant, system}`.
- `shell_events(id, session_id, origin, command, status, output, exit_code,
  created_at, completed_at)` — `origin ∈ {user, ai, system}`,
  `status ∈ {running, completed, blocked, error}`.
- `PRAGMA journal_mode=WAL` is set at initialization.
- `initialize_database()` is idempotent (`CREATE TABLE IF NOT EXISTS`) and
  sets module-level `database_ready`/`database_error` flags rather than
  raising, so a bad DB path degrades the app instead of crashing it at
  import/startup time.
- `database_connection()` raises `HTTPException(503)` immediately if
  `database_ready` is `False`, so every DB-backed route fails cleanly and
  consistently rather than throwing a raw `sqlite3` error.

## SSE

Two independent SSE surfaces, both built on the same `make_event()` helper
(`data: <json>\n\n` frames):

- **Chat stream** (`POST /api/agent/chat`, `POST /ask`): a
  `StreamingResponse` wrapping `agent_event_stream()`. Frame types:
  `agent` (status), `message_delta` (text chunk), `tool` (a command
  starting, then its full result), `message` (used only if no deltas were
  streamed — e.g. straight to a cached/instant answer), `done`, `error`.
- **Activity stream** (`GET /api/events`): subscribes to `ActivityHub` for
  one `sessionId`, immediately sends a `connected` frame, then relays any
  published event for that session. If nothing arrives within 20 seconds it
  sends a `: keepalive\n\n` comment frame instead of closing the connection.

`ActivityHub` is in-process, in-memory pub/sub (a dict of
`asyncio.Queue` → `sessionId`, capacity 100 per subscriber, drops events on
a full queue rather than blocking). It is **not** a substitute for SQLite —
reconnecting clients are expected to re-fetch history via the REST endpoints
and use SSE only for events while connected. This also means activity is
only ever delivered to subscribers connected to the *same process*; there is
no cross-process fan-out (Redis, etc.) today, so this design assumes a
single Uvicorn worker/process for activity to work correctly for all
subscribers.

## TinyMemory

See root [README.md § TinyMemory](../../README.md#tinymemory) for the full
description. From the backend's point of view: `request_instructions()` is
called once per chat turn and always returns *something* usable — either
`SYSTEM_INSTRUCTIONS` alone, or `SYSTEM_INSTRUCTIONS` plus a `TinyMemory
context:` block. No exception raised by `load_tiny_memory_context()` ever
propagates past that function.

## Frontend serving

- `FRONTEND_DIST` defaults to `<this file's directory>/frontend-dist`,
  overridable via `DRE_FRONTEND_DIST`.
- If `FRONTEND_DIST/assets` exists, it's mounted at `/assets` via
  `StaticFiles`.
- A catch-all `GET /{full_path:path}` route (excluded from the OpenAPI
  schema) serves a matching file under `FRONTEND_DIST` if one exists,
  otherwise falls back to `FRONTEND_DIST/index.html` for SPA client-side
  routing, otherwise returns a `503` JSON error telling the operator to
  build the frontend first.
- This route has **no** auth dependency — it's how the SPA shell itself
  loads before a token is ever entered. Protection lives entirely in the
  `/api/*` calls the SPA makes after loading.

## API routes

| Method & path | Auth | Request body | Notes |
| --- | --- | --- | --- |
| `GET /api/healthz` | No | — | `{status, database, uptimeSeconds}`; safe for infra checks |
| `GET /health` | No | — | Legacy alias, identical response |
| `GET /api/status` | Yes | query `sessionId` | `{api, openai, shellMode: "server-tools-full-root", database, sessionId, uptimeSeconds, recentCommand}` |
| `POST /api/agent/session/new` | Yes | — | `{sessionId: <new uuid4>}` |
| `GET /api/agent/history` | Yes | query `sessionId` | Bounded chat history, oldest→newest |
| `POST /api/agent/chat` | Yes | `{content, sessionId, executeCommands}` | SSE stream, see above |
| `POST /ask` | Yes | `{content|message|prompt|query, sessionId?, executeCommands?}` | Legacy shape; `sessionId` auto-generated if omitted |
| `GET /api/terminal/history` | Yes | query `sessionId` | Full chronological shell event history (up to 200) |
| `GET /api/terminal/output` | Yes | query `sessionId` | Latest single event, or a "ready" placeholder if none |
| `POST /api/terminal/execute` | Yes | `{command, sessionId}` | Runs a manual command; `400` if blocked (blank command), else `200` |
| `GET /api/events` | Yes | query `sessionId` | SSE activity stream |
| `GET /{path}` | No | — | Compiled SPA / static asset |

## Legacy routes

- `GET /health` — identical to `/api/healthz`, kept for older monitors or
  scripts that call the original path.
- `POST /ask` — identical SSE behavior to `/api/agent/chat`, but its input
  model (`LegacyAskInput`) also accepts `message`, `prompt`, or `query` as
  aliases for `content`, and defaults `sessionId` to a fresh UUID if the
  caller doesn't supply one. `tests/test_dre_server.py` asserts both legacy
  paths remain registered on `app.routes`.

## Important functions

| Function | Role |
| --- | --- |
| `load_tiny_memory_context()` / `request_instructions()` | Optional context injection, failure-isolated |
| `initialize_database()` / `database_connection()` | SQLite lifecycle and the "degrade, don't crash" pattern |
| `save_message()` / `get_history()` | Chat persistence and bounded retrieval |
| `create_shell_event()` / `finish_shell_event()` / `get_shell_history()` | Shell audit trail lifecycle |
| `is_guarded_command()` | Blank-command rejection only (legacy name, see below) |
| `run_shell_command()` | The actual `/bin/bash` execution path, shared by AI and manual commands |
| `get_openai_client()` / `build_openai_input()` / `stream_openai_response()` | OpenAI Responses API integration |
| `agent_event_stream()` | The full per-turn orchestration loop, including the tool round-trip loop |
| `require_agent_token()` | Auth dependency |

## Environment variables

See the root [README.md § Environment variables](../../README.md#environment-variables)
for the full table with defaults; this backend is the sole source of truth
for those defaults (`Settings` class at the top of `fastapi_app.py`).

## Failure behavior

- **No `OPENAI_API_KEY`**: `get_openai_client()` raises
  `RuntimeError("OpenAI is not configured.")`; this is caught by
  `agent_event_stream`'s broad `except Exception`, so the caller sees an
  `error` SSE frame and a system message is saved to history, not a crash.
- **No `DRE_AGENT_TOKEN`**: every protected route (everything except
  `/api/healthz`/`/health`) returns `503` via `require_agent_token`.
- **SQLite unavailable**: `database_ready=False`; `/api/healthz` reports
  `status: "degraded"`; any route touching the database raises `503`
  through `database_connection()`.
- **Shell command exceptions** (subprocess failed to spawn, etc.): recorded
  as a `shell_events` row with `status="error"`, not surfaced as an HTTP
  error, since shell execution always happens inside an already-`200`
  streaming or JSON response.
- **TinyMemory loader missing/broken**: silently ignored, logged at
  `exception` level; chat continues normally with base
  `SYSTEM_INSTRUCTIONS`.
- **No frontend build present**: the catch-all route returns a `503` JSON
  body instructing the operator to build the frontend, rather than a raw
  404 or a stack trace.

## Testing

`tests/test_dre_server.py` imports `fastapi_app` directly (with
`DRE_STATE_DB_PATH` pointed at a temp directory) and covers:

- Shell history ordering (`get_shell_history` selects newest rows but
  returns them chronologically).
- `ActivityHub` only delivering events to the matching `sessionId`.
- The tool-continuation loop preserving `instructions` and `tools` across
  a `previous_response_id` follow-up request.
- Both legacy compatibility routes (`/health`, `/ask`) staying registered.

**Known-broken test**: `test_guarded_mode_excludes_code_executables_but_retains_diagnostics`
reads and writes `dre.settings.allow_shell_execution`, an attribute that no
longer exists on `Settings`. This test currently errors (`AttributeError`)
rather than validating anything, and was **not** fixed as part of this
documentation-only pass — see the root README's known-drift table. A future
change should either delete this test or rewrite it against the current
"Server Tools is the only gate" behavior.

## Known legacy naming/debt

- `is_guarded_command()` — name implies an allow/deny policy; the function
  now only rejects a blank string. Anyone reading the name without reading
  the body will misunderstand current behavior.
- `/api/status`'s `shellMode` field is the literal string
  `"server-tools-full-root"`. The frontend's `ServerStatus.shellMode` type
  and `lib/api-spec/openapi.yaml`'s `shellMode` enum both still say
  `'guarded' | 'unrestricted'`, so status responses do not currently
  type-check against either the frontend types or the published API spec.
- `lib/db`'s Drizzle schema (`conversations`, `messages`) is not imported by
  this backend, which manages its own schema directly via `sqlite3`. Treat
  `lib/db` as inactive scaffolding, not a description of the real schema —
  the real schema is `chat_messages`/`shell_events` as documented above.
