#!/usr/bin/env bash
# flightdeck-server 시작 (docs/install.md "서버 기기").
# 사용: deploy/server/start.sh [server.env 경로]   (기본: deploy/server/server.env)
# 빌드가 없으면 먼저 빌드한다. 시작 로그의 "server key SHA256:…"를 멤버에게 나눠 준다.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/../.." && pwd)
ENV_FILE=${1:-$DIR/server.env}
[ -f "$ENV_FILE" ] || { echo "설정 파일이 없다: $ENV_FILE (server.env.example을 복사해 고친다)"; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${FD_DATA_DIR:?FD_DATA_DIR가 없다}"
: "${FD_DATABASE_URL:?FD_DATABASE_URL가 없다}"

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node 22 이상이 필요하다 (지금 $(node -v))"; exit 1; }
git --version >/dev/null || { echo "git이 필요하다"; exit 1; }
if [ ! -f "$ROOT/dist/flightdeck-server.mjs" ]; then
  echo "빌드한다…"
  (cd "$ROOT" && pnpm install --frozen-lockfile && pnpm build)
fi
mkdir -p "$FD_DATA_DIR"

args=()
[ -n "${FD_BOOTSTRAP_ADMIN:-}" ] && args+=(--bootstrap-admin "$FD_BOOTSTRAP_ADMIN")
if [ -n "${FD_IMPORT_PRODUCT:-}" ]; then
  args+=(--import-product "$FD_IMPORT_PRODUCT")
  [ -n "${FD_PRODUCT_REPO:-}" ] && args+=(--repo "$FD_PRODUCT_REPO")
  [ -n "${FD_IMPORT_REPO:-}" ] && args+=(--import-repo "$FD_IMPORT_REPO")
fi
exec node "$ROOT/dist/flightdeck-server.mjs" ${args[@]+"${args[@]}"}
