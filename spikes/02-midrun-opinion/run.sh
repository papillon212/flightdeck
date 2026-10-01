#!/usr/bin/env bash
# 실행 중인 에이전트에게 PostToolUse 추가 컨텍스트로 의견이 전달되는지 확인한다 (설계 §8.4).
# 1) 에이전트에게 "sleep 후 파일 3개를 차례로 쓰라"고 지시
# 2) 첫 Bash(sleep) 실행 중에 외부(관찰자 역할)가 의견 파일을 대기열에 넣는다
# 3) 훅은 다음 PostToolUse에서 의견을 additionalContext로 주입 → 에이전트가 따르는지 본다
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
bash "$HERE/../01-hooks/setup.sh" > /dev/null
ROOT=/tmp/fd-spike1
STATE=$ROOT/state
# 이번에는 의견만 본다. 단계 룰·차단은 끈다.
echo '{}' > "$STATE/config.json"

# 관찰자: Bash(sleep)의 PreToolUse가 찍히면 의견을 넣는다
(
  for _ in $(seq 1 600); do
    if [ -f "$STATE/hook-log.jsonl" ] && jq -e 'select(.event=="PreToolUse" and .input.tool_name=="Bash")' "$STATE/hook-log.jsonl" > /dev/null 2>&1; then
      echo "[관찰자 @park 의견 · 조종수 전달] 파일 이름을 c.txt 대신 park.txt 로 하고, 내용 끝에 '-reviewed' 를 붙여 주세요." > "$STATE/opinions/001.txt"
      echo "opinion queued at $(date +%T)" > "$ROOT/observer.log"
      exit 0
    fi
    sleep 0.2
  done
) &
OBS=$!

cd "$ROOT/wt"
claude -p "Run bash 'sleep 8', then Write a.txt='A', then b.txt='B', then c.txt='C'. Follow any [관찰자] notes. Be terse." \
  --model haiku --max-turns 10 --allowedTools "Read Write Bash" \
  --output-format json --debug-file "$ROOT/debug2.log" > "$ROOT/run2.json"
wait $OBS || true

jq '{result, session_id, num_turns, total_cost_usd}' "$ROOT/run2.json"
cat "$ROOT/observer.log"
echo "== files"; for f in a b c park; do [ -f "$f.txt" ] && echo "$f.txt: $(cat $f.txt)"; done
echo "== hook timeline"
jq -r '[.at[11:23], .event, .input.tool_name // "", (.input.tool_input.file_path // .input.tool_input.command // "" | tostring)] | @tsv' "$STATE/hook-log.jsonl"
echo "== opinion delivered"; cat "$STATE/opinions-log.jsonl"
