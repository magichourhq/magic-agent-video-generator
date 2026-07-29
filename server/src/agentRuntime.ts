import { Agent, OpenAIProvider, Runner, retryPolicies, type AgentOutputType } from "@openai/agents";
import OpenAI from "openai";
import { ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import type { AgentModelIntensity, AgentModelProvider, CreateProjectRequest } from "./schemas.js";
import { runtimeCredentialsFromRequest } from "./runtimeCredentials.js";

export const DEFAULT_OPENAI_AGENT_MODEL = "gpt-5.4";
export const DEFAULT_OPENROUTER_AGENT_MODEL = "openai/gpt-5.4";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MAX_TOKENS = 4_000;
export const DEFAULT_DEEPSEEK_V4_PRO_MAX_TOKENS = 12_000;

export const FALLBACK_OPENROUTER_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-opus-4.5",
  "google/gemini-3-pro",
  "x-ai/grok-4.1",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-r1",
  "qwen/qwen3-max",
  "meta-llama/llama-4-maverick",
] as const;

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  context_length?: number | null;
  supported_parameters?: string[];
  pricing?: {
    prompt?: number | null;
    completion?: number | null;
    prompt_per_1m?: number | null;
    completion_per_1m?: number | null;
    source?: string;
  } | null;
}

const OPENROUTER_PRICING_CACHE = new Map<
  string,
  {
    input: number;
    cached_input: number;
    output: number;
    long_context_threshold_input_tokens: number;
    long_context_input_multiplier: number;
    long_context_output_multiplier: number;
    source: string;
  }
>();

export interface AgentRuntimeConfig {
  provider: AgentModelProvider;
  model: string;
  intensity: AgentModelIntensity;
  base_url: string | null;
  has_api_key: boolean;
  model_provider?: OpenAIProvider;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function fallbackOpenRouterModels(): OpenRouterModelInfo[] {
  return FALLBACK_OPENROUTER_MODELS.map((id) => ({ id, name: id }));
}

export function openRouterPricingForModel(model: string) {
  return OPENROUTER_PRICING_CACHE.get(model) ?? null;
}

function envProvider(): AgentModelProvider {
  const value = clean(ENV.AGENT_MODEL_PROVIDER ?? ENV.LLM_PROVIDER ?? ENV.OPENAI_PROVIDER);
  return value === "openrouter" ? "openrouter" : "openai";
}

function normalizeIntensity(value: string | null | undefined): AgentModelIntensity {
  if (value === "pro" || value === "max") return value;
  return "standard";
}

function configuredOpenRouterMaxTokens(model: string): number {
  const raw =
    clean(process.env.OPENROUTER_MAX_TOKENS) ??
    clean(process.env.AGENT_MAX_OUTPUT_TOKENS) ??
    clean(ENV.OPENROUTER_MAX_TOKENS) ??
    clean(ENV.AGENT_MAX_OUTPUT_TOKENS);
  const modelDefault = /deepseek\/deepseek-v4-pro/i.test(model)
    ? DEFAULT_DEEPSEEK_V4_PRO_MAX_TOKENS
    : DEFAULT_OPENROUTER_MAX_TOKENS;
  const parsed = Math.trunc(Number(raw ?? modelDefault));
  if (!Number.isFinite(parsed)) return modelDefault;
  return Math.max(1024, Math.min(parsed, 16_000));
}

function openAiModelSupportsResponseControls(model: string): boolean {
  return /^(gpt-5|o[1-9]|codex)/i.test(model.trim());
}

function runtimeSupportsResponseControls(runtime: AgentRuntimeConfig): boolean {
  return runtime.provider === "openrouter" || openAiModelSupportsResponseControls(runtime.model);
}

function reasoningEffortForRuntime(runtime: AgentRuntimeConfig): string {
  if (runtime.intensity === "max") return "medium";
  if (runtime.intensity === "pro") return "low";
  return runtime.provider === "openai" ? "none" : "minimal";
}

function runtimeModel(provider: AgentModelProvider, requestedModel: string | null): string {
  if (requestedModel) return requestedModel;
  if (provider === "openrouter") {
    return clean(ENV.OPENROUTER_MODEL) ?? DEFAULT_OPENROUTER_AGENT_MODEL;
  }
  return clean(ENV.OPENAI_MODEL) ?? DEFAULT_OPENAI_AGENT_MODEL;
}

function runtimeApiKey(provider: AgentModelProvider, request: CreateProjectRequest | null): string | null {
  const credentials = runtimeCredentialsFromRequest(request);
  if (provider === "openrouter") {
    return clean(credentials.openrouter_api_key) ?? clean(ENV.OPENROUTER_API_KEY);
  }
  return clean(credentials.openai_api_key) ?? clean(ENV.OPENAI_API_KEY);
}

export function resolveAgentRuntime(request: CreateProjectRequest | null = null): AgentRuntimeConfig {
  const provider = request?.agent_provider ?? envProvider();
  const model = runtimeModel(provider, clean(request?.agent_model));
  const intensity = normalizeIntensity(request?.agent_intensity ?? ENV.AGENT_MODEL_INTENSITY ?? ENV.OPENROUTER_INTENSITY);
  const apiKey = runtimeApiKey(provider, request);

  if (provider === "openrouter") {
    const baseURL = clean(ENV.OPENROUTER_BASE_URL) ?? DEFAULT_OPENROUTER_BASE_URL;
    const client = new OpenAI({
      apiKey: apiKey ?? "missing-openrouter-key",
      baseURL,
      defaultHeaders: {
        "HTTP-Referer": clean(ENV.OPENROUTER_SITE_URL) ?? "http://localhost:3000",
        "X-Title": clean(ENV.OPENROUTER_APP_NAME) ?? "Magic Agent",
      },
    });
    return {
      provider,
      model,
      intensity,
      base_url: baseURL,
      has_api_key: Boolean(apiKey),
      model_provider: new OpenAIProvider({
        openAIClient: client as any,
        useResponses: false,
        strictFeatureValidation: false,
      }),
    };
  }

  const client = apiKey
    ? new OpenAI({
        apiKey,
      })
    : null;
  return {
    provider,
    model,
    intensity,
    base_url: null,
    has_api_key: Boolean(apiKey),
    ...(client
      ? {
          model_provider: new OpenAIProvider({
            openAIClient: client as any,
            useResponses: true,
            strictFeatureValidation: false,
          }),
        }
      : {}),
  };
}

export function runtimeFromContext(ctx: ProjectContext): AgentRuntimeConfig {
  return resolveAgentRuntime({
    prompt: "saved project runtime",
    workflow: "generated",
    youtube_search_provider: "youtube_data_api",
    youtube_allow_provider_fallback: false,
    duration_seconds: null,
    scene_count: null,
    aspect_ratio: "9:16",
    resolution: "720p",
    image_model: null,
    video_model: null,
    image_resolution: null,
    video_resolution: null,
    agent_provider: (ctx.agent_provider === "openrouter" ? "openrouter" : "openai") as AgentModelProvider,
    agent_model: ctx.agent_model || null,
    agent_intensity: normalizeIntensity(ctx.agent_intensity),
    audio_provider: ctx.audio_provider,
    hume_voice_description: ctx.hume_voice_description || null,
    hume_voice_id: ctx.hume_voice_id || null,
    hume_voice_name: ctx.hume_voice_name || null,
    elevenlabs_voice_id: ctx.elevenlabs_voice_id || null,
    elevenlabs_voice_name: ctx.elevenlabs_voice_name || null,
    input_media: [],
    runtime_credentials: {
      openai_api_key: ctx.openai_api_key ?? null,
      openrouter_api_key: ctx.openrouter_api_key ?? null,
      magic_hour_api_key: null,
      fish_audio_api_key: null,
      fish_audio_reference_id: null,
      hume_api_key: null,
      elevenlabs_api_key: null,
      elevenlabs_voice_id: null,
      elevenlabs_voice_name: null,
    },
    openrouter_api_key: null,
  });
}

export function cloneAgentForRuntime<TContext, TOutput extends AgentOutputType>(
  agent: Agent<TContext, TOutput>,
  runtime: AgentRuntimeConfig,
): Agent<TContext, TOutput> {
  const openRouterSettings =
    runtime.provider === "openrouter"
      ? {
          maxTokens: configuredOpenRouterMaxTokens(runtime.model),
          retry: {
            maxRetries: 1,
            policy: retryPolicies.networkError(),
            backoff: { initialDelayMs: 500, maxDelayMs: 500, jitter: false },
          },
        }
      : {};
  const supportsResponseControls = runtimeSupportsResponseControls(runtime);
  const baseModelSettings: Record<string, unknown> = { ...(agent.modelSettings as any) };
  if (!supportsResponseControls) {
    delete baseModelSettings.reasoning;
    delete baseModelSettings.text;
  }
  const responseControlSettings = supportsResponseControls
    ? {
        reasoning: {
          ...(agent.modelSettings as any)?.reasoning,
          effort: reasoningEffortForRuntime(runtime),
        },
        text: {
          ...(agent.modelSettings as any)?.text,
          verbosity: runtime.intensity === "max" ? "medium" : "low",
        },
      }
    : {};
  return agent.clone({
    model: runtime.model,
    modelSettings: {
      ...baseModelSettings,
      ...openRouterSettings,
      ...responseControlSettings,
    } as any,
  });
}

export function runnerForRuntime(runtime: AgentRuntimeConfig): Runner {
  return new Runner({
    ...(runtime.model_provider ? { modelProvider: runtime.model_provider } : {}),
    workflowName: "Magic Agent video generation",
    traceMetadata: {
      provider: runtime.provider,
      model: runtime.model,
      intensity: runtime.intensity,
    },
  });
}

export function assertAgentRuntimeReady(runtime: AgentRuntimeConfig): void {
  if (runtime.provider === "openrouter" && !runtime.has_api_key) {
    throw new Error("OpenRouter is selected for the agent model, but no OpenRouter API key is configured.");
  }
  if (runtime.provider === "openai" && !runtime.has_api_key) {
    throw new Error("OpenAI is selected for the agent model, but no OpenAI API key is configured.");
  }
}

export function agentRuntimeStatus(runtime: AgentRuntimeConfig) {
  return {
    provider: runtime.provider,
    model: runtime.model,
    intensity: runtime.intensity,
    base_url: runtime.base_url,
    has_api_key: runtime.has_api_key,
  };
}

export async function fetchOpenRouterModels(apiKey?: string | null): Promise<OpenRouterModelInfo[]> {
  const key = clean(apiKey) ?? clean(ENV.OPENROUTER_API_KEY);
  try {
    const response = await fetch(`${clean(ENV.OPENROUTER_BASE_URL) ?? DEFAULT_OPENROUTER_BASE_URL}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!response.ok) throw new Error(`OpenRouter model list failed with HTTP ${response.status}`);
    const body: any = await response.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    const models = data
      .map((item: any): OpenRouterModelInfo => {
        const id = String(item?.id ?? "").trim();
        const name = String(item?.name ?? item?.id ?? "").trim();
        const prompt = finiteNumber(item?.pricing?.prompt);
        const completion = finiteNumber(item?.pricing?.completion);
        const contextLength = finiteNumber(item?.context_length);
        const model: OpenRouterModelInfo = {
          id,
          name,
          context_length: contextLength,
          supported_parameters: Array.isArray(item?.supported_parameters)
            ? item.supported_parameters.map((value: unknown) => String(value))
            : [],
          pricing:
            prompt !== null || completion !== null
              ? {
                  prompt,
                  completion,
                  prompt_per_1m: prompt === null ? null : prompt * 1_000_000,
                  completion_per_1m: completion === null ? null : completion * 1_000_000,
                  source: "https://openrouter.ai/models",
                }
              : null,
        };
        if (id && prompt !== null && completion !== null) {
          OPENROUTER_PRICING_CACHE.set(id, {
            input: prompt * 1_000_000,
            cached_input: prompt * 1_000_000,
            output: completion * 1_000_000,
            long_context_threshold_input_tokens: contextLength ?? Number.MAX_SAFE_INTEGER,
            long_context_input_multiplier: 1,
            long_context_output_multiplier: 1,
            source: "https://openrouter.ai/models",
          });
        }
        return model;
      })
      .filter((item: OpenRouterModelInfo) => item.id);
    return models.length ? models : fallbackOpenRouterModels();
  } catch {
    return fallbackOpenRouterModels();
  }
}
