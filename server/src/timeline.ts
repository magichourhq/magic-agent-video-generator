export type TimelineTrackKind = "video" | "narration" | "guard";
export type TimelineEndBehavior = "cut" | "freeze" | "fade";

export interface TimelineClip {
  id: string;
  track: TimelineTrackKind;
  label: string;
  scene_id?: string | null;
  source_path?: string | null;
  source_start: number;
  source_end: number;
  timeline_start: number;
  timeline_end: number;
  duration: number;
  end_behavior: TimelineEndBehavior;
  locked?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TimelineTrack {
  id: string;
  kind: TimelineTrackKind;
  label: string;
  clips: TimelineClip[];
}

export interface TimelineArtifact {
  version: 1;
  duration_seconds: number;
  tracks: TimelineTrack[];
  ending: {
    hold_seconds: number;
    intentional: boolean;
    reason: string;
    guard_clip_id: string | null;
    verification?: Record<string, unknown>;
  };
  updated_at: string;
}

export interface TimelineEditResult {
  timeline: TimelineArtifact;
  summary: string;
}

export const DEFAULT_FINAL_HOLD_SECONDS = 0;
const MAX_FINAL_HOLD_SECONDS = 5;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clipDuration(asset: Record<string, any>): number {
  const duration = numberOrNull(asset.duration_seconds);
  if (duration !== null && duration > 0) return round3(duration);
  const sourceStart = numberOrNull(asset.start_seconds) ?? 0;
  const sourceEnd = numberOrNull(asset.end_seconds);
  if (sourceEnd !== null && sourceEnd > sourceStart) return round3(sourceEnd - sourceStart);
  return 1;
}

function orderedVideos(projectState: Record<string, any>): Record<string, any>[] {
  const videos = [...(projectState.scene_assets?.videos ?? [])];
  const scenes = projectState.current_plan?.scenes ?? [];
  if (!Array.isArray(scenes) || scenes.length === 0) return videos;
  const order = new Map<string, number>();
  scenes.forEach((scene: Record<string, any>, index: number) => {
    if (scene?.id) order.set(String(scene.id), index);
  });
  return videos.sort((a, b) => {
    const aOrder = order.get(String(a.scene_id ?? "")) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(String(b.scene_id ?? "")) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}

function makeTrack(kind: TimelineTrackKind, label: string, clips: TimelineClip[]): TimelineTrack {
  return { id: kind, kind, label, clips };
}

function trackEnd(track: TimelineTrack | undefined): number {
  return Math.max(0, ...(track?.clips ?? []).map((clip) => clip.timeline_end));
}

function videoEnd(timeline: TimelineArtifact): number {
  const videoTrack = timeline.tracks.find((track) => track.kind === "video");
  const narrationTrack = timeline.tracks.find((track) => track.kind === "narration");
  return Math.max(trackEnd(videoTrack), trackEnd(narrationTrack));
}

function clampFinalHold(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_FINAL_HOLD_SECONDS;
  return round3(Math.max(0, Math.min(MAX_FINAL_HOLD_SECONDS, seconds)));
}

function ensureTrack(timeline: TimelineArtifact, kind: TimelineTrackKind, label: string): TimelineTrack {
  let track = timeline.tracks.find((item) => item.kind === kind);
  if (!track) {
    track = makeTrack(kind, label, []);
    timeline.tracks.push(track);
  }
  return track;
}

export function normalizeTimeline(timeline: TimelineArtifact): TimelineArtifact {
  const normalized: TimelineArtifact = {
    version: 1,
    duration_seconds: round3(
      Math.max(
        0,
        ...timeline.tracks.flatMap((track) => track.clips.map((clip) => Number(clip.timeline_end) || 0)),
      ),
    ),
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        const sourceStart = round3(Math.max(0, Number(clip.source_start) || 0));
        const sourceEnd = round3(Math.max(sourceStart, Number(clip.source_end) || sourceStart));
        const timelineStart = round3(Math.max(0, Number(clip.timeline_start) || 0));
        const duration = round3(Math.max(0, Number(clip.duration) || sourceEnd - sourceStart));
        const timelineEnd = round3(Math.max(timelineStart, Number(clip.timeline_end) || timelineStart + duration));
        return {
          ...clip,
          source_start: sourceStart,
          source_end: sourceEnd,
          timeline_start: timelineStart,
          timeline_end: timelineEnd,
          duration: round3(timelineEnd - timelineStart),
        };
      }),
    })),
    ending: {
      hold_seconds: round3(Math.max(0, Number(timeline.ending?.hold_seconds) || 0)),
      intentional: Boolean(timeline.ending?.intentional),
      reason: String(timeline.ending?.reason ?? ""),
      guard_clip_id: timeline.ending?.guard_clip_id ?? null,
      ...(timeline.ending?.verification ? { verification: timeline.ending.verification } : {}),
    },
    updated_at: new Date().toISOString(),
  };
  normalized.duration_seconds = round3(
    Math.max(0, ...normalized.tracks.flatMap((track) => track.clips.map((clip) => clip.timeline_end))),
  );
  return normalized;
}

export function buildTimelineFromProjectState(
  projectState: Record<string, any>,
  options: { final_hold_seconds?: number | null; ending_reason?: string | null } = {},
): TimelineArtifact {
  let cursor = 0;
  const videoClips = orderedVideos(projectState).map((asset, index) => {
    const duration = round3(numberOrNull(asset.audio_duration_seconds) ?? numberOrNull(asset.timeline_duration_seconds) ?? clipDuration(asset));
    const sourceDuration = round3(numberOrNull(asset.source_duration_seconds) ?? clipDuration(asset));
    const originalStart = numberOrNull(asset.start_seconds) ?? 0;
    const originalEnd = numberOrNull(asset.end_seconds) ?? originalStart + sourceDuration;
    const isDownloadedYoutubeSegment = asset.source === "youtube" || Boolean(asset.youtube_url);
    const sourceStart = isDownloadedYoutubeSegment ? 0 : originalStart;
    const sourceEnd = isDownloadedYoutubeSegment ? sourceDuration : originalEnd;
    const start = cursor;
    const end = round3(start + duration);
    cursor = end;
    return {
      id: `video:${asset.scene_id ?? index + 1}`,
      track: "video" as const,
      label: `Scene ${index + 1}`,
      scene_id: asset.scene_id ? String(asset.scene_id) : null,
      source_path: asset.path ? String(asset.path) : null,
      source_start: round3(sourceStart),
      source_end: round3(sourceEnd),
      timeline_start: start,
      timeline_end: end,
      duration,
      end_behavior: duration > sourceEnd - sourceStart ? "freeze" as const : "cut" as const,
      metadata: {
        youtube_url: asset.youtube_url,
        youtube_title: asset.youtube_title,
        youtube_channel: asset.youtube_channel,
        window_source: asset.window_source,
        original_start_seconds: isDownloadedYoutubeSegment ? round3(originalStart) : undefined,
        original_end_seconds: isDownloadedYoutubeSegment ? round3(originalEnd) : undefined,
        source_duration_seconds: sourceDuration,
        audio_duration_seconds: numberOrNull(asset.audio_duration_seconds) ?? undefined,
        has_embedded_audio: asset.has_embedded_audio === true ? true : undefined,
        on_camera: asset.on_camera === true ? true : undefined,
      },
    };
  });

  const voiceover = projectState.scene_assets?.voiceover ?? null;
  const voiceoverDuration = numberOrNull(voiceover?.duration_seconds);
  const makeNarrationClip = (suffix: string, start: number, end: number) => ({
    id: suffix ? `narration:voiceover:${suffix}` : "narration:voiceover",
    track: "narration" as const,
    label: "Voiceover",
    scene_id: null,
    source_path: voiceover?.path ? String(voiceover.path) : null,
    source_start: round3(start),
    source_end: round3(end),
    timeline_start: round3(start),
    timeline_end: round3(end),
    duration: round3(end - start),
    end_behavior: "cut" as const,
    locked: true,
  });
  let narrationClips: ReturnType<typeof makeNarrationClip>[] = [];
  if (voiceover && voiceoverDuration !== null && voiceoverDuration > 0) {
    const talkingSpans = videoClips
      .filter((c) => c.metadata?.on_camera === true || c.metadata?.has_embedded_audio === true)
      .map((c) => [c.timeline_start, c.timeline_end] as const);
    if (talkingSpans.length === 0) {
      narrationClips = [makeNarrationClip("", 0, voiceoverDuration)];
    } else {
      // Emit narration only over the b-roll complement of [0, cursor] minus the talking spans.
      const sortedSpans = [...talkingSpans].sort((a, b) => a[0] - b[0]);
      const gaps: Array<readonly [number, number]> = [];
      let position = 0;
      for (const [spanStart, spanEnd] of sortedSpans) {
        if (spanStart > position) gaps.push([position, spanStart] as const);
        position = Math.max(position, spanEnd);
      }
      if (cursor > position) gaps.push([position, cursor] as const);
      narrationClips = gaps
        .filter(([start, end]) => end > start)
        .map(([start, end], index) => makeNarrationClip(`gap-${index + 1}`, start, end));
    }
  }

  const holdSeconds = clampFinalHold(options.final_hold_seconds ?? DEFAULT_FINAL_HOLD_SECONDS);
  const guardStart = Math.max(cursor, narrationClips[0]?.timeline_end ?? 0);
  const guardClip =
    holdSeconds > 0
      ? {
          id: "guard:final-hold",
          track: "guard" as const,
          label: "Final hold",
          scene_id: videoClips[videoClips.length - 1]?.scene_id ?? null,
          source_path: videoClips[videoClips.length - 1]?.source_path ?? null,
          source_start: 0,
          source_end: holdSeconds,
          timeline_start: round3(guardStart),
          timeline_end: round3(guardStart + holdSeconds),
          duration: holdSeconds,
          end_behavior: "freeze" as const,
          metadata: { reason: options.ending_reason ?? "Default ending guard to avoid abrupt cutoff." },
        }
      : null;

  return normalizeTimeline({
    version: 1,
    duration_seconds: 0,
    tracks: [
      makeTrack("video", "Video", videoClips),
      makeTrack("narration", "Narration", narrationClips),
      makeTrack("guard", "Ending Guard", guardClip ? [guardClip] : []),
    ],
    ending: {
      hold_seconds: holdSeconds,
      intentional: holdSeconds > 0,
      reason: options.ending_reason ?? "Default ending guard to avoid abrupt cutoff.",
      guard_clip_id: guardClip?.id ?? null,
    },
    updated_at: new Date().toISOString(),
  });
}

export function setFinalHold(
  timeline: TimelineArtifact,
  holdSeconds: number,
  reason = "Adjusted final hold.",
): TimelineArtifact {
  const next = normalizeTimeline(structuredClone(timeline));
  const guardTrack = ensureTrack(next, "guard", "Ending Guard");
  const hold = clampFinalHold(holdSeconds);
  const start = round3(videoEnd(next));
  guardTrack.clips = hold > 0
    ? [
        {
          id: "guard:final-hold",
          track: "guard",
          label: "Final hold",
          scene_id: next.tracks.find((track) => track.kind === "video")?.clips.at(-1)?.scene_id ?? null,
          source_path: next.tracks.find((track) => track.kind === "video")?.clips.at(-1)?.source_path ?? null,
          source_start: 0,
          source_end: hold,
          timeline_start: start,
          timeline_end: round3(start + hold),
          duration: hold,
          end_behavior: "freeze",
          metadata: { reason },
        },
      ]
    : [];
  next.ending = {
    hold_seconds: hold,
    intentional: hold > 0,
    reason,
    guard_clip_id: hold > 0 ? "guard:final-hold" : null,
  };
  return normalizeTimeline(next);
}

export function moveClip(timeline: TimelineArtifact, clipId: string, timelineStart: number): TimelineArtifact {
  const next = normalizeTimeline(structuredClone(timeline));
  const clip = next.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  if (!clip) throw new Error(`Timeline clip not found: ${clipId}`);
  const start = round3(Math.max(0, timelineStart));
  clip.timeline_start = start;
  clip.timeline_end = round3(start + clip.duration);
  return normalizeTimeline(next);
}

export function trimClip(
  timeline: TimelineArtifact,
  clipId: string,
  trim: { source_start?: number; source_end?: number },
): TimelineArtifact {
  const next = normalizeTimeline(structuredClone(timeline));
  const clip = next.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  if (!clip) throw new Error(`Timeline clip not found: ${clipId}`);
  const sourceStart = round3(Math.max(0, trim.source_start ?? clip.source_start));
  const sourceEnd = round3(Math.max(sourceStart, trim.source_end ?? clip.source_end));
  const duration = round3(sourceEnd - sourceStart);
  if (duration <= 0) throw new Error("Trimmed timeline clip must have positive duration.");
  clip.source_start = sourceStart;
  clip.source_end = sourceEnd;
  clip.duration = duration;
  clip.timeline_end = round3(clip.timeline_start + duration);
  return normalizeTimeline(next);
}

export function timelineSummary(timeline: TimelineArtifact): string {
  const normalized = normalizeTimeline(timeline);
  const videoCount = normalized.tracks.find((track) => track.kind === "video")?.clips.length ?? 0;
  const hold = normalized.ending.hold_seconds;
  const ending = normalized.ending.intentional ? "intentional ending" : "no ending guard";
  return `${videoCount} video clip${videoCount === 1 ? "" : "s"}, ${round3(normalized.duration_seconds)}s total, final hold ${hold}s, ${ending}.`;
}

export function inspectTimeline(timeline: TimelineArtifact): TimelineEditResult {
  const normalized = normalizeTimeline(timeline);
  return { timeline: normalized, summary: timelineSummary(normalized) };
}

