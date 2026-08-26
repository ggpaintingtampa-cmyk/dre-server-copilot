# DRE Server Copilot — implemented architecture

## Runtime architecture

```text
Phone browser
  │  HTTPS + Authorization: Bearer DRE_AGENT_TOKEN
  ▼
FastAPI / Uvicorn on 0.0.0.0:$PORT (default 8000)
  ├── compiled React static files and SPA routes
  ├── protected DRE chat and SSE response stream
  ├── protected terminal activity and SSE activity stream
  ├── guarded shell authorization and execution
  └── SQLite chat and shell audit history
        │
        ├── OpenAI Responses API
        └── Linux server shell
```

Nginx may proxy to Uvicorn when present, but is optional. The production application is one FastAPI/Uvicorn process; Node.js and pnpm are build-only tools.

## Frontend and backend

The React/TypeScript source lives in `artifacts/dre-server-copilot/`. Build it with:

```sh
sh scripts/build-dre-production.sh
```

That script copies the static build to `artifacts/api-server/frontend-dist/`. `artifacts/api-server/fastapi_app.py` serves those files, assets, and SPA routes directly. The production startup command is:

```sh
python -m uvicorn fastapi_app:app --app-dir artifacts/api-server --host 0.0.0.0 --port "${PORT:-8000}"
```

This is suitable for a container startup command and does not assume systemd.

## Authentication flow

1. An operator enters `DRE_AGENT_TOKEN` in the Chat tab.
2. The token is held in browser session storage only.
3. Protected requests send `Authorization: Bearer <DRE_AGENT_TOKEN>`.
4. FastAPI verifies the token before chat, history, terminal, activity, session, and status routes.
5. `/api/healthz` remains intentionally minimal for infrastructure checks and never reveals secrets, history, commands, paths, or configuration values.

`OPENAI_API_KEY` never reaches the browser, compiled static assets, logs, or API responses.

## OpenAI and shell flow

For a chat with guarded checks enabled:

1. The browser sends the current `sessionId`, prompt, and opt-in flag.
2. FastAPI stores the user message in SQLite and loads bounded recent session history.
3. FastAPI sends that history to the OpenAI Responses API.
4. If the model requests a shell tool call, FastAPI records an `AI` activity event, applies the centralized safety policy, executes or blocks it, records the result, and returns that result to OpenAI.
5. The assistant response streams back to the browser with SSE and is saved to SQLite once complete.

Manual terminal commands use the same shell authorization function but are saved with `origin=user`. Internal operations, if recorded, use `origin=system`.

```text
USER   $ uname -a
AI     $ df -h
SYSTEM shell timeout
```

The activity tab distinguishes each origin visually and shows timestamps, status, output, and exit code.

## SQLite state

`DRE_STATE_DB_PATH` defaults to `/workspace/dre-copilot/state.sqlite3`.

- `chat_messages`: `id`, `session_id`, `role`, `content`, `created_at`
- `shell_events`: `id`, `session_id`, `origin`, `command`, `status`, `output`, `exit_code`, `created_at`, `completed_at`

Roles are `user`, `assistant`, and `system`. Shell origins are `user`, `ai`, and `system`.

History is bounded by `DRE_HISTORY_MAX_MESSAGES` and `DRE_HISTORY_MAX_CHARS` before it enters an OpenAI prompt. The browser retains its session ID across refreshes and can start a new session without deleting existing records.

SQLite persists across application restarts while its filesystem survives. `/workspace` is **not** guaranteed to survive a RunPod replacement unless an actual persistent RunPod volume is mounted there.

## Shell safety

`DRE_ALLOW_SHELL_EXECUTION=false` is the default. In this mode, the app allows only a narrow, tokenized diagnostic command set and rejects shell metacharacters, command chaining, redirects, sensitive paths, non-diagnostic Git operations, and known destructive commands. Blocked requests are recorded with `status=blocked` and are not executed.

With `DRE_ALLOW_SHELL_EXECUTION=true`, authenticated use is broader, but hard destructive patterns, execution timeout, output truncation, exit-code capture, and audit history remain active. Do not enable unrestricted execution on a public or unauthenticated endpoint.

## Environment variables

| Variable | Safe/default value | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Uvicorn listening port |
| `OPENAI_API_KEY` | empty | Server-only OpenAI credential |
| `OPENAI_MODEL` | `gpt-5.6` | Responses API model |
| `DRE_AGENT_TOKEN` | empty | Required bearer token for protected APIs |
| `DRE_ALLOW_SHELL_EXECUTION` | `false` | Enables broader authenticated commands |
| `DRE_STATE_DB_PATH` | `/workspace/dre-copilot/state.sqlite3` | SQLite state location |
| `DRE_HISTORY_MAX_MESSAGES` | `40` | Maximum messages added to a chat prompt |
| `DRE_HISTORY_MAX_CHARS` | `30000` | Maximum history characters added to a prompt |
| `DRE_SHELL_TIMEOUT_SECONDS` | `30` | Command timeout |
| `DRE_SHELL_MAX_OUTPUT_CHARS` | `20000` | Captured output cap |

Copy `.env.example` to a private environment configuration if desired; never commit the real file.

## API summary

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/healthz` | No | Safe health signal |
| `GET /api/status` | Yes | Operational state without secret values |
| `POST /api/agent/session/new` | Yes | Create a session ID |
| `GET /api/agent/history` | Yes | Load a session’s stored chat |
| `POST /api/agent/chat` | Yes | Stream DRE responses and tool activity |
| `GET /api/terminal/history` | Yes | Reload a session’s chronological activity |
| `GET /api/terminal/output` | Yes | Compatibility endpoint for latest output |
| `POST /api/terminal/execute` | Yes | Explicit user command |
| `GET /api/events` | Yes | SSE activity stream |

## Important files

- `artifacts/api-server/fastapi_app.py` — single production app
- `artifacts/api-server/frontend-dist/` — build output served by FastAPI (generated, ignored)
- `artifacts/dre-server-copilot/src/` — React phone UI source
- `lib/api-spec/openapi.yaml` — API contract
- `scripts/build-dre-production.sh` — static frontend build/copy step
- `.env.example` — variable names and safe defaults

## Known limitations

- There is no account system; access is a shared bearer token.
- SSE uses in-process fan-out; a single FastAPI process is the supported target.
- SQLite durability requires a persistent mounted filesystem.
- OpenAI streaming is represented by SSE lifecycle events; provider availability and credentials must be configured separately.