# Plan: Per-Section Voiceover to Fix YouTube Short Desync

- **Date:** 2026-05-28
- **POC:** AdaL
- **Scope:** `youtube_clips` workflow only (`create_youtube_short_impl`)
- **Status:** Implemented (2026-05-28). Decision 1 → hard cuts; Decision 2 → (a) natural total. Tests green (97 passed). See "Implementation notes" at bottom.

## TL;DR
Final YouTube shorts desync because the **audio timeline and the video timeline are built independently and never reconciled at section boundaries**. We will make section boundaries authoritative on *both* tracks: generate TTS **per section**, measure each section's real spoken duration, set each scene's video length to that measured duration, mux audio+video **per section**, then concat. This makes the desync structurally impossible rather than merely smaller.

---

## Root cause recap (confirmed by tracing)

Two compounding mechanisms, both in the YouTube path:

**A — Estimated durations vs. real speech.**
`generate_voiceover_asset` (media.py:297) produces **one file for the entire narration** and returns only a total duration — no per-section boundaries. Each scene's video is hard-trimmed to the **LLM's estimated** `section.duration_seconds` (main.py:1968, youtube_short.py:800). The video cuts at *estimated* boundaries while the single audio flows at *real* pace → error accumulates across scenes.

**B — Crossfade compresses video but not audio.**
`stitch_assets` (media.py:510) overlaps scenes with `xfade`, shrinking the video timeline by `crossfade × (n−1)` (media.py:408). The single voiceover is overlaid linearly with only `apad`/`atrim` — no matching compression. With `CROSSFADE_DURATION = 0.5` and 5 scenes the visuals end ~2s ahead of where narration expects each section. Total durations get reconciled; **internal section alignment never does.**

Per-section voiceover eliminates **A** by construction and removes **B** (each section becomes self-contained; we control the join explicitly).

---

## Target flow

```
For each section:
  1. TTS(section.dialogue) -> voiceover/section_<N>.<fmt>   (NEW: per-section)
  2. measured_dur = ffprobe(section audio)                  (NEW)
  3. section.duration_seconds <- measured_dur               (authoritative)
Then:
  4. download clip trimmed to measured per-section duration (existing path, fed measured dur)
  5. per-section mux: normalize video + clamp/pad to its audio length + attach its audio
  6. concat per-section muxed clips                          (hard cuts by default)
```

Boundaries are exact because each section's video length **equals** its measured audio length, and each section carries its own audio.

---

## File-by-file changes

### 1. `backend/app/tools/media.py`

**a) Extract the Fish Audio HTTP call (refactor, no behavior change).**
Pull the request/validate/write block out of `generate_voiceover_asset` into a private helper:
```
async def _fish_audio_tts(ctx, text: str, output: Path) -> float   # returns measured duration
```
`generate_voiceover_asset` keeps its exact current signature and behavior (it just calls the helper). **This preserves the two non-YouTube callers** (main.py:1745, 2423) byte-for-byte.

**b) New per-section generator.**
```
async def generate_section_voiceovers(
    ctx, sections: list[...],
) -> list[dict]   # [{section, scene_id, path, duration_seconds}], ordered by section
```
- Writes `voiceover/section_<N>.<fmt>` per section, reusing `_fish_audio_tts`.
- Generates concurrently (asyncio.gather), preserving section order in the returned list.
- Raises/records per-section failure so the caller's guard can react.

**c) New per-section stitch.**
```
async def stitch_assets_per_section(
    ctx, scenes: list[dict],   # each: {video_path, audio_path, duration_seconds}
) -> str
```
- Reuse `normalize_scene_video_for_stitch` (already strips audio with `-an`).
- Per scene: one ffmpeg call that pads/trims video to **its own audio duration** (`tpad=stop_mode=clone` if short, `trim` if long) and muxes that scene's audio (`-map 0:v -map 1:a`, `-t <audio_dur>`).
- Concat the per-section muxed MP4s via the concat demuxer (**hard cuts** — see Decision 1).
- Keep `stitch_assets` (the global version) intact for the other workflows.

### 2. `backend/app/main.py` — `create_youtube_short_impl` (L1975)

Reorder so **TTS happens before plan/clip durations are locked**:
1. Normalize sections (unchanged, L1999).
2. **NEW:** `section_vo = await generate_section_voiceovers(ctx, sections)`.
3. **NEW:** overwrite each `section.duration_seconds` with its measured audio duration (round, enforce a small floor).
4. Build plan from the now-accurate sections (`youtube_sections_to_video_plan`, L2008) → `plan_duration_seconds` is now real.
5. `draft_video_plan_impl` (L2011) — unchanged, now with accurate durations.
6. Download clips (L2034 area) — unchanged code, but each section now carries its measured duration, so `_pick_transcript_window` + `_download_clip` trim to real speech length.
7. zip sections+clip_results+section_vo into per-scene dicts; keep the existing **failure guard** (L2122) and extend it to TTS failures.
8. Replace the `stitch_assets(...)` call with `stitch_assets_per_section(...)`.
9. Write a `section_voiceovers` JSON artifact alongside `videos`.

**No change** to `generate_voiceover_asset`, `youtube_sections_to_video_plan` signature, `download_youtube_clip_assets`, `_download_section_clip`, or the search-provider plumbing.

---

## Decisions I need from you

**Decision 1 — Transitions.** Per-section audio means I can either:
- **(default) Hard cuts** between scenes — zero speech overlap, simplest, exact. Recommended for narration.
- **xfade + acrossfade** — smoother visuals but blends ~0.5s of adjacent narration (the existing `_build_xfade_filter` already builds the audio graph, currently unused). Looks nicer, slightly muddies speech at joins.

I recommend hard cuts. Say the word if you want the crossfade aesthetic.

**Decision 2 — Hard target duration.** When `explicit_target_final_duration_seconds_for_project` is set, the current code trims/extends the single audio to hit it. With per-section, the natural total is `sum(measured durations)`. Options: (a) accept the natural total and ignore the hard target for YT, (b) apply one final trim/pad to the concatenated result to hit the target. I lean (a) for fidelity; (b) is a small add if you need exact length.

---

## Blast radius

| Touched | Unchanged (verified callers/paths) |
|---|---|
| `media.py`: +`_fish_audio_tts`, +`generate_section_voiceovers`, +`stitch_assets_per_section` | `generate_voiceover_asset` body+signature → draft-video (L1745) & 3rd workflow (L2423) unaffected |
| `main.py`: `create_youtube_short_impl` internals | `stitch_assets` (global) kept for non-YT workflows |
| — | search-provider toggle, `download_youtube_clip_assets`, `_download_section_clip`, failure guard semantics |

Other workflows have the *same* desync design (global voiceover + crossfade) but are **out of scope** here; can be a follow-up once this is proven.

---

## Risks
- **TTS cost/latency:** N short requests instead of 1. Mitigated by concurrent generation; per-section is also more retry-friendly.
- **Very short sections:** enforce a minimum audio floor so a 1-word section doesn't yield a sub-second clip the transcript-window logic can't satisfy.
- **Clip shorter than its audio:** handled by `tpad=stop_mode=clone` per section (freeze last frame) — same technique already in the codebase.

## Testing
1. Unit: `_fish_audio_tts` parity (global generator output identical pre/post refactor).
2. Integration: a 5-section short; assert each muxed scene's video duration == its audio duration (±1 frame) via ffprobe.
3. Regression: run the draft-video workflow to confirm `generate_voiceover_asset` path is untouched.
4. Manual: eyeball/ear a real 30s short for boundary sync.

---

## Implementation notes (2026-05-28)

**Code (all in the uncommitted working tree):**
- `media.py`: `_fish_audio_tts` (extracted), `generate_section_voiceovers`, `_mux_section`, `stitch_assets_per_section`, plus **`combine_section_voiceovers`** — an addition beyond the plan: it concatenates the surviving sections' audio back into a single `voiceover.<fmt>` so the manifest's voiceover contract (path + duration) still holds for downstream consumers, while the per-section files stay the alignment source of truth.
- `main.py` `create_youtube_short_impl`: per-section TTS now runs before durations lock; each `section.duration_seconds` is overwritten with `max(1, min(30, round(measured)))`; failed scenes are dropped from both the combined audio and the stitch list (`vo_by_scene` lookup) so a dropped section can't desync survivors. `hard_target_duration`/`voiceover_target_duration` removed (Decision 2a).
- `youtube_short.py`: added per-call yt-dlp `--socket-timeout` + subprocess `timeout` guards (network safety net, not run-abort).

**Tests (`tests/test_fast_pipeline.py`):**
- Reconciled `test_create_youtube_short_impl_reuses_project_state_voiceover_and_stitching` and `..._records_stitch_failure` to patch the new functions; tightened the reuse-guard test to forbid the new functions too.
- Added `test_stitch_assets_per_section_locks_each_scene_to_its_audio_duration` — a real-ffmpeg integration test asserting each muxed section's video length equals its audio length (pad + trim branches) and the concat total equals the sum. Skips if ffmpeg/ffprobe absent.

**Still open / follow-ups:** items 1 (`_fish_audio_tts` HTTP parity unit test) and 4 (manual A/V eyeball) from Testing are not automated. Other workflows still use the global voiceover + crossfade (out of scope, as noted in Blast radius).
