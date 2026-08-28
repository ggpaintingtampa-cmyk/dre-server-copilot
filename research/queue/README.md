# Research Queue — design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

## Purpose

Give research jobs a durable, ordered, restart-safe home so that submitting
a question is a fast, fire-and-forget action, and so that "what is
happening to my research right now" is always answerable by reading state,
never by asking a live in-memory process that might not exist anymore.

## Status

Design contract only within this repository. No queue table, API, or
worker-facing claim mechanism ships here. This document defines what must
exist before [`research/worker/README.md`](../worker/README.md) can be
implemented against it.

**External prototype validation:** a prototype (`research_jobs.py`) exists
outside this repository, on the persistent volume at
`/workspace/dre-research-runtime/app/`. Informal runtime testing there has
passed for: queue operations, priority/FIFO ordering, move-to-top
reordering, pause/resume, cancel, restart/retry, read/unread/archive,
duplicate-worker protection, crash recovery, and project cleanup. This
demonstrates the mechanics below are implementable as designed — it is not
a production database, and the surrounding pipeline (retrieval, analysis,
ranking, synthesis) is not implemented, so no research job actually
completes end-to-end yet.

## Responsibilities

- Store every research job (project) as a durable row with an ID, its
  current internal stage, its user-facing status, its priority, and
  timestamps.
- Provide FIFO ordering within equal priority, and let priority be changed
  after submission.
- Provide pause / resume / cancel / retry as explicit, safe state
  transitions.
- Track enough per-job detail (progress stage, current activity, failure
  reason) that a UI or DRE chat can answer "what's happening with job X"
  without contacting a live worker.
- Survive the worker process dying mid-job: no job should be silently lost
  or silently stuck forever in a state that looks like it's still running.

## Inputs

- A new job: the research question/prompt, an optional priority, and
  optional project-level configuration (e.g. an override to the default
  PRIMARY-tier size of 5 diverse sources — see
  [`research/ranking/README.md`](../ranking/README.md)).
- Control operations against an existing job ID: change priority, pause,
  resume, cancel, retry.
- Worker-side updates: stage transitions, heartbeat/progress, completion,
  failure with a reason.

## Outputs

- A job/project ID, immediately, on submission.
- Queryable job state: internal stage, user-facing status, priority,
  created/updated timestamps, current activity description, failure reason
  (if any).
- The ordered claim candidate list a worker consumes (see
  [`research/worker/README.md`](../worker/README.md)).

## Persistence / state

- **SQLite-backed**, living under `/workspace/dre-research-runtime`
  alongside the rest of research state (see
  [`research/projects/README.md`](../projects/README.md) for the full
  storage layout and the SQLite-vs-files split). The queue table(s) are
  part of that same database (proposed name: `research.db`), not a
  separate store — a job's queue row and its project data should be
  transactionally close enough that "job says completed but project data
  doesn't exist" cannot happen from a partial write.
- Proposed job row shape (illustrative, not final):
  `id, question, priority, internal_stage, user_status, created_at,
  updated_at, claimed_by, claimed_at, heartbeat_at, attempt_count,
  failure_reason, config_json`.
- Every state-changing operation (claim, stage advance, pause, cancel,
  retry, complete, fail) is a single transactional update to this row, so a
  reader never observes a torn/partial state.

## Internal stages (suggested)

```text
queued
initial_search
initial_fetch
initial_analysis
followup_search
followup_fetch
ranking
synthesis
publishing
completed
failed
paused
cancelled
```

These are the fine-grained stages a worker reports progress against. They
are deliberately more granular than the user-facing groups defined in
[`research/README.md`](../README.md#user-facing-project-groups) — a UI
should translate internal stage → user-facing group, not expose internal
stage names directly as the primary status a user reads.

### User-facing vs. internal statuses

Three layers, each answering a different question:

| Layer | Answers | Example values |
| --- | --- | --- |
| Internal stage | "Exactly where is the pipeline right now?" | `initial_fetch`, `followup_search`, `ranking` |
| Operational state | "Is this job actually making progress?" | `running`, `paused`, `failed`, `cancelled` |
| User-facing group | "What should a person see in their project list?" | `New`, `Generating`, `Enriching/Refining`, `Ready`, `Read` |

`failed`, `paused`, and `cancelled` are **operational states** layered on
top of internal stage — a job can be `paused` while its internal stage
value stays wherever it was when the pause happened, so resuming can pick
up from that exact point rather than restarting the pipeline. Operational
states are visible in an operator/admin view; they don't need to be forced
into one of the five user-facing groups, per
[`research/README.md`](../README.md#user-facing-project-groups).

## Priority and ordering

- Priority is a simple ordered value (e.g. an integer, higher = sooner).
  Within equal priority, jobs are claimed strictly **FIFO** by creation
  time.
- **Change priority**: an explicit operation that only touches the
  priority column and `updated_at` — it never touches internal stage or
  claim state. A worker's *next* claim query picks it up sooner; a job
  already claimed and running is not interrupted by a priority change.
- **Reorder where reasonable**: for equal-priority jobs, allow explicit
  reordering (e.g. "move to top of this priority band") by adjusting a
  secondary ordering key (e.g. an effective-created-time or explicit
  sequence number) rather than by mutating `created_at` itself, so audit
  history of "when was this actually submitted" is preserved.

## Pause / resume / cancel / retry

- **Pause**: only valid while `internal_stage` is not already terminal
  (`completed`, `failed`, `cancelled`). Sets operational state to `paused`
  and must be safe to call whether or not a worker currently holds the
  claim — if a worker is mid-step, it should notice the pause request and
  stop advancing at the next safe checkpoint rather than being killed
  mid-write (see [`research/worker/README.md`](../worker/README.md)).
- **Resume**: clears `paused`, becomes eligible for claiming again from
  wherever `internal_stage` left off. Resuming never re-runs already
  completed retrieval/analysis for that stage — it continues.
- **Cancel**: terminal. Sets operational state to `cancelled`; a worker
  that notices mid-job stops and leaves already-collected sources/analysis
  in place (per [`research/README.md`](../README.md)'s "save every usable
  source" requirement) rather than deleting partial work.
- **Retry**: only valid from `failed`. Increments `attempt_count`, clears
  `failure_reason`, and re-queues either from the failed stage or from
  `queued` depending on how safely that stage's work can be resumed
  (idempotency requirement below) — a retry is not required to redo
  already-successful earlier stages (e.g. a synthesis failure should not
  force re-collecting all 20 sources).

## Crash recovery

- A worker holds a job via a **lease** (claim timestamp + heartbeat), not
  an in-memory-only lock — see
  [`research/worker/README.md`](../worker/README.md) for the claim
  mechanism itself. The queue's job here is simply to expose `claimed_by`,
  `claimed_at`, and `heartbeat_at` so that a job whose heartbeat has gone
  stale (worker died, was killed, or the pod restarted) is detectable and
  can be released back to `queued` — a lease renewal query, not a
  destructive one.
- No job may be permanently stuck in a "someone is working on this"
  operational state with no worker actually alive. Recovery is: if
  `heartbeat_at` is older than a defined staleness threshold and the job is
  not in a terminal state, treat it as abandoned and make it claimable
  again (optionally recording this as a retry attempt).

## Duplicate-safe / idempotent transitions

- Every transition (claim, stage advance, pause, resume, cancel, retry,
  complete, fail) must be safe to attempt twice — e.g. via a
  compare-and-set on the row (`UPDATE ... WHERE id = ? AND
  internal_stage = ? AND claimed_by IS NULL`) so two workers racing to
  claim the same job, or a client double-submitting "cancel," never
  produces conflicting or duplicated side effects.
- Submitting the same question twice is **not** deduplicated by this layer
  — that is a product decision left to whatever calls into the queue, not
  something the queue enforces unilaterally.

## Interfaces / dependencies

- Consumed by: [`research/worker/README.md`](../worker/README.md) (claims
  and advances jobs), a future DRE-chat-facing submission surface (creates
  jobs, reads status), and [`research/reader/README.md`](../reader/README.md)
  (reads user-facing status/group for listing).
- Depends on: the storage layout defined in
  [`research/projects/README.md`](../projects/README.md).

## Acceptance criteria

- Submitting a job returns an ID and a `queued` state without waiting on
  any retrieval/analysis work.
- Killing the worker process mid-job, then restarting it, results in the
  job eventually completing (or reaching a clearly recorded `failed` state
  with a reason) — never in a job silently stuck forever with no worker
  aware of it.
- Two worker processes running concurrently never process the same job at
  the same time.
- Changing priority on a queued job measurably affects claim order without
  disturbing any job already claimed.
- Pausing a running job stops forward progress at a safe checkpoint and
  resuming continues from that checkpoint, not from scratch.
- Cancelling a job at any stage preserves already-collected sources and
  analysis rather than deleting them.
- Retrying a failed job does not needlessly redo already-completed,
  successfully-persisted earlier stages.

## Non-goals / not implemented yet

- No actual SQLite schema/migration exists yet — the row shape above is
  illustrative.
- No API routes for job submission/control exist yet.
- No UI for priority/pause/resume/cancel/retry exists yet.
- No multi-worker horizontal scaling story beyond "the lease mechanism
  should make it safe" is designed — a single worker process is the
  assumed initial deployment (see
  [`research/worker/README.md`](../worker/README.md)).
