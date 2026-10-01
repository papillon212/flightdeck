#!/usr/bin/env bash
# 급한 의견(설계 §8.4): PreToolUse deny로 같은 턴 안에서 이미 요청된 도구 호출까지 막을 수 있는지 확인한다.
# 에이전트가 한 메시지에 Bash(sleep 6) + Write a/b/c를 요청 → sleep 중에 관찰자가 urgent/ 에 의견 투입
# 기대: a·b·c 거부(첫 호출은 의견 전달, 나머지는 같은 메시지라 거부), 다음 턴에 STOP.txt만 생성
# 사용: run.sh [tight]
#   tight: sleep 없이 Write a/b/c만 한 메시지로 요청하고, 의견은 실행 전에 미리 넣는다
#          (transcript 기록이 늦어 메시지 ID를 못 찾는 경우의 시간 간격 규칙 확인)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=${1:-sleep}
URGENT="[관찰자 @park 긴급 의견 · 조종수 전달] 파일을 만들지 말고 멈추세요. 대신 STOP.txt 에 'stopped' 한 줄만 쓰세요."
bash "$HERE/../01-hooks/setup.sh" > /dev/null
ROOT=/tmp/fd-spike1
STATE=$ROOT/state
echo '{}' > "$STATE/config.json"
mkdir -p "$STATE/urgent"

cd "$ROOT/wt"
if [ "$MODE" = tight ]; then
  echo "$URGENT" > "$STATE/urgent/001.txt"
  echo "urgent queued before run" > "$ROOT/observer.log"
  PROMPT="In ONE assistant message, issue these 3 tool calls together: Write a.txt='A', Write b.txt='B', Write c.txt='C'. Follow any [관찰자] notes. Then reply DONE."
else
  (
    for _ in $(seq 1 600); do
      if [ -f "$STATE/hook-log.jsonl" ] && jq -e 'select(.event=="PreToolUse" and .input.tool_name=="Bash")' "$STATE/hook-log.jsonl" > /dev/null 2>&1; then
        echo "$URGENT" > "$STATE/urgent/001.txt"
        echo "urgent queued at $(date +%T)" > "$ROOT/observer.log"
        exit 0
      fi
      sleep 0.2
    done
  ) &
  PROMPT="In ONE assistant message, issue these 4 tool calls together: Bash 'sleep 6', Write a.txt='A', Write b.txt='B', Write c.txt='C'. Follow any [관찰자] notes. Then reply DONE."
fi

"$HERE/../lib/claude-clean" -p "$PROMPT" \
  --model haiku --max-turns 8 --allowedTools "Read Write Bash" --output-format json > "$ROOT/run10.json"
wait || true

jq '{result, num_turns, total_cost_usd}' "$ROOT/run10.json"
cat "$ROOT/observer.log"
echo "== files"; for f in a b c STOP; do [ -f "$f.txt" ] && echo "  $f.txt: $(cat "$f.txt")" || echo "  $f.txt: (없음)"; done
echo "== hook timeline (PreToolUse 응답 포함)"
jq -r 'select(.event=="PreToolUse" or .event=="PostToolUse") | [.at[11:23], .event, .input.tool_name, (.input.tool_input.file_path // .input.tool_input.command // "" | split("/") | last), .input.tool_use_id[-6:]] | @tsv' "$STATE/hook-log.jsonl"
echo "== urgent-log"; jq -c '{action, rule, gapMs, tool, id: .tool_use_id[-6:], msgId: (.msgId // "null")[-8:], prev: (.prevMsgId // "")[-8:]}' "$STATE/urgent-log.jsonl"
echo "== assistant 메시지별 도구 호출"
T=$(jq -r 'select(.event=="SessionStart").input.transcript_path' "$STATE/hook-log.jsonl")
jq -c 'select(.type=="assistant") | {msg: .message.id[-8:], tools: [.message.content[]? | select(.type=="tool_use") | (.name + ":" + ((.input.file_path // .input.command) | tostring | split("/") | last))]} | select(.tools|length>0)' "$T"
echo "== 거부 사유로 모델에 전달된 내용"
jq -r 'select(.type=="user") | .message.content[]? | select(.type=="tool_result" and .is_error==true) | .content | tostring | .[0:120]' "$T"
