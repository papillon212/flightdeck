#!/usr/bin/env bash
# 백업 (설계 §1.5 백업, docs/install.md "백업"): 내장 git 레포 bundle + PostgreSQL 덤프를 날짜 폴더에.
# 사용: deploy/server/backup.sh [server.env 경로]   cron 등으로 정기 실행한다(주기는 팀이 정한다, 설계 §15 미결 6)
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/../.." && pwd)
ENV_FILE=${1:-$DIR/server.env}
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${FD_BACKUP_DIR:?FD_BACKUP_DIR가 없다}"
OUT="$FD_BACKUP_DIR/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# 1. 내장 git 레포마다 bundle (검증까지)
node "$ROOT/dist/flightdeck-server.mjs" backup "$OUT/git"

# 2. PostgreSQL (설정·멤버·편집 기록). 컨테이너면 그 안에서
if [ -n "${FD_PG_CONTAINER:-}" ]; then
  # 컨테이너 안에서는 밖의 포트가 아니라 컨테이너 자신의 DB다: 사용자·DB 이름만 쓴다
  PGU=$(node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).username))' "$FD_DATABASE_URL")
  PGD=$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$FD_DATABASE_URL")
  docker exec "$FD_PG_CONTAINER" pg_dump --format=custom -U "$PGU" "$PGD" > "$OUT/db.dump"
else
  pg_dump --format=custom "$FD_DATABASE_URL" > "$OUT/db.dump"
fi

# 3. 서버 서명 키 (잃으면 지금까지의 서명을 새 키로 검증할 수 없다)
cp "$FD_DATA_DIR/server-key.pem" "$OUT/server-key.pem"
chmod 600 "$OUT/server-key.pem"
echo "백업: $OUT"
