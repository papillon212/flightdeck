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
| 6 | worktree `.mcp.json` 최초 승인 흐름 (CLI) | **가능**: `settings.local.json`에 서버 허용과 도구 권한을 미리 넣으면 승인 창 없이 연결 |
| 7 | VS Code 확장: Comments API(markdown), 에디터 편집 기록 재적용, 외부 변경 구별 | **가능**: 쓰레드 화면 위치는 VS Code가 따라가지만 API 값은 갱신 안 됨. 편집 재적용 해시 일치(한글 IME 포함) |
| 8 | 공식 Claude Code VS Code 확장에서 worktree 훅·MCP | **가능**: 훅 4종·MCP 동작. 신뢰는 CLI와 별개로 VS Code 작업 영역 신뢰를 따름 |
| 9 | GitHub에서 체크포인트 ref, 메타 동시 push | **가능**: 단, 삭제한 ref의 커밋을 SHA로 계속 받을 수 있음. 경합 시 반영 지연 최대 75초 |
| 10 | Meet 회의록·전사 조회 (M0 ④) | **가능**: 회의 기록 → 회의록 Docs → 본문, 전사 항목까지 조회됨. 회의록과 전사는 한 문서의 두 탭 |
| 11 | 급한 의견: PreToolUse deny로 같은 턴의 남은 도구 호출까지 차단 (M0 ③) | **가능 (우회책)**: transcript로는 같은 메시지를 판별할 수 없어 시간 간격 규칙 사용. 훅이 죽으면 차단이 뚫림 |

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

## 6. worktree `.mcp.json` 최초 승인 흐름 (§6.1, M0 ②) — **가능**

코드: `spikes/06-mcp/` (`server.mjs`: 의존성 없는 최소 MCP 서버, 도구 `flightdeck_ping`), `spikes/lib/screen.py`(대화형 화면 캡처, 프롬프트 없음)

### 방법
1번과 같은 worktree에 `.mcp.json`(서버 `flightdeck`)을 두고 두 경우를 비교한다.
- **plain**: `.mcp.json`만 둔다.
- **enabled**: `settings.local.json`에 `"enabledMcpjsonServers": ["flightdeck"]`(서버 승인)와 `"permissions": {"allow": ["mcp__flightdeck"]}`(도구 호출 권한)를 함께 넣는다.

각 경우에 `claude mcp list`, 대화형 시작 화면(8초 캡처), `claude -p "Call the flightdeck_ping tool…"`를 확인했다. `.mcp.json`도 `.git/info/exclude`로 `git status`에 보이지 않았다.

### 결과 (실제 출력)

| | plain | enabled |
|---|---|---|
| `claude mcp list` | `flightdeck: … - ⏸ Pending approval (run claude to approve)` | `flightdeck: … - ✔ Connected` |
| 대화형 시작 화면 | 승인 창이 뜸 (아래) | 창 없음. 서버 기동·`initialize`(client `claude-code`) 기록됨 |
| `claude -p` 도구 호출 | 서버는 기동·초기화됐지만 호출 실패: `"The tool flightdeck_ping is available but requires permission to use. Since this is a non-interactive session…"` | 성공: `"pong: epic CU-test, phase ANALYSIS"` |

plain의 대화형 승인 창:
```
New MCP server found in this project: flightdeck
MCP servers may execute code or access system resources. All tool calls require approval. …
  Use this MCP server
  Use this and all future MCP servers in this project
❯ Continue without using this MCP server        ← 기본 선택
```

### 발견 사항
1. **서버 승인과 도구 호출 권한은 별개다.** `-p`에서는 승인 창 없이 서버가 기동되지만, 도구 호출 권한이 없으면 호출이 거절된다. 자동 초안(§6.1)에서 Flightdeck 도구를 쓰려면 `permissions.allow`에 `mcp__flightdeck`이 있어야 한다.
2. 대화형 승인 창의 기본 선택은 신뢰 확인 창과 마찬가지로 **"사용하지 않음"**이다. 설계 §6.1의 방식(`settings.local.json`에서 서버 활성화)을 쓰면 이 창 자체가 뜨지 않는다.
3. 두 설정 모두 에이전트가 고칠 수 없어야 한다. `settings.local.json`·`.mcp.json`은 이미 §6.2 보호 경로에 있다.
4. 대화형에서 도구 호출 시 권한 창이 뜨는지는 프롬프트가 필요해 확인하지 않았다. `permissions.allow`가 대화형에도 똑같이 적용되는 것은 Claude Code 문서상 동작이다. → 8번에서 VS Code 확장으로 확인: 권한 창 없이 호출됨.

---

## 7. VS Code 확장: Comments API, 에디터 편집 기록, 외부 변경 구별 (§3.2·§3.3, §7.4, §8.6, M0 ①·⑦) — **가능**

코드: `spikes/07-vscode-ext/` (빌드 없는 JS 확장. `run.sh auto`: 별도 사용자 프로필로 VS Code를 띄워 자동 테스트 후 스스로 종료). VS Code 1.128.0.

### 방법
- 확장은 시작할 때 작업 폴더 파일을 디스크 바이트 그대로 `base/`에 보관한다.
- `onDidChangeTextDocument`의 `contentChanges`를 shadow 문서에 적용하며, 이벤트마다 결과가 `document.getText()`와 같은지 확인하고 기록한다. 한 이벤트 안의 변경은 모두 이벤트 전 문서 기준 오프셋이므로 뒤에서부터 적용한다.
- "편집 기록 검증": `base/` + 기록을 순서대로 재적용해 디스크 바이트와 sha256을 비교한다.
- 자동 테스트:
  - Comments 쓰레드 생성 → 위에 3줄 삽입 → 쓰레드 줄 삭제
  - 한글·이모지 삽입, 두 위치를 한 번에 편집, undo/redo
  - CRLF 파일에 `\n` 삽입
  - 저장 시 자동 수정(`trimTrailingWhitespace`, `insertFinalNewline`)
  - 외부 `sed -i`로 **열린** 파일과 **닫힌** 파일 변경
- 수동 테스트(사용자 직접): 거터 **+**로 댓글 작성, 맨 위 3줄 삽입, 한글 IME 입력(조합 중 백스페이스), 붙여넣기, undo, 저장, 검증 명령.

### 결과 (실제 출력)

자동 테스트 편집 기록 검증:
```
이벤트 11건, 이벤트마다 shadow=문서 불일치 0건, base_hash 순서 불일치 0건
  MATCH    a.ts         MATCH    analysis.md   MATCH    crlf.txt   MATCH    ko.txt
  MISMATCH notes.txt    replay=66663af9c7 disk=7b66fafdcd     ← 닫힌 파일 외부 변경 (예상대로)
```

주요 이벤트:
```
seq4  ko.txt   changes [{offset 15, "끝>"}, {offset 10, len 2, "두번째"}]   ← 한 번의 편집에 변경 2개 (내림차순)
seq5  ko.txt   reason "undo"   /  seq6 reason "redo"
seq7  crlf.txt changes [{offset 5, "NEW\r\n"}]                          ← API로 넣은 "\n"이 문서 EOL로 바뀌어 기록됨
seq9  a.ts     changes [{offset 19, len 3, ""}]                          ← 저장 시 trimTrailingWhitespace
seq10 a.ts     changes [{offset 19, "\n"}]                               ← 저장 시 insertFinalNewline
seq11 ko.txt   changes [{offset 16, len 7, "끝>EXTERNAL 줄\n"}]           ← 외부 sed (열린 파일): VS Code가 다시 읽으며 편집 이벤트로 옴
외부 변경(닫힌 파일 notes.txt): 변경 이벤트 0건
```

수동 테스트(한글 IME) 검증:
```
이벤트 36건, shadow=문서 불일치 0건, base_hash 순서 불일치 0건, 파일 5개 전부 MATCH
seq4  "ㅊ" → seq5 "추" → seq6 "축" → seq7 "추"(조합 중 백스페이스) → seq8 "가" …
```

외부 변경 구별 (자동 테스트 2회차, `이벤트 직후 문서 == 디스크` 기록 추가):
```
seq  file         dirty_after  equals_disk_after
1    analysis.md  false        false
2    analysis.md  true         false
3    ko.txt       false        false
…    (사람 편집 10건 모두 equals_disk_after=false)
11   ko.txt       false        true        ← 외부 변경만 true
```

Comments:
```
자동: 쓰레드 줄 3 → 위에 3줄 삽입 후 thread.range.start.line = 3 (기대 6)
수동: 화면의 댓글 상자는 "액세스 토큰은…" 줄을 따라 내려감 (사용자 확인)
```

### 발견 사항
1. **에디터 편집은 빠짐없이 잡히고, 재적용하면 디스크와 바이트 단위로 같다.** 다중 위치 편집, undo/redo, CRLF, 저장 시 자동 수정, 한글 IME 조합이 모두 포함된다. M0 ⑦의 에디터 경로는 **가능**이다.
2. **한글 IME는 조합 단계마다 이벤트가 온다**(한 글자에 2~4건). 편집 기록·중계량이 글자 수의 몇 배가 된다. 전송 전에 짧은 간격(예: 같은 위치의 연속 변경)으로 묶는 압축이 필요하다.
3. **외부 도구가 열린 파일을 바꾸면 에디터 편집 이벤트로 들어온다.** 그대로 두면 `human:<member>`로 잘못 기록된다. `isDirty`로는 구별할 수 없다(파일을 연 뒤 첫 편집도 `false`). **"이벤트 직후 문서 == 디스크"**이면 외부 변경(디스크 재로드)으로 보면 정확히 갈렸다. 에이전트 편집(훅 기록과 내용이 같음)인지, 그 외 `external:unknown`인지는 그다음에 가린다.
4. **열리지 않은 파일의 외부 변경은 에디터 이벤트가 없다.** §7.4의 파일 감시가 꼭 필요하다(설계 그대로).
5. **Comments 쓰레드는 화면에서는 VS Code가 줄을 따라 옮기지만, 확장의 `thread.range` 값은 갱신되지 않는다.** 따라서 쓰레드 앵커를 저장할 때 `thread.range`를 믿으면 안 되고, 편집 기록으로 계산한 위치(§3.5)를 써야 한다. 다시 표시할 때도 그 위치로 쓰레드를 만든다.
6. markdown 문서의 텍스트 에디터에서 Comments API(거터 +, 댓글 입력, 답글 명령)가 동작한다. markdown **미리보기 화면**에서는 Comments API가 동작하지 않는다(VS Code 제약, 이번엔 확인하지 않음).

---

## 8. 공식 Claude Code VS Code 확장에서 worktree 훅·MCP (§6.1, D19) — **가능**

코드: `spikes/08-vscode-claude/setup.sh`. 아직 신뢰한 적 없는 새 레포 `/tmp/fd-spike8`에 worktree를 만들고, 훅·`.mcp.json`(미리 허용)·7번 확장을 사용자의 평소 VS Code에 띄웠다. 사용자가 Claude Code 패널에서 haiku로 프롬프트 1개를 보냈다.

### 결과 (실제 출력)

Claude 답변 (사용자 전달):
```
flightdeck_ping 결과: pong: epic CU-test, phase ANALYSIS
확인 코드: KIWI-77 (세션 시작 훅이 알려준 값)
git status: 실행하지 못했어요. Flightdeck PreToolUse 훅이 막았습니다: Flightdeck: git 등 금지된 명령입니다 (git status). …
[fd-ok]
```

훅 로그:
```
15:31:32  SessionStart  startup
15:31:56  UserPromptSubmit                                permission_mode=auto
15:32:00  PreToolUse    ToolSearch
15:32:03  PreToolUse    mcp__flightdeck__flightdeck_ping
15:32:03  PreToolUse    Bash  git status                  ← deny
15:32:09  Stop
transcript: entrypoint "claude-vscode", version 2.1.286
MCP 서버: started → initialize(client "claude-code") → call flightdeck_ping
```

| 확인 사항 | 결과 |
|---|---|
| SessionStart·UserPromptSubmit 컨텍스트 | 됨 (`KIWI-77`, `[fd-ok]`) |
| PreToolUse 차단 | 됨. 사용자 설정의 권한 모드가 `auto`인데도 deny가 적용됨 |
| `.mcp.json` + `enabledMcpjsonServers` + `permissions.allow` | 승인 창·권한 창 없이 도구 호출됨 |
| Claude Code 자체 신뢰 창 | **안 뜸.** `~/.claude.json`에도 신뢰 기록이 생기지 않음 |
| VS Code 작업 영역 신뢰 | Extension Development Host 창: 아무 표시 없음. 일반 창: 모달 창이 아니라 **상단 배너(제한 모드, Manage 버튼)**로 표시. 사용자가 Manage로 신뢰한 뒤 Claude Code에서도 훅이 동작함 |

### 발견 사항
1. **VS Code 확장은 CLI와 신뢰 체계가 다르다.** VS Code 안의 Claude Code는 자체 신뢰 창을 띄우지 않고 CLI 신뢰 기록도 쓰지 않는다. VS Code 작업 영역 신뢰를 따르는 것으로 보인다. 그래서 같은 worktree라도 터미널에서 `claude`를 처음 열면 CLI 신뢰 창이 따로 뜬다(3번).
2. **VS Code 작업 영역 신뢰는 폴더 단위다.** 에픽 worktree는 `../<repo>.flightdeck/<epic-id>`처럼 에픽마다 다른 폴더이므로, 에픽마다 제한 모드 배너가 뜰 수 있다. 상위 폴더 `../<repo>.flightdeck/`을 한 번 신뢰하면 하위 폴더도 신뢰된다(VS Code 동작). Flightdeck 확장 자체도 제한 모드에서는 동작이 제한되므로, 첫 에픽 때 상위 폴더 신뢰를 안내하는 게 맞다.
3. 신뢰하기 **전**(제한 모드)에 Claude Code가 worktree 훅을 적용하는지는 확인하지 못했다(사용자가 먼저 신뢰함). Flightdeck 확장이 제한 모드에서 동작하지 않도록 두면(`untrustedWorkspaces: false`) 실무상 문제가 되지 않는다.
4. MCP 도구는 처음에 `ToolSearch`를 거쳐 불러왔다(지연 로딩되는 도구). 도구 이름·설명을 에이전트가 찾기 쉽게 지어야 한다.

---

## 9. GitHub에서 체크포인트 ref, 메타 동시 push (§2.1, §3.1, §8.1, M0 ⑤·⑥) — **가능 (주의점 있음)**

코드: `spikes/09-github/checkpoint.sh`, `spikes/05-git-refs/meta-concurrency.sh`(원격·ref를 받도록 일반화). 원격은 `git@github.papillon212:papillon212/flightdeck.git`. 검증은 `refs/flightdeck-spike/*` 이름공간에서만 했고, 끝난 뒤 모두 삭제했다(`ls-remote`에 `main`만 남음).

### 9-1. 체크포인트 ref (실제 출력)
```
== A → GitHub push (커스텀 ref)
   * [new reference]   refs/flightdeck-spike/ckpt/CU-1/dh.lee -> refs/flightdeck-spike/ckpt/CU-1/dh.lee
  push 4308ms
== B: 기본 클론에는 안 보임 → refspec fetch
  기본 클론 후 refs/flightdeck-spike: [0개]
  --mirror 아닌 'fetch --all' 후: [0개]
  refspec fetch 3588ms
  A 작업 트리 == B 체크아웃(ckpt1): 일치 (CRLF·바이너리 포함)
== 체인 갱신
     5f4c8f6..e9f602c  refs/flightdeck-spike/ckpt/CU-1/dh.lee -> …          ← fast-forward 갱신
     ! [rejected]  a1a5249… -> refs/flightdeck-spike/ckpt/CU-1/dh.lee (fetch first)   ← 오래된 값 기준 push 거절
== 삭제
   - [deleted]         refs/flightdeck-spike/ckpt/CU-1/dh.lee
  ls-remote 후: [0개]
  삭제된 커밋을 SHA로 직접 fetch:
     * branch            e9f602c31389d0ee138c41a21afa203e953b11a7 -> FETCH_HEAD   ← 여전히 받아짐
```

### 9-2. 메타 동시 push (클라이언트 5개 × 이벤트 5개, `refs/flightdeck-spike/meta`)
```
== 클라이언트 5개 × 이벤트 5개 (동시 실행), 94.3s, 실패 클라이언트 0
원격 이벤트 파일: 25 / 기대 25 (중복 제거 25)
원격 커밋: 26 (머지 커밋 0 → 선형 이력 예)
push 시도 합계 55 (이벤트당 평균 2.20, 최대 13), rebase 30, rebase 충돌 0, lock 실패 10, non-ff 30
이벤트당 반영 시간(ms): 평균 10184, 최대 75098
== push 오류 종류
  20 ! [rejected]        HEAD -> refs/flightdeck-spike/meta (fetch first)
  10 ! [remote rejected] HEAD -> refs/flightdeck-spike/meta (cannot lock ref 'refs/flightdeck-spike/meta': is at … but expected …)
```

### 발견 사항
1. **GitHub도 커스텀 ref(`refs/flightdeck-*/…`)의 push·fetch·fast-forward 갱신·삭제를 허용한다.** 기본 clone·`fetch --all`에는 포함되지 않아 일반 사용자 화면(브랜치 목록 등)에 드러나지 않는다. 브랜치가 아니므로 브랜치 보호 규칙·Actions 트리거 대상도 아니다(설계상 바람직).
2. **ref를 지워도 커밋 내용은 GitHub에 남는다.** 삭제 직후에도 SHA를 알면 누구나(레포 읽기 권한자) fetch할 수 있었다. GitHub가 도달 불가 객체를 언제 정리하는지는 GitHub가 정한다. §2.1의 "ref를 지우면 원격에서 공간이 회수된다"는 GitHub에서는 즉시 성립하지 않는다. 특히 **체크포인트·세션 원본에 비밀값이 한 번 들어가면 ref 삭제로는 지워지지 않는다**(GitHub 지원 요청 필요). 저장 전 비밀값 제거(§6.4)와 체크포인트 대상 제외 규칙이 더 중요해진다.
3. **GitHub 왕복은 push·fetch 각 약 4초다**(SSH 연결 포함). 경합이 없으면 메타 이벤트 반영은 수 초지만, 5명이 쉬지 않고 동시에 push하면 평균 10초, 최대 75초까지 밀렸다. 알림 주기(20초, §3.7)에는 문제없지만, "승인 직후 다른 사람 화면에 바로 반영"을 기대하면 안 된다. 실시간이 필요한 것은 서버 ④로 보낸다(설계 그대로). 대기 중 이벤트 묶음 push(§3.1 v0.9)가 지연을 줄인다.
4. 거절 형태는 로컬과 같은 두 가지(`fetch first`, `cannot lock ref`)였다. 재시도 정책(§3.1 v0.9)이 그대로 적용된다.

---

## 10. Meet 회의록·전사 조회 (§10.1 ⑤, M0 ④) — **가능**

방법: 이미 설치된 Google Workspace CLI(`gws` 0.22.5)로 사용자 계정의 **지난 회의**를 읽기 전용으로 조회했다. 범위는 `meetings.space.readonly`를 추가했다. 회의 내용은 출력하지 않고 개수·상태·구조만 봤다. Flightdeck 자체 OAuth 앱이 아니라 gws의 OAuth 앱을 썼으므로, 확인한 것은 **API 경로와 데이터 형태**다.

### 결과 (실제 출력)

회의 기록 10건별 회의록·전사:
```
aEB_NPgAh5  smartNotes=[{"state":"FILE_GENERATED","doc":true,"keys":["document","exportUri"]}]  transcripts=[{"state":"FILE_GENERATED","doc":true}]
wpamtpkV41  smartNotes=[]  transcripts=[]
… (10건 중 5건에 회의록·전사 있음, 모두 FILE_GENERATED)
```

가장 최근 회의(25분, 참가자 3명):
```
== 회의록 Docs 본문 (구조만, documents.get 기본)
{"title_len":60,"paragraphs":41,"headings":{"HEADING_2":1,"HEADING_3":4},"text_chars":2758,"has_hangul":true,"links":2}
== 전사 항목 (transcripts.entries.list, pageSize 100)
{"entries":100,"more_pages":true,"fields":["endTime","languageCode","name","participant","startTime","text"],
 "languages":["ko-KR"],"speakers":3,"first":"2026-10-01T05:56:56.482Z","last":"2026-10-01T06:14:51.641Z"}
== 참가자
{"participants":3,"kinds":{"signedinUser":3}}
== 회의록 문서와 전사 문서가 같은 문서인가: 같음
== documents.get(includeTabsContent=true)
[{"tab_title_len":3,"chars":2758,"children":0},{"tab_title_len":4,"chars":6914,"children":0}]
```

### 발견 사항
1. **설계 §10.1 ⑤의 경로가 그대로 동작한다.** `conferenceRecords.list → smartNotes.list → docsDestination.document → Docs API`. 한국어 회의록(제목 구조 있음)이 읽힌다.
2. **회의록과 전사가 한 Docs 문서의 두 탭이다.** `documents.get` 기본 호출은 첫 탭(회의록)만 돌려준다. 전사 탭까지 읽으려면 `includeTabsContent: true`가 필요하다. 다만 전사는 탭 텍스트보다 `transcripts.entries`가 낫다. 항목마다 `participant`, `startTime`, `endTime`, `languageCode`가 붙어 있어서, §10.2 앵커링 1순위(전사 문장 시각 ↔ 포커스 위치)에 바로 쓸 수 있다.
3. **전사 항목은 페이지로 나뉜다.** 18분 구간에서 100건 이상이 나왔다(`nextPageToken` 있음). 1시간 회의면 수백 건이므로 페이지 처리가 필요하다.
4. 회의록이 없는 회의도 많다(10건 중 5건). 회의록이 켜지지 않은 회의는 §10.1의 ⑤에서 "회의록 없음"으로 처리하고, 포커스 이벤트만으로 에픽 단위 기록을 남기는 경로가 필요하다. 회의록 자동 켜기(①)는 이번에 확인하지 않았다.
5. **범위에 관한 주의**: 이번에는 `meetings.space.readonly`(내가 참여한 모든 회의)를 썼다. 설계의 `meetings.space.created`는 **그 앱이 만든 회의 공간만** 볼 수 있다. Flightdeck이 `spaces.create`로 만든 회의만 다루므로 설계 의도에는 맞는다. 하지만 사용자가 일반 Meet 링크로 연 회의는 가져올 수 없다. 이 제약은 B 방식(실제 회의)으로 확인해야 한다.
6. gws 재로그인 후에도 이전 액세스 토큰 캐시 때문에 403이 계속됐다. 캐시를 치우자 해결됐다. Flightdeck이 범위를 추가할 때도 토큰을 새로 받아야 한다.

---

## 11. 급한 의견: PreToolUse deny로 같은 턴의 남은 도구 호출까지 차단 (§8.4, M0 ③) — **가능 (우회책)**

코드: `spikes/10-urgent-opinion/run.sh`, `spikes/01-hooks/hook.mjs`의 `urgentReason()`

### 방법
- 관찰자가 `urgent/` 대기열에 의견을 넣으면, 훅은 다음 PreToolUse에서 그 도구 호출을 `deny`하고 의견을 거부 사유로 돌려준다.
- 같은 assistant 메시지에서 이미 요청된 나머지 도구 호출도 거부하고, 다음 모델 턴의 호출부터 해제한다.
- "같은 메시지"인지는 두 규칙으로 판정한다.
  - **메시지 ID 규칙**: `transcript_path`에서 현재 `tool_use_id`가 든 assistant 메시지의 `message.id`를 찾아 비교한다.
  - **시간 간격 규칙**: transcript에서 찾지 못하면, 직전 거부로부터 1초 안에 온 호출을 같은 메시지로 본다.
- 두 조건으로 실행했다.
  - **sleep**: 한 메시지에 `Bash(sleep 6)` + Write a·b·c를 요청하고, sleep 중에 의견을 투입한다.
  - **tight**: 한 메시지에 Write a·b·c만 요청하고, 의견은 실행 전에 미리 넣는다.
- 의견 내용: "파일을 만들지 말고 멈추세요. 대신 STOP.txt에 'stopped' 한 줄만 쓰세요."

### 결과 (실제 출력)

sleep 조건 (1회차, 메시지 ID 규칙만 있던 버전):
```
== files   a.txt: (없음)  b.txt: (없음)  c.txt: (없음)  STOP.txt: stopped
== urgent-log
{"action":"deliver","tool":"Write","id":"vFPJfm","msgId":"LJmGqard"}
{"action":"deny_same_message","tool":"Write","id":"mHcCU2","msgId":"LJmGqard"}
{"action":"deny_same_message","tool":"Write","id":"9MPqiB","msgId":"LJmGqard"}
{"action":"clear","tool":"Write","id":"QeXgj6","msgId":"null","prev":"LJmGqard"}   ← 새 턴 호출은 transcript에서 못 찾음
```

tight 조건 (시간 간격 규칙 추가 후):
```
== files   a.txt: (없음)  b.txt: (없음)  c.txt: (없음)  STOP.txt: stopped
== urgent-log
{"action":"deliver","tool":"Write","id":"rWA8T6","msgId":"null"}
{"action":"deny_same_message","rule":"time_gap","gapMs":272,"tool":"Write","id":"VqrwRm","msgId":"null"}
{"action":"deny_same_message","rule":"time_gap","gapMs":280,"tool":"Write","id":"UuwnEm","msgId":"null"}
{"action":"clear","rule":"time_gap","gapMs":4534,"tool":"Write","id":"R9r72N","msgId":"null"}
== assistant 메시지별 도구 호출
{"msg":"khPLVZZk","tools":["Write:a.txt"]}  {"msg":"khPLVZZk","tools":["Write:b.txt"]}  {"msg":"khPLVZZk","tools":["Write:c.txt"]}
{"msg":"cutNLnGo","tools":["Write:STOP.txt"]}
== 거부 사유로 모델에 전달된 내용
PreToolUse:Write hook error: [관찰자 @park 긴급 의견 · 조종수 전달] 파일을 만들지 말고 멈추세요. …
PreToolUse:Write hook error: Flightdeck: 앞선 긴급 의견 때문에 이번 메시지의 나머지 도구 호출은 실행하지 않았습니다.
```

### 발견 사항
1. **급한 의견은 같은 턴 안에서 효과를 낸다.** 이미 요청된 호출(b·c)까지 막았고, 모델은 다음 턴에 의견대로 다시 계획했다(STOP.txt만 작성). 일반 의견(2번, PostToolUse 주입)이 "다음 턴부터"인 것과 다르다.
2. **transcript로는 "같은 메시지"를 판별할 수 없다.**
   - Claude Code는 assistant 메시지가 다 오기 전에 도구 실행을 시작한다. sleep 조건에서 `Bash` PreToolUse(25.895)가 a·b·c의 tool_use 블록 기록(26.3~27.2)보다 먼저 일어났다.
   - transcript 파일은 늦게 기록된다. STOP.txt의 tool_use 줄은 타임스탬프가 37.395인데, 37.445의 PreToolUse 시점에는 아직 파일에 없었다. tight 조건에서는 조회가 한 번도 성공하지 않았다(모두 `null`).
   - sleep 조건에서 b·c를 찾은 것은 sleep 6초 동안 기록이 끝났기 때문이다.
3. **시간 간격 규칙이 실제로 판정했다.** 같은 메시지 안의 호출 간격은 272·280ms, 새 턴 첫 호출까지는 4534ms(모델 응답 대기)였다. 1초 기준으로 깔끔하게 갈렸다. 판정이 틀리는 쪽은 "모델이 1초 안에 다음 턴을 낸 경우"다. 그때는 새 턴 첫 호출이 한 번 더 거부되고(안전한 쪽), 모델이 사유를 보고 다시 시도한다.
4. **훅이 죽으면 긴급 차단이 그대로 뚫린다.** 첫 tight 실행에서 훅 버그(`ReferenceError`, exit 1)로 a만 거부되고 b·c는 실행됐다. 4번 발견(훅 오류는 실행을 막지 않음)과 같은 성질이다. 긴급 차단처럼 "막는 쪽이 안전한" 경로는 훅 내부 예외를 잡아 **deny로 응답(fail-closed)**해야 한다.

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

## 설계 변경 제안 2차 (6~10번 결과, design.md v0.10에 반영)

| # | 절 | 현재 서술 | 제안 | 근거 |
|---|---|---|---|---|
| Q1 | §6.1 설정 배치 | `settings.local.json`: 훅 등록, Flightdeck MCP 서버 활성화, 권장 기본 모델 | 구체화: `"enabledMcpjsonServers": ["flightdeck"]`(서버 승인)와 `"permissions": {"allow": ["mcp__flightdeck"]}`(도구 호출 권한)를 **둘 다** 넣는다. 서버 승인과 도구 권한은 별개다. 도구 권한이 없으면 자동 초안(`-p`)에서 Flightdeck 도구 호출이 거절된다 | 6번 |
| Q2 | §6.1 신뢰 확인 창, §9.1 | 신뢰는 원본 레포 경로 기준. 첫 에픽 때 Claude Code에서 레포 신뢰를 안내 | **진입점마다 신뢰 체계가 다르다**로 고친다. (a) 터미널 `claude`: Claude Code 자체 신뢰 창, 원본 레포 경로 기준 (b) VS Code 안의 Claude Code: 자체 창 없음, VS Code 작업 영역 신뢰(폴더 단위, 상단 제한 모드 배너)를 따름. 안내는 둘로 나눈다. VS Code는 **worktree 상위 폴더 `../<repo>.flightdeck/`을 한 번 신뢰**하도록 안내한다. Flightdeck 확장은 `capabilities.untrustedWorkspaces: false`로 둔다 | 3·8번 |
| Q3 | §7.4 외부 변경 감지, §8.6 "조종수의 에디터 편집" | 파일 감시에서 세 경로에 해당하지 않으면 `external:unknown`. 에디터 편집은 `onDidChangeTextDocument` | 추가: **열린 파일을 외부 도구가 바꾸면 `onDidChangeTextDocument`로 들어온다.** "이벤트 직후 문서 == 디스크"이면 사람 편집이 아니라 디스크 재로드로 분류한다. 이어서 훅 기록과 내용이 같으면 에이전트 편집(이미 기록됨, 중복 제외), 아니면 `external:unknown`으로 기록한다. `isDirty`는 판별에 쓸 수 없다 | 7번 |
| Q4 | §8.6 전송, §8.3 편집 스트림 | 생기는 즉시 전송 | 추가: 한글 IME는 조합 단계마다 이벤트가 온다(한 글자에 2~4건). 같은 위치의 연속 변경을 짧은 간격(예: 300ms)으로 묶어 전송·저장한다. 묶은 결과도 재적용 해시가 같아야 한다 | 7번 수동 테스트 |
| Q5 | §3.3 코드 쓰레드, §3.5 위치 고정 | 앵커는 편집 기록 위치 | 추가: VS Code는 쓰레드를 **화면에서는** 줄을 따라 옮기지만 확장의 `thread.range` 값은 갱신하지 않는다. 앵커를 저장·전송할 때 `thread.range`를 읽지 말고 편집 기록으로 계산한 위치를 쓴다. 다시 열 때는 그 위치로 쓰레드를 만든다 | 7번 |
| Q6 | §6.1 MCP 도구 표 | 도구 목록 | 추가: Claude Code는 MCP 도구를 지연 로딩해 처음에 `ToolSearch`로 찾는다. 도구 이름·설명에 에이전트가 검색할 단어(쓰레드, 인수인계, 단계 등)를 넣는다 | 8번 |
| Q7 | §14 M0 | 진행 현황 | ①, ②의 `.mcp.json`·VS Code 확장, ⑦의 에디터 부분, GitHub에서의 ⑤·⑥을 **가능**으로 옮긴다 | 6~9번 |
| Q8 | §2.1 ref 구성 | ref를 지우면 원격 저장소에서 실제로 공간이 회수된다(gc) | GitHub에서는 ref를 지워도 커밋이 SHA로 계속 받아진다. 회수 시점은 GitHub가 정한다고 고친다. 체크포인트·세션 원본에 들어간 비밀값은 ref 삭제로 지워지지 않으므로, **체크포인트 대상에서 `.env` 등 비밀 파일 패턴을 제외**하는 규칙을 §8.1에 추가한다(세션 원본은 §6.4의 비밀값 제거가 이미 있음) | 9번 |
| Q10 | §10.1 ⑤·⑥, §10.3 | 회의록 조회: `conferenceRecords.list → smartNotes.list → docsDestination → Docs API`, 전사 사용 시 `transcripts.entries` | 추가: (a) 회의록과 전사는 한 Docs 문서의 두 탭이다. 회의록은 첫 탭, 전사 탭은 `includeTabsContent: true`로만 받아진다 (b) 앵커링 입력의 전사는 탭 텍스트가 아니라 `transcripts.entries`(화자·시각·언어 포함, 페이지 처리)를 쓴다 (c) 회의록이 생성되지 않은 회의의 처리 경로를 둔다 (d) `meetings.space.created` 범위는 Flightdeck이 만든 회의만 보이므로, "회의 시작" 버튼으로 연 회의만 대상이라고 명시한다 | 10번 |
| Q9 | §3.7 알림, §3.1 | 20초 `ls-remote` 폴링 | GitHub 왕복이 push·fetch 각 약 4초이고 경합 시 메타 반영이 수십 초까지 밀린다는 점을 적는다. 메타 브랜치는 "수 초~수십 초 안에 반영"되는 경로이고, 실시간 경로는 서버 ④임을 명시한다 | 9번 |

## 설계 변경 제안 3차 (11번 결과, design.md 미반영, 검토 후 반영)

| # | 절 | 현재 서술 (v0.10) | 제안 | 근거 |
|---|---|---|---|---|
| R1 | §8.4 급한 의견 | PreToolUse에서 대기열을 확인해 거부 + 의견을 사유로 돌려주는 경로를 둔다. 이 경로는 M0에서 확인한다 | "M0 확인"으로 바꾸고 방식을 적는다: (a) 급한 의견은 다음 PreToolUse를 deny하고 의견을 사유로 돌려준다 (b) 같은 메시지에서 이미 요청된 나머지 호출도 deny한다 (c) 같은 메시지 판정은 **직전 거부로부터의 시간 간격(1초)**으로 한다. transcript는 PreToolUse 시점에 아직 기록되지 않아 쓸 수 없다. 틀리면 새 턴 첫 호출이 한 번 더 거부된다(안전한 쪽) (d) 조종수가 "급한 의견으로 전달"을 고를 때만 쓴다(실행 중인 계획을 끊으므로) | 11번 |
| R2 | §6.1 강제의 위치(훅 오류) | 훅 오류는 실행을 막지 않는다. 훅은 오류를 확장에 보고한다 | 추가: 경로마다 실패 시 기본값을 정한다. **차단 경로(단계별 권한 §6.2, 보호 경로, 급한 의견)는 훅 내부 예외를 잡아 deny로 응답한다(fail-closed).** 기록 경로(편집 기록, trace)는 실행을 막지 않는다(fail-open + 외부 변경 감지로 보완) | 11번 4, 4번 2 |
| R3 | §6.1 훅 입출력 표 | — | 추가: "Claude Code는 assistant 메시지가 다 오기 전에 도구 실행을 시작한다. 한 메시지의 도구 호출 전체를 PreToolUse 시점에 알 수 없다" | 11번 2 |

### 이번에 확인하지 못한 것 (M0 남은 항목)
- ~~`.mcp.json` 최초 승인 흐름~~ → 6번 가능
- ~~VS Code 공식 Claude Code 확장에서의 신뢰 확인 창·훅 동작~~ → 8번 가능
- ~~에디터 편집(`onDidChangeTextDocument`) 경로~~ → 7번 가능
- VS Code 제한 모드(신뢰 전)에서 Claude Code가 worktree 훅을 적용하는지
- ~~실제 git 호스트(GitHub)에서의 커스텀 ref push 허용 여부, 동시 push 거동~~ → 9번 가능. GitHub의 도달 불가 객체 정리 시점은 알 수 없음
- ~~PreToolUse deny로 급한 의견을 같은 턴 안에 전달하는 우회책 (P8)~~ → 11번 가능(시간 간격 규칙)
- 대형 레포에서 Bash마다 `write-tree`를 하는 비용 (P3)
- ~~Meet 회의록·전사 조회 (M0 ④)~~ → 10번 가능(지난 회의 읽기)
- Meet: Flightdeck 자체 OAuth 앱 + `meetings.space.created` 범위로 만든 회의에서의 조회, 회의록 자동 켜기, 회의 종료 후 회의록 생성까지 걸리는 시간 (B 방식, 실제 회의 필요)
