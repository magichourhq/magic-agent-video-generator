import { describe, expect, it } from "vitest";
import {
  projectAgentForRequest,
  VIDEO_STUDIO_TOOLS,
  videoAgent,
  YOUTUBE_SHORT_TOOLS,
} from "../src/agents.js";
import { YOUTUBE_SCRIPT_SYSTEM_PROMPT } from "../src/prompts.js";
import { YOUTUBE_REVIEW_PROVIDERS_ACTIVE } from "../src/projects.js";
import { CreateProjectRequestSchema } from "../src/schemas.js";

const expectedVideoStudioTools = [
  "request_clarification",
  "generate_magic_hour_images",
  "draft_video_plan",
  "generate_voiceover",
  "generate_scene_images",
  "animate_scene_videos",
  "stitch_final_video",
  "inspect_render_status",
  "record_project_decision",
  "retry_scene",
  "regenerate_scene",
  "revise_narration",
  "replace_voiceover",
  "restitch_video",
  "inspect_timeline",
  "trim_clip",
  "move_clip",
  "set_final_hold",
  "restitch_timeline",
];

describe("CreateProjectRequestSchema", () => {
  it("defaults to generated workflow and Data API YouTube search", () => {
    const generated = CreateProjectRequestSchema.parse({ prompt: "make a video" });
    const youtube = CreateProjectRequestSchema.parse({
      prompt: "make a fast news short",
      workflow: "youtube_clips",
    });
    const ytdlp = CreateProjectRequestSchema.parse({
      prompt: "make a fast news short",
      workflow: "youtube_clips",
      youtube_search_provider: "yt_dlp",
    });

    expect(generated.workflow).toBe("generated");
    expect(generated.youtube_search_provider).toBe("youtube_data_api");
    expect(generated.youtube_allow_provider_fallback).toBe(false);
    expect(youtube.workflow).toBe("youtube_clips");
    expect(youtube.youtube_search_provider).toBe("youtube_data_api");
    expect(youtube.youtube_allow_provider_fallback).toBe(false);
    expect(ytdlp.youtube_search_provider).toBe("yt_dlp");
  });

  it("accepts disabled YouTube provider fallback explicitly", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "make a fast news short",
      workflow: "youtube_clips",
      youtube_search_provider: "yt_dlp",
      youtube_allow_provider_fallback: false,
    });

    expect(request.youtube_search_provider).toBe("yt_dlp");
    expect(request.youtube_allow_provider_fallback).toBe(false);
  });
});

describe("videoAgent tool surface", () => {
  it("exposes split deferred video studio tools plus hosted tool search", () => {
    const toolNames = new Set(videoAgent.tools.map((tool: any) => tool.name));

    for (const name of expectedVideoStudioTools) {
      expect(toolNames.has(name)).toBe(true);
    }
    expect(toolNames.has("execute_video_batch")).toBe(false);
    expect(toolNames.has("tool_search")).toBe(true);
    expect((videoAgent.modelSettings as any).reasoning.effort).toBe("low");

    for (const tool of VIDEO_STUDIO_TOOLS as any[]) {
      expect(expectedVideoStudioTools).toContain(tool.name);
      expect(tool.deferLoading).toBe(true);
      expect(tool.type).toBe("function");
    }
  });

  it("exposes only the prompt-based YouTube tool to the orchestrator", () => {
    const toolNames = new Set(videoAgent.tools.map((tool: any) => tool.name));

    expect(toolNames.has("create_youtube_short_from_prompt")).toBe(true);
    expect(toolNames.has("create_youtube_short")).toBe(false);
    expect(YOUTUBE_SHORT_TOOLS.map((tool: any) => tool.name)).toEqual(["create_youtube_short_from_prompt"]);
    expect((YOUTUBE_SHORT_TOOLS[0] as any).deferLoading).toBe(true);
  });

  it("uses a constrained first-render agent for new generated and YouTube workflows", () => {
    const generated = CreateProjectRequestSchema.parse({
      prompt: "make a video",
      agent_provider: "openrouter",
      runtime_credentials: { openrouter_api_key: "test-openrouter-key" },
    });
    const youtube = CreateProjectRequestSchema.parse({
      prompt: "make a YouTube clips video",
      workflow: "youtube_clips",
      agent_provider: "openrouter",
      runtime_credentials: { openrouter_api_key: "test-openrouter-key" },
    });

    const generatedTools = new Set(projectAgentForRequest(generated).tools.map((tool: any) => tool.name));
    const youtubeTools = new Set(projectAgentForRequest(youtube).tools.map((tool: any) => tool.name));

    expect(generatedTools.has("draft_video_plan")).toBe(true);
    expect(generatedTools.has("regenerate_scene")).toBe(false);
    expect(generatedTools.has("retry_scene")).toBe(false);
    expect(generatedTools.has("restitch_video")).toBe(false);
    expect(youtubeTools.has("create_youtube_short_from_prompt")).toBe(true);
    expect(youtubeTools.has("draft_video_plan")).toBe(false);
  });
});

describe("YouTube workflow guardrails", () => {
  it("keeps script search hints away from stock and watermark queries", () => {
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).not.toContain('append "stock"');
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).toContain("watermark");
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).toContain("genuine YouTube");
  });

  it("steers search hints away from intro/title/trailer/outro/subscribe clips", () => {
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).toContain("subscribe");
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).toContain("title sequence");
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).toMatch(/intro/i);
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).toMatch(/trailer/i);
    // the subscribe/intro guidance must be framed as terms to AVOID
    expect(YOUTUBE_SCRIPT_SYSTEM_PROMPT).toMatch(/avoid[^.]*subscribe/i);
  });

  it("keeps review batches targeted to the YouTube Data API provider", () => {
    expect(YOUTUBE_REVIEW_PROVIDERS_ACTIVE).toEqual(["youtube_data_api"]);
  });
});
