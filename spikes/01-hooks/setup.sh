#!/usr/bin/env bash
# /tmp/fd-spike1(또는 FD_ROOT) 아래에 레포 + 에픽 worktree를 만들고, worktree의 .claude/settings.local.json에 훅을 등록한다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=${FD_ROOT:-/tmp/fd-spike1}
rm -rf "$ROOT"
mkdir -p "$ROOT/state"

git init -q -b main "$ROOT/repo"
cd "$ROOT/repo"
printf 'line1\nline2\nline3\n' > notes.txt
git add notes.txt
git commit -q -m init
git worktree add -q -b flightdeck/CU-test "$ROOT/wt"

# worktree의 Claude Code 설정은 git 추적에서 뺀다 (설계 §6.1)
printf '.claude/settings.local.json\n.mcp.json\n' >> "$(git rev-parse --git-common-dir)/info/exclude"

HOOK="FD_STATE=$ROOT/state node $HERE/hook.mjs"
mkdir -p "$ROOT/wt/.claude"
jq -n --arg cmd "$HOOK" '
  def h: [{hooks: [{type: "command", command: $cmd}]}];
  def hm: [{matcher: "*", hooks: [{type: "command", command: $cmd}]}];
  {hooks: {SessionStart: h, UserPromptSubmit: h, PreToolUse: hm, PostToolUse: hm, Stop: h}}
' > "$ROOT/wt/.claude/settings.local.json"

cat > "$ROOT/state/config.json" <<'JSON'
{
  "sessionStartContext": "[Flightdeck] 이 에픽의 확인 코드는 PINEAPPLE-42 이다.",
  "promptContext": "[Flightdeck] 현재 단계: ANALYSIS. 답변 마지막 줄에 [fd-ok] 를 붙여라.",
  "denyPath": "blocked",
  "denyBash": "^\\s*git\\b"
}
JSON

echo "worktree: $ROOT/wt"
cat "$ROOT/wt/.claude/settings.local.json"
git -C "$ROOT/wt" status --short
