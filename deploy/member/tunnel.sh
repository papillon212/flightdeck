#!/usr/bin/env bash
# 서버로 가는 SSH 터널 (docs/install.md "멤버 기기"): 이 기기의 127.0.0.1:8787 → 서버 기기의 127.0.0.1:8787.
# 사용: deploy/member/tunnel.sh <ssh 대상, 예: me@flightdeck-host> [로컬 포트, 기본 8787]
# 끊기면 3초 뒤 다시 잇는다. 작업하는 동안 켜 둔다(VS Code의 Flightdeck·git push·실시간 관찰이 모두 이 터널로 간다).
set -uo pipefail
HOST=${1:?ssh 대상이 필요하다 (예: me@flightdeck-host)}
PORT=${2:-8787}
while true; do
  echo "$(date +%T) 터널 연결: 127.0.0.1:$PORT → $HOST:8787"
  ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L "$PORT:127.0.0.1:8787" "$HOST"
  echo "$(date +%T) 터널이 끊겼다. 3초 뒤 다시 연결한다 (멈추려면 Ctrl+C)"
  sleep 3
done
