# YouTube Workflow — Production-Quality Fixes (2026-06-17)

Grounded in reviewer punch list (A–E) + a verified map/design workflow. Branch `ui/generative-youtube-iteration`.

## Pipeline today (verified)
POST `/api/projects {workflow:"youtube_clips"}` → `videoAgent` calls `create_youtube_short_from_prompt` once → `draftYoutubeScriptImpl` emits sections {dialogue, search_hint} → `normalizeYoutubeSectionsForProject` rewrites hints (`carrySourceSubjectTerms`/`factualYoutubeSearchHint`, prompts.ts:668-786) → `createYoutubeShortImpl` (workflows.ts:927-1209):
1. `downloadYoutubeClipAssets` (youtubeShort.ts:2191) — per-section `downloadSectionClip` (2017): search 20 candidates → text-only subagent rerank → **sequential first-accept** over top 8: `metadataSpecificityRejectionReason(...,strict=false)` (2043) → transcript window (≥2.0) → `downloadClip` (yt-dlp `--download-sections`) → binary VLM frame check (3 frames @0.2/0.5/0.8) → **returns first survivor**.
2. Per-section Fish VO generated; section/asset durations rewritten to VO length (workflows.ts:1054-1073) but the clip file is **not re-trimmed**, and `source_duration_seconds` is **not refreshed** (stays the planned estimate, set workflows.ts:1008 ← youtubeShort.ts:2088).
3. `buildTimelineFromProjectState` (timeline.ts:152): clip.duration=VO; `end_behavior = duration > source_end-source_start ? 'freeze' : 'cut'` (timeline.ts:179) → **freeze** whenever VO > recorded source len; +1.5s final-hold freeze guard (DEFAULT_FINAL_HOLD_SECONDS, timeline.ts:46,234).
4. `stitchTimelineAssets` (media.ts:927): aspect-fill crop + `tpad=stop_mode=clone` freeze-pad, hard-concat, mux VO, `-t` clamp.
Subject identity enforced ONLY by a per-name allowlist (`carrySourceSubjectTerms`) + per-name regex ladder (`requiredEntityRejectionReason`, youtubeShort.ts:726-839). Final at `outputs/<id>/final.mp4`, exported to `mh_agent_output/yt-clips/<slug>__<first8>.mp4`.

## Fixes (with verifier corrections folded in)

### F1 — Subject relevance (A) [P0]
- `extractDominantSubject(sourcePrompt)` → `{tokens, phrase}` for confident proper-noun subjects (capitalized multi-word spans, quoted names, known team/brand/place), else null.
- Inject the subject phrase into search hints in **BOTH** branches of `normalizeYoutubeSectionsForProject` (prompts.ts:761-786) — non-factual (`carrySourceSubjectTerms`) AND factual (`factualYoutubeSearchHint`), or after the branch split. *(Verifier: factual-phrased subject prompts bypass `carrySourceSubjectTerms`.)*
- `requiredSubjectRejectionReason(candidateText, subjectTokens)`: reject candidate whose title+description union contains NONE of the subject tokens. **Thread `subjectTokens` through `metadataSpecificityRejectionReason`'s signature → into the gate** *(Verifier: `requiredEntityRejectionReason(query,text)` can't receive tokens as-is)*. Reaches both loops.
- Flip youtubeShort.ts:2043 `strict=false`→`true`.
- Guard: only enforce when a confident subject is found; else today's loose behavior. Keep hint-backoff (2176) as safety net.

### F3 — Kill the dead end-pause (C) [P0]
- Over-fetch the download window: `max(planned, planned*1.4 + 1.5)` clamped to source, extending FORWARD from transcript-match start (not into the final seconds → avoid end-cards).
- **CRITICAL (verifier):** after VO realign (workflows.ts:1054-1073), for clips whose VO > recorded source window, ffprobe the actual file and **update `source_duration_seconds`, `start_seconds`, `end_seconds`** so `timeline.ts:179` sees real footage → `end_behavior='cut'`. (If source genuinely shorter than VO, freeze stays as fallback.)
- Test the real signal: when source window ≥ VO, the normalized clip duration ≥ target so tpad pads ~0s (motion to the cut). (NOT "no tpad emitted" — tpad always emits.)

### F4 — Artifact avoidance (B) [P1, cheap]
- `extractVisualVerificationFrames`: add edge offsets ~0.04 and ~0.96 (5–6 frames), sampling the INTENDED window (start..start+VO), not the over-fetched tail.
- Judge prompt (youtubeShort.ts:1301-1312): add "reject if OPENS/ENDS on a title slate/intro-outro/end-card/CTA, or frames are near-identical (static), only when the slate/CTA dominates."
- `YOUTUBE_SCRIPT_SYSTEM_PROMPT` (prompts.ts:433-449): search-hint rule — target action/footage; avoid intro/title sequence/trailer/outro/subscribe/reaction; prefer raw/official footage.

### F5 — Shrink the 1.5s static end-hold (C) [P1, trivial]
- At the YT timeline build call site (workflows.ts:1151), pass `final_hold_seconds: 0.25` (scope to youtube_clips; leave global DEFAULT untouched).

### F2-light — Stop over-fetching (D) [P0 of the D ask; light version]
- Lower `SEARCH_CANDIDATE_LIMIT` 20→10, `TRANSCRIPT_CANDIDATE_LIMIT` 8→3 (youtubeShort.ts:16-17). Confirmed only consumers are 1393/2028/2041/2108 — safe.
- **Follow-up (not now):** full parallel best-of-3 with a `confidence` field on `openaiVisualMatchJudgment` + a REQUIRED global p-limit (~6) — the reviewer's "pick the BEST" refinement. Deferred to keep this change low-risk; first-accept over 3 *with the active subject+VLM gates* is the MVP.

## Run recipe (generate + save)
Env in `/Users/tanmay/Magic Hour ML role/.env` (incl. YOUTUBE_API_KEY_1/2/3). Start server: `server/node_modules/tsx/dist/cli.mjs src/index.ts` (port 8000). POST `/api/projects {prompt, workflow:"youtube_clips", duration_seconds:30, scene_count:4, aspect_ratio:"9:16"}` → poll `/api/projects/<id>` → final at `outputs/<id>/final.mp4` (+ exported copy). Tests: `./node_modules/.bin/vitest run` from `server/` (npm wrapper crashes under proxy).

## Order: F1 → F3+F5 → F4+F2-light → e2e generate/save → judge against A–E.
Minimal production set = F1, F3, (F5, F4, F2-light cheap add-ons). Full best-of-3 = follow-up.
