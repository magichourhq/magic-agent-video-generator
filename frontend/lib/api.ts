import type {
  CreateProjectPayload,
  CreateProjectResponse,
  ProjectListResponse,
  ProjectMessagePayload,
  ProjectStatusResponse,
  OpenRouterModelInfo,
  InputMedia,
  TimelineEditPayload,
  YouTubeReviewBatchResponse,
  YouTubeReviewCommentPayload,
  YouTubeReviewSessionPayload,
  YouTubeReviewSessionResponse,
} from "./types";

const RAW_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
export const API_BASE = RAW_BASE.replace(/\/+$/, "");

async function parseOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const detail = body?.detail ?? `Request failed with ${response.status}`;
    if (typeof detail === "string") {
      throw new Error(detail);
    }
    if (detail?.message) {
      const missing = [
        ...(detail.missing_config ?? []),
        ...(detail.missing_dependencies ?? []),
      ];
      throw new Error(missing.length ? `${detail.message} Missing: ${missing.join(", ")}` : detail.message);
    }
    throw new Error(JSON.stringify(detail));
  }
  return body as T;
}

export async function createProject(payload: CreateProjectPayload): Promise<CreateProjectResponse> {
  const response = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow<CreateProjectResponse>(response);
}

export async function uploadInputMedia(file: File): Promise<InputMedia> {
  const response = await fetch(`${API_BASE}/api/input-media`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  return parseOrThrow<InputMedia>(response);
}

export async function getProjects(limit = 100): Promise<ProjectListResponse> {
  const response = await fetch(`${API_BASE}/api/projects?limit=${encodeURIComponent(String(limit))}`, {
    cache: "no-store",
  });
  return parseOrThrow<ProjectListResponse>(response);
}

export async function getOpenRouterModels(apiKey?: string): Promise<OpenRouterModelInfo[]> {
  const response = await fetch(`${API_BASE}/api/providers/openrouter/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey || null }),
  });
  const payload = await parseOrThrow<{ models: OpenRouterModelInfo[] }>(response);
  return payload.models;
}

export async function getProject(projectId: string): Promise<ProjectStatusResponse> {
  const response = await fetch(`${API_BASE}/api/projects/${projectId}`, {
    cache: "no-store",
  });
  return parseOrThrow<ProjectStatusResponse>(response);
}

export async function sendProjectMessage(projectId: string, payload: ProjectMessagePayload): Promise<ProjectStatusResponse> {
  const response = await fetch(`${API_BASE}/api/projects/${projectId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow<ProjectStatusResponse>(response);
}

export async function patchProjectTimeline(
  projectId: string,
  payload: TimelineEditPayload,
): Promise<ProjectStatusResponse> {
  const response = await fetch(`${API_BASE}/api/projects/${projectId}/timeline`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow<ProjectStatusResponse>(response);
}

export async function createYoutubeReviewSession(
  payload: YouTubeReviewSessionPayload,
): Promise<YouTubeReviewSessionResponse> {
  const response = await fetch(`${API_BASE}/api/youtube-review-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow<YouTubeReviewSessionResponse>(response);
}

export async function getYoutubeReviewSession(reviewId: string): Promise<YouTubeReviewSessionResponse> {
  const response = await fetch(`${API_BASE}/api/youtube-review-sessions/${reviewId}`, {
    cache: "no-store",
  });
  return parseOrThrow<YouTubeReviewSessionResponse>(response);
}

export async function saveYoutubeReviewComment(
  reviewId: string,
  payload: YouTubeReviewCommentPayload,
): Promise<YouTubeReviewSessionResponse> {
  const response = await fetch(`${API_BASE}/api/youtube-review-sessions/${reviewId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseOrThrow<YouTubeReviewSessionResponse>(response);
}

export async function createYoutubeReviewBatch(): Promise<YouTubeReviewBatchResponse> {
  const response = await fetch(`${API_BASE}/api/youtube-review-batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return parseOrThrow<YouTubeReviewBatchResponse>(response);
}

export async function getYoutubeReviewBatch(batchId: string): Promise<YouTubeReviewBatchResponse> {
  const response = await fetch(`${API_BASE}/api/youtube-review-batches/${batchId}`, {
    cache: "no-store",
  });
  return parseOrThrow<YouTubeReviewBatchResponse>(response);
}

export async function getLatestYoutubeReviewBatch(): Promise<YouTubeReviewBatchResponse> {
  const response = await fetch(`${API_BASE}/api/youtube-review-batches/latest`, {
    cache: "no-store",
  });
  return parseOrThrow<YouTubeReviewBatchResponse>(response);
}

export function mediaUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/media/")) return `${API_BASE}${path}`;
  const marker = "/outputs/";
  const index = path.indexOf(marker);
  if (index >= 0) {
    return `${API_BASE}/media/${path.slice(index + marker.length)}`;
  }
  return path;
}
