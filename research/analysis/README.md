# Research Analysis — design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

## Purpose

Define the model-driven reasoning role in the pipeline: making sense of
retrieved sources, deciding what's still missing, and eventually producing
a final synthesized answer that is honest about what is evidence, what is
inference, and what is uncertain. Local Qwen is the intended model for this
role, kept behind a replaceable interface rather than hard-coded
everywhere.

## Status

Design contract only. No analysis prompts, Pass 1 map-building logic,
follow-up query generation, or final synthesis logic exists yet — this is
true even though a queue/worker control-plane prototype now exists
externally (see [`research/README.md`](../README.md) and
[`research/worker/README.md`](../worker/README.md)). A real request's
pipeline stage currently refuses explicitly with
`REAL_RESEARCH_PIPELINE_NOT_IMPLEMENTED`; nothing in this component has
been built or validated yet.

## Responsibilities

Two distinct passes, not one blended step:

### Pass 1 — after the initial 5 sources

- Consume the initial 5 usable sources (from
  [`research/retrieval/README.md`](../retrieval/README.md)).
- Identify what is currently known/established across those sources.
- Identify contradictions between sources.
- Identify missing evidence — gaps the 5 sources don't cover but the
  original question needs answered.
- Identify weak claims — assertions present but thinly supported (single
  low-authority source, no primary evidence, etc.).
- Produce a **preliminary research map**: a structured intermediate
  artifact capturing the above, not prose meant for the reader.
- Generate **exactly 3** follow-up search queries, each with a distinct,
  fixed purpose:
  1. **Evidence / factual gaps** — fill in facts the initial 5 sources
     didn't cover.
  2. **Primary / authoritative evidence** — find the strongest, most
     original/official source(s) for claims currently resting on weaker or
     secondary sources.
  3. **Dissent, contradictions, criticism, limitations, or an alternate
     explanation** — actively search for credible disagreement with the
     emerging picture, not just more confirmation of it.
  Each query must expand evidence coverage, not simply reword or
  paraphrase the original question. A follow-up query that would plausibly
  return overlapping results to an already-issued query has failed this
  requirement.
- **The dissent query (#3) is mandatory on every standard project.** If no
  credible dissenting, critical, or materially different source exists for
  a given question, use the query to surface the strongest credible
  limitation or uncertainty instead. **Never manufacture disagreement** —
  the goal is to actively look for it, not to invent it when none exists.

### Final synthesis — after retrieval/ranking of the full evidence set

- Consume **all 20 ranked sources** (or however many were actually
  collected) produced by [`research/ranking/README.md`](../ranking/README.md)
  — the top 5 diverse sources tagged **PRIMARY EVIDENCE** and the rest
  tagged **SUPPORTING EVIDENCE** (or a project-configured override of the
  PRIMARY tier size). **Synthesis is not limited to the PRIMARY tier** —
  supporting evidence is weighed too, just with the PRIMARY tier's sources
  expected to carry the most weight in the final narrative.
- Build the final research output: the long-form content
  [`research/reader/README.md`](../reader/README.md) will display.
- Explicitly distinguish, in the structured output:
  - **Evidence** — directly supported by a specific retrieved source.
  - **Inference** — a reasonable conclusion drawn *from* evidence, but not
    itself stated by any single source.
  - **Uncertainty** — questions the evidence set does not resolve.
  - **Disagreement** — cases where sources conflict, presented as such
    rather than silently resolved in one direction.
- **Never invent source support.** Every claim attributed to a source must
  be traceable to that source's actual retrieved content
  (`cleaned_content_path` in the source record — see
  [`research/projects/README.md`](../projects/README.md)). If the model
  cannot find support for a claim it wants to make, that claim must be
  presented as inference or omitted, not silently attributed to a source
  that doesn't say it.
- Save structured intermediate analysis (the Pass 1 map, and any
  synthesis-time structured breakdown of evidence/inference/uncertainty/
  disagreement) **separately** from the final prose report, so the
  structured data remains available for the optional source/evidence panel
  in the reader (see
  [`research/reader/README.md`](../reader/README.md#optional-sourceevidence-panel))
  without having to re-derive it by re-parsing prose.

## Inputs

- Pass 1: the initial 5 usable source records (cleaned content + metadata).
- Final synthesis: all 20 ranked sources from
  [`research/ranking/README.md`](../ranking/README.md), tagged PRIMARY or
  SUPPORTING evidence, plus the Pass 1 preliminary research map for
  continuity.

## Outputs

- Pass 1: a structured preliminary research map (known facts,
  contradictions, gaps, weak claims) and exactly 3 follow-up query strings.
- Final synthesis: a structured final analysis artifact (evidence/
  inference/uncertainty/disagreement breakdown) plus the final long-form
  prose report consumed by [`research/reader/README.md`](../reader/README.md).

## Persistence / state

- Both the Pass 1 map and the final structured analysis are saved as
  distinct artifacts under project storage (see
  [`research/projects/README.md`](../projects/README.md)), not only as
  ephemeral values passed in-process from one pipeline stage to the next —
  a worker restart between Pass 1 and follow-up retrieval must not lose the
  3 follow-up queries or the reasoning behind them.
- The final prose report and its structured backing analysis are saved
  separately (structured JSON-like artifact vs. rendered report content),
  per the requirement above, so the reader's evidence panel can present
  structured detail without re-parsing prose.

## Failure behavior

- If Pass 1 cannot produce exactly 3 usable follow-up queries (model
  failure, malformed output, fewer than 3 genuinely distinct expansion
  queries identifiable), this is a stage failure for `initial_analysis`,
  handled per [`research/worker/README.md`](../worker/README.md)'s
  failure/retry rules — the pipeline should not silently proceed with 0–2
  queries or invented filler queries.
- If final synthesis cannot produce a report that satisfies the
  evidence/inference/uncertainty distinction (e.g. the model's output
  can't be reliably parsed into that structure), this is a stage failure
  for `synthesis`, not a partially-published report that skips the
  distinction.
- A synthesis run must not proceed by fabricating source support to fill
  gaps in the evidence set — an evidence gap is represented as
  "uncertainty" in the output, never quietly patched over.

## Interfaces / dependencies

- **Model configuration is replaceable.** Local Qwen is the intended model
  for both passes, but the analysis layer should be built against a model
  interface (prompt in, structured result out) rather than embedding
  Qwen-specific business logic throughout the pipeline. This matters
  because the analysis *role* (map-building, follow-up query generation,
  evidence-bounded synthesis) is the actual contract other components
  depend on — [`research/worker/README.md`](../worker/README.md) and
  [`research/retrieval/README.md`](../retrieval/README.md) should never
  need to know which model produced a given analysis artifact.
- Consumes: usable sources from
  [`research/retrieval/README.md`](../retrieval/README.md) and the
  selected evidence set from
  [`research/ranking/README.md`](../ranking/README.md).
- Produces input for: the follow-up retrieval phase (the 3 queries) and
  [`research/reader/README.md`](../reader/README.md) (the final report and
  its structured backing analysis).

## Acceptance criteria

- Pass 1 always yields exactly 3 follow-up queries matching the three
  fixed purposes (gaps, primary/authoritative evidence, dissent), each
  demonstrably targeting the preliminary map rather than restating the
  original question, and the dissent query always either surfaces a
  credible dissenting source or an explicit, non-manufactured limitation/
  uncertainty.
- Final synthesis draws on all 20 ranked sources (PRIMARY and SUPPORTING),
  not only the top 5.
- The final synthesized report never attributes a claim to a source whose
  retrieved content does not support that claim.
- The final report's structured backing data cleanly separates evidence,
  inference, uncertainty, and disagreement, and that structure survives a
  worker restart between synthesis completion and reader publication.
- Swapping the underlying model (Qwen version, or a different local model
  entirely) requires no changes outside this component's model-interface
  boundary.

## Non-goals / not implemented yet

- No prompts, model client integration, or output-parsing logic exists
  yet.
- No automated fact-checking beyond "is this claim traceable to retrieved
  source content" is specified — this component is not designed to verify
  the *truth* of a source's claims, only to avoid misattributing or
  inventing support.
- No multi-model ensemble or cross-model verification step is planned;
  this design assumes a single configured analysis model at a time.
