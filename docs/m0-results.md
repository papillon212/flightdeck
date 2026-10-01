# M0 기술 검증 결과 (로컬 항목 1~5)

- 대상 설계: [design.md](design.md) v0.8, §14 M0
- 환경: macOS (Darwin 27.0), Claude Code **2.1.285**, git 2.54.0, node 24.18
- 검증 코드: `spikes/<번호>-<이름>/`, 실험 레포: `/tmp/fd-spike*`
- claude 실행은 `--model haiku`와 한 줄짜리 프롬프트로 사용량을 줄였다.

| # | 항목 | 판정 |
|---|---|---|
| 1 | worktree `settings.local.json` 훅: PreToolUse 차단, PostToolUse 편집 전후, SessionStart·UserPromptSubmit 컨텍스트 | **가능** |
| 2 | PostToolUse 추가 컨텍스트로 실행 중 의견 전달 | **가능** (반영 시점은 "다음 모델 턴") |
| 3 | `claude -p` 세션 resume, `transcript_path` 실시간 읽기 | **가능** (단, 대화형 첫 실행 시 신뢰 확인 창, transcript에 개인 맥락 포함) |
| 4 | 훅으로 잡은 편집을 재적용했을 때 해시 일치 | **가능 (우회책 필요)**: 훅 페이로드만으로는 CRLF 파일에서 불일치. 훅에서 디스크 전후 스냅샷을 뜨면 전부 일치 |
| 5 | 숨은 커밋 체크포인트 push/fetch, 메타 브랜치 동시 push 재시도 | **가능** (로컬 bare 레포 기준) |

---

## 1. Claude Code 훅 (worktree `.claude/settings.local.json`) — **가능**

코드: `spikes/01-hooks/` (`setup.sh`: 레포·worktree·설정 생성, `hook.mjs`: 공용 훅)

### 방법
- `/tmp/fd-spike1/repo`에서 `git worktree add`로 `flightdeck/CU-test` 브랜치 worktree 생성
- worktree에 `.claude/settings.local.json`으로 SessionStart·UserPromptSubmit·PreToolUse·PostToolUse·Stop 훅 등록, `.git/info/exclude`에 추가
- 훅 응답: SessionStart = "확인 코드는 PINEAPPLE-42", UserPromptSubmit = "답변 끝에 [fd-ok]", PreToolUse = 경로에 `blocked` 포함 시 / `git`으로 시작하는 Bash 시 `permissionDecision: "deny"`
- `claude -p "…1) notes.txt Edit 2) blocked.txt Write 3) git status 4) 확인 코드 출력" --model haiku --allowedTools "Read Edit Write Bash"`

### 결과 (실제 출력)

```
result: "Edit completed. Blocked by Flightdeck hooks:
         - Write to blocked.txt: blocked at this stage
         - git status: git commands forbidden at this stage
         Confirming 확인 코드: **PINEAPPLE-42**
         [fd-ok]"
num_turns 5, total_cost_usd 0.049
```

훅 호출 순서 (`hook-log.jsonl`):
```
SessionStart        startup
UserPromptSubmit
PreToolUse   Read   /private/tmp/fd-spike1/wt/notes.txt
PostToolUse  Read   /private/tmp/fd-spike1/wt/notes.txt
PreToolUse   Edit   /private/tmp/fd-spike1/wt/notes.txt
PostToolUse  Edit   /private/tmp/fd-spike1/wt/notes.txt
PreToolUse   Write  /private/tmp/fd-spike1/wt/blocked.txt   ← deny, PostToolUse 없음
PreToolUse   Bash   git status                              ← deny
Stop
```

| 확인 사항 | 결과 |
|---|---|
| worktree의 `settings.local.json` 훅 로드 | 됨. `git status`에도 설정 파일이 보이지 않음(exclude 동작) |
| PreToolUse 차단 | 됨. `--allowedTools`로 허용한 도구도 deny가 우선. 모델에는 `PreToolUse:Write hook error: <사유>`가 `is_error: true` tool_result로 전달되고, 모델이 사유를 이해해 보고함 |
| SessionStart 추가 컨텍스트 | 됨. transcript에 `attachment.type = "hook_additional_context"`, `hookName: "SessionStart"`로 기록 |
| UserPromptSubmit 추가 컨텍스트 | 됨. 같은 형식, `hookName: "UserPromptSubmit"` |
| PostToolUse 편집 전후 | 됨. **Edit의 `tool_response`에 `originalFile`(변경 전 전체 내용)과 `structuredPatch`가 들어 있음.** 훅에서 PreToolUse 스냅샷을 따로 뜨지 않아도 변경 전 내용을 얻을 수 있다 |

PostToolUse(Edit)의 `tool_response` 실제 값:
```json
{
  "filePath": "/private/tmp/fd-spike1/wt/notes.txt",
  "oldString": "line2", "newString": "LINE-TWO",
  "originalFile": "line1\nline2\nline3\n",
  "structuredPatch": [{"oldStart":1,"oldLines":3,"newStart":1,"newLines":3,
                       "lines":[" line1","-line2","+LINE-TWO"," line3"]}],
  "userModified": false, "replaceAll": false
}
```

훅 입력 공통 필드: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `prompt_id`, `hook_event_name`. 도구 훅은 `tool_name`, `tool_input`, `tool_use_id`, (Post만) `tool_response`, `duration_ms`. Stop은 `last_assistant_message`, `stop_hook_active`.

### 주의점 (설계 반영 필요)
1. **경로가 실제 경로(realpath)로 들어온다.** `/tmp/fd-spike1/wt`에서 실행했는데 `cwd`, `file_path`는 `/private/tmp/...`. 훅의 경로 판정(§6.2 보호 경로, 쓰기 허용 목록)은 양쪽을 `realpath`로 정규화한 뒤 비교해야 한다.
2. **transcript 경로는 worktree 경로 기준.** `~/.claude/projects/-private-tmp-fd-spike1-wt/<session_id>.jsonl`. 에픽 worktree마다 별도 프로젝트 폴더가 생긴다(§8.3 대화 스트림은 훅이 주는 `transcript_path`만 쓰면 무관).
3. **`-p` 모드는 검증에 실패한 설정 파일을 조용히 무시한다** (`claude --help`: "Settings files that fail validation are silently ignored in this mode"). 확장은 `settings.local.json`을 쓸 때 스키마를 검증하고, SessionStart 훅이 오지 않으면 "훅 미동작"으로 처리해야 한다.
4. `prompt_id`가 모든 훅 입력에 있다. 편집 기록의 `source.message`(§8.6)에 쓸 수 있는 후보다.
5. 전역 `~/.claude/settings.json` 훅과의 병합은 2번에서, 대화형 모드 동작은 3번에서 확인한다.

---

## 2. 실행 중 의견 전달 (PostToolUse 추가 컨텍스트, §8.4) — **가능**

코드: `spikes/02-midrun-opinion/run.sh` (1번의 `hook.mjs` 재사용. 훅은 `opinions/*.txt` 대기열을 PostToolUse·UserPromptSubmit에서 꺼내 주입)

### 방법
- 프롬프트: `Run bash 'sleep 8', then Write a.txt='A', then b.txt='B', then c.txt='C'. Follow any [관찰자] notes.`
- 백그라운드 "관찰자" 프로세스가 `Bash(sleep 8)`의 PreToolUse를 보면, 즉 에이전트가 **실행 중일 때** 의견 파일을 대기열에 넣는다:
  `[관찰자 @park 의견 · 조종수 전달] 파일 이름을 c.txt 대신 park.txt 로 하고, 내용 끝에 '-reviewed' 를 붙여 주세요.`

### 결과 (실제 출력)

```
result: "Done. Created a.txt, b.txt, and park.txt (per observer note—content: A, B, C-reviewed)."
opinion queued at 21:19:16          ← sleep 실행 중에 대기열에 들어감
a.txt: A
b.txt: B
park.txt: C-reviewed                ← c.txt 대신 park.txt, '-reviewed' 반영
```

훅 타임라인(UTC):
```
13:19:16.158  PreToolUse   Bash   sleep 8        ← 이 직후 의견 대기열 투입
13:19:25.065  PostToolUse  Bash   sleep 8        ← 의견 주입 (opinions-log: event=PostToolUse)
13:19:29.054  PreToolUse   Write  a.txt          ← 다음 모델 턴
13:19:29.326  PreToolUse   Write  b.txt
13:19:29.604  PreToolUse   Write  park.txt
```

transcript에는 `attachment.type = "hook_additional_context"`, `hookName: "PostToolUse:Bash"`로 의견 원문이 남는다. 즉 "에이전트에 전달된 의견은 세션 원본의 일부가 된다"(§8.4 기록)가 별도 작업 없이 성립한다.

### 반영 시점에 관한 사실
- 주입된 의견은 **다음 모델 턴**부터 보인다. 이번 실행에서 모델은 Write 3개를 **한 assistant 메시지(`msg_011Cfbaqs3…`)에 묶어** 보냈다. 만약 의견이 a.txt의 PostToolUse에서 주입됐다면 b.txt·c.txt는 의견 없이 이미 정해진 대로 실행됐을 것이다.
- 따라서 지연 = "현재 도구 실행 시간 + 같은 턴에 이미 계획된 나머지 도구 호출". 실행을 되돌리지는 못하고, 다음 판단부터 영향을 준다.
- 급한 의견(예: "그 파일 건드리지 마")은 PreToolUse에서 의견 대기열을 확인해 해당 도구를 `deny` + 사유로 의견을 돌려주는 방식으로 같은 턴 안의 나머지 호출도 막을 수 있다(1번에서 deny 사유가 모델에 전달됨을 확인). 우회책 후보로 기록만 하고 이번엔 검증하지 않았다.

### 전역 훅 병합
- `--debug-file` 로그에 전역 `~/.claude/settings.json`의 훅(`SessionEnd:other [/Users/doohwanlee/.config/iterm2/cc-status] completed with status 0`)과 worktree 훅(`Hook PostToolUse (FD_STATE=… hook.mjs) provided additionalContext (82 chars)`)이 **같은 세션에서 모두 실행**됐다. 사용자 전역 훅을 건드리지 않고 worktree 설정만으로 공존한다(§6.1 "사용자 전역 설정은 건드리지 않는다" 성립).

### 기타 확인
- Write의 PostToolUse `tool_response`: 새 파일이면 `{"type":"create","originalFile":null,"structuredPatch":[]}`. 덮어쓰기(`type: "update"`)는 4번에서 확인한다.
- 1·2번은 이 검증을 돌린 Claude Code 세션의 환경변수(`CLAUDECODE`, `CLAUDE_CODE_*`)를 물려받은 상태로 실행했다. 3번부터는 이를 지운 `spikes/lib/claude-clean`으로 실행했다(아래 3번 참고). 훅 동작은 두 조건에서 같았다.

---

## 3. headless 세션 resume + `transcript_path` 실시간 읽기 (§6.1, §8.3) — **가능**

코드: `spikes/03-resume-transcript/` (`run.sh`, `drive.py`: pty로 대화형 claude 조작, `tail.mjs`: 관찰자 tailer), `spikes/lib/claude-clean`

### 방법
1. `claude -p "Remember the word MANGO. Reply only: OK"` → `session_id` 획득
2. tailer 시작: 훅 로그에서 `transcript_path`를 찾아 100ms 간격으로 새 줄을 읽고, 줄의 `timestamp`와 읽은 시각의 차이를 기록
3. pty로 `claude --resume <session_id> --model haiku`를 **대화형(TUI)**으로 띄워
   `What word did I ask you to remember? Then run bash: git log -1. Answer in one line.` 입력 후 `/exit`

### 결과 (실제 출력)

훅 로그 — headless와 대화형이 **같은 session_id, 같은 transcript 파일**:
```
13:32:56.094  SessionStart  startup  1798efa7  1798efa7-….jsonl   ← claude -p
13:32:58.183  UserPromptSubmit       1798efa7
13:33:01.449  Stop                   1798efa7
13:33:03.099  SessionStart  resume   1798efa7  1798efa7-….jsonl   ← 대화형 --resume
13:33:08.401  UserPromptSubmit       1798efa7
13:33:10.679  PreToolUse  Bash "git log -1"  permission_mode: "default"   ← deny
13:33:13.696  Stop                   1798efa7
```

대화형 resume 턴의 transcript:
```
user:        "What word did I ask you to remember? Then run bash: git log -1. Answer in one line."
tool_result: "PreToolUse:Bash hook error: Flightdeck: git 등 금지된 명령입니다 (git log -1)."
assistant:   "MANGO is the word you asked me to remember; git log was blocked by the Flightdeck hook.\n\n[fd-ok]"
```
→ headless 맥락 유지, 대화형 TUI에서도 worktree 훅(UserPromptSubmit 주입, PreToolUse 차단)이 동작한다.

tailer가 본 resume 이후 줄 (seen = 읽은 시각, ts = 줄 안의 timestamp, lag = ms):
```
seen          ts            lag   type        내용
13:33:08.563  13:33:08.359  204   user        prompt:What word did I ask you to remember?…
13:33:08.563  13:33:08.405  158   attachment  hook_additional_context
13:33:10.817  13:33:10.217  600   assistant   thinking
13:33:10.817  13:33:10.612  205   assistant   tool_use:Bash
13:33:10.817  13:33:10.685  132   user        tool_result
13:33:13.580  13:33:10.688  2892  attachment  total_tokens_reminder
13:33:13.784  13:33:13.635  149   assistant   text:MANGO is the word you asked me to rememb…
13:33:13.784  13:33:13.699   85   system      stop_hook_summary
```
- 53줄 전부 JSON 파싱 성공(파싱 실패 0).
- 메시지 본문(user/assistant/tool_result) 지연은 **85~600ms**. 1초 목표(§8.3) 안에 들어온다. 부가 attachment 한 줄은 2.9초 늦게 기록됐다(내용 표시와 무관).
- assistant 메시지는 **토큰 단위 스트리밍이 아니라 블록(thinking / tool_use / text) 단위로 완성된 뒤** 기록된다. 관찰자는 "타이핑 중"은 볼 수 없고, 블록이 끝날 때마다 본다. 긴 답변은 끝날 때까지 안 보일 수 있다.

### 발견 사항 (설계 반영 필요)
1. **대화형 첫 실행 시 신뢰 확인 창이 뜬다.** `Quick safety check: Is this a project you created or one you trust?` 기본 선택이 **"No, exit"**다. 신뢰하기 전에는 프로젝트 설정(훅)이 적용되지 않는다. `-p` 모드는 이 확인을 건너뛴다(`claude --help`).
   - 신뢰는 `~/.claude.json`의 `projects["/private/tmp/fd-spike1/repo"].hasTrustDialogAccepted = true`로 저장됐다. **worktree가 아니라 원본 레포(main worktree) 경로 기준**이다. 그래서 같은 레포에서 새로 만든 worktree(`setup.sh`가 매번 다시 만듦)에서는 다시 묻지 않았다.
   - 즉 사용자가 제품 레포를 한 번 신뢰하면 이후 에픽 worktree는 모두 신뢰 상태로 열린다. 처음 한 번은 사용자가 직접 수락해야 한다(확장이 `~/.claude.json`을 고치는 것은 "사용자 전역 설정을 건드리지 않는다" 원칙에 어긋남).
   - VS Code 공식 Claude Code 확장에서의 신뢰 흐름은 이 로컬 검증 범위 밖이다(터미널 TUI만 확인).
2. **Claude Code 세션 안에서 띄운 claude는 transcript를 저장하지 않는다.** 상속된 `CLAUDE_CODE_CHILD_SESSION=1` 때문에 화면에 `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 to keep future transcripts`가 표시됐다. 확장이 Claude Code를 띄울 때(자동 초안의 `claude -p`, 터미널 열기) 부모 프로세스에 이런 변수가 있으면 지워야 한다. 예: 사용자가 Claude Code 터미널 안에서 VS Code를 연 경우.
3. **transcript에 사용자 개인 맥락이 들어 있다.** transcript에는 대화뿐 아니라 세션 시작 때 Claude에게 넘긴 배경 정보도 기록된다. 3번 세션 파일(260KB)에서 확인한 내용:

   | 기록 종류 | 들어 있던 내용 |
   |---|---|
   | `instructions` | 전역 `~/.claude/CLAUDE.md` 전문(823자), 그 레포의 자동 메모리 `MEMORY.md` |
   | `session_context` | 로그인 계정 이메일 |
   | `credential_org` | Claude 조직 UUID |
   | `skill_listing`, `mcp_instructions_delta`, `deferred_tools_delta` | 개인으로 설치한 플러그인·MCP 목록 |
   | `prompt_snapshot` | 시스템 프롬프트 전체(134KB) |

   - 크기는 대부분 `prompt_snapshot`과 도구·스킬·MCP 목록(약 90KB)이다. 개인 정보 자체는 그중 일부다.
   - 이번 자동 메모리는 실험 레포의 것으로, 테스트 프롬프트("Remember the word MANGO")를 받은 Claude가 스스로 만든 한 줄(`mango.md`)이었다. 사용자의 실제 메모리가 노출된 것은 아니다. 실제 사용에서는 이 자리에 사용자가 제품 레포에서 쌓은 개인 메모리가 들어간다.
   - 내 PC에만 있으면 문제가 없다. 그러나 관찰자 중계(§8.3)와 세션 원본 저장(§6.4)에 그대로 쓰면 이 내용이 관찰자와 레포에 공유된다. 현재 설계의 "비밀값 제거"(환경변수 값, 토큰 패턴, `.env`)로는 걸러지지 않는다.
4. **Claude Code가 검증 도중 자동 업데이트됐다.** 2.1.285로 시작했는데, 대화형 세션의 transcript `version` 필드는 `2.1.286`이었다. 버전 확인(§15 "Claude Code 내부 형식 의존")은 확장 시작 시 한 번이 아니라 **세션마다** 해야 한다. transcript의 각 줄에 `version`이 있어 이걸로 판단할 수 있다.

---

## 4. 훅으로 잡은 편집의 재적용 → 파일 해시 일치 (§8.6, M0 ⑦) — **가능 (우회책 필요)**

코드: `spikes/04-edit-replay/` (`run.sh`, `replay.mjs`). 1번의 `hook.mjs`에 Bash 전후 작업 트리 스냅샷(`shellSnapshot`) 추가.

### 방법
- 일부러 까다로운 파일을 준비해 커밋하고, 디스크 원본 바이트를 `base/`에 복사한다.
  `a.txt`(replace_all), `ko.txt`(한글·이모지, 같은 파일 2회 편집), `crlf.txt`(CRLF), `noeol.txt`(끝 개행 없음), `big.txt`(2만 줄, 190KB), `w.txt`(Write 덮어쓰기), `new.txt`(Write 생성), `shell.txt`·`shellcrlf.txt`(Bash `sed -i`)
- `claude -p`로 9단계 편집을 시킨다(haiku, 17턴, $0.069).
- 훅 기록을 §8.6 형식 `{file, seq, base_hash, range, insert, source}`로 바꾼다. 오프셋은 UTF-16 code unit(VS Code와 같은 기준)이다. 이걸 `base/`에서 순서대로 적용해 디스크와 sha256을 비교한다. 편집을 만드는 방식은 두 가지다.
  - **payload 방식**: 훅 페이로드(`tool_response.originalFile`, `oldString`/`newString`, `replaceAll`, Write의 `content`)만 사용
  - **disk 방식**: 훅이 PreToolUse·PostToolUse 시점에 직접 읽은 파일 내용(전후 스냅샷)의 차이 사용
- 셸 편집: PreToolUse(Bash)와 PostToolUse(Bash)에서 임시 index로 `git add -A && git write-tree`를 해 작업 트리 tree를 만들고, 두 tree의 `diff-tree`로 바뀐 파일을 찾는다. 브랜치·index·작업 트리는 건드리지 않는다.

### 결과 (실제 출력)

disk 방식 — **전체 일치**:
```
#1  a.txt       base=e95e9bf120 [0,16] ← "ALPHA\nbeta\nALPHA"  (agent)
#2  ko.txt      base=db68d67b6f [9,10] ← "두번"  (agent)
#3  ko.txt      base=b0002fb32c [3,5] ← "world"  (agent)
#4  crlf.txt    base=9fc4c6bdc7 [5,8] ← "TWO"  (agent)
#5  noeol.txt   base=2d711642b7 [0,1] ← "y"  (agent)
#6  shell.txt   base=15c04bf210 [0,3] ← "bar"  (agent_shell: sed -i '' 's/foo/bar/' shell.txt …/shellcrlf.txt)
#7  shellcrlf.txt base=9669b4fde5 [0,3] ← "bar"  (agent_shell: …)
#8  new.txt     base=∅ [0,0] ← "created"  (agent)
#9  w.txt       base=01d09d19c2 [0,4] ← "new content"  (agent)
#10 big.txt     base=c6302c069a [138884,138888] ← "ROW-"  (agent)
도구 호출 단위: 순서(base_hash) 10/10 OK, 적용 결과=그 시점 디스크 10/10 OK
최종 파일 해시: 10/10 MATCH
결과(disk): 전체 일치 (파일 10개, 편집 10건)
```

payload 방식 — **CRLF 파일만 불일치**:
```
  seq 5-5    crlf.txt    순서 MISMATCH   결과 MISMATCH
  MISMATCH crlf.txt    replay=3830e97f63 disk=dca60fe3c6
  (나머지 9개 파일 MATCH)
```

### 원인: `originalFile`은 줄바꿈이 LF로 정규화돼 있다
```
디스크 crlf.txt:            o n e \r \n T W O \r \n t h r e e \r \n
tool_response.originalFile: "one\ntwo\nthree\n"
```
Claude Code의 Edit은 디스크에는 CRLF를 그대로 두지만, 훅에 주는 `originalFile`은 LF로 바꿔서 준다. 그래서 페이로드만으로 계산한 오프셋은 CRLF 파일에서 줄마다 1씩 어긋난다. 190KB 파일의 `originalFile`은 잘리지 않고 전체가 왔다(big.txt payload 방식도 일치).

### 함께 발견한 사항
1. **git을 거친 비교는 줄바꿈 차이를 가린다.** 첫 시도에서는 최종 비교를 git tree(블롭)로 했다. 이 PC의 전역 `core.autocrlf=input` 때문에 CRLF가 LF로 정규화돼 불일치가 "일치"로 보였다. 셸 스냅샷·체크포인트처럼 "디스크를 그대로 담아야 하는" git 호출에는 `-c core.autocrlf=false`와 `GIT_ATTR_SOURCE=<빈 트리 4b825dc…>`를 줘야 한다. 이렇게 하면 레포의 `.gitattributes`도 무시된다. 아래로 확인:
   ```
   with attrs:   422c2b7a… / raw(--no-filters): c30dea8a…
   ATTR_SOURCE:  c30dea8a…   ← 원본 바이트 그대로
   ```
2. **훅이 죽어도 에이전트는 조용히 계속한다.** 수정 전 훅에 버그(`ReferenceError`, exit 1)가 있었는데, `claude -p` 결과는 `"Done."`이었고 셸 편집 기록만 빠졌다. 종료 코드 2가 아닌 훅 오류는 실행을 막지 않는다. 기록 누락은 §7.4 외부 변경 감지(파일 감시)가 `external:unknown`으로 잡는 구조가 안전망이 된다. 훅 쪽에도 자체 오류 기록과 확장으로의 상태 보고가 필요하다.
3. **disk 방식의 공통 앞뒤 비교는 편집 범위가 거칠다.** replace_all(`a.txt`)이 `[0,16]` 한 덩어리로 기록돼 가운데 바뀌지 않은 `beta`까지 포함됐다. 위치 고정(§3.5)에서 이 범위 안의 앵커는 위치를 잃는다. 실제 구현은 disk 스냅샷으로 정확한 바이트를 얻고, 범위는 줄 단위 → 글자 단위 diff로 잘게 나누는 것이 좋다. 또는 페이로드의 `oldString` 위치를 디스크 내용에서 다시 찾는 방법도 있다.
4. **disk 방식의 출처 오염 가능성.** PreToolUse~PostToolUse 사이에 조종수가 에디터에서 같은 파일을 고치면 그 변경도 에이전트 편집으로 잡힌다. Edit/Write는 수 ms라 사실상 무시할 수 있지만, 긴 Bash(빌드·코드 생성) 동안은 가능하다. 확장은 같은 구간의 `onDidChangeTextDocument` 편집을 빼고 기록해야 한다(이번 로컬 검증에서는 미확인).
5. **범위 밖**: 에디터 편집(`onDidChangeTextDocument`)은 VS Code가 필요해 이번 로컬 검증에 넣지 않았다. M0 ⑦ 중 "에디터" 경로는 아직 미판정이다. 대형 레포에서 Bash마다 `git add -A`를 하는 비용도 측정하지 않았다.

---

## 5. 숨은 커밋 체크포인트 + 메타 브랜치 동시 push (§8.1, §2.1, §3.1) — **가능**

코드: `spikes/05-git-refs/` (`checkpoint.sh`, `meta-concurrency.sh`, `meta-client.sh`). 원격은 로컬 bare 레포. claude 사용 없음.

### 5-1. 체크포인트

방법: 클라이언트 A가 에픽 worktree에서 파일을 고치고(unstaged 수정, untracked 새 파일, stage된 파일, 2MB 바이너리), 체크포인트를 2개 만든다. 절차는 사용자 index를 임시 index로 복사(stat 캐시 재사용) → `add -A` → `write-tree` → `commit-tree -p <이전 ckpt 또는 HEAD>` → `update-ref <ref> <new> <old>`(CAS)다.

```
== 체크포인트 후 상태 (브랜치·index·작업 트리 불변 확인)
HEAD   불변  (b89c56eb…)
index  불변  (cd30939434fb)
 M app.txt
A  staged.txt                      ← 사용자가 stage 해 둔 상태 그대로
체크포인트 체인:
  f3ac8c9 checkpoint step 2 | Flightdeck-Step: 2, Flightdeck-Seq: 140
  7d1ad70 checkpoint step 1 | Flightdeck-Step: 1, Flightdeck-Seq: 100
  b89c56e base

== push (A → 원격)
   * [new reference]   refs/flightdeck/ckpt/CU-1/dh.lee -> refs/flightdeck/ckpt/CU-1/dh.lee

== 클라이언트 B(관찰자): 기본 클론으로는 체크포인트가 안 받아짐
  기본 클론 후 refs/flightdeck: [0개]
  refspec 지정 fetch 후:
    refs/flightdeck/ckpt/CU-1/dh.lee f3ac8c9
  ckpt1 → ckpt2 diff:
     app.txt  |   1 +
     blob.bin | Bin 2000000 -> 0 bytes
     new.txt  |   1 -

== B가 ckpt2를 읽기 전용 창(@live)으로 열기: 파일이 A 작업 트리와 같은가
  A 작업 트리 == B@live (ckpt2): 일치

== A에서 '이 시점으로 복원' (ckpt1). 복원 직전 상태도 체크포인트로 남긴다
  복원 후 작업 트리 == ckpt1: 일치
  HEAD 불변, index 불변

== CAS: 오래된 값으로 update-ref 하면 거절
  fatal: update_ref failed for ref 'refs/flightdeck/ckpt/CU-1/dh.lee': cannot lock ref …: is at 5e6aba7c… but expected 45406a83…

== ref 삭제 + gc 후 원격 공간 회수 (§2.1)
  ckpt 있을 때: 1956 KiB
  ckpt ref 삭제 + gc 후: 1 KiB
```

확인된 사실과 구현 메모:
- 체크포인트 생성·push·fetch·복원 모두 **브랜치·사용자 index·HEAD를 건드리지 않는다**. untracked 파일과 삭제된 파일도 정확히 담기고 복원된다.
- `refs/flightdeck/*`는 **기본 clone/fetch로 받아지지 않는다.** 확장이 refspec(`+refs/flightdeck/ckpt/<epic>/*:…`)을 관리해야 한다(§2.1 "fetch 설정은 확장이 관리" 그대로).
- **복원**: 임시 index에 현재 트리를 `read-tree` → `update-index --refresh`로 stat 정보 채우기 → `read-tree -m -u <현재> <대상>`. refresh 없이 하면 `error: Entry 'app.txt' not uptodate. Cannot merge.`로 실패한다. 이 방식은 대상에 없는 파일 삭제까지 처리하고 사용자 index는 건드리지 않는다.
- **커스텀 ref에는 reflog가 남지 않는다**(`core.logAllRefUpdates`는 heads·remotes·notes만). 체크포인트 이력은 커밋 체인(parent)으로만 따라간다. 덮어쓰기 실수에 대비한 복구 수단이 없으므로 CAS(`update-ref <new> <old>`)를 반드시 쓴다.
- **gc 공간 회수(§2.1)**: 로컬 bare 레포에서는 ref 삭제 + `gc --prune=now`로 즉시 회수됐다. GitHub·GitLab 등 호스트의 gc 시점은 호스트가 정하므로 회수가 늦을 수 있다(이번 범위 밖).
- 4번과 같은 줄바꿈 문제: 체크포인트도 `git add`를 거치므로 `core.autocrlf`·`.gitattributes` 변환을 받는다. "복원 = 그 시점 디스크와 바이트 단위로 같음"을 원하면 체크포인트에도 4번의 변환 끄기 옵션이 필요하다. 다만 LFS 같은 filter도 꺼지므로 큰 파일이 그대로 들어간다. 어느 쪽을 택할지 결정이 필요하다(아래 제안).

### 5-2. 메타 브랜치 동시 push

방법: 클라이언트 N개가 각자 클론한 뒤 **동시에** 이벤트 파일 `epics/CU-1/events/<시각순 ID>-<member>.json`을 하나씩 추가·커밋·push한다. 거절되면 `fetch → rebase → push`를 지수 백오프(+지터, 최대 0.8초)로 최대 30회까지 재시도한다. 사람 속도보다 훨씬 가혹하게, 쉬지 않고 연속 push한다.

```
== 클라이언트 5개 × 이벤트 20개 (동시 실행), 12.9s, 실패 클라이언트 0
원격 이벤트 파일: 100 / 기대 100 (중복 제거 100)
원격 커밋: 101 (머지 커밋 0 → 선형 이력 예)
누락 클라이언트: 0
push 시도 합계 159 (이벤트당 평균 1.59, 최대 21), rebase 59, rebase 충돌 0, lock 실패 4
포기(GAVE_UP): 0

== 클라이언트 10개 × 이벤트 10개 (동시 실행), 14.6s, 실패 클라이언트 0
원격 이벤트 파일: 100 / 기대 100 (중복 제거 100)
원격 커밋: 101 (머지 커밋 0 → 선형 이력 예)
누락 클라이언트: 0
push 시도 합계 250 (이벤트당 평균 2.50, 최대 28), rebase 150, rebase 충돌 0, lock 실패 12
포기(GAVE_UP): 0
```

- **유실 0, 중복 0, rebase 충돌 0, 선형 이력.** 파일 1개 = 이벤트 1개 + 고유 파일 이름이라 rebase가 항상 깨끗하다(§3.1 설계 그대로 성립).
- 거절 형태는 두 가지다. non-fast-forward 외에, 동시에 들어온 push가 ref 잠금을 잡지 못하는 **`cannot lock ref` 오류**(4회/12회)도 있었다. 재시도 로직은 오류 종류를 가리지 않고 같은 경로로 처리하면 된다.
- **꼬리 지연**: 평균은 1.6~2.5회지만 한 이벤트가 최대 **28회**까지 밀렸다(상한 30에 근접). 경합이 심하면 특정 클라이언트가 계속 지는 기아 상태가 생긴다. 실제 사용(사람 속도, 에픽당 수 명)에서는 드물겠지만 다음이 필요하다.
  - 재시도 상한에 걸려도 이벤트를 버리지 않는다. 로컬 커밋으로 남겨 두고 다음 주기에 다시 push한다(append-only라 안전).
  - 대기 중인 이벤트는 한 번의 push로 묶어 보낸다. 이번 클라이언트는 이벤트마다 push해서 경합이 과장됐다.
- 범위 밖: 원격 호스트의 네트워크 지연·push 속도 제한·보호 규칙은 이번 로컬 bare 레포 검증으로는 알 수 없다(git 호스트 미정, §15).

---

## 설계 변경 제안 (design.md v0.9에 반영, P4(c)는 권장안인 "디스크 바이트 그대로"로 결정)

판정이 "불가"인 항목은 없다. 다만 아래는 설계 문서의 서술과 실제 동작이 다르거나, 설계에 없던 처리가 필요한 부분이다.

| # | 절 | 현재 서술 | 제안 | 근거 |
|---|---|---|---|---|
| P1 | §8.6 편집 기록 (표 "에이전트 파일 편집") | `tool.after` 훅 → `extractEdits()` (Claude Code는 Edit/Write 변경 전후) | 에이전트 편집은 **훅이 PreToolUse·PostToolUse 시점에 직접 읽은 디스크 내용**으로 만든다. 도구 페이로드(`originalFile` 등)는 범위를 잘게 나누는 힌트로만 쓴다. 오프셋 단위는 **UTF-16 code unit**, `base_hash`는 **디스크 원본 바이트의 sha256**으로 명시한다 | 4번: `originalFile`은 CRLF를 LF로 바꿔서 주므로, 페이로드만 쓰면 CRLF 파일이 불일치 |
| P2 | §6.5 `AgentAdapter.extractEdits` | `extractEdits(e: ToolEvent): Edit[]` | `extractEdits(e: ToolEvent, before: FileSnapshot, after: FileSnapshot): Edit[]`. 스냅샷은 공통 훅(`packages/hook`)이 뜨고, 어댑터는 범위 분할만 한다. Codex의 `apply_patch`도 같은 구조로 처리할 수 있다 | P1과 같음 |
| P3 | §8.6 "에이전트 셸 결과" | 명령 전후 파일 감시 → diff | 구체 방법: Bash PreToolUse·PostToolUse에서 임시 index로 `add -A` + `write-tree`, 두 tree의 `diff-tree`. git 호출에는 `-c core.autocrlf=false`, `GIT_ATTR_SOURCE=<빈 트리>`를 준다. 같은 구간의 조종수 에디터 편집은 빼고 기록한다 | 4번: 셸 편집 2건(CRLF 포함) 해시 일치. 변환을 끄지 않으면 CRLF가 사라진다 |
| P4 | §8.1 체크포인트 | 임시 index + write-tree + commit-tree + update-ref | (a) `update-ref`는 항상 CAS(이전 값 지정). 커스텀 ref에는 reflog가 없다 (b) 복원 절차를 명시: 임시 index `read-tree` → `update-index --refresh` → `read-tree -m -u` (c) **줄바꿈·filter 정책 결정 필요**: 체크포인트를 디스크 바이트 그대로(변환 끔, LFS 파일도 원본으로 들어감) 둘지, 레포 규칙대로 변환할지. 권장은 변환 끔이다. 편집 기록의 `base_hash`와 체크포인트가 같은 바이트를 가리켜야 §3.5·§7.3이 맞물린다 | 5번 |
| P5 | §3.1 이벤트 (push 재시도) | push가 거절되면 `fetch → rebase → push` 자동 재시도 | 추가: 거절 사유(non-fast-forward, `cannot lock ref`)와 무관하게 재시도한다. 지수 백오프와 지터를 둔다. 상한에 걸려도 이벤트를 버리지 않고 로컬 커밋으로 남겨 다음 주기에 보낸다. 대기 중인 이벤트는 묶어서 한 번에 push한다 | 5번: 유실 0, 충돌 0이지만 최대 28회 재시도 |
| P6 | §8.3 대화 스트림, §6.4 세션 원본 | transcript를 따라 읽어 대화 전체 중계, 원본은 비밀값 제거 후 저장 | **기록 종류 허용 목록 필터**를 추가한다. 중계·저장은 user 프롬프트, assistant text/tool_use, tool_result, `hook_additional_context`만 한다. 나머지(`prompt_snapshot`, `instructions`, `session_context`, `credential_org`, 스킬·MCP·도구 목록, `environment` 등)는 모두 버린다. 지울 항목을 고르는 차단 목록이 아니라 보낼 종류만 정하는 허용 목록이므로, Claude Code 업데이트로 새 기록 종류가 생겨도 기본적으로 걸러진다. 크기도 260KB 중 약 90%가 버리는 부분이다 | 3번: transcript에 계정 이메일, 전역 CLAUDE.md, 레포 자동 메모리, 개인 플러그인·MCP 목록이 들어 있음 |
| P7 | §8.3 대화 스트림 | 관찰자 화면에 약 1초 안에 반영 | "**블록 단위**로 1초 안"이라고 명시한다. 토큰 스트리밍은 transcript로 볼 수 없다. 긴 답변·긴 thinking은 끝날 때까지 안 보인다 | 3번: 메시지 지연 85~600ms, assistant는 블록이 완성된 뒤 기록 |
| P8 | §8.4 의견 "에이전트에 전달" | 실행 중이면 다음 PostToolUse 훅의 추가 컨텍스트로 들어간다 | "다음 PostToolUse에서 주입되고, **다음 모델 턴부터** 반영된다. 같은 턴에 이미 요청된 도구 호출은 그대로 실행된다"를 추가한다. 급한 의견(중지·금지)은 PreToolUse에서 대기열을 확인해 deny + 사유로 돌려주는 경로를 검토한다(미검증) | 2번 |
| P9 | §6.1 설정 배치 / §9.1 진입 흐름 | worktree에 `settings.local.json`을 두면 훅이 적용된다 | 추가할 내용 네 가지. (a) **대화형 첫 실행 시 신뢰 확인 창**(기본값 "No, exit")을 사용자가 한 번 수락해야 훅이 적용된다. 신뢰는 원본 레포 경로 기준이라 이후 worktree는 다시 묻지 않는다. 확장은 `~/.claude.json`을 고치지 않고 첫 에픽 시작 때 안내한다 (b) 확장이 claude를 띄울 때 `CLAUDECODE`·`CLAUDE_CODE_*` 환경변수를 지운다(상속되면 transcript가 저장되지 않음) (c) `-p` 모드는 검증에 실패한 설정을 조용히 무시하므로, 설정 스키마를 검증하고 SessionStart 훅이 오지 않으면 "훅 미동작"으로 표시한다 (d) 훅 입력 경로는 realpath(`/private/tmp/…`)이므로 경로 판정 전에 정규화한다 | 1·3번 |
| P10 | §6.1 강제의 위치 | 훅은 편의·즉시 피드백, 강제는 관문 | 추가: **훅 오류(종료 코드 ≠ 2)는 에이전트 실행을 막지 않고 조용히 지나간다.** 훅은 자체 오류를 확장에 보고하고, 확장은 "훅 오류 n건"을 표시한다. 누락된 편집은 §7.4 외부 변경 감지가 `external:unknown`으로 잡는다 | 4번: 훅 버그로 셸 편집이 빠졌는데 결과는 `"Done."` |
| P11 | §6.1 마지막 문단 | 정확한 훅 입출력(추가 컨텍스트 필드, 실행 중 전달 가능 여부), resume 동작은 M0에서 확정 | 확정된 내용으로 바꾼다. `hookSpecificOutput.additionalContext`(SessionStart·UserPromptSubmit·PostToolUse), `permissionDecision: "deny"` + `permissionDecisionReason`, 실행 중 전달 가능(P8), `--resume`은 같은 session_id·같은 transcript를 이어 쓰고 SessionStart `source: "resume"`. 편집 기록의 `source.message`에는 모든 훅 입력에 있는 `prompt_id` + `tool_use_id`를 쓴다. `.mcp.json` 최초 승인 흐름은 아직 미확인 | 1~3번 |
| P12 | §15 해결됨 "Claude Code 내부 형식 의존" | 확장이 설치된 Claude Code 버전을 확인 | 버전 확인을 **세션마다** 한다(transcript 각 줄의 `version`). 검증 도중 2.1.285 → 2.1.286 자동 업데이트를 실제로 겪었다 | 3번 |

### 이번에 확인하지 못한 것 (M0 남은 항목)
- `.mcp.json` 최초 승인 흐름 (M0 ②의 일부)
- VS Code 공식 Claude Code 확장에서의 신뢰 확인 창·훅 동작 (이번엔 터미널 TUI만 확인)
- 에디터 편집(`onDidChangeTextDocument`) 경로 (M0 ⑦의 일부)
- 실제 git 호스트에서의 커스텀 ref push 허용 여부, gc 시점, 동시 push 거동
- PreToolUse deny로 급한 의견을 같은 턴 안에 전달하는 우회책 (P8)
- 대형 레포에서 Bash마다 `write-tree`를 하는 비용 (P3)
