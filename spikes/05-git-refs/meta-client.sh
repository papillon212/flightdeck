#!/usr/bin/env bash
# 메타 브랜치 클라이언트 1개: 이벤트 파일을 COUNT개 추가하며 매번 push. 거절되면 fetch → rebase → push 재시도 (설계 §3.1).
# 사용: meta-client.sh <remote> <workdir> <member> <count> <stats_file>
set -uo pipefail
REMOTE=$1 DIR=$2 MEMBER=$3 COUNT=$4 STATS=$5
BR=flightdeck-meta
MAX_TRIES=30

git clone -q --branch $BR "$REMOTE" "$DIR"
cd "$DIR"
git config user.name "$MEMBER"; git config user.email "$MEMBER@example.com"
mkdir -p epics/CU-1/events

for i in $(seq 1 "$COUNT"); do
  # 파일 이름 = <시각순 ID>-<member>.json (ULID 대용: 나노초 + 난수)
  id=$(python3 -c 'import time,random;print(f"{time.time_ns():020d}{random.randrange(16**6):06x}")')
  f=epics/CU-1/events/$id-$MEMBER.json
  printf '{"v":1,"id":"%s","type":"thread.replied","author":"%s","n":%d}\n' "$id" "$MEMBER" "$i" > "$f"
  git add "$f"
  git commit -q -m "event $id"

  tries=0 rebases=0 conflicts=0 lockfails=0
  while :; do
    tries=$((tries + 1))
    if out=$(git push -q origin HEAD:$BR 2>&1); then break; fi
    grep -qiE 'lock|cannot lock' <<<"$out" && lockfails=$((lockfails + 1))
    if [ $tries -ge $MAX_TRIES ]; then echo "$MEMBER $i GAVE_UP" >> "$STATS"; exit 1; fi
    git fetch -q origin $BR
    if ! git rebase -q origin/$BR > /dev/null 2>&1; then
      conflicts=$((conflicts + 1)); git rebase --abort
    fi
    rebases=$((rebases + 1))
    # 지수 백오프 + 지터 (최대 ~0.8초)
    sleep "$(python3 -c "import random;print(min(0.8, 0.02 * 2 ** $tries) * random.random())")"
  done
  echo "$MEMBER $i tries=$tries rebases=$rebases conflicts=$conflicts lockfails=$lockfails" >> "$STATS"
done
