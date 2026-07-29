# yt-dlp Search Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the yt-dlp YouTube search path as accurate as the YouTube Data API path (wider recall pool + rich-metadata hydration + tag/category-aware scoring) while leaving the Data API path byte-for-byte unchanged.

**Architecture:** Inside `backend/app/tools/youtube_short.py`, the yt-dlp search (`_yt_dlp_search_candidates`) gains a wider flat pool, then hydrates only its top-N flat-ranked candidates in parallel via a bounded `ThreadPoolExecutor` of `yt_dlp --print` calls. Hydrated `description`/`categories`/`tags`/`duration` are merged onto candidates, re-ranked, gated, cached into `_VIDEO_DURATION_CACHE`, and fed to the existing acceptance gate. Scoring folds hydrated `tags` into the description tier and applies a soft category penalty for off-topic factual/news queries. The Data API path never supplies `tags`/`categories`, so all new logic is inert there.

**Tech Stack:** Python 3, `subprocess` + `yt_dlp` module, `concurrent.futures.ThreadPoolExecutor`, `pytest` (offline unit tests via `monkeypatch`).

**Source of truth:** `docs/plans/2026-05-25-yt-dlp-search-parity-design.md`

**Key existing anchors (real, verified):**
- Module constants: `youtube_short.py:24-33` (`SEARCH_CANDIDATE_LIMIT = 10`, `TRANSCRIPT_CANDIDATE_LIMIT = 3`, `_VIDEO_DURATION_CACHE: dict[str, float] = {}`).
- `_candidate_score` — `youtube_short.py:265-292` (description tier `+= 0.5` at line 285; title `1.5`; channel `5.0`).
- `_yt_dlp_search_candidates` — `youtube_short.py:507-536` (flat `--print` of `id/title/channel/upload_date/description`, `prefix = ytsearchdate|ytsearch`, ends `return _rank_video_candidates(query, candidates)`).
- `_youtube_data_api_search_candidates` — `youtube_short.py:539-558` (MUST stay unchanged).
- `_search_video_candidates_with_provider` — `youtube_short.py:604-664` (yt_dlp branch at 608, Data API fallback path).
- `_candidate_has_scene_specific_metadata` — `youtube_short.py:402-429` (reads `title` + `description` only).
- `_needs_news_category` — `youtube_short.py:248-251`.
- `_video_duration` — `youtube_short.py:679-692` (checks `_VIDEO_DURATION_CACHE` first).
- `_download_section_clip` — `youtube_short.py:913-993` (duration loop at 964, calls `_video_duration` at 967).
- `download_youtube_clip_assets` — `youtube_short.py:996-1009` (`asyncio.to_thread` per scene at 1005).
- `_yt_dlp_command` — `youtube_short.py:675-676` (`[sys.executable, "-m", "yt_dlp"]`).
- `_upload_date_to_iso` — `youtube_short.py:501-504`.
- Test style: `tests/test_fast_pipeline.py` — `SimpleNamespace` sections, `monkeypatch.setattr(youtube_short, ...)`, e.g. `test_section_candidate_rerank_prefers_scene_specific_metadata` (290) and `test_download_section_clip_skips_generic_transcript_match_when_metadata_misses_scene` (373).

**Conventions for every task below:**
- Verification command (full suite): `.venv/bin/python -m pytest tests/test_fast_pipeline.py`
- Single test: `.venv/bin/python -m pytest tests/test_fast_pipeline.py::<test_name> -v`
- All unit tests are OFFLINE: never call real `yt_dlp`/network. Mock at the hydration-function boundary or monkeypatch `subprocess.check_output`.
- Clear `_VIDEO_DURATION_CACHE` and any new module-level cache in tests that touch them (use a fixture / `monkeypatch.setattr` to a fresh dict) so tests stay deterministic and order-independent.

---

## Task 0: Add tunable constants

**Files:**
- Modify: `backend/app/tools/youtube_short.py:24-33` (constants block)

**Step 1: Add constants** near `SEARCH_CANDIDATE_LIMIT` (line 24-25):

```python
YT_DLP_FLAT_POOL_SIZE = 12
YT_DLP_HYDRATE_TOP_N = 5
YT_DLP_HYDRATE_WORKERS = 5
YT_DLP_CATEGORY_PENALTY = 4.0
```

And add a module-level hydrated-metadata cache near `_VIDEO_DURATION_CACHE` (line 32):

```python
_VIDEO_METADATA_CACHE: dict[str, dict[str, Any]] = {}
```

**Step 2: Verify import still loads**

Run: `.venv/bin/python -c "import backend.app.tools.youtube_short"`
Expected: no output, exit 0.

**Step 3: Commit**

```bash
git add backend/app/tools/youtube_short.py
git commit -m "feat: add yt-dlp hydration tunable constants"
```

---

## Task 1: Fold hydrated `tags` into `_candidate_score` (description tier)

**Files:**
- Modify: `backend/app/tools/youtube_short.py:265-292` (`_candidate_score`)
- Test: `tests/test_fast_pipeline.py`

**Step 1: Write the failing test**

```python
def test_candidate_score_folds_tags_into_description_tier() -> None:
    query = "ancient coins numismatics restoration"
    thin_on_topic = {
        "video_id": "on",
        "title": "Cleaning an old find",
        "channel_title": "Restorer",
        "description": "A short clip.",
        "tags": ["ancient coins", "numismatics", "restoration"],
    }
    off_topic = {
        "video_id": "off",
        "title": "Cleaning an old find",
        "channel_title": "Restorer",
        "description": "A short clip.",
        "tags": ["gardening", "cooking"],
    }
    assert youtube_short._candidate_score(query, thin_on_topic) > youtube_short._candidate_score(query, off_topic)


def test_candidate_score_ignores_missing_tags_for_data_api_candidate() -> None:
    query = "ancient coins"
    no_tags = {"video_id": "x", "title": "Ancient coins", "channel_title": "C", "description": "d"}
    # Must not raise and must equal the score with tags explicitly None
    assert youtube_short._candidate_score(query, no_tags) == youtube_short._candidate_score(
        query, {**no_tags, "tags": None}
    )
```

**Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py::test_candidate_score_folds_tags_into_description_tier tests/test_fast_pipeline.py::test_candidate_score_ignores_missing_tags_for_data_api_candidate -v`
Expected: first test FAILS (scores equal; tags ignored); second PASSES trivially (but keep it as the regression guard).

**Step 3: Implement**

In `_candidate_score`, fold `tags` text into the description-tier match. After the existing description extraction (line 269-275), add a tag string and treat it as additional description-tier signal:

```python
    description = str(candidate.get("description") or "")
    tags_value = candidate.get("tags")
    tags_text = " ".join(str(t) for t in tags_value) if isinstance(tags_value, (list, tuple)) else str(tags_value or "")
    description_lower = description.lower()
    tags_lower = tags_text.lower()
    description_tokens = set(_query_entity_tokens(description))
    tag_tokens = set(_query_entity_tokens(tags_text))
```

Then in the per-token loop (line 284-285), award the description-tier weight if the token matches the description OR the tags (do not double-count):

```python
        if _token_matches_field(token, description_tokens, description_lower) or _token_matches_field(
            token, tag_tokens, tags_lower
        ):
            score += 0.5
```

Leave title (`1.5`) and channel (`5.0`) weights untouched. When `tags` is absent (Data API candidates), `tags_text` is empty and the OR short-circuits on the existing description match — identical to today.

**Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k candidate_score -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/tools/youtube_short.py tests/test_fast_pipeline.py
git commit -m "feat: fold yt-dlp hydrated tags into candidate description scoring"
```

---

## Task 2: Add `_hydrate_yt_dlp_candidate` (single-candidate metadata fetch + parse)

**Files:**
- Modify: `backend/app/tools/youtube_short.py` (add helper after `_yt_dlp_search_candidates`, ~line 537)
- Test: `tests/test_fast_pipeline.py`

This is the hydration boundary that tests mock. It must: run one `yt_dlp --print` against `watch?v=<id>`, parse a tab-joined `description\tcategories\ttags\tduration` line, merge onto the candidate (flat metadata survives on empty/missing fields), populate `_VIDEO_DURATION_CACHE` and `_VIDEO_METADATA_CACHE`, and swallow subprocess failure (returning the original candidate unchanged).

**Step 1: Write the failing tests**

```python
def test_hydrate_yt_dlp_candidate_merges_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(youtube_short, "_VIDEO_DURATION_CACHE", {})
    monkeypatch.setattr(youtube_short, "_VIDEO_METADATA_CACHE", {})
    line = "Full rich description\tEducation,Science\tancient coins,numismatics\t842.0\n"
    monkeypatch.setattr(youtube_short.subprocess, "check_output", lambda *a, **k: line)

    candidate = {"video_id": "vid", "title": "T", "channel_title": "C", "description": "thin"}
    hydrated = youtube_short._hydrate_yt_dlp_candidate(candidate)

    assert hydrated["description"] == "Full rich description"
    assert hydrated["categories"] == ["Education", "Science"]
    assert hydrated["tags"] == ["ancient coins", "numismatics"]
    assert youtube_short._VIDEO_DURATION_CACHE["vid"] == 842.0
    assert youtube_short._VIDEO_METADATA_CACHE["vid"]["tags"] == ["ancient coins", "numismatics"]


def test_hydrate_yt_dlp_candidate_keeps_flat_metadata_on_empty_line(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(youtube_short, "_VIDEO_DURATION_CACHE", {})
    monkeypatch.setattr(youtube_short, "_VIDEO_METADATA_CACHE", {})
    monkeypatch.setattr(youtube_short.subprocess, "check_output", lambda *a, **k: "\t\t\tNA\n")

    candidate = {"video_id": "vid", "title": "T", "channel_title": "C", "description": "flat desc"}
    hydrated = youtube_short._hydrate_yt_dlp_candidate(candidate)

    assert hydrated["description"] == "flat desc"  # flat metadata survives
    assert "vid" not in youtube_short._VIDEO_DURATION_CACHE  # unparseable duration not cached


def test_hydrate_yt_dlp_candidate_swallows_subprocess_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(youtube_short, "_VIDEO_DURATION_CACHE", {})
    monkeypatch.setattr(youtube_short, "_VIDEO_METADATA_CACHE", {})

    def boom(*a, **k):
        raise youtube_short.subprocess.CalledProcessError(1, "yt_dlp")

    monkeypatch.setattr(youtube_short.subprocess, "check_output", boom)
    candidate = {"video_id": "vid", "title": "T", "description": "flat desc"}
    hydrated = youtube_short._hydrate_yt_dlp_candidate(candidate)

    assert hydrated == candidate  # unchanged, no raise
```

**Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k hydrate_yt_dlp_candidate -v`
Expected: FAIL with `AttributeError: module ... has no attribute '_hydrate_yt_dlp_candidate'`.

**Step 3: Implement**

Add after `_yt_dlp_search_candidates` (after line 536). Use `--print "%(description)s\t%(categories)s\t%(tags)s\t%(duration)s"`. Note `yt_dlp`'s `%(categories)s`/`%(tags)s` render Python lists like `['Education', 'Science']`; parse them via `_parse_yt_dlp_list` (a tiny helper that strips brackets/quotes and splits on comma, also accepting plain comma-joined strings). Cache hydrated metadata under `_VIDEO_METADATA_CACHE[video_id]` first; on a cache hit return the merge without a subprocess call.

```python
def _parse_yt_dlp_list(raw: str) -> list[str]:
    raw = (raw or "").strip()
    if not raw or raw in {"NA", "None", "[]"}:
        return []
    raw = raw.strip("[]")
    items = [item.strip().strip("'\"") for item in raw.split(",")]
    return [item for item in items if item]


def _hydrate_yt_dlp_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    video_id = str(candidate.get("video_id") or "")
    if not video_id:
        return candidate
    cached = _VIDEO_METADATA_CACHE.get(video_id)
    if cached is None:
        try:
            raw = subprocess.check_output(
                [
                    *_yt_dlp_command(),
                    f"https://www.youtube.com/watch?v={video_id}",
                    "--print",
                    "%(description)s\t%(categories)s\t%(tags)s\t%(duration)s",
                    "--skip-download",
                    "--ignore-errors",
                    "--no-warnings",
                ],
                text=True,
            )
        except Exception:
            return candidate  # flat metadata survives; never drop the candidate
        parts = raw.splitlines()[0].split("\t") if raw.strip() else []
        description = parts[0].strip() if len(parts) > 0 else ""
        categories = _parse_yt_dlp_list(parts[1]) if len(parts) > 1 else []
        tags = _parse_yt_dlp_list(parts[2]) if len(parts) > 2 else []
        duration: float | None = None
        if len(parts) > 3:
            try:
                duration = float(parts[3].strip())
            except ValueError:
                duration = None
        cached = {"description": description, "categories": categories, "tags": tags, "duration": duration}
        _VIDEO_METADATA_CACHE[video_id] = cached
        if duration is not None:
            _VIDEO_DURATION_CACHE[video_id] = duration
    merged = dict(candidate)
    if cached.get("description"):
        merged["description"] = cached["description"]
    if cached.get("categories"):
        merged["categories"] = cached["categories"]
    if cached.get("tags"):
        merged["tags"] = cached["tags"]
    return merged
```

Note: this must NOT call `_video_duration`-style raising; duration parse failure simply leaves the cache unset (test 2).

**Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k hydrate_yt_dlp_candidate -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/tools/youtube_short.py tests/test_fast_pipeline.py
git commit -m "feat: add yt-dlp single-candidate metadata hydration helper"
```

---

## Task 3: Soft category penalty for off-topic factual/news queries

**Files:**
- Modify: `backend/app/tools/youtube_short.py` (add `_category_penalty` helper near `_needs_news_category` line 248)
- Test: `tests/test_fast_pipeline.py`

The penalty is applied during hydration re-rank (Task 4), but the decision helper is unit-tested in isolation here. It down-weights (never removes) a candidate whose hydrated `categories` are off-topic for a `_needs_news_category` query.

**Step 1: Write the failing test**

```python
def test_category_penalty_downweights_off_topic_news_candidate() -> None:
    query = "latest election results breaking news"
    on_topic = {"video_id": "a", "categories": ["News & Politics"]}
    off_topic = {"video_id": "b", "categories": ["Gaming"]}
    no_categories = {"video_id": "c"}
    assert youtube_short._category_penalty(query, on_topic) == 0.0
    assert youtube_short._category_penalty(query, off_topic) > 0.0
    assert youtube_short._category_penalty(query, no_categories) == 0.0  # absent -> no penalty


def test_category_penalty_inert_for_non_news_query() -> None:
    query = "deep sea submersible b-roll"
    off_topic = {"video_id": "b", "categories": ["Gaming"]}
    assert youtube_short._category_penalty(query, off_topic) == 0.0
```

**Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k category_penalty -v`
Expected: FAIL (`_category_penalty` missing).

**Step 3: Implement** (add after `_needs_news_category`, line 251):

```python
_NEWS_CATEGORY_NAMES = {"news & politics", "news", "politics"}


def _category_penalty(query: str, candidate: dict[str, Any]) -> float:
    categories = candidate.get("categories")
    if not categories or not _needs_news_category(query):
        return 0.0
    names = {str(c).strip().lower() for c in categories}
    if names & _NEWS_CATEGORY_NAMES:
        return 0.0
    return YT_DLP_CATEGORY_PENALTY
```

**Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k category_penalty -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/tools/youtube_short.py tests/test_fast_pipeline.py
git commit -m "feat: add soft off-topic category penalty for factual yt-dlp queries"
```

---

## Task 4: Parallel hydration + re-rank inside `_yt_dlp_search_candidates`

**Files:**
- Modify: `backend/app/tools/youtube_short.py:507-536` (`_yt_dlp_search_candidates`)
- Add import: `from concurrent.futures import ThreadPoolExecutor` (top of file, near line 3)
- Test: `tests/test_fast_pipeline.py`

Behavior: (a) flat fetch uses `YT_DLP_FLAT_POOL_SIZE` regardless of the caller's `limit`; (b) flat-rank, take top `YT_DLP_HYDRATE_TOP_N`, hydrate them in parallel via `ThreadPoolExecutor(max_workers=YT_DLP_HYDRATE_WORKERS)`; (c) merge hydrated candidates back, re-rank using `_candidate_score` minus `_category_penalty`; (d) return the re-ranked list (un-hydrated tail preserved after hydrated head). The accepted/returned count is NOT truncated to `limit` here — the existing `_search_section_video_candidates`/`TRANSCRIPT_CANDIDATE_LIMIT` consumers slice downstream, matching today's behavior where `_rank_video_candidates` returns all rows.

**Step 1: Write the failing tests**

```python
def test_yt_dlp_search_uses_wider_flat_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def fake_check_output(cmd, text=True):
        seen["cmd"] = cmd
        # one flat row so hydration has something to do
        return "vid1\tTitle one\tChannel\t20240101\tflat desc\n"

    monkeypatch.setattr(youtube_short.subprocess, "check_output", fake_check_output)
    monkeypatch.setattr(youtube_short, "_hydrate_yt_dlp_candidate", lambda c: c)

    youtube_short._yt_dlp_search_candidates("deep sea submersible", limit=10)

    spec = next(part for part in seen["cmd"] if isinstance(part, str) and part.startswith(("ytsearch", "ytsearchdate")))
    assert f"{youtube_short.YT_DLP_FLAT_POOL_SIZE}:" in spec


def test_yt_dlp_search_hydrates_top_n_only(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = "".join(
        f"vid{i}\tTitle {i}\tChannel\t20240101\tflat desc {i}\n"
        for i in range(youtube_short.YT_DLP_FLAT_POOL_SIZE)
    )
    monkeypatch.setattr(youtube_short.subprocess, "check_output", lambda *a, **k: rows)
    hydrated_ids: list[str] = []

    def fake_hydrate(candidate):
        hydrated_ids.append(candidate["video_id"])
        return candidate

    monkeypatch.setattr(youtube_short, "_hydrate_yt_dlp_candidate", fake_hydrate)

    result = youtube_short._yt_dlp_search_candidates("deep sea submersible", limit=10)

    assert len(hydrated_ids) == youtube_short.YT_DLP_HYDRATE_TOP_N
    assert len(result) == youtube_short.YT_DLP_FLAT_POOL_SIZE  # tail preserved, not dropped


def test_yt_dlp_search_reranks_after_hydration(monkeypatch: pytest.MonkeyPatch) -> None:
    # Two flat rows with identical thin metadata; hydration makes vid2 on-topic.
    rows = "vid1\tClip\tChannel\t20240101\tthin\nvid2\tClip\tChannel\t20240101\tthin\n"
    monkeypatch.setattr(youtube_short.subprocess, "check_output", lambda *a, **k: rows)

    def fake_hydrate(candidate):
        if candidate["video_id"] == "vid2":
            return {**candidate, "tags": ["ancient", "coins", "numismatics"]}
        return candidate

    monkeypatch.setattr(youtube_short, "_hydrate_yt_dlp_candidate", fake_hydrate)

    result = youtube_short._yt_dlp_search_candidates("ancient coins numismatics", limit=10)
    assert result[0]["video_id"] == "vid2"


def test_yt_dlp_search_swallows_single_candidate_hydration_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = "vid1\tTitle\tChannel\t20240101\tflat desc\n"
    monkeypatch.setattr(youtube_short.subprocess, "check_output", lambda *a, **k: rows)

    def fake_hydrate(candidate):
        raise RuntimeError("hydration blew up")

    monkeypatch.setattr(youtube_short, "_hydrate_yt_dlp_candidate", fake_hydrate)
    result = youtube_short._yt_dlp_search_candidates("deep sea", limit=10)
    assert [c["video_id"] for c in result] == ["vid1"]  # flat candidate survives
```

**Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k yt_dlp_search -v`
Expected: FAIL (wider pool / hydration not implemented).

**Step 3: Implement**

Add `from concurrent.futures import ThreadPoolExecutor` near line 3. Rewrite `_yt_dlp_search_candidates`:

```python
def _yt_dlp_search_candidates(query: str, limit: int = 5) -> list[dict[str, Any]]:
    prefix = "ytsearchdate" if _looks_factual_query(query) else "ytsearch"
    result = subprocess.check_output(
        [
            *_yt_dlp_command(),
            f"{prefix}{YT_DLP_FLAT_POOL_SIZE}:{query}",
            "--print",
            "%(id)s\t%(title)s\t%(channel)s\t%(upload_date)s\t%(description)s",
            "--skip-download",
            "--flat-playlist",
            "--ignore-errors",
            "--no-warnings",
        ],
        text=True,
    )
    candidates: list[dict[str, Any]] = []
    for line in result.splitlines():
        parts = line.split("\t", 4)
        if len(parts) < 4 or not parts[0]:
            continue
        candidates.append(
            {
                "video_id": parts[0],
                "title": parts[1] if len(parts) > 1 else None,
                "channel_title": parts[2] if len(parts) > 2 else None,
                "published_at": _upload_date_to_iso(parts[3] if len(parts) > 3 else None),
                "description": parts[4] if len(parts) > 4 else None,
            }
        )
    ranked = _rank_video_candidates(query, candidates)
    hydrated = _hydrate_top_candidates(query, ranked)
    return _rank_yt_dlp_candidates(query, hydrated)
```

Add two helpers above it:

```python
def _rank_yt_dlp_candidates(query: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        candidates,
        key=lambda candidate: _candidate_score(query, candidate) - _category_penalty(query, candidate),
        reverse=True,
    )


def _hydrate_top_candidates(query: str, ranked: list[dict[str, Any]]) -> list[dict[str, Any]]:
    head = ranked[:YT_DLP_HYDRATE_TOP_N]
    tail = ranked[YT_DLP_HYDRATE_TOP_N:]
    if not head:
        return ranked

    def hydrate_one(candidate: dict[str, Any]) -> dict[str, Any]:
        try:
            return _hydrate_yt_dlp_candidate(candidate)
        except Exception:
            return candidate  # never drop a candidate on hydration failure

    with ThreadPoolExecutor(max_workers=YT_DLP_HYDRATE_WORKERS) as executor:
        hydrated_head = list(executor.map(hydrate_one, head))
    return hydrated_head + tail
```

**Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k yt_dlp_search -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/tools/youtube_short.py tests/test_fast_pipeline.py
git commit -m "feat: hydrate top yt-dlp candidates in parallel and re-rank"
```

---

## Task 5: End-to-end yt-dlp duration cache hit + acceptance gate on hydrated text

**Files:**
- Test only: `tests/test_fast_pipeline.py`
- (No source change expected; this verifies Tasks 2-4 integrate with `_download_section_clip` / `_video_duration`.)

**Step 1: Write the test**

```python
def test_yt_dlp_hydration_makes_duration_a_cache_hit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(youtube_short, "_VIDEO_DURATION_CACHE", {})
    monkeypatch.setattr(youtube_short, "_VIDEO_METADATA_CACHE", {})

    def fake_check_output(cmd, text=True):
        spec = next((p for p in cmd if isinstance(p, str)), "")
        if any(isinstance(p, str) and p.startswith(("ytsearch", "ytsearchdate")) for p in cmd):
            return "vid1\tDeep sea submersible dive\tOcean\t20240101\tthin\n"
        # hydration print call: description, categories, tags, duration
        return "Deep sea submersible exploring hydrothermal vents\tScience & Technology\tsubmersible,deep sea\t300.0\n"

    monkeypatch.setattr(youtube_short.subprocess, "check_output", fake_check_output)

    candidates = youtube_short._yt_dlp_search_candidates("deep sea submersible", limit=10)
    assert candidates[0]["video_id"] == "vid1"
    # duration cached by hydration -> _video_duration is a pure cache hit (no subprocess)
    monkeypatch.setattr(
        youtube_short.subprocess,
        "check_output",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not call subprocess")),
    )
    assert youtube_short._video_duration("vid1") == 300.0
```

**Step 2: Run the test**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py::test_yt_dlp_hydration_makes_duration_a_cache_hit -v`
Expected: PASS. If it fails because the hydration print path is distinguished incorrectly, adjust the helper's `--print` arguments — do not weaken the cache write in `_hydrate_yt_dlp_candidate`.

**Step 3: Commit**

```bash
git add tests/test_fast_pipeline.py
git commit -m "test: verify yt-dlp hydration primes the duration cache"
```

---

## Task 6: Regression guard — Data API path unchanged

**Files:**
- Test only: `tests/test_fast_pipeline.py`

Assert the Data API path neither hydrates nor changes scoring, and that new fields are never produced from a Data API snippet.

**Step 1: Write the test**

```python
def test_data_api_search_path_does_not_hydrate_or_emit_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    # If hydration ran on the Data API path this would explode the test.
    def fail_hydrate(candidate):
        raise AssertionError("Data API path must not hydrate")

    monkeypatch.setattr(youtube_short, "_hydrate_yt_dlp_candidate", fail_hydrate)

    class FakeResp:
        def execute(self):
            return {
                "items": [
                    {
                        "id": {"videoId": "vid1"},
                        "snippet": {
                            "title": "Ancient coins restoration",
                            "channelTitle": "Numismatics",
                            "publishedAt": "2024-01-01T00:00:00Z",
                            "description": "Full snippet description.",
                        },
                    }
                ]
            }

    class FakeSearch:
        def list(self, **kwargs):
            return FakeResp()

    class FakeClient:
        def search(self):
            return FakeSearch()

    monkeypatch.setattr(youtube_short, "_youtube_client", lambda: FakeClient())

    candidates = youtube_short._youtube_data_api_search_candidates("ancient coins restoration", 5)
    assert candidates[0]["video_id"] == "vid1"
    assert "tags" not in candidates[0]
    assert "categories" not in candidates[0]
    # Scoring is identical with and without an (absent) tags key.
    assert youtube_short._candidate_score("ancient coins", candidates[0]) == youtube_short._candidate_score(
        "ancient coins", {**candidates[0], "tags": None, "categories": None}
    )


def test_provider_dispatch_uses_data_api_without_hydration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        youtube_short,
        "_youtube_data_api_search_candidates",
        lambda query, limit=5: [{"video_id": "d", "title": "t", "channel_title": "c", "description": "x"}],
    )
    monkeypatch.setattr(
        youtube_short,
        "_hydrate_yt_dlp_candidate",
        lambda c: (_ for _ in ()).throw(AssertionError("no hydration on data api")),
    )
    out = youtube_short._search_video_candidates_with_provider("ancient coins", 5, "youtube_data_api")
    assert out[0]["video_id"] == "d"
    assert out[0]["_search_provider"] == "youtube_data_api"
```

**Step 2: Run the tests**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -k "data_api" -v`
Expected: PASS. If any fail, the new logic leaked into the Data API path — fix the source, not the test.

**Step 3: Commit**

```bash
git add tests/test_fast_pipeline.py
git commit -m "test: guard YouTube Data API search path against hydration regressions"
```

---

## Task 7: Opt-in timing probe (network, excluded from unit suite)

**Files:**
- Create: `scripts/bench_yt_dlp_search.py`

Network-bound, manual. Gated behind `RUN_YT_DLP_BENCH`; prints a small table of flat-search / hydration / total wall-clock for the deep-sea and ancient-coins sample sections under `search_provider="yt_dlp"`, reusing the `duration_ms` already captured in `_search_benchmark`. It must be a standalone script (NOT collected by pytest) so the deterministic suite never hits the network.

**Step 1: Create the script**

```python
"""Opt-in yt-dlp search timing probe. Network-bound; run manually.

Usage:
    RUN_YT_DLP_BENCH=1 .venv/bin/python scripts/bench_yt_dlp_search.py
"""
from __future__ import annotations

import os
import sys
import time
from types import SimpleNamespace

from backend.app.tools import youtube_short

SAMPLE_SECTIONS = [
    SimpleNamespace(
        section=1,
        dialogue="The submersible reaches hydrothermal vents where strange animals glow in the dark.",
        search_hint="deep sea submersible descending underwater b-roll",
        duration_seconds=5,
    ),
    SimpleNamespace(
        section=2,
        dialogue="A conservator lifts corrosion a grain at a time with bamboo picks and distilled water.",
        search_hint="ancient coin restoration under microscope corrosion removal",
        duration_seconds=6,
    ),
]


def main() -> int:
    if not os.environ.get("RUN_YT_DLP_BENCH"):
        print("Set RUN_YT_DLP_BENCH=1 to run this network probe.")
        return 0
    print(f"{'scene':<8}{'total_s':<10}{'top_attempt_ms':<16}{'count'}")
    for section in SAMPLE_SECTIONS:
        started = time.perf_counter()
        candidates = youtube_short._search_section_video_candidates(section, search_provider="yt_dlp")
        total = time.perf_counter() - started
        attempt_ms = 0.0
        if candidates:
            benchmark = candidates[0].get("_search_benchmark") or {}
            attempts = benchmark.get("attempts") or []
            if attempts:
                attempt_ms = attempts[-1].get("duration_ms", 0.0)
        print(f"{section.section:<8}{total:<10.2f}{attempt_ms:<16}{len(candidates)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

**Step 2: Verify it is skipped without the env var (offline, no network)**

Run: `.venv/bin/python scripts/bench_yt_dlp_search.py`
Expected: prints `Set RUN_YT_DLP_BENCH=1 to run this network probe.` and exits 0 — NO network call.

**Step 3: Confirm pytest does not collect it**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py -q`
Expected: PASS; the script under `scripts/` is not collected.

**Step 4: Commit**

```bash
git add scripts/bench_yt_dlp_search.py
git commit -m "feat: add opt-in yt-dlp search timing probe"
```

---

## Task 8: Full suite green + final review

**Files:** none

**Step 1: Run the full unit suite**

Run: `.venv/bin/python -m pytest tests/test_fast_pipeline.py`
Expected: all PASS, zero network access.

**Step 2: Sanity import**

Run: `.venv/bin/python -c "import backend.app.tools.youtube_short as y; print(y.YT_DLP_FLAT_POOL_SIZE, y.YT_DLP_HYDRATE_TOP_N, y.YT_DLP_HYDRATE_WORKERS)"`
Expected: `12 5 5`.

**Step 3: REQUIRED SUB-SKILL** — Use superpowers:requesting-code-review before declaring done.

---

## Open questions / risks

- **`%(categories)s`/`%(tags)s` exact rendering** differs across yt-dlp versions (Python-list repr vs comma-joined). `_parse_yt_dlp_list` handles both; verify against the installed yt-dlp during Task 2 if a real call is ever made (the unit tests mock it, so this is only a manual-probe concern).
- **Tab characters inside descriptions** could shift the 4-field split in hydration. The flat path already uses `split("\t", 4)`; the hydration path puts `description` first, so an embedded tab would bleed into `categories`. If observed in the probe, switch the `--print` field order to put `description` last, or use a non-tab separator.
- The accepted-count is intentionally NOT truncated to `limit` in `_yt_dlp_search_candidates` (mirrors today's `_rank_video_candidates` returning all rows; downstream `TRANSCRIPT_CANDIDATE_LIMIT` slicing is unchanged). Confirm this matches reviewer expectations.
