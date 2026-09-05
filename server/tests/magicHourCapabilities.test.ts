import { describe, expect, it } from "vitest";
import {
  classifyMagicHourRequest,
  magicHourCapabilityBrief,
  MAGIC_HOUR_CAPABILITIES,
} from "../src/magicHourCapabilities.js";
import { CreateProjectRequestSchema } from "../src/schemas.js";

describe("Magic Hour capability routing", () => {
  it("does not mistake creator body language for a body-edit request", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "Create a vertical 9:16 short-form social video, 8 seconds, in a casual UGC style. " +
        "A creator holds up a compact gadget and says through expression and body language that it is useful.",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("does not demand product details for a non-product short-form skit", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "Create a vertical 9:16 short-form video, 8 seconds, as a POV relatable skit. " +
        "One person at a desk realizes it is 2 a.m. and has a funny emotional spiral beside an empty coffee cup.",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("routes image-only prompts to standalone image generation", () => {
    const result = classifyMagicHourRequest({ prompt: "make an image of a cat wearing sunglasses", workflow: "generated" });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("image");
    expect(result.capability_id).toBe("standalone_image");
  });

  it("routes generated video prompts to the multi-scene video pipeline", () => {
    const result = classifyMagicHourRequest({
      prompt: "make a 40 second TikTok ad for a smart water bottle",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("lets explicit video requests override incidental image words like still", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "make me about a 1 minute video for an AI video tool called ClipPilot. start by showing how annoying it is to make videos right now with too many tools, edits, and retries. then show ClipPilot making it easier by planning the shots, generating clips, fixing problems, and putting the final video together. keep it polished but still natural, not super corporate.",
      workflow: "generated",
      duration_seconds: 60,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("does not over-clarify detailed UGC product prompts", () => {
    const result = classifyMagicHourRequest({
      prompt: "make a 60 second TikTok style ad for a smart water bottle called AeroBottle that reminds me to drink during work",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("keeps voice-style preferences inside detailed video prompts", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "can you make a 40 second UGC skincare ad for a serum called MiraSkin? make it feel like someone filming in their bathroom before work. i want the voice to sound casual and specific, not like a beauty commercial.",
      workflow: "generated",
      duration_seconds: 40,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("treats an explicit no-lip-sync instruction as a video constraint, not a lip-sync request", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "Create a 30-second vertical historical story about Joseph Figlock. Use one consistent narrator, no lip sync, no captions, and no title cards.",
      workflow: "generated",
      duration_seconds: 30,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("treats captions inside a negative production list as constraints, not an edit request", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "Create a 20-second vertical comedy skit about group-project reality. Keep the same three coworkers and laptop throughout. No generated chat text, captions, title cards, emojis, text-only frames, freeze frames, or repeated actions.",
      workflow: "generated",
      duration_seconds: 20,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("keeps optional dialogue inside a generated skit instead of routing to standalone voice generation", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "Create a 20-second vertical natural comedy skit about a group project. Three consistent college students begin at the same table, then reveal that only one student is doing the work. Use natural room sound, light comic music, and one coherent dialogue or narrator voice only if needed. Hard cuts only, no captions, title cards, or repeated beats.",
      workflow: "generated",
      duration_seconds: 20,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("does not mistake physical cover or still-image vocabulary inside a video story for an image request", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "Create a 30-second vertical cinematic action video. The soldier takes cover beside a tank, launches one missile, and the aircraft explode. Use realistic cinematic style and no narration.",
      workflow: "generated",
      duration_seconds: 30,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("keeps colorful generated animation prompts in the video pipeline", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "Create a 30-second vertical colorful 2D children's animation about a monkey riding a bicycle and helping an elephant and giraffe.",
      workflow: "generated",
      duration_seconds: 30,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("asks useful brief-completion questions for vague UGC ads", () => {
    const result = classifyMagicHourRequest({ prompt: "make a UGC ad", workflow: "generated" });

    expect(result.needs_clarification).toBe(true);
    expect(result.questions.join(" ")).toContain("How long");
    expect(result.questions.join(" ")).toContain("product or service");
  });

  it("asks for source topic before vague YouTube/source-clip assembly", () => {
    const result = classifyMagicHourRequest({ prompt: "make a YouTube clips video", workflow: "generated" });

    expect(result.needs_clarification).toBe(true);
    expect(result.questions.join(" ")).toContain("topic or angle");
  });

  it("routes clear uploaded image animation to image-to-video without product-ad clarification", () => {
    const result = classifyMagicHourRequest({
      prompt: "animate my uploaded product photo product.png into an 8 second slow push-in video",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.capability_id).toBe("image_to_video");
  });

  it("routes clear talking-photo prompts without asking for product context", () => {
    const result = classifyMagicHourRequest({
      prompt: "make this uploaded portrait founder.png say \"I finally found a lamp that does not destroy my eyes\" in a 10 second talking video",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.capability_id).toBe("talking_photo");
  });

  it("treats benchmark reference assets as supplied source context", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "make a 35 second founder-style video for a scheduling app called CalNest. use the founder photo as the opening talking shot. the founder should say: \"I built CalNest because scheduling should not feel like a second job.\"\n\nReference assets available for this standardized test: calnest_founder_portrait (portrait_reference).",
      workflow: "generated",
      duration_seconds: 35,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.capability_id).toBe("talking_photo");
  });

  it("does not ask product-context questions for clear local business reels", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "make a 45 second Instagram Reel for a neighborhood coffee shop called Northstar Coffee. make it feel warm and local: opening the shop in the morning, grinding beans, pouring a latte, regulars coming in, and a simple invite at the end.",
      workflow: "generated",
      duration_seconds: 45,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("routes planned Magic Hour tools to their specific wrapper bucket", () => {
    expect(classifyMagicHourRequest({
      prompt: "lip sync my uploaded video demo.mp4 to this new audio file voice.wav from 0 to 12 seconds",
      workflow: "generated",
    }).capability_id).toBe("lip_sync");
    expect(classifyMagicHourRequest({
      prompt: "make a looping GIF of a happy coffee cup dancing",
      workflow: "generated",
    }).capability_id).toBe("social_asset_tools");
    expect(classifyMagicHourRequest({
      prompt: "generate an expressive young creator voice saying \"I did not expect this to work so well\"",
      workflow: "generated",
    }).capability_id).toBe("voice_tools");
  });

  it("asks for missing inputs before short planned-tool prompts can run", () => {
    const cases = [
      ["make this uploaded portrait talk", "line"],
      ["make my uploaded selfie speak", "line"],
      ["make this headshot say something", "line"],
      ["restyle my uploaded video", "style"],
      ["put the face onto this", "reference"],
      ["head swap this", "reference"],
      ["detect faces", "source"],
      ["change clothes", "image"],
      ["combine my images", "composition"],
      ["replace the voiceover", "voiceover"],
      ["compile real clips", "topic"],
      ["make my reference photo move", "long"],
      ["make this illustration animated", "long"],
      ["sync the lips to audio", "source"],
      ["enhance this photo", "image"],
      ["make a narrator voice", "script"],
    ] as const;

    for (const [prompt, expectedQuestionText] of cases) {
      const result = classifyMagicHourRequest({ prompt, workflow: "generated" });

      expect(result.needs_clarification, prompt).toBe(true);
      expect(result.questions.join(" ").toLowerCase(), prompt).toContain(expectedQuestionText);
    }
  });

  it("blocks hard ambiguous prompts before runtime preflight or provider calls", () => {
    const cases = [
      ["pull source clips for a motivational short", "topic"],
      ["make a YouTube clip video and add captions", "topic"],
      ["make this portrait say the hook", "exact line"],
      ["make this headshot say \"I fixed my desk setup\" and add subtitles", "source video"],
      ["sync the lips in this clip to my script", "speech audio or script"],
      ["lip sync my attached video so it says something better", "speech audio or script"],
      ["lip-sync this video with the audio I upload later", "speech audio or script"],
      ["turn this into a meme about burnout", "source media"],
      ["swap the face from image one onto image two", "reference identity"],
    ] as const;

    for (const [prompt, expectedQuestionText] of cases) {
      const result = classifyMagicHourRequest({ prompt, workflow: "generated" });

      expect(result.needs_clarification, prompt).toBe(true);
      expect(result.questions.join(" ").toLowerCase(), prompt).toContain(expectedQuestionText);
    }
  });

  it("asks sharper questions for difficult-but-fixable ambiguous production prompts", () => {
    const cases = [
      ["create a thumbnail, a GIF, and a reel", "video asset"],
      ["create a polished reel for my app", "product, or service"],
      ["make a founder video with a strong hook", "product, company, or topic"],
      ["make the person in this photo explain the product", "exact line"],
      ["make a visualizer from my voice memo", "audio file"],
      ["combine the bottle photo with the creator selfie into one first frame", "uploaded images"],
      ["make this clip look like an iPhone ad", "source video or clip"],
    ] as const;

    for (const [prompt, expectedQuestionText] of cases) {
      const result = classifyMagicHourRequest({ prompt, workflow: "generated" });

      expect(result.needs_clarification, prompt).toBe(true);
      expect(result.questions.join(" ").toLowerCase(), prompt).toContain(expectedQuestionText);
    }
  });

  it("asks image-native questions for underspecified image assets", () => {
    const cases = ["design an album cover", "create a product mockup"] as const;

    for (const prompt of cases) {
      const result = classifyMagicHourRequest({ prompt, workflow: "generated" });
      const questions = result.questions.join(" ").toLowerCase();

      expect(result.needs_clarification, prompt).toBe(true);
      expect(questions, prompt).toMatch(/show|image|visual|product/);
      expect(questions, prompt).not.toContain("video prove");
    }
  });

  it("keeps captions on a new generated video in the video pipeline", () => {
    const result = classifyMagicHourRequest({
      prompt: "make a 30 second video with captions for AeroBottle",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("keeps generated ad captions in the video pipeline even when reference assets are mentioned", () => {
    const result = classifyMagicHourRequest({
      prompt:
        "can you make a 45 second tiktok style ad for AeroBottle? include product closeups, captions, and a strong ending. Reference assets are available but this API run cannot attach binaries directly.",
      workflow: "generated",
      duration_seconds: 45,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("does not treat uploaded product-image references plus requested captions as subtitle edits", () => {
    const result = classifyMagicHourRequest({
      prompt: "make a 45 second tiktok ad with captions using my uploaded product image as reference",
      workflow: "generated",
      duration_seconds: 45,
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("video");
    expect(result.capability_id).toBe("multi_scene_video");
  });

  it("routes caption requests on existing media to the subtitle capability", () => {
    const result = classifyMagicHourRequest({
      prompt: "add captions to my uploaded video demo.mp4",
      workflow: "generated",
    });

    expect(result.needs_clarification).toBe(false);
    expect(result.intent).toBe("edit");
    expect(result.capability_id).toBe("auto_subtitles");
  });

  it("asks clarification for prompts that do not specify output type or subject", () => {
    const result = classifyMagicHourRequest({ prompt: "make something", workflow: "generated" });

    expect(result.needs_clarification).toBe(true);
    expect(result.intent).toBe("clarification");
    expect(result.questions.join(" ")).toContain("image, a video, or an edit");
  });

  it("keeps the SDK catalog visible without pretending every wrapper is implemented", () => {
    const implemented = MAGIC_HOUR_CAPABILITIES.filter((item) => item.status === "implemented").map((item) => item.id);
    const planned = MAGIC_HOUR_CAPABILITIES.filter((item) => item.status === "planned").map((item) => item.id);

    expect(implemented).toContain("standalone_image");
    expect(implemented).toContain("multi_scene_video");
    expect(planned).toContain("lip_sync");
    expect(planned).toContain("video_to_video");
    expect(planned).toContain("auto_subtitles");
  });

  it("injects routing and missing-input guidance into the generation brief", () => {
    const request = CreateProjectRequestSchema.parse({ prompt: "make something" });
    const brief = magicHourCapabilityBrief(request);

    expect(brief).toContain("Clarification required");
    expect(brief).toContain("Directly callable now");
    expect(brief).toContain("SDK-backed tools to wrap");
  });
});
