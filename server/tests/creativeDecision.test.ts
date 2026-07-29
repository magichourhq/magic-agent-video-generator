import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import {
  creativeIntentBrief,
  inferCreativeIntent,
  validatePlanForCreativeIntent,
} from "../src/creativeDecision.js";
import { CreateProjectRequestSchema, type CreateProjectRequest, type Scene, type VideoPlan } from "../src/schemas.js";
import { initializeProjectState, readJsonArtifact } from "../src/renderState.js";
import {
  draftFallbackVideoPlanImpl,
  draftVideoPlanImpl,
  repairIntroducedOnlyNewIssueFamilies,
} from "../src/workflows.js";

describe("bounded draft repair policy", () => {
  it("permits one extra repair only for a newly introduced issue family", () => {
    expect(
      repairIntroducedOnlyNewIssueFamilies(
        ["scene_4 starts a falling event without completing the catch or landing."],
        ["Narrated elevenlabs plan is under-scripted; write about 70+ spoken words."],
      ),
    ).toBe(true);
    expect(
      repairIntroducedOnlyNewIssueFamilies(
        ["scene_4 starts a falling event without completing the catch or landing."],
        ["scene_4 still lacks falling geometry and a completed landing."],
      ),
    ).toBe(false);
  });
});

function request(prompt: string, overrides: Partial<CreateProjectRequest> = {}): CreateProjectRequest {
  return CreateProjectRequestSchema.parse({ prompt, ...overrides });
}

function ctx(projectDir = path.join(tmpdir(), "creative-decision-static")): ProjectContext {
  return {
    project_id: "creative-decision-test",
    project_dir: projectDir,
    aspect_ratio: "9:16",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

function scene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    narration: "I tried it once, and it immediately made the routine easier.",
    image_prompt: "A casual creator at a desk holding the product, natural phone-style UGC framing.",
    video_prompt: "Slow handheld push in.",
    duration_seconds: 8,
    on_camera: true,
    audio_mode: "ugc_casual",
    audio_note: null,
    reference_media_ids: [],
    continuity: {
      story_beat: `Unique chronological beat ${id}`,
      required_subjects: [],
      opening_state: `The creator and product remain at the same desk before ${id}.`,
      closing_state: `The creator and product remain at the same desk after ${id}.`,
      setting: "The same home workspace during the same workday.",
      screen_direction: "not_applicable",
    },
    ...overrides,
  };
}

function plan(overrides: Partial<VideoPlan> = {}): VideoPlan {
  return {
    title: "AeroBottle TikTok ad",
    creative_vibe: "raw_ugc",
    narration: "A creator forgets water, sees the reminder, proves the feature, and ends with a clear CTA.",
    visual_bible: "One casual creator, handheld workday footage, product closeups, realistic desk setup.",
    voice: null,
    scenes: [
      scene("scene_1", {
        narration: "I always forget water until my focus is already gone.",
        image_prompt: "A casual creator at a laptop noticing an untouched AeroBottle on the desk.",
      }),
      scene("scene_2", {
        narration: "The reminder lights up right when I need it.",
        image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop with hydration tracking visible.",
        on_camera: false,
      }),
      scene("scene_3", {
        narration: "If you're like me, try it before your next afternoon crash.",
        image_prompt: "Final clean desk reveal with AeroBottle in the foreground and a creator reaction in the background.",
      }),
    ],
    ...overrides,
  };
}

describe("creative intent inference", () => {
  it("keeps cinematic historical stories out of commercial and edit contracts", () => {
    const intent = inferCreativeIntent(
      request(
        "Create a 30-second cinematic historical story about Joseph Figlock. Use active footage for the one-year time change and keep it black-and-white.",
        { duration_seconds: 30 },
      ),
      ctx(),
    );

    expect(intent.format).toBe("general");
    expect(intent.goal).toBe("story");
    expect(intent.required_beats).not.toContain("product_proof");
    expect(intent.required_beats).not.toContain("payoff_cta");
  });

  it("keeps a generic visual request neutral instead of defaulting to UGC", () => {
    const intent = inferCreativeIntent(request("Make a peaceful 20 second video of sunrise over a quiet city."), ctx());

    expect(intent.format).toBe("general");
    expect(intent.speech_mode).toBe("mostly_visual");
    expect(intent.required_beats).toEqual([]);
  });

  it("maps a TikTok smart-water-bottle ad to UGC conversion with product proof beats", () => {
    const intent = inferCreativeIntent(
      request(
        "can you make a 60 second tiktok style ad for a smart water bottle called AeroBottle? make it feel like a normal person filming during their workday. include closeups and a strong ending.",
        { duration_seconds: 60 },
      ),
      ctx(),
    );

    expect(intent.format).toBe("ugc");
    expect(intent.platform).toBe("tiktok");
    expect(intent.goal).toBe("conversion");
    expect(intent.speech_mode).toBe("inferred_creator_dialogue");
    expect(intent.suggested_vibe).toBe("raw_ugc");
    expect(intent.required_beats).toEqual(expect.arrayContaining(["hook", "creator_reaction", "product_proof", "payoff_cta"]));
    expect(intent.pacing.preferred_scene_count).toBeGreaterThanOrEqual(7);
  });

  it("keeps comparison format even when the user asks for creator talking", () => {
    const intent = inferCreativeIntent(
      request("make a 55 second comparison ad for running shoes with a mix of creator talking, closeups, and running shots."),
      ctx(),
    );

    expect(intent.format).toBe("comparison");
    expect(intent.required_beats).toEqual(expect.arrayContaining(["creator_reaction", "product_proof", "payoff_cta"]));
  });

  it("maps a cinematic product commercial without forcing a creator format", () => {
    const intent = inferCreativeIntent(request("Make a cinematic 40 second commercial for Coca-Cola with a final hero reveal."), ctx());

    expect(intent.format).toBe("cinematic_ad");
    expect(intent.speech_mode).toBe("voiceover");
    expect(intent.suggested_vibe).toBe("cinematic_commercial");
    expect(intent.required_beats).toEqual(expect.arrayContaining(["product_proof", "payoff_cta"]));
    expect(intent.required_beats).not.toContain("creator_reaction");
  });

  it("keeps quoted user speech as spoken dictation", () => {
    const intent = inferCreativeIntent(request('Make a UGC ad where she says "I forgot water again, then AeroBottle saved me."'), ctx());

    expect(intent.speech_mode).toBe("quoted_user_speech");
  });

  it("requires an explicitly requested ending narration claim in the final scene", () => {
    const promptText =
      "Create a 30-second historical story. End on the stunned crowd as narration explains that both babies survived.";
    const creativeIntent = inferCreativeIntent(request(promptText, { duration_seconds: 30 }), ctx());
    const missingClaim = plan({
      creative_vibe: "cinematic_commercial",
      scenes: [
        scene("scene_1", {
          narration: "Joseph caught the first baby beneath the window.",
          on_camera: false,
          audio_mode: "cinematic_narrator",
        }),
        scene("scene_2", {
          narration: "A stunned crowd gathered around Joseph in the alley.",
          on_camera: false,
          audio_mode: "cinematic_narrator",
        }),
      ],
    });

    expect(validatePlanForCreativeIntent(missingClaim, creativeIntent, request(promptText, { duration_seconds: 30 })).join(" "))
      .toContain('Final scene narration must preserve the explicitly requested ending claim: "both babies survived"');

    const preservedClaim = {
      ...missingClaim,
      scenes: missingClaim.scenes.map((item, index) =>
        index === missingClaim.scenes.length - 1
          ? { ...item, narration: "A stunned crowd gathered around Joseph, and both babies survived." }
          : item,
      ),
    };
    expect(
      validatePlanForCreativeIntent(preservedClaim, creativeIntent, request(promptText, { duration_seconds: 30 })).join(" "),
    ).not.toContain("explicitly requested ending claim");
  });

  it("rejects plans that paraphrase explicitly requested quoted narration", () => {
    const input = request(
      'Create a historical story where narration says, "Imagine two babies falling from the sky onto the same man."',
    );
    const intent = inferCreativeIntent(input, ctx());
    const testPlan = plan({
      narration: "Detroit, 1937. Joseph Figlock was sweeping beneath a tenement window.",
      scenes: [
        scene("scene_1", {
          narration: "Detroit, 1937. Joseph Figlock was sweeping beneath a tenement window.",
        }),
      ],
    });

    expect(validatePlanForCreativeIntent(testPlan, intent, input).join(" ")).toContain(
      "Quoted user speech must remain exact",
    );
  });

  it("treats unquoted closeup/caption requests as visual direction, not dictation", () => {
    const intent = inferCreativeIntent(
      request("Make a cinematic product video for GlowBar. Show closeups of brightness settings and include captions."),
      ctx(),
    );

    expect(intent.speech_mode).toBe("mostly_visual");
  });

  it("does not mistake an anti-repetition direction for a product comparison", () => {
    const intent = inferCreativeIntent(
      request(
        "Create a 30-second cinematic anime video of the same teenage boy on one grassy hill at night. Use peaceful music with no narration and vary the coherent camera angles instead of repeating the same rise or zoom.",
        { duration_seconds: 30 },
      ),
      ctx(),
    );

    expect(intent.format).toBe("general");
    expect(intent.goal).toBe("story");
    expect(intent.speech_mode).toBe("mostly_visual");
    expect(intent.required_beats).not.toContain("product_proof");
    expect(intent.required_beats).not.toContain("payoff_cta");
  });

  it("maps edit prompts to edit goal without implying a fresh full generation", () => {
    const intent = inferCreativeIntent(request("Change scene 2 so the product closeup is faster and trim the ending."), ctx());

    expect(intent.goal).toBe("edit");
  });

  it("prints a compact brief for the planning prompt", () => {
    const brief = creativeIntentBrief(inferCreativeIntent(request("Make a TikTok UGC ad for a smart bottle."), ctx()));

    expect(brief).toContain("Format intent");
    expect(brief).toContain("Speech interpretation");
    expect(brief).toContain("Speech style");
    expect(brief).toContain("Suggested video vibe");
    expect(brief).toContain("Plan schema rule");
    expect(brief).toContain("Format grammar");
    expect(brief).toContain("Required format-specific first-run beats");
    expect(brief).toContain("Provider-cost rule");
  });
});

describe("creative intent plan validation", () => {
  it("passes a good UGC plan with hook, creator, product proof, and CTA", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle with closeups and a strong CTA.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());

    expect(validatePlanForCreativeIntent(plan(), intent, req)).toEqual([]);
  });

  it("accepts a creator-native stay-on-track payoff for product UGC", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle that helps people stay on track.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());

    expect(
      validatePlanForCreativeIntent(
        plan({
          scenes: [
            scene("scene_1", {
              narration: "I kept forgetting water until my focus was already slipping.",
            }),
            scene("scene_2", {
              narration: "The subtle reminder makes me take a sip before the crash hits.",
              image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
              on_camera: false,
            }),
            scene("scene_3", {
              narration: "Now I stay on track all day without thinking about it.",
              image_prompt: "Final clean desk reveal with AeroBottle in the foreground and the creator back on track.",
            }),
          ],
        }),
        intent,
        req,
      ),
    ).toEqual([]);
  });

  it("rejects adjacent scenes that repeat the same AeroBottle reminder beat", () => {
    const req = request(
      "can you make a 40 second tiktok style ad for a smart water bottle called AeroBottle? make it feel like a normal person filming during their workday.",
      { duration_seconds: 40 },
    );
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "I keep forgetting water until my afternoon focus is already gone.",
            image_prompt: "A normal creator working at a laptop with AeroBottle beside the keyboard.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_2", {
            narration: "AeroBottle reminds me with a subtle glow before I totally crash.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop with a phone notification nearby.",
            video_prompt: "Slow handheld push toward the glowing bottle and phone notification.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "Then it lights up and pings my phone again, basically telling me to sip up.",
            image_prompt: "Close-up product proof of AeroBottle lighting up beside the same laptop and phone reminder.",
            video_prompt: "Slow push toward the lit bottle as the phone sits beside it.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_4", {
            narration: "By the end of the day, I feel way more on track.",
            image_prompt: "Final clean desk reveal with AeroBottle in the foreground and the creator looking focused.",
            duration_seconds: 10,
            on_camera: false,
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("repeat the same reminder/notification product proof");
  });

  it("rejects repeated spoken lines across different scenes", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle with closeups and a CTA.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", { narration: "I kept forgetting water until this bottle reminded me." }),
          scene("scene_2", {
            narration: "I kept forgetting water until this bottle reminded me.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "Now I stay on track before the afternoon crash hits.",
            image_prompt: "Final desk reveal with AeroBottle and a clear creator payoff.",
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("repeat the same spoken line");
  });

  it("accepts direct second-person creator CTAs in UGC narration", () => {
    const req = request("Make a comparison UGC ad for PaceFlex running shoes with creator talking and a clean reason to try them.", {
      duration_seconds: 30,
    });
    const intent = inferCreativeIntent(req, ctx());

    expect(
      validatePlanForCreativeIntent(
        plan({
          scenes: [
            scene("scene_1", {
              narration: "I noticed my old shoes felt stiff before I even hit the corner.",
              duration_seconds: 10,
            }),
            scene("scene_2", {
              narration: "The flexible sole bends with each step instead of fighting it.",
              image_prompt: "Close-up product proof of PaceFlex flexible sole bending on a morning sidewalk.",
              duration_seconds: 10,
              on_camera: false,
            }),
            scene("scene_3", {
              narration: "If your morning run feels heavier than it should, try these first.",
              image_prompt: "Creator on a quiet sidewalk holding the PaceFlex shoe with a clear final payoff.",
              duration_seconds: 10,
            }),
          ],
        }),
        intent,
        req,
      ),
    ).toEqual([]);
  });

  it("accepts skincare application details as concrete product proof", () => {
    const req = request("Make a 40 second UGC skincare ad for a serum called MiraSkin.", { duration_seconds: 40 });
    const intent = inferCreativeIntent(req, ctx());

    expect(
      validatePlanForCreativeIntent(
        plan({
          scenes: [
            scene("scene_1", {
              narration: "My skin looked tired before work, so I kept this really simple.",
              duration_seconds: 10,
            }),
            scene("scene_2", {
              narration: "I apply two drops and it sinks in without feeling sticky.",
              image_prompt: "Close-up product proof of MiraSkin serum dropper applying clear serum to realistic skin texture.",
              video_prompt: "Gentle hand motion applying serum on fingertips in bathroom light.",
              duration_seconds: 10,
              on_camera: false,
            }),
            scene("scene_3", {
              narration: "By the time I head out, my morning feels more put together.",
              image_prompt: "Final bathroom mirror reveal with natural skin glow and MiraSkin on the counter.",
              duration_seconds: 10,
            }),
          ],
        }),
        intent,
        req,
      ),
    ).toEqual([]);
  });

  it("rejects narration that leaks visual directions or schema words", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({ scenes: [scene("scene_1", { narration: "Close-up shot of the bottle, image_prompt goes here." })] }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("visual directions or schema words");
  });

  it("rejects meta planning language that would sound nonsensical as voiceover", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "The ending should feel like a real recommendation, and the benefit is easy to understand.",
          }),
          scene("scene_2", {
            narration: "The proof matters because the setup feels quick.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "If you're like me, try it before your next afternoon crash.",
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("meta planning language");
  });

  it("rejects detached third-person UGC narration when the creator should be speaking", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle that feels like a normal person filming.", {
      duration_seconds: 30,
    });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "The creator keeps it beside their laptop and they remember to drink more water.",
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("creator's point of view");
  });

  it("requires on-camera talking only for explicit visible speech requests", () => {
    const req = request('Make a TikTok UGC ad where the creator says "I forgot water again."', {
      duration_seconds: 30,
    });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", { on_camera: false }),
          scene("scene_2", {
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "Now I stay on track all day without thinking about it.",
            image_prompt: "Final clean desk reveal with AeroBottle in the foreground and the creator back on track.",
            on_camera: false,
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("explicit visible-speaker");
  });

  it("rejects multi-panel keyframes before provider calls", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            image_prompt: "A split-screen before and after layout with three stacked panels of the creator and product.",
          }),
          scene("scene_2"),
          scene("scene_3"),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("single full-frame keyframe");
  });

  it("rejects product-lineup keyframes before provider calls", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            image_prompt: "A lineup of different smart water bottle variants across a desk.",
          }),
          scene("scene_2"),
          scene("scene_3"),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("one primary product instance");
  });

  it("rejects a vibe that does not fit the inferred format", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        creative_vibe: "cinematic_commercial",
        visual_bible: "Controlled cinematic product commercial lighting, macro hero product reveal.",
        scenes: [
          scene("scene_1", {
            image_prompt: "Controlled cinematic product commercial lighting on a macro AeroBottle hero shot.",
          }),
          scene("scene_2", {
            image_prompt: "Macro product close-up proof of AeroBottle glowing beside the laptop.",
            on_camera: false,
          }),
          scene("scene_3", {
            image_prompt: "Cinematic final product reveal with a clean payoff.",
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("does not fit inferred ugc format");
  });

  it("rejects on-camera UGC narration that is not first-person creator speech", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "Introducing AeroBottle, the revolutionary bottle designed to elevate your workday.",
          }),
          scene("scene_2", {
            narration: "The reminder lights up right when I need it.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "If you're like me, try it before your next afternoon crash.",
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("first-person and creator-native");
  });

  it("rejects bracketed performance cues in UGC spoken narration", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [scene("scene_1", { narration: "[energetic] I kept forgetting water until this thing blinked at me." })],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("bracketed performance cues");
  });

  it("rejects long UGC plans with too little spoken copy for the runtime", () => {
    const req = request("Make a 60 second TikTok UGC ad for AeroBottle.", { duration_seconds: 60 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", { narration: "I forget water.", duration_seconds: 12 }),
          scene("scene_2", {
            narration: "It glows.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
            duration_seconds: 12,
            on_camera: false,
          }),
          scene("scene_3", { narration: "I drink.", duration_seconds: 12 }),
          scene("scene_4", { narration: "I stay on track.", duration_seconds: 12, on_camera: false }),
          scene("scene_5", { narration: "Link in bio.", duration_seconds: 12 }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("under-scripted");
  });

  it("rejects long UGC plans with too many Talking Photo scenes", () => {
    const req = request("Make a 45 second TikTok UGC ad for AeroBottle with product proof.", { duration_seconds: 45 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", { duration_seconds: 9, on_camera: true }),
          scene("scene_2", { duration_seconds: 9, on_camera: true }),
          scene("scene_3", {
            narration: "The glowing reminder makes me take a sip before I crash.",
            image_prompt: "Close-up product proof of AeroBottle glowing beside a laptop.",
            duration_seconds: 9,
            on_camera: false,
          }),
          scene("scene_4", { duration_seconds: 9, on_camera: true }),
          scene("scene_5", { duration_seconds: 9, on_camera: true }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("at most 2 on-camera Talking Photo scenes");
  });

  it("rejects on-camera UGC lines that are not first-person or creator-native", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [scene("scene_1", { narration: "The bottle reminds busy workers to stay hydrated." })],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("first-person and creator-native");
  });

  it("rejects UGC product plans that have no b-roll or proof beat", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", { image_prompt: "A creator talking in a bedroom." }),
          scene("scene_2", { image_prompt: "The same creator talking in a bedroom." }),
          scene("scene_3", { image_prompt: "The creator still talking in a bedroom." }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("Product-oriented plans need");
  });

  it("allows cinematic product plans without an on-camera creator when proof and payoff exist", () => {
    const req = request("Make a cinematic commercial for AeroBottle with product closeups and a final reveal.", {
      duration_seconds: 30,
    });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        title: "Cinematic commercial",
        creative_vibe: "cinematic_commercial",
        visual_bible: "Controlled cinematic lighting, macro product closeups, polished product hero reveal.",
        scenes: [
          scene("scene_1", {
            narration: "The bottle catches the light before the workday gets hectic.",
            image_prompt: "Macro product close-up of AeroBottle glowing beside a laptop.",
            on_camera: false,
          }),
          scene("scene_2", {
            narration: "Hands pick it up during focused work, making the habit feel effortless.",
            image_prompt: "Hands using AeroBottle hydration tracking during focused work.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "The final desk reveal makes staying hydrated feel simple and premium.",
            image_prompt: "Final product reveal with a clear desk result and CTA composition.",
            on_camera: false,
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues).toEqual([]);
  });

  it("allows cozy problem-solution product plans when proof and payoff are present", () => {
    const req = request(
      "i need a 50 second product video for a desk lamp called GlowBar. show someone studying in bad lighting, then show how the lamp makes the setup way better.",
      { duration_seconds: 50 },
    );
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        title: "GlowBar Desk Lamp",
        creative_vibe: "cozy_lifestyle",
        visual_bible: "Warm cozy desk study lifestyle, soft home lighting, useful practical product closeups.",
        narration: "Bad desk lighting feels harsh. GlowBar makes the setup warmer, clearer, and easier to work in.",
        scenes: [
          scene("scene_1", {
            narration: "Late-night studying feels harsh under overhead light.",
            image_prompt: "Student at a desk in bad lighting, warm cozy home study setting.",
            video_prompt: "Gentle push across the dim desk.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_2", {
            narration: "GlowBar brings soft light right where it is needed.",
            image_prompt: "Close-up product proof of GlowBar lighting the desk surface.",
            video_prompt: "Slow push toward the lamp on the desk.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "Brightness and color temperature shift for reading or focused work.",
            image_prompt: "Hands adjusting GlowBar brightness and warm cool light modes.",
            video_prompt: "Close detail of hands changing the lamp setting.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_4", {
            narration: "The phone charges at the base while the desk stays clean.",
            image_prompt: "Phone charging on the GlowBar base with cable-free desk proof.",
            video_prompt: "Slow push across the charging base.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_5", {
            narration: "The final setup feels cozy, calm, and useful.",
            image_prompt: "Final cozy desk reveal with GlowBar as the useful centerpiece.",
            video_prompt: "Slow reveal of the finished cozy desk setup.",
            duration_seconds: 10,
            on_camera: false,
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues).toEqual([]);
  });

  it("does not force on-camera talking-photo scenes for comparison product plans", () => {
    const req = request(
      "make a 55 second comparison style ad for running shoes called PaceFlex with closeups and sidewalk running shots.",
      { duration_seconds: 55 },
    );
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        title: "PaceFlex running shoe comparison",
        creative_vibe: "practical_product_demo",
        visual_bible: "Hands-on product demo with close-up proof, sidewalk running, before and after comparison.",
        narration: "Old stiff shoes feel heavy. PaceFlex looks lighter, flexes cleaner, and makes the morning run feel easier.",
        scenes: [
          scene("scene_1", {
            narration: "The old shoes feel stiff before the run even starts.",
            image_prompt: "Runner tying stiff old shoes on a morning sidewalk, single close product setup.",
            video_prompt: "Slow push across the stiff shoe and sidewalk.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_2", {
            narration: "PaceFlex bends cleanly at the sole.",
            image_prompt: "Close-up product proof of PaceFlex flexible sole bending in hand.",
            video_prompt: "Gentle handheld close-up of the flexible shoe sole.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "The stride looks lighter and more comfortable.",
            image_prompt: "Sidewalk running shot with PaceFlex shoes in motion, practical demo.",
            video_prompt: "Simple low-angle tracking motion of the runner's feet.",
            duration_seconds: 10,
            on_camera: false,
          }),
          scene("scene_4", {
            narration: "The final reason to try them is simple: less stiff, more natural.",
            image_prompt: "Final product result reveal with PaceFlex beside the old stiff shoe.",
            video_prompt: "Slow reveal of the comparison result.",
            duration_seconds: 10,
            on_camera: false,
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues).toEqual([]);
  });

  it("rejects unsupported I2V durations and risky motion prompts before provider calls", () => {
    const req = request("Make a cinematic product demo for AeroBottle.", {
      duration_seconds: 30,
      video_model: "kling-2.5",
    });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            duration_seconds: 13,
            on_camera: false,
            video_prompt: "Cut to a new scene where a logo appears.",
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("not supported");
    expect(issues.join(" ")).toContain("ungrounded motion");
  });
});

describe("draftVideoPlanImpl pre-provider repair gate", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns structured repair results before failing after the allowed invalid drafts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creative-draft-gate-"));
    dirs.push(dir);
    const projectCtx = ctx(dir);
    initializeProjectState(projectCtx, {
      user_preferences: request("Make a TikTok UGC ad for AeroBottle with closeups.", { duration_seconds: 30 }),
    });

    const invalidScenes = [
      scene("temporary", {
        narration: "Close-up shot of the product, video_prompt should show the logo.",
        video_prompt: "Cut to a new scene where a logo appears.",
      }),
    ];
    const first = await draftVideoPlanImpl(projectCtx, "Bad plan", "Bad narration", invalidScenes, "");

    expect(first.validation_failed).toBe(true);
    expect(first.next_tools).toEqual(["draft_video_plan"]);
    expect(String(first.message)).toContain("Focused repair rules:");
    expect(String(first.message)).not.toContain("For 40-60s UGC/product ads");
    expect(readJsonArtifact(projectCtx, "plan", null)).toBeNull();
    expect(existsSync(path.join(dir, "plan.json"))).toBe(false);

    await expect(draftVideoPlanImpl(projectCtx, "Bad plan", "Bad narration", invalidScenes, "")).rejects.toThrow(
      /first-run production quality checks/,
    );
  }, 10000);

  it("writes a fallback UGC plan with speakable first-person narration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creative-fallback-script-"));
    dirs.push(dir);
    const projectCtx = ctx(dir);
    initializeProjectState(projectCtx, {
      user_preferences: request(
        "can you make a 60 second tiktok style ad for a smart water bottle called AeroBottle? make it feel like a normal person filming during their workday.",
        { duration_seconds: 60 },
      ),
    });

    const result = await draftFallbackVideoPlanImpl(projectCtx);
    const savedPlan = readJsonArtifact<VideoPlan>(projectCtx, "plan");
    const spoken = savedPlan?.scenes.map((item) => item.narration).join(" ") ?? "";

    expect(result.validation_failed, JSON.stringify(result, null, 2)).not.toBe(true);
    expect(savedPlan?.scenes.reduce((sum, item) => sum + item.duration_seconds, 0)).toBe(60);
    expect(savedPlan?.scenes.every((item) => item.on_camera === false)).toBe(true);
    expect(spoken).not.toMatch(/the proof matters|ending should feel|benefit is easy to understand|product feels useful/i);
    expect(spoken).toMatch(/\bI\b/);
  });

  it("derives the saved full narration from clean scene narration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creative-clean-global-narration-"));
    dirs.push(dir);
    const projectCtx = ctx(dir);
    const scenes = [
      scene("draft_a", { narration: "I kept forgetting water while I worked.", duration_seconds: 8, on_camera: false }),
      scene("draft_b", { narration: "The bottle reminder made the habit easy to notice.", duration_seconds: 8, on_camera: false }),
      scene("draft_c", { narration: "By the end, I was actually on track.", duration_seconds: 8, on_camera: false }),
    ];

    const result = await draftVideoPlanImpl(
      projectCtx,
      "AeroBottle clean narration",
      "[Scene 1: Hook] I kept forgetting water. [Scene 2: Proof] The bottle reminder helped.",
      scenes,
      "Phone-shot workday UGC with one creator and practical product proof.",
      "raw_ugc",
    );

    const savedPlan = readJsonArtifact<VideoPlan>(projectCtx, "plan");
    expect(result.validation_failed, JSON.stringify(result, null, 2)).not.toBe(true);
    expect(savedPlan?.narration).not.toMatch(/\[Scene|\bScene\s+\d/i);
    expect(savedPlan?.narration).toBe(scenes.map((item) => item.narration).join("\n\n"));
  });

  it("keeps the fallback plan relevant for SaaS video tools", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creative-fallback-saas-"));
    dirs.push(dir);
    const projectCtx = ctx(dir);
    initializeProjectState(projectCtx, {
      user_preferences: request(
        "make me about a 1 minute video for an AI video tool called ClipPilot. start by showing how annoying it is to make videos right now with too many tools, edits, and retries. then show ClipPilot making it easier by planning the shots, generating clips, fixing problems, and putting the final video together. keep it polished but still natural, not super corporate.",
        { duration_seconds: 60 },
      ),
    });

    const result = await draftFallbackVideoPlanImpl(projectCtx);
    const savedPlan = readJsonArtifact<VideoPlan>(projectCtx, "plan");
    const spoken = savedPlan?.scenes.map((item) => item.narration).join(" ") ?? "";
    const visualText = savedPlan?.scenes.map((item) => `${item.image_prompt} ${item.video_prompt}`).join(" ") ?? "";

    expect(result.validation_failed, JSON.stringify(result, null, 2)).not.toBe(true);
    expect(savedPlan?.title).toContain("ClipPilot");
    expect(savedPlan?.creative_vibe).toBe("polished_ugc");
    expect(spoken).toMatch(/\b(video|clips|shot|workflow|editing|tools)\b/i);
    expect(visualText).toMatch(/\b(laptop|timeline|clip|workspace|creator)\b/i);
    expect(`${spoken} ${visualText}`).not.toMatch(/\b(water|bottle|hydration|hydrate|sip)\b/i);
  });
});
