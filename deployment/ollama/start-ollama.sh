#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace/models/ollama
export OLLAMA_MODELS=/workspace/models/ollama
export OLLAMA_HOST=127.0.0.1:11434

exec ollama serve
