# DRE Server Copilot

DRE Server Copilot is a phone-first web control surface for administering a
DRE.SMALL RunPod GPU container. A single FastAPI/Uvicorn process serves a
compiled React app and exposes an authenticated chat agent ("DRE") backed by
the OpenAI Responses API. When the operator enables **Server Tools** in the
UI, DRE can execute Bash shell commands directly on the host as the running
process user, in addition to reviewing history and status from a phone
browser.

This document is the canonical entry point for understanding the whole
system — current behavior, current drift between docs and code, and the
research subsystem that is being designed (not yet built) on top of it.

> **Current code always wins over prose.** If anything here disagrees with
> `artifacts/api-server/fastapi_app.py`, the code is correct and this file is
> stale. See [Known drift](#known-codedocumentation-drift) for the drift that
> is already known and intentionally left unfixed by this documentation pass.

## What DRE Server Copilot is

- A **single production backend**: `artifacts/api-server/fastapi_app.py`, run
  under Uvicorn. There is no separate Node.js server in production.
- A **React/Vite frontend** (`artifacts/dre-server-copilot/`) that is built to
  static files and served directly by FastAPI — no separate frontend host.
- A **chat agent** ("DRE") that talks to the OpenAI Responses API, optionally
  with a `run_shell_command` tool the model can call.
- A **terminal/activity view** that shows every shell command run by the user
  or the AI, with live updates over Server-Sent Events (SSE).
- A **status view** reporting API/OpenAI/database health and the most recent
  shell command.
- A **SQLite-backed audit trail** of every chat message and every shell
  command (who ran it, what it was, its output, exit code, and timing).
- A **research subsystem** (`research/`) that is **design-contract-only** at
  this point — see [Research-system roadmap](#research-system-roadmap).

## Current verified production state

This section reflects a direct reading of
`artifacts/api-server/fastapi_app.py` as of this documentation pass (starting
commit `4026cc4`), not the older prose that used to live here.

- **Runtime**: FastAPI + Uvicorn, single process, single Python file.
- **Frontend delivery**: React is compiled ahead of time to static assets and
  served by FastAPI itself (`StaticFiles` mount for `/assets`, a catch-all
  route for the SPA and `index.html`). There is no Node server in production.
- **Authentication**: every protected route depends on `require_agent_token`,
  which compares a caller-supplied `Authorization: Bearer <token>` header
  against `DRE_AGENT_TOKEN` using `hmac.compare_digest`.
- **Server Tools gate**: `AgentMessageInput.executeCommands` (surfaced in the
  UI as a checkbox on the Chat screen) is the **only** thing that decides
  whether the model is given the `run_shell_command` function tool for that
  request. There is no separate server-side allow/deny list gating this.
- **No command whitelist/blacklist**: when the shell tool is available (i.e.
  `executeCommands=true`, or a manual terminal command is submitted), the
  backend's `is_guarded_command()` function only rejects a blank command
  string. It does not parse, tokenize, or restrict the command in any other
  way. The former "guarded" allow-list/deny-list policy has been removed from
  the code even though its name (and some docs) remain — see
  [Known drift](#known-codedocumentation-drift).
- **Execution mechanism**: commands run via
  `asyncio.create_subprocess_shell(command, executable="/bin/bash", ...)`.
  This runs as whatever OS user is running the Uvicorn process. **Current DRE
  images run that process as root**, so an enabled Server Tools session can
  run arbitrary root shell commands on the host.
- **Shell timeout**: `DRE_SHELL_TIMEOUT_SECONDS`, default **300 seconds**.
  On timeout the process is killed and the partial output is annotated.
- **Shell output cap**: `DRE_SHELL_MAX_OUTPUT_CHARS`, default **50,000
  characters**. Output beyond the cap is truncated with a `[Output
  truncated]` marker.
- **Manual terminal command length cap**: `TerminalCommandInput.command` is
  validated by Pydantic to a maximum of **50,000 characters**.
- **Tool-call rounds**: `DRE_AGENT_MAX_TOOL_ROUNDS`, default **50**. This
  bounds how many times the agent loop can go back to the model after
  executing tool calls before it gives up.
- **Conversation history**: bounded to `DRE_HISTORY_MAX_MESSAGES` (default
  **40**) most recent messages and further trimmed to
  `DRE_HISTORY_MAX_CHARS` (default **30,000** characters) before being sent
  to the model.
- **State storage**: SQLite at `DRE_STATE_DB_PATH`, default
  `/workspace/dre-copilot/state.sqlite3`.
- **TinyMemory**: an optional, best-effort context loader. The loader module
  is expected at `/opt/dre-memory/load_memory.py` and its content root at
  `/var/lib/dre-memory`. A failure anywhere in this path is caught and
  logged; it **never** blocks or fails a normal chat request — the agent
  simply proceeds without the extra context.
- **Shell auditing**: every shell command — from the AI tool or from the
  manual terminal — is recorded in SQLite (`shell_events`) with origin,
  status, output, exit code, and timestamps before and after execution.
- **Streaming**: SSE (`text/event-stream`) is used both for the chat response
  stream (`/api/agent/chat`, `/ask`) and for the live activity stream
  (`/api/events`).
- **Legacy routes**: `/health` and `/ask` remain registered for backward
  compatibility alongside their modern equivalents `/api/healthz` and
  `/api/agent/chat`.
- **Current image tag**:
  `ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.3-research`, built by
  `.github/workflows/build-dre-small-v1.3-research.yml` from
  `image-research-autostart/Dockerfile` (context: repository root — see
  [`image-research-autostart/README.md`](image-research-autostart/README.md)).

## High-level architecture

```text
                       Phone / desktop browser
                                │
                 HTTPS  Authorization: Bearer DRE_AGENT_TOKEN
                                ▼
        ┌────────────────────────────────────────────────────┐
        │      FastAPI / Uvicorn  — 0.0.0.0:$PORT (8000)      │
        │  artifacts/api-server/fastapi_app.py                │
        │                                                      │
        │  ┌────────────────────────────────────────────────┐│
        │  │ Compiled React SPA (StaticFiles + catch-all)    ││
        │  └────────────────────────────────────────────────┘│
        │                                                      │
        │  ┌───────────────┐   ┌───────────────┐  ┌──────────┐│
        │  │ /api/agent/*  │   │ /api/terminal/*│  │/api/events││
        │  │ chat + history│   │ manual commands│  │  SSE hub  ││
        │  └───────┬───────┘   └───────┬────────┘  └────┬─────┘│
        │          │                   │                │      │
        │          ▼                   ▼                │      │
        │   OpenAI Responses    run_shell_command()◄─────┘      │
        │   API (function        via /bin/bash as the           │
        │   tool: shell)         Uvicorn process user            │
        │          │                   │                        │
        │          ▼                   ▼                        │
        │   TinyMemory loader   SQLite (chat_messages,           │
        │   (best-effort)       shell_events) — audit trail      │
        └────────────────────────────────────────────────────┘
                    │
                    ▼
        /workspace/dre-copilot/state.sqlite3
        (durable only if /workspace is a real mounted volume)
```

See [SCHEMATICS.md](SCHEMATICS.md) for more detailed diagrams, including
image startup and the research-system bootstrap hook, with IMPLEMENTED vs.
PLANNED clearly separated.

## Backend + frontend relationship

- The frontend (`artifacts/dre-server-copilot/`) is a normal Vite/React app
  during development (`pnpm --filter @workspace/dre-server-copilot run dev`).
- For production, `scripts/build-dre-production.sh` builds the frontend with
  Vite and copies the output (`dist/public`) into
  `artifacts/api-server/frontend-dist/` (generated, git-ignored).
- FastAPI serves that directory directly: `/assets/*` is mounted as static
  files, and a catch-all route serves any other built file or falls back to
  `index.html` for client-side routing. There is no reverse proxy or Node
  server required in production, though Nginx may optionally sit in front of
  Uvicorn in a given deployment.
- The frontend never talks to OpenAI directly and never sees
  `OPENAI_API_KEY`; every model or shell interaction goes through the FastAPI
  backend's authenticated `/api/*` routes.

## Server Tools execution model

"Server Tools" is the umbrella name for **letting the AI or the operator run
shell commands on the host**. There is exactly one boundary that decides
whether that is possible for a given AI turn:

- The Chat screen has a checkbox (currently labeled **"Guarded checks"** in
  the UI — see [Known drift](#known-codedocumentation-drift)) that sets
  `AgentMessageInput.executeCommands`.
- If `executeCommands` is `true`, the backend hands the model a
  `run_shell_command` function tool with a `command` and `reason` argument.
  If it is `false`, no tool is offered and the model cannot run anything.
- Once the tool is available, **there is no further allow/deny filtering**.
  `is_guarded_command()` only rejects an empty command string — the function
  name is legacy and misleading now (see
  [Known drift](#known-codedocumentation-drift)).
- Manual commands typed into the Terminal screen go through the exact same
  `run_shell_command()` execution path (`origin="user"` instead of
  `origin="ai"`), with the same timeout and output cap, and the same SQLite
  audit trail.
- Every command — AI or manual — executes via
  `asyncio.create_subprocess_shell(command, executable="/bin/bash")` as the
  Uvicorn process user. **Current DRE images run Uvicorn as root**, so an
  enabled session effectively grants root shell access to whoever holds the
  bearer token.

There is intentionally no sandboxing, containment, or command filtering
beyond that at the application layer today. Treat `DRE_AGENT_TOKEN`
possession as equivalent to root shell access on the host.

## Authentication

- A single shared secret, `DRE_AGENT_TOKEN`, gates every route except
  `/api/healthz` (and its legacy alias `/health`).
- The frontend stores the token in `sessionStorage` (`dre-agent-token`) —
  **not** `localStorage`, and not a cookie — so it is scoped to one browser
  tab/session and cleared when that tab is closed.
- `require_agent_token()` reads the `Authorization` header, strips a
  `Bearer ` prefix, and compares it to `DRE_AGENT_TOKEN` with
  `hmac.compare_digest` (constant-time comparison).
- If `DRE_AGENT_TOKEN` is unset, every protected route returns `503` rather
  than silently allowing access.
- There is no user account system, no per-user permissions, and no token
  rotation mechanism — this is a single shared bearer token model, suitable
  for a single-operator private server, not multi-tenant use.
- `OPENAI_API_KEY` is a server-only secret. It never reaches the browser,
  the compiled frontend bundle, logs, or any API response body.

## Persistence / storage rules

| What | Where | Durable across restart? | Durable across pod replacement? |
| --- | --- | --- | --- |
| Chat history, shell audit log | SQLite at `DRE_STATE_DB_PATH` (default `/workspace/dre-copilot/state.sqlite3`) | Yes, if the file survives | **Only if `/workspace` is a real mounted persistent volume** |
| Browser session token / session ID | `sessionStorage` in the browser | No — cleared when the tab/window closes | N/A (client-side) |
| TinyMemory content | `/var/lib/dre-memory` (read-only from the app's perspective) | Depends on image/volume | Depends on image/volume |
| Research runtime state (planned) | `/workspace/dre-research-runtime` | Yes, if the file survives | **Only if `/workspace` is a real mounted persistent volume** |

`/workspace` is a plain filesystem path from the application's point of
view. It is **not** inherently durable — nothing in this codebase assumes or
enforces a persistent volume. If a RunPod pod is destroyed and recreated
without a persistent volume mounted at `/workspace`, all SQLite state,
research runtime state, and any other on-disk data at that path is lost.
Treat "persisted to `/workspace`" as "survives process restart," not
"survives infrastructure replacement," unless you have separately verified a
persistent volume is mounted there.

## TinyMemory

TinyMemory is an optional, best-effort source of extra context injected into
the system instructions sent to OpenAI on every chat turn.

- Loader module: `/opt/dre-memory/load_memory.py` (loaded dynamically via
  `importlib.util`, not imported as a normal Python package).
- Content root passed to the loader: `/var/lib/dre-memory`.
- The loader is expected to expose a `load_memory(root: Path) -> str`
  function. Its return value is appended, verbatim as untrusted context text
  (never executed), to `SYSTEM_INSTRUCTIONS` under a `TinyMemory context:`
  heading.
- **Any exception** anywhere in this path — missing loader file, missing
  content root, non-string return value, or a runtime error inside the
  loader — is caught, logged (`logger.exception`), and treated as "no
  TinyMemory context this turn." A TinyMemory failure never fails or blocks
  the chat request itself.
- Neither the loader script nor the content directory is part of this
  repository; both are expected to be baked into the DRE server image or
  mounted at runtime.

## SQLite

- Location: `DRE_STATE_DB_PATH`, default
  `/workspace/dre-copilot/state.sqlite3`. The parent directory is created on
  startup if missing.
- `PRAGMA journal_mode=WAL` is set on initialization.
- Two tables:
  - `chat_messages(id, session_id, role, content, created_at)` — `role` is
    checked to be one of `user`, `assistant`, `system`.
  - `shell_events(id, session_id, origin, command, status, output,
    exit_code, created_at, completed_at)` — `origin` is one of `user`, `ai`,
    `system`; `status` is one of `running`, `completed`, `blocked`, `error`.
- If the database cannot be initialized (bad path, permission error, disk
  full, etc.), the app still starts. `database_ready` is `False`, and any
  route that needs the database returns `503`. `/api/healthz` reports
  `status: "degraded"` and `database: "error"` in that case.
- History returned to the model is first limited to the most recent
  `DRE_HISTORY_MAX_MESSAGES` rows, then trimmed further (from the newest
  backwards) to fit within `DRE_HISTORY_MAX_CHARS` total characters.

## Important paths

| Path | What it is |
| --- | --- |
| `artifacts/api-server/fastapi_app.py` | The entire production backend |
| `artifacts/api-server/frontend-dist/` | Compiled frontend output FastAPI serves (generated, git-ignored) |
| `artifacts/dre-server-copilot/` | React/Vite source for the production phone UI |
| `artifacts/mockup-sandbox/` | Design/prototype sandbox — **not** shipped, see its README |
| `lib/api-spec/openapi.yaml` | Hand-authored/maintained API contract (currently drifted, see below) |
| `lib/api-client-react`, `lib/api-zod`, `lib/db`, `lib/integrations*` | Generated/scaffold support packages, not wired into the production backend today (see [Known drift](#known-codedocumentation-drift)) |
| `image-research-autostart/Dockerfile` | Builds the `v1.3-research` image on top of `v1.2` |
| `scripts/build-dre-production.sh` | Frontend build + copy step used before starting Uvicorn |
| `tests/test_dre_server.py` | Backend regression tests (contains one obsolete test, see below) |
| `.env.example` | Documented environment variable names and defaults |
| `research/` | Design-contract READMEs for the not-yet-built research subsystem |

## Repository map

```text
.
├── README.md                     — this file
├── SCHEMATICS.md                 — architecture diagrams (implemented vs. planned)
├── .env.example                  — environment variable reference
├── artifacts/
│   ├── api-server/                — production FastAPI backend (see its README)
│   ├── dre-server-copilot/        — production React frontend (see its README)
│   └── mockup-sandbox/            — prototype/design sandbox, not production (see its README)
├── image-research-autostart/      — Dockerfile for the v1.3-research image (see its README)
├── lib/                           — shared/generated TypeScript packages (API spec, Zod types,
│                                    generated API client, Drizzle schema, OpenAI integration
│                                    scaffolding) — support packages, not individually documented
├── scripts/                       — build helper scripts
├── tests/                         — backend regression tests
└── research/                      — DESIGN CONTRACTS for the planned research subsystem
    ├── README.md                  — master research architecture
    ├── queue/README.md            — persistent job queue design
    ├── worker/README.md           — independent research worker design
    ├── retrieval/README.md        — source acquisition / fetch layer design
    ├── analysis/README.md         — Qwen analysis & synthesis role design
    ├── ranking/README.md          — evidence scoring & selection design
    ├── projects/README.md         — durable project/storage layout design
    └── reader/README.md           — finished-report reading experience design
```

## Build instructions

Requires Node.js with `pnpm` (frontend) and Python 3.12+ (backend).

```sh
# Install JS workspace dependencies (frontend + shared lib packages)
pnpm install

# Build the production frontend and copy it where FastAPI expects it
sh scripts/build-dre-production.sh
```

`scripts/build-dre-production.sh` runs
`pnpm --filter @workspace/dre-server-copilot run build`, deletes any existing
`artifacts/api-server/frontend-dist/`, and copies the Vite output
(`artifacts/dre-server-copilot/dist/public`) into that directory.

Python dependencies (`fastapi`, `uvicorn`, `openai`, `pymupdf`) are declared
in `pyproject.toml` / `uv.lock`; install with `uv sync` or `pip install -r`
an equivalent export, per your environment's tooling.

## Run instructions

```sh
# 1. Build the frontend first (see above), then:
export OPENAI_API_KEY=...      # required for chat to function
export DRE_AGENT_TOKEN=...     # required — every protected route 503s without it
python -m uvicorn fastapi_app:app --app-dir artifacts/api-server \
  --host 0.0.0.0 --port "${PORT:-8000}"
```

This single command is suitable as a container `CMD`/entrypoint; it does not
assume systemd or a process manager. Copy `.env.example` into your private
server environment file and fill in real secrets there — never commit real
credentials.

For local frontend-only development with hot reload:

```sh
pnpm --filter @workspace/dre-server-copilot run dev
```

## GitHub Actions / image flow

- Workflow: `.github/workflows/build-dre-small-v1.3-research.yml`.
- Triggers: manual (`workflow_dispatch`) or a push that touches
  `artifacts/api-server/fastapi_app.py`,
  `image-research-autostart/Dockerfile`, or the workflow file itself.
- Build context is the **repository root** (`context: .`), with
  `file: ./image-research-autostart/Dockerfile` — required because the
  Dockerfile `COPY`s `artifacts/api-server/fastapi_app.py` from the repo
  root, which is unreachable if the build context were scoped to the
  `image-research-autostart/` directory.
- The built image is pushed to
  `ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.3-research`, i.e. **this
  workflow always publishes the same tag** — it is not versioned per commit.
- The image itself is `ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.2` plus a
  copy of the current `fastapi_app.py` and a startup-script patch. It is
  **not** a from-scratch DRE image build; see
  [`image-research-autostart/README.md`](image-research-autostart/README.md)
  for exactly what the Dockerfile does.

## Environment variables

Source of truth: `Settings` in `artifacts/api-server/fastapi_app.py`. The
table below lists every variable the backend actually reads and its actual
default, cross-checked against the current `.env.example` (kept in sync as
part of this documentation pass).

| Variable | Default if unset | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Uvicorn listening port |
| `OPENAI_API_KEY` | empty (chat disabled) | Server-only OpenAI credential. Falls back to `AI_INTEGRATIONS_OPENAI_API_KEY` if set. |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | — | Alternate credential source (e.g. Replit's integration proxy) |
| `OPENAI_BASE_URL` | provider default | Falls back to `AI_INTEGRATIONS_OPENAI_BASE_URL` if set |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | — | Alternate base URL source |
| `OPENAI_MODEL` | `gpt-5.6` (or `gpt-5.6-terra` when `AI_INTEGRATIONS_OPENAI_API_KEY` is set) | Responses API model name |
| `DRE_AGENT_TOKEN` | empty (all protected routes return 503) | Shared bearer token required on every protected route |
| `DRE_STATE_DB_PATH` | `/workspace/dre-copilot/state.sqlite3` | SQLite database file path |
| `DRE_HISTORY_MAX_MESSAGES` | `40` | Max stored messages loaded into a prompt |
| `DRE_HISTORY_MAX_CHARS` | `30000` | Max total history characters loaded into a prompt |
| `DRE_SHELL_TIMEOUT_SECONDS` | `300` | Shell command timeout, in seconds |
| `DRE_SHELL_MAX_OUTPUT_CHARS` | `50000` | Max captured shell output characters before truncation |
| `DRE_AGENT_MAX_TOOL_ROUNDS` | `50` | Max model↔tool round-trips per chat turn (minimum enforced: 1) |
| `DRE_FRONTEND_DIST` | `<app dir>/frontend-dist` | Where FastAPI looks for the compiled frontend |
| `LOG_LEVEL` | `INFO` | Python logging level |

There is **no** `DRE_ALLOW_SHELL_EXECUTION` variable in the current backend —
it was removed along with the old guarded/unrestricted shell policy. See
[Known drift](#known-codedocumentation-drift).

## API summary

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/healthz` | No | Minimal health signal for infra checks; never reveals secrets |
| `GET /health` | No | Legacy alias for `/api/healthz` |
| `GET /api/status` | Yes | Operational snapshot (OpenAI configured?, DB state, most recent command) |
| `POST /api/agent/session/new` | Yes | Mint a new random session ID |
| `GET /api/agent/history` | Yes | Load a session's stored chat messages |
| `POST /api/agent/chat` | Yes | Stream a DRE agent turn (SSE); may run shell tool calls if `executeCommands` is true |
| `POST /ask` | Yes | Legacy alias for `/api/agent/chat`, accepting `message`/`prompt`/`query` as aliases for `content` |
| `GET /api/terminal/history` | Yes | Chronological shell command history for a session |
| `GET /api/terminal/output` | Yes | Latest single command's state (compatibility shape) |
| `POST /api/terminal/execute` | Yes | Run a manual (`origin=user`) shell command |
| `GET /api/events` | Yes | SSE stream of live agent/shell activity for a session |
| `GET /{path}` | No | Serves the compiled SPA / static asset, or falls back to `index.html` |

Full request/response schemas are meant to live in
[`lib/api-spec/openapi.yaml`](lib/api-spec/openapi.yaml); as of this pass
that file still describes the old `shellMode: guarded | unrestricted` enum
and needs a follow-up fix (see [Known drift](#known-codedocumentation-drift)).

See [`artifacts/api-server/README.md`](artifacts/api-server/README.md) for
full endpoint-by-endpoint detail, request/response bodies, and failure
behavior.

## Research-system roadmap

`research/` contains **design contracts**, not working code, for a
background research pipeline meant to sit alongside DRE chat:

> Submit a question → job goes into a persistent background queue → status
> and priority controls → collect 5 usable initial sources → local Qwen
> analyzes those sources and produces exactly 3 follow-up search queries →
> collect 15 more usable, unique sources → score/rank/select the strongest,
> diverse evidence → final synthesis → save the project → publish to a
> reader UI.

Key properties the design commits to:

- Research runs **independently of DRE chat** — closing the browser or
  ending a chat session must not stop or lose a research job.
- Submitting a job returns immediately; the actual work happens in a
  separate, restart-safe worker process.
- All research state lives under `/workspace/dre-research-runtime`
  (durability rules are the same as for `/workspace` generally — see
  [Persistence / storage rules](#persistence--storage-rules)).
- Chromium/Playwright is a **cross-cutting retrieval fallback**, not a
  distinct late pipeline stage — it can trigger during either the first-5 or
  the follow-up-15 source collection, whenever plain HTTP fetch cannot
  obtain complete, usable content.
- A finished project is read in a dedicated **reader** UI, not the chat
  textbox, with sources retained but collapsed by default.

Read [`research/README.md`](research/README.md) first — it links every
component design contract (`queue`, `worker`, `retrieval`, `analysis`,
`ranking`, `projects`, `reader`). **None of this is implemented yet.** Every
file under `research/` prominently states
`Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED`.

## Documentation philosophy

- **Code wins.** Documentation describes what the code in this repository
  currently does. Where they disagree, the code is correct and the doc is
  stale — flagged, not silently "corrected" into aspirational text.
- **Proportional detail.** Substantial, production-relevant components (the
  backend, the production frontend, the research master plan) get long,
  detailed READMEs. Small, generated, or inactive components get short ones
  or none — see [Repository map](#repository-map).
- **Design contracts are explicitly not done.** Every `research/*/README.md`
  says so at the top, in the same words, so nobody mistakes a design
  document for a status report.
- **Drift gets written down, not silently fixed.** This documentation pass
  intentionally does not touch application source, the frontend, tests, or
  the API schema — see [Known drift](#known-codedocumentation-drift) for
  everything found and left for a follow-up change.

## Known code/documentation drift

Found by direct inspection of the current source during this documentation
pass. None of it is fixed here — this pass is documentation-only.

| Area | What's stale | What's actually true |
| --- | --- | --- |
| Root README (prior version) | Described "guarded shell execution" as current behavior | Server Tools is now an all-or-nothing gate; there is no allow/deny command policy left |
| `.env.example` | Had `DRE_ALLOW_SHELL_EXECUTION=false` | That setting does not exist in `Settings` anymore |
| `.env.example` | Had `DRE_SHELL_TIMEOUT_SECONDS=30` | Backend default is `300` |
| `.env.example` | Had `DRE_SHELL_MAX_OUTPUT_CHARS=20000` | Backend default is `50000` |
| `.env.example` | Missing `DRE_AGENT_MAX_TOOL_ROUNDS` entirely | Backend default is `50` |
| Chat UI (`chat-view.tsx`) | Checkbox labeled `Guarded checks` | It toggles the full, unfiltered Server Tools shell gate, not a guarded subset |
| Terminal UI (`terminal-view.tsx`) | Placeholder text `Explicit diagnostic command…` | Any command can be run once Server Tools access exists; nothing restricts it to diagnostics |
| Frontend types (`dre-api.ts`) | `ServerStatus.shellMode: 'guarded' \| 'unrestricted'` | Backend actually reports the literal string `"server-tools-full-root"` for `shellMode` |
| `lib/api-spec/openapi.yaml` | `shellMode` enum is `[guarded, unrestricted]` | Same mismatch as above; the spec has not been regenerated/updated |
| `tests/test_dre_server.py` | `test_guarded_mode_excludes_code_executables_but_retains_diagnostics` references `dre.settings.allow_shell_execution` | `Settings` has no `allow_shell_execution` attribute; this test currently errors rather than exercising real behavior |
| `fastapi_app.py` naming | Function is named `is_guarded_command` | It no longer implements any guard beyond rejecting a blank string; the name is legacy |
| `lib/db` | Drizzle schema for `conversations`/`messages` exists | Not imported anywhere in `fastapi_app.py`; the production backend uses raw `sqlite3` directly. This package appears to be inactive scaffolding. |

None of these are fixed in this pass by design — this is a
documentation-only change. They are recorded here so a future change can
address the frontend labels, `.env.example`, the OpenAPI spec, and the
obsolete test together, deliberately, rather than by accident.

## Component READMEs

- [`artifacts/api-server/README.md`](artifacts/api-server/README.md) — the FastAPI backend
- [`artifacts/dre-server-copilot/README.md`](artifacts/dre-server-copilot/README.md) — the production React frontend
- [`artifacts/mockup-sandbox/README.md`](artifacts/mockup-sandbox/README.md) — prototype sandbox, not production
- [`image-research-autostart/README.md`](image-research-autostart/README.md) — the `v1.3-research` image build
- [`research/README.md`](research/README.md) — research subsystem master design contract
  - [`research/queue/README.md`](research/queue/README.md)
  - [`research/worker/README.md`](research/worker/README.md)
  - [`research/retrieval/README.md`](research/retrieval/README.md)
  - [`research/analysis/README.md`](research/analysis/README.md)
  - [`research/ranking/README.md`](research/ranking/README.md)
  - [`research/projects/README.md`](research/projects/README.md)
  - [`research/reader/README.md`](research/reader/README.md)

See also [SCHEMATICS.md](SCHEMATICS.md) for diagrams.
