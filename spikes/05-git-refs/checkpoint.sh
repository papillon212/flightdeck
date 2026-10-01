#!/usr/bin/env bash
# 숨은 커밋 체크포인트(설계 §8.1, §2.1) 검증. 원격은 로컬 bare 레포.
# 1) 임시 index + write-tree + commit-tree + update-ref 로 체크포인트 생성 → 브랜치·index·작업 트리 불변 확인
# 2) refs/flightdeck/ckpt/* push → 다른 클라이언트에서 fetch (기본 refspec으로는 안 받아짐 확인)
# 3) 다른 클라이언트가 체크포인트를 꺼내 파일이 같은지, 조종수 쪽 "이 시점으로 복원"
# 4) ref 삭제 + gc 후 원격 공간 회수
set -euo pipefail
ROOT=/tmp/fd-spike5/ckpt
rm -rf "$ROOT"
mkdir -p "$ROOT"
EPIC=CU-1
REF=refs/flightdeck/ckpt/$EPIC/dh.lee
ZERO=0000000000000000000000000000000000000000
say() { printf '\n== %s\n' "$*"; }
hashes() { (cd "$1" && find . -type f ! -path './.git' ! -path './.git/*' -print0 | sort -z | xargs -0 shasum -a 256 | sed 's/  / /'); }

# 체크포인트 생성: 사용자의 index를 복사한 임시 index에 작업 트리 전체를 담는다(stat 캐시 재사용)
ckpt() { # $1=worktree $2=step $3=seq
  local wt=$1 tmp tree old parent c
  tmp=$(mktemp)
  cp "$(git -C "$wt" rev-parse --git-path index)" "$tmp"
  GIT_INDEX_FILE=$tmp git -C "$wt" add -A
  tree=$(GIT_INDEX_FILE=$tmp git -C "$wt" write-tree)
  rm -f "$tmp"
  old=$(git -C "$wt" rev-parse -q --verify "$REF" || true)
  parent=${old:-$(git -C "$wt" rev-parse HEAD)}
  c=$(git -C "$wt" commit-tree "$tree" -p "$parent" -m "checkpoint step $2

Flightdeck-Run: 01JB7TEST
Flightdeck-Step: $2
Flightdeck-Source: agent
Flightdeck-Seq: $3")
  # CAS: 다른 프로세스가 그 사이 ref를 바꿨으면 실패한다
  git -C "$wt" update-ref -m "flightdeck ckpt" "$REF" "$c" "${old:-$ZERO}"
  echo "$c"
}

# --- 원격 + 에픽 브랜치 준비
git init -q --bare -b main "$ROOT/remote.git"
git clone -q "$ROOT/remote.git" "$ROOT/seed" 2>/dev/null
( cd "$ROOT/seed" && printf 'base\n' > app.txt && git add . && git commit -q -m base && git push -q origin HEAD:main HEAD:flightdeck/$EPIC )

# --- 클라이언트 A(조종수): 클론 + 에픽 worktree
git clone -q "$ROOT/remote.git" "$ROOT/A"
git -C "$ROOT/A" worktree add -q -b flightdeck/$EPIC "$ROOT/A-wt" origin/flightdeck/$EPIC
WT=$ROOT/A-wt
printf 'base\nedit-1\n' > "$WT/app.txt"           # 수정 (unstaged)
printf 'new file\n' > "$WT/new.txt"               # untracked
printf 'staged\n' > "$WT/staged.txt"; git -C "$WT" add staged.txt   # 사용자가 stage 해 둔 상태
head -c 2000000 /dev/urandom > "$WT/blob.bin"     # gc 회수 확인용 큰 파일

say "체크포인트 전 상태"
IDX=$(git -C "$WT" rev-parse --git-path index)
B_HEAD=$(git -C "$WT" rev-parse HEAD); B_IDX=$(shasum "$IDX" | cut -c1-12); B_STATUS=$(git -C "$WT" status --porcelain); B_FILES=$(hashes "$WT")
echo "HEAD=$B_HEAD index=$B_IDX"; echo "$B_STATUS"

C1=$(ckpt "$WT" 1 100)
printf 'base\nedit-1\nedit-2\n' > "$WT/app.txt"; rm "$WT/new.txt"; rm "$WT/blob.bin"
C2=$(ckpt "$WT" 2 140)
printf 'base\nedit-1\nedit-2\n' > /dev/null

say "체크포인트 후 상태 (브랜치·index·작업 트리 불변 확인)"
A_HEAD=$(git -C "$WT" rev-parse HEAD); A_IDX=$(shasum "$IDX" | cut -c1-12)
echo "HEAD   $([ "$A_HEAD" = "$B_HEAD" ] && echo 불변 || echo 변경됨!)  ($A_HEAD)"
echo "index  $([ "$A_IDX" = "$B_IDX" ] && echo 불변 || echo 변경됨!)  ($A_IDX)"
echo "branch flightdeck/$EPIC = $(git -C "$WT" rev-parse flightdeck/$EPIC)"
git -C "$WT" status --porcelain
echo "체크포인트 체인:"; git -C "$WT" log --format='  %h %s | %(trailers:key=Flightdeck-Step,key=Flightdeck-Seq,separator=%x2C )' "$REF" -3
echo "reflog:"; git -C "$WT" reflog show --format='  %h %gs' "$REF"

say "push (A → 원격)"
git -C "$WT" push origin "$REF:$REF" 2>&1 | sed 's/^/  /'
git -C "$ROOT/remote.git" for-each-ref --format='  remote: %(refname) %(objectname:short)' refs/flightdeck

say "클라이언트 B(관찰자): 기본 클론으로는 체크포인트가 안 받아짐"
git clone -q "$ROOT/remote.git" "$ROOT/B"
echo "  기본 클론 후 refs/flightdeck: [$(git -C "$ROOT/B" for-each-ref refs/flightdeck | wc -l | tr -d ' ')개]"
git -C "$ROOT/B" fetch -q origin "+refs/flightdeck/ckpt/$EPIC/*:refs/flightdeck/ckpt/$EPIC/*"
echo "  refspec 지정 fetch 후:"; git -C "$ROOT/B" for-each-ref --format='    %(refname) %(objectname:short)' refs/flightdeck
echo "  ckpt1 → ckpt2 diff:"; git -C "$ROOT/B" diff --stat "$C1" "$C2" | sed 's/^/    /'

say "B가 ckpt2를 읽기 전용 창(@live)으로 열기: 파일이 A 작업 트리와 같은가"
git -C "$ROOT/B" worktree add -q --detach "$ROOT/B-live" "$C2"
if diff <(hashes "$WT") <(hashes "$ROOT/B-live") > /dev/null; then echo "  A 작업 트리 == B@live (ckpt2): 일치"; else echo "  불일치"; diff <(hashes "$WT") <(hashes "$ROOT/B-live") | sed 's/^/    /'; fi

say "A에서 '이 시점으로 복원' (ckpt1). 복원 직전 상태도 체크포인트로 남긴다"
C3=$(ckpt "$WT" restore-point 141)
CUR_TREE=$(git -C "$WT" rev-parse "$C3^{tree}")
TMPIDX=$(mktemp); rm "$TMPIDX"
GIT_INDEX_FILE=$TMPIDX git -C "$WT" read-tree "$CUR_TREE"
GIT_INDEX_FILE=$TMPIDX git -C "$WT" update-index -q --refresh             # 임시 index에 stat 정보 채우기 (없으면 "not uptodate")
GIT_INDEX_FILE=$TMPIDX git -C "$WT" read-tree -m -u "$CUR_TREE" "$C1"   # 두 트리 병합: 삭제·추가 포함해 작업 트리만 갱신
rm -f "$TMPIDX"
EXP=$(mktemp -d); git -C "$ROOT/A" archive "$C1" | tar -x -C "$EXP"
if diff <(hashes "$WT") <(hashes "$EXP") > /dev/null; then echo "  복원 후 작업 트리 == ckpt1: 일치"; else echo "  불일치"; diff <(hashes "$WT") <(hashes "$EXP") | sed 's/^/    /'; fi
echo "  HEAD $([ "$(git -C "$WT" rev-parse HEAD)" = "$B_HEAD" ] && echo 불변 || echo 변경됨!), index $([ "$(shasum "$IDX" | cut -c1-12)" = "$B_IDX" ] && echo 불변 || echo 변경됨!)"
git -C "$WT" status --porcelain | sed 's/^/  /'

say "CAS: 오래된 값으로 update-ref 하면 거절"
git -C "$WT" update-ref "$REF" "$C1" "$C2" 2>&1 | sed 's/^/  /' || true

say "ref 삭제 + gc 후 원격 공간 회수 (§2.1)"
size() { git -C "$ROOT/remote.git" count-objects -v | awk '/size-pack|^size:/ {s+=$2} END {print s " KiB"}'; }
git -C "$ROOT/remote.git" gc -q --prune=now
echo "  ckpt 있을 때: $(size)"
git -C "$WT" push -q origin ":$REF"
git -C "$ROOT/remote.git" gc -q --prune=now
echo "  ckpt ref 삭제 + gc 후: $(size)"
