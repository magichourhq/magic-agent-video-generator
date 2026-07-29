import type { CreateProjectRequest } from "./schemas.js";

export interface ClarificationSlotAnalysis {
  questions: string[];
  missing_slots: string[];
  slots: {
    output_type: "image" | "video" | "edit" | "unknown";
    subject: "present" | "missing";
    duration: "present" | "missing" | "not_applicable";
    format: "ugc" | "product" | "youtube" | "edit" | "general";
    speech_mode: "quoted" | "creator_dialogue" | "voiceover" | "mostly_visual" | "unknown";
  };
}

const IMAGE = /\b(image|picture|photo|poster|thumbnail|still|wallpaper|mockup|logo|artwork|illustration|cover art|cover)\b/i;
const VIDEO = /\b(video|reel|tiktok|short|commercial|ad|ugc|clip|scene|skit|film|animate|animation|trailer|story|explainer|podcast moments?|podcast clips?|montage)\b/i;
const EDIT = /\b(edit|replace|swap|upscale|remove background|colorize|lip[- ]?sync|captions?|subtitles?|face|body|head|clothes)\b/i;
const YOUTUBE = /\b(youtube|source clips?|real clips?|real footage|news footage|existing footage|pull clips?|find clips?|creator clips?|real interviews|clip compilation|podcast moments?|podcast clips?)\b/i;
const UGC = /\b(ugc|tiktok|reel|shorts?|testimonial|normal person|creator|influencer|selfie|talking to camera)\b/i;
const PRODUCT =
  /\b(product|brand|ad|commercial|demo|launch|app|tool|software|bottle|lamp|serum|service|shop|store|cafe|coffee|restaurant|studio|clinic|nonprofit)\b/i;
const DURATION = /\b(\d+\s*[- ]?\s*(?:s|sec|second|seconds|min|minute|minutes)|short|long|quick|about a minute|one minute)\b/i;
const QUOTED = /["“”'][^"“”'\n]{4,}["“”']/;
const SPEECH = /\b(say|says|saying|dialogue|voiceover|narration|narrate|talk|speaking|script)\b/i;
const VISUAL_ONLY = /\b(show|include|feature|close[- ]?ups?|b[- ]?roll|camera|scene|shot|visual|reveal)\b/i;
const SUBJECT_LINK = /\b(of|for|about|showing|with|featuring|called|named)\b/i;
const PRODUCT_DETAIL =
  /\b(smart|ai|water bottle|desk lamp|skincare|serum|tool|software|app|charging|brightness|mode|remind|track|feature|benefit|problem|helps?|fix(?:es)?|use case|coffee shop|cafe|local|owner|regulars|invite|morning|latte|beans|brand|package|packaging|premium|bottles?|friends|commercial|volunteers|neighbors|nonprofit|planting|trees?|shade|support)\b/i;
const PROOF_DETAIL =
  /\b(smart|water bottle|desk lamp|close[- ]?up|demo|proof|feature|setting|before|after|result|charging|brightness|progress|workflow|remind|track|use|using|shows?|grinding|pouring|regulars|planting|shade|payoff)\b/i;
const NEGATED_EDIT_CLAUSE =
  /\b(?:no|without|avoid|never|disable(?:d)?|do not|don't|dont)\b[^.!?;\n]{0,160}/gi;
const NEGATED_EDIT_TERM = /\b(?:lip[- ]?sync(?:ing)?|captions?|subtitles?)\b/gi;

export function stripNegatedEditFeatures(prompt: string): string {
  return prompt.replace(NEGATED_EDIT_CLAUSE, (clause) => clause.replace(NEGATED_EDIT_TERM, " "));
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function compactWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function hasConcreteSubject(prompt: string): boolean {
  const words = compactWords(prompt).filter(
    (word) =>
      ![
        "make",
        "create",
        "generate",
        "produce",
        "build",
        "video",
        "image",
        "photo",
        "reel",
        "tiktok",
        "short",
        "ad",
        "ugc",
        "commercial",
        "clip",
        "something",
        "content",
      ].includes(word),
  );
  return SUBJECT_LINK.test(prompt) || words.length >= 3;
}

function outputTypeFor(request: Pick<CreateProjectRequest, "prompt" | "workflow">): ClarificationSlotAnalysis["slots"]["output_type"] {
  if (request.workflow === "youtube_clips") return "video";
  if (EDIT.test(request.prompt)) return "edit";
  const asksImage = IMAGE.test(request.prompt);
  const asksVideo = VIDEO.test(request.prompt) || YOUTUBE.test(request.prompt);
  if (asksImage && !/\b(animate|animated|motion|image[- ]?to[- ]?video|video[- ]?to[- ]?video|reel|tiktok|short|commercial|ugc)\b/i.test(request.prompt)) {
    return "image";
  }
  if (asksVideo) return "video";
  if (asksImage) return "image";
  return "unknown";
}

function formatFor(prompt: string, outputType: ClarificationSlotAnalysis["slots"]["output_type"]): ClarificationSlotAnalysis["slots"]["format"] {
  if (YOUTUBE.test(prompt)) return "youtube";
  if (outputType === "edit") return "edit";
  if (UGC.test(prompt)) return "ugc";
  if (PRODUCT.test(prompt)) return "product";
  return "general";
}

function speechModeFor(prompt: string, format: ClarificationSlotAnalysis["slots"]["format"]): ClarificationSlotAnalysis["slots"]["speech_mode"] {
  if (QUOTED.test(prompt)) return "quoted";
  if (format === "ugc") return "creator_dialogue";
  if (SPEECH.test(prompt)) return "voiceover";
  if (VISUAL_ONLY.test(prompt)) return "mostly_visual";
  return "unknown";
}

export function analyzeClarificationSlots(
  request: Pick<CreateProjectRequest, "prompt" | "workflow"> & Partial<Pick<CreateProjectRequest, "duration_seconds">>,
): ClarificationSlotAnalysis {
  const prompt = stripNegatedEditFeatures(request.prompt.trim());
  const outputType = outputTypeFor({ ...request, prompt });
  const format = formatFor(prompt, outputType);
  const subjectPresent = hasConcreteSubject(prompt);
  const durationPresent = outputType === "video" ? Boolean(request.duration_seconds || DURATION.test(prompt)) : true;
  const questions: string[] = [];
  const missing: string[] = [];

  if (outputType === "unknown") {
    missing.push("output_type");
    questions.push("Do you want an image, a video, or an edit of uploaded media?");
  }
  if (outputType !== "unknown" && !subjectPresent) {
    missing.push("subject");
    questions.push("What should the generation show or be about?");
  }
  if (outputType === "video" && !durationPresent) {
    missing.push("duration");
    questions.push("How long should the video be?");
  }
  if (format === "youtube" && !/\b(youtube|source clips?|real footage|news footage|existing footage)\s+(?:about|of|for|on)\b/i.test(prompt) && compactWords(prompt).length < 6) {
    missing.push("source_topic");
    questions.push("What topic or angle should the YouTube/source clips cover?");
  }
  if (outputType === "video" && (format === "ugc" || format === "product") && !PRODUCT_DETAIL.test(prompt)) {
    missing.push("product_context");
    questions.push("What product or service is this for, and what main benefit should the video prove?");
  } else if (outputType === "video" && (format === "ugc" || format === "product") && !PROOF_DETAIL.test(prompt) && compactWords(prompt).length < 8) {
    missing.push("proof_point");
    questions.push("What specific feature, proof point, or result should be visibly demonstrated?");
  }

  return {
    questions: unique(questions).slice(0, 3),
    missing_slots: unique(missing),
    slots: {
      output_type: outputType,
      subject: subjectPresent ? "present" : "missing",
      duration: outputType === "video" ? (durationPresent ? "present" : "missing") : "not_applicable",
      format,
      speech_mode: speechModeFor(prompt, format),
    },
  };
}
