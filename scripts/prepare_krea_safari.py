#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def osa_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def run_applescript(script: str) -> str:
    result = subprocess.run(["osascript", "-e", script], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def find_krea_tab_script(js: str) -> str:
    return f'''
tell application "Safari"
  set foundTab to missing value
  set foundWindow to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "krea.ai/video" then
        set foundTab to t
        set foundWindow to w
      end if
    end repeat
  end repeat
  if foundTab is missing value then error "No Krea video tab found"
  set current tab of foundWindow to foundTab
  set index of foundWindow to 1
  activate
  do JavaScript "{osa_string(js)}" in foundTab
end tell
'''.strip()


def press_return_on_krea() -> None:
    run_applescript(
        '''
tell application "Safari"
  set foundTab to missing value
  set foundWindow to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "krea.ai/video" then
        set foundTab to t
        set foundWindow to w
      end if
    end repeat
  end repeat
  if foundTab is missing value then error "No Krea video tab found"
  set current tab of foundWindow to foundTab
  set index of foundWindow to 1
  activate
end tell
delay 0.2
tell application "System Events"
  key code 36
end tell
'''.strip()
    )


def navigate_prompt(prompt: str) -> None:
    url = "https://www.krea.ai/video?from=miniapp&model=ltx-2-19b&prompt=" + quote_plus(prompt)
    run_applescript(
        f'''
tell application "Safari"
  activate
  set foundTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "krea.ai" then set foundTab to t
    end repeat
  end repeat
  if foundTab is missing value then
    make new document with properties {{URL:"{osa_string(url)}"}}
  else
    set URL of foundTab to "{osa_string(url)}"
  end if
end tell
'''.strip()
    )


def prepare_controls(prompt: str, submit: bool) -> str:
    js = r'''
(() => {
  const wantedPrompt = __PROMPT__;
  const text = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
  const clickButton = (label) => {
    const btn = Array.from(document.querySelectorAll("button")).find((el) => text(el) === label);
    if (!btn) return false;
    btn.click();
    return true;
  };
  const textarea = document.querySelector("textarea");
  if (textarea) {
    textarea.value = wantedPrompt;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const selected10s = clickButton("10s");
  const selectedPortrait = clickButton("Portrait");
  let submitted = false;
  let focusedGenerate = false;
  if (__SUBMIT__) {
    const generate = Array.from(document.querySelectorAll("button")).find((el) =>
      el.outerHTML.includes("lucide-sparkle") && el.outerHTML.includes("bg-primary")
    );
    if (generate) {
      generate.scrollIntoView({ block: "center" });
      generate.focus();
      focusedGenerate = document.activeElement === generate;
      generate.click();
      submitted = true;
    }
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    promptPresent: Boolean(textarea && textarea.value.includes(wantedPrompt.slice(0, 40))),
    selected10s,
    selectedPortrait,
    submitted,
    focusedGenerate,
    visibleText: document.body.innerText.slice(0, 800)
  });
})()
'''.replace("__PROMPT__", json.dumps(prompt)).replace("__SUBMIT__", "true" if submit else "false")
    return run_applescript(find_krea_tab_script(js))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare the logged-in Krea LTX-2 Safari tab for a benchmark prompt.")
    parser.add_argument("--prompts", type=Path, default=Path("evals/video_generation_benchmark_prompts.jsonl"))
    parser.add_argument("--case-id", default="vg-bench-001")
    parser.add_argument("--submit", action="store_true", help="Click the Krea generate button. This may spend credits.")
    parser.add_argument("--no-navigate", action="store_true", help="Do not navigate; only adjust the existing Krea video tab.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cases = {case["id"]: case for case in read_jsonl(args.prompts)}
    if args.case_id not in cases:
        raise SystemExit(f"Unknown case id: {args.case_id}")
    prompt = cases[args.case_id]["prompt"]
    if not args.no_navigate:
        navigate_prompt(prompt)
        time.sleep(3)
    result = prepare_controls(prompt, submit=args.submit)
    print(result)
    if args.submit:
        press_return_on_krea()
    if not args.submit:
        print("Prepared Krea only. Re-run with --submit to click generate and spend credits.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
