# Research Worker — design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

## Purpose

Be the one process that actually does research work — search, fetch,
analyze, rank, synthesize — running continuously and independently of any
browser tab, DRE chat session, or FastAPI request/response cycle.

## Status

Design contract only. No worker process, claim loop, or lease
implementation exists yet.

## Responsibilities

- Run as a long-lived process, started by
  `/workspace/dre-research-runtime/bootstrap.sh` (the hook the
  `v1.3-research` image already conditionally invokes — see
  [`image-research-autostart/README.md`](../../image-research-autostart/README.md)
  — but whose script does not exist yet).
- Continuously poll/claim eligible queued jobs from
  [`research/queue/README.md`](../queue/README.md), honoring priority and
  FIFO-within-priority.
- Hold each claimed job via a lease so exactly one worker instance
  processes it at a time.
- Drive a claimed job through the pipeline stages
  (`initial_search → initial_fetch → initial_analysis → followup_search →
  followup_fetch → ranking → synthesis → publishing → completed`),
  delegating actual work to [`research/retrieval/README.md`](../retrieval/README.md),
  [`research/analysis/README.md`](../analysis/README.md), and
  [`research/ranking/README.md`](../ranking/README.md).
- Record heartbeat and human-readable progress ("current activity") as it
  works, so the queue's state is always an accurate live picture.
- Resume safely after a restart — including restarting mid-job, not just
  between jobs.
- Detect and recover (or hand back to the queue for recovery) jobs
  abandoned by a previous, now-dead worker instance.
- Emit structured logs.
- Never require a browser or chat connection to make progress on any job.
- Be inspectable and controllable by DRE (chat can ask "what is the worker
  doing" and issue pause/cancel/priority-change requests through the queue)
  **without DRE itself becoming, hosting, or blocking on the long-running
  research process**.

## Inputs

- The job queue (claims, priority, control signals like pause/cancel).
- Project configuration attached to a job (e.g. selection-size override).
- Retrieval, analysis, and ranking provider configuration (API keys, model
  endpoints, provider adapter selection — see
  [`research/retrieval/README.md`](../retrieval/README.md) and
  [`research/analysis/README.md`](../analysis/README.md)).

## Outputs

- Stage transitions and heartbeats written back to the queue.
- Source records, analysis artifacts, ranking data, and final synthesis
  written to project storage (see
  [`research/projects/README.md`](../projects/README.md)).
- Structured log lines (job ID, stage, outcome, timing) suitable for
  operator inspection or DRE-assisted debugging via the existing Server
  Tools shell access — not a bespoke log viewer.

## Persistence / state

- The worker itself should be as close to stateless as possible between
  claim iterations: everything it needs to resume a job (current stage,
  what's already been collected/analyzed) is read back from
  [`research/projects/README.md`](../projects/README.md)'s durable storage,
  not held only in worker process memory. A worker restart mid-job should
  be able to reconstruct exactly where that job was from disk/SQLite alone.
- Heartbeat is written frequently enough that the queue's staleness
  threshold (see
  [`research/queue/README.md#crash-recovery`](../queue/README.md#crash-recovery))
  reliably distinguishes "still working, just slow" from "actually dead."

## Lease / claim mechanism

- A worker claims a job with an atomic, compare-and-set style update
  against the queue's job row (claim succeeds only if the job is currently
  unclaimed and eligible) — see
  [`research/queue/README.md#duplicate-safe--idempotent-transitions`](../queue/README.md#duplicate-safe--idempotent-transitions).
- The claim includes a worker identity and a claim/heartbeat timestamp.
- The worker renews its heartbeat on a fixed interval while actively
  working a job; if it stops (crash, kill, pod loss), the queue's
  staleness check eventually makes the job claimable again.
- A worker should renew or release its lease at stage boundaries at
  minimum, so a crash never loses more progress than "redo the current
  stage," never "redo the whole job."

## Restart / recovery behavior

- On startup, a worker does **not** assume a clean slate: it should look
  for jobs already marked as claimed by a worker identity that is no
  longer itself (or whose heartbeat is stale) and treat them per the
  queue's recovery rules, rather than starting fresh work while orphaned
  jobs sit stuck.
- Restarting the worker process must not duplicate already-collected
  sources or already-completed analysis for a job it resumes — resumption
  reads persisted project state first and only does the remaining work.

## How worker failures affect job status, and retry

- A single job-level exception (e.g. one retrieval attempt errors) should
  be handled within that job's pipeline logic where possible (retry that
  one operation, or treat it as a failed source and continue toward the
  quota) — it should not, by itself, fail the whole job unless it's
  genuinely unrecoverable (e.g. no analysis provider reachable at all).
- A genuinely unrecoverable job-level failure moves the job to `failed`
  with a recorded `failure_reason`, per
  [`research/queue/README.md`](../queue/README.md). It does not delete any
  already-collected sources or partial analysis.
- A worker **process** crash (not a job-level exception) leaves whatever
  job(s) it held claimed to be recovered via the staleness mechanism above
  — this is treated as "abandoned," not "failed," and becomes reclaimable
  without consuming a retry attempt by itself. Only an explicit job-level
  failure (or a job that keeps getting abandoned repeatedly and should be
  surfaced rather than looped forever) should increment `attempt_count`.
- `retry` (an explicit queue operation, see
  [`research/queue/README.md`](../queue/README.md)) re-queues a `failed`
  job from the most advanced stage whose output was durably persisted,
  never forcing a full restart of stages that already produced valid,
  saved output.

## Interfaces / dependencies

- Depends on: [`research/queue/README.md`](../queue/README.md) for claim/
  lease/status, [`research/retrieval/README.md`](../retrieval/README.md),
  [`research/analysis/README.md`](../analysis/README.md), and
  [`research/ranking/README.md`](../ranking/README.md) for the actual
  pipeline work, and [`research/projects/README.md`](../projects/README.md)
  for where to read/write durable state.
- Started by: `/workspace/dre-research-runtime/bootstrap.sh`, invoked by
  the already-shipped conditional hook in the `v1.3-research` image (see
  [`image-research-autostart/README.md`](../../image-research-autostart/README.md)).
  That script itself is part of this component's implementation and does
  not exist yet.
- Inspected/controlled by: DRE chat, indirectly, through the queue's
  status/control surface — never by DRE holding a direct handle on the
  worker process or blocking a chat turn on worker output.

## Acceptance criteria

- The worker runs and makes progress on jobs with no browser tab or DRE
  chat session open.
- Killing the worker process at an arbitrary point and restarting it
  results in jobs continuing correctly, without duplicate work or lost
  progress beyond "redo the current stage" at worst.
- Two worker instances running simultaneously never process the same job
  concurrently.
- A job stuck behind a dead worker becomes claimable again automatically,
  without manual intervention, once the staleness threshold passes.
- DRE chat can query "what is the research worker doing right now" and
  issue queue-level controls (pause/cancel/priority) without DRE itself
  performing retrieval/analysis work or blocking on it.

## Non-goals / not implemented yet

- No actual worker process, executable, or `bootstrap.sh` exists yet.
- No multi-worker/horizontal-scaling deployment is specified beyond "the
  lease mechanism must make it safe if it happens" — a single worker
  instance per deployment is the assumed baseline.
- No dedicated log-aggregation or dashboard is designed; structured logs
  plus existing Server Tools shell access are the assumed inspection path
  for now.
