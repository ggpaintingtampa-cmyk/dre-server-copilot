# DRE Research System — master design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

Nothing under `research/` exists as working code **in this repository**.
This directory is a set of design contracts written *before* implementation
so that whoever builds this system (human or AI) has an agreed target
architecture to build against, instead of inventing one ad hoc
mid-implementation. Every file under `research/` repeats this status line
so it can never be mistaken for a status report on a shipped feature.

The one thing that already exists in this repository related to this
system is a conditional startup hook in the `v1.3-research` DRE image (see
[`image-research-autostart/README.md`](../image-research-autostart/README.md))
that will start `/workspace/dre-research-runtime/bootstrap.sh` in the
background *if* it exists and is executable. That script does not exist in
this repository.

**External prototype validation (not part of this repository):** a
control-plane prototype now exists on the persistent volume at
`/workspace/dre-research-runtime/app/` (`research_jobs.py`,
`research_worker.py`, `research_pipeline.py`, `start-research-worker.sh`).
Informal runtime testing has passed for queue operations, priority/FIFO,
move-to-top, pause/resume, cancel, restart/retry, read/unread/archive,
worker heartbeat, duplicate-worker protection, crash recovery,
process-group cancellation, worker shutdown, project cleanup, and a
`CONTROL_TEST` check. **A production research database and production
worker have not been initialized, and the real research pipeline is not
implemented** — a real request currently refuses explicitly with
`REAL_RESEARCH_PIPELINE_NOT_IMPLEMENTED`. This validates that the
*queue/worker control-plane mechanics* described below are buildable as
designed; it does not mean the pipeline (retrieval → analysis → ranking →
synthesis) exists or works yet. See
[`docs/storage/README.md`](../docs/storage/README.md) for how the
underlying persistent volume itself has been verified.

## Purpose

Let an operator ask DRE a research question and get back a properly
sourced, synthesized, long-form answer — without that work blocking chat,
without losing progress if the browser or chat session closes, and with
every claim traceable back to a real, retrieved, unique source.

## Status

Design contract. No queue, worker, retrieval, analysis, ranking, project
storage, or reader code exists yet. This document and its linked component
documents are the specification the eventual implementation must satisfy.

## Target user flow

```text
Submit question
  │
  ▼
persistent background queue (research/queue/)         ← job created, returns immediately
  │  status + priority controls available from here on
  ▼
collect 5 usable initial sources (research/retrieval/) ← search != source; only usable,
  │                                                        unique, retrieved content counts
  ▼
Qwen analyzes those 5 sources (research/analysis/, "Pass 1")
  │  → identifies known facts, contradictions, gaps, weak claims
  │  → produces a preliminary research map
  │  → generates EXACTLY 3 follow-up search queries, each with a distinct
  │     purpose:
  │       1. evidence / factual gaps
  │       2. primary / authoritative evidence
  │       3. dissent, contradictions, criticism, limitations, or an
  │          alternate explanation
  │     (queries expand evidence, never paraphrase the original question)
  ▼
collect 5 additional usable, UNIQUE sources PER follow-up query
  │  (research/retrieval/) — 15 total across the 3 queries, 20 overall
  ▼
score / rank ALL 20 sources (research/ranking/)
  │  transparent, tunable scoring + diversity-aware selection (MMR-style)
  │  top 5 diverse sources → PRIMARY EVIDENCE; remaining 15 → SUPPORTING
  │  EVIDENCE (unless project config overrides the PRIMARY tier size)
  ▼
final synthesis (research/analysis/, "synthesis" pass)
  │  considers ALL 20 sources — PRIMARY and SUPPORTING — not only the top 5
  │  distinguishes evidence, inference, uncertainty, disagreement
  │  never invents source support; never manufactures disagreement
  ▼
save project (research/projects/)
  │  durable under /workspace/dre-research-runtime
  ▼
publish to reader (research/reader/)
     long-form report; sources retained but collapsed by default
```

**Chromium/Playwright fallback is not a step in this list.** It is a
cross-cutting capability inside the retrieval layer, usable during *either*
the first-5 or any follow-up-5 collection phase — see
[Why Chromium fallback lives in retrieval](#why-chromiumplaywright-fallback-lives-in-retrieval-not-as-a-late-stage)
below and the fuller explanation in
[`research/retrieval/README.md`](retrieval/README.md).

## Core requirements

- **Independent of DRE chat.** Research jobs run in a separate worker
  process (see [`research/worker/README.md`](worker/README.md)), not inside
  a chat request/response cycle. DRE chat can *create* and *inspect* jobs,
  but it must never be the process actually doing the work.
- **Submitting a job returns quickly.** `POST` a question, get back a job
  ID immediately; all subsequent work happens asynchronously.
- **Closing the browser/chat does not stop research.** A job's lifecycle is
  owned by the queue/worker, not by any client connection.
- **Jobs and progress survive worker restarts.** State is written to
  durable storage at each meaningful step, not held only in worker memory
  — see [`research/queue/README.md`](queue/README.md) for crash-recovery
  semantics and [`research/projects/README.md`](projects/README.md) for the
  storage layout.
- **Persistent state lives under `/workspace/dre-research-runtime`.** Same
  durability caveat as the rest of `/workspace`: durable across process and
  pod restarts only if `/workspace` is backed by an actual mounted
  persistent volume, not an assumption this system gets to make on its own.
- **Search result ≠ usable source.** A search engine hit is a *candidate*.
  It only counts toward the 5-per-phase quota (initial phase, or any one of
  the 3 follow-up queries) once content has actually been retrieved, is
  non-empty, is meaningfully readable, and is not a duplicate of an
  already-collected source.
- **Every project actively seeks credible dissent.** The third follow-up
  query is always aimed at dissent, contradictions, criticism, limitations,
  or an alternate explanation. If no credible dissenting source exists for
  a question, the strongest credible limitation or uncertainty is used
  instead — disagreement is never manufactured to satisfy this requirement.
- **Save every usable source, even unselected ones.** Ranking/selection for
  final synthesis does not delete or hide sources that weren't chosen —
  see [`research/ranking/README.md`](ranking/README.md) and
  [`research/projects/README.md`](projects/README.md).
- **Source metadata/provenance is always retained.** Title, URL, domain,
  author (when available), publication date (when available), retrieval
  timestamp, retrieval method, the query that discovered it, and content
  file paths persist for every usable source, whether or not it made the
  final cut.
- **Sources don't clutter the reader by default, but are always available.**
  The default reading experience shows synthesized findings; the full
  source list is present but collapsed unless explicitly requested — see
  [`research/reader/README.md`](reader/README.md).
- **Local Qwen performs research analysis/synthesis** where a model is
  appropriate, rather than OpenAI/DRE's chat model — see
  [`research/analysis/README.md`](analysis/README.md) for why this is kept
  swappable rather than hard-coded.
- **Provider adapters, not hard-coded providers.** Search and fetch
  providers (and the model used for analysis) are designed as replaceable
  interfaces from day one — see [`research/retrieval/README.md`](retrieval/README.md)
  and [`research/analysis/README.md`](analysis/README.md).

## Why Chromium/Playwright fallback lives in retrieval, not as a late stage

The high-level checklist above lists retrieval before ranking and
synthesis, which could suggest headless-browser fetching is something that
happens "later." It is not. Chromium/Playwright is a **fallback fetch
strategy inside the retrieval layer**, invoked per-URL, any time ordinary
HTTP fetch fails to produce complete, usable content — whether that URL was
discovered during the *first* 5-source collection phase or *any of the 3
follow-up* 5-source phases. It is cross-cutting because "this page needs a real
browser to render" is a property of the URL, not of which phase of the
pipeline discovered it. See
[`research/retrieval/README.md`](retrieval/README.md) for the detection
heuristics and fallback flow.

## User-facing project groups

The reader and any project list UI should group jobs/projects by
**user-facing status**, distinct from the more granular internal pipeline
stage (see [`research/queue/README.md`](queue/README.md)):

| User-facing group | Meaning |
| --- | --- |
| **New** | Job created, not yet meaningfully started (queued, not yet claimed) |
| **Generating** | Actively running: initial search/fetch/analysis through synthesis |
| **Enriching / Refining** | Optional follow-on work after an initial result — e.g. a user-triggered re-run, deeper follow-up, or refinement pass on an already-synthesized project |
| **Ready** | Synthesis complete, project saved, available to read, not yet opened |
| **Read** | Opened in the reader at least once |

**Failures/paused/cancelled are operational states, tracked separately**
from this user-facing grouping — a project that failed, was paused, or was
cancelled should be visible to an operator/administrator view but does not
need to occupy one of the five user-facing groups above as if it were a
normal in-progress state. See
[`research/queue/README.md`](queue/README.md#user-facing-vs-internal-statuses)
for exactly how internal stage, operational state, and user-facing group
relate to each other.

## Component READMEs

| Component | Weight | Covers |
| --- | --- | --- |
| [`research/queue/README.md`](queue/README.md) | Medium | Persistent job queue, priorities, pause/resume/cancel/retry, crash recovery |
| [`research/worker/README.md`](worker/README.md) | Medium | The independent long-running process that actually executes jobs |
| [`research/retrieval/README.md`](retrieval/README.md) | Medium | Source acquisition: search, HTTP fetch, Chromium fallback, dedup, provenance |
| [`research/analysis/README.md`](analysis/README.md) | Medium | Qwen's Pass 1 (map + follow-up queries) and final synthesis roles |
| [`research/ranking/README.md`](ranking/README.md) | Medium | Transparent scoring model + diversity-aware (MMR) selection |
| [`research/projects/README.md`](projects/README.md) | Medium | Durable storage layout under `/workspace/dre-research-runtime`, SQLite vs. files |
| [`research/reader/README.md`](reader/README.md) | Medium | The finished long-form reading experience, separate from DRE chat |

Every one of the above documents its own Purpose, Status, Responsibilities,
Inputs, Outputs, Persistence/state, Failure behavior,
Interfaces/dependencies, Acceptance criteria, and Non-goals, per the
convention set for this documentation pass.

## Non-goals of this document

This master document intentionally does not specify database column names,
API route shapes, or class/module boundaries — those live in the linked
component documents. This document exists to fix the pipeline shape, the
5-initial / 3×5-follow-up / 20-total source-count contract, the
PRIMARY/SUPPORTING evidence tiers, the dissent requirement, the
independence-from-chat requirement, and the Chromium-fallback placement so
the component documents can't drift from each other on those points.
