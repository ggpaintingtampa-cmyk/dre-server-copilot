# Research Projects — design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

## Purpose

Define where and how a research project's entire lifecycle — queue state,
sources, analysis, ranking, and final results — is durably stored, so that
"is this actually saved" has one unambiguous, verifiable answer, and so
that no other component needs to invent its own storage convention.

## Status

Design contract only within this repository. No `research.db` schema,
directory layout, or read/write access pattern ships here. Other component
documents (queue, retrieval, analysis, ranking, reader) all defer to this
document for storage location and the SQLite-vs-files split.

**External validation:** the underlying persistent volume this layout
would live on (`/workspace`, backed by the `BigLittleWeights` RunPod
Network Volume) has been independently verified as accessible and durable
via RunPod's S3 API — see [`docs/storage/README.md`](../../docs/storage/README.md).
A `research_jobs.py` prototype has also informally validated project/queue
row mechanics outside this repository (see
[`research/queue/README.md`](../queue/README.md)). Neither confirms the
`research.db` schema or directory layout below has actually been built —
they remain this document's design, not a shipped result.

## Responsibilities

- Own the canonical runtime root: `/workspace/dre-research-runtime`.
- Define the durable directory/file structure for source archives, cleaned
  text, project metadata, intermediate analysis, ranking data, final
  results, and logs.
- Define what belongs in SQLite (`research.db`) versus what belongs in
  plain files on disk, and why.
- Guarantee that a project's state, once written, is recoverable after any
  of: browser close, DRE chat ending, worker restart, application
  (FastAPI) restart, or a pod restart **when `/workspace` is backed by a
  real persistent volume**.
- Be explicit that ordinary ephemeral container storage is **not** durable,
  and that this system does not pretend otherwise.
- Define the semantics of the user-facing lifecycle states (New,
  Generating, Enriching/Refining, Ready, Read) in terms of what's actually
  been written to storage at each point.

## Inputs

- Writes from every other pipeline component:
  [`research/queue/README.md`](../queue/README.md) (job/queue rows),
  [`research/retrieval/README.md`](../retrieval/README.md) (source
  metadata + content files), [`research/analysis/README.md`](../analysis/README.md)
  (Pass 1 map, final structured analysis, final report),
  [`research/ranking/README.md`](../ranking/README.md) (scoring/selection
  records).

## Outputs

- Reads for: [`research/worker/README.md`](../worker/README.md) (resuming
  a job), [`research/reader/README.md`](../reader/README.md) (rendering a
  finished project and its optional source panel), and any future
  project-listing UI (grouping by user-facing status).

## Expected runtime root

```text
/workspace/dre-research-runtime/
```

Everything this component owns lives under this single root, so operational
tooling (backup, inspection via Server Tools shell access, disk-usage
checks) has one place to look.

## Proposed durable structure

```text
/workspace/dre-research-runtime/
├── research.db                       # SQLite: queue, project metadata,
│                                      #   source metadata, ranking scores,
│                                      #   structured analysis pointers
├── projects/
│   └── <project_id>/
│       ├── sources/
│       │   └── <source_id>/
│       │       ├── raw.html          # or raw.pdf / raw.* — as fetched
│       │       ├── cleaned.txt       # extracted readable content
│       │       └── meta.json         # denormalized copy of the SQLite row,
│       │                             #   for easy inspection/backup
│       ├── analysis/
│       │   ├── pass1-map.json        # preliminary research map (§ analysis)
│       │   └── final-analysis.json   # structured evidence/inference/
│       │                             #   uncertainty/disagreement breakdown
│       ├── ranking/
│       │   └── scores.json           # per-source dimension scores,
│       │                             #   overall score, diversity penalty,
│       │                             #   PRIMARY/SUPPORTING tier, selection
│       │                             #   reason (denormalized; canonical
│       │                             #   copy lives in SQLite)
│       ├── report/
│       │   └── final-report.md       # (or equivalent) the reader-facing
│       │                             #   long-form output
│       └── logs/
│           └── worker.log            # this project's worker activity log
└── logs/
    └── worker.log                    # process-wide worker log (startup,
                                       #   claims, cross-project events)
```

This structure is illustrative, not final — exact filenames/formats can
change during implementation, but the shape (per-project directory,
sources/analysis/ranking/report/logs subdivision, SQLite for structured
queryable data) is the contract other components should assume.

## What belongs in SQLite vs. files

| Data | Location | Why |
| --- | --- | --- |
| Job/queue state (stage, priority, timestamps, claim/heartbeat) | SQLite | Needs transactional, queryable, frequently-updated access — see [`research/queue/README.md`](../queue/README.md) |
| Project metadata (question, user-facing status, created/updated times) | SQLite | Needs to be listed/filtered/sorted for project-list UIs |
| Source metadata (title, URL, domain, author, dates, retrieval method, discovering query, content file paths, errors) | SQLite | Needs to be queryable (e.g. "all sources for project X," dedup checks) and small/structured per row |
| Source raw and cleaned content bodies | Files | Potentially large, not something you want bloating a SQLite row; referenced by path from the SQLite metadata row |
| Ranking dimension scores, overall score, diversity penalty, PRIMARY/SUPPORTING tier, selection reason | SQLite (canonical), optionally denormalized to a project file for easy inspection | Needs to be queryable per-source and joinable against source metadata |
| Pass 1 map, final structured analysis | Files (JSON), pointer/path recorded in SQLite | Structured but potentially large and read as a whole rather than queried field-by-field |
| Final report | File, pointer/path recorded in SQLite | Rendered as a whole document by the reader, not queried in pieces |
| Logs | Files | Append-only, not relational data |

The general rule: **if something needs to be queried, filtered, sorted, or
joined, it belongs in SQLite (at least as metadata); if it's a large blob
read as a whole, it belongs in a file referenced by path from SQLite.**

## Durability guarantees

A project must survive:

- **Browser close** — trivially true, since the browser holds no
  authoritative state (see
  [`artifacts/dre-server-copilot/README.md`](../../artifacts/dre-server-copilot/README.md)
  on `sessionStorage` being client-side-only and non-authoritative).
- **DRE chat ending** — research is never owned by a chat session; see
  [`research/README.md`](../README.md)'s independence requirement.
- **Worker restart** — because all meaningful state is written to
  `research.db` and the files above as it's produced, not held only in
  worker memory; see [`research/worker/README.md`](../worker/README.md).
- **Application (FastAPI) restart** — the research runtime is a separate
  process tree from the FastAPI/Uvicorn app (see
  [`artifacts/api-server/README.md`](../../artifacts/api-server/README.md)),
  so restarting FastAPI has no bearing on research state at all.
- **Pod restart — only when `/workspace` is backed by a real, mounted
  persistent volume.** This is not a guarantee this system can make on its
  own. If `/workspace` is ordinary container-local/ephemeral storage, a pod
  replacement destroys everything under `dre-research-runtime` exactly as
  it would destroy `/workspace/dre-copilot/state.sqlite3` (see the root
  [README.md § Persistence / storage rules](../../README.md#persistence--storage-rules)).
  **This design does not imply, assume, or paper over that risk** — an
  operator is responsible for actually mounting a persistent volume at
  `/workspace` if projects need to survive pod replacement.

## New / Generating / Enriching-Refining / Ready / Read semantics

These are the same five user-facing groups defined in
[`research/README.md`](../README.md#user-facing-project-groups); this
section defines them in terms of what has (or hasn't) been durably written:

| Group | Storage-level meaning |
| --- | --- |
| **New** | A `research.db` project row and queue job exist; no source, analysis, or report files exist yet |
| **Generating** | Queue job is actively advancing through stages; source/analysis/ranking artifacts are being written incrementally as each stage completes |
| **Enriching / Refining** | A previously `Ready`/`Read` project has a new job/stage sequence appended (e.g. a user-triggered refinement) rather than overwriting the prior final report until the new one is ready |
| **Ready** | `report/final-report.md` (or equivalent) exists and is complete; the project has not yet been opened in the reader |
| **Read** | Same as Ready, plus a recorded "opened in reader" marker/timestamp |

Failed/paused/cancelled projects retain whatever was durably written up to
the point of that operational state — per
[`research/queue/README.md`](../queue/README.md), nothing is deleted on
failure, pause, or cancellation.

## Operational hazards (verified)

- **Never hand-edit a live `research.db` (or any live SQLite file under
  this layout) over an S3/Windows mount while a worker or the FastAPI
  process has it open.** SQLite's locking assumptions do not hold reliably
  across an S3-backed network mount plus a Pod-side process writing
  concurrently; this risks corrupting the database. Inspect a copy, or
  inspect while the Pod is stopped. See
  [`docs/storage/README.md`](../../docs/storage/README.md#live-sqlite-files-never-hand-edit-while-in-use).
- **Do not treat file permission bits under `/workspace` as an execution
  trust boundary.** The Network Volume backing `/workspace` does not
  reliably preserve `chmod`. Anything under this layout meant to be
  *executed* (not just stored) — the worker code itself — must be synced
  and hash-verified into `/opt/dre-research` first; see
  [`research/worker/README.md`](../worker/README.md) and
  [`docs/storage/README.md`](../../docs/storage/README.md).

## Failure behavior

- A write failure to `research.db` or the filesystem during any pipeline
  stage is a stage failure for whichever component was writing (see that
  component's own failure-behavior section), not something this document
  papers over — this component defines *where* things go, not how callers
  should react to a write failing.
- If the runtime root itself is missing or not writable at worker startup,
  the worker should fail fast and loudly (structured log, no silent
  no-op) rather than attempting to run a research pipeline it cannot
  persist anything for.

## Interfaces / dependencies

- Every other research component reads and writes through this layout —
  this document is the shared contract preventing each of them from
  inventing its own incompatible storage convention.
- Depends on `/workspace` existing and being writable by the worker
  process; does not depend on the FastAPI backend or DRE chat in any way.

## Acceptance criteria

- Every artifact type listed in the proposed structure has an unambiguous
  home (SQLite row, specific file path, or both) before implementation
  begins.
- A project's full state (queue status, sources with provenance, Pass 1
  map, final analysis, ranking data, final report) can be reconstructed
  entirely by reading `/workspace/dre-research-runtime`, with no
  dependency on any other process's memory.
- Killing and restarting the worker process at any point does not corrupt
  or lose previously-completed stage artifacts for any project.
- An operator can distinguish, from stored data alone, "this project's
  storage is durable" (a real persistent volume is mounted) from "this
  project's storage will vanish on pod replacement" (it is not) — even if
  that distinction has to be confirmed via infrastructure configuration
  rather than application code.

## Non-goals / not implemented yet

- No actual SQLite schema/migration, directory-creation code, or file
  I/O exists yet.
- No backup/export tooling is specified — this document defines the
  layout an operator could back up manually (e.g. via Server Tools shell
  access), not an automated backup system.
- No multi-tenancy or per-user storage partitioning is designed; this
  layout assumes the same single-operator model as the rest of DRE Server
  Copilot.
