#!/usr/bin/env bash
# 에이전트 편집(Edit/Write/Bash)을 훅으로 잡아 오프셋 편집 기록으로 바꾸고,
# 순서대로 재적용했을 때 실제 파일과 해시가 일치하는지 확인한다 (설계 §8.6, M0 ⑦).
# claude 실행은 1회. 재적용만 다시 하려면: node replay.mjs /tmp/fd-spike1/state /tmp/fd-spike1/wt /tmp/fd-spike1/base
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
bash "$HERE/../01-hooks/setup.sh" > /dev/null
ROOT=/tmp/fd-spike1
STATE=$ROOT/state
echo '{"shellSnapshot": true}' > "$STATE/config.json"

cd "$ROOT/wt"
printf 'alpha\nbeta\nalpha\n' > a.txt
printf '안녕 세계 🌏\n둘째 줄 🍣\n' > ko.txt
printf 'one\r\ntwo\r\nthree\r\n' > crlf.txt
printf 'x' > noeol.txt
printf 'foo\nkeep\n' > shell.txt
printf 'foo\r\nkeep\r\n' > shellcrlf.txt
printf 'old\n' > w.txt
seq -f 'row %g' 1 20000 > big.txt
git -c core.autocrlf=false add -A && git commit -q -m "spike4 fixtures"
# base는 git 블롭이 아니라 디스크 원본 바이트로 보관한다 (autocrlf·.gitattributes 변환 회피)
rsync -a --exclude .git --exclude .claude ./ "$ROOT/base/"

"$HERE/../lib/claude-clean" -p "Do each step, no commentary. Use Edit/Write except step 6.
1) a.txt: replace all 'alpha' with 'ALPHA' (replace_all).
2) ko.txt: '둘째' -> '두번째'.
3) ko.txt: '세계' -> 'world'.
4) crlf.txt: 'two' -> 'TWO'.
5) noeol.txt: 'x' -> 'y'.
6) Bash: sed -i '' 's/foo/bar/' shell.txt shellcrlf.txt
7) Write w.txt with 'new content'.
8) Write new.txt with 'created'.
9) big.txt: Read offset 15000 limit 1, then Edit 'row 15000' -> 'ROW-15000'." \
  --model haiku --max-turns 30 --allowedTools "Read Edit Write Bash" --output-format json > "$ROOT/run4.json"
jq '{result, num_turns, total_cost_usd}' "$ROOT/run4.json"

node "$HERE/replay.mjs" "$STATE" "$ROOT/wt" "$ROOT/base"
