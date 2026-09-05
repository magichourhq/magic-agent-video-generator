import { describe, expect, it } from "vitest";
import { sceneAudioSource, validateSceneAudioContract } from "../src/sceneAudio.js";
import type { Scene, VideoPlan } from "../src/schemas.js";

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: "scene_1",
    narration: "A narrator explains what happened.",
    image_prompt: "One full-frame cinematic keyframe.",
    video_prompt: "The subject moves naturally through the frame.",
    duration_seconds: 10,
    on_camera: false,
    audio_source: null,
    native_audio_prompt: null,
    audio_mode: "cinematic_narrator",
    audio_note: null,
    reference_media_ids: [],
    continuity: {
      story_beat: "The subject completes one action.",
      required_subjects: ["subject"],
      opening_state: "The subject stands at the start position.",
      closing_state: "The subject reaches the end position.",
      setting: "The same room at the same time.",
      screen_direction: "left_to_right",
    },
    ...overrides,
  };
}

function plan(scenes: Scene[]): VideoPlan {
  return {
    title: "Audio ownership test",
    creative_vibe: "cinematic_commercial",
    narration: scenes.map((item) => item.narration).filter(Boolean).join("\n\n"),
    visual_bible: "One stable cinematic world.",
    scenes,
    voice: "sarah",
  };
}

describe("scene audio ownership", () => {
  it("keeps legacy narration on the external voiceover path", () => {
    expect(sceneAudioSource(scene())).toBe("voiceover");
  });

  it("infers speech-driven audio for legacy on-camera scenes", () => {
    expect(sceneAudioSource(scene({ on_camera: true }))).toBe("speech_driven");
  });

  it("accepts a complete native H3 sound contract", () => {
    const native = scene({
      narration: "",
      audio_source: "native_scene_audio",
      native_audio_prompt: "Soft room tone, footsteps on wood, one quiet line of dialogue, no music.",
    });
    expect(validateSceneAudioContract(plan([native]), "minimax-h3")).toEqual([]);
  });

  it("rejects external narration layered on a native H3 scene", () => {
    const native = scene({
      audio_source: "native_scene_audio",
      native_audio_prompt: "Natural room tone and footsteps.",
    });
    expect(validateSceneAudioContract(plan([native]), "minimax-h3").join(" ")).toContain("external narration");
  });

  it("rejects native audio on unsupported models and with authoritative uploaded audio", () => {
    const native = scene({
      narration: "",
      audio_source: "native_scene_audio",
      native_audio_prompt: "Ocean surf, distant gulls, and natural wind.",
    });
    const issues = validateSceneAudioContract(plan([native]), "ltx-2.3", true).join(" ");
    expect(issues).toContain("requires the minimax-h3");
    expect(issues).toContain("user-supplied audio is authoritative");
  });
});
