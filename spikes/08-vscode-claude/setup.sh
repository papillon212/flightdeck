#!/usr/bin/env bash
# 수동 검증 세션 준비: 아직 신뢰한 적 없는 새 레포(/tmp/fd-spike8)에 에픽 worktree를 만들고
# 훅 + .mcp.json(미리 허용) + 스파이크 확장(07)을 사용자의 평소 VS Code에 띄운다.
# 확인 대상: 공식 Claude Code VS Code 확장의 신뢰 창·훅·MCP, Comments 쓰레드 화면 위치, 한글 IME 입력 기록.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/tmp/fd-spike8
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"

FD_ROOT=$ROOT bash "$HERE/../01-hooks/setup.sh" > /dev/null
cat > "$ROOT/state/config.json" <<'JSON'
{
  "sessionStartContext": "[Flightdeck] 이 에픽의 확인 코드는 KIWI-77 이다.",
  "promptContext": "[Flightdeck] 답변 마지막 줄에 [fd-ok] 를 붙여라.",
  "denyBash": "^\\s*git\\b"
}
JSON

cd "$ROOT/wt"
jq -n --arg srv "$HERE/../06-mcp/server.mjs" --arg st "$ROOT/state" \
  '{mcpServers: {flightdeck: {command: "node", args: [$srv], env: {FD_STATE: $st}}}}' > .mcp.json
jq '. + {enabledMcpjsonServers: ["flightdeck"], permissions: {allow: ["mcp__flightdeck"]}}' .claude/settings.local.json > .claude/s.tmp
mv .claude/s.tmp .claude/settings.local.json

cat > analysis.md <<'MD'
<!-- p:7f3a -->
## 요구사항 요약
<!-- p:a91c -->
액세스 토큰은 Redis에 저장하고 만료 시 리프레시 토큰으로 갱신한다.

<!-- p:b22d -->
## 영향 범위
MD
printf '첫째 줄\n둘째 줄\n셋째 줄\n' > ko.txt
git add analysis.md ko.txt && git commit -q -m "fixtures"

# 스파이크 확장의 상태 디렉터리 초기화 (수동 모드: auto 파일 없음)
rm -rf /tmp/fd-spike7/state && mkdir -p /tmp/fd-spike7/state

echo "신뢰 기록(있으면 안 됨): $(python3 -c "import json;d=json.load(open('$HOME/.claude.json'));print([k for k in d.get('projects',{}) if 'fd-spike8' in k])")"
"$CODE" --new-window --extensionDevelopmentPath="$HERE/../07-vscode-ext" "$ROOT/wt"
echo "VS Code 창을 열었습니다: $ROOT/wt"
