#!/usr/bin/env sh
set -eu

# Build-only step. The resulting FastAPI runtime requires no Node.js or pnpm.
: "${PORT:=19646}"
: "${BASE_PATH:=/}"
export PORT BASE_PATH
pnpm --filter @workspace/dre-server-copilot run build
rm -rf artifacts/api-server/frontend-dist
cp -R artifacts/dre-server-copilot/dist/public artifacts/api-server/frontend-dist