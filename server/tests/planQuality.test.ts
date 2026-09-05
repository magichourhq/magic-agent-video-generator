import { describe, expect, it } from "vitest";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import type { ProjectContext } from "../src/context.js";
import { TOPIC_CHANGE_PAUSE_SECONDS, audioPerformanceSequenceForPlan } from "../src/audioPerformance.js";
import {
  alignPlanToMeasuredVoiceover,
  estimatePlanSpeechSeconds,
  normalizePlan,
  normalizePlanRuntimeToTarget,
  providerImagePrompt,
  providerVideoPrompt,
  validatePlanAudioDurationFit,
  validatePlanRuntimeCoverage,
  validateProductionVideoPlan,
  validateSceneSpeechAndVisualCoverage,
} from "../src/workflows.js";
import { CreateProjectRequestSchema, VideoPlanSchema, type VideoPlan } from "../src/schemas.js";

function scene(id: string, overrides: Partial<VideoPlan["scenes"][number]> = {}): VideoPlan["scenes"][number] {
  return {
    id,
    narration: "I use it once, and the difference is obvious.",
    image_prompt: "A creator at a bright desk holding the product near the camera, natural daylight, handheld UGC framing.",
    video_prompt: "Slow handheld push in while the creator smiles.",
    duration_seconds: 8,
    on_camera: true,
    audio_source: null,
    native_audio_prompt: null,
    audio_mode: "ugc_casual",
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

function plan(overrides: Partial<VideoPlan> = {}): VideoPlan {
  return {
    title: "AeroBottle UGC product ad",
    creative_vibe: "raw_ugc",
    narration: "A creator forgets water, tries AeroBottle, shows the reminder, and ends with a clear payoff.",
    visual_bible: "One relatable creator, natural workday desk, handheld phone-style footage, clean product closeups.",
    voice: null,
    scenes: [
      scene("scene_1", {
        narration: "I kept forgetting to drink water halfway through my workday.",
        image_prompt: "A creator at a cluttered desk noticing a dry water bottle beside a laptop.",
      }),
      scene("scene_2", {
        narration: "Then AeroBottle reminded me before I even felt tired.",
        image_prompt: "Close-up of AeroBottle glowing gently beside the laptop, creator reacting in the background.",
        on_camera: false,
      }),
      scene("scene_3", {
        narration: "Now I actually finish the day hydrated, without thinking about it.",
        image_prompt: "Final clean desk reveal with AeroBottle in the foreground and the creator giving a relaxed thumbs up.",
        video_prompt: "Slow push toward the product and final desk reveal.",
      }),
    ],
    ...overrides,
  };
}

describe("validateProductionVideoPlan", () => {
  it("passes a compact UGC plan with creator, proof, and payoff beats", () => {
    expect(validateProductionVideoPlan(plan())).toEqual([]);
  });

  it("accepts a short but complete natural spoken sentence", () => {
    const testPlan = plan({
      narration: "Honestly, nobody forgot.",
      scenes: [scene("scene_1", { narration: "Honestly, nobody forgot." })],
    });

    expect(validateProductionVideoPlan(testPlan).join(" ")).not.toContain("mid-thought");
  });

  it("rejects narration that ends on an unfinished connective", () => {
    const testPlan = plan({
      narration: "A year later, Joseph was walking from",
      scenes: [scene("scene_1", { narration: "A year later, Joseph was walking from" })],
    });

    expect(validateProductionVideoPlan(testPlan).join(" ")).toContain("mid-thought");
  });

  it("grounds every declared continuity subject in the normalized keyframe prompt", () => {
    const normalized = normalizePlan(
      plan({
        scenes: [
          scene("draft-id", {
            image_prompt: "Joseph sweeps below the tenement window.",
            continuity: {
              story_beat: "Joseph continues sweeping.",
              required_subjects: ["Joseph Figlock", "wooden push broom"],
              opening_state: "Joseph stands below the window.",
              closing_state: "Joseph looks upward.",
              setting: "Detroit sidewalk.",
              screen_direction: "stationary",
            },
          }),
        ],
      }),
    );

    expect(normalized.scenes[0]?.image_prompt).toContain(
      "Required visible subjects in this single keyframe: Joseph Figlock; wooden push broom.",
    );
    expect(normalizePlan(normalized).scenes[0]?.image_prompt.match(/Required visible subjects/g)).toHaveLength(1);
  });

  it("wraps provider image prompts with a single-frame guard", () => {
    const prompt = providerImagePrompt(plan(), scene("scene_1"));

    expect(prompt).toContain("Single unbroken photorealistic keyframe");
    expect(prompt).toContain("split-screen, collage, storyboard");
    expect(prompt).toContain("One primary focal subject/product only");
    expect(prompt).toContain("Scene physics packet");
    expect(prompt).toContain("Real-world blocking");
  });

  it("compiles a natural cause-action-result staging instruction into video prompts", () => {
    const pickup = scene("scene_1", {
      image_prompt: "A creator reaches toward a bottle resting beside the laptop.",
      video_prompt: "The creator picks up the bottle.",
      continuity: {
        story_beat: "The creator picks up the bottle from the desk.",
        required_subjects: ["creator", "bottle", "desk"],
        opening_state: "The bottle rests on the desk within the creator's reach.",
        closing_state: "The creator holds the same bottle in one hand above the desk.",
        setting: "Home office desk in daylight.",
        screen_direction: "stationary",
      },
    });

    const prompt = providerVideoPrompt(plan({ scenes: [pickup] }), pickup);

    expect(prompt).toContain("object begins resting on a visible support");
    expect(prompt).toContain("hand approaches, grips, and only then lifts it");
    expect(prompt).toContain("finish at the declared closing state");
  });

  it("injects previous exit and current physical state into image and video prompts", () => {
    const first = scene("scene_1", {
      continuity: {
        story_beat: "Joseph sweeps beneath the window.",
        required_subjects: ["Joseph", "broom"],
        opening_state: "Joseph stands beneath the window with the broom.",
        closing_state: "Joseph drops the broom and looks directly upward.",
        setting: "Detroit sidewalk beneath one brick tenement.",
        screen_direction: "stationary",
      },
    });
    const second = scene("scene_2", {
      image_prompt: "Joseph reaches upward as a bundled baby descends toward him.",
      video_prompt: "The baby descends and Joseph catches the baby.",
      continuity: {
        story_beat: "A bundled baby descends from the fourth-story window into Joseph's arms.",
        required_subjects: ["Joseph", "bundled baby", "fourth-story window"],
        opening_state: "Joseph stands below the fourth-story window while the baby is directly above his arms.",
        closing_state: "Joseph holds the bundled baby safely and the broom remains at his feet.",
        setting: "Same Detroit sidewalk beneath the same brick tenement.",
        screen_direction: "stationary",
      },
    });
    const testPlan = plan({ scenes: [first, second] });

    const imagePrompt = providerImagePrompt(testPlan, second);
    const videoPrompt = providerVideoPrompt(testPlan, second);

    expect(imagePrompt).toContain("Previous scene exit");
    expect(imagePrompt).toContain("Joseph drops the broom");
    expect(imagePrompt).toContain("Gravity geometry");
    expect(imagePrompt).toContain("Safety-staged opening keyframe");
    expect(imagePrompt).toContain("wrapped bundle must be clearly visible in the opening frame");
    expect(imagePrompt).toContain("separated from the adult");
    expect(imagePrompt).not.toContain("State after this scene's motion");
    expect(imagePrompt).not.toContain("Joseph holds the bundled baby safely");
    expect(imagePrompt).not.toContain("Scene keyframe: Joseph reaches upward");
    expect(videoPrompt).toContain("Begin from the declared current entry");
    expect(videoPrompt).toContain("Joseph holds the bundled baby safely");
    expect(videoPrompt).toContain("keeps the origin, full downward path, receiver, and contact point visible");
    expect(videoPrompt).toContain("Complete the declared catch or landing before the final second");
  });

  it("preserves a shoulder landing instead of converting every fall into an arm catch", () => {
    const shoulderScene = scene("scene_2", {
      image_prompt: "Joseph braces below a wrapped baby descending from an alley window.",
      video_prompt: "The wrapped baby descends vertically and lands onto Joseph's shoulders.",
      continuity: {
        story_beat: "A wrapped baby falls from the window and lands onto Joseph's shoulders.",
        required_subjects: ["Joseph", "wrapped baby", "open window"],
        opening_state: "Joseph sweeps beneath the open alley window.",
        closing_state: "Joseph steadies the wrapped baby across his shoulders.",
        setting: "Narrow Detroit alley.",
        screen_direction: "stationary",
      },
    });
    const testPlan = plan({ scenes: [shoulderScene] });

    const imagePrompt = providerImagePrompt(testPlan, shoulderScene);
    const videoPrompt = providerVideoPrompt(testPlan, shoulderScene);

    expect(imagePrompt).toContain("shoulders directly under the descent");
    expect(imagePrompt).toContain("aligned vertically with the receiving adult's shoulders");
    expect(imagePrompt).not.toContain("begins raising both arms");
    expect(videoPrompt).toContain("toward the receiving adult's shoulders below");
  });

  it("does not leak a previous location into a time-jump keyframe", () => {
    const first = scene("scene_1", {
      continuity: {
        story_beat: "Joseph finishes sweeping the sidewalk.",
        required_subjects: ["Joseph"],
        opening_state: "Joseph stands on the tenement sidewalk.",
        closing_state: "Joseph leaves the broom beside the tenement doorway.",
        setting: "Tenement sidewalk in the morning.",
        screen_direction: "stationary",
      },
    });
    const oneYearLater = scene("scene_2", {
      image_prompt: "Joseph sweeps inside a narrow alley in late afternoon.",
      continuity: {
        story_beat: "One year later Joseph works in a different alley.",
        required_subjects: ["Joseph"],
        opening_state: "One year later Joseph begins sweeping in a narrow alley.",
        closing_state: "Joseph continues sweeping alone in the alley.",
        setting: "Different narrow alley in late afternoon, one year later.",
        screen_direction: "stationary",
      },
    });
    const prompt = providerImagePrompt(plan({ scenes: [first, oneYearLater] }), oneYearLater);

    expect(prompt).not.toContain("Joseph leaves the broom beside the tenement doorway");
    expect(prompt).toContain("One year later Joseph begins sweeping in a narrow alley");
  });

  it("compiles a completed catch draft into a pre-contact opening keyframe", () => {
    const fallingScene = scene("scene_1", {
      narration: "A baby falls from the fourth-story window toward Joseph below.",
      image_prompt: "Joseph already holds the baby safely in his arms.",
      video_prompt: "The baby falls from the window and Joseph catches her.",
      continuity: {
        story_beat: "A baby falls from the fourth-story window and Joseph catches her.",
        required_subjects: ["Joseph", "baby"],
        opening_state: "Joseph already cradles the baby after the catch.",
        closing_state: "Joseph holds the baby safely.",
        setting: "Detroit sidewalk beneath a four-story brick tenement.",
        screen_direction: "stationary",
      },
    });

    const imagePrompt = providerImagePrompt(
      plan({
        visual_bible:
          "Black-and-white 1930s Detroit. BUNDLED BABIES: both babies gently descending. FALL PHYSICS: all falls are vertical from windows.",
        scenes: [fallingScene],
      }),
      fallingScene,
    );

    expect(imagePrompt).toContain("securely wrapped infant-sized rescue bundle");
    expect(imagePrompt).toContain("wrapped bundle must be clearly visible in the opening frame");
    expect(imagePrompt).not.toContain("Joseph already holds the baby");
    expect(imagePrompt).not.toContain("Joseph holds the baby safely");
    expect(imagePrompt).not.toContain("BUNDLED BABIES");
    expect(imagePrompt).not.toContain("FALL PHYSICS");
  });

  it("preserves the complete visual bible instead of truncating it to sixty words", () => {
    const visualBible = Array.from(
      { length: 75 },
      (_, index) => `anchor${index + 1}`,
    ).join(" ");

    expect(normalizePlan(plan({ visual_bible: visualBible })).visual_bible).toBe(visualBible);
    expect(VideoPlanSchema.parse(plan({ visual_bible: visualBible.repeat(2) })).visual_bible)
      .toBe(visualBible.repeat(2));
  });

  it("prevents human subjects from becoming toys or symbolic stand-ins", () => {
    const babyScene = scene("scene_1", {
      image_prompt: "A baby boy falls toward a man in a narrow city alley.",
      continuity: {
        story_beat: "A real infant falls and is caught.",
        required_subjects: ["baby boy", "man"],
        opening_state: "A baby boy is visible above the man.",
        closing_state: "The man catches the baby boy.",
        setting: "A city alley in daylight.",
        screen_direction: "stationary",
      },
    });

    const prompt = providerImagePrompt(plan({ scenes: [babyScene] }), babyScene);

    expect(prompt).toContain("actual living human");
    expect(prompt).toContain("never depict a doll, toy, stuffed animal");
  });

  it("uses fully clothed non-graphic provider wording for minor subjects", () => {
    const fallingBaby = scene("scene_1", {
      image_prompt:
        "A baby girl in a cloth diaper plummets from an upper window toward a man waiting below.",
      continuity: {
        story_beat: "A baby girl falls and is caught safely.",
        required_subjects: ["baby girl", "man"],
        opening_state: "The fully clothed baby girl descends toward the man.",
        closing_state: "The man catches the baby girl safely.",
        setting: "A historical city street.",
        screen_direction: "stationary",
      },
    });

    const prompt = providerImagePrompt(plan(), fallingBaby);

    expect(prompt).toContain("securely wrapped infant-sized cloth rescue bundle");
    expect(prompt).toContain("no visible face, skin, injury, or distress");
    expect(prompt).toContain("safe, non-graphic historical rescue reenactment");
    expect(prompt).not.toMatch(/\bdiaper\b/i);
    expect(prompt).not.toMatch(/\bplummets?\b/i);
  });

  it("accepts creator-native product endings like staying on track", () => {
    expect(
      validateProductionVideoPlan(
        plan({
          scenes: [
            scene("scene_1"),
            scene("scene_2", {
              image_prompt: "Close-up of AeroBottle glowing with a reminder beside a laptop.",
              on_camera: false,
            }),
            scene("scene_3", {
              narration: "Now I stay on track all day without having to think about it.",
              image_prompt: "Final clean desk reveal with AeroBottle in the foreground and the creator back on track.",
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("does not impose product proof or CTA rules on a cinematic historical story", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Create a 30-second cinematic historical story about an unlikely rescue.",
      workflow: "generated",
      duration_seconds: 30,
    });
    const historicalPlan = plan({
      creative_vibe: "cinematic_commercial",
      scenes: [
        scene("scene_1", {
          narration: "A worker crosses a crowded city street.",
          image_prompt: "A black-and-white historical city street with one worker.",
          video_prompt: "The worker walks steadily through the crowd.",
          duration_seconds: 10,
          on_camera: false,
        }),
        scene("scene_2", {
          narration: "He looks up and completes an unexpected rescue.",
          image_prompt: "The worker safely catches a bundled child below a window.",
          video_prompt: "The worker completes the catch and secures the child.",
          duration_seconds: 10,
          on_camera: false,
        }),
        scene("scene_3", {
          narration: "The gathered neighbors stare while both walk away safely.",
          image_prompt: "Neighbors gather around the worker and child in relief.",
          video_prompt: "The crowd settles as the worker carries the child away.",
          duration_seconds: 10,
          on_camera: false,
        }),
      ],
    });

    const issues = validateProductionVideoPlan(historicalPlan, request);

    expect(issues.join(" ")).not.toContain("visible proof");
    expect(issues.join(" ")).not.toContain("creator-native CTA");
  });

  it.each([
    {
      name: "narration that leaks camera or visual directions into spoken copy",
      sceneOverrides: { narration: "Close-up of the bottle on the desk while the camera pans." },
      expectedIssue: "visual/camera instructions",
    },
    {
      name: "meta planning language in spoken narration",
      sceneOverrides: {
        narration: "The proof matters because the reminder is simple and the ending should feel useful.",
      },
      expectedIssue: "meta planning language",
    },
    {
      name: "image prompts that ask for storyboard or split-frame layouts",
      sceneOverrides: {
        image_prompt: "A three-panel storyboard showing the creator before and after using AeroBottle.",
      },
      expectedIssue: "split-screen, collage, storyboard, or multiple views",
    },
    {
      name: "image prompts that ask for multiple competing product instances",
      sceneOverrides: {
        image_prompt: "A row of serum bottles and different product variants on a bathroom shelf.",
      },
      expectedIssue: "multiple competing product instances",
    },
  ])("rejects $name", ({ sceneOverrides, expectedIssue }) => {
    const issues = validateProductionVideoPlan(
      plan({ scenes: [scene("scene_1", sceneOverrides), scene("scene_2"), scene("scene_3")] }),
    );

    expect(issues.join(" ")).toContain(expectedIssue);
  });

  it("rejects longer videos made from repeated sub-3s flashes", () => {
    const issues = validateProductionVideoPlan(
      plan({
        scenes: Array.from({ length: 8 }, (_, index) =>
          scene(`scene_${index + 1}`, {
            duration_seconds: 2,
            narration: "This moment moves fast.",
          }),
        ),
      }),
    );

    expect(issues.join(" ")).toContain("sub-3s scene");
  });

  it("rejects long UGC ads that are under-scripted for the target runtime", () => {
    const issues = validateProductionVideoPlan(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "I keep forgetting water during work.",
            duration_seconds: 12,
          }),
          scene("scene_2", {
            narration: "The reminder lights up.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop.",
            duration_seconds: 12,
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "Now I stay on track.",
            duration_seconds: 12,
          }),
          scene("scene_4", {
            narration: "It helps all day.",
            duration_seconds: 12,
            on_camera: false,
          }),
          scene("scene_5", {
            narration: "Link in bio.",
            duration_seconds: 12,
          }),
        ],
      }),
    );

    expect(issues.join(" ")).toContain("under-scripted");
  });

  it("rejects 40s mixed UGC plans whose talking-photo clips will render far shorter than target", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 40 second TikTok UGC ad for AeroBottle with product closeups and a strong ending",
      duration_seconds: 40,
    });
    const ctx = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "runtime-coverage-test",
      project_dir: "/tmp/runtime-coverage-test",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const issues = validatePlanRuntimeCoverage(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "Okay so it's 3pm and I just realized I've had zero water today.",
            duration_seconds: 10,
          }),
          scene("scene_2", {
            narration: "AeroBottle glows when you're supposed to drink. Look at this.",
            duration_seconds: 10,
          }),
          scene("scene_3", {
            narration: "The reminder gets brighter when I ignore it.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_4", {
            narration: "Now I actually stay hydrated. Link in bio.",
            duration_seconds: 10,
          }),
        ],
      }),
      request,
      ctx,
    );

    expect(issues.join(" ")).toContain("likely to render too short");
  });

  it("rejects long b-roll scenes with one tiny spoken line that would become padded silence", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 45 second TikTok style ad for a smart water bottle called AeroBottle",
      duration_seconds: 45,
    });
    const ctx = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "broll-silence-test",
      project_dir: "/tmp/broll-silence-test",
      aspect_ratio: "9:16",
      resolution: "720p",
      audio_provider: "hume" as const,
    };
    const issues = validateSceneSpeechAndVisualCoverage(
      plan({
        scenes: [
          scene("scene_1", { duration_seconds: 10, on_camera: true }),
          scene("scene_2", {
            narration: "Then I got AeroBottle.",
            image_prompt: "A close-up shot of the AeroBottle on the desk, sleek and stylish, glimmering in warm light.",
            video_prompt: "A gentle zoom-in showcasing the logo and design details.",
            duration_seconds: 20,
            on_camera: false,
            audio_mode: "mostly_visual",
          }),
          scene("scene_3", { duration_seconds: 15, on_camera: false }),
        ],
      }),
      request,
      ctx,
    );

    expect(issues.join(" ")).toContain("only about");
    expect(issues.join(" ")).toContain("20s b-roll scene");
  });

  it("rejects product b-roll narration that would only cover the first few seconds", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 45 second TikTok style ad for a smart water bottle called AeroBottle",
      duration_seconds: 45,
    });
    const ctx = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "broll-coverage-test",
      project_dir: "/tmp/broll-coverage-test",
      aspect_ratio: "9:16",
      resolution: "720p",
      audio_provider: "hume" as const,
    };
    const issues = validateSceneSpeechAndVisualCoverage(
      plan({
        scenes: [
          scene("scene_1", { duration_seconds: 10, on_camera: true }),
          scene("scene_2", {
            narration: "Meet AeroBottle. It reminds me to hydrate with a soft glow and gentle beep.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop during a busy workday.",
            video_prompt: "Slow push-in as the reminder glow turns on and the person reaches for a sip.",
            duration_seconds: 15,
            on_camera: false,
            audio_mode: "product_proof",
          }),
          scene("scene_3", { duration_seconds: 10, on_camera: false }),
        ],
      }),
      request,
      ctx,
    );

    expect(issues.join(" ")).toContain("15s b-roll scene");
    expect(issues.join(" ")).toContain("long silent padding");
  });

  it("rejects static product beauty shots when product b-roll needs visible proof", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 40 second UGC ad for AeroBottle with product closeups and a strong ending",
      duration_seconds: 40,
    });
    const ctx = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "static-showcase-test",
      project_dir: "/tmp/static-showcase-test",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const issues = validateSceneSpeechAndVisualCoverage(
      plan({
        scenes: [
          scene("scene_1", { duration_seconds: 10, on_camera: true }),
          scene("scene_2", {
            narration: "The bottle finally made hydration impossible to ignore, even on busy days.",
            image_prompt: "Hero shot of AeroBottle on a clean desk, sleek and stylish, logo visible, design details crisp.",
            video_prompt: "Slow beauty shot push-in across the product logo and design details.",
            duration_seconds: 15,
            on_camera: false,
          }),
          scene("scene_3", { duration_seconds: 15, on_camera: false }),
        ],
      }),
      request,
      ctx,
    );

    expect(issues.join(" ")).toContain("static product showcase");
  });

  it("uses Hume-paced speech estimates for UGC runtime coverage", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "can you make a 45 second tiktok style ad for a smart water bottle called AeroBottle?",
      duration_seconds: 45,
      audio_provider: "hume",
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "hume-runtime-coverage-test",
      project_dir: "/tmp/hume-runtime-coverage-test",
      audio_provider: "hume",
      audio_model: "octave-1",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const issues = validatePlanRuntimeCoverage(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "Okay, it is 3pm and I just realized I have barely touched my water again today.",
            duration_seconds: 10,
            on_camera: true,
          }),
          scene("scene_2", {
            narration: "The reminder light comes on before the afternoon crash fully hits.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop.",
            duration_seconds: 15,
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "It sounds small, but seeing it right there actually makes me take a sip.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_4", {
            narration: "The bottle tracks the habit while the workday keeps moving.",
            image_prompt: "AeroBottle hydration tracking visible during focused desk work.",
            duration_seconds: 15,
            on_camera: false,
          }),
          scene("scene_5", {
            narration: "By the end of the day, I am not guessing anymore. I stayed on track.",
            duration_seconds: 10,
            on_camera: true,
          }),
        ],
      }),
      request,
      ctx,
    );

    expect(issues).toEqual([]);
  });

  it("includes Hume topic-change micro-pauses in speech duration estimates", () => {
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "hume-topic-pause-estimate-test",
      project_dir: "/tmp/hume-topic-pause-estimate-test",
      audio_provider: "hume",
      audio_model: "octave-1",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const shifted = plan({
      scenes: [
        scene("scene_1", {
          narration: "Okay, I kept forgetting water once work got busy.",
          image_prompt: "creator at a laptop with an untouched smart bottle",
          audio_mode: "ugc_hook",
        }),
        scene("scene_2", {
          narration: "Then the reminder glow caught me before the crash.",
          image_prompt: "close-up product proof of the smart bottle glowing",
          on_camera: false,
          audio_mode: "product_proof",
        }),
        scene("scene_3", {
          narration: "By the end, I was actually on track.",
          image_prompt: "final clean desk reveal with a satisfied creator",
          on_camera: false,
          audio_mode: "testimonial",
        }),
      ],
    });
    const noMicroPauses = {
      ...shifted,
      scenes: shifted.scenes.map((item) => ({ ...item, audio_mode: "mostly_visual" as const })),
    };

    expect(audioPerformanceSequenceForPlan(shifted.scenes, shifted).map((item) => item.trailing_silence)).toEqual([
      TOPIC_CHANGE_PAUSE_SECONDS,
      TOPIC_CHANGE_PAUSE_SECONDS,
      0,
    ]);
    expect(estimatePlanSpeechSeconds(shifted, ctx) - estimatePlanSpeechSeconds(noMicroPauses, ctx)).toBeCloseTo(1, 2);
  });

  it("extends close b-roll plans to the requested runtime using supported I2V durations", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 50 second product video for a smart induction pan called HomeChef",
      duration_seconds: 50,
      video_model: "ltx-2.3",
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "runtime-normalizer-test",
      project_dir: "/tmp/runtime-normalizer-test",
      video_model: "ltx-2.3",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const normalized = normalizePlanRuntimeToTarget(
      plan({
        scenes: [
          scene("scene_1", { duration_seconds: 10, on_camera: false }),
          scene("scene_2", { duration_seconds: 11, on_camera: false }),
          scene("scene_3", { duration_seconds: 12, on_camera: false }),
          scene("scene_4", { duration_seconds: 15, on_camera: false }),
        ],
      }),
      request,
      ctx,
    );

    expect(normalized.scenes.map((item) => item.duration_seconds)).toEqual([10, 15, 15, 15]);
    expect(validatePlanRuntimeCoverage(normalized, request, ctx)).toEqual([]);
  });

  it("does not stretch existing b-roll when its speech would leave long silence", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 45 second tiktok style ad for AeroBottle with product closeups and a strong ending",
      duration_seconds: 45,
      video_model: "ltx-2.3",
      audio_provider: "hume",
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "runtime-coverage-broll-extension-test",
      project_dir: "/tmp/runtime-coverage-broll-extension-test",
      video_model: "ltx-2.3",
      audio_provider: "hume",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const normalized = normalizePlanRuntimeToTarget(
      plan({
        scenes: [
          scene("scene_1", { duration_seconds: 10, narration: "I keep forgetting water during work.", on_camera: true }),
          scene("scene_2", {
            duration_seconds: 10,
            narration: "Then this little reminder lights up.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
            on_camera: false,
          }),
          scene("scene_3", {
            duration_seconds: 10,
            narration: "I take one sip and get back to it.",
            image_prompt: "Hands picking up AeroBottle and drinking beside a focused work setup.",
            on_camera: false,
          }),
          scene("scene_4", {
            duration_seconds: 10,
            narration: "The bottle stays next to the laptop during a focused work block.",
            image_prompt: "AeroBottle beside a laptop while the creator works with better focus.",
            on_camera: false,
          }),
          scene("scene_5", { duration_seconds: 10, narration: "Now I end the day hydrated.", on_camera: true }),
        ],
      }),
      request,
      ctx,
    );

    expect(normalized.scenes.map((item) => item.duration_seconds)).toEqual([7, 5, 5, 5, 7]);
    expect(validatePlanRuntimeCoverage(normalized, request, ctx).join(" ")).toContain("likely to render too short");
  });

  it("does not stretch a single UGC product b-roll beat to 30s to cover missing runtime", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 45 second tiktok style ad for AeroBottle with product closeups and a strong ending",
      duration_seconds: 45,
      video_model: "ltx-2.3",
      audio_provider: "hume",
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "runtime-no-long-broll-stretch-test",
      project_dir: "/tmp/runtime-no-long-broll-stretch-test",
      video_model: "ltx-2.3",
      audio_provider: "hume",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const normalized = normalizePlanRuntimeToTarget(
      plan({
        scenes: [
          scene("scene_1", { duration_seconds: 10, narration: "I kept forgetting water again.", on_camera: true }),
          scene("scene_2", {
            duration_seconds: 15,
            narration: "The reminder lights up.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
            on_camera: false,
          }),
          scene("scene_3", { duration_seconds: 10, narration: "Now I stay on track.", on_camera: true }),
        ],
      }),
      request,
      ctx,
    );

    expect(normalized.scenes.map((item) => item.duration_seconds)).toEqual([7, 5, 7]);
    expect(validatePlanRuntimeCoverage(normalized, request, ctx).join(" ")).toContain("likely to render too short");
  });

  it("rejects long UGC plans that overuse slow Talking Photo scenes", () => {
    const issues = validateProductionVideoPlan(
      plan({
        title: "AeroBottle TikTok UGC ad",
        scenes: [
          scene("scene_1", { duration_seconds: 9, on_camera: true }),
          scene("scene_2", { duration_seconds: 9, on_camera: true }),
          scene("scene_3", {
            narration: "The glowing reminder makes me take a sip before I crash.",
            image_prompt: "Close-up proof of AeroBottle glowing beside a laptop.",
            duration_seconds: 9,
            on_camera: false,
          }),
          scene("scene_4", { duration_seconds: 9, on_camera: true }),
          scene("scene_5", { duration_seconds: 9, on_camera: true }),
        ],
      }),
    );

    expect(issues.join(" ")).toContain("at most 2 on-camera Talking Photo scenes");
  });

  it("rejects Hume narrated scripts that are too short for 30-70s requested runtimes", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "i need a 50 second product video for a desk lamp called GlowBar with natural narration",
      duration_seconds: 50,
      audio_provider: "hume",
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "hume-short-narration-test",
      project_dir: "/tmp/hume-short-narration-test",
      audio_provider: "hume",
      audio_model: "octave-1",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const shortPlan = plan({
      title: "GlowBar Product Video",
      creative_vibe: "practical_product_demo",
      narration: "GlowBar makes the desk brighter. It has warm light, cool light, and phone charging.",
      scenes: [
        scene("scene_1", { narration: "My desk lighting was rough.", duration_seconds: 10, on_camera: false }),
        scene("scene_2", { narration: "GlowBar makes it brighter.", duration_seconds: 10, on_camera: false }),
        scene("scene_3", { narration: "Warm mode feels cozy.", duration_seconds: 10, on_camera: false }),
        scene("scene_4", { narration: "Cool mode helps focus.", duration_seconds: 10, on_camera: false }),
        scene("scene_5", { narration: "And it charges my phone.", duration_seconds: 10, on_camera: false }),
      ],
    });

    const issues = validatePlanAudioDurationFit(shortPlan, request, ctx);

    expect(issues.join(" ")).toContain("under-scripted");
    expect(issues.join(" ")).toContain("about 146+");
  });

  it("tightens narrated coverage only when the user explicitly forbids dead air", () => {
    const narration = [
      "Joseph sweeps a crowded Detroit street beneath a tall brick building.",
      "A baby girl falls from an upper window while he looks up.",
      "She lands in his arms, and both of them survive the impact.",
      "One year later, Joseph returns to work in a narrow alley.",
      "A baby boy falls toward his shoulders, and Joseph catches him too.",
    ].join(" ");
    const scenes = [
      scene("scene_1", { narration: narration.split(". ")[0] + ".", duration_seconds: 5, on_camera: false }),
      scene("scene_2", { narration: narration.split(". ")[1] + ".", duration_seconds: 10, on_camera: false }),
      scene("scene_3", { narration: narration.split(". ")[2] + ".", duration_seconds: 5, on_camera: false }),
      scene("scene_4", { narration: narration.split(". ")[3] + ".", duration_seconds: 5, on_camera: false }),
      scene("scene_5", { narration: narration.split(". ")[4], duration_seconds: 5, on_camera: false }),
    ];
    const narratedPlan = plan({
      title: "The Man Who Caught Two Falling Babies",
      creative_vibe: "cinematic_commercial",
      narration,
      scenes,
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "strict-narration-coverage-test",
      project_dir: "/tmp/strict-narration-coverage-test",
      audio_provider: "elevenlabs",
      audio_model: "eleven_multilingual_v2",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const normalRequest = CreateProjectRequestSchema.parse({
      prompt: "Create a 30 second narrated historical story.",
      duration_seconds: 30,
      audio_provider: "elevenlabs",
    });
    const strictRequest = CreateProjectRequestSchema.parse({
      prompt: "Create a 30 second narrated historical story with no silent or frozen filler.",
      duration_seconds: 30,
      audio_provider: "elevenlabs",
    });
    const listedStrictRequest = CreateProjectRequestSchema.parse({
      prompt: "Use hard cuts only, no captions, title cards, repeated events, or silent ending.",
      duration_seconds: 30,
      audio_provider: "elevenlabs",
    });

    const normalIssues = validatePlanAudioDurationFit(narratedPlan, normalRequest, ctx);
    const strictIssues = validatePlanAudioDurationFit(narratedPlan, strictRequest, ctx);
    const listedStrictIssues = validatePlanAudioDurationFit(narratedPlan, listedStrictRequest, ctx);

    expect(normalIssues.join(" ")).not.toContain("minimum 29.1s");
    expect(strictIssues.join(" ")).toContain("minimum 29.1s");
    expect(strictIssues.join(" ")).toContain("under-scripted");
    expect(listedStrictIssues.join(" ")).toContain("minimum 29.1s");
  });

  it("does not force mostly visual no-voice videos to meet narrated coverage", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a 50 second mostly visual ambient product mood video for GlowBar, no voiceover",
      duration_seconds: 50,
      audio_provider: "hume",
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "hume-mostly-visual-test",
      project_dir: "/tmp/hume-mostly-visual-test",
      audio_provider: "hume",
      audio_model: "octave-1",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const visualPlan = plan({
      title: "GlowBar Ambient Mood Video",
      creative_vibe: "cozy_lifestyle",
      narration: "",
      scenes: [
        scene("scene_1", { narration: "", duration_seconds: 10, on_camera: false }),
        scene("scene_2", { narration: "", duration_seconds: 10, on_camera: false }),
        scene("scene_3", { narration: "", duration_seconds: 10, on_camera: false }),
        scene("scene_4", { narration: "", duration_seconds: 10, on_camera: false }),
        scene("scene_5", { narration: "", duration_seconds: 10, on_camera: false }),
      ],
    });

    expect(validatePlanAudioDurationFit(visualPlan, request, ctx)).toEqual([]);
  });

  it("rejects Hume scripts that are likely to exceed the requested duration before video calls", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "i need a 50 second product video for a desk lamp called GlowBar",
      duration_seconds: 50,
      audio_provider: "hume",
    });
    const ctx: ProjectContext = {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "audio-duration-fit-test",
      project_dir: "/tmp/audio-duration-fit-test",
      audio_provider: "hume",
      audio_model: "octave-1",
      aspect_ratio: "9:16",
      resolution: "720p",
    };
    const glowBarPlan = plan({
      title: "GlowBar Desk Lamp",
      creative_vibe: "practical_product_demo",
      narration:
        "You know that moment when it's 11pm and you're still studying under harsh overhead light? Your eyes are tired, the room feels cold, and you just can't focus anymore. Then I got the GlowBar. One touch and the whole desk transforms. It has stepless brightness control, so you dial in exactly what you need. And the color temperature shifts from warm amber to cool daylight — warm for late night reading, cool for focused morning work. The best part I didn't expect? There's a built-in phone charger in the base. Just set your phone down and it charges while you work. No more cable clutter. Now when I sit down at night, the whole space feels different. Cozy, calm, actually somewhere I want to be. It's the one thing on my desk that changed everything. Even my notes feel easier to get through because the setup finally feels intentional, clean, and comfortable instead of like I'm forcing myself through another late-night grind.",
      scenes: [
        scene("scene_1", {
          narration:
            "You know that moment when it's 11pm and you're still studying under harsh overhead light? Your eyes are tired, the room feels cold, and you just can't focus anymore.",
          duration_seconds: 10,
          on_camera: false,
          audio_mode: "cinematic_narrator",
        }),
        scene("scene_2", {
          narration:
            "Then I got the GlowBar. One touch and the whole desk transforms. It has stepless brightness control, so you dial in exactly what you need.",
          duration_seconds: 10,
          on_camera: false,
          audio_mode: "product_proof",
        }),
        scene("scene_3", {
          narration:
            "And the color temperature shifts from warm amber to cool daylight — warm for late night reading, cool for focused morning work. The best part I didn't expect?",
          duration_seconds: 10,
          on_camera: false,
          audio_mode: "product_proof",
        }),
        scene("scene_4", {
          narration:
            "There's a built-in phone charger in the base. Just set your phone down and it charges while you work. No more cable clutter.",
          duration_seconds: 10,
          on_camera: false,
          audio_mode: "product_proof",
        }),
        scene("scene_5", {
          narration:
            "Now when I sit down at night, the whole space feels different. Cozy, calm, actually somewhere I want to be. It's the one thing on my desk that changed everything. Even my notes feel easier to get through because the setup finally feels intentional, clean, and comfortable instead of like I'm forcing myself through another late-night grind.",
          duration_seconds: 10,
          on_camera: false,
          audio_mode: "calm_lifestyle",
        }),
      ],
    });

    expect(estimatePlanSpeechSeconds(glowBarPlan, ctx)).toBeGreaterThan(50);
    const issues = validatePlanAudioDurationFit(glowBarPlan, request, ctx);
    expect(issues.join(" ")).toContain("Estimated hume voiceover");
    expect(issues.join(" ")).toMatch(/scene_\d+ narration .* about \d+ words/);
    expect(issues.join(" ")).toContain("redistribute its extra detail into another scene");
    expect(issues.join(" ")).toContain("generic ad phrases");
  }, 10_000);

  it("rejects UGC/product plans without visible proof or payoff beats", () => {
    const issues = validateProductionVideoPlan(
      plan({
        scenes: [
          scene("scene_1", { image_prompt: "A creator talking in a bedroom." }),
          scene("scene_2", { image_prompt: "The creator keeps talking in the same bedroom." }),
          scene("scene_3", { image_prompt: "The creator continues talking in the same bedroom." }),
        ],
      }),
    );

    expect(issues.join(" ")).toContain("visible proof");
    expect(issues.join(" ")).toContain("payoff");
  });

  it("does not force an on-camera creator for cinematic commercial plans", () => {
    const issues = validateProductionVideoPlan(
      plan({
        title: "Cinematic brand commercial",
        narration: "A polished product film shows the bottle solving a real desk problem.",
        visual_bible: "Moody practical light, product macro shots, clean desk reveal, no presenter.",
        scenes: [
          scene("scene_1", {
            narration: "The reminder arrives before the day gets away.",
            image_prompt: "Macro product close-up of AeroBottle glowing beside a laptop, premium commercial lighting.",
            video_prompt: "Slow macro push toward the glowing bottle.",
            on_camera: false,
          }),
          scene("scene_2", {
            narration: "A simple rhythm turns scattered focus into a better workday.",
            image_prompt: "Hands using the bottle during focused work, visible hydration tracking on the bottle.",
            video_prompt: "Gentle handheld slide across the desk setup.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "End the day clear, steady, and hydrated.",
            image_prompt: "Final product reveal on a clean desk with a clear result and polished CTA composition.",
            video_prompt: "Slow push toward the product and final result reveal.",
            on_camera: false,
          }),
        ],
      }),
    );

    expect(issues).toEqual([]);
  });

  it("allows creator-style voiceover plans with visible creator reactions", () => {
    const issues = validateProductionVideoPlan(
      plan({
        title: "AeroBottle TikTok UGC ad",
        scenes: [
          scene("scene_1", {
            narration: "I kept forgetting water until the reminder pulled me out of autopilot.",
            image_prompt: "A creator at a work desk noticing AeroBottle beside a laptop, candid tired reaction.",
            on_camera: false,
          }),
          scene("scene_2", {
            narration: "The bottle glows right when I am buried in work, so I actually take the sip.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop while the creator reaches for it.",
            video_prompt: "Slow handheld push toward the reminder glow as the creator reaches for one sip.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "By the end of the day, staying on track feels automatic instead of like another task.",
            image_prompt: "Final desk reveal with AeroBottle in the foreground and the creator looking focused and hydrated.",
            video_prompt: "Slow push toward the product and final result reveal.",
            on_camera: false,
          }),
        ],
      }),
    );

    expect(issues).toEqual([]);
  });

  it("rejects explicit visible-speaker plans that never use on-camera talking", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: 'make a 30 second TikTok UGC ad where the creator says "I keep forgetting water until AeroBottle reminds me"',
      duration_seconds: 30,
    });
    const issues = validateProductionVideoPlan(
      plan({
        title: "AeroBottle TikTok UGC ad",
        scenes: [
          scene("scene_1", { on_camera: false }),
          scene("scene_2", { on_camera: false }),
          scene("scene_3", { on_camera: false }),
        ],
      }),
      request,
    );

    expect(issues.join(" ")).toContain("Visible-speaker");
  });
});

describe("alignPlanToMeasuredVoiceover", () => {
  it("moves hard-cut durations to measured narration starts while preserving total runtime", () => {
    const source = plan();
    const aligned = alignPlanToMeasuredVoiceover(source, {
      duration_seconds: 23.7,
      target_duration_seconds: 24,
      scene_timings: [
        { scene_id: "scene_1", start_seconds: 0, end_seconds: 5.7 },
        { scene_id: "scene_2", start_seconds: 6.2, end_seconds: 14.5 },
        { scene_id: "scene_3", start_seconds: 15.1, end_seconds: 23.7 },
      ],
    });

    expect(aligned.scenes.map((item) => item.duration_seconds)).toEqual([6, 9, 9]);
    expect(aligned.scenes.reduce((sum, item) => sum + item.duration_seconds, 0)).toBe(24);
  });
});
