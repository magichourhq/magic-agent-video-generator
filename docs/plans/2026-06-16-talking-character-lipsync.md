# Talking-Character Lip-Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make an on-camera UGC character visibly speak by lip-syncing each marked scene's own Fish Audio line onto its clip, instead of overlaying one detached global voiceover on silent footage.

**Architecture:** Add a per-scene `on_camera` boolean to `SceneSchema` that **defaults to `true`** — because the agent-authored `SceneSchema` is used only by the **generative (UGC) path**, where talking humans are the product. The **YouTube-clip path** (`youtubeSectionsToVideoPlan`) builds its plan in code and explicitly sets `on_camera: false`, so it stays b-roll + per-section VO (which exists specifically so found YouTube clips can be matched to short segments). After the silent `imageToVideo` clip is produced, a folded-in post-pass generates that scene's own Fish Audio mp3 (single global `FISH_AUDIO_REFERENCE_ID` voice) and runs `silentClip + sceneAudio` through `v1.lipSync.generate`, overwriting the scene's video-artifact entry. `stitchFinalVideoImpl` branches: all-b-roll projects (e.g. YouTube) keep the existing global-VO overlay path byte-for-byte; any project with a talking scene (the UGC norm) routes every scene through the audio-preserving per-section assembler (each scene carries its own mp3, re-muxed after the `-an` normalize — so correctness never depends on whether the lipSync mp4 embeds audio). A pure-talking UGC video therefore has **no global voiceover** and every scene lip-synced. No new agent tool is added, so the tool-surface contract stays unchanged.

**Tech Stack:** TypeScript (ESM), Zod schemas, OpenAI Agents SDK tool surface, Magic Hour SDK (`v1.imageToVideo`, `v1.lipSync`), Fish Audio TTS, ffmpeg/ffprobe, Vitest 4.1.8.

---

## Locked decisions (do not revisit)

1. **Mechanism = AI Talking Photo (`v1.aiTalkingPhoto`).** For a talking scene, feed the `generate_scene_images` keyframe + that scene's audio straight into `v1.aiTalkingPhoto.generate({ assets:{ imageFilePath, audioFilePath }, startSeconds:0, endSeconds:audioDuration, style:{ generationMode:"realistic" } })` → talking clip in **one render**. Talking scenes SKIP `imageToVideo` entirely (≈ half the video wall-clock — the latency priority). b-roll cutaways still use `imageToVideo` (silent) + VO. **Superseded earlier choice:** an initial build used lip-sync over imageToVideo (2 renders/scene) to keep `video_prompt` motion; switched to Talking Photo on 2026-06-16 for latency + the selfie-to-camera UGC look. Trade-off accepted: talking scenes are talking-head/portrait motion (no `video_prompt` camera moves). `realistic` mode = best likeness, ≤180s.
2. **Single global voice.** All speech uses the existing `FISH_AUDIO_REFERENCE_ID` via `fishAudioTts`. No per-character voice catalog in this change.
3. **Generative/UGC path is talking-by-default.** `SceneSchema.on_camera` defaults to `true`; scenes are lip-synced talking humans unless the planner explicitly marks a scene `on_camera: false` for a deliberate b-roll cutaway (whose narration plays as VO over the cutaway). The **YouTube-clip path stays b-roll + VO** (`youtubeSectionsToVideoPlan` sets `on_camera: false` explicitly). This is *why* per-section VO exists — YouTube clip-matching, not UGC.

## ⚠️ MECHANISM CHANGE (2026-06-16): AI Talking Photo, not Lip Sync

This plan originally specified lip-sync over imageToVideo. It was switched to **AI Talking Photo** mid-execution (Tasks 1–6b were already merged; they are mechanism-agnostic and unaffected). The detailed specs for **Task 3, Task 5, and Task 6c below are SUPERSEDED** by the revised specs that follow each (look for "REVISED (Talking Photo)"). Net deltas vs the lip-sync build:
- **Task 3:** `generateLipSyncedClip` (v1.lipSync, takes a silent *video* + audio) → **`generateTalkingClip`** (v1.aiTalkingPhoto, takes the keyframe *image* + audio).
- **Task 5:** instead of "render all silent clips, then lip-sync talking ones", **partition** scenes: b-roll → `imageToVideo` (silent); talking → `generateTalkingClip(image, audio)` — both run in parallel, TTS overlapped. Talking scenes never get an imageToVideo render. On talking-render failure, fall back to a silent `imageToVideo` clip so the scene still appears.
- **Task 6c:** the original premise (restitch drops lip-synced audio) is FALSE — restitch routes through `stitchFinalVideoImpl` → (talking) `stitchMixedAssets`, which is audio-preserving regardless of mechanism. So **remove the guard** and add a regression test that a talking restitch preserves audio. (Residual: per-scene timeline trim/move edits aren't re-applied to talking videos — a non-data-loss follow-up.)
- **Tasks 4, 6, 6b, 7, 9, 10:** unaffected. **Task 8 (prompts):** for talking scenes `video_prompt` is now unused (no imageToVideo), so emphasize a clear front-facing `image_prompt` and note the talking-photo path in the model-catalog blurb.

## Conventions for every task

- **Working directory for all commands:** `server/` (e.g. `cd server`).
- **Test runner:** Vitest 4.1.8. Full suite: `npm test`. Single file by filename substring: `npm test -- <substr>`.
- **Typecheck gate:** `npm run typecheck` (= `tsc --noEmit`, strict). Baseline is EXIT 0; keep it green.
- **Baseline before starting:** `npm test` → `Test Files 8 passed (8), Tests 46 passed (46)`; `npm run typecheck` → exit 0.
- **TDD:** write the failing test, run it red, implement minimally, run it green, then commit.
- Network boundaries (`fishAudioTts` / `fetch`, `v1.lipSync.generate`) MUST be mocked in tests (`vi.mock` / `vi.stubGlobal`). Audio/video fixtures use the existing real-ffmpeg helpers `makeSilentVideo` / `makeTone` in `tests/media.test.ts`.

## Pipeline: before → after

```
BEFORE                                  AFTER
draft_video_plan                        draft_video_plan  (Scene.on_camera: bool; talking scenes = 1st-person dialogue)
  → generate_voiceover (1 global mp3)     → generate_voiceover (SKIPPED if all-talking; else global mp3 for b-roll cutaways)
  → generate_scene_images                 → generate_scene_images
  → animate_scene_videos (SILENT)         → animate_scene_videos (SILENT clip batch) + folded lip-sync post-pass:
                                              TTS for talking scenes runs CONCURRENTLY with the silent-clip batch
                                              then, all on_camera scenes IN PARALLEL:
                                                generateSceneVoiceovers([scene]) → voiceover/scenes/<id>.mp3  (overlapped above)
                                                generateLipSyncedClip(clip, mp3) → videos/<id>/lipsync/*.mp4
                                                overwrite videos[scene] (+has_embedded_audio,on_camera,audio_path,…)
  → stitch_final_video                    → stitch_final_video
      stitchFromTimelineOrFallback            if NO on_camera → stitchFromTimelineOrFallback (UNCHANGED, byte-for-byte)
      (-an strip + 1 global VO overlay)       else            → stitchMixedAssets / stitchAssetsPerSection
                                              (every scene normalized -an then re-muxed with its OWN mp3, hard-cut concat)
  → final.mp4 (silent + detached VO)      → final.mp4 (talking scenes lip-synced to their line; b-roll keeps VO; character SPEAKS)
```

---

### Task 1: Add `on_camera` flag to `SceneSchema` (+ fix the YouTube literal)

**Files:**
- Modify: `server/src/schemas.ts:104-110` (add field after `duration_seconds`, line 109)
- Modify: `server/src/workflows.ts:699-706` (the `youtubeSectionsToVideoPlan` literal at line 700 — REQUIRED, see below)
- Test: `server/tests/schemas.test.ts` (create)

> **Verified blocking-issue fix (doubly required now):** `z.boolean().default(...)` makes `on_camera` **required in the inferred `Scene` output type** (proven via isolated `tsc`: TS2741). The literal `const scenes: Scene[] = sections.map(...)` at `workflows.ts:700` omits it, so `npm run typecheck` will FAIL unless we add `on_camera: false` there. With the default now `true`, that explicit `false` is *also* what keeps the YouTube path b-roll — so it's load-bearing for both the typecheck gate AND correctness. `workflows.ts:280` (`const next: Scene = { ...scene }`) spreads an existing scene and is unaffected. No other hand-built `Scene` literals exist.
>
> **Caution (default flipped to `true`):** any existing test fixture or saved-plan path that *intends* b-roll and constructs scenes **via `SceneSchema.parse`/`VideoPlanSchema.parse`** will now default to talking. Audit such sites and add explicit `on_camera: false` where b-roll is intended (the existing all-b-roll timeline test at `timeline.test.ts:42-60` is the one to check — if it parses through the schema, pin `on_camera: false`; if it builds raw objects without parse, `on_camera` stays `undefined` and is treated as non-talking, so no change needed).

**Step 1: Write the failing test**

Create `server/tests/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SceneSchema, VideoPlanSchema } from "../src/schemas.js";

const baseScene = { id: "s1", narration: "hi", image_prompt: "p", video_prompt: "v", duration_seconds: 4 };

describe("SceneSchema on_camera", () => {
  it("defaults on_camera to true (UGC talking-by-default)", () => {
    expect(SceneSchema.parse(baseScene).on_camera).toBe(true);
  });
  it("round-trips an explicit b-roll opt-out", () => {
    expect(SceneSchema.parse({ ...baseScene, on_camera: false }).on_camera).toBe(false);
  });
  it("preserves per-scene flags through VideoPlanSchema", () => {
    const plan = VideoPlanSchema.parse({
      title: "t",
      narration: "n",
      scenes: [{ ...baseScene, id: "a" }, { ...baseScene, id: "b", on_camera: false }],
    });
    expect(plan.scenes.map((s) => s.on_camera)).toEqual([true, false]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- schemas`
Expected: FAIL — first assertion `expected undefined to be true` (field not yet on schema).

**Step 3: Implement**

In `server/src/schemas.ts`, inside `SceneSchema`, after the `duration_seconds` line (109), add:

```ts
  on_camera: z.boolean().default(true).describe("True (default) for UGC: a character on screen speaks this scene's first-person narration, lip-synced onto the clip. Set false ONLY for a deliberate b-roll cutaway whose narration plays as voiceover over the footage."),
```

Use `.default(true)` — NOT `.optional()`/`.nullable()` — matching the strict-JSON-schema convention of `require_captions` at `schemas.ts:156` (the Agents SDK emits strict schemas). Default `true` makes the generative/UGC agent path talking-by-default without depending on the planner setting a flag; the YouTube literal (next edit) pins `false`.

Then in `server/src/workflows.ts:700`, add `on_camera: false` to the mapped literal:

```ts
  const scenes: Scene[] = sections.map((section) => ({
    id: `scene_${section.section}`,
    narration: section.dialogue,
    image_prompt: section.search_hint,
    video_prompt: `YouTube clip search: ${section.search_hint}`,
    duration_seconds: section.duration_seconds,
    on_camera: false,
  }));
```

**Step 4: Run tests + typecheck to verify green**

Run: `cd server && npm test -- schemas && npm run typecheck`
Expected: schemas tests PASS; `tsc --noEmit` exits 0 (the literal fix prevents TS2741).

**Step 5: Commit**

```bash
git add server/src/schemas.ts server/src/workflows.ts server/tests/schemas.test.ts
git commit -m "feat(plan): add on_camera flag to SceneSchema"
```

---

### Task 2: Add `generateSceneVoiceovers` (per-scene Fish Audio, real `scene.id`, single voice)

**Files:**
- Modify: `server/src/media.ts` (insert after `generateSectionVoiceovers` ends, line 433)
- Test: `server/tests/media.test.ts` (extend)

**Step 1: Write the failing test**

Add to `server/tests/media.test.ts` (reuse its `makeTone` fixture; stub `fetch` since `fishAudioTts` writes the response body to disk then probes it — the stubbed body must be a real audio buffer):

```ts
import { generateSceneVoiceovers } from "../src/media.js";
// ... inside a describe block:
it("generateSceneVoiceovers keys by real scene.id and writes per-scene mp3", async () => {
  const tone = await makeTone(/* 1s fixture path */);
  const bytes = await fs.promises.readFile(tone);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));
  const ctx = /* a test ProjectContext with a temp project_dir + audio_format */;
  const out = await generateSceneVoiceovers(ctx, [
    { id: "scene_7", narration: "hello", image_prompt: "", video_prompt: "", duration_seconds: 2, on_camera: true },
  ]);
  expect(out[0].scene_id).toBe("scene_7");
  expect(out[0].path).toMatch(/voiceover\/scenes\/scene_7\./);
  expect(out[0].duration_seconds).toBeGreaterThan(0);
  vi.unstubAllGlobals();
});

it("generateSceneVoiceovers throws on blank narration", async () => {
  const ctx = /* temp ctx */;
  await expect(generateSceneVoiceovers(ctx, [
    { id: "s1", narration: "  ", image_prompt: "", video_prompt: "", duration_seconds: 2, on_camera: true },
  ])).rejects.toThrow(/No narration for scene/);
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- media`
Expected: FAIL — `generateSceneVoiceovers is not a function` / import error.

**Step 3: Implement**

Insert after `generateSectionVoiceovers` (after line 433) in `server/src/media.ts`:

```ts
export async function generateSceneVoiceovers(
  ctx: ProjectContext,
  scenes: Scene[],
): Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>> {
  const dir = path.join(ctx.project_dir, "voiceover", "scenes");
  resetProviderOutputDir(dir);
  return Promise.all(
    scenes.map(async (scene) => {
      const text = String(scene.narration ?? "").trim();
      if (!text) throw new Error(`No narration for scene ${scene.id}; cannot generate scene voiceover.`);
      const output = path.join(dir, `${scene.id}.${ctx.audio_format}`);
      const duration = await fishAudioTts(ctx, text, output);
      return { scene_id: scene.id, path: path.resolve(output), duration_seconds: Math.round(duration * 1000) / 1000 };
    }),
  );
}
```

Mirrors `generateSectionVoiceovers` (lines 409-433) but keys by the **real `scene.id`** (the section variant synthesizes `scene_${N}` at line 427 — we deliberately avoid that reconciliation hazard). `fishAudioTts` (line 332) already hardcodes `ctx.fish_audio_reference_id` (single voice). `Scene` is already imported at `media.ts:7`.

**Step 4: Run tests to verify green**

Run: `cd server && npm test -- media`
Expected: both new tests PASS.

**Step 5: Commit**

```bash
git add server/src/media.ts server/tests/media.test.ts
git commit -m "feat(media): add per-scene Fish Audio voiceover generation"
```

---

### Task 3: Add `generateLipSyncedClip` calling `v1.lipSync.generate`

**Files:**
- Modify: `server/src/media.ts` (insert after `generateVideoAsset` ends, line 192)
- Test: `server/tests/media.lipsync.test.ts` (create)

**Step 1: Write the failing test**

Create `server/tests/media.lipsync.test.ts`. Mock the SDK boundary so `magicHourClient(ctx).v1.lipSync.generate` returns `{ id: "p1", status: "complete", downloads: [{ url: "file://<fixture.mp4>" }] }` and `ensureProviderOutputDownloaded` resolves to a local fixture mp4 (built from `makeSilentVideo` + `makeTone` muxed). Assert the request shape and the returned asset:

```ts
it("generateLipSyncedClip calls v1.lipSync with file source and no resolution field", async () => {
  // arrange: spy/mock magicHourClient(...).v1.lipSync.generate
  const asset = await generateLipSyncedClip(ctx, scene, silentClipPath, audioPath, /*dur*/ 2.0);
  const req = lipSyncGenerateSpy.mock.calls[0][0];
  expect(req.assets.videoSource).toBe("file");
  expect(req.assets.audioFilePath).toBe(path.resolve(audioPath));
  expect(req.assets.videoFilePath).toBe(path.resolve(silentClipPath));
  expect(req.startSeconds).toBe(0);
  expect(req.endSeconds).toBe(2.0);
  expect(req.style.generationMode).toBe("lite");
  expect(req).not.toHaveProperty("resolution");
  expect(req).not.toHaveProperty("height");
  expect(req).not.toHaveProperty("width");
  expect(asset.has_embedded_audio).toBe(true);
  expect(asset.on_camera).toBe(true);
  expect(asset.audio_path).toBe(path.resolve(audioPath));
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- lipsync`
Expected: FAIL — `generateLipSyncedClip is not a function`.

**Step 3: Implement**

Insert after `generateVideoAsset` (after line 192) in `server/src/media.ts`:

```ts
export async function generateLipSyncedClip(
  ctx: ProjectContext,
  scene: Scene,
  silentClipPath: string,
  audioPath: string,
  audioDuration: number,
): Promise<VideoAsset & { has_embedded_audio: boolean; audio_path: string; audio_duration_seconds: number; on_camera: boolean }> {
  const outDir = path.join(ctx.project_dir, "videos", scene.id, "lipsync");
  resetProviderOutputDir(outDir);
  const result: any = await magicHourClient(ctx).v1.lipSync.generate(
    {
      assets: { audioFilePath: path.resolve(audioPath), videoFilePath: path.resolve(silentClipPath), videoSource: "file" },
      startSeconds: 0,
      endSeconds: audioDuration,
      name: `${ctx.project_id}-${scene.id}-lipsync`,
      style: { generationMode: "lite" },
    },
    { waitForCompletion: true, downloadOutputs: false, downloadDirectory: outDir },
  );
  const downloaded = await ensureProviderOutputDownloaded(result, outDir, "lipsync");
  return {
    scene_id: scene.id,
    path: downloaded,
    prompt: scene.video_prompt,
    model: ctx.video_model,
    resolution: ctx.resolution,
    audio: true,
    duration_seconds: Math.round(audioDuration * 1000) / 1000,
    provider_job_id: result?.id ?? null,
    provider_url: firstDownloadUrl(result),
    has_embedded_audio: true,
    audio_path: path.resolve(audioPath),
    audio_duration_seconds: Math.round(audioDuration * 1000) / 1000,
    on_camera: true,
  };
}
```

Notes (all verified against `server/node_modules/magic-hour/.../lip-sync/*.d.ts`):
- `style.generationMode: "lite"` is the only free-tier-safe mode (`standard`/`pro` require Creator/Pro/Business).
- lipSync has **no** `resolution` field; `height`/`width` are deprecated/ignored — do not pass them.
- `endSeconds = audioDuration` (`> 0`, `> startSeconds`).
- `has_embedded_audio: true` is a **label only**. Tasks 5–6 re-mux the known scene mp3 regardless, so nothing depends on the lipSync mp4 actually embedding audio. `VideoAsset` has a `[key: string]: any` index signature (`media.ts:21-33`), so the extra fields type-check.

**Step 4: Run tests to verify green**

Run: `cd server && npm test -- lipsync`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/media.ts server/tests/media.lipsync.test.ts
git commit -m "feat(media): add generateLipSyncedClip via v1.lipSync"
```

---

### Task 4: Add `anyEmbeddedAudio` decision seam + `stitchMixedAssets` dispatcher

**Files:**
- Modify: `server/src/media.ts` (insert after `stitchAssetsPerSection` ends, line 1079)
- Test: `server/tests/media.test.ts` (extend)

**Step 1: Write the failing test**

Add to `server/tests/media.test.ts` (uses real `makeSilentVideo`/`makeTone`, no network):

```ts
import { anyEmbeddedAudio, stitchMixedAssets } from "../src/media.js";

it("anyEmbeddedAudio detects talking scenes", () => {
  expect(anyEmbeddedAudio([{ has_embedded_audio: true }])).toBe(true);
  expect(anyEmbeddedAudio([{ on_camera: true }])).toBe(true);
  expect(anyEmbeddedAudio([{}])).toBe(false);
});

it("stitchMixedAssets muxes each scene's own audio", async () => {
  const silent = await makeSilentVideo(/*1s*/);
  const tone = await makeTone(/*1s*/);
  const final = await stitchMixedAssets(ctx, [
    { video_path: silent, audio_path: tone, audio_duration_seconds: 1 },
    { video_path: silent, audio_path: tone, audio_duration_seconds: 1 },
  ], {});
  const streams = await probeMediaStreamDurations(final);
  expect(streams.audio_duration_seconds).not.toBeNull();
  expect(streams.format_duration_seconds).toBeGreaterThan(1.5);
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- media`
Expected: FAIL — `anyEmbeddedAudio` / `stitchMixedAssets` not exported.

**Step 3: Implement**

Insert after `stitchAssetsPerSection` (after line 1079) in `server/src/media.ts`:

```ts
export function anyEmbeddedAudio(videos: Array<Record<string, any>>): boolean {
  return videos.some((v) => v.has_embedded_audio === true || v.on_camera === true);
}

export async function stitchMixedAssets(
  ctx: ProjectContext,
  scenes: PerSectionScene[],
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  return stitchAssetsPerSection(ctx, scenes, options);
}
```

`stitchMixedAssets` is a thin named entry point so the workflow has one mixed-mode call site, reusing the **already-correct audio-preserving** per-section machinery. Do NOT touch `stitchAssets` (648), `stitchTimelineAssets` (798), or `normalizeSceneVideoForStitch` (600-641) — the `-an` at line 634 stays, because `muxSection` (934) re-adds each scene's `audio_path` *after* normalize. `PerSectionScene` interface is at `media.ts:967-972`.

**Step 4: Run tests to verify green**

Run: `cd server && npm test -- media`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/media.ts server/tests/media.test.ts
git commit -m "feat(media): add anyEmbeddedAudio seam + stitchMixedAssets dispatcher"
```

---

### Task 5: Fold lip-sync post-pass into `animateSceneVideosImpl` (parallel; TTS overlapped)

**Files:**
- Modify: `server/src/workflows.ts` — insertion **A** just before the video batch at line 608; insertion **B** between line 622 and 624
- Modify: `server/src/workflows.ts:5-17` (add `generateSceneVoiceovers`, `generateLipSyncedClip` to the `./media.js` import)
- Test: `server/tests/workflows.lipsync.test.ts` (create)

> **Latency design (mechanism = lipSync over imageToVideo, kept).** Two video renders per talking scene is the accepted cost for cinematic motion; we pay it in *parallel*, not serially. (1) Per-scene TTS doesn't depend on the silent clip, so kick it off **before** the `generateVideoAssetsBatch` await (line 608) — it runs concurrently with the imageToVideo batch and is done by the time clips land. (2) The lip-sync jobs run **all in parallel** (mirroring `generateVideoAssetsBatch`'s own unbounded `Promise.allSettled`; scenes are capped at 10). Net video-gen wall-clock ≈ `max(imageToVideo) + max(lipSync)`, not `sum(...)`.

**Step 1: Write the failing test**

Create `server/tests/workflows.lipsync.test.ts`. `vi.mock("../src/media.js")` so `generateVideoAssetsBatch` returns fake silent `VideoAsset`s, `generateSceneVoiceovers` returns fake `{scene_id,path,duration_seconds}`, `generateLipSyncedClip` returns a fake synced asset (`has_embedded_audio:true`). Use a real temp `project_dir`; seed a `video_plan` artifact (one `on_camera:true` + one `on_camera:false` scene) and an `images` artifact for both, then call `animateSceneVideosImpl`. Assert:
- (a) `generateSceneVoiceovers` called ONLY with the talking scene;
- (b) `generateLipSyncedClip` called exactly once, with the talking scene's silent clip path + that scene's audio;
- (c) persisted `videos` artifact has `has_embedded_audio:true` ONLY on the talking entry; the b-roll entry is unchanged (no `audio_path`);
- (d) when `generateLipSyncedClip` throws, a `{stage:"lip_sync"}` failure is recorded AND the silent clip path is retained;
- (e) a pure-b-roll plan does NOT call `generateLipSyncedClip`.

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- workflows.lipsync`
Expected: FAIL — assertions on lip-sync calls fail (no post-pass yet).

**Step 3: Implement**

In `server/src/workflows.ts`, add to the `./media.js` import (lines 5-17): `generateSceneVoiceovers`, `generateLipSyncedClip`.

**Insertion A — overlap TTS with the video batch.** Immediately BEFORE `const videoResults = await generateVideoAssetsBatch(...)` (line 608), kick off per-scene TTS concurrently (it depends only on `scene.narration`, not the clips):

```ts
  const talkingScenes = selectedScenes.filter((s) => (s as any).on_camera === true);
  const sceneAudioPromise: Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>> =
    talkingScenes.length > 0 ? generateSceneVoiceovers(videoCtx, talkingScenes) : Promise.resolve([]);
```

**Insertion B — parallel lip-sync.** After the `videoScenePairs.forEach` loop populates `videos` (lines 614-622) and BEFORE `const mergedVideos = ...` (line 624), insert:

```ts
  const videoByScene = new Map(videos.map((v) => [String(v.scene_id), v]));
  const sceneAudios = await sceneAudioPromise; // already running since before the video batch
  const audioByScene = new Map(sceneAudios.map((a) => [a.scene_id, a]));
  await Promise.all(
    talkingScenes
      .filter((scene) => videoByScene.has(scene.id) && audioByScene.has(scene.id))
      .map(async (scene) => {
        const silent = videoByScene.get(scene.id)!;
        const audio = audioByScene.get(scene.id)!;
        try {
          const synced = await generateLipSyncedClip(videoCtx, scene, String(silent.path), audio.path, audio.duration_seconds);
          Object.assign(silent, synced);
        } catch (err) {
          console.warn(`Lip-sync failed for ${scene.id}; keeping silent clip`, err);
          failures.push({ scene_id: scene.id, stage: "lip_sync", error: err instanceof Error ? err.message : String(err) });
        }
      }),
  );
```

The `Promise.all` of per-scene async fns (each with its own try/catch) never rejects — it mirrors `generateVideoAssetsBatch`'s all-at-once parallelism and bounds wall-clock to the slowest single lip-sync, not the sum. `videos` holds object references; `orderedSceneAssets`/`upsertSceneAssets` (`renderState.ts:190-199`) reuse the same references, so `Object.assign` mutations survive into `mergedVideos` (built at line 624, persisted at 628). `failures` is already declared at line 612 and recorded at 627. `selectedScenes` (578) and `videoCtx` (579) are in scope at both insertion points. b-roll scenes (`on_camera` falsy) are untouched. `clearRenderOutputs` (320-334) already recursively removes `voiceover` and `videos`, cleaning `voiceover/scenes` and `videos/<id>/lipsync` on re-run. `next_tools` at line 653 is unchanged.

**Step 4: Run tests to verify green**

Run: `cd server && npm test -- workflows.lipsync && npm run typecheck`
Expected: PASS; typecheck exit 0.

**Step 5: Commit**

```bash
git add server/src/workflows.ts server/tests/workflows.lipsync.test.ts
git commit -m "feat(workflows): lip-sync on_camera scenes during animate step"
```

---

### Task 6: Branch `stitchFinalVideoImpl` on talking scenes; relax the voiceover guard

**Files:**
- Modify: `server/src/workflows.ts:657-697`
- Modify: `server/src/workflows.ts:5-17` (add `anyEmbeddedAudio`, `stitchMixedAssets` to the `./media.js` import; add `PerSectionScene` type import if needed)
- Test: `server/tests/workflows.lipsync.test.ts` (extend)

**Step 1: Write the failing test**

Extend `server/tests/workflows.lipsync.test.ts` (media.ts mocked; spy `stitchMixedAssets` and `stitchFromTimelineOrFallback`; mock `stitchMixedAssets` to return a fake final path). Assert:
- (a) a plan with ≥1 `on_camera` scene routes through `stitchMixedAssets` with per-scene inputs carrying `audio_path` for talking scenes;
- (b) a pure-b-roll plan routes through `stitchFromTimelineOrFallback` and STILL throws when the voiceover artifact is absent;
- (c) a talking-ONLY plan with no voiceover does NOT throw.

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- workflows.lipsync`
Expected: FAIL — assertion (c) hits the current `if (!voiceover) throw`.

**Step 3: Implement**

In `server/src/workflows.ts`, add `anyEmbeddedAudio`, `stitchMixedAssets` to the `./media.js` import (and `PerSectionScene` type if used).

In `stitchFinalVideoImpl` (657-697):

1. After `const videos = ...` (line 660), add:
   ```ts
   const hasTalking = anyEmbeddedAudio(videos as any[]);
   ```
2. Relax the guard at 670-672: `if (!voiceover)` → `if (!voiceover && !hasTalking)`. (Any b-roll scene still requires the global VO; talking-only projects no longer do.)
3. Add a helper (above `stitchFinalVideoImpl`):
   ```ts
   async function buildPerSceneStitchInputs(ctx: ProjectContext, plan: VideoPlan, videos: JsonDict[]): Promise<PerSectionScene[]> {
     const result: PerSectionScene[] = [];
     for (const v of videos) {
       if (v.on_camera || v.has_embedded_audio) {
         result.push({ video_path: String(v.path), audio_path: String(v.audio_path), audio_duration_seconds: Number(v.audio_duration_seconds) });
       } else {
         const scene = plan.scenes.find((s) => s.id === String(v.scene_id))!;
         const [vo] = await generateSceneVoiceovers(ctx, [scene]);
         result.push({ video_path: String(v.path), audio_path: vo.path, audio_duration_seconds: vo.duration_seconds });
       }
     }
     return result;
   }
   ```
4. Replace the single stitch call at line 683:
   ```ts
   let finalVideo: string;
   if (hasTalking) {
     const perScene = await buildPerSceneStitchInputs(ctx, plan, videos);
     const target = timelineTargetDurationSeconds(timeline, explicitTargetFinalDurationSeconds(requestFromProjectState(ctx)));
     finalVideo = await stitchMixedAssets(ctx, perScene, { target_duration_seconds: target });
   } else {
     finalVideo = await stitchFromTimelineOrFallback(ctx, videos, voiceover!, timeline);
   }
   ```

`voiceover` is still loaded (661) and recorded in the manifest (684-694). Talking projects MUST take the `stitchMixedAssets` branch because `stitchFromTimelineOrFallback`/`stitchTimelineAssets` are NOT audio-preserving (`-an` at 841/891 + single-VO overlay) — this is a load-bearing routing change. The helpers `timelineTargetDurationSeconds`, `explicitTargetFinalDurationSeconds`, `requestFromProjectState` are already imported/used (18, 23, 202-204).

> **Talking-by-default note:** for UGC the common case is all-talking → `hasTalking` is true and there are no b-roll scenes, so `buildPerSceneStitchInputs` just passes each lip-synced scene's own audio through (the b-roll branch is the rare cutaway path). Also skip `generate_voiceover` when `plan.scenes.every((s) => s.on_camera)` (see resolved Open decision E) — Task 6b below.

**Step 4: Run tests + typecheck**

Run: `cd server && npm test -- workflows.lipsync && npm run typecheck`
Expected: all three assertions PASS; typecheck exit 0.

**Step 5: Commit**

```bash
git add server/src/workflows.ts server/tests/workflows.lipsync.test.ts
git commit -m "feat(workflows): route talking projects through audio-preserving stitch"
```

---

### Task 6b: Skip the global voiceover for all-talking (pure UGC) plans

**Files:**
- Modify: `server/src/workflows.ts` (`generateVoiceoverImpl`, ~line 486, calls `generateVoiceoverAsset(ctx, plan.narration, ...)`)
- Test: `server/tests/workflows.lipsync.test.ts` (extend)

> Resolves Open decision E. A pure-talking UGC plan needs no global VO; generating one is wasted work and a misleading manifest artifact. When ≥1 b-roll cutaway exists, keep generating it (its narration feeds the cutaway's VO and the b-roll fallback).

**Step 1: Write the failing test**

Extend `server/tests/workflows.lipsync.test.ts`: assert that `generateVoiceoverImpl` on a plan where every scene is `on_camera:true` does NOT call `generateVoiceoverAsset` (spy it) and does not persist a `voiceover` artifact; and that a plan with ≥1 `on_camera:false` scene DOES.

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- workflows.lipsync`
Expected: FAIL — `generateVoiceoverAsset` is still called for the all-talking plan.

**Step 3: Implement**

In `generateVoiceoverImpl` (~486), early-return a skip result when `plan.scenes.length > 0 && plan.scenes.every((s) => (s as any).on_camera === true)` (no global VO needed). Return a shape the downstream tool flow tolerates (e.g. `{ skipped: true }` / `next_tools` unchanged) and do NOT write the `voiceover` artifact. Verify the stitch step's relaxed guard (Task 6) already permits the missing artifact for talking-only plans.

**Step 4: Run tests + typecheck**

Run: `cd server && npm test -- workflows.lipsync && npm run typecheck`
Expected: PASS; typecheck exit 0.

**Step 5: Commit**

```bash
git add server/src/workflows.ts server/tests/workflows.lipsync.test.ts
git commit -m "feat(workflows): skip global voiceover for all-talking UGC plans"
```

---

### Task 6c: Guard `restitch_timeline` on talking projects (prevent silent audio loss)

**Files:**
- Modify: `server/src/workflows.ts` (`restitchTimelineImpl` at line 1410, and/or `restitchVideoImpl` it calls at line 1415)
- Test: `server/tests/workflows.lipsync.test.ts` (extend)

> Resolves Open decision B with the **guard** option. `restitch_timeline` → `restitchVideoImpl` → `stitchTimelineAssets`, which strips clip audio (`-an`) and overlays only the global VO (`media.ts:841/891`). On a talking project that would **silently discard the lip-synced dialogue**. Until the timeline stitch is made audio-preserving (deferred follow-up), refuse the destructive path instead of running it.

**Step 1: Write the failing test**

Extend `server/tests/workflows.lipsync.test.ts`: seed a project whose `videos` artifact has ≥1 entry with `on_camera:true`/`has_embedded_audio:true`, call `restitchTimelineImpl`, and assert it does NOT invoke `stitchTimelineAssets` (spy it) and returns a clear "not supported for talking videos" result (the existing `final.mp4` is left intact). Also assert an all-b-roll project still restitches normally (control).

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- workflows.lipsync`
Expected: FAIL — `stitchTimelineAssets` is still called for the talking project.

**Step 3: Implement**

At the top of `restitchVideoImpl` (or `restitchTimelineImpl` before it calls through), read the `videos` artifact and short-circuit when talking:

```ts
  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  if (anyEmbeddedAudio(videos as any[])) {
    return {
      project_id: ctx.project_id,
      stage: "restitch_skipped",
      message: "Timeline re-stitch is not supported for talking (lip-synced) videos yet — it would drop the synced dialogue. The existing final video already reflects the lip-synced audio.",
      next_tools: [],
    };
  }
```

Add `anyEmbeddedAudio` to the `./media.js` import if not already present (Task 6 added it). Do NOT run `stitchTimelineAssets` in the talking case. b-roll/YouTube projects are unaffected.

**Step 4: Run tests + typecheck**

Run: `cd server && npm test -- workflows.lipsync && npm run typecheck`
Expected: PASS; typecheck exit 0.

**Step 5: Commit**

```bash
git add server/src/workflows.ts server/tests/workflows.lipsync.test.ts
git commit -m "fix(workflows): guard restitch_timeline against dropping lip-synced audio"
```

> **Deferred follow-up (Decision B option b):** make `stitchTimelineAssets` carry per-clip embedded audio so timeline trim/move/hold edits can be re-rendered on talking videos. Out of scope for this plan.

---

### Task 7: Timeline — stamp talking metadata + gap narration over talking spans

**Files:**
- Modify: `server/src/timeline.ts:180-213`
- Test: `server/tests/timeline.test.ts` (extend)

> This affects timeline/UI fidelity and any future timeline-driven re-stitch. The Task 6 talking render path uses `stitchMixedAssets`, not the timeline stitch, so this does not change rendered audio for talking projects today — it keeps the model truthful (no global VO "double-speaking" over lip-synced dialogue).

**Step 1: Write the failing test**

Extend `server/tests/timeline.test.ts`: add a `projectState` with scenes `[{id:"scene_1",on_camera:true,duration_seconds:4,narration:"hi"},{id:"scene_2",on_camera:false,duration_seconds:5,narration:"yo"}]` and videos carrying `has_embedded_audio` true/false respectively. Assert:
- video track `clip[0].metadata.has_embedded_audio === true`; `clip[1]` has no `has_embedded_audio`;
- narration track has NO clip overlapping scene_1's `[0,4]` span (gap over talking) and DOES cover scene_2's `[4,9]`;
- the EXISTING all-b-roll test (`timeline.test.ts:42-60`) still produces the single full-span narration clip.

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- timeline`
Expected: FAIL — narration still spans `[0,9]`; no metadata stamped.

**Step 3: Implement**

In `server/src/timeline.ts` videoClips metadata block (180-189), add (matching the existing `?? undefined` optional-metadata idiom):

```ts
        has_embedded_audio: asset.has_embedded_audio === true || undefined,
        on_camera: asset.on_camera === true || undefined,
```

In the narrationClips block (193-213): compute talking spans and emit narration only over the b-roll complement:

```ts
  const talkingSpans = videoClips
    .filter((c) => c.metadata?.on_camera || c.metadata?.has_embedded_audio)
    .map((c) => [c.timeline_start, c.timeline_end] as const);
```

If `talkingSpans.length === 0`, keep the EXISTING single `[0, voiceoverDuration]` clip unchanged (all-b-roll preserved). Otherwise emit narration clips only over the contiguous b-roll spans (the complement of `talkingSpans` within `[0, cursor]`); emit none if the complement is empty (all-talking). `TimelineTrackKind` stays `video|narration|guard` — the talking marker lives on video-clip metadata, not a new track kind.

**Step 4: Run tests to verify green**

Run: `cd server && npm test -- timeline`
Expected: new assertions PASS; existing all-b-roll test still PASS.

**Step 5: Commit**

```bash
git add server/src/timeline.ts server/tests/timeline.test.ts
git commit -m "feat(timeline): gap narration over lip-synced talking spans"
```

---

### Task 8: Prompts — first-person dialogue for `on_camera`, lip-sync as a separate post-process

**Files:**
- Modify: `server/src/prompts.ts:319-332` (ltx-2.3 catalog blurb, line 320)
- Modify: `server/src/prompts.ts:905-919` (`INSTRUCTIONS`)
- Modify: `server/src/prompts.ts:934-958` (`PLANNING_INSTRUCTIONS`)
- Test: `server/tests/prompts.test.ts` (create)

**Step 1: Write the failing test**

Create `server/tests/prompts.test.ts` (pure string assertions on exported constants, mirroring the existing `youtubePrompts` test style):

```ts
import { describe, it, expect } from "vitest";
import { INSTRUCTIONS, PLANNING_INSTRUCTIONS } from "../src/prompts.js";
// import the model-catalog builder used at prompts.ts:309 (magicHourModelCatalogForAgent)

describe("prompt contract for on_camera dialogue", () => {
  it("INSTRUCTIONS allows on_camera first-person dialogue but keeps video prompts motion-only", () => {
    expect(INSTRUCTIONS).toContain("on_camera");
    expect(INSTRUCTIONS).toContain("first-person");
    expect(INSTRUCTIONS).toContain("camera motion and subject motion only"); // regression: no speech in video_prompt
  });
  it("PLANNING_INSTRUCTIONS documents on_camera", () => {
    expect(PLANNING_INSTRUCTIONS).toContain("on_camera");
  });
  it("model catalog flags lip-sync as a separate post-process", () => {
    const catalog = /* magicHourModelCatalogForAgent(...) */;
    expect(catalog).toContain("separate lip-sync post-process");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npm test -- prompts`
Expected: FAIL — the new strings are absent.

**Step 3: Implement**

1. `INSTRUCTIONS` (905-919): reframe the narration bullet (~908) so dialogue is the DEFAULT:
   > "These are UGC videos: by default every scene shows a creator on camera speaking to the viewer (`on_camera=true`, the default). Write each scene's narration as natural FIRST-PERSON spoken dialogue — what the creator actually says. The mouth motion comes from a SEPARATE lip-sync pass, NOT the video_prompt. Set `on_camera=false` ONLY for a deliberate b-roll cutaway (e.g. a product/screen shot); that scene's narration then plays as voiceover over the footage."

   After the video-prompt rule (~916) add:
   > "For `on_camera` scenes keep `video_prompt` motion-only (no speech text) and make `image_prompt` show a clear, front-facing, lip-sync-suitable face that stays stable enough to lip-sync."

   Keep the existing "camera motion and subject motion only" sentence intact.
2. `PLANNING_INSTRUCTIONS` (934-958): rewrite the combine-cleanly bullet (945-946) — UGC scenes are first-person dialogue spoken by the on-screen creator and need NOT read as one continuous third-person VO; only b-roll-cutaway (`on_camera=false`) narrations are voiceover and should read cleanly as VO. Add a bullet documenting `on_camera` (default true) and when to set it false. Note that `plan.narration` is no longer the primary script for UGC (per-scene `narration` is); it remains a summary/fallback used only when b-roll cutaways exist.
3. `magicHourModelCatalogForAgent` ltx-2.3 blurb (line 320): the line currently reads "…with audio, lip-sync, and end frame support" — **rewrite it** (don't just append) to remove the implication that the I2V audio flag drives speech, e.g.:
   > "Character speech is produced by a separate lip-sync post-process (over the silent clip + the scene's Fish Audio line) for `on_camera` scenes, NOT by the I2V model audio flag — keep audio off on the animate step."

   Keep the single-voice note and the bracketed S2 expression-cue note (`prompts.ts:393-395`).

**Step 4: Run tests to verify green**

Run: `cd server && npm test -- prompts`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/prompts.ts server/tests/prompts.test.ts
git commit -m "feat(prompts): allow on_camera first-person dialogue; clarify lip-sync"
```

---

### Task 9: Update agent tool descriptions (no new tool; keep contract green)

**Files:**
- Modify: `server/src/agents.ts:64-88` (`draft_video_plan` description, 66-70)
- Modify: `server/src/agents.ts:140-172` (`animate_scene_videos` description, audio clause 148-149)
- Test: `server/tests/agentContracts.test.ts` (run unchanged as a regression guard)

**Step 1: Run the regression guard first (must already be green)**

Run: `cd server && npm test -- agentContracts`
Expected: PASS (16-tool `expectedVideoStudioTools` at lines 12-30 equals `videoAgent.tools`; all `deferLoading: true`). The test asserts names/types/deferLoading only — not description strings.

**Step 2: Implement (description-only edits)**

No NEW tool (lip-sync is folded into `animateSceneVideosImpl`). Do NOT change tool names, parameters, `deferLoading`, or the `VIDEO_STUDIO_TOOLS` array (declared at `agents.ts:506`).

- `draft_video_plan` description (66-70): append — "Scenes with `on_camera:true` are lip-synced to their own first-person narration line so the character appears to speak; leave `on_camera:false` (default) for detached-voiceover b-roll."
- `animate_scene_videos` description (near the audio clause at 148-149): append — "On-camera (talking) scenes are automatically lip-synced to a per-scene Fish Audio line after animation, so keep `audio:false` — provider audio is not the speech source."

**Step 3: Run the contract test again to verify still green**

Run: `cd server && npm test -- agentContracts && npm run typecheck`
Expected: PASS; typecheck exit 0. (Description edits don't touch the asserted surface.)

**Step 4: Commit**

```bash
git add server/src/agents.ts
git commit -m "docs(agents): surface on_camera lip-sync in tool descriptions"
```

---

### Task 10: Full-suite verification + first real-output ffprobe check

**Files:**
- Test: `server/tests/` (run all)

**Step 1: Run the full suite + typecheck**

Run: `cd server && npm test && npm run typecheck`
Expected: all prior 46 tests plus the new `schemas` / `media` / `lipsync` / `workflows.lipsync` / `timeline` / `prompts` tests green; `tsc --noEmit` exit 0.

**Step 2: One runtime check types cannot prove (gated on a real key)**

With a real `MAGIC_HOUR_API_KEY`, run `generateLipSyncedClip` on a short fixture and `probeMediaStreamDurations` the output — confirm whether `audio_duration_seconds` is non-null (does the lipSync mp4 embed audio?). The design does NOT depend on this (Task 6 re-muxes the known scene mp3 regardless); the result only informs a FUTURE optimization (skip the re-mux for talking scenes if the output reliably embeds audio). Record the finding in the project decision log. Observational only — not a CI assertion.

**Step 3: Commit (if anything was recorded)**

```bash
git add -A
git commit -m "chore: full-suite verification of talking-character lip-sync"
```

---

## Risks (carried from verification)

1. **lipSync embedded-audio is unprovable from types.** MITIGATED: Task 6 always re-muxes the known scene mp3 via `stitchAssetsPerSection`/`muxSection`; `has_embedded_audio` is a label, not load-bearing. Task 10 ffprobes only to inform a future optimization.
2. **`normalizeSceneVideoForStitch` always `-an`s (media.ts:634).** The talking path relies on `muxSection` re-adding the scene mp3 after normalize. The lip-synced clip's own audio is discarded and replaced by the identical scene mp3 — correct only because the same line drives both. Documented.
3. **`standard`/`pro` modes need paid tiers.** Default `lite` chosen. A per-scene lip-sync failure is caught (Task 5 try/catch) and demoted to the silent clip + a `lip_sync` failure entry, so one bad scene never fails the whole render.
4. **lipSync has no resolution field.** Output follows the input clip + account tier (free ~576px). ABSORBED: `normalizeSceneVideoForStitch` rescales every clip to `targetFrameSize` before `muxSection`.
5. **Duration mismatch.** `endSeconds = scene mp3 duration`, not `scene.duration_seconds`; `muxSection` clamps via freeze-last-frame/trim. Task 8 prompt nudges the planner to size talking-scene durations near the spoken line.
6. **Crossfade → hard-cut for any project with a talking scene.** Intentional for audio-sync correctness; visible change for mixed plans. All-b-roll plans are unaffected (still `stitchFromTimelineOrFallback`).
7. **`restitch_timeline` / `stitchTimelineAssets` are NOT audio-preserving.** A restitch on a talking project would drop lip-synced audio. Task 6 routes the primary stitch around it, but the `restitch_timeline` tool path is not yet talking-aware — see Open decision B.
8. **Latency: lipSync = a 2nd video render per talking scene** (imageToVideo → lipSync). This is the accepted cost of keeping cinematic motion (mechanism decision). MITIGATED, not eliminated: Task 5 runs TTS concurrently with the imageToVideo batch and fires all lip-sync jobs in parallel, so wall-clock ≈ `max(imageToVideo) + max(lipSync)` rather than the sum. Per-scene TTS also multiplies Fish Audio calls (raising 429 risk; `fishAudioTts` already retries 429×4) but those overlap the video batch and are off the critical path. If end-to-end time later becomes the priority over motion, `aiTalkingPhoto` (one render/scene) is the drop-in alternative — see the mechanism note.

## Open decisions

**Resolved by the talking-by-default decision (2026-06-16):**

- **A. Mixed-project b-roll audio — RESOLVED.** With talking-by-default, b-roll is a rare per-scene cutaway, not the norm. A cutaway scene gets its own per-scene Fish Audio take (from its `narration`), muxed over the footage as VO — no lip-sync, no face needed. The "re-take seams" concern was about *many* b-roll scenes; with b-roll as the exception it's a non-issue. The global VO-slicing alternative is dropped. (Pure-talking videos have no b-roll and no global VO at all.)
- **E. Global VO — RESOLVED.** A pure-talking UGC video has no global voiceover (Task 6's relaxed guard already permits this). `generate_voiceover` should be **skipped when every scene is `on_camera`** (all-talking) and run only when ≥1 b-roll cutaway exists. *Implementation note for the executor:* add a small guard in `generateVoiceoverImpl` (or its caller) to no-op / skip persistence when `plan.scenes.every((s) => s.on_camera)`. Add this as a sub-step of Task 6 or a small Task 6b; keep the manifest entry optional in the all-talking case.

- **B. `restitch_timeline` on talking projects — RESOLVED (guard now).** Implemented as **Task 6c**: refuse the destructive timeline re-stitch when any scene is `on_camera`, leaving the existing lip-synced `final.mp4` intact. The proper fix (make the timeline stitch audio-preserving) is a documented deferred follow-up.

**Soft / deferred (default chosen; revisit post-merge):**

- **C. `generationMode`.** DEFAULT: hardcoded `lite` (free-tier safe) + per-scene demote-on-failure (Task 5). Revisit threading `ctx.lip_sync_mode` with auto-retry-lite if a higher-fidelity tier is wanted.
- **D. Dialogue quality for `on_camera` scenes** depends on the planner authoring usable first-person `scene.narration`. DEFAULT: rely on the Task 8 prompt change. Revisit adding a validation step (reject empty/third-person `on_camera` narration) if quality is inconsistent in practice.

## Verification provenance

Synthesized from a map → design → adversarial-verify workflow (run `wf_fd0c2436-4af`). Both verifiers re-opened the real files; the only blocking issue found (the `workflows.ts:700` TypeScript break) is folded into **Task 1** above and re-confirmed directly. All cited line numbers/signatures were confirmed against the working tree on 2026-06-16.
