#!/usr/bin/env bash
# GitHub에서 숨은 커밋 체크포인트 ref가 push/fetch/삭제되는지 확인한다 (설계 §8.1, §2.1, M0 ⑥).
# 실제 레포를 쓰므로 refs/flightdeck-spike/* 이름공간만 쓰고 끝나면 지운다.
# 사용: checkpoint.sh <remote_url>
set -euo pipefail
REMOTE=$1
ROOT=/tmp/fd-spike9
REF=refs/flightdeck-spike/ckpt/CU-1/dh.lee
ZERO=0000000000000000000000000000000000000000
export GIT_SSH_COMMAND="ssh -o ConnectTimeout=15"
rm -rf "$ROOT"; mkdir -p "$ROOT"
say() { printf '\n== %s\n' "$*"; }
hashes() { (cd "$1" && find . -type f ! -path './.git' ! -path './.git/*' -print0 | sort -z | xargs -0 shasum -a 256 | sed 's/  / /'); }
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

ckpt() { # 5번과 같은 방식 + 디스크 바이트 그대로(§8.1 v0.9)
  local wt=$1 tmp tree old parent c
  tmp=$(mktemp)
  cp "$(git -C "$wt" rev-parse --git-path index)" "$tmp"
  GIT_INDEX_FILE=$tmp GIT_ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904 git -C "$wt" -c core.autocrlf=false add -A
  tree=$(GIT_INDEX_FILE=$tmp git -C "$wt" write-tree); rm -f "$tmp"
  old=$(git -C "$wt" rev-parse -q --verify "$REF" || true)
  parent=${old:-$(git -C "$wt" rev-parse HEAD)}
  c=$(git -C "$wt" commit-tree "$tree" -p "$parent" -m "checkpoint step $2

Flightdeck-Step: $2
Flightdeck-Source: agent")
  git -C "$wt" update-ref "$REF" "$c" "${old:-$ZERO}"
  echo "$c"
}

say "A: 클론 + worktree + 편집 + 체크포인트"
git clone -q "$REMOTE" "$ROOT/A"
git -C "$ROOT/A" worktree add -q --detach "$ROOT/A-wt" origin/main
WT=$ROOT/A-wt
printf 'spike edit\r\nCRLF line\r\n' > "$WT/spike-crlf.txt"
printf 'new untracked\n' > "$WT/spike-new.txt"
head -c 300000 /dev/urandom > "$WT/spike.bin"
C1=$(ckpt "$WT" 1)
echo "  ckpt1 $C1, HEAD $(git -C "$WT" rev-parse --short HEAD) (불변), status:"; git -C "$WT" status --porcelain | sed 's/^/    /'

say "A → GitHub push (커스텀 ref)"
t=$(ms); git -C "$WT" push origin "$REF:$REF" 2>&1 | sed 's/^/  /'; echo "  push $(( $(ms) - t ))ms"
echo "  ls-remote:"; git ls-remote "$REMOTE" 'refs/flightdeck-spike/*' | sed 's/^/    /'

say "B: 기본 클론에는 안 보임 → refspec fetch"
git clone -q "$REMOTE" "$ROOT/B"
echo "  기본 클론 후 refs/flightdeck-spike: [$(git -C "$ROOT/B" for-each-ref refs/flightdeck-spike | wc -l | tr -d ' ')개]"
echo "  --mirror 아닌 'fetch --all' 후: [$(git -C "$ROOT/B" fetch -q --all && git -C "$ROOT/B" for-each-ref refs/flightdeck-spike | wc -l | tr -d ' ')개]"
t=$(ms); git -C "$ROOT/B" fetch -q origin "+refs/flightdeck-spike/ckpt/CU-1/*:refs/flightdeck-spike/ckpt/CU-1/*"; echo "  refspec fetch $(( $(ms) - t ))ms"
git -C "$ROOT/B" for-each-ref --format='    %(refname) %(objectname:short)' refs/flightdeck-spike
git -C "$ROOT/B" worktree add -q --detach "$ROOT/B-live" "$C1"
if diff <(hashes "$WT") <(hashes "$ROOT/B-live") > /dev/null; then echo "  A 작업 트리 == B 체크아웃(ckpt1): 일치 (CRLF·바이너리 포함)"; else echo "  불일치"; diff <(hashes "$WT") <(hashes "$ROOT/B-live") | sed 's/^/    /'; fi

say "체인 갱신: ckpt2 push (fast-forward), 오래된 값으로 덮어쓰기(force 아님) 거절 확인"
printf 'second\n' >> "$WT/spike-new.txt"
C2=$(ckpt "$WT" 2)
git -C "$WT" push origin "$REF:$REF" 2>&1 | sed 's/^/  /'
echo "  B가 오래된 ckpt1 기준 다른 커밋을 force 없이 push:"
git -C "$ROOT/B" commit-tree "$C1^{tree}" -p "$C1" -m "stale" > "$ROOT/stale"
git -C "$ROOT/B" push origin "$(cat "$ROOT/stale"):$REF" 2>&1 | sed 's/^/    /' || true

say "삭제"
git -C "$WT" push origin ":$REF" 2>&1 | sed 's/^/  /'
echo "  ls-remote 후: [$(git ls-remote "$REMOTE" 'refs/flightdeck-spike/*' | wc -l | tr -d ' ')개]"
echo "  삭제된 커밋을 SHA로 직접 fetch:"
git -C "$ROOT/B" fetch origin "$C2" 2>&1 | sed 's/^/    /' || true
