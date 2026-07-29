# Character-Matched Fish Audio Voice — Design (2026-06-16)

**Problem:** All speech used one global `FISH_AUDIO_REFERENCE_ID` = "Ethan" (male, middle-aged). A female on-camera character was narrated by a male voice. Revisits the earlier "single global voice" decision.

**Goal:** Add a small repertoire of Fish Audio voices and pick one matching the recurring character (gender + energy), planner-driven with a robust fallback.

## Decisions (confirmed with user)
- **Curated in-code catalog** of 5 vetted voices (not runtime-querying random community voices).
- **One voice per video** (one recurring character; per-scene/multi-speaker = YAGNI).
- **Planner picks** from the catalog; **code guards** against a gender-mismatched pick.

## Catalog (verified live against Fish Audio /model — all en)
| key | reference_id | gender | style |
|---|---|---|---|
| `sarah` | 933563129e564b19a115bedd57b7406a | female | young, soft, conversational (female default) |
| `jasphina` | e9b134e4c0b547a3894793be502314f1 | female | energetic, social-media |
| `ethan` | 536d3a5e000945adb7038665781a4aca | male | calm, professional narration (male default; = current env voice) |
| `energetic_male` | 802e3bc2b27e49c2995d23ef70e6ac89 | male | young, enthusiastic, ad-style |
| `alle` | 59e9dc1cb20c452584788a2690c80970 | neutral | young, conversational |

Female default = `sarah`; male default = `ethan`. Easy to expand by adding rows.

## Components
1. **`server/src/voices.ts`** — `FISH_AUDIO_VOICES` catalog (key→{reference_id, gender, style}) + `inferCharacterGender(plan)` (keyword heuristic over visual_bible + scene narration/image_prompt: she/woman/female/her vs he/man/male/his → "female"|"male"|"unknown") + `resolveVoiceReferenceId(plan, ctx)`:
   1. inferred gender = inferCharacterGender(plan).
   2. candidate = catalog[plan.voice] if plan.voice is a valid key, else null.
   3. **Mismatch guard:** if candidate exists AND inferred gender is confident (female|male) AND candidate.gender is the *opposite* binary gender → override to that gender's default voice. (Neutral candidate never overridden.)
   4. else if candidate exists → candidate.reference_id.
   5. else if inferred gender confident → gender default.
   6. else → `ctx.fish_audio_reference_id` (env default; backward compatible).
2. **Schema** — add `voice: z.enum([sarah,jasphina,ethan,energetic_male,alle]).nullable().default(null)` to `VideoPlanSchema`. Plan-level. YouTube path: `.default(null)` applies via `.parse`, no literal edit (b-roll uses fallback chain → env default).
3. **Threading** — `fishAudioTts(ctx, text, output, referenceId = ctx.fish_audio_reference_id)`; `generateSceneVoiceovers(ctx, scenes, referenceId?)` passes it through.
4. **Call sites** — resolve once per render and pass the reference_id: `animateSceneVideosImpl` (talking scenes), `buildPerSceneStitchInputs` (b-roll per-scene VO), and `generateVoiceoverImpl` (global VO). Each calls `resolveVoiceReferenceId(plan, ctx)`.
5. **Prompt** — list the catalog (key + gender + style) in `PLANNING_INSTRUCTIONS` and instruct: set `voice` to the entry whose gender + energy match the on-screen character in the visual bible.

## Tasks (TDD + spec + code-quality review each, push between)
- **VA:** `voices.ts` catalog + `inferCharacterGender` + `resolveVoiceReferenceId` (+ `voices.test.ts`: female bible→female voice; male bible→male; mismatch guard overrides; unset→gender default; ambiguous→env default).
- **VB:** schema `voice` field + thread `referenceId` through `fishAudioTts`/`generateSceneVoiceovers` (+ tests).
- **VC:** wire `resolveVoiceReferenceId` at the 3 call sites + prompt catalog/instruction (+ tests); then a real e2e re-run to confirm a female character gets a female voice.

## Verification
Unit tests for the resolver/heuristic; full suite + typecheck green; final e2e: a female-creator prompt → manifest `plan.voice` female + per-scene mp3 generated with the female reference_id (and audibly female).
