# DRE Server Copilot

DRE Server Copilot is a phone-first control surface for a DRE.SMALL RunPod container. It provides authenticated DRE chat, guarded shell execution, live activity, SQLite-backed session history, and operational status.

The production runtime is one FastAPI/Uvicorn application. React and pnpm are used only to build the static frontend.

## Build and start

```sh
sh scripts/build-dre-production.sh
python -m uvicorn fastapi_app:app --app-dir artifacts/api-server --host 0.0.0.0 --port "${PORT:-8000}"
```

Copy `.env.example` into your private server environment and set `OPENAI_API_KEY` and `DRE_AGENT_TOKEN` there. Do not commit real credentials.

See [SCHEMATICS.md](SCHEMATICS.md) for the runtime architecture, authentication, environment variables, API routes, state persistence, shell safety policy, and RunPod deployment notes.