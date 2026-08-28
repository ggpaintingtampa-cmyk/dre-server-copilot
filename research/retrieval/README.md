# Research Retrieval — design contract

**Status: DESIGN CONTRACT — NOT FULLY IMPLEMENTED**

## Purpose

Turn search queries into **usable, unique, provenance-complete sources** —
the layer responsible for the difference between "a search engine returned
a link" and "we have real, readable content we can analyze and cite."

## Status

Design contract only. No search provider integration, HTTP fetcher,
content extractor, unusable-content detector, Chromium/Playwright fallback,
or dedup logic exists yet.

## Responsibilities

- Run the **first phase**: collect 5 usable, unique sources for a job's
  initial analysis pass.
- Run the **follow-up phase**: for each of the 3 follow-up queries Qwen
  produces (see [`research/analysis/README.md`](../analysis/README.md) —
  one targeting evidence/factual gaps, one targeting primary/authoritative
  evidence, one targeting dissent/contradictions/criticism/limitations/an
  alternate explanation), collect **5 usable, unique sources per query**
  (15 additional total), for a target grand total of **20 usable unique
  sources** per job.
- Treat search results as candidates only — never count a search hit
  toward a quota until content has actually been retrieved and validated.
- Attempt direct HTTP fetch first for every candidate URL.
- Extract readable content from a successful fetch.
- Detect fetches that returned something technically "200 OK" but not
  actually usable (empty, JS-only shell, consent/cookie wall, obviously
  incomplete/truncated content).
- Retry a detected-unusable case with a Chromium/Playwright-driven fetch
  when that's a plausible fix (see below).
- Deduplicate by URL and by substantially duplicate content, not just exact
  URL string match.
- Preserve full provenance for every usable source (see below).
- Persist every usable source, whether or not it's later selected for
  synthesis.
- Never count a failed retrieval attempt toward the 5/15/20 quotas.
- Keep going until a quota is reached or a clearly recorded exhaustion/
  limit condition is hit (e.g. search provider exhausted, a maximum
  attempt budget reached) — never fail silently or hang indefinitely.
- Keep the search-provider and fetch-provider interfaces replaceable.

## Inputs

- A search query string (from either the initial question framing or one
  of Qwen's 3 follow-up queries).
- A target usable-source count for the current phase (5 for the initial
  phase, 5 for each individual follow-up query — 15 total across the three).
- The set of already-collected source URLs/content fingerprints for this
  job, for dedup purposes.

## Outputs

- Zero or more **usable source records**, each with:
  - `title`
  - `url`
  - `domain`
  - `author` (when available)
  - `publication_date` (when available)
  - `retrieved_at` (retrieval timestamp)
  - `retrieval_method` (e.g. `http`, `chromium_fallback`)
  - `discovered_by_query` (the exact search query that surfaced it)
  - `raw_content_path` and `cleaned_content_path` (see
    [`research/projects/README.md`](../projects/README.md) for the storage
    layout these paths live under)
  - `error` (populated on a retained-but-failed attempt record, if the
    design chooses to keep failed attempts for diagnostics — see Non-goals)
- A phase-completion signal: quota reached, or a recorded exhaustion/limit
  condition with a human-readable reason.

## Persistence / state

- Every usable source is saved immediately as it's confirmed usable —
  retrieval does not hold sources in memory until the end of a phase and
  then write them all at once, since that would lose everything already
  found if the worker died mid-phase.
- Source metadata belongs in SQLite (`research.db`); raw and cleaned
  content bodies belong in files on disk, referenced by path from the
  metadata row — see
  [`research/projects/README.md`](../projects/README.md#what-belongs-in-sqlite-vs-files)
  for the exact split and rationale.
- Dedup state (URLs and content fingerprints already collected for this
  job) must be checked against durable, already-persisted records, not
  just an in-memory set for the current process lifetime — so a resumed
  job after a worker restart doesn't re-fetch or double-count sources it
  already has.

## Why Chromium/Playwright fallback sits inside retrieval, not as a later stage

The pipeline's high-level checklist (in
[`research/README.md`](../README.md)) lists "collect 5 sources," then
later "collect 15 more sources," and only after that, ranking and
synthesis — which could read as if a headless-browser fallback is
something bolted on near the end, after normal fetching has already
"failed" in some global sense. That is not the design.

Chromium/Playwright fallback is a **per-URL fetch strategy inside this
retrieval layer**, evaluated fetch-by-fetch, during *either* the first-5 or
any of the three follow-up 5-source collection phases:

1. Attempt a direct HTTP fetch.
2. Run the extracted content through the unusable-content detector (empty
   body, JS-only shell with no server-rendered content, a consent/cookie
   wall page, or content that's clearly truncated/incomplete relative to
   what the page should contain).
3. If detected unusable **and** the situation looks like something a real
   browser render would fix (client-side rendering, a wall that a headless
   browser can navigate past), retry that same URL with
   Chromium/Playwright.
4. Only after both attempts fail is that URL recorded as a failed
   retrieval (not counted toward any quota) and retrieval moves on to the
   next candidate.

This has to be cross-cutting because "does this URL need a real browser to
render" is a property of the **URL/site**, not of which pipeline phase
happens to be running when that URL comes up. A site that requires
JavaScript rendering behaves the same way whether it was discovered by the
original question's search or by one of Qwen's 3 follow-up queries. Treating
Chromium fallback as a distinct "phase 3" step, after both source-collection
phases, would either force it to re-visit URLs from both earlier phases
after the fact (wasteful and delays the pipeline) or would silently drop
JS-only sources encountered during normal collection (contradicting the
"only give up after a genuine retrieval failure" requirement). Keeping it
inside retrieval means every URL gets the same two-tier fetch attempt
regardless of when it was discovered.

## Detecting unusable content

Signals that should trigger Chromium fallback consideration rather than
immediately marking a URL as a failed source:

- Empty or near-empty body after HTML-to-text extraction.
- A body that is overwhelmingly `<script>`/framework boilerplate with no
  extracted readable text (a client-rendered app shell).
- Recognizable consent-wall / cookie-wall / paywall-interstitial patterns
  that block the actual article content.
- Content that is suspiciously short relative to the page's own metadata
  (e.g. an `og:description` or title implying a full article, but
  extracted body text of a sentence or two).

## Deduplication

- **URL-level**: normalize URLs (strip tracking parameters, normalize
  trailing slashes/scheme) before comparing against already-collected
  sources for this job.
- **Content-level**: compare extracted cleaned content against
  already-collected sources' cleaned content (e.g. a similarity/fingerprint
  check) so that two different URLs serving substantially the same
  syndicated article don't both consume quota slots.

## Continuing until quota or exhaustion

- Retrieval for a phase keeps issuing searches/fetches until either the
  phase's target count of usable unique sources is reached, or a defined
  exhaustion condition is hit (e.g. the search provider has no more
  results for the query set, or a maximum fetch-attempt budget for the
  phase has been spent). The exhaustion condition and its reason are
  recorded on the job (visible via
  [`research/queue/README.md`](../queue/README.md)'s current-activity /
  failure-reason fields) — a phase that comes up short of its quota is not
  a silent success, but it is also not necessarily a hard job failure; how
  the pipeline should proceed with fewer than 5 (or fewer than 20 total)
  sources is a synthesis-time judgment call for
  [`research/analysis/README.md`](../analysis/README.md), not something
  this layer decides unilaterally.

## Interfaces / dependencies

- **Search provider adapter**: an interface for "query in, candidate
  URLs+snippets out," so the underlying search engine/API can change
  without touching the rest of retrieval.
- **Fetch provider adapters**: at minimum an HTTP fetcher and a
  Chromium/Playwright fetcher behind a common "fetch this URL, get back
  content or a typed failure" interface.
- Consumed by: [`research/worker/README.md`](../worker/README.md) (drives
  the `initial_fetch`/`followup_fetch` stages), and indirectly by
  [`research/analysis/README.md`](../analysis/README.md) (consumes the
  usable sources this layer produces) and
  [`research/ranking/README.md`](../ranking/README.md) (scores them).
- Depends on: [`research/projects/README.md`](../projects/README.md) for
  where content and metadata are durably written.

## Acceptance criteria

- A job's initial phase does not advance to analysis until either 5 usable
  unique sources are collected or a recorded exhaustion condition is hit.
- A job's follow-up phase does not advance to ranking until either all 3
  follow-up queries have each collected 5 usable unique sources (15
  additional, 20 total) or a recorded exhaustion condition is hit for the
  queries that came up short.
- No search result is ever counted toward a quota without a successful,
  validated content retrieval behind it.
- Every usable source, selected for final synthesis or not, is persisted
  with full provenance and remains queryable afterward.
- Switching the search provider or the fetch provider implementation does
  not require changes to the worker, analysis, or ranking layers.
- A URL that fails plain HTTP fetch due to client-side rendering or a
  consent wall is retried with Chromium/Playwright before being recorded as
  a failed retrieval, regardless of which collection phase it was
  discovered in.

## Non-goals / not implemented yet

- No concrete search provider or Chromium/Playwright integration is chosen
  or implemented yet — this document defines the interface shape and
  behavior contract, not a specific library or API.
- No decision is made here about whether failed retrieval attempts are
  retained as diagnostic records or simply logged and discarded — that's an
  implementation detail left open, as long as failed attempts never count
  toward quotas and never silently swallow the reason for failure from the
  job's recorded activity/failure state.
- No rate-limiting, politeness/robots.txt policy, or provider-specific
  quota management is specified yet.
