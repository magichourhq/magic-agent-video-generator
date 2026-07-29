#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


DEFAULT_IMAGE_MODEL = "seedream-v4"
DEFAULT_VIDEO_MODEL = "ltx-2"

COMPETITORS = [
    {
        "name": "local-video-agent",
        "image_model": DEFAULT_IMAGE_MODEL,
        "video_model": DEFAULT_VIDEO_MODEL,
        "model_policy": "seedream-v4 image + ltx-2 video",
        "default_status": "local",
        "notes": "Runs through the local FastAPI agent.",
    },
    {
        "name": "Krea LTX-2",
        "image_model": "",
        "video_model": DEFAULT_VIDEO_MODEL,
        "model_policy": "ltx-2 text-to-video; no seedream image stage",
        "default_status": "not_run",
        "notes": "Krea has an LTX-2 model page/workflow. Use this as the strict external LTX-2 UI baseline.",
    },
    {
        "name": "Focal",
        "image_model": "",
        "video_model": "",
        "model_policy": "no exposed seedream-v4 or ltx-2 selector found",
        "default_status": "skipped_model_unavailable",
        "notes": "Skip for strict model-controlled eval. Keep only if doing product-level UX comparison.",
    },
    {
        "name": "InVideo AI",
        "image_model": "",
        "video_model": "",
        "model_policy": "no exposed seedream-v4 or ltx-2 selector found",
        "default_status": "skipped_model_unavailable",
        "notes": "Skip for strict model-controlled eval. Keep only if doing product-level UX comparison.",
    },
    {
        "name": "VideoGen",
        "image_model": "",
        "video_model": "",
        "model_policy": "no exposed seedream-v4 or ltx-2 selector found",
        "default_status": "skipped_model_unavailable",
        "notes": "Skip for strict model-controlled eval. Keep only if doing product-level UX comparison.",
    },
    {
        "name": "Runway",
        "image_model": "",
        "video_model": "",
        "model_policy": "Runway Gen-4, not ltx-2",
        "default_status": "skipped_model_unavailable",
        "notes": "Skip for strict LTX-2 eval.",
    },
    {
        "name": "Kling AI",
        "image_model": "",
        "video_model": "",
        "model_policy": "Kling models, not ltx-2",
        "default_status": "skipped_model_unavailable",
        "notes": "Skip for strict LTX-2 eval.",
    },
]

WEIGHTS = {
    "prompt_adherence_1_5": 20,
    "story_coherence_1_5": 20,
    "visual_quality_1_5": 20,
    "motion_quality_1_5": 15,
    "narration_audio_1_5": 10,
    "finishedness_1_5": 10,
    "editability_1_5": 5,
}

CSV_COLUMNS = [
    "prompt_id",
    "prompt_name",
    "category",
    "competitor",
    "image_model",
    "video_model",
    "model_policy",
    "run_date",
    "status",
    "project_id",
    "output_url_or_path",
    "manifest_path",
    "settings_used",
    "latency_minutes",
    "estimated_cost_or_credits",
    "usable_first_try",
    *WEIGHTS.keys(),
    "weighted_score_100",
    "major_failures",
    "notes",
    "prompt",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Invalid JSONL at {path}:{line_number}: {exc}") from exc
    return rows


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


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
    if status_url.startswith("http://") or status_url.startswith("https://"):
        return status_url
    return urljoin(api_base, status_url.lstrip("/"))


def local_agent_payload(case: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    settings = dict(case.get("settings") or {})
    payload: dict[str, Any] = {
        "prompt": case["prompt"],
        "duration_seconds": settings.get("duration_seconds"),
        "scene_count": settings.get("scene_count"),
        "aspect_ratio": settings.get("aspect_ratio", "9:16"),
        "resolution": settings.get("resolution", "720p"),
        "image_model": args.image_model,
        "image_resolution": args.image_resolution,
        "video_model": args.video_model,
        "video_resolution": args.video_resolution,
    }
    return {key: value for key, value in payload.items() if value is not None}


def settings_for_row(case: dict[str, Any], *, image_model: str | None, video_model: str | None) -> str:
    settings = dict(case.get("settings") or {})
    if image_model:
        settings["image_model"] = image_model
    if video_model:
        settings["video_model"] = video_model
    return json.dumps(settings, sort_keys=True)


def blank_result_row(
    case: dict[str, Any],
    competitor: str,
    *,
    image_model: str | None = "",
    video_model: str | None = "",
    model_policy: str = "",
) -> dict[str, Any]:
    return {
        "prompt_id": case["id"],
        "prompt_name": case["name"],
        "category": case["category"],
        "competitor": competitor,
        "image_model": image_model or "",
        "video_model": video_model or "",
        "model_policy": model_policy,
        "run_date": "",
        "status": "",
        "project_id": "",
        "output_url_or_path": "",
        "manifest_path": "",
        "settings_used": settings_for_row(case, image_model=image_model, video_model=video_model),
        "latency_minutes": "",
        "estimated_cost_or_credits": "",
        "usable_first_try": "",
        **{column: "" for column in WEIGHTS},
        "weighted_score_100": "",
        "major_failures": "",
        "notes": "",
        "prompt": case["prompt"],
    }


def local_agent_result_row(
    case: dict[str, Any],
    *,
    status: str,
    project_id: str = "",
    output_url_or_path: str = "",
    manifest_path: str = "",
    latency_minutes: float | None = None,
    estimated_cost: float | None = None,
    major_failures: str = "",
    notes: str = "",
) -> dict[str, Any]:
    row = blank_result_row(
        case,
        "local-video-agent",
        image_model=DEFAULT_IMAGE_MODEL,
        video_model=DEFAULT_VIDEO_MODEL,
        model_policy="seedream-v4 image + ltx-2 video",
    )
    row.update(
        {
            "run_date": utc_now(),
            "status": status,
            "project_id": project_id,
            "output_url_or_path": output_url_or_path,
            "manifest_path": manifest_path,
            "latency_minutes": "" if latency_minutes is None else f"{latency_minutes:.2f}",
            "estimated_cost_or_credits": "" if estimated_cost is None else f"${estimated_cost:.6f}",
            "usable_first_try": "yes" if status in {"succeeded", "partial"} and not major_failures else "no",
            "major_failures": major_failures,
            "notes": notes,
        }
    )
    return row


def run_local_agent_case(case: dict[str, Any], args: argparse.Namespace, out_dir: Path) -> dict[str, Any]:
    api_base = normalize_api_base(args.api_base)
    payload = local_agent_payload(case, args)
    write_json(out_dir / "requests" / f"{case['id']}.json", payload)

    start = time.monotonic()
    created = http_json("POST", urljoin(api_base, "api/projects"), payload, timeout=args.request_timeout_seconds)
    project_id = created["project_id"]
    status_url = project_url(api_base, created["status_url"])
    write_json(out_dir / "status_snapshots" / f"{case['id']}-created.json", created)

    deadline = time.monotonic() + args.timeout_minutes * 60
    latest = created
    while time.monotonic() < deadline:
        latest = http_json("GET", status_url, timeout=args.request_timeout_seconds)
        if latest.get("status") in {"succeeded", "failed"}:
            break
        time.sleep(args.poll_interval_seconds)

    latency_minutes = (time.monotonic() - start) / 60
    write_json(out_dir / "status_snapshots" / f"{case['id']}-final.json", latest)

    status = str(latest.get("status") or "unknown")
    manifest = latest.get("manifest") or {}
    manifest_path = str(manifest.get("manifest_path") or "")
    final_url = str(manifest.get("final_video_url") or manifest.get("final_video_path") or "")
    cost = manifest.get("gpt_cost_usd")
    render_status = manifest.get("render_status")
    failed_scene_count = int(manifest.get("failed_scene_count") or 0)
    failures = manifest.get("failed_scenes") or []

    if manifest:
        write_json(out_dir / "manifests" / f"{case['id']}.json", manifest)

    if status == "succeeded" and render_status == "partial":
        row_status = "partial"
    else:
        row_status = status

    major_failures = ""
    if latest.get("error"):
        major_failures = str(latest["error"])
    elif failed_scene_count:
        major_failures = json.dumps(failures, sort_keys=True)

    notes = f"render_status={render_status or ''}; message={latest.get('message', '')}"
    return local_agent_result_row(
        case,
        status=row_status,
        project_id=project_id,
        output_url_or_path=final_url,
        manifest_path=manifest_path,
        latency_minutes=latency_minutes,
        estimated_cost=float(cost) if isinstance(cost, int | float) else None,
        major_failures=major_failures,
        notes=notes,
    )


def weighted_score(row: dict[str, Any]) -> str:
    total = 0.0
    for column, weight in WEIGHTS.items():
        raw = row.get(column)
        if raw in {"", None}:
            return ""
        total += float(raw) * weight
    return f"{total / 5:.1f}"


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    for row in rows:
        row["weighted_score_100"] = weighted_score(row)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def selected_cases(cases: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.ids:
        wanted = {item.strip() for item in args.ids.split(",") if item.strip()}
        cases = [case for case in cases if case["id"] in wanted]
    if args.limit:
        cases = cases[: args.limit]
    return cases


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the video benchmark against the local Video Agent API.")
    parser.add_argument("--prompts", type=Path, default=Path("evals/video_generation_benchmark_prompts.jsonl"))
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--api-base", default="http://127.0.0.1:8000")
    parser.add_argument("--ids", default="", help="Comma-separated prompt IDs to run.")
    parser.add_argument("--limit", type=int, default=0, help="Run only the first N selected prompts.")
    parser.add_argument("--execute", action="store_true", help="Actually submit local-agent jobs. Without this, only writes a dry-run sheet.")
    parser.add_argument("--poll-interval-seconds", type=int, default=10)
    parser.add_argument("--timeout-minutes", type=int, default=45)
    parser.add_argument("--request-timeout-seconds", type=int, default=60)
    parser.add_argument("--image-model", default=DEFAULT_IMAGE_MODEL)
    parser.add_argument("--image-resolution", default=None)
    parser.add_argument("--video-model", default=DEFAULT_VIDEO_MODEL)
    parser.add_argument("--video-resolution", default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cases = selected_cases(read_jsonl(args.prompts), args)
    if not cases:
        print("No benchmark cases selected.", file=sys.stderr)
        return 2

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = args.out_dir or Path("evals/runs") / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    write_json(
        out_dir / "run_config.json",
        {
            "created_at": utc_now(),
            "execute": args.execute,
            "api_base": args.api_base,
            "prompts": str(args.prompts),
            "case_ids": [case["id"] for case in cases],
        },
    )

    rows: list[dict[str, Any]] = []
    for case in cases:
        print(f"{case['id']} {case['name']}")
        if args.execute:
            try:
                rows.append(run_local_agent_case(case, args, out_dir))
            except Exception as exc:
                rows.append(local_agent_result_row(case, status="error", major_failures=str(exc)))
                print(f"  local-video-agent error: {exc}", file=sys.stderr)
        else:
            row = blank_result_row(
                case,
                "local-video-agent",
                image_model=args.image_model,
                video_model=args.video_model,
                model_policy="seedream-v4 image + ltx-2 video",
            )
            row.update({"run_date": utc_now(), "status": "dry_run", "notes": "Run with --execute to submit to local Video Agent API."})
            rows.append(row)

        for competitor in COMPETITORS:
            if competitor["name"] == "local-video-agent":
                continue
            row = blank_result_row(
                case,
                competitor["name"],
                image_model=competitor["image_model"],
                video_model=competitor["video_model"],
                model_policy=competitor["model_policy"],
            )
            row.update({"status": competitor["default_status"], "notes": competitor["notes"]})
            rows.append(row)

    csv_path = out_dir / "comparison_results.csv"
    write_csv(csv_path, rows)
    write_json(out_dir / "comparison_results.json", rows)
    print(f"wrote {csv_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
