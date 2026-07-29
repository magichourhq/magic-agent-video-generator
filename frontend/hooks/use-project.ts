import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProject,
  createYoutubeReviewBatch,
  createYoutubeReviewSession,
  getLatestYoutubeReviewBatch,
  getProject,
  getProjects,
  getYoutubeReviewBatch,
  getYoutubeReviewSession,
  patchProjectTimeline,
  saveYoutubeReviewComment,
  sendProjectMessage,
} from "@/lib/api";
import type {
  CreateProjectPayload,
  ProjectMessagePayload,
  ProjectListResponse,
  ProjectStatusResponse,
  TimelineEditPayload,
  YouTubeReviewBatchResponse,
  YouTubeReviewCommentPayload,
  YouTubeReviewSessionPayload,
  YouTubeReviewSessionResponse,
} from "@/lib/types";

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      if (!projectId) throw new Error("No project ID");
      return getProject(projectId);
    },
    enabled: !!projectId,
    // SSE status events invalidate this query in real time; the slow poll is
    // only a fallback in case the event stream drops.
    refetchInterval: (query) => {
      const data = query.state.data as ProjectStatusResponse | undefined;
      const isRunning = data?.status === "queued" || data?.status === "running";
      return isRunning ? 10000 : false;
    },
  });
}

function hasRunningProject(data: ProjectListResponse | undefined) {
  return (data?.projects ?? []).some((project) => project.status === "queued" || project.status === "running");
}

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(100),
    enabled,
    refetchInterval: (query) => (hasRunningProject(query.state.data as ProjectListResponse | undefined) ? 5000 : false),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectPayload) => createProject(data),
    onSuccess: (data) => {
      queryClient.setQueryData(["project", data.project_id], data);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useSendProjectMessage(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProjectMessagePayload) => {
      if (!projectId) throw new Error("Start a project before sending follow-up messages.");
      return sendProjectMessage(projectId, data);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["project", data.project_id], data);
      queryClient.invalidateQueries({ queryKey: ["project", data.project_id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function usePatchProjectTimeline(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: TimelineEditPayload) => {
      if (!projectId) throw new Error("Start a project before editing the timeline.");
      return patchProjectTimeline(projectId, data);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["project", data.project_id], data);
      queryClient.invalidateQueries({ queryKey: ["project", data.project_id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useYoutubeReviewSession(reviewId: string | null) {
  return useQuery({
    queryKey: ["youtube-review-session", reviewId],
    queryFn: async () => {
      if (!reviewId) throw new Error("No review session ID");
      return getYoutubeReviewSession(reviewId);
    },
    enabled: !!reviewId,
    refetchInterval: (query) => {
      const data = query.state.data as YouTubeReviewSessionResponse | undefined;
      const hasRunningProvider = Object.values(data?.providers ?? {}).some(
        (provider) => provider.status?.status === "queued" || provider.status?.status === "running",
      );
      return hasRunningProvider ? 2000 : false;
    },
  });
}

export function useCreateYoutubeReviewSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: YouTubeReviewSessionPayload) => createYoutubeReviewSession(data),
    onSuccess: (data) => {
      queryClient.setQueryData(["youtube-review-session", data.review_id], data);
    },
  });
}

function reviewBatchHasRunningProviders(data: YouTubeReviewBatchResponse | undefined) {
  return Object.values(data?.items ?? {}).some((item) =>
    Object.values(item.review?.providers ?? {}).some(
      (provider) => provider.status?.status === "queued" || provider.status?.status === "running",
    ),
  );
}

export function useLatestYoutubeReviewBatch(enabled = true) {
  return useQuery({
    queryKey: ["youtube-review-batch", "latest"],
    queryFn: getLatestYoutubeReviewBatch,
    enabled,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as YouTubeReviewBatchResponse | undefined;
      if (!data) return false;
      return reviewBatchHasRunningProviders(data) ? 2000 : false;
    },
  });
}

export function useYoutubeReviewBatch(batchId: string | null) {
  return useQuery({
    queryKey: ["youtube-review-batch", batchId],
    queryFn: async () => {
      if (!batchId) throw new Error("No review batch ID");
      return getYoutubeReviewBatch(batchId);
    },
    enabled: !!batchId,
    refetchInterval: (query) => {
      const data = query.state.data as YouTubeReviewBatchResponse | undefined;
      return reviewBatchHasRunningProviders(data) ? 2000 : false;
    },
  });
}

export function useCreateYoutubeReviewBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createYoutubeReviewBatch,
    onSuccess: (data) => {
      queryClient.setQueryData(["youtube-review-batch", data.batch_id], data);
      queryClient.setQueryData(["youtube-review-batch", "latest"], data);
    },
  });
}

export function useSaveYoutubeReviewComment(batchId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: YouTubeReviewCommentPayload & { reviewId: string }) => {
      const { reviewId, ...payload } = data;
      return saveYoutubeReviewComment(reviewId, payload);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["youtube-review-session", data.review_id], data);
      if (batchId) {
        queryClient.invalidateQueries({ queryKey: ["youtube-review-batch", batchId] });
      }
      queryClient.invalidateQueries({ queryKey: ["youtube-review-batch", "latest"] });
    },
  });
}

