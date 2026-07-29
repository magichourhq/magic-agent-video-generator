import type { CreateProjectRequest, ProjectMessageRequest, RuntimeCredentials } from "./schemas.js";

const PROJECT_CREDENTIALS = new Map<string, RuntimeCredentials>();
const EMPTY_RUNTIME_CREDENTIALS: RuntimeCredentials = {
  openai_api_key: null,
  openrouter_api_key: null,
  magic_hour_api_key: null,
  fish_audio_api_key: null,
  fish_audio_reference_id: null,
  hume_api_key: null,
  elevenlabs_api_key: null,
  elevenlabs_voice_id: null,
  elevenlabs_voice_name: null,
};

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

export function runtimeCredentialsFromRequest(
  request: Pick<CreateProjectRequest, "runtime_credentials" | "openrouter_api_key"> | ProjectMessageRequest | null,
): RuntimeCredentials {
  const credentials: RuntimeCredentials = { ...EMPTY_RUNTIME_CREDENTIALS, ...(request?.runtime_credentials ?? {}) };
  const legacyOpenRouterKey =
    request && "openrouter_api_key" in request ? request.openrouter_api_key : null;
  return {
    openai_api_key: clean(credentials.openai_api_key),
    openrouter_api_key: clean(credentials.openrouter_api_key ?? legacyOpenRouterKey),
    magic_hour_api_key: clean(credentials.magic_hour_api_key),
    fish_audio_api_key: clean(credentials.fish_audio_api_key),
    fish_audio_reference_id: clean(credentials.fish_audio_reference_id),
    hume_api_key: clean(credentials.hume_api_key),
    elevenlabs_api_key: clean(credentials.elevenlabs_api_key),
    elevenlabs_voice_id: clean(credentials.elevenlabs_voice_id),
    elevenlabs_voice_name: clean(credentials.elevenlabs_voice_name),
  };
}

export function rememberProjectRuntimeCredentials(
  projectId: string,
  credentials: Partial<RuntimeCredentials> | null | undefined,
): void {
  const existing = PROJECT_CREDENTIALS.get(projectId) ?? EMPTY_RUNTIME_CREDENTIALS;
  const next: RuntimeCredentials = { ...existing };
  for (const [key, value] of Object.entries(credentials ?? {}) as Array<[keyof RuntimeCredentials, string | null | undefined]>) {
    const cleaned = clean(value);
    if (cleaned) next[key] = cleaned;
  }
  if (Object.values(next).some(Boolean)) {
    PROJECT_CREDENTIALS.set(projectId, next);
  }
}

export function projectRuntimeCredentials(projectId: string): RuntimeCredentials {
  return { ...EMPTY_RUNTIME_CREDENTIALS, ...(PROJECT_CREDENTIALS.get(projectId) ?? {}) };
}

export function runtimeCredentialStatus(credentials: RuntimeCredentials) {
  return {
    has_openai_api_key: Boolean(clean(credentials.openai_api_key)),
    has_openrouter_api_key: Boolean(clean(credentials.openrouter_api_key)),
    has_magic_hour_api_key: Boolean(clean(credentials.magic_hour_api_key)),
    has_fish_audio_api_key: Boolean(clean(credentials.fish_audio_api_key)),
    has_fish_audio_reference_id: Boolean(clean(credentials.fish_audio_reference_id)),
    has_hume_api_key: Boolean(clean(credentials.hume_api_key)),
    has_elevenlabs_api_key: Boolean(clean(credentials.elevenlabs_api_key)),
    has_elevenlabs_voice_id: Boolean(clean(credentials.elevenlabs_voice_id)),
    has_elevenlabs_voice_name: Boolean(clean(credentials.elevenlabs_voice_name)),
  };
}

