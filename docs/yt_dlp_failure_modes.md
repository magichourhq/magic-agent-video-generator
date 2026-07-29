# YouTube Sourcing — Known Failure Modes (yt-dlp & Data API)

_Last updated: 2026-05-27 (branch: `yt-dlp-search-parity`)_

## Failure: Transcript-Aligned Window Not Found

### Symptom
Generation aborts with:
```
RuntimeError: Refusing to stitch partial YouTube short because missing scenes
would desync script and visuals.
  scene_X: No transcript-aligned YouTube window found for search hint: <hint>.
  Tried: <video_id>: no transcript match;
         <video_id>: metadata does not match scene-specific search terms;
         ...
```

The stitcher refuses to produce a partial video when one or more scenes can't
source footage, because missing scenes would desync narration and visuals.

### Observed Example (2026-05-27 run)
Script topic: Steve Jobs / iPhone 2007 keynote.

- **scene_1** — hint: `"steve Jobs iPhone 2007 keynote backstage Apple secrecy"`
  - `fvN9dy8FeBY` → no transcript match
  - Only **1 candidate** tried before giving up.
- **scene_3** — hint: `"steve Jobs iPhone 2007 keynote audience reaction first demo"`
  - `IYogbb97Y4s` → metadata does not match scene-specific search terms
  - `hSDgkCaYxrs` → metadata does not match scene-specific search terms
  - `Vs6vJwmJL0Y` → no transcript match

### Root Causes

1. **Narrow / non-verbal scene hints.** Hints like "backstage", "audience
   reaction", "secrecy" describe B-roll moments that almost never appear
   verbatim in a keynote's captions. The transcript-window matcher has no
   phrase to lock onto.

2. **Captions absent or auto-generated poorly.** Many archival keynote uploads
   either have captions disabled or low-quality auto-captions, so the
   transcript alignment check returns "no transcript match" even when the clip
   visually fits.

3. **Strict metadata gate.** Scene-specific terms must appear in title /
   description / tags. Generic re-uploads of famous keynotes often have sparse
   metadata, so candidates are rejected as "metadata does not match".

4. **Shallow candidate pool.** scene_1 only had 1 candidate before failing.
   The search/hydration step isn't surfacing enough alternates per scene to
   absorb a single bad pick.

### Mitigation Options (not yet implemented)

| Option | Effort | Trade-off |
|---|---|---|
| Loosen scene hints at script-gen so they use phrases likely to appear in transcripts (e.g. "iPhone unveiling moment" vs "backstage secrecy") | Low | Slightly less precise B-roll targeting |
| Increase candidate pool per scene (more search results, deeper hydration) | Low-Med | Higher API + yt-dlp cost per run |
| Fallback path when transcript alignment fails: metadata-only matching, or skip transcript gate for B-roll/visual-only scenes | Med | Risk of mis-aligned visuals on narrative scenes |
| Allow partial stitch with placeholder/stock for missing scenes (gated by flag) | Med | Quality regression unless placeholder is good |
| Per-scene retry with broadened hint after first failure | Med | Extra latency per failed scene |

### Where to Look in Code
- `backend/app/tools/youtube_short.py`
  - `download_youtube_clip_assets` — parallel `asyncio.gather` over sections
  - `_download_section_clip` / `_download_clip` — per-clip yt-dlp subprocess
  - Transcript alignment + metadata gating live in the search-parity path
- `docs/plans/2026-05-25-yt-dlp-search-parity-design.md` — design doc for
  parallel hydration & search parity.

### Logging
Failure surfaces in `.run-logs/backend.log` as `ERROR:video-agent:Project generation failed`
with the full per-scene candidate trail in the `RuntimeError` message.

---

## Full Failure Mode Catalog

Comprehensive audit of every error path, exception, and rejection condition in
the yt-dlp YouTube short workflow. Stage-ordered.

### 1. Search & Discovery (`backend/app/tools/youtube_short.py`)

| # | Location | Type | Trigger |
|---|---|---|---|
| 1.1 | `:225` | `RuntimeError` | No YouTube API keys (1-3 or default) found in `.env` or env |
| 1.2 | `:235` | `RuntimeError` | All provided API keys fail validation against a known video ID |
| 1.3 | `:373` | `ValueError` | `search_provider` is not `youtube_data_api` or `yt_dlp` |
| 1.4 | `:505` | `RuntimeError` | Both primary and focused queries return zero ranked candidates **and** errors occurred |
| 1.5 | `:657` | `RuntimeError` | YouTube Data API call fails (secrets redacted in message) |

### 2. Metadata Hydration & Candidate Selection

| # | Location | Type | Trigger |
|---|---|---|---|
| 2.1 | `:553`, `:625` | _Silent_ | `yt-dlp --print` hydration fails → candidate kept with flat metadata only |
| 2.2 | `:1035` | `RuntimeError` | Empty candidate pool for a search hint |
| 2.3 | `:1038` | `RuntimeError` | Section has no dialogue (required for transcript alignment) |
| 2.4 | `:1105` | `RuntimeError` | None of top `TRANSCRIPT_CANDIDATE_LIMIT` candidates yield transcript or visual-metadata window — **this is the failure observed in the 2026-05-27 run above** |

### 3. Transcript & Duration Logic

| # | Location | Type | Trigger |
|---|---|---|---|
| 3.1 | `:802` | `RuntimeError` | `yt-dlp --print duration` returns non-float-castable value |
| 3.2 | `:883` | _Silent_ | `yt-dlp --write-subs` non-zero exit → empty cache, falls back to visual metadata matching |
| 3.3 | `:825` | _Silent_ | Malformed VTT lines skipped by `_parse_vtt_entries` |

### 4. yt-dlp Download Subprocess

| # | Location | Type | Trigger |
|---|---|---|---|
| 4.1 | `:1003` | `subprocess.CalledProcessError` | yt-dlp download non-zero exit (`check=True`) |
| 4.2 | `:1006` | `RuntimeError` | yt-dlp exits 0 but no file matches the expected template on disk |

### 5. Stitching & Assembly (`backend/app/tools/media.py`)

| # | Location | Type | Trigger |
|---|---|---|---|
| 5.1 | `:373` | `RuntimeError` | `ffprobe` fails to read duration of a normalized scene video |
| 5.2 | `:376` | `ValueError` | Scene or merged video duration ≤ 0 |
| 5.3 | `:353` | `RuntimeError` | Any `ffmpeg` command (normalize / xfade / mux) returns non-zero |
| 5.4 | `:425` | `ValueError` | Fewer than 2 videos provided for crossfade |
| 5.5 | `:527` | `ValueError` | Zero videos provided for stitching |
| 5.6 | `:331` | `ValueError` | Fish Audio voiceover response < 1024 bytes |
| 5.7 | `:339` | `ValueError` | Generated voiceover duration < 0.5s |

### 6. Silent Rejections / Soft Penalties

These don't raise but reduce the candidate pool and contribute to downstream
hard failures (especially 2.4):

| # | Location | Behavior |
|---|---|---|
| 6.1 | `:270` | News-category mismatch on factual queries → down-weighted by `YT_DLP_CATEGORY_PENALTY` |
| 6.2 | `:1093` | `_candidate_has_scene_specific_metadata` false → candidate skipped for that scene |
| 6.3 | `:1085` | Transcript-window missing → tries `visual_metadata` fallback before failing |

### Failure-Mode Cascade Diagram

```
Search (1.x)
   │
   ▼
Hydration (2.1 silent) ──► Candidate pool
   │
   ▼
Per-scene selection
   ├─ 2.2 empty pool ──────────┐
   ├─ 2.3 no dialogue ─────────┤
   ├─ 6.1/6.2/6.3 reject ──┐   │
   ▼                       ▼   ▼
Transcript align (3.x) ──► 2.4 no alignment  ◄── most common hard fail
   │
   ▼
Download (4.x)
   │
   ▼
Stitch / mux (5.x)
```

---

## YouTube Data API Provider — Failure Modes

When `search_provider=youtube_data_api`, the discovery path differs from yt-dlp.
File refs are all `backend/app/tools/youtube_short.py`.

### A. API Key & Authentication

| # | Location | Type | Trigger |
|---|---|---|---|
| A.1 | `:225` | `RuntimeError` | No keys found in env or `.env` (`YOUTUBE_API_KEY_1-3` / `YOUTUBE_API_KEY`) |
| A.2 | `:215` | _Silent_ | `_is_youtube_api_key_working` test call against `dQw4w9WgXcQ` returns no items → key marked dead |
| A.3 | `:235` | `RuntimeError` | Every configured key fails validation or throws |

### B. Search & Quota

| # | Location | Type | Trigger |
|---|---|---|---|
| B.1 | `:521` | `googleapiclient.errors.HttpError` | `search().list().execute()` fails (quota, network, invalid params) |
| B.2 | `:179-200` | _Parsing_ | Errors caught and parsed for `quotaExceeded`, `keyInvalid`, etc.; key strings redacted via regex |
| B.3 | `:657` | `RuntimeError` | Any exception in `search().list()` flow re-raised with cleaned message |
| B.4 | `:734-745` | _Auto-fallback_ | On Data API failure, system falls back to `yt_dlp` provider. **Inverse is NOT true** — yt_dlp failures don't fall back to Data API |

### C. Sourcing & Metadata

| # | Location | Type | Trigger |
|---|---|---|---|
| C.1 | `:659-669` | _Implicit_ | Snippet (title/channel/description/tags) returned inline — no separate hydration step, so 2.1 silent-hydration-failure mode does NOT apply here |
| C.2 | `:668` | _Filter_ | Candidates without `videoId` dropped from list comprehension |
| C.3 | `:515` | _Ranking_ | Uses `order=relevance` (default) or `order=date` (factual) at API level |
| C.4 | `:520` | _Filter_ | `videoCategoryId="25"` (News & Politics) hard-applied for factual queries — stricter than yt-dlp's soft category penalty (6.1) |

### D. Shared Downstream Path (Both Providers)

Once candidates are produced, both providers feed the same pipeline, so all
of these still apply when running `youtube_data_api`:

- **2.3** no dialogue → `RuntimeError`
- **2.4** no transcript-aligned window → `RuntimeError` ← still the most common hard fail
- **3.x** transcript / duration probe (transcripts ALWAYS go through yt-dlp; Data API has no caption path without OAuth — `_transcript_entries` at `:861`)
- **4.x** yt-dlp download subprocess (download is yt-dlp regardless of search provider)
- **5.x** stitching / voiceover / ffmpeg

### Provider Comparison Cheatsheet

| Aspect | `youtube_data_api` | `yt_dlp` |
|---|---|---|
| Key required | Yes (1-3 env keys) | No |
| Quota risk | Yes (10k units/day default) | No |
| Metadata richness | Full snippet inline | Flat → needs hydration (2.1 silent) |
| News-category filter | Hard (API param) | Soft penalty |
| Ranking | Server-side (`order=`) | Client-side after `ytsearch`/`ytsearchdate` |
| Fallback on failure | → `yt_dlp` (auto) | None |
| Transcript fetch | yt-dlp (shared) | yt-dlp |
| Download | yt-dlp (shared) | yt-dlp |

**Implication:** Data API failures (B.x) are usually recoverable thanks to
auto-fallback. The hard failures users actually see (2.4, 4.x, 5.x) live in the
shared downstream path and hit both providers identically.

---

### Resilience Gaps Worth Tracking

1. **Hydration failures are silent (2.1)** — a candidate with bad metadata
   then gets rejected later (6.2) without indicating that the upstream cause
   was a yt-dlp print failure, not actual metadata mismatch.
2. **No retry on transient yt-dlp errors (4.1)** — single subprocess failure
   kills a scene's download even though re-run usually succeeds.
3. **Voiceover hard-fails late (5.6/5.7)** — voiceover is generated after
   visuals are sourced; a Fish Audio glitch wastes the entire upstream cost.
4. **2.4 has no automatic broadening** — when transcript alignment fails for
   all candidates, there's no retry with a relaxed hint or expanded search.

