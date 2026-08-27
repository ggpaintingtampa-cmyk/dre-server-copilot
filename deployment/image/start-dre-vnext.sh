#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="/var/log/dre"
MEMORY_DIR="/var/lib/dre-memory"
MEMORY_DEFAULT="/opt/dre-memory-default"

mkdir -p \
  "$LOG_DIR" \
  "$MEMORY_DIR" \
  /workspace/models/ollama \
  /workspace/dre-copilot \
  /run

if [ ! -f "$MEMORY_DIR/manifest.json" ]; then
  cp -a "$MEMORY_DEFAULT/." "$MEMORY_DIR/"
fi

export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_MODELS="${OLLAMA_MODELS:-/workspace/models/ollama}"
export PORT="${PORT:-8000}"

export DRE_FRONTEND_DIST="${DRE_FRONTEND_DIST:-/opt/dre-copilot/artifacts/api-server/frontend-dist}"
export DRE_STATE_DB_PATH="${DRE_STATE_DB_PATH:-/workspace/dre-copilot/state.sqlite3}"

if command -v ollama >/dev/null 2>&1; then
  nohup ollama serve >>"$LOG_DIR/ollama.log" 2>&1 &
  echo $! > /run/dre-ollama.pid
else
  echo "WARNING: Ollama runtime not found." >>"$LOG_DIR/ollama.log"
fi

cd /opt/dre-copilot

if [ ! -x .venv/bin/python ]; then
  echo "FATAL: DRE Copilot virtualenv missing." >&2
  exit 1
fi

nohup .venv/bin/python -m uvicorn fastapi_app:app \
  --app-dir /opt/dre-copilot/artifacts/api-server \
  --host 0.0.0.0 \
  --port "$PORT" \
  >>"$LOG_DIR/copilot.log" 2>&1 &

COPILOT_PID=$!
echo "$COPILOT_PID" > /run/dre-copilot.pid

sleep 2

if ! kill -0 "$COPILOT_PID" 2>/dev/null; then
  echo "FATAL: DRE Copilot failed during startup." >&2
  exit 1
fi

exec /start.sh
