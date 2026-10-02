#!/usr/bin/env bash
# 회의 종료 후 Gemini 회의록·전사가 생성되기까지 걸리는 시간을 잰다 (설계 §10.1 ⑤, M0 ④).
# 지금 이후에 시작한 회의를 1분마다 찾고, 회의록(smartNotes)·전사(transcripts)의 상태 변화 시각을 기록한다.
# 읽기 전용. 회의 내용(문서 본문, 전사 텍스트)은 읽지 않는다.
# 사용: poll.sh <out_file> [max_minutes]
set -uo pipefail
OUT=$1
MAX=${2:-240}
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
api() { gws meet "$@" 2>/dev/null | sed -n '/^{/,$p'; }
log() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$OUT"; }

log "폴링 시작. 기준 시각(UTC) $START 이후 시작한 회의를 찾음"
declare -A seen
for _ in $(seq 1 "$MAX"); do
  recs=$(api conferenceRecords list --params '{"pageSize": 5}' | jq -c --arg s "$START" '[.conferenceRecords[]? | select(.startTime > $s)]')
  for r in $(jq -r '.[] | @base64' <<<"$recs"); do
    rec=$(base64 -d <<<"$r")
    name=$(jq -r .name <<<"$rec")
    end=$(jq -r '.endTime // "진행 중"' <<<"$rec")
    key="$name|$end"
    [ -z "${seen[$key]:-}" ] && { log "회의 ${name:18:10} 시작 $(jq -r .startTime <<<"$rec") 종료 $end"; seen[$key]=1; }
    [ "$end" = "진행 중" ] && continue
    sn=$(api conferenceRecords smartNotes list --params "{\"parent\": \"$name\"}" | jq -r '[.smartNotes[]?.state] | join(",") | if . == "" then "없음" else . end')
    tr=$(api conferenceRecords transcripts list --params "{\"parent\": \"$name\"}" | jq -r '[.transcripts[]?.state] | join(",") | if . == "" then "없음" else . end')
    k2="$name|sn=$sn|tr=$tr"
    [ -z "${seen[$k2]:-}" ] && { log "  회의록=$sn 전사=$tr"; seen[$k2]=1; }
    if [[ "$sn" == *FILE_GENERATED* && "$tr" == *FILE_GENERATED* ]]; then log "  둘 다 생성 완료. 종료"; exit 0; fi
  done
  sleep 60
done
log "최대 시간(${MAX}분) 도달. 종료"
