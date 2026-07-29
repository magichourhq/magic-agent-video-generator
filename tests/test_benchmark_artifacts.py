import json
from pathlib import Path

from scripts.consolidate_benchmark_artifacts import consolidate_benchmark_artifacts
from scripts.run_platform_benchmark_playwright import (
    extract_http_video_urls,
    is_payment_gate_text,
)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_consolidates_latest_run_packet_and_referenced_outputs(tmp_path: Path) -> None:
    source_root = tmp_path / "repo"
    run_dir = source_root / "evals" / "runs" / "full_benchmark_20260502T043913Z"
    outputs_dir = source_root / "outputs"
    dest = source_root / "benchmark_artifacts"

    prompt_file = source_root / "evals" / "video_generation_benchmark_prompts.jsonl"
    prompt_file.parent.mkdir(parents=True)
    prompt_file.write_text('{"id":"vg-bench-001","prompt":"make video"}\n', encoding="utf-8")

    for filename in [
        "merged_results_for_review.csv",
        "merged_results_for_review.json",
        "benchmark_review_packet.md",
        "summary_for_review.csv",
        "comparison_results.csv",
        "comparison_results.json",
        "external_browser_results.csv",
        "external_browser_results.json",
        "run_config.json",
        "runner.log",
    ]:
        (run_dir / filename).parent.mkdir(parents=True, exist_ok=True)
        (run_dir / filename).write_text(filename, encoding="utf-8")

    workbook = run_dir / "workbook" / "ai_video_benchmark_full_run_2026-05-02.xlsx"
    workbook.parent.mkdir(parents=True)
    workbook.write_bytes(b"xlsx")

    for project_id in ["project-a", "project-b"]:
        project_dir = outputs_dir / project_id
        project_dir.mkdir(parents=True)
        (project_dir / "final.mp4").write_bytes(b"video")
        _write_json(project_dir / "manifest.json", {"project_id": project_id})
        _write_json(
            run_dir / "manifests" / f"{project_id}.json",
            {"final_video_path": str(project_dir / "final.mp4")},
        )

    extra_project = outputs_dir / "project-not-in-run"
    extra_project.mkdir(parents=True)
    (extra_project / "final.mp4").write_bytes(b"old")

    result = consolidate_benchmark_artifacts(
        source_root=source_root,
        run_dir=run_dir,
        dest_dir=dest,
        google_sheet_url="https://docs.google.com/spreadsheets/d/test/edit",
        public_demo_url="https://demo.example",
    )

    assert result.project_ids == ["project-a", "project-b"]
    assert (dest / "README.md").read_text(encoding="utf-8").count("https://demo.example") == 1
    assert (dest / "prompts" / "video_generation_benchmark_prompts.jsonl").exists()
    assert (dest / "comparison" / "merged_results_for_review.csv").exists()
    assert (dest / "comparison" / "ai_video_benchmark_full_run_2026-05-02.xlsx").exists()
    assert (dest / "runs" / run_dir.name / "outputs" / "project-a" / "final.mp4").exists()
    assert (dest / "runs" / run_dir.name / "outputs" / "project-b" / "manifest.json").exists()
    assert not (dest / "runs" / run_dir.name / "outputs" / "project-not-in-run").exists()


def test_playwright_helpers_detect_payment_gates_and_video_urls() -> None:
    assert is_payment_gate_text("Generate AI clip - Requires Business plan")
    assert is_payment_gate_text("Add card to buy more credits")
    assert not is_payment_gate_text("Free plan ready. LTX-2 selected.")

    urls = extract_http_video_urls(
        [
            "https://cdn.example.com/render.mp4?token=abc",
            "blob:https://app.videogen.io/123",
            "",
            "https://example.com/image.png",
            "https://cdn.example.com/render.mp4?token=abc",
        ]
    )

    assert urls == ["https://cdn.example.com/render.mp4?token=abc"]
