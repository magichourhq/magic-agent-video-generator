import type { Scene, SceneAudioSource, VideoPlan } from "./schemas.js";

export function sceneAudioSource(scene: Scene): SceneAudioSource {
  if (scene.audio_source) return scene.audio_source;
  if (scene.on_camera === true) return "speech_driven";
  return String(scene.narration ?? "").trim() ? "voiceover" : "native_scene_audio";
}

export function sceneUsesExternalSpeech(scene: Scene): boolean {
  const source = sceneAudioSource(scene);
  return source === "voiceover" || source === "speech_driven";
}

export function sceneUsesNativeAudio(scene: Scene): boolean {
  return sceneAudioSource(scene) === "native_scene_audio";
}

export function planNeedsPerSceneAudio(plan: VideoPlan): boolean {
  return plan.scenes.some((scene) => sceneAudioSource(scene) !== "voiceover");
}

export function nativeAudioVideoPrompt(scene: Scene): string {
  const audio = String(scene.native_audio_prompt ?? "").trim();
  return audio ? `${scene.video_prompt} Audio: ${audio}` : scene.video_prompt;
}

export function validateSceneAudioContract(
  plan: VideoPlan,
  videoModel: string,
  hasUploadedAudio = false,
): string[] {
  const issues: string[] = [];
  for (const scene of plan.scenes) {
    const source = sceneAudioSource(scene);
    const narration = String(scene.narration ?? "").trim();
    const nativePrompt = String(scene.native_audio_prompt ?? "").trim();

    if (source === "speech_driven") {
      if (scene.on_camera !== true) {
        issues.push(`${scene.id} uses speech_driven audio but is not marked on_camera=true.`);
      }
      if (!narration) issues.push(`${scene.id} uses speech_driven audio but has no spoken narration.`);
      if (nativePrompt) issues.push(`${scene.id} speech_driven audio cannot also include a native H3 audio prompt.`);
      continue;
    }

    if (source === "voiceover") {
      if (scene.on_camera === true) {
        issues.push(`${scene.id} uses voiceover audio but is marked on_camera=true; use speech_driven for visible speech.`);
      }
      if (!narration) issues.push(`${scene.id} uses voiceover audio but has no spoken narration.`);
      if (nativePrompt) issues.push(`${scene.id} voiceover audio cannot also include a native H3 audio prompt.`);
      continue;
    }

    if (scene.on_camera === true) {
      issues.push(`${scene.id} uses native_scene_audio but is marked on_camera=true; H3 does not accept external lip-sync audio.`);
    }
    if (narration) {
      issues.push(`${scene.id} uses native_scene_audio but also contains external narration; move audible content into native_audio_prompt.`);
    }
    if (!nativePrompt) {
      issues.push(`${scene.id} uses native_scene_audio but does not describe its dialogue, ambience, foley, or music.`);
    }
    if (videoModel !== "minimax-h3") {
      issues.push(`${scene.id} uses native_scene_audio, which currently requires the minimax-h3 video model.`);
    }
    if (hasUploadedAudio) {
      issues.push(`${scene.id} uses native_scene_audio while user-supplied audio is authoritative; use voiceover instead.`);
    }
  }
  return issues;
}
