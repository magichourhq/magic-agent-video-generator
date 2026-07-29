import { describe, expect, it } from "vitest";
import {
  TOPIC_CHANGE_PAUSE_SECONDS,
  audioPerformanceSequenceForPlan,
  audioPerformanceForScene,
  audioPerformanceForGeneration,
  audioPerformanceIssues,
  audioTopicForScene,
  defaultAudioModeForScene,
  emotionContextForScene,
  planAllowsVoiceVariation,
  sanitizeTextForAudioPerformance,
  topicChangePauseSeconds,
} from "../src/audioPerformance.js";
import type { Scene, VideoPlan } from "../src/schemas.js";

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: "scene_1",
    narration: "Okay, this actually helped.",
    image_prompt: "creator holding a smart water bottle",
    video_prompt: "small handheld push in",
    duration_seconds: 8,
    on_camera: true,
    audio_mode: "ugc_hook",
    audio_note: null,
    reference_media_ids: [],
    continuity: {
      story_beat: "",
      required_subjects: [],
      opening_state: "",
      closing_state: "",
      setting: "",
      screen_direction: "not_applicable",
    },
    ...overrides,
  };
}

function plan(scenes: Scene[]): VideoPlan {
  return {
    title: "AeroBottle UGC",
    creative_vibe: "polished_ugc",
    narration: scenes.map((s) => s.narration).join(" "),
    visual_bible: "A female creator filming during work.",
    scenes,
    voice: null,
  };
}

describe("audio performance contract", () => {
  it("maps compact UGC mode to Hume-safe provider settings", () => {
    const settings = audioPerformanceForScene(scene({ audio_mode: "ugc_hook" }));

    expect(settings.description).toContain("scroll-stopping UGC hook");
    expect(settings.description).toContain("emotional context");
    expect(settings.emotion_context).toBe("expressive creator energy with real curiosity and momentum");
    expect(settings.speed).toBe(1.12);
    expect(settings.temperature).toBe(0.85);
    expect(settings.trailing_silence).toBe(0);
    expect(settings.pause).toBe("none");
  });

  it("defaults the opening UGC creator scene to hook delivery", () => {
    const mode = defaultAudioModeForScene(
      scene({ audio_mode: null }),
      plan([scene({ audio_mode: null })]),
      0,
    );

    expect(mode).toBe("ugc_hook");
  });

  it("sanitizes pause tokens when the selected mode disallows pauses", () => {
    const settings = audioPerformanceForScene(scene({ audio_mode: "urgent_reaction" }));
    expect(sanitizeTextForAudioPerformance("Wait [long pause] this is useful.", settings)).toBe(
      "Wait this is useful.",
    );
  });

  it("keeps short pauses only for modes that allow them", () => {
    const settings = audioPerformanceForScene(scene({ audio_mode: "testimonial" }));
    expect(sanitizeTextForAudioPerformance("Honestly [long pause] this worked.", settings)).toBe(
      "Honestly [pause] this worked.",
    );
  });

  it("flags audio notes that leak visual or schema instructions", () => {
    const issues = audioPerformanceIssues(
      plan([scene({ audio_mode: "product_proof", audio_note: "close-up camera shot" })]),
    );
    expect(issues.join(" ")).toContain("audio_note contains visual/schema instructions");
  });

  it("infers emotion from the product story beat", () => {
    const scenes = [
      scene({
        id: "scene_1",
        narration: "I kept burning dinner after work and honestly it was so frustrating.",
        image_prompt: "tired creator beside smoky pan",
        video_prompt: "small handheld push in",
      }),
      scene({
        id: "scene_2",
        narration: "Then this pan finally controlled the heat for me.",
        image_prompt: "clean closeup of smart pan temperature controls",
        video_prompt: "slow product push in",
        on_camera: false,
        audio_mode: "product_proof",
      }),
    ];

    expect(emotionContextForScene(scenes[0]!, plan(scenes), 0)).toContain("frustration");
    expect(audioPerformanceForScene(scenes[1]!, plan(scenes)).description).toContain("product-proof");
  });

  it("locks normal UGC plans to one Hume performance profile unless voice variation is requested", () => {
    const scenes = [
      scene({ id: "scene_1", audio_mode: "urgent_reaction", narration: "Wait, this is the problem." }),
      scene({ id: "scene_2", audio_mode: "product_proof", narration: "Here is the proof." }),
    ];
    const lockedPlan = plan(scenes);

    expect(planAllowsVoiceVariation(lockedPlan)).toBe(false);
    expect(audioPerformanceForGeneration(scenes[0]!, lockedPlan)).toEqual(
      audioPerformanceForGeneration(scenes[1]!, lockedPlan),
    );

    const multiVoicePlan = {
      ...lockedPlan,
      visual_bible: "Use two different speakers with separate voices.",
    };
    expect(planAllowsVoiceVariation(multiVoicePlan)).toBe(true);
    expect(audioPerformanceForGeneration(scenes[0]!, multiVoicePlan).audio_mode).toBe("urgent_reaction");
    expect(audioPerformanceForGeneration(scenes[1]!, multiVoicePlan).audio_mode).toBe("product_proof");
  });

  it("keeps workday/home UGC on a creator delivery instead of calm lifestyle", () => {
    const scenes = [
      scene({
        id: "scene_1",
        narration: "Okay, I keep forgetting water once work gets busy.",
        image_prompt: "phone-shot creator at a home work desk with a smart bottle",
      }),
      scene({
        id: "scene_2",
        narration: "The reminder hits right when I am locked into work.",
        image_prompt: "product proof at the laptop in a realistic home office",
        on_camera: false,
        audio_mode: "product_proof",
      }),
    ];
    const settings = audioPerformanceForGeneration(scenes[0]!, {
      ...plan(scenes),
      visual_bible: "One normal person filming a workday at home, phone-shot UGC.",
    });

    expect(settings.audio_mode).toBe("ugc_casual");
    expect(settings.description).toContain("natural UGC creator");
    expect(settings.speed).toBe(0.96);
  });

  it("adds a 0.5s micro-pause when adjacent scenes change topics", () => {
    const scenes = [
      scene({
        id: "scene_1",
        narration: "Okay, I keep forgetting water once work gets busy.",
        image_prompt: "creator at a laptop with an untouched smart bottle",
        audio_mode: "ugc_hook",
      }),
      scene({
        id: "scene_2",
        narration: "The reminder glow catches me before the crash hits.",
        image_prompt: "close-up product proof of the bottle glowing near the laptop",
        on_camera: false,
        audio_mode: "product_proof",
      }),
      scene({
        id: "scene_3",
        narration: "By the end of the day, I am actually on track.",
        image_prompt: "creator smiling at a clean desk with the bottle in frame",
        on_camera: false,
        audio_mode: "testimonial",
      }),
    ];
    const p = plan(scenes);
    const settings = audioPerformanceSequenceForPlan(scenes, p);

    expect(audioTopicForScene(scenes[0]!, p, 0)).toBe("hook_problem");
    expect(audioTopicForScene(scenes[1]!, p, 1)).toBe("feature_demo");
    expect(topicChangePauseSeconds(scenes[0]!, scenes[1]!, p, 1)).toBe(TOPIC_CHANGE_PAUSE_SECONDS);
    expect(settings[0]!.trailing_silence).toBe(TOPIC_CHANGE_PAUSE_SECONDS);
    expect(settings[1]!.trailing_silence).toBe(TOPIC_CHANGE_PAUSE_SECONDS);
    expect(settings[2]!.trailing_silence).toBe(0);
  });

  it("does not add micro-pauses for repeated same-topic proof beats or mostly visual scenes", () => {
    const sameTopicScenes = [
      scene({
        id: "scene_1",
        narration: "The app shows my hydration progress without making me think about it.",
        image_prompt: "phone app dashboard beside the bottle",
        on_camera: false,
        audio_mode: "product_proof",
      }),
      scene({
        id: "scene_2",
        narration: "The progress screen makes the habit feel easy to keep using.",
        image_prompt: "close-up of the same hydration progress dashboard",
        on_camera: false,
        audio_mode: "product_proof",
      }),
    ];
    const mostlyVisual = scene({
      id: "scene_3",
      narration: "A quiet desk moment.",
      image_prompt: "silent product beauty shot",
      on_camera: false,
      audio_mode: "mostly_visual",
    });

    expect(topicChangePauseSeconds(sameTopicScenes[0]!, sameTopicScenes[1]!, plan(sameTopicScenes), 1)).toBe(0);
    expect(topicChangePauseSeconds(sameTopicScenes[1]!, mostlyVisual, plan([...sameTopicScenes, mostlyVisual]), 2)).toBe(0);
  });

  it("uniformly slows a near-target narration without changing voice identity between scenes", () => {
    const scenes = [
      scene({
        id: "scene_1",
        narration: "Imagine two babies falling from the sky onto the same man.",
        on_camera: false,
        audio_mode: "cinematic_narrator",
      }),
      scene({
        id: "scene_2",
        narration: "Joseph looks up as the crowd realizes what is happening above him.",
        on_camera: false,
        audio_mode: "cinematic_narrator",
      }),
    ];
    const p = plan(scenes);
    const baseline = audioPerformanceSequenceForPlan(scenes, p);
    const calibrated = audioPerformanceSequenceForPlan(scenes, p, {
      targetSpeechSeconds: 12.5,
      wordsPerSecond: 2,
    });

    expect(calibrated[0]!.speed).toBeLessThan(baseline[0]!.speed);
    expect(calibrated[0]!.speed).toBe(calibrated[1]!.speed);
    expect(calibrated.every((settings) => settings.speed >= 0.85)).toBe(true);
  });

  it("uses the safe speed floor when the exact target would require slower speech", () => {
    const scenes = [
      scene({
        narration: "Joseph keeps working as the city moves around him through another full year.",
        on_camera: false,
        audio_mode: "cinematic_narrator",
      }),
    ];
    const p = plan(scenes);
    const calibrated = audioPerformanceSequenceForPlan(scenes, p, {
      targetSpeechSeconds: 7.65,
      wordsPerSecond: 2,
    });

    expect(calibrated[0]!.speed).toBe(0.85);
  });

  it("does not stretch a materially under-scripted narration to hide missing content", () => {
    const scenes = [
      scene({
        narration: "A baby falls. Joseph catches her.",
        on_camera: false,
        audio_mode: "cinematic_narrator",
      }),
    ];
    const p = plan(scenes);
    const baseline = audioPerformanceSequenceForPlan(scenes, p);
    const calibrated = audioPerformanceSequenceForPlan(scenes, p, {
      targetSpeechSeconds: 20,
      wordsPerSecond: 2,
    });

    expect(calibrated).toEqual(baseline);
  });
});
