#!/usr/bin/env bash
# 여러 클라이언트가 같은 메타 브랜치에 동시에 push할 때 유실·충돌 없이 모두 반영되는지 확인한다.
# 사용: meta-concurrency.sh <clients> <events_per_client>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
N=${1:-5} M=${2:-20}
ROOT=/tmp/fd-spike5/meta-$N-$M
rm -rf "$ROOT"; mkdir -p "$ROOT"
STATS=$ROOT/stats.txt; : > "$STATS"

git init -q --bare -b main "$ROOT/remote.git"
git clone -q "$ROOT/remote.git" "$ROOT/seed" 2>/dev/null
( cd "$ROOT/seed" && git checkout -q --orphan flightdeck-meta && printf '# meta\n' > README.md && git add . && git commit -q -m "meta init" && git push -q origin flightdeck-meta )

start=$(python3 -c 'import time;print(time.time())')
pids=()
for c in $(seq 1 "$N"); do
  bash "$HERE/meta-client.sh" "$ROOT/remote.git" "$ROOT/c$c" "m$c" "$M" "$STATS" &
  pids+=($!)
done
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=$((fail + 1)); done
elapsed=$(python3 -c "import time;print(f'{time.time()-$start:.1f}')")

echo "== 클라이언트 ${N}개 × 이벤트 ${M}개 (동시 실행), ${elapsed}s, 실패 클라이언트 ${fail}"
expected=$((N * M))
on_remote=$(git -C "$ROOT/remote.git" ls-tree -r --name-only flightdeck-meta -- epics/CU-1/events | wc -l | tr -d ' ')
unique=$(git -C "$ROOT/remote.git" ls-tree -r --name-only flightdeck-meta -- epics/CU-1/events | sort -u | wc -l | tr -d ' ')
commits=$(git -C "$ROOT/remote.git" rev-list --count flightdeck-meta)
merges=$(git -C "$ROOT/remote.git" rev-list --count --merges flightdeck-meta)
echo "원격 이벤트 파일: $on_remote / 기대 $expected (중복 제거 $unique)"
echo "원격 커밋: $commits (머지 커밋 $merges → 선형 이력 $([ "$merges" = 0 ] && echo 예 || echo 아니오))"
# 클라이언트별로 보낸 n이 전부 있는지
missing=0
for c in $(seq 1 "$N"); do
  got=$(git -C "$ROOT/remote.git" ls-tree -r --name-only flightdeck-meta -- epics/CU-1/events | grep -c -- "-m$c.json" || true)
  [ "$got" = "$M" ] || { echo "  m$c: $got/$M"; missing=$((missing + 1)); }
done
echo "누락 클라이언트: $missing"
awk '{for(i=3;i<=NF;i++){split($i,a,"=");s[a[1]]+=a[2]; if(a[1]=="tries" && a[2]>mx) mx=a[2]}; n++}
     END {printf "push 시도 합계 %d (이벤트당 평균 %.2f, 최대 %d), rebase %d, rebase 충돌 %d, lock 실패 %d\n", s["tries"], s["tries"]/n, mx, s["rebases"], s["conflicts"], s["lockfails"]}' "$STATS"
grep -c GAVE_UP "$STATS" | sed 's/^/포기(GAVE_UP): /' || true
