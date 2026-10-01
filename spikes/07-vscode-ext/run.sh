#!/usr/bin/env bash
# VS Code 확장 스파이크 실행. 별도 사용자 프로필(--user-data-dir)로 깨끗한 VS Code 창을 띄운다.
# 사용: run.sh auto   → 자동 테스트 후 창이 스스로 닫히고 결과 출력
#       run.sh manual → 창을 띄워 둔다. 직접 편집 후 'Flightdeck Spike: 편집 기록 검증' 실행
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=${1:-auto}
ROOT=/tmp/fd-spike7
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
rm -rf "$ROOT/ws" "$ROOT/state"
mkdir -p "$ROOT/ws/.vscode" "$ROOT/state"
cd "$ROOT/ws"

cat > analysis.md <<'MD'
<!-- p:7f3a -->
## 요구사항 요약
<!-- p:a91c -->
액세스 토큰은 Redis에 저장하고 만료 시 리프레시 토큰으로 갱신한다.

<!-- p:b22d -->
## 영향 범위
MD
printf '첫째 줄\n둘째 줄\n셋째 줄\n' > ko.txt
printf 'one\r\ntwo\r\nthree\r\n' > crlf.txt
printf 'let x = 1;' > a.ts
printf 'line1\nline2\nline3\n' > notes.txt
cat > .vscode/settings.json <<'JSON'
{ "files.trimTrailingWhitespace": true, "files.insertFinalNewline": true, "security.workspace.trust.enabled": false }
JSON
[ "$MODE" = auto ] && touch "$ROOT/state/auto"

FD_STATE="$ROOT/state" "$CODE" --new-window --user-data-dir "$ROOT/udd" --extensions-dir "$ROOT/exts" \
  --disable-workspace-trust --skip-welcome --skip-release-notes \
  --extensionDevelopmentPath="$HERE" "$ROOT/ws"

if [ "$MODE" = auto ]; then
  for _ in $(seq 1 90); do [ -f "$ROOT/state/done" ] && break; sleep 1; done
  [ -f "$ROOT/state/done" ] || echo "(90초 안에 끝나지 않음)"
  jq -r .line "$ROOT/state/report.log.jsonl"
  echo "== 편집 이벤트"; jq -c '{seq, file, changes, reason, dirty_after, equals_disk_after, shadow_ok}' "$ROOT/state/editlog.jsonl"
  echo "== 열 때 문서=디스크"; jq -c '{file, same_as_disk, eol}' "$ROOT/state/opens.jsonl"
  echo "== 저장 시 문서=디스크"; jq -c '{file, match}' "$ROOT/state/saves.jsonl"
  [ -f "$ROOT/state/errors.jsonl" ] && { echo "== 오류"; cat "$ROOT/state/errors.jsonl"; }
fi
