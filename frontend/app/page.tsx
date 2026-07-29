"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChatWorkspace, type ChatSubmitValues } from "@/components/chat-workspace";
import { YoutubeReviewWorkspace } from "@/components/youtube-review-workspace";
import {
  useCreateProject,
  useCreateYoutubeReviewBatch,
  useLatestYoutubeReviewBatch,
  usePatchProjectTimeline,
  useProject,
  useProjects,
  useSaveYoutubeReviewComment,
  useSendProjectMessage,
} from "@/hooks/use-project";
import type { ProjectStatusResponse, RuntimeCredentials, TimelineEditPayload, YouTubeReviewProvider } from "@/lib/types";

type AppMode = "review" | "compose";

function mergeProjectJobs(...groups: Array<Array<ProjectStatusResponse | null | undefined> | null | undefined>) {
  const byId = new Map<string, ProjectStatusResponse>();
  for (const group of groups) {
    for (const project of group ?? []) {
      if (project?.project_id) byId.set(project.project_id, project);
    }
  }
  return Array.from(byId.values()).sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

export default function HomePage() {
  const [mode, setMode] = useState<AppMode>("compose");
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("project_id");
  });
  const [savingTarget, setSavingTarget] = useState<{ reviewId: string; provider: YouTubeReviewProvider } | null>(null);

  const createProject = useCreateProject();
  const projects = useProjects(mode === "compose");
  const projectId = loadedProjectId;
  const { data: job, isError: isJobError } = useProject(projectId);
  const sendMessage = useSendProjectMessage(projectId);
  const patchTimeline = usePatchProjectTimeline(projectId);

  const latestBatch = useLatestYoutubeReviewBatch(mode === "review");
  const createBatch = useCreateYoutubeReviewBatch();
  const saveComment = useSaveYoutubeReviewComment(latestBatch.data?.batch_id ?? null);

  const currentJob =
    job ??
    (createProject.data?.project_id === projectId ? createProject.data : null) ??
    (projects.data?.projects ?? []).find((project) => project.project_id === projectId) ??
    null;
  const projectJobs = useMemo(
    () => mergeProjectJobs(projects.data?.projects, [createProject.data], [currentJob]),
    [createProject.data, currentJob, projects.data?.projects],
  );
  const isBusy =
    sendMessage.isPending ||
    patchTimeline.isPending ||
    currentJob?.status === "queued" ||
    currentJob?.status === "running";

  if (isJobError) {
    toast.error("Could not read project status.", { id: "polling-error" });
  }

  const handleCreate = (values: ChatSubmitValues) => {
    createProject.mutate(values, {
      onSuccess: (data) => {
        setLoadedProjectId(data.project_id);
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `${window.location.pathname}?project_id=${data.project_id}`);
        }
        toast.success("Generation queued.");
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not start generation."),
    });
  };

  const handleMessage = (message: string, runtimeCredentials?: RuntimeCredentials | null) => {
    sendMessage.mutate(
      { message, runtime_credentials: runtimeCredentials ?? null },
      {
        onSuccess: () => toast.success("Message sent to agent."),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Could not send message."),
      },
    );
  };

  const handleTimelineEdit = (payload: TimelineEditPayload) => {
    patchTimeline.mutate(payload, {
      onSuccess: () => toast.success("Timeline updated."),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update timeline."),
    });
  };

  const handleNewCreate = () => {
    setLoadedProjectId(null);
    if (typeof window !== "undefined" && window.location.search.includes("project_id=")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    createProject.reset();
    sendMessage.reset();
    patchTimeline.reset();
  };

  const handleSelectProject = (nextProjectId: string) => {
    setLoadedProjectId(nextProjectId);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `${window.location.pathname}?project_id=${nextProjectId}`);
    }
  };

  const handleCreateBatch = () => {
    createBatch.mutate(undefined, {
      onSuccess: () => toast.success("Review batch started."),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not start review batch."),
    });
  };

  const handleSaveComment = (reviewId: string, provider: YouTubeReviewProvider, comments: string) => {
    setSavingTarget({ reviewId, provider });
    saveComment.mutate(
      { reviewId, provider, comments },
      {
        onSuccess: () => toast.success("Comments saved."),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save comments."),
        onSettled: () => setSavingTarget(null),
      },
    );
  };

  if (mode === "review") {
    return (
      <YoutubeReviewWorkspace
        activeMode={mode}
        batch={createBatch.data ?? latestBatch.data ?? null}
        isBusy={createBatch.isPending}
        isSavingComment={saveComment.isPending}
        onCreateBatch={handleCreateBatch}
        onModeChange={setMode}
        onNewReview={handleCreateBatch}
        onSaveComment={handleSaveComment}
        savingProvider={savingTarget?.provider ?? null}
        savingReviewId={savingTarget?.reviewId ?? null}
      />
    );
  }

  return (
    <ChatWorkspace
      activeMode={mode}
      job={currentJob}
      isBusy={Boolean(isBusy)}
      isCreating={createProject.isPending}
      jobs={projectJobs}
      onCreate={handleCreate}
      onModeChange={setMode}
      onMessage={handleMessage}
      onSelectProject={handleSelectProject}
      onTimelineEdit={handleTimelineEdit}
      onNewCreate={handleNewCreate}
      selectedProjectId={projectId}
    />
  );
}

