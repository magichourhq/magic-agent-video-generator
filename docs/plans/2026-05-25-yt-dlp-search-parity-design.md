# yt-dlp Search Parity with the YouTube Data API

**Date:** 2026-05-25
**Status:** Design approved, pending implementation
**Scope:** `backend/app/tools/youtube_short.py` (yt-dlp search path only)

## Motivation

The YouTube Data API gives better semantic accuracy than yt-dlp for scene
clip selection, but it is quota- and cost-limited. We want yt-dlp to be an
unlimited, free path that matches the Data API's accuracy so we can rely on it
without burning quota.

Two real failures motivated this:

- **Deep sea (scene 1):** right video absent from the yt-dlp pool.
- **Ancient coins (scene 2):** weak yt-dlp candidate pool; transcript/visual
  overlap let unrelated coin-cleaning footage pass. The Data API found better
  candidates.

Root causes:

1. **Pool quality.** yt-dlp `ytsearch`/`ytsearchdate` cannot replicate the Data
   API's `order=relevance` + `videoCategoryId` filtering, so the right video
   sometimes never appears.
2. **Metadata starvation.** `--flat-playlist` returns truncated or missing
   descriptions, so `_candidate_score` and `_candidate_has_scene_specific_metadata`
   (which match against title + description) have far less text to work with
   than the Data API path, which carries full snippets.

## Goals

- yt-dlp candidate pool reliably contains the right video (recall).
- yt-dlp ranking + acceptance gate operate on rich metadata comparable to the
  Data API (precision).
- The Data API path stays **byte-for-byte unchanged**.
- No new latency on the Data API path; bounded extra latency on yt-dlp
  (hydrate top few only: ~2-6s/scene).

## Non-goals

- Replacing the Data API. It remains the default and the accuracy reference.
- Hydrating every candidate (rejected for latency).
- A feature flag — the yt-dlp path is already opt-in via `search_provider`.

## Design

### 1. Wider flat pool (recall)

`_yt_dlp_search_candidates` currently fetches `limit` (5) flat rows. Raise the
**flat** fetch to a larger pool (`YT_DLP_FLAT_POOL_SIZE`, ~12) so the right
video is more likely present. The number of candidates ultimately *accepted* is
unchanged. Still a single flat request — cheap.

Factual recency is already handled by `ytsearchdate` (mirrors the Data API's
`order=date` + `publishedAfter`). The one pool lever yt-dlp's search cannot
replicate is `videoCategoryId`; that is handled as a soft post-hydration filter
(see §3) rather than at search time.

### 2. Hydrate top-N (precision)

New step between flat ranking and acceptance:

1. Flat-rank the wide pool with `_candidate_score`. Title is present in flat
   mode and carries the dominant entity-token weight (1.5 vs description 0.5),
   so flat ranking is a usable prefilter.
2. Take the top N (`YT_DLP_HYDRATE_TOP_N`, ~5) and hydrate each via **one**
   `yt_dlp --print` call against `watch?v=<id>` returning a tab-joined line of
   `description`, `categories`, `tags`, `duration`. Wrap with
   `--ignore-errors --no-warnings`.

   **Hydration runs in parallel.** The N per-video extractions are dispatched
   concurrently via a `ThreadPoolExecutor` (bounded, `YT_DLP_HYDRATE_WORKERS`,
   ~5) inside the scene worker thread, so the step costs ~max(per-call) instead
   of the sum. This keeps the added latency at ~2-4s/scene rather than ~3-8s.
   Each scene already runs in its own thread (`asyncio.to_thread`), so this is a
   nested, bounded pool — total concurrent yt-dlp subprocesses stay modest.
3. Merge hydrated fields onto the candidate. A failed/empty hydration leaves the
   flat metadata in place — the candidate is never dropped.
4. Re-rank and run `_candidate_has_scene_specific_metadata` on the rich
   metadata.
5. Populate `_VIDEO_DURATION_CACHE` from the same call so the downstream
   `_video_duration` for the selected clip is a cache hit — net zero extra
   fetches for that clip. Cache hydrated metadata by `video_id`.

### 3. Scoring, tags, and category filtering

- **Tags into scoring.** `_candidate_score` folds hydrated `tags` into the
  description-tier match (weight 0.5). Title/channel weights unchanged. A video
  tagged `ancient coins`/`numismatics` scores correctly even with a thin
  description. Tags are only present for yt-dlp candidates, so the Data API path
  is unaffected.
- **Category as a soft pool filter.** Replaces what the Data API gets from
  `videoCategoryId`. After hydration, for factual/news queries
  (`_needs_news_category`), down-weight (not hard-reject) candidates whose
  hydrated `categories` are off-topic. Soft penalty keeps a thin pool from
  collapsing to zero; the scene-fail decision stays with the acceptance gate, so
  we fail a scene only when *everything* is genuinely off-topic rather than
  stitching unrelated footage.
- **Acceptance gate.** `_candidate_has_scene_specific_metadata` runs on hydrated
  text, giving the yt-dlp path the same full-description + tags signal the Data
  API path already enjoys.

### Tunable constants

- `YT_DLP_FLAT_POOL_SIZE` (~12)
- `YT_DLP_HYDRATE_TOP_N` (~5)
- category soft-penalty weight

## Performance & timing

Scenes run in parallel (`download_youtube_clip_assets` → `asyncio.gather` over
`to_thread`), so clip-sourcing wall-clock ≈ the slowest scene, independent of
scene count.

`_video_duration` already does a per-candidate yt-dlp extraction today (up to
`TRANSCRIPT_CANDIDATE_LIMIT`). Hydration merges metadata into that same call and
caches it, so later duration fetches become cache hits — the net new cost is
only the extra extractions beyond what we already pay, run in parallel.

Estimated per-scene impact:

| Step | Today | With changes |
|---|---|---|
| Flat search (1 call) | ~1-3s @ 5 rows | ~1.5-3.5s @ 12 rows |
| Hydrate top-N (parallel) | — | +~2-4s |
| Duration fetch (transcript loop) | ~1-3s | ~0s (cache hits) |
| Transcript fetch | ~1-3s ×1-2 | unchanged |
| Section download | ~3-10s | unchanged |
| **Per-scene total** | **~12-20s** | **~15-26s (+3-6s)** |

These are structural estimates, not measured. yt-dlp extraction is
network/throttle-bound (0.5-2s typical, can spike under rate-limiting); a wider
pool issues more requests per scene, so heavy-throttle worst cases get worse.

### Timing probe

Add a small offline-capable benchmark (`scripts/bench_yt_dlp_search.py` or a
`-m pytest` marker gated behind a `RUN_YT_DLP_BENCH` env var so CI skips it) that:

- Runs `_search_section_video_candidates` for a fixed set of sample sections
  (the deep-sea and ancient-coins cases) under `search_provider="yt_dlp"`.
- Records wall-clock for flat search, hydration, and total, plus the
  per-attempt `duration_ms` already captured in `_search_benchmark`.
- Prints a small table so before/after numbers replace the estimates above.

This requires network access (real yt-dlp calls); it is a manual/opt-in probe,
not part of the deterministic unit suite.

## Testing

Unit tests (pure, offline) in `tests/test_fast_pipeline.py`:

- `_candidate_score` folds tags: thin-description + on-topic-tags candidate
  outscores an off-topic one.
- Hydration merge: parse tab-joined `--print` line; malformed/empty line leaves
  flat metadata intact.
- Category soft-penalty: off-category candidate down-ranked, not removed; all
  off-category → pool still non-empty (fail decision stays with acceptance gate).
- Wider pool: flat search requests `YT_DLP_FLAT_POOL_SIZE`; accepted count
  unchanged.
- Hydration subprocess failure swallowed per-candidate; flat candidate survives.
- Cache: hydration populates `_VIDEO_DURATION_CACHE`; second selection is a hit.

Mocking: patch at the hydration-function boundary / monkeypatch
`subprocess.check_output` so tests stay offline and deterministic.

Regression guard: assert the Data API path is unchanged — tags/category logic
only activates when those fields are present, which the Data API never supplies.

Manual verification (high-effort): re-run the two real cases search-only with
`search_provider="yt_dlp"` — deep-sea scene 1 → submersible candidate;
ancient-coins scene 2 → confirm the wider pool + hydration surfaces a real
coins-restoration match.

## Rollout

No flag. yt-dlp is opt-in via `search_provider`; the Data API default is
untouched. TDD throughout (test → red → implement → green).
