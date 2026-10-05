# M5 검증·반영 — 구현 계획

- 기준: [design.md](design.md) v0.14 §14 M5, §3.3(코드 쓰레드), §4.1·§4.2(VERIFICATION 티어), §4.3(되돌림), §9.3(리뷰 사본·수정 제안), §11(반영 서버), §12
- 완료 기준: **실제 에픽 1개가 서버를 통해 main까지**
  - 구현을 제출하면 VERIFICATION 티어 리뷰가 시작된다.
  - 리뷰어가 자기 사본에서 코드를 고쳐 **수정 제안(패치)**을 붙인 코드 쓰레드를 단다. 담당자가 반영하고 다시 요청하면 1티어부터 다시 승인받는다.
  - 마지막 티어가 승인하면 서버가 다시 검증하고 main 위로 반영(squash)해 push한다. `epic.landed`(서버 서명)로 DONE.
  - main이 그 사이 움직였으면 서버가 rebase하고, 담당자 확장이 rebase 결과로 테스트를 다시 보고한 뒤 반영한다(사람의 재승인 없음).
  - main에 Flightdeck 밖에서 들어온 커밋은 확장이 감사로 잡아 알린다.

## 범위

| 포함 | 제외 (이후 마일스톤) |
|---|---|
| VERIFICATION 티어 리뷰: 리뷰 요청(테스트 통과 커밋)·승인·재승인 | 서버의 coverage 재계산 (M7, v0.14 §7.3 6) |
| 코드 쓰레드: 코드 줄에 쓰레드, 앵커 `{file, rev, range, context}`, 담당자 작업 폴더에서는 diff 줄 매핑으로 위치 계산 | 편집 기록 기반 앵커 이동 (M7) |
| 리뷰 사본(쓰기 가능한 리뷰어 창), 수정 제안(패치) 첨부, 담당자의 반영(`patch.applied`, 편집 출처 `patch`) | 회의 (M6), 조종 넘기기 (M8) |
| 반영 서버: 재검증 → rebase → squash(기록 정리) → main push → `epic.landed`/`land.rejected`, main 이동 시 재보고 경로, 충돌 시 IMPLEMENTATION | 내장 git 서버·pre-receive (M5.5) |
| 구현 재개(VERIFICATION → IMPLEMENTATION, §4.3) | 정리 예약(브랜치·ref 삭제 실행, retention) — 반영 후 에픽 브랜치 삭제만 |
| main 감사(§11.4), GitHub main 보호 설정 안내·확인 | |

## 단계

| 단계 | 패키지 | 내용 | 완료 확인 |
|---|---|---|---|
| M5-1 | `schema`, `core` | VERIFICATION 리뷰 설정·진행(Y1), `gate.reported`를 VERIFICATION에서도, 코드 쓰레드 앵커·패치 첨부(Y3), `patch.applied`, `phase.reverted` VERIFICATION→IMPLEMENTATION, LANDING·DONE(`epic.landed`, `land.rejected`), main 감사 판정 | 단위 테스트 |
| M5-2 | `git`, `server` | 반영 작업(Y5): 재검증(reducer·서명·impl-log 형식·테스트 보고) → main 위 rebase → 기록 정리 squash + trailer → main push → `epic.landed`. main 이동 시 rebase 결과를 에픽 브랜치에 올리고 `land.rejected(needs_report)`, 충돌 시 `land.rejected(conflict)`. 마지막 승인 서명 시 작업 등록 + 1분 주기 스캔, `GET /land/<job>` | 서버 통합 테스트 (main 이동·충돌 포함) |
| M5-3 | `hook`, `agent`, `mcp` | 리뷰 사본 정책(Y3: `.flightdeck/` 밖 쓰기·셸 허용, git 금지, 기록 안 함), VERIFICATION 에이전트 셸은 테스트 명령만(§6.2), 리뷰어 맥락(diff·impl-log·handoff·`search_run`) | 훅 테스트 |
| M5-4 | `vscode` | 구현 완료 뒤 VERIFICATION 리뷰 요청, 리뷰 사본 열기, 코드 쓰레드(Comments, 줄 매핑), 수정 제안 만들기·반영, 다시 요청, 구현 재개, 반영 진행 표시·재보고 자동 처리, 반영 후 정리, main 감사 경고 | workflow 수준 시나리오 테스트 |
| M5-5 | — | 실제 VS Code 3창(담당자 dh.lee, verification lead park, qa choi) + GitHub `test-flightdeck`: park의 에이전트(실제 claude 1회)가 리뷰 사본에서 고친 수정 제안 → 담당자 반영·재요청 → 두 티어 승인 → 서버가 main에 반영 → DONE·ClickUp 완료 | 완료 기준 |

## 미리 보이는 설계 문제 (구현 전 제안)

구현은 아래 제안대로 진행한다. design.md는 확인을 받은 뒤 고친다.

| # | 절 | 현재 서술 | 문제 | 제안 |
|---|---|---|---|---|
| Y1 | §4.1 VERIFICATION, §4.2 | 하위 상태 `owner_review → tier[1..n]_review`. 승인의 `artifact_hash`는 에픽 브랜치 tree 해시 | 티어 리뷰를 시작하는 리뷰 요청이 정해지지 않았다. 리뷰 중 수정 제안을 반영하면 코드가 바뀌어 테스트 결과도 다시 필요하다 | DESIGN과 같은 `review.requested {phase: VERIFICATION, artifact_hash: tree:<tree>, commit}`. 서버는 그 커밋이 원격 에픽 브랜치 끝이고 **같은 커밋의 서명된 테스트 보고가 모두 통과**일 때 서명한다. 구현 완료(`phase.completed`) 직후 확장이 첫 리뷰 요청을 낸다. 수정 제안을 반영한 뒤의 "다시 요청"은 관문 검사 → 커밋 → 명령 실행·보고 → 리뷰 요청 순서다. 재승인은 `reapproval` 그대로 |
| Y2 | §3.3, §3.5 | 코드 쓰레드 위치는 편집 기록으로 계산 | 편집 기록 기반 앵커 이동은 M7이다 | M5는 앵커 `{type: code, file, rev(리뷰 요청 커밋), range, context}`를 남기고, 담당자 작업 폴더에서는 `rev → 작업 트리` diff로 줄을 옮긴다(§3.5 대체 수단 3번). 줄이 지워졌으면 가장 가까운 줄에 "위치 잃음"으로 표시한다 |
| Y3 | §9.3, §2.4 `#review-<member>` | 리뷰어가 `리뷰 시작`을 누르면 리뷰 전용 사본이 따로 생긴다. 수정 제안은 쓰레드 답글의 `patch` | 리뷰어 창이 둘(읽기 전용 창 + 리뷰 사본)이면 어디서 쓰레드를 다는지 헷갈린다. 수정 요청 쓰레드를 만들 때 바로 패치를 붙일 수 없다 | VERIFICATION 리뷰어의 창은 **리뷰 요청 커밋의 쓰기 가능한 사본**(경로는 지금의 읽기 전용 창과 같음)이다. 리뷰어(와 그 에이전트)는 자유롭게 고칠 수 있고 기록하지 않는다(git 명령만 금지). "수정 제안 만들기" = 사본의 `rev` 대비 diff(`.flightdeck/` 제외)를 `change_request` 쓰레드(`thread.created.patch`, 신설) 또는 답글(`thread.replied.patch`)에 붙인다. 붙인 뒤 사본은 리뷰 커밋으로 되돌린다. 패치는 메타 이벤트에 그대로 넣고 64KB로 제한한다 |
| Y4 | §9.3 4, §8.6 `patch` | 조종수가 반영하면 `patch.applied` | 반영 결과를 편집 기록·coverage에서 어떻게 보는지 | 담당자 작업 폴더에 `git apply --3way`(실패하면 이유를 알리고 중단). 바뀐 파일의 전후를 출처 `patch:<thread>/<member>`로 편집 기록에 남긴다(설명 필요 없음). `patch.applied {thread, commit: 패치를 만든 리뷰 커밋}`. 반영 뒤에는 Y1의 "다시 요청" |
| Y5 | §11.1 | 마지막 검증 티어 승인자의 확장이 `land.requested`를 남기고 `POST /land`를 호출. 서버도 1분마다 확인 | 승인 서명은 서버가 하므로, 서버는 마지막 승인 시점을 이미 안다. 확장을 거치면 실패 경로만 늘어난다 | 서버가 마지막 티어 승인(→ LANDING)에 서명하면 **바로 반영 작업을 등록**한다. 1분 스캔은 재시작 복구용으로 둔다. `land.requested` 이벤트는 쓰지 않는다(`POST /land`는 담당자의 재시도용으로 남긴다) |
| Y6 | §11.3 7 `needs_report` | 서버가 rebase 결과를 에픽 브랜치에 push → 담당자 확장이 명령 실행·보고 → `POST /land` | 담당자 확장이 꺼져 있으면 반영이 멈춘다. 재보고 뒤 누가 반영을 다시 거는지 정해지지 않았다 | 확장이 `needs_report`를 보면 작업 폴더를 그 커밋으로 fast-forward하고(Y9, 바뀐 파일은 편집 기록에 `external:<commit>`) 명령 실행·보고. 서버는 그 보고에 서명하면서 반영 대기로 돌아가므로 **바로 반영 작업을 다시 건다**(`POST /land` 불필요). 확장이 꺼져 있으면 열 때 이어서 한다 |
| Y9 | §11.3 7 rebase | main이 움직였으면 서버가 main 위로 rebase하고 결과를 에픽 브랜치에 force-with-lease로 올린다 | rebase는 에픽 브랜치 이력을 다시 쓴다. 담당자 작업 폴더·체크포인트(부모가 에픽 커밋)가 갈라지고, 외부 git에서는 브랜치 보호와도 부딪힌다. 반영은 어차피 squash라 에픽 브랜치 이력 모양은 main에 남지 않는다 | rebase 대신 **main을 에픽 브랜치에 병합한 커밋**(부모: 검증한 커밋, main)을 서버가 만들어 올린다(fast-forward). 충돌 판정은 `git merge-tree`로 작업 폴더 없이 한다. 담당자 작업 폴더도 fast-forward로 따라온다. 그 커밋으로 테스트를 다시 보고하면 squash는 main 위에 그 tree로 만든다 |
| Y7 | §11.3 8, §5 `landing.records` | `drop`(trace.jsonl, state.json)을 빼고 squash | `keep`과 `drop`이 모두 있으면 둘에 없는 파일(예: 리뷰 중 생긴 파일)의 처리가 모호하다 | squash 트리 = 에픽 tree에서 `.flightdeck/epics/<epic>/` 아래는 `keep`에 맞는 것만 남긴다(`drop`은 문서화용). `threads/code.json`은 반영 서버가 그 시점 코드 쓰레드로 만든다. squash 커밋 메시지 = 일감 제목 + trailer(§11.3 8) |
| Y8 | §11.4 감사 | trailer가 없거나 `epic.landed`가 없는 main 커밋을 경고 | Flightdeck 도입 전 커밋은 모두 걸린다 | 감사 시작점 = 메타 브랜치의 가장 오래된 `epic.started.base_sha`. 그 뒤 main first-parent 커밋 중 trailer `Flightdeck-Epic`이 없거나 그 에픽의 서명된 `epic.landed.main_commit`과 다르면 경고(확장 알림, 출력 창). 어드민이 확인한 커밋은 감사 예외로 등록할 수 있다(설정 `landing.audit_allow: [sha…]`). M4 시나리오에서 시험 레포 main에 직접 넣은 `check.js` 커밋이 실제로 걸려야 한다 |

## 결정

2026-10-05 사용자 결정: Y1~Y9 모두 제안대로. design.md v0.15에 반영했다.

## 진행 결과

| 단계 | 커밋 | 결과 |
|---|---|---|
| M5-1~M5-4 | `b16b462`, `b8e36bd` | reducer: VERIFICATION 리뷰(통과 보고가 있는 커밋만 요청), 수정 제안(`patch`, `patch.applied`), 구현 재개, LANDING·DONE(`epic.landed`, `land.rejected` needs_report/conflict). core: 반영 기록 정리, main 감사, 코드 쓰레드 줄 옮기기. 서버: 반영 작업(재검증 → main 병합 커밋·재보고 대기 → squash → main push → `epic.landed` → 에픽 브랜치 삭제), 마지막 승인·재보고 서명 때 작업 등록, 1분 스캔, `POST /land`·`GET /land/<job>`. 훅: 리뷰 사본 정책, VERIFICATION 셸은 관문 명령만. workflow·확장: 리뷰 사본, 코드 쓰레드 표시·만들기, 수정 제안 만들기·반영, 검증 다시 요청, 구현 재개, 반영 재보고 자동, main 감사. 테스트 190개 |
| M5-5 | (이번 커밋) | 실제 VS Code 시나리오(아래). 견본 설정에 `rules/verification.md` 추가, 시나리오 창 실행 스크립트가 멤버 목록을 받게 함 |

### M5 완료 확인 결과 (2026-10-05)

실제 VS Code 세 창(담당자 dh.lee, 검증 lead park, qa choi) + GitHub `test-flightdeck` + 로컬 서버 + 실제 ClickUp. 설정: 설계 lead = dh.lee(자기 승인), architect 없음, 검증 lead = park, qa = choi, 관문 명령 `node check.js`. 담당자의 구현은 훅이 하는 일을 직접 했고(실제 claude 구현은 M4에서 확인), park의 에이전트는 **실제 claude(haiku) 1회**. 경고 창(모달)과 확인 알림 버튼 대신 그것이 부르는 함수를 불렀다.

| 단계 | 멤버 | 결과 |
|---|---|---|
| 구현 제출 → 검증 리뷰 요청 | dh.lee | 관문 통과 → 커밋·공유 → `node check.js` → 서명 `gate.reported`·`phase.completed` → 서명 `review.requested(VERIFICATION)` (tree 해시), lead 차례 |
| 리뷰 사본 | park | 리뷰 차례 → 쓰기 가능한 리뷰 사본(`VERIFICATION(lead) · 리뷰 사본 · 내 리뷰 차례`) |
| 에이전트 수정 → 수정 제안 | park | claude가 리뷰 사본에서 `rotate`에 형식 검사 한 줄 추가·`node check.js` 통과(19초). "수정 제안 만들기" → `change_request` 코드 쓰레드(앵커: 리뷰 커밋 3줄, 앞뒤 문맥) + 패치. 사본은 리뷰 커밋으로 되돌아감. 이 상태의 승인은 서버가 거부("승인자가 연 열린 쓰레드 1개") |
| 반영·다시 요청 | dh.lee | "@park의 수정 요청" 알림 → 쓰레드의 "수정 제안 반영" → 설명 필요 0(출처 patch) → 답글 → 검증 다시 요청(관문·커밋·테스트·보고·요청) → lead부터 다시 |
| lead 승인 | park | 사본이 새 리뷰 커밋으로 옮겨짐(수정 포함) → 쓰레드 해결 → 승인(서명) → qa 차례 |
| main 이동 + qa 승인 | choi | main에 직접 커밋 push(Flightdeck 밖) → 승인(서명) → LANDING |
| 반영 | 서버·dh.lee | 서버: main이 움직여 병합 커밋을 에픽 브랜치에 올리고 서명 `land.rejected(needs_report)`. 담당자 창: 병합 커밋으로 fast-forward·테스트 재보고(자동). 서버: 재보고 서명과 함께 다시 반영 → main에 squash `736ae1a`(trailer: 에픽·설정·승인 2개·반영자), trace 제외, `threads/code.json` 생성, 에픽 브랜치 삭제, 서명 `epic.landed` → **DONE**. 담당자 확장의 일감 조정으로 ClickUp `complete`. 승인부터 DONE까지 약 2분 |
| main 감사 | dh.lee | 반영 서버를 거치지 않은 main 커밋 2개를 잡음: choi의 직접 push, M4 시나리오 때 시험 레포에 직접 넣은 `check.js`. 서명된 반영 커밋은 통과 |

찾아 고친 것: 수정 제안 반영 명령이 끝의 확인 알림을 기다려 명령이 끝나지 않음(알림을 기다리지 않게). 시나리오 1차 시도에서 에이전트 출처 기록이 실패한 채 `src/token.js`만 남았고, 다시 실행하자 관문이 그 파일을 "Flightdeck 밖 변경"으로 막았다(의도대로 동작. 시나리오는 새 일감으로 다시 함).

확인하지 못한 것: 사람이 직접 하는 클릭(거터 `+`로 코드 쓰레드, 쓰레드 버튼, 확인 창), 반영 충돌 경로(`conflict` → IMPLEMENTATION, 단위 테스트만), GitHub main 보호 설정(봇 계정이 없어 설정하지 않음 — §15 미결의 봇 방식 결정 필요), 내장 git 서버(M5.5). 이번에도 PostgreSQL 컨테이너가 응답하지 않아 시나리오 서버는 메모리 저장소로 돌렸다.
