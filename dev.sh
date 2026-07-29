#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/.run-logs"
SHARED_ENV="/Users/tanmay/Magic Hour ML role/.env"
mkdir -p "$LOG_DIR"

if [[ -f "$SHARED_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SHARED_ENV"
  set +a
fi

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
API_PUBLIC_HOST="${API_PUBLIC_HOST:-localhost}"
FRONTEND_PUBLIC_HOST="${FRONTEND_PUBLIC_HOST:-localhost}"
if [[ "${SINGLE_ORIGIN_DEMO:-false}" == "true" ]]; then
  export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL-}"
  export BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://127.0.0.1:${BACKEND_PORT}}"
else
  export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-http://${API_PUBLIC_HOST}:${BACKEND_PORT}}"
fi

BACKEND_URL="http://${API_PUBLIC_HOST}:${BACKEND_PORT}"
FRONTEND_URL="http://${FRONTEND_PUBLIC_HOST}:${FRONTEND_PORT}"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

# The server needs node:events addAbortListener (execa), so Node 20.5+/18.18+.
node_version_supported() {
  local version="${1#v}"
  IFS='.' read -r major minor _ <<< "$version"
  major="${major:-0}"
  minor="${minor:-0}"
  if (( major >= 21 )); then return 0; fi
  if (( major == 20 && minor >= 5 )); then return 0; fi
  if (( major == 18 && minor >= 18 )); then return 0; fi
  return 1
}

select_node_toolchain() {
  local candidate_node
  local candidate_npm
  local candidate_version
  local nvm_dir

  candidate_node="$(command -v node 2>/dev/null || true)"
  candidate_npm="$(command -v npm 2>/dev/null || true)"
  if [[ -n "$candidate_node" && -n "$candidate_npm" ]]; then
    candidate_version="$("$candidate_node" -v 2>/dev/null || true)"
    if [[ -n "$candidate_version" ]] && node_version_supported "$candidate_version"; then
      NODE_BIN="$candidate_node"
      NPM_BIN="$candidate_npm"
      return 0
    fi
  fi

  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    for nvm_dir in "$HOME/.nvm/versions/node"/*/bin; do
      [[ -x "$nvm_dir/node" && -x "$nvm_dir/npm" ]] || continue
      candidate_version="$("$nvm_dir/node" -v 2>/dev/null || true)"
      if [[ -n "$candidate_version" ]] && node_version_supported "$candidate_version"; then
        NODE_BIN="$nvm_dir/node"
        NPM_BIN="$nvm_dir/npm"
        return 0
      fi
    done
  fi

  if [[ -x /opt/homebrew/bin/node && -x /opt/homebrew/bin/npm ]]; then
    candidate_version="$(/opt/homebrew/bin/node -v 2>/dev/null || true)"
    if [[ -n "$candidate_version" ]] && node_version_supported "$candidate_version"; then
      NODE_BIN="/opt/homebrew/bin/node"
      NPM_BIN="/opt/homebrew/bin/npm"
      return 0
    fi
  fi

  echo "A compatible Node.js version (20.5+) is required." >&2
  exit 1
}

wait_for_http() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$name did not become ready at $url" >&2
  return 1
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

require_cmd curl
require_cmd ffmpeg
require_cmd ffprobe
select_node_toolchain

if [[ ! -d "$SERVER_DIR/node_modules" ]]; then
  echo "Installing server dependencies..."
  (cd "$SERVER_DIR" && "$NPM_BIN" install)
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && "$NPM_BIN" install)
fi

echo "Starting backend on ${BACKEND_URL} ..."
(
  cd "$SERVER_DIR"
  exec env SERVER_HOST="$BACKEND_HOST" SERVER_PORT="$BACKEND_PORT" \
    "$NODE_BIN" node_modules/tsx/dist/cli.mjs src/index.ts
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

wait_for_http "$BACKEND_URL/api/health" "Backend API"

echo "Starting frontend on ${FRONTEND_URL} ..."
(
  cd "$FRONTEND_DIR"
  exec "$NODE_BIN" node_modules/next/dist/bin/next dev --hostname "$FRONTEND_HOST" --port "$FRONTEND_PORT"
) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

wait_for_http "$FRONTEND_URL" "Frontend"

echo
printf 'Frontend URL: %s\n' "$FRONTEND_URL"
printf 'Backend URL:  %s\n' "$BACKEND_URL"
printf 'Backend log:  %s\n' "$BACKEND_LOG"
printf 'Frontend log: %s\n' "$FRONTEND_LOG"
echo
echo "Press Ctrl+C to stop both servers."

wait "$FRONTEND_PID"
