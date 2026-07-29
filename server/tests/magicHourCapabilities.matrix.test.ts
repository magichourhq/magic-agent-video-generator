import { describe, expect, it } from "vitest";
import { capabilityById, classifyMagicHourRequest } from "../src/magicHourCapabilities.js";

const routedCases = [
  ["image cat", "make an image of a cat wearing sunglasses in a bright kitchen", "standalone_image"],
  ["image product mockup", "create a product mockup image for GlowBar desk lamp on a clean desk", "standalone_image"],
  ["image thumbnail", "make a thumbnail image for ClipPilot showing a creator at a laptop", "standalone_image"],
  ["image poster", "generate a poster for a neighborhood coffee shop called Northstar with a warm morning counter", "standalone_image"],
  ["image photo", "make a photo of a cozy study desk with warm lighting and notebooks", "standalone_image"],
  ["image illustration", "make an illustration of a tiny robot organizing video clips on a timeline", "standalone_image"],
  ["image logo", "create a logo image for AeroBottle with a minimalist water drop mark", "standalone_image"],
  ["image cover", "make cover art for a podcast about startup productivity with a bold desk setup", "standalone_image"],
  ["video water bottle", "make a 45 second TikTok ad for a smart water bottle called AeroBottle that reminds workers to drink", "multi_scene_video"],
  ["video lamp", "make a 50 second product video for a desk lamp called GlowBar showing bad lighting, brightness modes, charging, and a cozy reveal", "multi_scene_video"],
  ["video SaaS", "make a 60 second video for an AI video tool called ClipPilot showing messy editing becoming simple", "multi_scene_video"],
  ["video beverage", "make a 40 second cinematic commercial for Coca-Cola with friends sharing cold bottles at sunset", "multi_scene_video"],
  ["video founder", "make a 30 second founder story video for an app called CalNest about making scheduling less painful", "multi_scene_video"],
  ["video testimonial", "make a 35 second testimonial video for MiraSkin serum with a creator in a bathroom showing the morning result", "multi_scene_video"],
  ["video comparison", "make a 40 second comparison video for two study desk setups showing how GlowBar improves the workspace", "multi_scene_video"],
  ["video tutorial", "make a 30 second tutorial walkthrough video for an app called TaskLift showing someone creating a project", "multi_scene_video"],
  ["video local shop", "make a 45 second Instagram reel for Northstar Coffee showing opening, grinding beans, pouring a latte, and inviting regulars", "multi_scene_video"],
  ["video note app", "make a 25 second reel about a normal person using an AI note app called NoteNest during class", "multi_scene_video"],
  ["video package", "make a 20 second video of someone opening a package for a brand called PackMate and showing why it feels premium", "multi_scene_video"],
  ["video nonprofit", "make a 70 second explainer video for EcoShade nonprofit about planting trees that cool city blocks", "multi_scene_video"],
  ["youtube interviews", "make a 30 second YouTube clips video about funny startup founder interviews and quick lessons", "youtube_clips"],
  ["youtube climate", "make a 45 second source clips video about climate tech founder talks and clean energy demos", "youtube_clips"],
  ["youtube sports", "pull real footage clips for a 35 second video about Olympic training routines and recovery habits", "youtube_clips"],
  ["youtube podcasts", "make a 40 second montage from podcast moments about productivity systems and deep work", "youtube_clips"],
  ["i2v product", "animate my uploaded product photo product.png into an 8 second slow push-in video", "image_to_video"],
  ["i2v reference", "turn my reference image ref.jpg into a 6 second cinematic reveal with a slow zoom", "image_to_video"],
  ["i2v still", "make this uploaded still frame hero.png move as a 5 second b-roll clip with a gentle pan", "image_to_video"],
  ["i2v file", "make a motion clip from my image file bottle.png, 7 seconds, with a slow float and shimmer", "image_to_video"],
  ["talking founder", "make this uploaded portrait founder.png say \"I built CalNest because scheduling should not feel like a second job\"", "talking_photo"],
  ["talking selfie", "make this uploaded selfie creator.jpg speak \"This bottle actually got me drinking water before noon\"", "talking_photo"],
  ["talking explicit", "talking photo: use portrait.png and say \"Here is the one desk upgrade I wish I bought sooner\"", "talking_photo"],
  ["talking image", "make my uploaded person image speaker.jpg narrate \"The first version was messy, but this finally feels simple\"", "talking_photo"],
  ["native t2v", "native text-to-video clip of a red car driving through neon rain for 8 seconds", "text_to_video"],
  ["lip sync", "lip sync my uploaded video demo.mp4 to this new audio file voice.wav from 0 to 12 seconds", "lip_sync"],
  ["video restyle", "restyle my uploaded video demo.mp4 to look like warm cinematic film", "video_to_video"],
  ["captions", "add captions to my uploaded video demo.mp4", "auto_subtitles"],
  ["audio to video", "make a 20 second audio-to-video visual for my uploaded audio file track.mp3 with abstract ocean visuals", "audio_to_video"],
  ["animation", "animate my uploaded cartoon illustration art.png for 8 seconds with a waving motion", "animation"],
  ["face swap", "face swap source video demo.mp4 with reference identity portrait.png", "face_body_tools"],
  ["upscale", "upscale my uploaded image product.png to high resolution", "image_utility_tools"],
  ["gif", "make a looping GIF of a happy coffee cup dancing", "social_asset_tools"],
  ["voice", "generate an expressive young creator voice saying \"I did not expect this to work so well\"", "voice_tools"],
  ["composition", "combine uploaded product image bottle.png with creator selfie creator.jpg into one first frame", "image_edit_or_reference_composition"],
  ["face detection", "detect faces in my uploaded video crowd.mp4", "face_body_tools"],
  ["background", "remove background from my uploaded image product.png", "image_utility_tools"],
  ["qr", "make a QR code art for https://example.com with neon style", "social_asset_tools"],
  ["meme", "make a meme about startup burnout with a tired founder and coffee", "social_asset_tools"],
] as const;

const clarificationCases = [
  ["vague something", "make something", "image, a video, or an edit"],
  ["vague stuff", "make me stuff", "image, a video, or an edit"],
  ["ugc ad", "make a UGC ad", "how long"],
  ["my app", "create a polished reel for my app", "product, or service"],
  ["founder missing topic", "make a founder video with a strong hook", "product, company, or topic"],
  ["youtube vague", "make a YouTube clips video", "topic or angle"],
  ["source vague", "pull source clips for a motivational short", "topic"],
  ["youtube captions", "make a YouTube clip video and add captions", "topic"],
  ["compile clips", "compile real clips", "topic"],
  ["reference move", "make my reference photo move", "long"],
  ["portrait talk", "make this uploaded portrait talk", "line"],
  ["selfie speak", "make my uploaded selfie speak", "line"],
  ["headshot something", "make this headshot say something", "line"],
  ["talking no line", "talking photo of uploaded founder.png", "line"],
  ["lip sync no source", "sync the lips to audio", "source"],
  ["lip sync later", "lip-sync this video with audio I upload later", "speech audio"],
  ["restyle no style", "restyle my uploaded video", "style"],
  ["clip iphone", "make this clip look like an iPhone ad", "source video"],
  ["face onto this", "put face onto this", "reference"],
  ["head swap", "head swap this", "reference"],
  ["detect faces", "detect faces", "source"],
  ["change clothes", "change clothes", "image"],
  ["enhance photo", "enhance this photo", "image"],
  ["remove background", "remove background", "image"],
  ["upscale this", "upscale this", "image"],
  ["combine images", "combine my images", "uploaded images"],
  ["combine references", "combine the bottle photo with the creator selfie into one first frame", "uploaded images"],
  ["multi output", "create a thumbnail, a GIF, and a reel", "video asset"],
  ["mockup vague", "create a product mockup", "visual subject"],
  ["album vague", "design an album cover", "visual subject"],
  ["video vague", "make a video", "how long"],
  ["short ad", "make a short ad", "product"],
  ["image vague", "make an image", "generation show"],
  ["logo vague", "create a logo", "generation show"],
  ["animation vague", "create an animation", "generation show"],
  ["t2v vague", "native text-to-video 8 seconds", "show"],
  ["t2v no duration", "native text-to-video clip of a robot at a desk", "long"],
  ["audio voice memo", "make audio-to-video from my voice memo", "audio file"],
  ["visualizer", "make a visualizer from my voice memo", "audio file"],
  ["narrator voice", "generate a narrator voice", "script"],
  ["clone voice", "clone my voice", "voice sample"],
  ["replace voiceover", "replace the voiceover", "video"],
  ["gif captions", "make a GIF with captions", "caption"],
  ["qr vague", "make a QR code", "url"],
  ["meme this", "make a meme about this", "source media"],
  ["captions vague", "add captions", "source video"],
  ["subtitles generated", "add subtitles to generated video", "source video"],
  ["colorize", "colorize old photo", "image"],
  ["face detection this", "face detection on this", "source"],
  ["illustration animated", "make this illustration animated", "long"],
  ["meme from this", "turn this into a meme about burnout", "source media"],
  ["v2v no style", "video-to-video my uploaded clip", "style"],
  ["content vague", "make content", "image, a video, or an edit"],
] as const;

describe("Magic Hour 100-case capability matrix", () => {
  it("covers exactly 100 routing and clarification cases", () => {
    expect(routedCases.length + clarificationCases.length).toBe(100);
  });

  it.each(routedCases)("routes %s", (_name, prompt, expectedCapability) => {
    const result = classifyMagicHourRequest({ prompt, workflow: "generated" });
    expect(result.needs_clarification, prompt).toBe(false);
    expect(result.capability_id, prompt).toBe(expectedCapability);
    expect(capabilityById(result.capability_id), prompt).not.toBeNull();
  });

  it.each(clarificationCases)("asks before rendering %s", (_name, prompt, expectedQuestionText) => {
    const result = classifyMagicHourRequest({ prompt, workflow: "generated" });
    expect(result.needs_clarification, prompt).toBe(true);
    expect(result.capability_id, prompt).toBeNull();
    expect(result.questions.join(" ").toLowerCase(), prompt).toContain(expectedQuestionText.toLowerCase());
  });
});

