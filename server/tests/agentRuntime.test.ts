import { afterEach, describe, expect, it, vi } from "vitest";
import { projectAgentForRequest, youtubeScriptAgentForRequest } from "../src/agents.js";
import {
  cloneAgentForRuntime,
  DEFAULT_DEEPSEEK_V4_PRO_MAX_TOKENS,
  DEFAULT_OPENROUTER_MAX_TOKENS,
  fetchOpenRouterModels,
  resolveAgentRuntime,
} from "../src/agentRuntime.js";
import { userPreferencesForRequest } from "../src/projectContext.js";
import { CreateProjectRequestSchema } from "../src/schemas.js";
import { tokenOutputPayload } from "../src/usageCost.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function openRouterRequest(overrides = {}) {
  return CreateProjectRequestSchema.parse({
    prompt: "make a 30 second UGC product video",
    agent_provider: "openrouter",
    agent_model: "deepseek/deepseek-chat-v3.2",
    agent_intensity: "pro",
    runtime_credentials: { openrouter_api_key: "test-openrouter-key" },
    ...overrides,
  });
}

function openAiRequest(overrides = {}) {
  return CreateProjectRequestSchema.parse({
    prompt: "make a 30 second UGC product video",
    agent_provider: "openai",
    agent_model: "gpt-4o-mini",
    agent_intensity: "standard",
    runtime_credentials: { openai_api_key: "test-openai-key" },
    ...overrides,
  });
}

describe("agent runtime selection", () => {
  it("resolves OpenRouter request-level provider, model, intensity, and key presence", () => {
    const runtime = resolveAgentRuntime(openRouterRequest());

    expect(runtime.provider).toBe("openrouter");
    expect(runtime.model).toBe("deepseek/deepseek-chat-v3.2");
    expect(runtime.intensity).toBe("pro");
    expect(runtime.has_api_key).toBe(true);
  });

  it("uses a flat non-deferred tool surface for OpenRouter Chat Completions compatibility", () => {
    const agent = projectAgentForRequest(openRouterRequest());
    const tools = agent.tools as any[];
    const toolNames = new Set(tools.map((tool) => tool.name));

    expect(toolNames.has("draft_video_plan")).toBe(true);
    expect(toolNames.has("generate_scene_images")).toBe(true);
    expect(toolNames.has("tool_search")).toBe(false);
    expect(tools.every((tool) => tool.deferLoading !== true)).toBe(true);
    expect(tools.every((tool) => !tool.namespace)).toBe(true);
  });

  it("uses a flat first-render tool surface for OpenAI local generation runs", () => {
    const agent = projectAgentForRequest(openAiRequest());
    const tools = agent.tools as any[];
    const toolNames = new Set(tools.map((tool) => tool.name));

    expect(toolNames.has("draft_video_plan")).toBe(true);
    expect(toolNames.has("generate_scene_images")).toBe(true);
    expect(toolNames.has("tool_search")).toBe(false);
    expect(tools.every((tool) => tool.type !== "hosted_tool")).toBe(true);
    expect(tools.every((tool) => !tool.namespace)).toBe(true);
  });

  it("does not send reasoning controls to OpenAI models that do not support them", () => {
    const request = openAiRequest({ agent_model: "gpt-4o-mini" });
    const runtime = resolveAgentRuntime(request);
    const agent = cloneAgentForRuntime(projectAgentForRequest(request), runtime);

    expect((agent.modelSettings as any).reasoning).toBeUndefined();
    expect((agent.modelSettings as any).text).toBeUndefined();
  });

  it("uses a supported no-reasoning value for standard GPT-5 local runs", () => {
    const request = openAiRequest({ agent_model: "gpt-5.4", agent_intensity: "standard" });
    const runtime = resolveAgentRuntime(request);
    const agent = cloneAgentForRuntime(projectAgentForRequest(request), runtime);

    expect((agent.modelSettings as any).reasoning?.effort).toBe("none");
  });

  it("uses a flat YouTube workflow tool surface for OpenRouter YouTube projects", () => {
    const agent = projectAgentForRequest(openRouterRequest({ workflow: "youtube_clips" }));
    const tools = agent.tools as any[];
    const toolNames = new Set(tools.map((tool) => tool.name));

    expect(toolNames.has("create_youtube_short_from_prompt")).toBe(true);
    expect(toolNames.has("draft_video_plan")).toBe(false);
    expect(toolNames.has("tool_search")).toBe(false);
    expect(tools.every((tool) => tool.deferLoading !== true)).toBe(true);
  });

  it("disables hosted web search for OpenRouter YouTube script planning", () => {
    const agent = youtubeScriptAgentForRequest(openRouterRequest({ workflow: "youtube_clips" }));

    expect(agent.tools).toHaveLength(0);
    expect(agent.instructions).toContain("hosted WebSearchTool is not available");
  });

  it("does not persist transient runtime API keys into project preferences", () => {
    const safePreferences = userPreferencesForRequest(
      openRouterRequest({
        runtime_credentials: {
          openai_api_key: "test-openai-key",
          openrouter_api_key: "test-openrouter-key",
          magic_hour_api_key: "test-magic-hour-key",
          fish_audio_api_key: "test-fish-key",
          fish_audio_reference_id: "test-fish-reference",
        },
      }),
    );

    expect(safePreferences.openrouter_api_key).toBeUndefined();
    expect(safePreferences.runtime_credentials).toBeUndefined();
    expect(safePreferences.agent_provider).toBe("openrouter");
    expect(safePreferences.agent_model).toBe("deepseek/deepseek-chat-v3.2");
  });

  it("caps OpenRouter chat completion output tokens to avoid oversized credit reservations", () => {
    const request = openRouterRequest();
    const runtime = resolveAgentRuntime(request);
    const agent = cloneAgentForRuntime(projectAgentForRequest(request), runtime);

    expect((agent.modelSettings as any).maxTokens).toBe(DEFAULT_OPENROUTER_MAX_TOKENS);
  });

  it("gives DeepSeek V4 Pro enough room to finish reasoning and emit its tool call", () => {
    const request = openRouterRequest({ agent_model: "deepseek/deepseek-v4-pro" });
    const runtime = resolveAgentRuntime(request);
    const agent = cloneAgentForRuntime(projectAgentForRequest(request), runtime);

    expect((agent.modelSettings as any).maxTokens).toBe(DEFAULT_DEEPSEEK_V4_PRO_MAX_TOKENS);
  });

  it("retries one OpenRouter network interruption without replaying arbitrary failures", async () => {
    const request = openRouterRequest({ agent_model: "deepseek/deepseek-v4-pro" });
    const runtime = resolveAgentRuntime(request);
    const agent = cloneAgentForRuntime(projectAgentForRequest(request), runtime);
    const retry = (agent.modelSettings as any).retry;

    expect(retry.maxRetries).toBe(1);
    expect(await retry.policy({
      normalized: { isNetworkError: true },
    })).toBe(true);
    expect(await retry.policy({
      normalized: { isNetworkError: false, statusCode: 400 },
    })).toBe(false);
  });

  it("allows a bounded OpenRouter max token override", () => {
    vi.stubEnv("OPENROUTER_MAX_TOKENS", "20000");
    const request = openRouterRequest();
    const runtime = resolveAgentRuntime(request);
    const agent = cloneAgentForRuntime(projectAgentForRequest(request), runtime);

    expect((agent.modelSettings as any).maxTokens).toBe(16000);
  });
});

describe("agent usage cost accounting", () => {
  it("records unknown OpenRouter model usage without throwing or inventing pricing", () => {
    const payload = tokenOutputPayload(
      "project",
      "deepseek/deepseek-chat-v3.2",
      {
        requests: 1,
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokensDetails: {},
        outputTokensDetails: {},
        requestUsageEntries: [],
      } as any,
      "openrouter",
    );

    expect(payload.provider).toBe("openrouter");
    expect(payload.pricing.estimate_available).toBe(false);
    expect(payload.cost.total_usd).toBe(0);
  });

  it("maps OpenRouter OpenAI-prefixed model names to known OpenAI pricing", () => {
    const payload = tokenOutputPayload(
      "project",
      "openai/gpt-5.4",
      {
        requests: 1,
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
        inputTokensDetails: {},
        outputTokensDetails: {},
        requestUsageEntries: [],
      } as any,
      "openrouter",
    );

    expect(payload.pricing.estimate_available).toBe(true);
    expect(payload.cost.total_usd).toBeGreaterThan(0);
  });

  it("uses OpenRouter catalog pricing after the model list is loaded", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "example/provider-priced-model",
              name: "Provider Priced Model",
              context_length: 128000,
              pricing: { prompt: "0.00000012", completion: "0.00000024" },
              supported_parameters: ["tools"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const models = await fetchOpenRouterModels("test-openrouter-key");
    const payload = tokenOutputPayload(
      "project",
      "example/provider-priced-model",
      {
        requests: 1,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokensDetails: {},
        outputTokensDetails: {},
        requestUsageEntries: [],
      } as any,
      "openrouter",
    );

    expect(models[0]).toMatchObject({
      id: "example/provider-priced-model",
      pricing: { prompt_per_1m: 0.12, completion_per_1m: 0.24 },
    });
    expect(payload.pricing.estimate_available).toBe(true);
    expect(payload.pricing.input).toBe(0.12);
    expect(payload.pricing.output).toBe(0.24);
    expect(payload.cost.total_usd).toBe(0.00024);
  });
});
