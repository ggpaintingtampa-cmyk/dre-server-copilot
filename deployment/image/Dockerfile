FROM node:22-bookworm-slim AS frontend

WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/dre-server-copilot run build

FROM arcero123/dre-small:v1.1

ARG OLLAMA_VERSION=0.33.1

ENV OLLAMA_HOST=127.0.0.1:11434
ENV OLLAMA_MODELS=/workspace/models/ollama
ENV OPENAI_MODEL=gpt-5.6
ENV PORT=8000
ENV DRE_ALLOW_SHELL_EXECUTION=true
ENV DRE_FRONTEND_DIST=/opt/dre-copilot/artifacts/api-server/frontend-dist
ENV DRE_STATE_DB_PATH=/workspace/dre-copilot/state.sqlite3

RUN mkdir -p /opt/dre-copilot \
    /opt/dre-memory \
    /opt/dre-memory-default/skills \
    /opt/dre-vnext \
    /workspace/models/ollama \
    /workspace/dre-copilot \
    /var/log/dre

COPY deployment/image/requirements-runtime.txt /tmp/requirements-runtime.txt

RUN python3.12 -m venv /opt/dre-copilot/.venv \
 && /opt/dre-copilot/.venv/bin/pip install --no-cache-dir \
      -r /tmp/requirements-runtime.txt \
 && rm -f /tmp/requirements-runtime.txt

COPY artifacts/api-server /opt/dre-copilot/artifacts/api-server

RUN rm -rf /opt/dre-copilot/artifacts/api-server/frontend-dist

COPY --from=frontend \
  /src/artifacts/dre-server-copilot/dist/public \
  /opt/dre-copilot/artifacts/api-server/frontend-dist

COPY deployment/tinymemory/load_memory.py /opt/dre-memory/load_memory.py

COPY deployment/tinymemory/manifest.json \
     deployment/tinymemory/persona.md \
     deployment/tinymemory/facts.md \
     /opt/dre-memory-default/

COPY deployment/tinymemory/skills /opt/dre-memory-default/skills

RUN curl -fsSL https://ollama.com/install.sh \
  | OLLAMA_VERSION=${OLLAMA_VERSION} sh \
 && ollama --version

COPY deployment/image/start-dre-vnext.sh \
  /opt/dre-vnext/start-dre-vnext.sh

RUN chmod +x /opt/dre-vnext/start-dre-vnext.sh

EXPOSE 8000 11434

ENTRYPOINT ["/opt/dre-vnext/start-dre-vnext.sh"]
