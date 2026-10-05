#!/usr/bin/env bash
# 멤버 기기 준비 (docs/install.md "멤버 기기"): 필요한 프로그램 확인 → Flightdeck 확장(VSIX) 설치 → VS Code 설정.
# 사용:
#   deploy/member/setup.sh --vsix flightdeck-0.1.0.vsix --server-key SHA256:… --product my-product --member my.id [--write-settings]
# --write-settings: VS Code 사용자 설정(settings.json)에 Flightdeck 설정을 넣는다(백업을 남긴다). 없으면 넣을 내용을 보여 주기만 한다.
set -euo pipefail
VSIX="" KEY="" PRODUCT="" MEMBER="" WRITE=0 URL="http://127.0.0.1:8787"
while [ $# -gt 0 ]; do
  case "$1" in
    --vsix) VSIX=$2; shift 2 ;;
    --server-key) KEY=$2; shift 2 ;;
    --product) PRODUCT=$2; shift 2 ;;
    --member) MEMBER=$2; shift 2 ;;
    --server-url) URL=$2; shift 2 ;;
    --write-settings) WRITE=1; shift ;;
    *) echo "모르는 인자: $1"; exit 1 ;;
  esac
done
[ -n "$VSIX" ] && [ -n "$KEY" ] && [ -n "$PRODUCT" ] && [ -n "$MEMBER" ] || { sed -n '3,5p' "$0"; exit 1; }

ok() { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; FAIL=1; }
FAIL=0
echo "필요한 프로그램"
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then ok "Node $(node -v)"; else bad "Node 22 이상 (에이전트 훅이 node로 실행된다)"; fi
if command -v git >/dev/null; then ok "$(git --version)"; else bad "git"; fi
CODE=$(command -v code || true)
[ -z "$CODE" ] && [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ] && CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [ -n "$CODE" ]; then ok "VS Code CLI"; else bad "VS Code (code 명령: VS Code에서 'Shell Command: Install code command in PATH')"; fi
if command -v claude >/dev/null; then ok "Claude Code $(claude --version 2>/dev/null | head -1)"; else bad "Claude Code (설치 후 개인 구독으로 로그인)"; fi
if [ -n "$(git config --global user.email || true)" ]; then ok "git 사용자 $(git config --global user.name) <$(git config --global user.email)>"; else bad "git 사용자 이름·이메일 (git config --global user.name/user.email)"; fi
[ "$FAIL" = 0 ] || { echo "위 항목을 먼저 준비하세요"; exit 1; }

echo "확장 설치"
# FD_CODE_ARGS: 다른 VS Code 프로필에 설치할 때 (예: "--user-data-dir X --extensions-dir Y")
# shellcheck disable=SC2086
"$CODE" ${FD_CODE_ARGS:-} --install-extension "$VSIX" --force >/dev/null 2>&1 && ok "$(basename "$VSIX")"

SETTINGS=$(cat <<EOF
{
  "flightdeck.serverUrl": "$URL",
  "flightdeck.serverKeyFingerprint": "$KEY",
  "flightdeck.product": "$PRODUCT",
  "flightdeck.devLoginMember": "$MEMBER"
}
EOF
)
case "$(uname)" in
  Darwin) USER_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json" ;;
  *) USER_SETTINGS="${XDG_CONFIG_HOME:-$HOME/.config}/Code/User/settings.json" ;;
esac
USER_SETTINGS=${FD_VSCODE_SETTINGS:-$USER_SETTINGS} # 다른 VS Code 프로필이면 그 settings.json
if [ "$WRITE" = 1 ]; then
  mkdir -p "$(dirname "$USER_SETTINGS")"
  [ -f "$USER_SETTINGS" ] && cp "$USER_SETTINGS" "$USER_SETTINGS.bak-$(date +%Y%m%d%H%M%S)"
  # 주석이 있는 settings.json(JSONC)은 고치지 않는다: 직접 넣도록 안내
  node -e '
    const fs = require("fs"); const [file, add] = [process.argv[1], JSON.parse(process.argv[2])];
    let cur = {};
    if (fs.existsSync(file)) { try { cur = JSON.parse(fs.readFileSync(file, "utf8") || "{}"); } catch { console.error("settings.json에 주석 등이 있어 고치지 않았다. 아래 내용을 직접 넣으세요"); process.exit(2); } }
    fs.writeFileSync(file, JSON.stringify({ ...cur, ...add }, null, 2) + "\n");
  ' "$USER_SETTINGS" "$SETTINGS" && ok "VS Code 설정: $USER_SETTINGS" || echo "$SETTINGS"
else
  echo "VS Code 사용자 설정에 넣을 내용 (명령 팔레트 → 'Preferences: Open User Settings (JSON)'):"
  echo "$SETTINGS"
fi

cat <<EOF

다음
  1. 터널을 켠다: deploy/member/tunnel.sh <ssh 대상>   (작업하는 동안 켜 둔다)
  2. VS Code에서 'Flightdeck: 서버 레포 받기' → 폴더를 고르면 레포를 받아 연다
  3. 'Flightdeck: 일감 도구(ClickUp) 개인 토큰 설정'으로 내 ClickUp 토큰을 넣는다
  4. 처음 여는 에픽 창은 '신뢰'를 눌러야 Flightdeck 훅이 동작한다
EOF
