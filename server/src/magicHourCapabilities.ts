import type { CreateProjectRequest } from "./schemas.js";
import { analyzeClarificationSlots, stripNegatedEditFeatures } from "./clarificationSlots.js";

export type MagicHourCapabilityStatus = "implemented" | "planned";
export type MagicHourOutputKind = "clarification" | "image" | "video" | "audio" | "edit";

export interface MagicHourCapability {
  id: string;
  sdk_resource: string;
  output: MagicHourOutputKind;
  status: MagicHourCapabilityStatus;
  needs: string[];
  use_when: string;
}

export const MAGIC_HOUR_CAPABILITIES: MagicHourCapability[] = [
  {
    id: "standalone_image",
    sdk_resource: "v1.aiImageGenerator",
    output: "image",
    status: "implemented",
    needs: ["visual subject or concept"],
    use_when: "The user asks for an image, picture, still, poster, art, product mockup, or photo.",
  },
  {
    id: "multi_scene_video",
    sdk_resource: "v1.aiImageGenerator + v1.imageToVideo + v1.aiTalkingPhoto",
    output: "video",
    status: "implemented",
    needs: ["video subject", "desired runtime or agent-inferred runtime", "visual goal"],
    use_when: "The user asks for a generated video, ad, reel, TikTok, commercial, or multi-scene story.",
  },
  {
    id: "youtube_clips",
    sdk_resource: "YouTube Data API + local ffmpeg pipeline",
    output: "video",
    status: "implemented",
    needs: ["source-clip topic", "script angle"],
    use_when: "The user wants a video assembled from real YouTube/source clips.",
  },
  {
    id: "image_edit_or_reference_composition",
    sdk_resource: "v1.aiImageEditor",
    output: "image",
    status: "planned",
    needs: ["one or more input images", "edit/composition instruction"],
    use_when: "The user drops product/person/reference images and wants them combined, edited, or prepared as video keyframes.",
  },
  {
    id: "image_to_video",
    sdk_resource: "v1.imageToVideo",
    output: "video",
    status: "implemented",
    needs: ["input/keyframe image", "motion prompt", "duration"],
    use_when: "A still/reference frame exists and needs to become a moving clip.",
  },
  {
    id: "text_to_video",
    sdk_resource: "v1.textToVideo",
    output: "video",
    status: "planned",
    needs: ["video prompt", "aspect ratio", "duration"],
    use_when: "The user explicitly asks for native text-to-video instead of our higher-control image-to-video path.",
  },
  {
    id: "talking_photo",
    sdk_resource: "v1.aiTalkingPhoto",
    output: "video",
    status: "implemented",
    needs: ["portrait/keyframe image", "speech audio"],
    use_when: "A still person should speak a generated or supplied line.",
  },
  {
    id: "lip_sync",
    sdk_resource: "v1.lipSync",
    output: "video",
    status: "planned",
    needs: ["source video", "speech audio", "time range"],
    use_when: "The user supplies video of a person and wants mouth motion synced to audio.",
  },
  {
    id: "video_to_video",
    sdk_resource: "v1.videoToVideo",
    output: "video",
    status: "planned",
    needs: ["source video", "style/prompt", "time range"],
    use_when: "The user supplies a video and asks to restyle, transform, or regenerate it.",
  },
  {
    id: "auto_subtitles",
    sdk_resource: "v1.autoSubtitleGenerator",
    output: "video",
    status: "planned",
    needs: ["source video", "subtitle style"],
    use_when: "The user asks for captions/subtitles on an existing or generated video.",
  },
  {
    id: "audio_to_video",
    sdk_resource: "v1.audioToVideo",
    output: "video",
    status: "planned",
    needs: ["audio file", "optional reference image", "duration/time range"],
    use_when: "The user supplies or asks for audio-driven video generation.",
  },
  {
    id: "animation",
    sdk_resource: "v1.animation",
    output: "video",
    status: "planned",
    needs: ["source image", "animation style", "duration"],
    use_when: "The user wants to animate a drawing/photo in a stylized way.",
  },
  {
    id: "face_body_tools",
    sdk_resource: "v1.faceSwap, v1.faceSwapPhoto, v1.bodySwap, v1.headSwap, v1.faceDetection, v1.aiFaceEditor",
    output: "edit",
    status: "planned",
    needs: ["source media", "identity/reference media", "explicit transformation instruction"],
    use_when: "The user asks for face swap, head/body swap, face detection, or face editing.",
  },
  {
    id: "image_utility_tools",
    sdk_resource: "v1.aiImageUpscaler, v1.imageBackgroundRemover, v1.photoColorizer, v1.aiHeadshotGenerator, v1.aiClothesChanger",
    output: "image",
    status: "planned",
    needs: ["input image", "desired utility operation"],
    use_when: "The user asks to upscale, remove background, colorize, make headshots, or change clothes.",
  },
  {
    id: "social_asset_tools",
    sdk_resource: "v1.aiGifGenerator, v1.aiMemeGenerator, v1.aiQrCodeGenerator",
    output: "image",
    status: "planned",
    needs: ["asset concept", "style/template details"],
    use_when: "The user asks for GIFs, memes, or QR-code art.",
  },
  {
    id: "voice_tools",
    sdk_resource: "v1.aiVoiceGenerator, v1.aiVoiceCloner",
    output: "audio",
    status: "planned",
    needs: ["voice prompt or source voice", "script"],
    use_when: "The user asks to generate or clone a voice through Magic Hour native audio tools.",
  },
];

const IMAGE_ONLY = /\b(image|picture|photo|poster|thumbnail|still|wallpaper|mockup|logo|artwork|illustration|album cover|cover art)\b/i;
const VIDEO = /\b(video|reel|tiktok|short|commercial|ad|ugc|clip|scene|skit|film|filming|talking|talk|creator|testimonial|b-roll|demo|hook|cta|animate|animation|trailer|story|explainer|podcast moments?|podcast clips?|montage)\b/i;
const IMPLIED_HUMAN_VIDEO =
  /\b(?:make|create|generate).*\b(?:guy|girl|person|someone|creator|founder)\b.*\b(?:work|apartment|realize|react|talk|film|filming|uses?|opens?|shows?)\b/i;
const SOURCE_CLIP =
  /\b(youtube|source clips?|real clips?|real footage|news footage|existing footage|pull clips?|find clips?|creator clips?|real interviews|clip compilation|montage from .*clips?|podcast (?:clips?|moments?)|news and creator footage)\b/i;
const EDIT_MEDIA = /\b(edit|replace|swap|upscale|remove background|colorize|lip[- ]?sync|face|body|head|clothes|voiceover)\b/i;
const CAPTION_REQUEST = /\b(captions?|subtitles?)\b/i;
const EXISTING_MEDIA_REFERENCE = /\b(uploaded|attached|dropped|existing|source|input|this|my|generated)\s+(?:image|photo|video|clip|media|file|talking photo)\b/i;
const VAGUE_CREATE = /^\s*(make|create|generate|produce|build|do)\s+(it|something|content|a\s+thing|an?\s*(image|video)?)?\s*$/i;
const DURATION = /\b(\d+\s*[- ]?\s*(?:s|sec|second|seconds|min|minute|minutes)|about a minute|one minute|short|long|quick)\b/i;
const EXPLICIT_DURATION = /\b(\d+\s*[- ]?\s*(?:s|sec|second|seconds|min|minute|minutes)|about a minute|one minute)\b/i;
const EXPLICIT_VIDEO_OUTPUT_REQUEST =
  /\b(?:make|create|generate|produce|need|want)\b(?:\s+\w+){0,8}\s+\b(?:video|reel|tiktok|short|commercial|ad|ugc|film|trailer|story|explainer)\b/i;
const EXPLICIT_IMAGE_OUTPUT_REQUEST =
  /\b(?:make|create|generate|produce|need|want)\b(?:\s+\w+){0,5}\s+\b(?:image|picture|photo|poster|thumbnail|still|wallpaper|mockup|logo|artwork|illustration|album cover|cover art|cover)\b/i;
const UPLOADED_OR_REFERENCED = /\b(uploaded|attached|dropped|existing|source|input|this|my|reference)\b/i;
const EXPLICIT_SOURCE_REFERENCE = /\b(uploaded|attached|dropped|existing|source|input|reference|file)\b/i;
const IMAGE_MEDIA = /\b(image|photo|picture|portrait|drawing|sketch|storyboard|comic|sticker|line art|avatar|cartoon|illustration|selfie|headshot|logo|still frame|still|keyframe)\b/i;
const VIDEO_MEDIA = /\b(video|clip|footage)\b/i;
const AUDIO_MEDIA = /\b(audio|voice|voice memo|podcast|sound|song|track|narration|spoken track|recording|mp3|wav)\b/i;
const QUOTED_OR_SPEECH = /["“”'][^"“”'\n]{4,}["“”']|\b(say|says|saying|script|dialogue|line|voiceover|audio)\b/i;
const EXACT_QUOTED_SPEECH = /["“”'][^"“”'\n]{4,}["“”']/;
const GENERIC_SPEECH_REFERENCE =
  /\b(?:say|says|saying|read|reads|reading)\s+(?:something|the hook|my script|the script|the line|a line|something better|whatever|it)\b/i;
const MULTI_OUTPUT_REQUEST =
  /(?:\b(?:poster|thumbnail|image|photo|gif|meme|qr code)\b.*\b(?:video|reel|tiktok|short|clip|animated version)\b)|(?:\b(?:video|reel|tiktok|short|clip|animated version)\b.*\b(?:poster|thumbnail|image|photo|gif|meme|qr code|static)\b)/i;

export function capabilityById(id: string | null): MagicHourCapability | null {
  if (!id) return null;
  return MAGIC_HOUR_CAPABILITIES.find((item) => item.id === id) ?? null;
}

export function unsupportedPlannedCapability(id: string | null): MagicHourCapability | null {
  const capability = capabilityById(id);
  return capability?.status === "planned" ? capability : null;
}

function intentForCapability(id: string): MagicHourOutputKind {
  if (
    [
      "auto_subtitles",
      "lip_sync",
      "video_to_video",
      "face_body_tools",
      "image_utility_tools",
      "image_edit_or_reference_composition",
    ].includes(id)
  ) {
    return "edit";
  }
  return capabilityById(id)?.output ?? "edit";
}

function specificCapabilityId(prompt: string): string | null {
  const asksVideoOutput =
    /\b(video|reel|tiktok|short|commercial|ad|ugc|clip|scene|skit|film|filming|b-roll|demo|animate|animation|trailer|story|explainer)\b/i.test(prompt) ||
    SOURCE_CLIP.test(prompt);
  const asksReferenceGuidedGeneratedVideo =
    asksVideoOutput &&
    /\b(make|create|generate|produce)\b/i.test(prompt) &&
    /\b(ad|commercial|ugc|tiktok|reel|product video|story|explainer)\b/i.test(prompt) &&
    /\b(reference|product image|uploaded product|input image|attached product)\b/i.test(prompt);
  if (
    CAPTION_REQUEST.test(prompt) &&
    (
      EXISTING_MEDIA_REFERENCE.test(prompt) ||
      (!asksVideoOutput && (/\b(this|my|uploaded|attached|existing|generated|source|input|voiceover)\b/i.test(prompt) || /^(?:add\s+)?(?:caption|subtitle)|\bcaption the voiceover\b/i.test(prompt)))
    )
  ) return "auto_subtitles";
  if (/\b(native\s+)?text[- ]?to[- ]?video\b/i.test(prompt)) return "text_to_video";
  if (/\blip[- ]?sync\b|\bsync (?:the )?(?:lips?|face)\b|\bmouth match (?:the )?voice\b|\breplace (?:the )?(?:talking|dialogue) in\b|\bvideo say\b|\bperson in the video say\b/i.test(prompt)) return "lip_sync";
  if (/\b(audio[- ]?to[- ]?video|from audio|audio file|podcast audio|voice memo|visualizer|turn this podcast|audio-driven|this audio|the track|interview audio|from the song|for the song|narration into b-roll|spoken track)\b/i.test(prompt)) return "audio_to_video";
  if (/\b(face[- ]?swap|swap the face|put .*face|face detection|detect (?:all )?faces|face editor|edit the face|make the face|headshot .*expressive|body[- ]?swap|head[- ]?swap)\b/i.test(prompt)) {
    return "face_body_tools";
  }
  if (/\bidentity\b/i.test(prompt) && /\b(ad|scene|person|model|reference|uploaded)\b/i.test(prompt)) return "face_body_tools";
  if (/\b(talking photo|(?:portrait|person|selfie|headshot|photo|image|face) .*(?:say|talk|speak|explain|narrate)|make .*(?:portrait|person|selfie|headshot|photo|image|face) .*(?:say|talk|speak|explain|narrate))\b/i.test(prompt)) return "talking_photo";
  if (
    /\b(upscale|enhance|remove (?:the )?background|background remover|colorize|colorful|sharper|high resolution|fix .*lighting|headshots?|clothes changer|change (?:the )?(?:clothes|outfit)|ready for ecommerce)\b/i.test(prompt) &&
    (!asksVideoOutput || EXISTING_MEDIA_REFERENCE.test(prompt) || EXPLICIT_IMAGE_OUTPUT_REQUEST.test(prompt))
  ) {
    return "image_utility_tools";
  }
  if (/\b(gif|meme|qr(?: code| art)?\b)\b/i.test(prompt)) return "social_asset_tools";
  if (
    /\b(generate .*voice|make .*voice|narrator voice|voice generator|clone .*voice|voice clone|voice cloner|voiceover|generate audio|(?:hook|line|narration) sound)\b/i.test(prompt) &&
    !/\breplace (?:the )?voiceover\b/i.test(prompt) &&
    !asksVideoOutput
  ) return "voice_tools";
  if (/\b(video[- ]?to[- ]?video|restyle|transform|make .*clip .*look|style .*uploaded .*(?:video|clip))\b/i.test(prompt) && VIDEO_MEDIA.test(prompt)) {
    return "video_to_video";
  }
  if (!asksReferenceGuidedGeneratedVideo && /\b(combine|compose|merge|reference composition|first frame|two images|these images|video keyframe)\b/i.test(prompt) && /\b(uploaded|reference|product and creator|bottle photo|creator selfie|images?|photo|keyframe)\b/i.test(prompt)) {
    return "image_edit_or_reference_composition";
  }
  if (/\b(?:illustrated|illustration|drawing|cartoon|logo).*\b(?:move|animated|animate|short clip|come alive|pop)\b/i.test(prompt)) return "animation";
  if (
    !asksReferenceGuidedGeneratedVideo &&
    (
      (/\b(?:animate|animated|move|breathe|shimmer|b-roll|cinematic reveal|looping intro)\b/i.test(prompt) && IMAGE_MEDIA.test(prompt) && UPLOADED_OR_REFERENCED.test(prompt)) ||
      /\b(?:turn|make).*(?:this|my|the).*(?:image|still frame|still|keyframe).*(?:into|as|a|move|b-roll|reveal|intro|clip)\b/i.test(prompt) ||
      /\bmotion clip from my file\b/i.test(prompt)
    )
  ) {
    return /\b(cartoon|drawing|illustration|stylized)\b/i.test(prompt) ? "animation" : "image_to_video";
  }
  return null;
}

function hasExplicitDuration(prompt: string, request?: Partial<Pick<CreateProjectRequest, "duration_seconds">>): boolean {
  return Boolean(request?.duration_seconds || EXPLICIT_DURATION.test(prompt));
}

function hasExplicitSource(prompt: string): boolean {
  return (
    /\bhttps?:\/\/|\bwww\.|\b[a-z0-9_-]+\.(?:png|jpe?g|webp|gif|mp4|mov|mp3|wav)\b/i.test(prompt) ||
    /\b(?:uploaded|attached|dropped|existing|source|input|reference)\s+(?:id|url|file|assets?)\b/i.test(prompt)
  );
}

function hasProvidedSpeechInput(prompt: string): boolean {
  return (
    EXACT_QUOTED_SPEECH.test(prompt) ||
    /\b(?:uploaded|attached|source|input|reference)\s+(?:audio|voice memo|mp3|wav|speech audio|script)\b/i.test(prompt) ||
    /\b(?:new|provided|supplied)\s+audio file\b/i.test(prompt)
  );
}

function hasUsefulSourceClipTopic(prompt: string): boolean {
  if (/\b(?:this story|motivational short|clip video|people reacting)\b/i.test(prompt)) return false;
  return /\b(?:about|of|on)\s+[a-z0-9][a-z0-9 -]{2,}\b/i.test(prompt) || /\bfrom\s+(?:tech interviews|interviews|podcasts|news|web)\b/i.test(prompt);
}

function capabilityClarificationQuestions(
  id: string,
  prompt: string,
  request?: Partial<Pick<CreateProjectRequest, "duration_seconds">>,
): string[] {
  const questions: string[] = [];
  const hasSource = hasExplicitSource(prompt);
  if (["image_to_video", "animation"].includes(id)) {
    if (!hasSource || !IMAGE_MEDIA.test(prompt)) questions.push("Which image or keyframe should I animate?");
    if (!hasExplicitDuration(prompt, request)) questions.push("How long should the animated clip be?");
    if (!/\b(push[- ]?in|pan|tilt|zoom|wave|motion|move|spin|float|animate|waving)\b/i.test(prompt)) {
      questions.push("What motion should the image have?");
    }
  } else if (id === "talking_photo") {
    if (!hasSource || !/\b(portrait|person|selfie|headshot|photo|image)\b/i.test(prompt)) questions.push("Which portrait or person image should speak?");
    if (!EXACT_QUOTED_SPEECH.test(prompt) || GENERIC_SPEECH_REFERENCE.test(prompt)) questions.push("What exact line should the person say?");
  } else if (id === "text_to_video") {
    if (!/\b(of|for|about|showing|with|featuring|shot of)\b/i.test(prompt)) questions.push("What should the text-to-video clip show?");
    if (!hasExplicitDuration(prompt, request)) questions.push("How long should the text-to-video clip be?");
  } else if (id === "lip_sync") {
    if (!VIDEO_MEDIA.test(prompt) || !hasSource) questions.push("Which source video should be lip-synced?");
    if (!hasProvidedSpeechInput(prompt) || GENERIC_SPEECH_REFERENCE.test(prompt) || /\bupload later\b/i.test(prompt)) {
      questions.push("What speech audio or script should drive the lip sync?");
    }
  } else if (id === "video_to_video") {
    if (!VIDEO_MEDIA.test(prompt) || !hasSource) questions.push("Which source video or clip should be transformed?");
    if (!/\b(cinematic|warm|film|anime|realistic|claymation|cartoon|noir|documentary|ugc|glossy|handheld|retro|futuristic|black and white|color grade|make it look like)\b/i.test(prompt)) {
      questions.push("What visual style or transformation should be applied?");
    }
  } else if (id === "auto_subtitles") {
    if (!VIDEO_MEDIA.test(prompt) || !hasSource) questions.push("Which source video should receive captions?");
  } else if (id === "audio_to_video") {
    if (!AUDIO_MEDIA.test(prompt) || !hasSource) questions.push("Which audio file should drive the video?");
    if (!hasExplicitDuration(prompt, request)) questions.push("How long should the audio-driven video be?");
    if (!/\b(visual|abstract|reference image|style|vertical|horizontal)\b/i.test(prompt)) questions.push("What should the visuals look like?");
  } else if (id === "face_body_tools") {
    if (/\b(face detection|detect (?:all )?faces)\b/i.test(prompt)) {
      if (!hasSource) questions.push("Which source media should I inspect for faces?");
    } else if (
      !hasSource ||
      !/\b(reference|identity|from|with my|with the|person|portrait|headshot|face photo|head photo|body photo)\b/i.test(prompt)
    ) {
      questions.push("Which source media and reference identity should I use?");
    }
  } else if (id === "image_utility_tools") {
    if (!hasSource) questions.push("Which image should I edit?");
  } else if (id === "social_asset_tools") {
    if (/\bqr(?: code| art)?\b/i.test(prompt) && !/\bhttps?:\/\/|\bwww\./i.test(prompt)) questions.push("What URL should the QR code open?");
    if (/\b(this|my|funniest moment|best part|reaction|(?:the|this|my|final)\s+(?:clip|scene)|out of the clip)\b/i.test(prompt) && !hasSource) {
      questions.push("Which image, video, or source media should I use for the social asset?");
    }
    if (/\bgif\b/i.test(prompt) && CAPTION_REQUEST.test(prompt)) questions.push("What caption text or source media should the GIF use?");
    if (/\bmeme\b/i.test(prompt) && /\b(pain point|product|this|it)\b/i.test(prompt)) questions.push("What should the meme be about?");
    if (!/\b(of|for|about|with)\b/i.test(prompt) && !/\bhttps?:\/\//i.test(prompt)) questions.push("What should the social asset be about?");
  } else if (id === "voice_tools") {
    if (/\bclone/i.test(prompt) && !hasSource) questions.push("Which voice sample should I clone?");
    if (!hasProvidedSpeechInput(prompt) || GENERIC_SPEECH_REFERENCE.test(prompt)) questions.push("What script should the voice say?");
  } else if (id === "image_edit_or_reference_composition") {
    if (!hasSource) questions.push("Which uploaded images should be edited or combined?");
    if (!/\b(combine .+ (?:into|with|as|for)|compose .+ (?:into|with|as|for)|first frame|reference .+ (?:for|as)|change .+ (?:to|into)|replace .+ (?:with|using))\b/i.test(prompt)) {
      questions.push("What edit or composition should I make?");
    }
  }
  return compactClarificationQuestions(questions);
}

function compactClarificationQuestions(questions: string[]): string[] {
  const unique = [...new Set(questions)];
  const hasSpecificContextQuestion = unique.some((question) =>
    /product or service|source clips cover|topic or angle/i.test(question),
  );
  return unique
    .filter((question) => !(hasSpecificContextQuestion && /generation show/i.test(question)))
    .slice(0, 3);
}

export function classifyMagicHourRequest(request: Pick<CreateProjectRequest, "prompt" | "workflow"> & Partial<Pick<CreateProjectRequest, "duration_seconds">>): {
  intent: MagicHourOutputKind;
  capability_id: string | null;
  needs_clarification: boolean;
  questions: string[];
} {
  const prompt = request.prompt.trim();
  const capabilityPrompt = stripNegatedEditFeatures(prompt);
  const lower = prompt.toLowerCase();
  const questions: string[] = [];
  const slotAnalysis = analyzeClarificationSlots({ ...request, prompt: capabilityPrompt });

  if (request.workflow === "youtube_clips" || SOURCE_CLIP.test(prompt)) {
    const sourceQuestions = [...slotAnalysis.questions];
    if (!hasExplicitDuration(prompt, request)) sourceQuestions.push("How long should the YouTube/source clips video be?");
    if (!hasUsefulSourceClipTopic(prompt)) sourceQuestions.push("What topic or angle should the YouTube/source clips cover?");
    if (sourceQuestions.length > 0) {
      return { intent: "clarification", capability_id: null, needs_clarification: true, questions: compactClarificationQuestions(sourceQuestions) };
    }
    return { intent: "video", capability_id: "youtube_clips", needs_clarification: false, questions };
  }

  if (
    MULTI_OUTPUT_REQUEST.test(prompt) &&
    !/\b(?:animate|animated|turn|make)\b.*\b(?:image|photo|picture|still)\b.*\b(?:into|as)\b.*\b(?:video|clip|reel)\b/i.test(prompt) &&
    !/\b(?:meme out of|gif from|gif reaction from)\b/i.test(prompt)
  ) {
    if (!/\b(of|for|about|showing|with|featuring)\b/i.test(lower)) questions.push("What product or visual subject should these assets show?");
    if (/\b(video|reel|tiktok|short|clip|animate)\b/i.test(prompt) && !hasExplicitDuration(prompt, request)) questions.push("How long should the video asset be?");
    if (questions.length > 0) {
      return { intent: "clarification", capability_id: null, needs_clarification: true, questions: compactClarificationQuestions(questions) };
    }
  }

  const specificCapability = specificCapabilityId(capabilityPrompt);
  if (specificCapability) {
    const capabilityQuestions = capabilityClarificationQuestions(specificCapability, capabilityPrompt, request);
    if (capabilityQuestions.length > 0) {
      return { intent: "clarification", capability_id: null, needs_clarification: true, questions: capabilityQuestions };
    }
    return {
      intent: intentForCapability(specificCapability),
      capability_id: specificCapability,
      needs_clarification: false,
      questions,
    };
  }

  const asksImage = IMAGE_ONLY.test(prompt);
  const explicitImageOutput = EXPLICIT_IMAGE_OUTPUT_REQUEST.test(prompt);
  const explicitVideoOutput = EXPLICIT_VIDEO_OUTPUT_REQUEST.test(prompt) && !explicitImageOutput;
  const imageDominant =
    explicitImageOutput ||
    (asksImage &&
      !explicitVideoOutput &&
      !VIDEO.test(prompt) &&
      !/\b(animate|animated|motion|image[- ]?to[- ]?video|video[- ]?to[- ]?video|reel|tiktok|short|commercial|ugc)\b/i.test(prompt));
  const asksVideo = !imageDominant && (VIDEO.test(prompt) || IMPLIED_HUMAN_VIDEO.test(prompt));
  const asksExistingCaptions = CAPTION_REQUEST.test(prompt) && EXISTING_MEDIA_REFERENCE.test(prompt) && !asksVideo;
  const asksEdit = EDIT_MEDIA.test(capabilityPrompt) || asksExistingCaptions;

  if (VAGUE_CREATE.test(prompt) || (!asksImage && !asksVideo && !asksEdit)) {
    questions.push("Do you want an image, a video, or an edit of uploaded media?");
  }
  if (asksVideo && /\bthing I uploaded\b/i.test(prompt)) {
    questions.push("What product, service, topic, or story should the uploaded thing become?");
  }
  if (asksVideo && /\b(founder|comparison)\b/i.test(prompt) && !/\b(about|for|called|named|versus|vs\.?|against)\b/i.test(prompt)) {
    questions.push("What product, company, or topic should the video be about?");
  }
  if (asksVideo && /\bmy app\b/i.test(prompt)) {
    questions.push("What app, product, or service is this for, and what main benefit should the video prove?");
  }
  if ((asksImage || asksVideo) && !/\b(of|for|about|showing|with|featuring)\b/i.test(lower) && prompt.split(/\s+/).length < 5) {
    questions.push("What should the generation show?");
  }
  if (asksImage && !asksVideo && !/\b(of|for|about|showing|featuring|called|named)\b/i.test(lower) && /\b(image|illustration|poster|thumbnail|photo|mockup|artwork|cover|logo)\b/i.test(prompt)) {
    questions.push("What visual subject should the image show?");
  }
  if (asksVideo && !asksEdit && !hasExplicitDuration(prompt, request) && !/\b(short|long|quick)\b/i.test(lower)) {
    questions.push("How long should the video be?");
  }
  for (const question of slotAnalysis.questions) {
    if (asksImage && !asksVideo && /product or service|main benefit should the video prove/i.test(question)) {
      if (!questions.includes("What product or visual subject should the image show?")) {
        questions.push("What product or visual subject should the image show?");
      }
      continue;
    }
    if (!questions.includes(question)) questions.push(question);
  }
  if (asksEdit && !questions.length && !EXISTING_MEDIA_REFERENCE.test(prompt)) {
    questions.push("Which uploaded media should I edit?");
  }
  if (/\breplace (?:the )?voiceover\b/i.test(prompt)) {
    questions.push("Which video should receive the new voiceover?");
    questions.push("What should the replacement voiceover say, or which audio should I use?");
  }

  if (questions.length > 0) {
    return { intent: "clarification", capability_id: null, needs_clarification: true, questions: compactClarificationQuestions(questions) };
  }
  if (asksExistingCaptions) {
    return { intent: "edit", capability_id: "auto_subtitles", needs_clarification: false, questions };
  }
  if (asksEdit) return { intent: "edit", capability_id: "image_edit_or_reference_composition", needs_clarification: false, questions };
  if (asksImage && !asksVideo) return { intent: "image", capability_id: "standalone_image", needs_clarification: false, questions };
  return { intent: "video", capability_id: "multi_scene_video", needs_clarification: false, questions };
}

export function magicHourCapabilityBrief(request: CreateProjectRequest): string {
  const routing = classifyMagicHourRequest(request);
  const implemented = MAGIC_HOUR_CAPABILITIES.filter((item) => item.status === "implemented");
  const planned = MAGIC_HOUR_CAPABILITIES.filter((item) => item.status === "planned");
  return [
    "Magic Hour capability routing:",
    `- Inferred request intent: ${routing.intent}${routing.capability_id ? ` (${routing.capability_id})` : ""}.`,
    routing.needs_clarification
      ? `- Clarification required before provider calls: ${routing.questions.join(" ")}`
      : "- Minimum prompt detail appears sufficient for the inferred output.",
    "- Directly callable now: " + implemented.map((item) => `${item.id} via ${item.sdk_resource}`).join("; ") + ".",
    "- SDK-backed tools to wrap with validation next: " + planned.map((item) => `${item.id} via ${item.sdk_resource}`).join("; ") + ".",
    "- Do not spend Magic Hour credits until the chosen capability has its required inputs.",
    "- If the user asks for a Magic Hour capability that is listed as planned, ask for the missing inputs and explain that this backend wrapper must be added before rendering that operation.",
  ].join("\n");
}
