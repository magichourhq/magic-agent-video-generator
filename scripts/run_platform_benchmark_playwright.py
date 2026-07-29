#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import csv
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus


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
    "prompt_adherence_1_5",
    "story_coherence_1_5",
    "visual_quality_1_5",
    "motion_quality_1_5",
    "narration_audio_1_5",
    "finishedness_1_5",
    "editability_1_5",
    "weighted_score_100",
    "major_failures",
    "notes",
    "prompt",
]

PAYMENT_GATE_PATTERNS = [
    "requires business plan",
    "business plan",
    "upgrade",
    "top up",
    "top-up",
    "add card",
    "credit card",
    "debit card",
    "select plan",
    "choose plan",
    "subscribe",
    "subscription",
    "checkout",
    "billing",
    "buy credits",
    "purchase credits",
    "insufficient credits",
]


@dataclass(frozen=True)
class PlatformSpec:
    id: str
    name: str
    url_template: str
    image_model: str
    video_model: str
    model_policy: str
    notes: str


PLATFORMS = {
    "krea": PlatformSpec(
        id="krea",
        name="Krea LTX-2",
        url_template="https://www.krea.ai/video?from=miniapp&model=ltx-2-19b&prompt={prompt}",
        image_model="",
        video_model="ltx-2",
        model_policy="ltx-2 text-to-video; no seedream-v4 image stage",
        notes="Playwright persistent Chrome profile; LTX-2 URL seeded with prompt.",
    ),
    "ltx-studio": PlatformSpec(
        id="ltx-studio",
        name="LTX Studio",
        url_template="https://app.ltx.studio/",
        image_model="",
        video_model="ltx-2 fast",
        model_policy="ltx-2 text-to-video in LTX Studio; no seedream-v4 image stage",
        notes="Requires logged-in browser profile and available credits.",
    ),
    "videogen": PlatformSpec(
        id="videogen",
        name="VideoGen",
        url_template="https://app.videogen.io/",
        image_model="",
        video_model="ltx-2",
        model_policy="VideoGen LTX on free plan when available; export captured via download/video-source extraction if possible.",
        notes="Stops on paid-plan or add-card gates. May require manual right-click save if the site hides export URLs.",
    ),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_id() -> str:
    return datetime.now(timezone.utc).strftime("playwright_%Y%m%dT%H%M%SZ")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.lower()).strip()


def is_payment_gate_text(text: str) -> bool:
    normalized = normalize_text(text)
    return any(pattern in normalized for pattern in PAYMENT_GATE_PATTERNS)


def extract_http_video_urls(urls: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for url in urls:
        if not url:
            continue
        clean = url.strip()
        if not clean.startswith(("http://", "https://")):
            continue
        if ".mp4" not in clean.lower() and ".webm" not in clean.lower() and ".mov" not in clean.lower():
            continue
        if clean not in seen:
            result.append(clean)
            seen.add(clean)
    return result


def selected_cases(cases: list[dict[str, Any]], ids: str, limit: int) -> list[dict[str, Any]]:
    if ids:
        wanted = {item.strip() for item in ids.split(",") if item.strip()}
        cases = [case for case in cases if case["id"] in wanted]
    if limit:
        cases = cases[:limit]
    return cases


def selected_platforms(raw: str) -> list[PlatformSpec]:
    ids = [item.strip() for item in raw.split(",") if item.strip()]
    unknown = [item for item in ids if item not in PLATFORMS]
    if unknown:
        raise SystemExit(f"Unknown platform ids: {', '.join(unknown)}")
    return [PLATFORMS[item] for item in ids]


def platform_url(spec: PlatformSpec, prompt: str) -> str:
    return spec.url_template.format(prompt=quote_plus(prompt))


def settings_for_row(case: dict[str, Any], spec: PlatformSpec) -> str:
    settings = dict(case.get("settings") or {})
    if spec.video_model:
        settings["video_model"] = spec.video_model
    return json.dumps(settings, sort_keys=True)


def result_row(
    case: dict[str, Any],
    spec: PlatformSpec,
    *,
    status: str,
    output_url_or_path: str = "",
    estimated_cost_or_credits: str = "",
    major_failures: str = "",
    notes: str = "",
    latency_minutes: float | None = None,
) -> dict[str, Any]:
    row = {column: "" for column in CSV_COLUMNS}
    row.update(
        {
            "prompt_id": case["id"],
            "prompt_name": case["name"],
            "category": case["category"],
            "competitor": spec.name,
            "image_model": spec.image_model,
            "video_model": spec.video_model,
            "model_policy": spec.model_policy,
            "run_date": utc_now(),
            "status": status,
            "output_url_or_path": output_url_or_path,
            "settings_used": settings_for_row(case, spec),
            "latency_minutes": "" if latency_minutes is None else f"{latency_minutes:.2f}",
            "estimated_cost_or_credits": estimated_cost_or_credits,
            "usable_first_try": "yes" if status in {"succeeded", "generated_project_page"} else "no",
            "major_failures": major_failures,
            "notes": notes,
            "prompt": case["prompt"],
        }
    )
    return row


def write_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def safe_body_text(page: Any) -> str:
    try:
        return page.locator("body").inner_text(timeout=5000)
    except Exception:
        return ""


def screenshot(page: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(path), full_page=True)
    except Exception:
        pass


def first_visible_locator(page: Any, selectors: list[str]) -> Any | None:
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if locator.count() and locator.is_visible(timeout=1500):
                return locator
        except Exception:
            continue
    return None


def fill_prompt_if_possible(page: Any, prompt: str) -> bool:
    locator = first_visible_locator(
        page,
        [
            "textarea",
            "input[placeholder*='prompt' i]",
            "input[placeholder*='describe' i]",
            "[contenteditable='true']",
            "[role='textbox']",
        ],
    )
    if locator is None:
        return False
    try:
        locator.fill(prompt)
        return True
    except Exception:
        try:
            locator.click()
            locator.press("Meta+A")
            locator.type(prompt)
            return True
        except Exception:
            return False


def click_button_by_name(page: Any, pattern: str, timeout_ms: int) -> bool:
    locator = page.get_by_role("button", name=re.compile(pattern, re.I)).first
    try:
        if not locator.count() or not locator.is_visible(timeout=timeout_ms):
            return False
        label = locator.inner_text(timeout=1000)
        if is_payment_gate_text(label):
            return False
        locator.click(timeout=timeout_ms)
        return True
    except Exception:
        return False


def select_ltx_if_possible(page: Any) -> bool:
    for pattern in [r"LTX[-\s]?2", r"LTX[-\s]?2 Fast"]:
        try:
            candidate = page.get_by_text(re.compile(pattern, re.I)).first
            if candidate.count() and candidate.is_visible(timeout=1000):
                candidate.click(timeout=1000)
                return True
        except Exception:
            continue
    return False


def discover_video_sources(page: Any) -> list[str]:
    try:
        values = page.eval_on_selector_all(
            "video, source, a[href]",
            """els => Array.from(new Set(els.map((el) =>
              el.currentSrc || el.src || el.href || el.getAttribute('src') || el.getAttribute('href') || ''
            ).filter(Boolean)))""",
        )
        return [str(value) for value in values]
    except Exception:
        return []


def save_http_video(page: Any, url: str, path: Path) -> bool:
    try:
        response = page.request.get(url, timeout=60000)
        if not response.ok:
            return False
        body = response.body()
        if not body:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return True
    except Exception:
        return False


def save_blob_video(page: Any, src: str, path: Path) -> bool:
    try:
        encoded = page.evaluate(
            """async (url) => {
              const response = await fetch(url);
              const buffer = await response.arrayBuffer();
              let binary = '';
              const bytes = new Uint8Array(buffer);
              const chunkSize = 0x8000;
              for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
              }
              return btoa(binary);
            }""",
            src,
        )
        data = base64.b64decode(encoded)
        if not data:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return True
    except Exception:
        return False


def click_download_if_possible(page: Any, path: Path, timeout_ms: int) -> bool:
    for pattern in [r"download", r"export", r"save video", r"save"]:
        locator = page.get_by_role("button", name=re.compile(pattern, re.I)).first
        try:
            if not locator.count() or not locator.is_visible(timeout=1000):
                continue
            if is_payment_gate_text(safe_body_text(page)):
                return False
            with page.expect_download(timeout=timeout_ms) as download_info:
                locator.click(timeout=timeout_ms)
            download = download_info.value
            path.parent.mkdir(parents=True, exist_ok=True)
            download.save_as(str(path))
            return True
        except Exception:
            continue
    return False


def save_video_from_page(page: Any, downloads_dir: Path, basename: str, timeout_ms: int) -> tuple[str, str]:
    download_path = downloads_dir / f"{basename}.mp4"
    if click_download_if_possible(page, download_path, timeout_ms):
        return "succeeded", str(download_path)

    sources = discover_video_sources(page)
    http_sources = extract_http_video_urls(sources)
    for index, url in enumerate(http_sources, 1):
        suffix = Path(url.split("?", 1)[0]).suffix or ".mp4"
        path = downloads_dir / f"{basename}-source-{index}{suffix}"
        if save_http_video(page, url, path):
            return "succeeded", str(path)

    for index, src in enumerate(source for source in sources if source.startswith("blob:")):
        path = downloads_dir / f"{basename}-blob-{index + 1}.mp4"
        if save_blob_video(page, src, path):
            return "succeeded", str(path)

    return "manual_save_required", ""


def run_browser_benchmark(args: argparse.Namespace) -> list[dict[str, Any]]:
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Python Playwright is not installed. Run `./.venv/bin/python -m pip install -r requirements.txt` first."
        ) from exc

    cases = selected_cases(read_jsonl(args.prompts), args.ids, args.limit)
    specs = selected_platforms(args.platforms)
    if not cases:
        raise SystemExit("No benchmark cases selected.")

    out_dir = args.out_dir or Path("benchmark_artifacts") / "runs" / run_id()
    evidence_dir = out_dir / "evidence"
    downloads_dir = out_dir / "downloads"
    profile_dir = args.profile_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    downloads_dir.mkdir(parents=True, exist_ok=True)
    profile_dir.mkdir(parents=True, exist_ok=True)

    write_json(
        out_dir / "run_config.json",
        {
            "created_at": utc_now(),
            "submit": args.submit,
            "platforms": [spec.id for spec in specs],
            "case_ids": [case["id"] for case in cases],
            "profile_dir": str(profile_dir),
            "payment_gate_patterns": PAYMENT_GATE_PATTERNS,
        },
    )

    rows: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            channel=args.browser_channel,
            headless=args.headless,
            accept_downloads=True,
            downloads_path=str(downloads_dir),
            viewport={"width": 1440, "height": 1000},
        )
        try:
            for case in cases:
                for spec in specs:
                    start = time.monotonic()
                    page = context.new_page()
                    page.set_default_timeout(args.action_timeout_ms)
                    url = platform_url(spec, case["prompt"])
                    basename = f"{case['id']}-{spec.id}"
                    notes = [spec.notes, f"start_url={url}"]
                    status = "error"
                    output = ""
                    major_failure = ""
                    try:
                        page.goto(url, wait_until="domcontentloaded", timeout=args.navigation_timeout_ms)
                        try:
                            page.wait_for_load_state("networkidle", timeout=8000)
                        except Exception:
                            pass
                        screenshot(page, evidence_dir / f"{basename}-loaded.png")
                        body_text = safe_body_text(page)
                        if is_payment_gate_text(body_text):
                            status = "blocked_payment_gate"
                            major_failure = "payment_or_plan_gate_detected"
                            notes.append("Stopped before clicking because payment/plan gate text was visible.")
                        elif not args.submit:
                            status = "dry_run_ready"
                            notes.append("Dry run only; no generate/export click attempted.")
                        else:
                            select_ltx_if_possible(page)
                            filled = fill_prompt_if_possible(page, case["prompt"])
                            notes.append(f"prompt_filled={filled}")
                            if is_payment_gate_text(safe_body_text(page)):
                                status = "blocked_payment_gate"
                                major_failure = "payment_or_plan_gate_detected_after_prompt"
                            else:
                                clicked = click_button_by_name(page, r"generate|create|make video|submit", args.action_timeout_ms)
                                notes.append(f"generate_clicked={clicked}")
                                if not clicked:
                                    status = "manual_submit_required"
                                    major_failure = "could_not_find_safe_generate_button"
                                else:
                                    page.wait_for_timeout(args.generation_wait_seconds * 1000)
                                    screenshot(page, evidence_dir / f"{basename}-after-generate.png")
                                    if is_payment_gate_text(safe_body_text(page)):
                                        status = "blocked_payment_gate"
                                        major_failure = "payment_or_plan_gate_detected_after_generate"
                                    else:
                                        status, output = save_video_from_page(
                                            page,
                                            downloads_dir,
                                            basename,
                                            args.download_timeout_ms,
                                        )
                                        if status == "manual_save_required":
                                            major_failure = "download_or_video_source_not_accessible"
                                            notes.append("Try right-click/save from the page; screenshot evidence was captured.")
                    except Exception as exc:
                        major_failure = str(exc)
                        status = "error"
                        screenshot(page, evidence_dir / f"{basename}-error.png")
                    finally:
                        latency = (time.monotonic() - start) / 60
                        rows.append(
                            result_row(
                                case,
                                spec,
                                status=status,
                                output_url_or_path=output,
                                major_failures=major_failure,
                                notes="; ".join(notes),
                                latency_minutes=latency,
                            )
                        )
                        page.close()
        finally:
            context.close()

    write_rows(out_dir / "platform_results.csv", rows)
    write_json(out_dir / "platform_results.json", rows)
    return rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run browser-based video platform benchmarks with Playwright.")
    parser.add_argument("--prompts", type=Path, default=Path("evals/video_generation_benchmark_prompts.jsonl"))
    parser.add_argument("--platforms", default="krea,ltx-studio,videogen")
    parser.add_argument("--ids", default="", help="Comma-separated prompt IDs to run.")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--profile-dir", type=Path, default=Path(".playwright-profiles/video-platforms"))
    parser.add_argument("--submit", action="store_true", help="Actually click safe generate/export controls. May spend existing credits.")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--browser-channel", default="chrome", help="Use installed Chrome by default; pass chromium if needed.")
    parser.add_argument("--navigation-timeout-ms", type=int, default=60000)
    parser.add_argument("--action-timeout-ms", type=int, default=10000)
    parser.add_argument("--download-timeout-ms", type=int, default=30000)
    parser.add_argument("--generation-wait-seconds", type=int, default=90)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rows = run_browser_benchmark(args)
    print(f"Wrote {len(rows)} platform result rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
