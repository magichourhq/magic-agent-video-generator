#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

export YOUTUBE_API_KEY_ALIASES="${YOUTUBE_API_KEY_ALIASES:-YOUTUBE_API_KEY_1,YOUTUBE_API_KEY_3}"

RUN_DIR="${1:-evals/runs/youtube_live_$(date -u +%Y%m%dT%H%M%SZ)}"
shift || true
mkdir -p "$RUN_DIR"

echo "Run dir: $RUN_DIR"
echo "YouTube key aliases: $YOUTUBE_API_KEY_ALIASES"
echo "Waiting for backend..."
until curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; do
  sleep 2
done

echo "Backend ready. Starting YouTube workflow evals..."
.venv/bin/python scripts/run_youtube_workflow_evals.py \
  --out-dir "$RUN_DIR" \
  --providers youtube_data_api \
  --timeout-minutes 60 \
  --poll-interval-seconds 10 \
  "$@" \
  2>&1 | tee "$RUN_DIR/runner.log"
status="${PIPESTATUS[0]}"
echo "Eval command exited with status $status"
echo "Run dir: $RUN_DIR"
exit "$status"
