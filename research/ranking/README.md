# Research Ranking — design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

## Purpose

Score and tier up to 20 usable sources into **PRIMARY EVIDENCE** (a small,
strong, diverse top set) and **SUPPORTING EVIDENCE** (everything else) —
through a transparent, explainable scoring model, not an opaque "Qwen just
picks its favorites" judgment call. Unlike an earlier version of this
contract, ranking here does **not** discard the non-top sources: all 20
are handed to final synthesis, tiered rather than filtered.

## Status

Design contract only. No scoring implementation, weighting configuration,
or diversity-aware selection (MMR or otherwise) exists yet.

## Responsibilities

- Score every usable source collected for a job (all 20, or however many
  were actually collected if a phase came up short of quota) along
  multiple normalized dimensions.
- Combine those dimension scores into an overall score using a documented,
  tunable weighting — not a black-box single number with no explanation.
- Apply diversity-aware selection to choose the **PRIMARY EVIDENCE** tier
  (default: top 5) on top of raw scoring, so it isn't several
  near-duplicate articles that all happened to score well individually.
  Every source not chosen for PRIMARY becomes **SUPPORTING EVIDENCE** — it
  is not discarded.
- Persist every component score, the overall score, a diversity penalty/
  similarity measure, the PRIMARY/SUPPORTING tier assignment, and a
  human-readable selection reason for every scored source.
- Leave all usable sources in storage regardless of tier — ranking tiers
  what goes into synthesis, it never deletes or excludes anything from it.

## Inputs

- All usable sources collected for a job (from
  [`research/retrieval/README.md`](../retrieval/README.md)), with their
  full metadata and cleaned content.
- Project-level configuration, if any, overriding the default selection
  size (default: **best 5 diverse sources**).

## Outputs

- Per-source scoring records: each dimension score, the overall weighted
  score, a diversity penalty/similarity value relative to already-selected
  PRIMARY sources, and a short selection reason string (e.g. "PRIMARY: high
  authority + high relevance, sufficiently distinct from source X" or
  "SUPPORTING: near-duplicate of higher-scoring source Y").
- **All 20 ranked sources**, each tagged PRIMARY or SUPPORTING, handed to
  [`research/analysis/README.md`](../analysis/README.md) for synthesis —
  synthesis considers the full set, not only PRIMARY.

## Persistence / state

- All scoring data (dimension scores, overall score, diversity penalty,
  selection reason) is saved per source as part of project storage (see
  [`research/projects/README.md`](../projects/README.md)) — this is
  intermediate analysis/ranking data, not something recomputed on demand
  each time a project is viewed.
- The selected evidence set is recorded explicitly (not just "the top N by
  score") so a later inspection of "why was this source used in the final
  report" is answerable directly from stored data.

## Scoring model

Proposed normalized score dimensions (each source scored roughly `0.0`–
`1.0` per dimension before weighting):

| Dimension | What it measures |
| --- | --- |
| **Relevance** | How directly the source's content addresses the research question (and, for follow-up sources, the specific gap/query that found it) |
| **Source authority / credibility** | Domain reputation, publication type (primary reporting, established outlet, academic/official source vs. low-quality aggregator) |
| **Evidence density** | How much of the source's content is substantive, on-topic material vs. filler/boilerplate |
| **Freshness (when relevant)** | How recent the source is, weighted only when recency plausibly matters to the question (a historical/timeless question should not penalize older sources) |
| **Completeness** | Whether the retrieved content is a full, coherent piece (vs. a partial/truncated extraction, even if it passed retrieval's usability check) |
| **Primary / independent evidence value** | Whether the source is original/primary reporting or independent analysis, vs. one of several outlets restating the same primary source |

### Weighted scoring — tunable, not proven

A proposed initial weighting (illustrative starting point):

```text
overall_score =
    0.30 * relevance
  + 0.20 * authority_credibility
  + 0.15 * evidence_density
  + 0.10 * freshness              (0 weight when freshness is not relevant to the question)
  + 0.15 * completeness
  + 0.10 * primary_independent_value
```

**These weights are a starting configuration to calibrate against real
results, not a mathematically derived or proven-correct formula.** They
should live in configuration (per-deployment or per-project override), not
be hard-coded as if they were settled science. Expect them to change as
real research output is reviewed.

## Diversity-aware selection (MMR-style)

Raw `overall_score` ranking alone can produce a final set of several
sources that all say nearly the same thing (e.g. five outlets syndicating
the same wire story). To avoid that, selection should use a
**Maximal-Marginal-Relevance-style** approach:

1. Select the single highest-`overall_score` source first.
2. For each subsequent pick, choose the source that maximizes a
   combination of its own `overall_score` **and** its dissimilarity to
   sources already selected (a content-similarity measure — this is the
   "diversity penalty" persisted per source).
3. Repeat until the target selection size (default 5) is reached or the
   remaining candidate pool is exhausted.

This guarantees the final evidence set trades off "individually strong" and
"collectively non-redundant," rather than optimizing only the former.

## PRIMARY / SUPPORTING evidence tiers

Ranking classifies every scored source into exactly one tier:

- **PRIMARY EVIDENCE** — the default **best 5 diverse sources** selected by
  the MMR-style process above. Expected to carry the most weight in the
  final synthesized narrative.
- **SUPPORTING EVIDENCE** — every other usable source (up to 15 more).
  Still passed to synthesis in full, still fully provenanced, just not
  weighted as heavily by default.

A project's configuration (see
[`research/queue/README.md`](../queue/README.md)'s per-job `config_json`)
may override the PRIMARY tier size later; the scoring/selection algorithm
itself should accept the target size as a parameter rather than
hard-coding `5`. **Final synthesis always considers both tiers** — the
tiering is a weighting signal for synthesis, not a filter that excludes
SUPPORTING sources from it.

## Failure behavior

- If fewer usable sources exist than the target selection size (e.g. only
  3 usable sources were collected in total), selection simply returns all
  of them, scored and ranked, without treating that as a ranking failure —
  the shortfall itself is a retrieval-stage/exhaustion concern (see
  [`research/retrieval/README.md`](../retrieval/README.md)), not something
  ranking papers over.
- If scoring cannot be computed for a source (e.g. missing content), that
  source is recorded with a clear reason for exclusion rather than being
  silently dropped from the record.

## Interfaces / dependencies

- Consumes: all usable sources from
  [`research/retrieval/README.md`](../retrieval/README.md).
- Produces input for: [`research/analysis/README.md`](../analysis/README.md)'s
  final synthesis pass.
- Depends on: [`research/projects/README.md`](../projects/README.md) for
  where scoring/selection records are stored.
- Scoring weights and selection size should be read from configuration,
  not hard-coded, so they can be tuned without a code change.

## Acceptance criteria

- Every usable source collected for a job has a persisted dimension-score
  breakdown, overall score, diversity penalty, and selection reason, not
  just the selected subset.
- The PRIMARY tier is not simply "top N by raw score" when near-duplicate
  high-scoring sources exist — diversity-aware selection measurably
  changes the outcome in that case.
- Every one of the 20 ranked sources — PRIMARY and SUPPORTING alike — is
  actually passed to and considered by final synthesis; none are silently
  dropped at the ranking stage.
- Changing the scoring weights or the default selection size does not
  require touching retrieval, analysis, or worker code.
- A human reviewing a project's stored ranking data can answer "why was
  source X used (or not used) in the final report" without guessing.

## Non-goals / not implemented yet

- No specific similarity metric (e.g. embedding cosine similarity vs.
  simpler lexical overlap) is chosen yet — this document specifies the
  *behavior* (diversity-aware selection, MMR-style trade-off), not the
  exact implementation.
- The weights above are not final and are not claimed to be optimal; they
  exist to give an implementation something concrete to start from and
  calibrate.
- No UI for manually reviewing/overriding ranking decisions is specified
  yet — see [`research/reader/README.md`](../reader/README.md) for what the
  reader does and does not expose about ranking today.
