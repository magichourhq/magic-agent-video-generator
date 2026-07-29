import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import { initializeProjectState, readProjectState, updateProjectState } from "../src/renderState.js";
import {
  buildTimelineFromProjectState,
  setFinalHold,
  timelineSummary,
} from "../src/timeline.js";

describe("timeline model", () => {
  const projectState = {
    current_plan: {
      scenes: [
        { id: "scene_1", duration_seconds: 4, narration: "Open strong." },
        { id: "scene_2", duration_seconds: 5, narration: "Show proof." },
      ],
    },
    scene_assets: {
      voiceover: { path: "/tmp/voiceover.mp3", duration_seconds: 9 },
      videos: [
        {
          scene_id: "scene_2",
          path: "/tmp/scene-2.mp4",
          duration_seconds: 5,
          start_seconds: 12,
          end_seconds: 17,
        },
        {
          scene_id: "scene_1",
          path: "/tmp/scene-1.mp4",
          duration_seconds: 4,
          start_seconds: 30,
          end_seconds: 34,
        },
      ],
    },
  };

  it("derives ordered video/narration tracks without a default freeze hold", () => {
    const timeline = buildTimelineFromProjectState(projectState);
    const videoTrack = timeline.tracks.find((track) => track.kind === "video");
    const narrationTrack = timeline.tracks.find((track) => track.kind === "narration");
    const guardTrack = timeline.tracks.find((track) => track.kind === "guard");

    expect(videoTrack?.clips.map((clip) => clip.scene_id)).toEqual(["scene_1", "scene_2"]);
    expect(videoTrack?.clips.map((clip) => [clip.timeline_start, clip.timeline_end])).toEqual([
      [0, 4],
      [4, 9],
    ]);
    expect(narrationTrack?.clips[0]).toMatchObject({
      source_start: 0,
      source_end: 9,
      timeline_start: 0,
      timeline_end: 9,
      end_behavior: "cut",
    });
    expect(guardTrack?.clips).toEqual([]);
    expect(timeline.ending).toMatchObject({
      hold_seconds: 0,
      intentional: false,
    });
    expect(timeline.duration_seconds).toBe(9);
  });

  it("updates final hold while preserving video clip timing", () => {
    const timeline = buildTimelineFromProjectState(projectState);
    const updated = setFinalHold(timeline, 2, "Make the ending deliberate.");
    const summary = timelineSummary(updated);

    expect(updated.tracks.find((track) => track.kind === "guard")?.clips[0]).toMatchObject({
      timeline_start: 9,
      timeline_end: 11,
      duration: 2,
      end_behavior: "freeze",
    });
    expect(updated.tracks.find((track) => track.kind === "video")?.clips.map((clip) => clip.timeline_end)).toEqual([4, 9]);
    expect(summary).toContain("final hold 2s");
    expect(summary).toContain("intentional ending");
  });

  it("uses measured section audio duration for YouTube clip timeline length", () => {
    const timeline = buildTimelineFromProjectState({
      current_plan: {
        scenes: [{ id: "scene_1", duration_seconds: 10, narration: "A longer measured voiceover." }],
      },
      scene_assets: {
        voiceover: { path: "/tmp/voiceover.mp3", duration_seconds: 11.2 },
        videos: [
          {
            scene_id: "scene_1",
            path: "/tmp/scene-1.mp4",
            duration_seconds: 11.2,
            source_duration_seconds: 10,
            audio_duration_seconds: 11.2,
            source: "youtube",
            start_seconds: 34,
            end_seconds: 44,
          },
        ],
      },
    });
    const clip = timeline.tracks.find((track) => track.kind === "video")?.clips[0];

    expect(clip).toMatchObject({
      source_start: 0,
      source_end: 10,
      duration: 11.2,
      timeline_start: 0,
      timeline_end: 11.2,
      end_behavior: "freeze",
    });
    expect(clip?.metadata).toMatchObject({
      original_start_seconds: 34,
      original_end_seconds: 44,
      source_duration_seconds: 10,
      audio_duration_seconds: 11.2,
    });
  });

  it("cuts a YouTube clip when the downloaded window is at least the voiceover length", () => {
    // F3: real downloaded window (source_duration_seconds) >= VO => end_behavior 'cut'.
    const timeline = buildTimelineFromProjectState({
      current_plan: {
        scenes: [{ id: "scene_1", duration_seconds: 5, narration: "Plenty of footage." }],
      },
      scene_assets: {
        voiceover: { path: "/tmp/voiceover.mp3", duration_seconds: 6.5 },
        videos: [
          {
            scene_id: "scene_1",
            path: "/tmp/scene-1.mp4",
            duration_seconds: 6.5,
            // Probed downloaded window is longer than the VO.
            source_duration_seconds: 8.2,
            audio_duration_seconds: 6.5,
            source: "youtube",
            start_seconds: 0,
            end_seconds: 8.2,
          },
        ],
      },
    });
    const clip = timeline.tracks.find((track) => track.kind === "video")?.clips[0];
    expect(clip).toMatchObject({
      source_start: 0,
      source_end: 8.2,
      duration: 6.5,
      end_behavior: "cut",
    });
  });

  it("freezes a YouTube clip only when the downloaded window is shorter than the voiceover", () => {
    // F3 fallback: real source genuinely shorter than VO => 'freeze' remains acceptable.
    const timeline = buildTimelineFromProjectState({
      current_plan: {
        scenes: [{ id: "scene_1", duration_seconds: 5, narration: "Short source." }],
      },
      scene_assets: {
        voiceover: { path: "/tmp/voiceover.mp3", duration_seconds: 6.5 },
        videos: [
          {
            scene_id: "scene_1",
            path: "/tmp/scene-1.mp4",
            duration_seconds: 6.5,
            source_duration_seconds: 4.0,
            audio_duration_seconds: 6.5,
            source: "youtube",
            start_seconds: 0,
            end_seconds: 4.0,
          },
        ],
      },
    });
    const clip = timeline.tracks.find((track) => track.kind === "video")?.clips[0];
    expect(clip).toMatchObject({
      source_start: 0,
      source_end: 4.0,
      duration: 6.5,
      end_behavior: "freeze",
    });
  });

  it("uses explicit final holds only when requested", () => {
    // F5: YT timeline build can pass final_hold_seconds:0.25; normal generated timelines default to no freeze hold.
    const youtubeTimeline = buildTimelineFromProjectState(
      {
        current_plan: { scenes: [{ id: "scene_1", duration_seconds: 5, narration: "YT." }] },
        scene_assets: {
          voiceover: { path: "/tmp/voiceover.mp3", duration_seconds: 6 },
          videos: [
            {
              scene_id: "scene_1",
              path: "/tmp/scene-1.mp4",
              duration_seconds: 6,
              source_duration_seconds: 8,
              audio_duration_seconds: 6,
              source: "youtube",
              start_seconds: 0,
              end_seconds: 8,
            },
          ],
        },
      },
      { final_hold_seconds: 0.25 },
    );
    const guard = youtubeTimeline.tracks.find((track) => track.kind === "guard")?.clips[0];
    expect(guard?.duration).toBeLessThanOrEqual(0.3);
    expect(youtubeTimeline.ending.hold_seconds).toBe(0.25);

    // A non-YT build (no final_hold option) uses no generated freeze hold.
    const defaultTimeline = buildTimelineFromProjectState(projectState);
    expect(defaultTimeline.ending.hold_seconds).toBe(0);
    expect(defaultTimeline.tracks.find((track) => track.kind === "guard")?.clips).toEqual([]);
  });

  it("stamps talking metadata and gaps narration over talking spans", () => {
    const talkingProjectState = {
      current_plan: {
        scenes: [
          { id: "scene_1", on_camera: true, duration_seconds: 4, narration: "hi" },
          { id: "scene_2", on_camera: false, duration_seconds: 5, narration: "yo" },
        ],
      },
      scene_assets: {
        voiceover: { path: "/tmp/voiceover.mp3", duration_seconds: 9 },
        videos: [
          {
            scene_id: "scene_1",
            path: "/tmp/scene-1.mp4",
            duration_seconds: 4,
            on_camera: true,
            has_embedded_audio: true,
          },
          {
            scene_id: "scene_2",
            path: "/tmp/scene-2.mp4",
            duration_seconds: 5,
          },
        ],
      },
    };
    const timeline = buildTimelineFromProjectState(talkingProjectState);
    const videoTrack = timeline.tracks.find((track) => track.kind === "video");
    const narrationTrack = timeline.tracks.find((track) => track.kind === "narration");

    const scene1Clip = videoTrack?.clips.find((clip) => clip.scene_id === "scene_1");
    const scene2Clip = videoTrack?.clips.find((clip) => clip.scene_id === "scene_2");

    expect(scene1Clip?.metadata?.has_embedded_audio).toBe(true);
    expect(scene1Clip?.metadata?.on_camera).toBe(true);
    // Non-talking scene: matches the file's optional-metadata idiom (value undefined, key omitted when serialized).
    expect(scene2Clip?.metadata?.has_embedded_audio).toBeUndefined();
    expect(scene2Clip?.metadata?.on_camera).toBeUndefined();

    // No narration clip overlaps scene_1's talking span [0, 4].
    const overlapsTalking = narrationTrack?.clips.some(
      (clip) => clip.timeline_start < 4 && clip.timeline_end > 0,
    );
    expect(overlapsTalking).toBe(false);

    // Narration covers scene_2's b-roll span [4, 9].
    const coversBroll = narrationTrack?.clips.some(
      (clip) => clip.timeline_start <= 4 && clip.timeline_end >= 9,
    );
    expect(coversBroll).toBe(true);
  });

  it("keeps a single full-span narration clip when there is no talking scene", () => {
    const timeline = buildTimelineFromProjectState(projectState);
    const narrationTrack = timeline.tracks.find((track) => track.kind === "narration");

    expect(narrationTrack?.clips).toHaveLength(1);
    expect(narrationTrack?.clips[0]).toMatchObject({
      source_start: 0,
      source_end: 9,
      timeline_start: 0,
      timeline_end: 9,
      end_behavior: "cut",
    });
  });

  it("persists timeline on project state updates", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "timeline-state-"));
    const ctx = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "timeline-state",
      project_dir: dir,
      aspect_ratio: "16:9",
      resolution: "720p",
    };
    const timeline = buildTimelineFromProjectState(projectState);

    initializeProjectState(ctx);
    updateProjectState(ctx, { timeline });
    updateProjectState(ctx, { status: { stage: "later_update" } });

    const saved = readProjectState(ctx);
    expect(saved.timeline.tracks.find((track: any) => track.kind === "guard")?.clips).toEqual([]);
    expect(saved.status.stage).toBe("later_update");
  });

  it("clears a recovered error when the project completes successfully", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recovered-state-"));
    const ctx = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "recovered-state",
      project_dir: dir,
      aspect_ratio: "16:9",
      resolution: "720p",
    };

    initializeProjectState(ctx);
    updateProjectState(ctx, {
      status: {
        status: "running",
        stage: "voiceover",
        error: "Voiceover was initially too short.",
      },
    });
    updateProjectState(ctx, {
      status: {
        status: "succeeded",
        stage: "complete",
        progress: 100,
        message: "Video is ready.",
      },
    });

    expect(readProjectState(ctx).status).toMatchObject({
      status: "succeeded",
      stage: "complete",
      progress: 100,
      message: "Video is ready.",
    });
    expect(readProjectState(ctx).status.error).toBeUndefined();
  });
});
