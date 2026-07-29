#!/usr/bin/env python3
"""Drive the youtube_clips workflow for a JSONL prompt set, saving only the
final videos plus per-prompt end-to-end timing."""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from urllib.request import Request, urlopen

API = "http://127.0.0.1:8000"
PROMPTS = Path("evals/youtube_headless_drive_prompts.jsonl")
OUT_DIR = Path(os.environ.get("BATCH_OUT_DIR", "outputs/youtube_headless_videos"))
LIMIT = int(os.environ.get("BATCH_LIMIT", "0"))


def http_json(method: str, url: str, payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode()
    req = Request(url, data=body, method=method, headers={"Accept": "application/json"})
    if body:
        req.add_header("Content-Type", "application/json")
    with urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    timings: list[dict] = []
    cases = [json.loads(line) for line in PROMPTS.read_text().splitlines() if line.strip()]
    if LIMIT:
        cases = cases[:LIMIT]
    for case in cases:
        settings = case.get("settings") or {}
        payload = {
            "prompt": case["prompt"],
            "workflow": "youtube_clips",
            "youtube_search_provider": "youtube_data_api",
            "duration_seconds": settings.get("duration_seconds"),
            "scene_count": settings.get("scene_count"),
            "aspect_ratio": settings.get("aspect_ratio", "9:16"),
            "resolution": settings.get("resolution", "720p"),
        }
        started = time.monotonic()
        created = http_json("POST", f"{API}/api/projects", payload)
        project_id = created["project_id"]
        status = "timeout"
        snapshot: dict = {}
        deadline = time.monotonic() + 15 * 60
        while time.monotonic() < deadline:
            time.sleep(5)
            snapshot = http_json("GET", f"{API}/api/projects/{project_id}")
            if snapshot.get("status") in {"succeeded", "failed"}:
                status = snapshot["status"]
                break
        elapsed = round(time.monotonic() - started, 1)
        manifest = snapshot.get("manifest") or {}
        final = manifest.get("final_video_path") or ""
        saved = ""
        if final and Path(final).exists():
            dest = OUT_DIR / f"{case['id']}__{case['name']}.mp4"
            shutil.copy(final, dest)
            saved = str(dest)
        row = {
            "id": case["id"],
            "name": case["name"],
            "status": status,
            "render_status": manifest.get("render_status") or "",
            "scenes_ok": manifest.get("completed_scene_count"),
            "scenes_failed": manifest.get("failed_scene_count"),
            "e2e_seconds": elapsed,
            "project_id": project_id,
            "video": saved,
        }
        timings.append(row)
        print(json.dumps(row), flush=True)
        (OUT_DIR / "timings.json").write_text(json.dumps(timings, indent=2))


if __name__ == "__main__":
    main()
