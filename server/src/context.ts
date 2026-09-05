export interface ProjectContext {
  project_id: string;
  project_dir: string;
  aspect_ratio: string;
  resolution: string;
  openai_api_key?: string;
  magic_hour_api_key: string;
  fish_audio_api_key: string;
  fish_audio_reference_id: string;
  hume_api_key: string;
  elevenlabs_api_key: string;
  elevenlabs_voice_id: string;
  elevenlabs_voice_name: string;
  agent_provider: string;
  agent_model: string;
  agent_intensity: string;
  openrouter_api_key?: string;
  image_model: string;
  image_resolution: string;
  image_style_tool: string;
  video_model: string;
  video_audio: boolean;
  audio_provider: "fish" | "hume" | "elevenlabs";
  audio_model: string;
  audio_format: string;
  hume_voice_description: string;
  hume_voice_id: string;
  hume_voice_name: string;
  hume_voice_provider: string;
}

export const PROJECT_CONTEXT_DEFAULTS = {
  openai_api_key: "",
  magic_hour_api_key: "",
  fish_audio_api_key: "",
  fish_audio_reference_id: "",
  hume_api_key: "",
  elevenlabs_api_key: "",
  elevenlabs_voice_id: "",
  elevenlabs_voice_name: "brielle - podcast girl",
  agent_provider: "openai",
  agent_model: "gpt-5.4",
  agent_intensity: "standard",
  image_model: "seedream-v4",
  image_resolution: "1k",
  image_style_tool: "general",
  video_model: "minimax-h3",
  video_audio: false,
  audio_provider: "hume",
  audio_model: "octave-1",
  audio_format: "mp3",
  hume_voice_description: "",
  hume_voice_id: "",
  hume_voice_name: "",
  hume_voice_provider: "HUME_AI",
} satisfies Partial<ProjectContext>;
