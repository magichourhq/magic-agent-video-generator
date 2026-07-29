"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Youtube,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  YouTubeReviewBatchItem,
  YouTubeReviewBatchResponse,
  YouTubeReviewProvider,
  YouTubeReviewProviderResult,
  YouTubeReviewSessionResponse,
} from "@/lib/types";

type AppMode = "review" | "compose";

const PROVIDERS: Array<{
  value: YouTubeReviewProvider;
  label: string;
  shortLabel: string;
  icon: typeof Database;
}> = [
  { value: "youtube_data_api", label: "YouTube Data API", shortLabel: "Data API", icon: Database },
];

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "Waiting";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function providerStatusLabel(provider: YouTubeReviewProviderResult | undefined) {
  if (!provider?.status) return "Queued";
  if (providerHasVideo(provider)) {
    return provider.failed_scene_count ? "Partial" : "Ready";
  }
  if (provider.status.status === "succeeded") {
    return provider.failed_scene_count ? "Partial" : "Ready";
  }
  if (provider.status.status === "failed") return "Failed";
  if (provider.status.status === "running") return "Running";
  return "Queued";
}

function providerStatusTone(provider: YouTubeReviewProviderResult | undefined) {
  if (providerHasVideo(provider)) {
    return provider?.failed_scene_count
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  const status = provider?.status?.status;
  if (status === "succeeded" && provider?.failed_scene_count) return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-sky-200 bg-sky-50 text-sky-700";
}

function providerError(provider: YouTubeReviewProviderResult | undefined) {
  if (!provider?.status) return null;
  const error = provider.status.error;
  if (error) return error;
  const failures = provider.status.manifest?.failed_scenes ?? [];
  return failures.length ? failures.map((failure) => `${failure.scene_id}: ${failure.error}`).join("\n") : null;
}

function readablePromptName(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function providerHasVideo(provider: YouTubeReviewProviderResult | undefined) {
  return Boolean(provider?.final_video_url || provider?.final_video_path);
}

function reviewIsRunning(review: YouTubeReviewSessionResponse | null | undefined) {
  return Object.values(review?.providers ?? {}).some(
    (provider) => !providerHasVideo(provider) && (provider.status?.status === "queued" || provider.status?.status === "running"),
  );
}

function itemStatus(item: YouTubeReviewBatchItem) {
  const providers = Object.values(item.review?.providers ?? {});
  if (!providers.length) return "Queued";
  if (providers.some((provider) => !providerHasVideo(provider) && (provider.status?.status === "running" || provider.status?.status === "queued"))) {
    return "Running";
  }
  if (providers.some((provider) => provider.status?.status === "failed")) return "Needs review";
  if (providers.some((provider) => provider.failed_scene_count)) return "Partial";
  return "Ready";
}

function itemStatusTone(item: YouTubeReviewBatchItem) {
  const status = itemStatus(item);
  if (status === "Ready") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "Partial") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "Needs review") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-sky-200 bg-sky-50 text-sky-700";
}

function batchProgress(batch: YouTubeReviewBatchResponse | null) {
  const providers = (batch?.items ?? []).flatMap((item) => Object.values(item.review?.providers ?? {}));
  const ready = providers.filter((provider) => providerHasVideo(provider)).length;
  const failed = providers.filter((provider) => provider.status?.status === "failed").length;
  return { ready, failed, total: providers.length };
}

export function YoutubeReviewWorkspace({
  activeMode,
  batch,
  isBusy,
  isSavingComment,
  onCreateBatch,
  onModeChange,
  onNewReview,
  onSaveComment,
  savingProvider,
  savingReviewId,
}: {
  activeMode: AppMode;
  batch: YouTubeReviewBatchResponse | null;
  isBusy: boolean;
  isSavingComment: boolean;
  onCreateBatch: () => void;
  onModeChange: (mode: AppMode) => void;
  onNewReview: () => void;
  onSaveComment: (reviewId: string, provider: YouTubeReviewProvider, comments: string) => void;
  savingProvider: YouTubeReviewProvider | null;
  savingReviewId: string | null;
}) {
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<YouTubeReviewProvider, string>>({
    youtube_data_api: "",
    yt_dlp: "",
  });

  const selectedItem = useMemo(() => {
    if (!batch?.items.length) return null;
    return batch.items.find((item) => item.review_id === selectedReviewId) ?? batch.items[0];
  }, [batch?.items, selectedReviewId]);
  const selectedReview = selectedItem?.review ?? null;
  const providers = selectedReview?.providers ?? null;
  const summary = batchProgress(batch);

  useEffect(() => {
    if (!batch?.items.length) {
      setSelectedReviewId(null);
      return;
    }
    const stillExists = selectedReviewId ? batch.items.some((item) => item.review_id === selectedReviewId) : false;
    if (!stillExists) {
      setSelectedReviewId(batch.items[0].review_id);
    }
  }, [batch?.batch_id, batch?.items, selectedReviewId]);

  useEffect(() => {
    if (!selectedReview) {
      setComments({ youtube_data_api: "", yt_dlp: "" });
      return;
    }
    setComments({
      youtube_data_api: selectedReview.providers.youtube_data_api?.comments ?? "",
      yt_dlp: selectedReview.providers.yt_dlp?.comments ?? "",
    });
  }, [selectedReview?.review_id]);

  const selectedSettings = selectedItem?.settings;

  return (
    <main className="min-h-screen bg-workspace-grid text-slate-900 selection:bg-slate-300/60 selection:text-slate-900">
      <header className="flex h-16 items-center justify-between border-b border-white/70 bg-white/65 px-5 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-mark text-white shadow-soft-panel">
            <Youtube className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold">YouTube Prompt Review</h1>
            <p className="truncate text-xs text-slate-500">Saved eval prompts via the YouTube Data API</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="grid grid-cols-2 rounded-full border border-slate-200 bg-white/75 p-1 text-xs font-bold text-slate-500">
            {(["review", "compose"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onModeChange(mode)}
                className={cn(
                  "h-8 rounded-full px-3 transition",
                  activeMode === mode ? "bg-slate-900 text-white shadow-sm" : "hover:bg-white",
                )}
              >
                {mode === "review" ? "Review" : "Composer"}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNewReview}
            className="gap-1.5 border-slate-300 bg-white/75 text-slate-700 hover:bg-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-4rem)] gap-4 p-4 xl:grid-cols-[390px_minmax(0,1fr)]">
        <section className="glass-panel grid min-h-0 grid-rows-[auto_1fr_auto] overflow-hidden rounded-[14px]">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white/55 px-4 py-3">
            <div>
              <h2 className="text-sm font-bold">Prompt Set</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {batch ? `${batch.items.length} prompts loaded` : "No generated set loaded"}
              </p>
            </div>
            {summary.total > 0 && (
              <span className="rounded-full border border-slate-200 bg-white/70 px-2 py-1 text-[11px] font-bold text-slate-700">
                {summary.ready}/{summary.total} videos
              </span>
            )}
          </div>

          <div className="custom-scrollbar min-h-0 space-y-3 overflow-y-auto p-4">
            {!batch ? (
              <div className="rounded-[14px] border border-slate-200 bg-white/75 p-4">
                <p className="text-sm font-bold text-slate-800">Generate the saved prompt set.</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  This queues a fresh Data API run for every prompt in the eval JSONL. Videos appear here as each run completes.
                </p>
              </div>
            ) : (
              batch.items.map((item, index) => (
                <button
                  key={item.review_id}
                  type="button"
                  onClick={() => setSelectedReviewId(item.review_id)}
                  className={cn(
                    "w-full rounded-[14px] border p-3 text-left transition",
                    selectedItem?.review_id === item.review_id
                      ? "border-slate-300 bg-white shadow-sm"
                      : "border-slate-200 bg-white/62 hover:bg-white/86",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-black text-slate-800">
                      {index + 1}. {readablePromptName(item.name)}
                    </p>
                    <span className={cn("shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold", itemStatusTone(item))}>
                      {itemStatus(item)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8e7899]">{item.category}</p>
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-[#6b4b78]">{item.prompt}</p>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-slate-200 bg-white/45 p-3">
            <Button
              type="button"
              onClick={onCreateBatch}
              disabled={isBusy}
              className="h-10 w-full gap-2 rounded-xl bg-slate-900 text-white hover:opacity-90"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Generate fresh set
            </Button>
            {batch && (
              <p className="mt-2 truncate text-[11px] text-[#8e7899]">
                Batch {batch.batch_id.slice(0, 8)} from {batch.prompt_set_path}
              </p>
            )}
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[auto_1fr] gap-4">
          <div className="glass-panel rounded-[14px] p-4">
            {selectedItem ? (
              <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-black text-slate-800">{readablePromptName(selectedItem.name)}</h2>
                    <span className={cn("rounded-full border px-2 py-1 text-[10px] font-bold", itemStatusTone(selectedItem))}>
                      {itemStatus(selectedItem)}
                    </span>
                    {reviewIsRunning(selectedReview) && <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-800">{selectedItem.prompt}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs lg:min-w-[300px]">
                  <Metric label="Seconds" value={String(selectedSettings?.duration_seconds ?? "Auto")} />
                  <Metric label="Scenes" value={String(selectedSettings?.scene_count ?? "Auto")} />
                  <Metric label="Output" value={`${selectedSettings?.aspect_ratio ?? "9:16"} ${selectedSettings?.resolution ?? "720p"}`} />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-black text-slate-800">No prompt selected</h2>
                  <p className="mt-1 text-sm text-slate-500">Generate a fresh set to start reviewing videos.</p>
                </div>
              </div>
            )}
          </div>

          <div className="grid min-h-0 gap-4 lg:grid-cols-2">
            {PROVIDERS.map((providerMeta) => (
              <ProviderReviewPanel
                key={providerMeta.value}
                comments={comments[providerMeta.value]}
                hasSession={Boolean(selectedReview?.review_id)}
                isSaving={isSavingComment && savingProvider === providerMeta.value && savingReviewId === selectedReview?.review_id}
                onCommentsChange={(value) => setComments((current) => ({ ...current, [providerMeta.value]: value }))}
                onSave={() => {
                  if (selectedReview?.review_id) {
                    onSaveComment(selectedReview.review_id, providerMeta.value, comments[providerMeta.value]);
                  }
                }}
                provider={providers?.[providerMeta.value]}
                providerMeta={providerMeta}
              />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function ProviderReviewPanel({
  comments,
  hasSession,
  isSaving,
  onCommentsChange,
  onSave,
  provider,
  providerMeta,
}: {
  comments: string;
  hasSession: boolean;
  isSaving: boolean;
  onCommentsChange: (value: string) => void;
  onSave: () => void;
  provider?: YouTubeReviewProviderResult;
  providerMeta: (typeof PROVIDERS)[number];
}) {
  const Icon = providerMeta.icon;
  const source = mediaUrl(provider?.final_video_url ?? provider?.final_video_path);
  const statusLabel = providerStatusLabel(provider);
  const error = providerError(provider);
  const isRunning = provider?.status?.status === "queued" || provider?.status?.status === "running" || (!provider && hasSession);

  return (
    <article className="glass-panel grid min-h-[620px] grid-rows-[auto_minmax(260px,1fr)_auto] overflow-hidden rounded-[14px]">
      <div className="border-b border-slate-200 bg-white/55 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-200 bg-white/80 text-slate-700">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold">{providerMeta.label}</h2>
              <p className="truncate text-xs text-slate-500">{provider?.project_id ?? "Not started"}</p>
            </div>
          </div>
          <span className={cn("rounded-full border px-2 py-1 text-[11px] font-bold", providerStatusTone(provider))}>
            {statusLabel}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <Metric label="Time" value={formatDuration(provider?.latency_seconds)} icon={<Clock className="h-3.5 w-3.5" />} />
          <Metric
            label="Scenes"
            value={`${provider?.completed_scene_count ?? 0}/${(provider?.completed_scene_count ?? 0) + (provider?.failed_scene_count ?? 0) || "-"}`}
          />
          <Metric label="Render" value={provider?.render_status ?? "-"} />
        </div>
      </div>

      <div className="grid min-h-0 bg-[#1d1524]">
        {source ? (
          <video className="h-full max-h-[calc(100vh-17rem)] min-h-[260px] w-full bg-black object-contain" src={source} controls />
        ) : (
          <div className="grid min-h-[260px] place-items-center p-6 text-center text-white/78">
            <div className="grid justify-items-center gap-3">
              {isRunning ? <Loader2 className="h-8 w-8 animate-spin text-sky-200" /> : <Youtube className="h-8 w-8 text-white/70" />}
              <div>
                <p className="text-sm font-bold">{hasSession ? provider?.status?.message ?? "Waiting for video" : "Generate a prompt set"}</p>
                <p className="mt-1 max-w-sm text-xs leading-5 text-white/58">{hasSession ? provider?.status?.stage ?? "queued" : providerMeta.shortLabel}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-slate-200 bg-white/55 p-4">
        {error && (
          <div className="flex gap-2 rounded-[12px] border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p className="line-clamp-4 whitespace-pre-line">{error}</p>
          </div>
        )}

        <label className="grid gap-2">
          <span className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
            <MessageSquare className="h-3.5 w-3.5" />
            Comments
          </span>
          <textarea
            value={comments}
            onChange={(event) => onCommentsChange(event.target.value)}
            className="min-h-[118px] rounded-[12px] border border-slate-200 bg-white/90 p-3 text-sm leading-6 text-slate-900 outline-none focus:border-slate-400"
            placeholder="Write what works, what misses, and whether the clip matches the narration."
            disabled={!hasSession}
          />
        </label>

        <Button
          type="button"
          onClick={onSave}
          disabled={!hasSession || isSaving}
          className="h-10 w-full gap-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800"
        >
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save comments
        </Button>

        {provider?.comments_updated_at && (
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved {new Date(provider.comments_updated_at).toLocaleTimeString()}
          </div>
        )}
      </div>
    </article>
  );
}

function Metric({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[12px] border border-slate-200 bg-white/75 px-2 py-2">
      <p className="flex items-center gap-1 truncate text-[11px] font-bold text-[#8e7899]">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate text-xs font-black text-slate-800">{value}</p>
    </div>
  );
}
