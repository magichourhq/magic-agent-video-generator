#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_RUN_DIR = Path("evals/runs/full_benchmark_20260502T043913Z")
DEFAULT_DEST_DIR = Path("benchmark_artifacts")
DEFAULT_GOOGLE_SHEET_URL = "https://docs.google.com/spreadsheets/d/18ftg2jAOCpgDoit2nAliMb35NFdcZ3FgS8_em27ha_Q/edit?usp=drivesdk"
DEFAULT_PUBLIC_DEMO_URL = "https://selections-float-matt-buffer.trycloudflare.com"

COMPARISON_FILES = [
    "merged_results_for_review.csv",
    "merged_results_for_review.json",
    "benchmark_review_packet.md",
    "summary_for_review.csv",
]

RAW_RUN_FILES = [
    "comparison_results.csv",
    "comparison_results.json",
    "external_browser_results.csv",
    "external_browser_results.json",
    "run_config.json",
    "runner.log",
]

RAW_RUN_DIRS = [
    "manifests",
    "requests",
    "status_snapshots",
]


@dataclass(frozen=True)
class ConsolidationResult:
    dest_dir: Path
    run_dest_dir: Path
    project_ids: list[str]
    copied_files: list[Path]


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def project_id_from_manifest(manifest: dict[str, Any]) -> str | None:
    explicit = manifest.get("project_id")
    if isinstance(explicit, str) and explicit:
        return explicit

    final_path = manifest.get("final_video_path")
    if isinstance(final_path, str) and final_path:
        parent = Path(final_path).parent.name
        if parent:
            return parent

    final_url = manifest.get("final_video_url")
    if isinstance(final_url, str) and final_url.startswith("/media/"):
        parts = final_url.split("/")
        if len(parts) >= 3 and parts[2]:
            return parts[2]

    return None


def referenced_project_ids(run_dir: Path) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for manifest_path in sorted((run_dir / "manifests").glob("*.json")):
        project_id = project_id_from_manifest(read_json(manifest_path))
        if project_id and project_id not in seen:
            ids.append(project_id)
            seen.add(project_id)
    return ids


def copy_file(src: Path, dst: Path, copied_files: list[Path]) -> None:
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    copied_files.append(dst)


def copy_dir(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, dirs_exist_ok=True)


def build_readme(
    *,
    run_name: str,
    project_ids: list[str],
    google_sheet_url: str,
    public_demo_url: str,
) -> str:
    return f"""# AI Video Benchmark Artifacts

Latest consolidated run: `{run_name}`

## Links

- Public demo: {public_demo_url}
- Google Sheet: {google_sheet_url}

## Contents

- `prompts/video_generation_benchmark_prompts.jsonl`: 10 benchmark prompts.
- `comparison/`: merged review CSV/JSON, benchmark summary, and workbook export.
- `runs/{run_name}/raw/`: raw local and external run evidence.
- `runs/{run_name}/outputs/`: copied output projects referenced by the benchmark run.

## Current Run Summary

- Local app completed 10/10 prompts in the prior benchmark packet.
- Local model policy: `seedream-v4` image generation + `ltx-2` video generation.
- External platform coverage is intentionally partial where products were gated, lacked LTX-2, or did not expose export URLs.
- Payment safety rule remains: no upgrade, top-up, add-card, purchase, or paid-plan clicks.

Copied output projects:

{chr(10).join(f"- `{project_id}`" for project_id in project_ids)}
"""


def consolidate_benchmark_artifacts(
    *,
    source_root: Path,
    run_dir: Path,
    dest_dir: Path,
    google_sheet_url: str = DEFAULT_GOOGLE_SHEET_URL,
    public_demo_url: str = DEFAULT_PUBLIC_DEMO_URL,
) -> ConsolidationResult:
    run_dir = run_dir if run_dir.is_absolute() else source_root / run_dir
    dest_dir = dest_dir if dest_dir.is_absolute() else source_root / dest_dir
    outputs_dir = source_root / "outputs"
    run_dest = dest_dir / "runs" / run_dir.name
    copied_files: list[Path] = []

    project_ids = referenced_project_ids(run_dir)
    if not project_ids:
        raise RuntimeError(f"No referenced output projects found in {run_dir / 'manifests'}")

    copy_file(
        source_root / "evals" / "video_generation_benchmark_prompts.jsonl",
        dest_dir / "prompts" / "video_generation_benchmark_prompts.jsonl",
        copied_files,
    )

    for filename in COMPARISON_FILES:
        copy_file(run_dir / filename, dest_dir / "comparison" / filename, copied_files)

    workbook = run_dir / "workbook" / "ai_video_benchmark_full_run_2026-05-02.xlsx"
    copy_file(workbook, dest_dir / "comparison" / workbook.name, copied_files)

    for filename in RAW_RUN_FILES:
        copy_file(run_dir / filename, run_dest / "raw" / filename, copied_files)

    for dirname in RAW_RUN_DIRS:
        copy_dir(run_dir / dirname, run_dest / "raw" / dirname)

    if (run_dir / "workbook").exists():
        copy_dir(run_dir / "workbook", run_dest / "raw" / "workbook")

    for project_id in project_ids:
        src = outputs_dir / project_id
        if not src.exists():
            raise FileNotFoundError(f"Referenced output project is missing: {src}")
        copy_dir(src, run_dest / "outputs" / project_id)

    readme = build_readme(
        run_name=run_dir.name,
        project_ids=project_ids,
        google_sheet_url=google_sheet_url,
        public_demo_url=public_demo_url,
    )
    readme_path = dest_dir / "README.md"
    readme_path.parent.mkdir(parents=True, exist_ok=True)
    readme_path.write_text(readme, encoding="utf-8")
    copied_files.append(readme_path)

    return ConsolidationResult(
        dest_dir=dest_dir,
        run_dest_dir=run_dest,
        project_ids=project_ids,
        copied_files=copied_files,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copy the latest benchmark packet into root-level benchmark_artifacts/.")
    parser.add_argument("--source-root", type=Path, default=Path("."))
    parser.add_argument("--run-dir", type=Path, default=DEFAULT_RUN_DIR)
    parser.add_argument("--dest-dir", type=Path, default=DEFAULT_DEST_DIR)
    parser.add_argument("--google-sheet-url", default=DEFAULT_GOOGLE_SHEET_URL)
    parser.add_argument("--public-demo-url", default=DEFAULT_PUBLIC_DEMO_URL)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = consolidate_benchmark_artifacts(
        source_root=args.source_root.resolve(),
        run_dir=args.run_dir,
        dest_dir=args.dest_dir,
        google_sheet_url=args.google_sheet_url,
        public_demo_url=args.public_demo_url,
    )
    print(f"Wrote {result.dest_dir}")
    print(f"Run packet: {result.run_dest_dir}")
    print(f"Copied {len(result.project_ids)} output projects.")
    for project_id in result.project_ids:
        print(f"- {project_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
