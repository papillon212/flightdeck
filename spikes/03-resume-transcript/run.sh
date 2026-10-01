#!/usr/bin/env bash
# headless 초안 세션을 대화형으로 이어가고(resume), 그동안 transcript_path를 실시간으로 따라 읽는다 (설계 §6.1, §8.3).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
bash "$HERE/../01-hooks/setup.sh" > /dev/null
ROOT=/tmp/fd-spike1
STATE=$ROOT/state
cat > "$STATE/config.json" <<'JSON'
{
  "promptContext": "[Flightdeck] 답변 마지막 줄에 [fd-ok] 를 붙여라.",
  "denyBash": "^\\s*git\\b"
}
JSON

CLAUDE="$HERE/../lib/claude-clean"
cd "$ROOT/wt"
# 1) headless 초안
"$CLAUDE" -p "Remember the word MANGO. Reply only: OK" --model haiku --max-turns 2 --output-format json > "$ROOT/run3-headless.json"
SID=$(jq -r .session_id "$ROOT/run3-headless.json")
echo "headless session: $SID  result: $(jq -r .result "$ROOT/run3-headless.json")"

# 2) 관찰자 tailer 시작 (훅 로그에서 transcript_path를 찾아 따라 읽기)
rm -f "$ROOT/tail3.jsonl"
node "$HERE/tail.mjs" "$STATE" "$ROOT/tail3.jsonl" 150 &
TAIL=$!

# 3) 대화형 resume
python3 "$HERE/drive.py" "$ROOT/wt" "$ROOT/screen3.log" \
  "What word did I ask you to remember? Then run bash: git log -1. Answer in one line." \
  -- "$CLAUDE" --resume "$SID" --model haiku
sleep 2
kill $TAIL 2>/dev/null || true

echo "== hook sessions"
jq -r '[.at[11:23], .event, .input.source // "", .input.session_id[0:8], (.input.transcript_path | split("/") | last)] | @tsv' "$STATE/hook-log.jsonl" | grep -E 'SessionStart|UserPrompt|Stop|PreToolUse' || true
echo "== transcript files"
ls -la "$(dirname "$(jq -r 'select(.event=="SessionStart").input.transcript_path' "$STATE/hook-log.jsonl" | head -1)")"
