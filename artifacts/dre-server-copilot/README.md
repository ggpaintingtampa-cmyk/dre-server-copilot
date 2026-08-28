# `artifacts/dre-server-copilot` — production DRE frontend

This is the production React/TypeScript single-page app served by the
FastAPI backend (`artifacts/api-server/fastapi_app.py`). It is the phone-
first UI an operator actually uses to talk to DRE, watch shell activity,
and check server status.

This is **not** the same thing as `artifacts/mockup-sandbox/` — that is a
separate, unshipped design prototype (see its own README).

## Purpose

Give an operator, from a phone browser, three things:

1. A chat interface to DRE, with an opt-in switch that lets the AI run
   shell commands on the server for that turn.
2. A live/replayable feed of every shell command that has run in the
   current session, whoever ran it.
3. A quick operational status snapshot (API/OpenAI/database health, most
   recent command).

## React/Vite architecture

- Build tool: Vite (`vite.config.ts`), package manager: pnpm, workspace
  package name `@workspace/dre-server-copilot`.
- Routing: `wouter` (`App.tsx`), a single real route (`/`) rendering `Home`,
  plus a catch-all `NotFound`.
- Data/query layer: `@tanstack/react-query`'s `QueryClientProvider` is set
  up in `App.tsx`, but the three main views currently fetch data with plain
  `fetch`-based helpers (`src/lib/dre-api.ts`) and `useEffect`/`setInterval`
  polling rather than `useQuery` — react-query is present in the tree but
  not yet the mechanism driving these screens' data.
- UI primitives: a large `src/components/ui/` directory of shadcn/Radix-based
  primitives (button, dialog, tabs, etc.). These are generated/boilerplate
  components and are not individually documented here — see the root
  README's note on proportional documentation detail.
- Entry point: `src/main.tsx` → `App.tsx` → `pages/home.tsx` (`Home`), which
  owns which of the three main views is active.

## Chat / Terminal / Status screens

`Home` (`src/pages/home.tsx`) renders a fixed phone-width shell (header +
content + bottom nav) and keeps all three views mounted simultaneously,
toggling visibility with opacity/`pointer-events` rather than unmounting —
so switching tabs doesn't lose in-flight state like scroll position or a
partially-typed command.

- **Chat** (`src/components/chat-view.tsx`): message history + streaming
  composer. Renders a token-entry prompt if no token is stored yet. Has a
  checkbox — currently labeled **"Guarded checks"** — that sets
  `executeCommands` on the outgoing chat request; this is the literal UI
  control for the backend's Server Tools gate (see
  [Known old wording/type drift](#current-known-old-wordingtype-drift)).
  "New chat" starts a fresh session ID without deleting old history from
  SQLite.
- **Terminal** (`src/components/terminal-view.tsx`): chronological activity
  feed (AI + user + system origins, color-coded) plus a manual command
  composer. The composer's placeholder currently reads **"Explicit
  diagnostic command…"**, which describes a policy the backend no longer
  enforces (see drift section).
- **Status** (`src/components/status-view.tsx`): health, OpenAI
  configuration state, database state, most recent command, and a raw
  `shellMode` string read straight from the backend.

## Token / sessionStorage behavior

Defined in `src/lib/dre-api.ts`:

- `dre-agent-token` — the `DRE_AGENT_TOKEN` value the operator enters in the
  Chat screen. Stored via `sessionStorage.setItem`, **not**
  `localStorage`, and never a cookie. This means the token does not survive
  closing the tab/browser and is not shared across tabs.
- `dre-session-id` — a `crypto.randomUUID()` generated on first use if none
  exists yet, otherwise reused across reloads within the same
  `sessionStorage` scope. `beginNewSession()` overwrites it with a fresh
  UUID (used by Chat's "New chat" button).
- Every authenticated request goes through `authHeaders()`, which attaches
  `Authorization: Bearer <token>` if a token is present, and otherwise sends
  the request unauthenticated (which the backend will reject with `401`, or
  `503` if no `DRE_AGENT_TOKEN` is configured server-side at all).

Because this is `sessionStorage`, closing the browser tab effectively logs
the operator out; there is no "remember me" or persistent login today.

## Session IDs

`sessionId` is a client-generated, non-secret UUID used purely to partition
server-side data (SQLite rows, SSE delivery) — it is **not** an
authentication credential itself. Both the bearer token and the session ID
are required together for any protected request to return data scoped to
"this operator's current conversation."

## Polling

None of the three views currently rely solely on SSE for their own list/
history state — they combine an initial fetch with a polling interval as a
resilience fallback, and use SSE only to make things feel closer to live:

| View | Poll interval | What it re-fetches | SSE used? |
| --- | --- | --- | --- |
| Chat | `5000ms` (`window.setInterval`) | `GET /api/agent/history` | No — chat's own streaming happens over the `/api/agent/chat` SSE response itself, not `/api/events` |
| Terminal | `4000ms` | `GET /api/terminal/history` | Yes — also subscribes to `/api/events` and re-fetches on any activity event |
| Status | `5000ms` | `GET /api/status` | No |

`terminal-view.tsx`'s `shellHistoryMatches()` avoids unnecessary re-renders
by comparing the fetched list to current state (id/status/output/
completedAt) before calling `setEvents`.

## SSE

Two distinct SSE consumers in `src/lib/dre-api.ts`, both parsed by the same
`consumeSse()` helper (splits `\n\n`-delimited blocks, extracts a `data:
` line, `JSON.parse`s it, silently ignores malformed/keepalive frames):

- `sendChat()` — reads the `POST /api/agent/chat` response body as a
  stream directly (this *is* the request/response, not a separate
  `EventSource`), feeding `message_delta`/`tool`/`done`/`error` frames into
  `useAgentChat`'s state.
- `subscribeToEvents()` — opens `GET /api/events?sessionId=...` via `fetch`
  with an `AbortController` (not the browser's native `EventSource`, since
  a custom `Authorization` header is required), and calls back on every
  frame; used by Terminal to trigger a history re-fetch on new activity.

## API integration

All backend calls are centralized in `src/lib/dre-api.ts`: `getHistory`,
`getShellHistory`, `getServerStatus`, `executeCommand`, `sendChat`,
`subscribeToEvents`, plus the token/session helpers above. There is no
generated API client wired in here today — the types (`ChatMessage`,
`ShellEvent`, `ServerStatus`, etc.) are hand-written in this file, separate
from `lib/api-zod` / `lib/api-client-react` / `lib/api-spec`.

## Frontend build

```sh
pnpm --filter @workspace/dre-server-copilot run dev     # local dev server
pnpm --filter @workspace/dre-server-copilot run build   # production build
pnpm --filter @workspace/dre-server-copilot run typecheck
```

Production builds are normally driven by `scripts/build-dre-production.sh`
from the repo root, which also copies the build output into
`artifacts/api-server/frontend-dist/` for FastAPI to serve — see the root
README's [Build instructions](../../README.md#build-instructions).

## Relationship with FastAPI

This app has no backend of its own. In development it runs as a plain Vite
dev server (default port `19646` per `.replit-artifact/artifact.toml`,
overridable via `PORT`/`BASE_PATH`); in production it is not run at all as a
server — its static build output is served directly by the FastAPI process
described in [`artifacts/api-server/README.md`](../api-server/README.md).
Every non-static request this app makes is to that same FastAPI process's
`/api/*` routes (or the legacy `/ask`), same-origin, so no CORS
configuration is needed for the shipped app despite the backend's
wide-open CORS policy.

## Mobile-first design

`Home`'s root container is capped at `max-w-lg` and centered, with a fixed
`h-[100dvh]` header/content/bottom-nav layout modeled on a native mobile
app (bottom tab bar, `pb-safe` safe-area padding, `100dvh` to handle mobile
browser chrome). It renders fine on desktop as a centered phone-width
column, but it is explicitly designed around a phone screen and a
single-thumb bottom nav first.

## Current known old wording/type drift

Recorded here, not fixed in this pass — see the root README's
[Known drift](../../README.md#known-codedocumentation-drift) table for the
authoritative list:

- Chat's checkbox label, `"Guarded checks"`, describes the *old* command
  filtering policy. The backend now treats this flag as an unfiltered
  Server Tools on/off switch, so the label undersells what enabling it
  actually grants (root shell access on the host).
- Terminal's composer placeholder, `"Explicit diagnostic command…"`,
  similarly implies a restriction to diagnostic commands that the backend
  no longer enforces — any command can be submitted here once a valid
  token is present.
- `ServerStatus.shellMode` is typed as `'guarded' | 'unrestricted'` in
  `src/lib/dre-api.ts`, but the backend's `/api/status` response actually
  returns the literal string `"server-tools-full-root"` for that field —
  so today, the app is technically consuming a value its own TypeScript
  type does not admit.

## Future Research/Reader integration direction

The research subsystem being designed under `research/` (see
[`research/README.md`](../../research/README.md)) is explicitly **not**
meant to be read through this chat/terminal/status UI. The direction is a
separate reader experience (see
[`research/reader/README.md`](../../research/reader/README.md)) — a
research library and long-form report view, distinct from DRE's chat
textbox. If/when that is built, this app is the most likely place a
navigation entry point to that reader would eventually live (e.g. a fourth
bottom-nav tab), but no such integration exists yet, and none of this
frontend's code currently references anything under `research/`.
