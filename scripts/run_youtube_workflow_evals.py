#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


PROVIDERS = ("youtube_data_api",)

SUMMARY_COLUMNS = [
    "prompt_id",
    "prompt_name",
    "category",
    "provider_requested",
    "status",
    "render_status",
    "project_id",
    "latency_seconds",
    "completed_scene_count",
    "failed_scene_count",
    "final_video_path",
    "final_video_url",
    "manifest_path",
    "contact_sheet_path",
    "gpt_cost_usd",
    "voiceover_duration_seconds",
    "planned_duration_seconds",
    "data_api_search_attempts",
    "yt_dlp_search_attempts",
    "data_api_key_aliases",
    "provider_used_counts",
    "major_failures",
    "notes",
    "prompt",
]

SCENE_COLUMNS = [
    "prompt_id",
    "prompt_name",
    "provider_requested",
    "project_id",
    "scene_id",
    "scene_index",
    "search_hint",
    "dialogue",
    "video_id",
    "youtube_url",
    "youtube_title",
    "youtube_channel",
    "youtube_published_at",
    "provider_used",
    "api_key_alias",
    "start_seconds",
    "end_seconds",
    "clip_duration_seconds",
    "window_source",
    "window_score",
    "window_text",
    "search_attempts_json",
    "asset_path",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
    return rows


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def http_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, method=method)
    request.add_header("Accept", "application/json")
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed with HTTP {exc.code}: {text}") from exc
    except URLError as exc:
        raise RuntimeError(f"{method} {url} failed: {exc}") from exc
    return json.loads(text) if text else {}


def normalize_api_base(raw: str) -> str:
    return raw.rstrip("/") + "/"


def project_url(api_base: str, status_url: str) -> str:
    if status_url.startswith(("http://", "https://")):
        return status_url
    return urljoin(api_base, status_url.lstrip("/"))


def manifest_has_terminal_video(manifest: dict[str, Any]) -> bool:
    if manifest.get("workflow") != "youtube_clips":
        return False
    if manifest.get("render_status") not in {"complete", "partial"}:
        return False
    if not manifest.get("videos"):
        return False
    final_video = str(manifest.get("final_video_path") or "")
    if final_video:
        return Path(final_video).exists()
    return bool(manifest.get("final_video_url"))


def snapshot_is_terminal(snapshot: dict[str, Any]) -> bool:
    if str(snapshot.get("status") or "") in {"succeeded", "failed"}:
        return True
    manifest = snapshot.get("manifest") or {}
    return isinstance(manifest, dict) and manifest_has_terminal_video(manifest)


def normalized_snapshot_status(snapshot: dict[str, Any]) -> str:
    if str(snapshot.get("status") or "") in {"succeeded", "failed"}:
        return str(snapshot.get("status"))
    manifest = snapshot.get("manifest") or {}
    if isinstance(manifest, dict) and manifest_has_terminal_video(manifest):
        return "succeeded"
    return str(snapshot.get("status") or "unknown")


def payload_for(case: dict[str, Any], provider: str) -> dict[str, Any]:
    settings = dict(case.get("settings") or {})
    return {
        "prompt": case["prompt"],
        "workflow": "youtube_clips",
        "youtube_search_provider": provider,
        "duration_seconds": settings.get("duration_seconds"),
        "scene_count": settings.get("scene_count"),
        "aspect_ratio": settings.get("aspect_ratio", "9:16"),
        "resolution": settings.get("resolution", "720p"),
    }


def extract_contact_sheet(final_video: str, out_path: Path) -> str:
    if not final_video or not Path(final_video).exists():
        return ""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        final_video,
        "-vf",
        "fps=1,scale=360:-1,tile=5x5",
        str(out_path),
    ]
    try:
        subprocess.run(command, check=True, timeout=120)
    except Exception:
        return ""
    return str(out_path)


def scene_lookup(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    scenes = ((manifest.get("plan") or {}).get("scenes") or [])
    return {str(scene.get("id")): scene for scene in scenes if isinstance(scene, dict)}


def summarize_attempts(videos: list[dict[str, Any]]) -> tuple[int, int, str, str]:
    data_api = 0
    ytdlp = 0
    key_aliases: set[str] = set()
    provider_counts: dict[str, int] = {}
    for video in videos:
        provider = str(video.get("youtube_search_provider") or "")
        if provider:
            provider_counts[provider] = provider_counts.get(provider, 0) + 1
        if video.get("youtube_api_key_alias"):
            key_aliases.add(str(video["youtube_api_key_alias"]))
        benchmark = video.get("youtube_search_benchmark") or {}
        for attempt in benchmark.get("attempts") or []:
            attempt_provider = str(attempt.get("provider") or "")
            if attempt_provider == "youtube_data_api":
                data_api += 1
            elif attempt_provider == "yt_dlp":
                ytdlp += 1
    return data_api, ytdlp, ",".join(sorted(key_aliases)), json.dumps(provider_counts, sort_keys=True)


def rows_for_scenes(case: dict[str, Any], provider: str, project_id: str, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    scenes = scene_lookup(manifest)
    rows: list[dict[str, Any]] = []
    for video in manifest.get("videos") or []:
        scene_id = str(video.get("scene_id") or "")
        scene = scenes.get(scene_id, {})
        window = video.get("window_match") or {}
        benchmark = video.get("youtube_search_benchmark") or {}
        rows.append(
            {
                "prompt_id": case["id"],
                "prompt_name": case["name"],
                "provider_requested": provider,
                "project_id": project_id,
                "scene_id": scene_id,
                "scene_index": scene_id.replace("scene_", ""),
                "search_hint": video.get("search_hint") or video.get("prompt") or scene.get("image_prompt") or "",
                "dialogue": scene.get("narration") or "",
                "video_id": video.get("video_id") or "",
                "youtube_url": video.get("youtube_url") or "",
                "youtube_title": video.get("youtube_title") or "",
                "youtube_channel": video.get("youtube_channel") or "",
                "youtube_published_at": video.get("youtube_published_at") or "",
                "provider_used": video.get("youtube_search_provider") or "",
                "api_key_alias": video.get("youtube_api_key_alias") or "",
                "start_seconds": video.get("start_seconds") or "",
                "end_seconds": video.get("end_seconds") or "",
                "clip_duration_seconds": video.get("duration_seconds") or "",
                "window_source": window.get("source") or "",
                "window_score": window.get("score") or "",
                "window_text": window.get("text") or "",
                "search_attempts_json": json.dumps(benchmark.get("attempts") or [], sort_keys=True),
                "asset_path": video.get("path") or "",
            }
        )
    return rows


def run_case(case: dict[str, Any], provider: str, args: argparse.Namespace, out_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    api_base = normalize_api_base(args.api_base)
    request_payload = payload_for(case, provider)
    case_key = f"{case['id']}__{provider}"
    write_json(out_dir / "requests" / f"{case_key}.json", request_payload)

    started = time.monotonic()
    created = http_json("POST", urljoin(api_base, "api/projects"), request_payload, timeout=args.request_timeout_seconds)
    project_id = str(created["project_id"])
    status_url = project_url(api_base, str(created["status_url"]))
    write_json(out_dir / "status_snapshots" / f"{case_key}-created.json", created)

    latest = created
    deadline = time.monotonic() + args.timeout_minutes * 60
    while time.monotonic() < deadline:
        latest = http_json("GET", status_url, timeout=args.request_timeout_seconds)
        if snapshot_is_terminal(latest):
            break
        time.sleep(args.poll_interval_seconds)

    latency = time.monotonic() - started
    write_json(out_dir / "status_snapshots" / f"{case_key}-final.json", latest)

    status = normalized_snapshot_status(latest)
    manifest = latest.get("manifest") or {}
    project_state = latest.get("project_state") or {}
    if manifest:
        write_json(out_dir / "manifests" / f"{case_key}.json", manifest)

    videos = manifest.get("videos") or []
    data_api_attempts, ytdlp_attempts, key_aliases, provider_counts = summarize_attempts(videos)
    final_video = str(manifest.get("final_video_path") or "")
    contact_sheet = extract_contact_sheet(final_video, out_dir / "contact_sheets" / f"{case_key}.jpg")
    failed_scenes = manifest.get("failed_scenes") or project_state.get("failures") or []
    major_failures = ""
    state_status = project_state.get("status") or {}
    if state_status.get("error"):
        major_failures = str(state_status["error"])
    elif latest.get("error"):
        major_failures = str(latest["error"])
    elif failed_scenes:
        major_failures = json.dumps(failed_scenes, sort_keys=True)

    summary = {
        "prompt_id": case["id"],
        "prompt_name": case["name"],
        "category": case.get("category") or "",
        "provider_requested": provider,
        "status": status,
        "render_status": manifest.get("render_status") or "",
        "project_id": project_id,
        "latency_seconds": f"{latency:.1f}",
        "completed_scene_count": manifest.get("completed_scene_count") or len(videos),
        "failed_scene_count": manifest.get("failed_scene_count") or len(failed_scenes),
        "final_video_path": final_video,
        "final_video_url": manifest.get("final_video_url") or "",
        "manifest_path": manifest.get("manifest_path") or "",
        "contact_sheet_path": contact_sheet,
        "gpt_cost_usd": manifest.get("gpt_cost_usd") or "",
        "voiceover_duration_seconds": ((manifest.get("narration_stats") or {}).get("voiceover_duration_seconds") or ""),
        "planned_duration_seconds": sum(scene.get("duration_seconds", 0) for scene in ((manifest.get("plan") or {}).get("scenes") or [])),
        "data_api_search_attempts": data_api_attempts,
        "yt_dlp_search_attempts": ytdlp_attempts,
        "data_api_key_aliases": key_aliases,
        "provider_used_counts": provider_counts,
        "major_failures": major_failures,
        "notes": str(latest.get("message") or ""),
        "prompt": case["prompt"],
    }
    return summary, rows_for_scenes(case, provider, project_id, manifest)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run live YouTube workflow evals against the local API.")
    parser.add_argument("--prompts", type=Path, default=Path("evals/youtube_workflow_eval_prompts.jsonl"))
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--api-base", default="http://127.0.0.1:8000")
    parser.add_argument("--providers", default="youtube_data_api")
    parser.add_argument("--ids", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--poll-interval-seconds", type=int, default=10)
    parser.add_argument("--timeout-minutes", type=int, default=45)
    parser.add_argument("--request-timeout-seconds", type=int, default=60)
    return parser.parse_args()


def select_cases(cases: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.ids:
        wanted = {item.strip() for item in args.ids.split(",") if item.strip()}
        cases = [case for case in cases if case["id"] in wanted]
    if args.limit:
        cases = cases[: args.limit]
    return cases


def main() -> int:
    args = parse_args()
    providers = [item.strip() for item in args.providers.split(",") if item.strip()]
    bad = [provider for provider in providers if provider not in PROVIDERS]
    if bad:
        raise SystemExit(f"Unsupported provider(s): {', '.join(bad)}")

    cases = select_cases(read_jsonl(args.prompts), args)
    if not cases:
        raise SystemExit("No eval cases selected.")

    run_id = datetime.now(timezone.utc).strftime("youtube_live_%Y%m%dT%H%M%SZ")
    out_dir = args.out_dir or Path("evals/runs") / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    write_json(
        out_dir / "run_config.json",
        {
            "created_at": utc_now(),
            "api_base": args.api_base,
            "prompts": str(args.prompts),
            "providers": providers,
            "case_ids": [case["id"] for case in cases],
        },
    )

    summary_rows: list[dict[str, Any]] = []
    scene_rows: list[dict[str, Any]] = []
    for case in cases:
        for provider in providers:
            print(f"{case['id']} {provider} {case['name']}", flush=True)
            try:
                summary, scenes = run_case(case, provider, args, out_dir)
            except Exception as exc:
                summary = {
                    "prompt_id": case["id"],
                    "prompt_name": case["name"],
                    "category": case.get("category") or "",
                    "provider_requested": provider,
                    "status": "error",
                    "major_failures": str(exc),
                    "prompt": case["prompt"],
                }
                scenes = []
                print(f"  error: {exc}", file=sys.stderr, flush=True)
            summary_rows.append(summary)
            scene_rows.extend(scenes)
            write_csv(out_dir / "summary.csv", summary_rows, SUMMARY_COLUMNS)
            write_csv(out_dir / "scenes.csv", scene_rows, SCENE_COLUMNS)
            write_json(out_dir / "summary.json", summary_rows)
            write_json(out_dir / "scenes.json", scene_rows)

    print(f"wrote {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
