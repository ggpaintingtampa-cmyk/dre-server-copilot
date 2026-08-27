# syntax=docker/dockerfile:1
FROM ghcr.io/ggpaintingtampa-cmyk/dre-small:v1.2

RUN bash -Eeuo pipefail <<'PATCH'
target=/opt/dre-vnext/start-dre-vnext.sh

test -f "$target"
grep -qxF 'set -Eeuo pipefail' "$target"
sed -i '\|^set -Eeuo pipefail$|r /dev/stdin' "$target" <<'BLOCK'
# DRE_RESEARCH_AUTOBOOT_BEGIN
if [ -x /workspace/dre-research-runtime/bootstrap.sh ]; then
  (nohup /workspace/dre-research-runtime/bootstrap.sh \
    >/tmp/dre-research-bootstrap.log 2>&1 </dev/null &) || true
fi
# DRE_RESEARCH_AUTOBOOT_END
BLOCK
bash -n "$target"
grep -qF '# DRE_RESEARCH_AUTOBOOT_BEGIN' "$target"
PATCH
