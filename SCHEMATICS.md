# DRE Server Copilot — Schematics

This file diagrams the system as it actually runs today (**IMPLEMENTED**)
and, separately and unambiguously, the research pipeline being designed on
top of it (**PLANNED / RESEARCH SYSTEM**). Nothing in the PLANNED section
exists in code yet — it mirrors the design contracts under `research/`.

Diagrams reflect a direct reading of `artifacts/api-server/fastapi_app.py`.
Where an earlier version of this file described a "guarded shell" policy as
current behavior, that has been removed — see the root
[README.md § Known drift](README.md#known-codedocumentation-drift).

---

## IMPLEMENTED

### 1. Browser → FastAPI → OpenAI / Bash

```text
Phone / desktop browser (React SPA)
  │  sessionStorage: dre-agent-token, dre-session-id
  │  HTTPS  Authorization: Bearer <DRE_AGENT_TOKEN>
  ▼
FastAPI / Uvicorn  — 0.0.0.0:$PORT (default 8000)
  │
  ├─ GET  /api/healthz, /health           → no auth, minimal status
  ├─ GET  /api/status                     → auth required
  ├─ POST /api/agent/session/new          → auth required
  ├─ GET  /api/agent/history              → auth required
  ├─ POST /api/agent/chat, /ask (legacy)  → auth required, SSE response
  │     │
  │     ├─ save user message to SQLite
  │     ├─ load bounded history (DRE_HISTORY_MAX_MESSAGES / _CHARS)
  │     ├─ call OpenAI Responses API (model = OPENAI_MODEL), streamed
  │     │     if AgentMessageInput.executeCommands == true:
  │     │         model is offered a `run_shell_command` function tool
  │     │         (no allow/deny filtering beyond "command is non-blank")
  │     ├─ on function_call: run_shell_command() → /bin/bash subprocess
  │     │         as the Uvicorn process user (root on current DRE images)
  │     │         timeout = DRE_SHELL_TIMEOUT_SECONDS (default 300s)
  │     │         output cap = DRE_SHELL_MAX_OUTPUT_CHARS (default 50000)
  │     │         result recorded in SQLite (shell_events), fed back to
  │     │         OpenAI as a function_call_output, loop repeats up to
  │     │         DRE_AGENT_MAX_TOOL_ROUNDS (default 50) times
  │     └─ save final assistant message to SQLite, stream "done" event
  │
  ├─ GET  /api/terminal/history           → auth required
  ├─ GET  /api/terminal/output            → auth required
  ├─ POST /api/terminal/execute           → auth required
  │     └─ same run_shell_command() path, origin="user", no AI involved
  │
  ├─ GET  /api/events                     → auth required, SSE activity feed
  │     └─ in-process ActivityHub pub/sub, filtered by sessionId
  │
  └─ GET  /{path}                         → no auth, serves compiled SPA
        (FRONTEND_DIST/assets mounted as StaticFiles; catch-all falls
         back to index.html; 503 JSON if no build is present)
```

Everything above lives in one Python file
(`artifacts/api-server/fastapi_app.py`) and one Uvicorn process. There is no
message queue, no worker process, and no sandboxing layer between the tool
call and `/bin/bash` today.

### 2. SQLite / history / activity

```text
DRE_STATE_DB_PATH (default /workspace/dre-copilot/state.sqlite3)
  PRAGMA journal_mode=WAL
  │
  ├── chat_messages
  │     id, session_id, role[user|assistant|system], content, created_at
  │     indexed on (session_id, created_at)
  │
  └── shell_events
        id, session_id, origin[user|ai|system],
        command, status[running|completed|blocked|error],
        output, exit_code, created_at, completed_at
        indexed on (session_id, created_at)
```

- Every shell command is written to `shell_events` **before** it runs
  (`status=running`) and updated in place once it finishes.
- `get_history()` reads the newest `DRE_HISTORY_MAX_MESSAGES` rows, then
  trims from the newest backwards to stay under `DRE_HISTORY_MAX_CHARS`
  before that history is sent to OpenAI.
- If SQLite cannot be opened at startup (bad path, permissions, disk full),
  the app still boots; `database_ready=False` and any route needing the
  database returns `503`.
- `ActivityHub` is a purely in-memory `asyncio.Queue` fan-out keyed by
  `sessionId`; it is not persisted and does not survive a process restart.
  SQLite is the reconnect source of truth for history — clients re-fetch
  `/api/terminal/history` or `/api/agent/history` on load/poll and use SSE
  only for live updates while connected.

### 3. TinyMemory

```text
Chat turn begins
  │
  ▼
request_instructions()
  │
  ├─ load_tiny_memory_context()
  │     ├─ importlib.util loads /opt/dre-memory/load_memory.py
  │     ├─ calls load_memory(Path("/var/lib/dre-memory"))
  │     └─ any exception at any step → logged, "" returned
  │
  └─ if memory text is non-empty:
        SYSTEM_INSTRUCTIONS + "\n\nTinyMemory context:\n" + memory
     else:
        SYSTEM_INSTRUCTIONS unchanged
```

TinyMemory failure is always non-fatal to the chat request — this is an
explicit design property, not an accident of exception handling.

### 4. Image startup (current: `v1.3-research`)

```text
ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.2      (base image)
  │
  │  image-research-autostart/Dockerfile, built with repo-root context
  │
  ├─ COPY artifacts/api-server/fastapi_app.py
  │        → /opt/dre-copilot/artifacts/api-server/fastapi_app.py
  │        (bakes the CURRENT backend source into the image)
  │
  └─ patch /opt/dre-vnext/start-dre-vnext.sh:
        insert, right after `set -Eeuo pipefail`:
          if [ -x /workspace/dre-research-runtime/bootstrap.sh ]; then
            (nohup /workspace/dre-research-runtime/bootstrap.sh
              >/tmp/dre-research-bootstrap.log 2>&1 </dev/null &) || true
          fi
        ▼
ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.3-research  (pushed by CI)
```

This patch only *conditionally starts* a bootstrap script if one happens to
exist and be executable at `/workspace/dre-research-runtime/bootstrap.sh` at
container start. The image does not ship that script, and does not contain
any research engine code — see
[`image-research-autostart/README.md`](image-research-autostart/README.md).

### 5. Persistent `/workspace`

```text
/workspace                                   ← plain filesystem path
  ├── dre-copilot/
  │     └── state.sqlite3                    ← chat + shell audit trail
  └── dre-research-runtime/                  ← PLANNED, see below
        └── bootstrap.sh                     ← if present+executable, autostarted
```

`/workspace` durability is entirely a function of RunPod pod/volume
configuration, not anything in this codebase. If no persistent volume is
mounted there, this data is lost on pod replacement. Nothing in the code
detects, warns about, or falls back for that case.

---

## PLANNED / RESEARCH SYSTEM

**Nothing below this line is implemented.** It mirrors the design contracts
in `research/`, most centrally
[`research/README.md`](research/README.md). Consult those files for
authoritative detail — this is a compressed visual summary.

### 6. Research bootstrap hook (planned engine, existing hook point)

```text
DRE image startup (v1.3-research, already implemented — see §4 above)
  │
  ▼
/workspace/dre-research-runtime/bootstrap.sh   ← does not exist yet
  │  (PLANNED) start the research worker as a background, long-lived
  │  process, independent of the Uvicorn/Copilot request lifecycle
  ▼
research worker (PLANNED, see research/worker/README.md)
  │  continuously claims queued jobs from a SQLite-backed queue
  ▼
research pipeline (PLANNED, see research/README.md):
  submit question
    → persistent background queue (research/queue/)
    → collect 5 usable initial sources (research/retrieval/)
    → Qwen analyzes sources, emits exactly 3 follow-up queries (research/analysis/)
    → collect 15 more usable, unique sources (research/retrieval/)
    → score / rank / select evidence, diversity-aware (research/ranking/)
    → final synthesis (research/analysis/)
    → save project (research/projects/)
    → publish to reader (research/reader/)
```

Chromium/Playwright fallback is **not** a separate late stage in this
pipeline — it is a cross-cutting capability inside `research/retrieval/`
that can trigger during either the first-5 or the follow-up-15 collection
phase, whenever ordinary HTTP fetch cannot obtain complete, usable content.
See [`research/retrieval/README.md`](research/retrieval/README.md) for why.

All research runtime state (job queue, source archives, analysis,
rankings, final reports, logs) is designed to live under
`/workspace/dre-research-runtime`, with the same durability caveat as the
rest of `/workspace` (§5 above) — see
[`research/projects/README.md`](research/projects/README.md).

---

## Component READMEs

- [`artifacts/api-server/README.md`](artifacts/api-server/README.md)
- [`artifacts/dre-server-copilot/README.md`](artifacts/dre-server-copilot/README.md)
- [`image-research-autostart/README.md`](image-research-autostart/README.md)
- [`research/README.md`](research/README.md) and its component READMEs
