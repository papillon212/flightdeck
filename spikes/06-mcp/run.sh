#!/usr/bin/env bash
# worktree의 .mcp.json 최초 승인 흐름 확인 (설계 §6.1, M0 ②).
# case=plain : .mcp.json만 둔다
# case=enabled: settings.local.json에 enabledMcpjsonServers(서버 승인)와 permissions.allow(도구 호출 권한)를 미리 넣는다
# 사용: run.sh <plain|enabled> [p]   (두 번째 인자 p를 주면 claude -p로 도구 호출까지 확인 — 사용량 소모)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CASE=$1
ROOT=/tmp/fd-spike1
CLAUDE="$HERE/../lib/claude-clean"
bash "$HERE/../01-hooks/setup.sh" > /dev/null
echo '{}' > $ROOT/state/config.json
cd "$ROOT/wt"

jq -n --arg srv "$HERE/server.mjs" --arg st "$ROOT/state" \
  '{mcpServers: {flightdeck: {command: "node", args: [$srv], env: {FD_STATE: $st}}}}' > .mcp.json
if [ "$CASE" = enabled ]; then
  jq '. + {enabledMcpjsonServers: ["flightdeck"], permissions: {allow: ["mcp__flightdeck"]}}' .claude/settings.local.json > .claude/s.tmp && mv .claude/s.tmp .claude/settings.local.json
fi
echo "== git status (설정 파일이 추적 대상에 안 보여야 함)"; git status --short; echo "(끝)"

echo "== claude mcp list"
"$CLAUDE" mcp list 2>&1 | grep -iE 'flightdeck|no mcp|approv|pending' || true

echo "== 대화형 시작 화면 (프롬프트 없음)"
python3 "$HERE/../lib/screen.py" "$ROOT/wt" 8 -- "$CLAUDE" --model haiku | grep -iE 'mcp|server|flightdeck|approv|trust|exited_by' || true
echo "== MCP 서버 기동 기록"; cat "$ROOT/state/mcp-log.jsonl" 2>/dev/null | jq -c '{event, client: .client.name}' || echo "(기동 안 됨)"

if [ "${2:-}" = p ]; then
  : > "$ROOT/state/mcp-log.jsonl"
  echo "== claude -p 로 도구 호출"
  "$CLAUDE" -p "Call the flightdeck_ping tool and print its exact result. If unavailable, say NO_TOOL." \
    --model haiku --max-turns 3 --output-format json | jq '{result, total_cost_usd}'
  echo "== MCP 서버 기록"; jq -c '{event, name}' "$ROOT/state/mcp-log.jsonl" 2>/dev/null || echo "(기동 안 됨)"
fi
