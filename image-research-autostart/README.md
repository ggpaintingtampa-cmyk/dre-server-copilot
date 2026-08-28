# `image-research-autostart` — v1.3-research image build

This directory contains exactly one file, `Dockerfile`, which builds the
`ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.3-research` image. It is small
and does **not** contain a research engine — it only prepares the hook
point one will start from.

## What the Dockerfile currently does

1. **Base image is `v1.2`**:
   `FROM ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.2`. Everything about the
   DRE server itself (OS, TinyMemory loader, `start-dre-vnext.sh`, etc.)
   comes from that base image and is not defined in this repository.
2. **Copies the current `fastapi_app.py`**:
   `COPY artifacts/api-server/fastapi_app.py
   /opt/dre-copilot/artifacts/api-server/fastapi_app.py` — this bakes
   whatever the backend source looks like at build time into the image,
   overwriting whatever version shipped in the `v1.2` base.
3. **Patches DRE startup**: a build-time script edits
   `/opt/dre-vnext/start-dre-vnext.sh` inside the image, inserting a block
   immediately after the existing `set -Eeuo pipefail` line:
   ```sh
   # DRE_RESEARCH_AUTOBOOT_BEGIN
   if [ -x /workspace/dre-research-runtime/bootstrap.sh ]; then
     (nohup /workspace/dre-research-runtime/bootstrap.sh \
       >/tmp/dre-research-bootstrap.log 2>&1 </dev/null &) || true
   fi
   # DRE_RESEARCH_AUTOBOOT_END
   ```
   The build asserts the target script exists, that the anchor line is
   present, that the patched script is still valid Bash (`bash -n`), and
   that the marker comment landed — if any of that fails, the image build
   fails rather than silently shipping an unpatched script.
4. **If `/workspace/dre-research-runtime/bootstrap.sh` is executable at
   container start, it is started in the background** with `nohup`, output
   redirected to `/tmp/dre-research-bootstrap.log`, and startup continues
   regardless of whether that command succeeds (`|| true`). If the script
   doesn't exist or isn't executable, this is a silent no-op — the DRE
   server starts exactly as it did before this patch.
5. **Does not itself contain the complete research engine.** No research
   code, worker, queue, or bootstrap script ships in this image or this
   repository today — this Dockerfile only adds the conditional hook that
   would run one if it's dropped onto a persistent `/workspace` volume
   later. See [`research/README.md`](../research/README.md) and
   [`research/worker/README.md`](../research/worker/README.md) for what is
   meant to eventually occupy that hook point. **The eventual
   `bootstrap.sh` must not execute worker code directly from
   `/workspace`** — the Network Volume backing it does not reliably
   preserve `chmod` (see
   [`docs/storage/README.md`](../docs/storage/README.md)), so `bootstrap.sh`
   is expected to sync/copy the persistent source under
   `/workspace/dre-research-runtime/app/` into `/opt/dre-research`,
   hash-verify it, and execute it from there instead, where normal Linux
   permissions apply. A prototype (`start-research-worker.sh`) already
   exists externally at that path and informally validates the worker's
   claim/heartbeat/shutdown mechanics — see
   [`research/worker/README.md`](../research/worker/README.md) — but it is
   not part of this image or this repository, and this Dockerfile's
   conditional hook is unchanged by that prototype's existence.

## Workflow / image tag

Built by
[`.github/workflows/build-dre-small-v1.3-research.yml`](../.github/workflows/build-dre-small-v1.3-research.yml),
triggered manually or on a push touching `artifacts/api-server/fastapi_app.py`,
this `Dockerfile`, or the workflow itself. It always pushes to the single
tag `ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.3-research` — there is no
per-commit or per-run tag, so this tag is a moving target that reflects
whatever the most recent successful build produced.

## Why repository-root Docker context is required

The workflow builds with `context: .` (the repo root) and
`file: ./image-research-autostart/Dockerfile`. This is required because the
`COPY` instruction above references `artifacts/api-server/fastapi_app.py`
relative to the build context — if the context were scoped to
`image-research-autostart/` instead, that path would not exist and the
build would fail immediately.

## How to validate a fresh pod

1. Start a pod from `ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.3-research`.
2. Confirm the DRE server itself still starts normally (unaffected by this
   patch when no bootstrap script is present):
   `curl http://localhost:$PORT/api/healthz` (or `/health`) should return
   `{"status": "ok", ...}`.
3. Confirm the patched script is present and syntactically valid:
   `grep -n DRE_RESEARCH_AUTOBOOT /opt/dre-vnext/start-dre-vnext.sh` and
   `bash -n /opt/dre-vnext/start-dre-vnext.sh`.
4. To exercise the autoboot path itself (optional, once a real bootstrap
   script exists): place an executable file at
   `/workspace/dre-research-runtime/bootstrap.sh` on the persistent volume,
   restart the container, and check `/tmp/dre-research-bootstrap.log` for
   its output. Confirm the script actually synced its source into
   `/opt/dre-research` and executed from there rather than directly out of
   `/workspace` (see [`docs/storage/README.md`](../docs/storage/README.md)).
5. Confirm `fastapi_app.py` inside the running image matches the commit you
   expect: `diff /opt/dre-copilot/artifacts/api-server/fastapi_app.py
   <your checked-out copy>`.
