#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus


STRICT_TARGETS = {"local-video-agent", "krea-ltx2"}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def read_targets(path: Path, include_skipped: bool) -> list[dict[str, Any]]:
    targets = json.loads(path.read_text(encoding="utf-8"))
    if include_skipped:
        return targets
    return [target for target in targets if target["id"] in STRICT_TARGETS]


def demo_url() -> str:
    path = Path(".run-logs/demo-url.txt")
    if path.exists():
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    return "http://127.0.0.1:3000"


def resolve_url(target: dict[str, Any], case: dict[str, Any]) -> str:
    if target.get("url") == "AUTO_DEMO_URL":
        return demo_url()
    if target.get("url_template"):
        return str(target["url_template"]).format(prompt=quote_plus(case["prompt"]))
    return str(target["url"])


def osa_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def open_safari_tabs(targets: list[dict[str, Any]], case: dict[str, Any]) -> None:
    commands = ['tell application "Safari"', "activate"]
    first = True
    for target in targets:
        url = osa_string(resolve_url(target, case))
        if first:
            commands.append(f'make new document with properties {{URL:"{url}"}}')
            first = False
        else:
            commands.append('tell front window')
            commands.append(f'make new tab at end of tabs with properties {{URL:"{url}"}}')
            commands.append("end tell")
    commands.append("end tell")
    subprocess.run(["osascript", "-e", "\n".join(commands)], check=True)


def copy_to_clipboard(text: str) -> None:
    subprocess.run("pbcopy", input=text.encode("utf-8"), check=True)


def write_queue(path: Path, case: dict[str, Any], targets: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["prompt_id", "target_id", "target_name", "url", "model_policy", "automation_status", "notes", "prompt"],
        )
        writer.writeheader()
        for target in targets:
            writer.writerow(
                {
                    "prompt_id": case["id"],
                    "target_id": target["id"],
                    "target_name": target["name"],
                    "url": resolve_url(target, case),
                    "model_policy": target["model_policy"],
                    "automation_status": target["automation_status"],
                    "notes": target["notes"],
                    "prompt": case["prompt"],
                }
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Open Safari tabs for browser-based video benchmark targets.")
    parser.add_argument("--prompts", type=Path, default=Path("evals/video_generation_benchmark_prompts.jsonl"))
    parser.add_argument("--targets", type=Path, default=Path("evals/browser_targets.json"))
    parser.add_argument("--case-id", default="vg-bench-001")
    parser.add_argument("--include-skipped", action="store_true", help="Also open product-level targets without seedream-v4/LTX-2 control.")
    parser.add_argument("--no-open", action="store_true", help="Only write queue/copy prompt; do not open Safari.")
    parser.add_argument("--out-dir", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cases = {case["id"]: case for case in read_jsonl(args.prompts)}
    if args.case_id not in cases:
        raise SystemExit(f"Unknown case id: {args.case_id}")
    case = cases[args.case_id]
    targets = read_targets(args.targets, include_skipped=args.include_skipped)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = args.out_dir or Path("evals/runs") / f"browser_{run_id}"
    queue_path = out_dir / "browser_run_queue.csv"
    write_queue(queue_path, case, targets)
    copy_to_clipboard(case["prompt"])
    if not args.no_open:
        open_safari_tabs(targets, case)
    print(f"Copied prompt {case['id']} to clipboard.")
    print(f"Wrote {queue_path.resolve()}")
    print("Targets:")
    for target in targets:
        print(f"- {target['name']}: {resolve_url(target, case)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
