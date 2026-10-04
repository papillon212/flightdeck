#!/usr/bin/env bash
# M2 수동 시나리오 (docs/m2-plan.md): 이 PC에서 멤버 두 명의 VS Code 창을 연다.
# 멤버마다 VS Code 사용자 데이터 폴더가 따로라 설정·비밀 저장소(로그인 세션, 일감 토큰)가 섞이지 않는다.
# 준비물: flightdeck-server가 127.0.0.1:8787에서 실행 중, /tmp/fd-m2/<멤버>/{test-flightdeck,vscode} (설정은 vscode/User/settings.json)
# CLICKUP_TOKEN을 주면 dh.lee 창에 일감 토큰으로 넘긴다(개발 모드에서만 받음). 없으면 창에서 "일감 도구 개인 토큰 설정"으로 넣는다.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
curl -sf http://127.0.0.1:8787/health >/dev/null || { echo "서버가 꺼져 있다 (http://127.0.0.1:8787)"; exit 1; }
for m in dh.lee park; do
  FLIGHTDECK_TRACKER_TOKEN=$([ "$m" = dh.lee ] && echo "${CLICKUP_TOKEN:-}" || true) \
    "$CODE" --user-data-dir "/tmp/fd-m2/$m/vscode" --extensionDevelopmentPath="$ROOT/packages/vscode/ext" --new-window "/tmp/fd-m2/$m/test-flightdeck"
done
echo "창 두 개를 열었다: [dh.lee] 담당자, [park] 질문 대상"
