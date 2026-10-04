# M4 구현·기록 — 구현 계획

- 기준: [design.md](design.md) v0.13 §14 M4, §6.1(MCP 도구), §6.4(실행 기록 3계층), §7(구현 기록과 diff 대조), §8.1(체크포인트), §8.6(편집 기록)
- 완료 기준: **설명 없는 hunk 차단 확인**
  - 설계를 통과한 에픽(IMPLEMENTATION)에서 에이전트가 Step 단위로 구현하고 Step마다 구현 기록(impl-log)을 남긴다.
  - 사람의 직접 수정, Flightdeck 밖의 변경(셸·다른 도구), Step에 속하지 않는 에이전트 편집이 있으면 **구현 완료(제출)가 막힌다.** 메모를 달거나 Step을 기록하면 통과한다.
  - 통과하면 확장이 테스트 명령을 실행해 보고하고(서버 서명 `gate.reported`), 서버가 `phase.completed`에 서명해 VERIFICATION으로 넘어간다.
  - 리뷰어가 자기 에이전트로 세션 원본을 검색해 "왜 이렇게 했나"의 답을 찾는다(`flightdeck_search_run`).

## 범위

| 포함 | 제외 (이후 마일스톤) |
|---|---|
| IMPLEMENTATION 단계 룰·맥락, 구현 에이전트(대화형 Claude Code, 시나리오는 headless) | 코드 쓰레드, 리뷰 사본, 수정 제안 패치 (M5) |
| `flightdeck_log_step`: impl-log Step 작성 + 체크포인트, `changes` 자동 생성 | 반영 서버의 coverage 재계산 (M5, 서버 편집 기록은 M7) |
| trace.jsonl (PostToolUse) | 편집 기록 서버 전송·줄 hover 출처 (M7) |
| 체크포인트: Step마다·턴 종료·에이전트 편집 후 유휴·사람 저장, push, 복원·비교 | 조종 넘기기·관찰 (M8) |
| coverage: 편집 기록으로 hunk별 출처·Step 조회, 설명 없는 변경 차단 | |
| 직접 수정·외부 변경 메모 | |
| 세션 원본: 허용 목록 필터 + 비밀값 가림 + 압축 → `refs/flightdeck/runs/<epic>`, `flightdeck_search_run` | |
| 테스트 결과 보고 `gate.reported`(서버 서명), `phase.completed(IMPLEMENTATION)` (X5) | |

## 단계

| 단계 | 패키지 | 내용 | 완료 확인 |
|---|---|---|---|
| M4-1 | `schema`, `core` | impl-log 파서·렌더러·형식 검사(Step 번호, yaml `design_ref`·`ckpt`·`changes`·`verification`, 의도·결정·검토한 대안·리뷰 포인트, `design_ref`가 design.md에 있는 문단 ID인지). 출처 추적 재적용(문자 단위 출처 + 삭제 표시) → hunk별 출처 → coverage 판정. 세션 원본 검색(BM25, 한글 2-gram), 비밀값 가림. reducer: `gate.reported`, `phase.completed(IMPLEMENTATION)` → VERIFICATION | 단위 테스트 |
| M4-2 | `git`, `agent`, `hook`, `mcp` | 편집 출처에 Step(X2), trace.jsonl, PostToolUseFailure(X9), 턴 종료·세션 종료 시 세션 원본 저장, ckpt·runs ref 백그라운드 push(X7). MCP `flightdeck_log_step`·`flightdeck_submit`·`flightdeck_search_run`. impl-log 직접 쓰기 차단(X1·X10). IMPLEMENTATION 맥락(룰, 설계 요약, 도구) | 훅·MCP 테스트 |
| M4-3 | `server` | `POST /events`에 `gate.reported`(담당자, 원격 에픽 브랜치의 커밋)와 `phase.completed(IMPLEMENTATION)`(그 커밋의 모든 명령 통과 보고 + impl-log 형식) | 서버 통합 테스트 |
| M4-4 | `vscode` | 구현 완료(제출): 저장 → 외부 변경 기록 → coverage·impl-log 검사 → 커밋·공유 → 명령 실행·보고 → 단계 완료. "설명 필요" 목록·메모, 체크포인트(사람 저장 10초, 에이전트 편집 후 30초 유휴), 복원·비교, 상태 표시줄 `IMPLEMENTATION · Step n · 설명 필요 k` | workflow 수준 시나리오 테스트 |
| M4-5 | — | 실제 VS Code 시나리오 자동 진행: 담당자가 실제 claude(haiku 1회)로 2 Step 구현 → 사람 직접 수정·외부 변경 → 제출 차단 → 메모 → 통과·VERIFICATION. 리뷰어(park) 창의 에이전트가 원본 검색 | 완료 기준 |

## 미리 보이는 설계 문제 (구현 전 제안)

구현은 아래 제안대로 진행한다. design.md는 확인을 받은 뒤 고친다.

| # | 절 | 현재 서술 | 문제 | 제안 |
|---|---|---|---|---|
| X1 | §7.1, §6.1 `flightdeck_log_step` | impl-log의 `ckpt`·`changes`는 자동 기입, 에이전트는 의도·결정·대안·리뷰 포인트만 쓴다. 쓰기 권한은 `impl-log.md` 허용 | 에이전트가 파일을 직접 고치면 자동 기입 필드를 지우거나 틀리게 쓸 수 있다. Step의 `ckpt`가 impl-log를 포함한 체크포인트면 순환이 생긴다 | impl-log는 **`flightdeck_log_step`으로만** 쓴다. 에이전트는 `{title, design_ref, intent, decision, alternatives, review_points, verification}`를 넘기고 Flightdeck이 Step을 렌더링한다(출처 `flightdeck/impl_log`). 순서: 체크포인트(그 Step까지의 코드) → Step 작성(`ckpt` = 그 체크포인트). 고칠 때는 `step: n`을 주어 같은 Step을 다시 쓴다. 에이전트의 impl-log 직접 쓰기는 훅이 거부한다 |
| X2 | §7.3, §8.6 `source.step` | 에이전트 편집에 `step`이 기록된다 | 편집이 일어날 때는 그 Step이 아직 기록되지 않았다(Step은 끝날 때 기록) | 편집 시점의 Step = **마지막으로 기록된 Step + 1**(에픽 단위 번호, 로컬 상태). `log_step`이 그 번호를 닫는다. 마지막 `log_step` 뒤의 에이전트 편집은 기록되지 않은 Step에 속하므로 "Step에 속하지 않는 에이전트 편집"이 된다 |
| X3 | §7.3, §7.4 "코드 파일 전체는 M7" | 줄 단위 출처 조회, 외부 변경은 파일 감시로 감지 | M4 coverage에는 코드 파일의 외부 변경 감지가 필요한데, 계속 감시하는 것은 M7 범위다. 서버에는 편집 기록이 없어(M7) 서버가 coverage를 다시 계산할 수 없다 | M4는 **로컬 편집 기록**으로 계산한다. 대상 = 최종 diff(`base → 작업 트리`)에서 `.flightdeck/`와 `coverage_ignore`를 뺀 파일. 파일마다 base 내용에서 편집 기록을 재적용하며 문자마다 출처를 붙이고(삭제는 그 자리에 표시), 재적용 결과 ≠ 디스크면 그 차이를 `external:unknown`으로 먼저 기록한다(체크포인트·제출 때). hunk의 출처가 모두 설명되면 통과. 서버의 coverage 재계산은 M7 이후 반영 서버에서 한다. M4 서버는 impl-log 형식과 테스트 보고만 본다 |
| X4 | §7.4 메모 | 메모는 수정 묶음 단위로 편집 기록에 붙는다(`edit_group.memo`) | 편집 기록은 덧붙이기만 하는 파일이라 기록에 붙일 자리가 없다. 리뷰어(다른 PC)도 메모를 봐야 한다 | 수정 묶음 = 같은 파일·같은 출처(human/external)의 연속 편집(2분 이내). 메모는 로컬 `memos/<epic>.jsonl`에 `{file, seqs:[처음, 끝], memo}`로 저장하고(M7에서 서버로), **impl-log.md 끝의 `## 직접 수정 메모` 섹션**에도 Flightdeck이 그린다(파일·줄 범위·메모). 리뷰어는 에픽 브랜치에서 본다 |
| X5 | §7.5, §4.1, §3.1, §14 | 테스트 결과 보고는 M5. IMPLEMENTATION 종료 조건은 "스키마 + coverage 100% + 명령 통과" | M4에 단계를 넘길 서명 이벤트가 없다. `phase.completed`의 `artifact_hash`만으로는 어느 커밋을 검사했는지 알 수 없다 | `gate.reported`를 M4로 당긴다. 확장이 명령을 실행해 보고하면 서버가 그 커밋이 원격 에픽 브랜치에 있는지 확인해 서명한다. `phase.completed(IMPLEMENTATION)`에 `commit`을 추가한다. 서버는 그 커밋이 원격 에픽 브랜치 끝이고, 그 커밋의 서명된 보고가 모두 종료 코드 0이며, impl-log 형식이 맞을 때 서명한다(`artifact_hash` = 그 커밋의 tree 해시). reducer도 같은 커밋의 통과 보고를 요구한다 |
| X6 | §6.4 비밀값 제거 | 환경변수 값, 토큰 패턴, `.env` 내용을 가린다 | 환경변수 값을 모두 가리면 `HOME`·`PATH` 같은 경로가 원본 곳곳에서 가려져 검색·읽기가 어렵다 | 가리는 대상: 이름이 비밀처럼 보이는 환경변수(`TOKEN`·`SECRET`·`KEY`·`PASSWORD`·`CREDENTIAL`·`AUTH` 포함)의 값, 토큰 패턴(`sk-…`, `ghp_…`, `github_pat_…`, ClickUp `pk_…`, Slack `xox?-…`, AWS `AKIA…`, JWT, PEM 개인키), 작업 폴더 `.env*` 파일의 값. 가린 자리는 `[REDACTED]` |
| X7 | §8.1 "생성 직후 push", §6.4 세션 원본 저장 시점 | 체크포인트는 만든 직후 push. 세션 원본 저장 시점은 정해지지 않음 | 훅 안에서 push하면 GitHub 기준 약 4초씩 에이전트가 멈춘다. 세션이 끝날 때만 저장하면 긴 세션 중에는 리뷰어가 검색할 수 없다 | 훅은 로컬 ref만 바꾸고, **분리된 백그라운드 `git push`**를 띄운다(서버 모드). 세션 원본은 **턴 종료(Stop)와 세션 종료** 때마다 그 세션 파일을 새로 쓴다(`<run-id>/<session-id>.jsonl.gz`). runs ref는 에픽당 하나라 CAS로 갱신한다 |
| X8 | §8.1 복원, §7.3 | 복원 직전 상태를 체크포인트로 남긴다 | 복원은 디스크를 바꾸므로 편집 기록 재적용 ≠ 디스크가 되어 외부 변경(메모 필수)으로 잡힌다. 복원으로 되살아난 줄의 실제 출처는 예전 편집이다 | 복원도 편집 기록에 남긴다(새 출처 `restore {member, ckpt, seq}`, 파일 전체 교체). coverage는 복원된 파일의 출처를 그 체크포인트의 편집 기록 위치(`Flightdeck-Seq`)에서의 출처로 되살린다. 내용이 맞지 않으면(기록 누락) 그 줄은 메모가 필요하다 |
| X9 | §6.1 연동 지점, §7.2 | PostToolUse에서 편집 기록·trace | Claude Code는 **실패한 도구 호출**(예: 종료 코드가 0이 아닌 Bash)에는 PostToolUse 대신 `PostToolUseFailure`를 부른다(2.1.287에 있음). 등록하지 않으면 실패한 셸 명령이 바꾼 파일이 기록되지 않고 전 스냅샷이 남는다 | `PostToolUseFailure`도 등록해 `tool.after`(실패 표시)로 처리한다. trace에 실패를 남긴다 |
| X10 | §6.2 IMPLEMENTATION | `.flightdeck/` 제외 전체 + `impl-log.md`, handoff | X1로 impl-log는 MCP로만 쓴다. trace.jsonl은 훅이 쓴다 | 에이전트 쓰기 허용: `.flightdeck/` 밖 전체 + 이번 실행의 handoff. impl-log·trace는 Flightdeck만 쓴다 |

### 구현 중 발견 (추가 제안)

| # | 절 | 문제 | 제안 |
|---|---|---|---|
| X8-2 | §8.1 복원 | Step 체크포인트는 그 Step 기록(impl-log)보다 먼저 만든다(X1). 그래서 Step 1 체크포인트로 복원하면 impl-log의 Step 1 기록까지 사라졌다(workflow 테스트에서 발견) | 복원은 **제품 코드만** 되돌린다. `.flightdeck/` 아래 Flightdeck 기록(impl-log·trace·handoff)은 복원 대상에서 뺀다(구현함) |
| X11 | §7.3 hunk 단위 | 새 파일은 base가 없어 파일 전체가 hunk 하나다. 실측에서 사람이 새 파일 첫 줄에 주석 하나를 넣었는데 메모 범위가 `src/token.js:1-17`(파일 전체)로 나왔다. 리뷰어가 사람이 고친 줄을 알 수 없다 | 메모 묶음의 줄 범위는 hunk가 아니라 **그 출처의 문자가 있는 줄**로 계산한다(Step `changes`와 같은 방식). hunk 통과 판정은 그대로 둔다. M4에서는 구현하지 않음 |
| X12 | §7.1 Step | 실측에서 에이전트(haiku)가 두 Step 분량을 한 번에 쓰고 Step 1·2를 이어서 기록했다. Step 2의 `changes`가 비었다 | `changes`가 빈 Step을 형식 오류로 막지는 않되(문서·확인만 하는 Step도 있다) `flightdeck_log_step` 응답에 "이 Step의 코드 편집 없음"을 알려 에이전트가 Step을 나눠 쓰도록 유도한다(응답에는 이미 있음). 룰에 "Step 하나를 끝낼 때마다 기록, 여러 Step을 한 번에 쓰지 않는다"를 더한다 |

## 결정 (2026-10-05, design.md v0.14에 반영)

| # | 결정 |
|---|---|
| X1~X10, X8-2 | 제안(구현한 그대로) |
| X11 | 제안대로: 메모 묶음의 줄 범위는 그 편집들의 문자가 있는 줄 (구현함, 실측 사례 `1-17` → `1`) |
| X12 | 제안대로: 단계 룰에 "Step 하나를 구현·확인·기록한 뒤 다음 Step" (견본 룰에 추가) |

## 진행 결과

| 단계 | 커밋 | 결과 |
|---|---|---|
| M4-1 | `a65265a` | impl-log 파서·렌더러·형식 검사, 출처 추적 재적용(문자 단위 출처 + 삭제 표시, 복원 출처 되살리기)·hunk별 coverage·수정 묶음, Step `changes` 계산, 세션 원본 BM25 검색(한글 2-gram), 비밀값 가림, reducer `gate.reported`·`phase.completed(IMPLEMENTATION)` |
| M4-2 | `6120cab` | 편집 출처에 Step, trace.jsonl, PostToolUseFailure, 턴 종료·세션 종료 때 세션 원본 저장(runs ref, CAS), ckpt·runs ref 백그라운드 push, MCP `flightdeck_log_step`·`flightdeck_submit`·`flightdeck_search_run`, impl-log 직접 쓰기 차단, IMPLEMENTATION 맥락 |
| M4-3·M4-4 | `cdcd199`, `4eb6e41` | 서버 `gate.reported`(원격 에픽 브랜치에 있는 커밋, 담당자) · `phase.completed(IMPLEMENTATION)`(원격 끝 = 검사한 커밋, impl-log 형식, 통과 보고). workflow 구현 관문(외부 변경 기록 → coverage·impl-log → 커밋(비밀 파일 제외)·공유 → 명령 실행·로그 보관 → 보고 → 완료), 메모, 체크포인트(사람 저장 10초, 에이전트 유휴), 복원(X8-2), 확장 명령(구현 완료, 설명 필요 변경, 복원, 비교)과 상태 표시줄. 테스트 176개 |
| M4-5 | (이번 커밋) | 실제 VS Code 시나리오(아래). 찾아 고친 것: 서버를 다시 띄우면 저장된 세션이 없어 창이 "로그인 필요"에서 멈춤 → 개발용 로그인 멤버가 있으면 한 번 다시 로그인. Step 제목의 "Step n:" 중복 |

### M4 완료 확인 결과 (2026-10-05)

실제 VS Code 두 창(멤버별 사용자 데이터) + GitHub `test-flightdeck` + 로컬 서버 + 실제 ClickUp. 설정 `sample-m4`: lead 티어 리뷰어가 dh.lee 혼자라 담당자가 스스로 승인(W3), architect 티어는 리뷰어가 없어 건너뜀(W4). 관문 명령은 레포의 `node check.js`. 에이전트는 **실제 claude(haiku)** 두 번(담당자 구현 1회, park 검색 1회). 사람의 경고 창(모달) 대신 그 창이 부르는 함수를 불렀다.

| 단계 | 멤버 | 결과 |
|---|---|---|
| 시작 → IMPLEMENTATION | dh.lee | 서버 서명 `epic.started`, `phase.completed(ANALYSIS)`, `review.requested`, lead 자기 승인 → architect 건너뜀 → IMPLEMENTATION (97초, 대부분 GitHub 왕복) |
| 에이전트 구현 | dh.lee | claude가 훅 아래에서 `src/token.js` 작성, `node check.js`, `flightdeck_log_step` 2회, `flightdeck_submit` "통과 coverage 100%" (46초). 편집 기록의 에이전트 편집에 `step: 1`, 체크포인트 3개(Step 1, Step 2, 턴 종료), trace 4줄, 세션 원본 1개. ckpt·runs ref가 원격(GitHub)에 올라감(백그라운드 push) |
| 사람 직접 수정·외부 변경 | dh.lee | 에디터로 `src/token.js` 첫 줄에 주석 + 저장(human 편집), 셸로 README.md 수정(기록 없음) |
| 제출 1차 | dh.lee | **차단**: `coverage 0% < 100%`, `README.md:4-5 — 메모 없는 외부 변경`, `src/token.js:1-17 — 메모 없는 직접 수정 (@dh.lee)`. 커밋하지 않음. 상태 표시줄 `IMPLEMENTATION · Step 3 · 설명 필요 2` |
| 메모 | dh.lee | 두 묶음에 메모 → 설명 필요 0, impl-log에 "직접 수정 메모" |
| 제출 2차 | dh.lee | 커밋·공유 → `node check.js` "ok 3 passed" → 서버 서명 `gate.reported`, `phase.completed(IMPLEMENTATION)` → **VERIFICATION**, ClickUp `검증` |
| 세션 원본 검색 | park | 읽기 전용 창의 claude가 `flightdeck_search_run`(원격 runs ref를 받음)으로 "새 토큰을 어떻게 만들기로 했나"를 찾아 Step 1 결정(`crypto.randomBytes(16).toString('hex')`)을 근거와 함께 답함 (22초) |
| 세션 원본 내용 | — | 40항목: 사람 프롬프트·에이전트 메시지·도구 결과·Flightdeck 주입 맥락만. 이메일·CLAUDE.md·메모리 내용 없음 |

확인하지 못한 것: 사람이 직접 하는 클릭(메모 입력 창, 경고 창 버튼, 복원 확인 창), 체크포인트 복원·비교 화면(복원은 workflow 테스트로만), 에이전트 유휴 30초 체크포인트, 대화형 Claude Code(시나리오는 headless). 이번 시나리오 서버는 메모리 저장소로 돌렸다(PostgreSQL 컨테이너가 응답하지 않음 — OrbStack 상태 확인 필요).
