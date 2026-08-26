# DRE Server Copilot

A phone-first web control surface for chatting with a DRE agent, reviewing terminal output, and approving safe server inspection commands.

## Run & Operate

- `python -m uvicorn fastapi_app:app --app-dir artifacts/api-server --host 0.0.0.0 --port $PORT` — run the FastAPI DRE agent (artifact workflow; port 8080)
- `pnpm --filter @workspace/dre-server-copilot run dev` — run the React/Vite development server only
- `sh scripts/build-dre-production.sh` — build the React frontend and copy it into FastAPI’s static directory
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Runtime configuration is documented in `.env.example` and `SCHEMATICS.md`; SQLite is used instead of PostgreSQL.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: FastAPI + OpenAI Responses API
- Frontend: React + Vite + TanStack Query
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Production runtime: one Python/FastAPI/Uvicorn process serving the compiled React files

## Where things live

- `artifacts/dre-server-copilot/` — mobile web experience.
- `artifacts/api-server/fastapi_app.py` — single FastAPI runtime: static frontend, DRE agent, SQLite state, SSE, auth, and shell guard.
- `lib/api-spec/openapi.yaml` — typed contract used by the frontend client.
- `SCHEMATICS.md` — full production architecture, environment, startup, and persistence notes.

## Architecture decisions

- Terminal commands are centrally guarded and audited as `user`, `ai`, or `system`; unrestricted execution still requires authentication and `DRE_ALLOW_SHELL_EXECUTION=true`.
- Chat and activity use SSE; SQLite is the reconnect source of truth.

## Product

- Three mobile tabs: AI chat, copyable terminal output with explicit commands, and server status.
- The AI agent can use a guarded shell tool when command execution is enabled per request.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
