#!/usr/bin/env bash
# 여러 클라이언트가 같은 메타 ref에 동시에 push할 때 유실·충돌 없이 모두 반영되는지 확인한다.
# 사용: meta-concurrency.sh <clients> <events_per_client>
# REMOTE: 원격 URL (없으면 로컬 bare 레포를 만든다). META_REF: 대상 ref (기본 refs/heads/flightdeck-meta)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
N=${1:-5} M=${2:-20}
export META_REF=${META_REF:-refs/heads/flightdeck-meta}
ROOT=/tmp/fd-spike5/meta-$N-$M${REMOTE:+-remote}
rm -rf "$ROOT"; mkdir -p "$ROOT"
STATS=$ROOT/stats.txt; : > "$STATS"

if [ -z "${REMOTE:-}" ]; then
  git init -q --bare -b main "$ROOT/remote.git"
  REMOTE=$ROOT/remote.git
fi

# 메타 ref 초기화: 고아 커밋 하나로 시작
git init -q "$ROOT/seed"
( cd "$ROOT/seed" && printf '# meta\n' > README.md && git add . && git -c user.name=seed -c user.email=seed@example.com commit -q -m "meta init" \
  && git push -q -f "$REMOTE" "HEAD:$META_REF" )

start=$(python3 -c 'import time;print(time.time())')
pids=()
for c in $(seq 1 "$N"); do
  bash "$HERE/meta-client.sh" "$REMOTE" "$ROOT/c$c" "m$c" "$M" "$STATS" &
  pids+=($!)
done
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=$((fail + 1)); done
elapsed=$(python3 -c "import time;print(f'{time.time()-$start:.1f}')")

# 원격에서 다시 받아 확인
git init -q "$ROOT/verify"
git -C "$ROOT/verify" fetch -q "$REMOTE" "+$META_REF:refs/check"
files=$(git -C "$ROOT/verify" ls-tree -r --name-only refs/check -- epics/CU-1/events)

echo "== 원격 ${REMOTE} ${META_REF}"
echo "== 클라이언트 ${N}개 × 이벤트 ${M}개 (동시 실행), ${elapsed}s, 실패 클라이언트 ${fail}"
expected=$((N * M))
echo "원격 이벤트 파일: $(grep -c . <<<"$files") / 기대 ${expected} (중복 제거 $(sort -u <<<"$files" | grep -c .))"
commits=$(git -C "$ROOT/verify" rev-list --count refs/check)
merges=$(git -C "$ROOT/verify" rev-list --count --merges refs/check)
echo "원격 커밋: ${commits} (머지 커밋 ${merges} → 선형 이력 $([ "$merges" = 0 ] && echo 예 || echo 아니오))"
missing=0
for c in $(seq 1 "$N"); do
  got=$(grep -c -- "-m$c.json" <<<"$files" || true)
  [ "$got" = "$M" ] || { echo "  m$c: $got/$M"; missing=$((missing + 1)); }
done
echo "누락 클라이언트: ${missing}"
awk '{for(i=3;i<=NF;i++){split($i,a,"=");s[a[1]]+=a[2]; if(a[1]=="tries" && a[2]>mx) mx=a[2]; if(a[1]=="ms") {ms[n]=a[2]}}; n++}
     END {asort(ms); printf "push 시도 합계 %d (이벤트당 평균 %.2f, 최대 %d), rebase %d, rebase 충돌 %d, lock 실패 %d, non-ff %d\n", s["tries"], s["tries"]/n, mx, s["rebases"], s["conflicts"], s["lockfails"], s["nonff"];
          printf "이벤트당 반영 시간(ms): 중앙값 %d, 최대 %d\n", ms[int((n+1)/2)], ms[n]}' "$STATS" 2>/dev/null \
  || awk '{for(i=3;i<=NF;i++){split($i,a,"=");s[a[1]]+=a[2]; if(a[1]=="tries" && a[2]>mx) mx=a[2]; if(a[1]=="ms" && a[2]>mm) mm=a[2]}; n++}
     END {printf "push 시도 합계 %d (이벤트당 평균 %.2f, 최대 %d), rebase %d, rebase 충돌 %d, lock 실패 %d, non-ff %d\n이벤트당 반영 시간(ms): 평균 %d, 최대 %d\n", s["tries"], s["tries"]/n, mx, s["rebases"], s["conflicts"], s["lockfails"], s["nonff"], s["ms"]/n, mm}' "$STATS"
echo "포기(GAVE_UP): $(grep -c GAVE_UP "$STATS" || true)"
[ -s "$STATS.errors" ] && { echo "== push 오류 종류"; sed -E 's/^m[0-9]+ [0-9]+ push-error: //' "$STATS.errors" | sed -E 's/[0-9a-f]{7,40}//g' | sort | uniq -c | sort -rn | head -5; }
true
