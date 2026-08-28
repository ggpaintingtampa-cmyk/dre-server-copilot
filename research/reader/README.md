# Research Reader — design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

## Purpose

Define the finished reading experience for a completed research project.
**The reader is not the DRE chat textbox** — it is a dedicated,
publication-style view for reading a synthesized report, browsing past
research, and optionally drilling into sources, built for phone and
desktop reading rather than conversational back-and-forth.

## Status

Design contract only. No reader UI, list view, or report rendering exists
yet. Nothing in the current production frontend
([`artifacts/dre-server-copilot/README.md`](../../artifacts/dre-server-copilot/README.md))
references this component.

## Responsibilities

- Present a **research library/list** of a user's projects.
- Group/filter that list by the user-facing status groups defined in
  [`research/README.md`](../README.md#user-facing-project-groups) (New,
  Generating, Enriching/Refining, Ready, Read), plus visibility into
  operational states (failed/paused/cancelled) per
  [`research/queue/README.md`](../queue/README.md#user-facing-vs-internal-statuses).
- Render a **long-form readable report page** per project, including:
  - Title
  - The original question
  - Completion time
  - A summary
  - Structured sections (as produced by
    [`research/analysis/README.md`](../analysis/README.md)'s synthesis
    output)
  - Findings
  - Uncertainty/disagreement callouts where the synthesis identified them
    as useful to surface
- Provide an **optional source/evidence panel**, collapsed/hidden by
  default, that a reader can expand on request.
- Retain and expose **all source provenance** underneath that panel, even
  though it isn't shown by default.
- Let a user **mark unread/ready research as Read**, moving a project from
  the `Ready` group to the `Read` group (see
  [`research/projects/README.md`](../projects/README.md#new--generating--enriching-refining--ready--read-semantics)).
- Provide a **good reading layout on both phone and desktop** — this is
  explicitly a reading surface, not a repurposed chat view, so its layout
  priorities are typography, section navigation, and comfortable long-form
  scrolling rather than a message-bubble conversation UI.
- **Never mutate research data by opening it.** Viewing a report is a
  read-only operation against already-saved project state, aside from the
  explicit, user-initiated "mark as Read" action.
- **Publish from saved project state, not from transient AI output.** The
  reader renders whatever
  [`research/projects/README.md`](../projects/README.md) has durably
  stored for a project (`report/final-report.md` or equivalent) — it never
  renders a live/streamed model response the way DRE chat does.

## Inputs

- A project ID (from the research library list, or a direct link/
  navigation into a specific project).
- The project's stored final report, structured analysis, source records,
  and user-facing status (all from
  [`research/projects/README.md`](../projects/README.md)).

## Outputs

- The rendered report view.
- A "mark as Read" state change, written back to project storage as the
  only data mutation this component performs.

## Persistence / state

- The reader is a **read path**, not a data producer, with the single
  narrow exception of the "mark as Read" flag/timestamp.
- Opening a project for reading must not trigger, restart, or influence
  any pipeline stage, queue state, or worker activity — reading and
  researching are fully decoupled. This is why "opening reader must not
  change research data" is listed as a hard requirement rather than an
  implementation detail: it prevents a future implementation from, say,
  triggering a "refresh" or partial re-synthesis just because a user opened
  a report.

## Failure behavior

- If a project's report file is missing or unreadable despite the project
  being marked `Ready`/`Read` in metadata, the reader should surface that
  as a clear, specific error (data-integrity problem) rather than a blank
  page or a generic "not found."
- If a project is still `Generating`, the reader should show its current
  status (deferring to
  [`research/queue/README.md`](../queue/README.md)'s current-activity
  data) rather than attempting to render a partial/incomplete report as if
  it were finished.
- A failure to load the optional source/evidence panel should not break
  the main report view — the report itself must always be viewable
  independent of whether the source panel loads successfully.

## Interfaces / dependencies

- Reads from: [`research/projects/README.md`](../projects/README.md)
  (final report, structured analysis, source records, status).
- Reads status/progress from: [`research/queue/README.md`](../queue/README.md)
  for projects not yet `Ready`.
- Distinct from, and not a replacement for: DRE chat in
  [`artifacts/dre-server-copilot/README.md`](../../artifacts/dre-server-copilot/README.md) —
  see that document's
  [Future Research/Reader integration direction](../../artifacts/dre-server-copilot/README.md#future-researchreader-integration-direction)
  for how the two are expected to eventually connect (most likely a
  navigation entry point from the existing phone UI, not a merge of the two
  experiences).

## Acceptance criteria

- A user can list, filter/group, and open research projects without any
  dependency on an active DRE chat session or an active research worker
  run (beyond the worker having produced the data being read).
- The default report view never shows the raw source list unless the user
  explicitly expands it.
- Every source behind that panel retains its full provenance (title, URL,
  domain, author, date, retrieval method, discovering query) exactly as
  collected — the reader does not summarize away provenance fields.
- Opening a report, scrolling it, and closing it produces zero writes to
  project storage beyond an optional, explicit "mark as Read" action.
- The report reads comfortably on a phone-width viewport and on a wider
  desktop viewport without separate, divergent content.

## Non-goals / not implemented yet

- No reader UI, routing, or component implementation exists yet.
- No commenting, annotation, sharing, or export functionality is specified
  — this document defines the read experience only.
- No real-time "live" view of an in-progress project's synthesis is
  planned; a `Generating` project shows status/progress, not a streaming
  preview of partial synthesis output.
- No integration point in the current production frontend
  (`artifacts/dre-server-copilot/`) exists yet — see that component's own
  README for the direction this is expected to take.
