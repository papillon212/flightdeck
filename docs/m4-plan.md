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

## 결정

(대기)

## 진행 결과

| 단계 | 커밋 | 결과 |
|---|---|---|
