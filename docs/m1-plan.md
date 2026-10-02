# M1 로컬 단일 사용자 — 구현 계획

- 기준: [design.md](design.md) v0.10 §14 M1
- 완료 기준: **혼자 분석 → 설계 초안**. 한 사람이 VS Code에서 에픽을 시작하고, 에이전트가 분석 초안을 쓰고, 쓰레드로 질문·답을 주고받고, 분석을 완료하면 설계 초안까지 나온다.

## 범위

| 포함 | 제외 (이후 마일스톤) |
|---|---|
| core reducer·렌더러, 문단 ID, 편집 추적 | 서명 검증 (M2. 이벤트에 `sig` 필드만 둠) |
| GitEngine 기초 (worktree, 커밋, 체크포인트·복원) | 원격 push·fetch (M2. 메타 브랜치는 로컬에만) |
| AgentAdapter 인터페이스 + claude-code 어댑터 | 일감 도구 연동 (M2. 에픽은 직접 입력) |
| flightdeck-hook, MCP 최소 도구 | 서버 (M5~M8. 편집 기록은 로컬 파일) |
| ANALYSIS·DESIGN 단계, handoff | 티어 승인 (M3), 구현·검증 단계 (M4~M5) |

## 기술 선택

- TypeScript, pnpm workspace, Node 22 이상
- 테스트: vitest
- 패키지는 개발 중 `src/*.ts`를 직접 내보낸다. 실행물(훅 CLI, MCP 서버, VS Code 확장)만 esbuild로 묶는다.
- 스키마: zod. pipeline.yaml 파싱: `yaml`

## 단계

| 단계 | 패키지 | 내용 | 완료 확인 |
|---|---|---|---|
| M1-1 | 루트, `schema` | 모노레포 골격. 이벤트(§3.1), pipeline.yaml(§5), 산출물 섹션(§6.3), handoff(§6.4) 스키마 | 단위 테스트 |
| M1-2 | `core` | 문단 ID 부여·검사(§3.2), 쓰레드 블록 렌더·파싱(§3.2), reducer(INTAKE → ANALYSIS → DESIGN), 편집 기록 적용·앵커 이동(§3.5, §8.6), 산출물 형식 검사 | 단위 테스트 |
| M1-3 | `git` | worktree 생성·정리, 에픽 브랜치 커밋, 체크포인트·복원(§8.1, M0 5번 방식), 로컬 메타 브랜치 EventStore(§1.3) | 임시 레포 통합 테스트 |
| M1-4 | `agent`, `hook`, `mcp` | AgentAdapter + claude-code 어댑터(§6.5), flightdeck-hook(§6.1 훅 입출력·실패 정책, §6.2 권한, §8.6 편집 기록), MCP 도구 `flightdeck_get_epic`·`flightdeck_list_threads`·`flightdeck_get_handoffs` | 훅 단위 테스트 + `claude -p` 1회 통합 확인 |
| M1-5 | `vscode` | 에픽 시작 → 자동 분석 초안(`claude -p`) → 이어서 작업(resume) → Comments 쓰레드 → 분석 완료 → 설계 초안 | 수동 시나리오 1회 |

## M1에서 정한 처리

- **에픽 입력**: 명령 팔레트 "Flightdeck: 새 에픽"에서 ID·제목·본문을 받아 `epic.md`를 만든다.
- **이벤트 저장**: §1.3 `EventStore`의 로컬 구현. 레포의 `flightdeck-meta` 브랜치에 커밋만 하고 push하지 않는다.
- **편집 기록**: §8.6 형식으로 `.git/flightdeck/editlog/<epic-id>.jsonl`에 쌓는다. M7에서 서버 전송을 붙인다.
- **훅 ↔ 확장 통신**: 상태 파일(`.git/flightdeck/state/<epic-id>.json`)을 훅이 읽고, 훅 결과는 jsonl로 남긴다. 로컬 IPC는 M8(실시간 관찰)에서 붙인다.

## 진행 결과

| 단계 | 커밋 | 결과 |
|---|---|---|
| M1-1 | `128694b` | schema. design.md의 예시·이벤트 표를 직접 읽는 테스트로 문서 불일치 1건 발견·수정 |
| M1-2 | `8d35f0b` | core. 무작위 500건 diff 왕복, M0 실측 IME 17건 묶음 |
| M1-3 | `d46bed7` | git. 복원 시 `.env` 삭제 버그를 테스트로 잡아 수정 |
| M1-4 | (이번 커밋) | agent·hook·mcp + workflow. 테스트 81개. 실제 `claude -p`(haiku) 1회 확인 |

### M1-4 실제 claude 확인 (2026-10-02)

`node dist/fd-demo.mjs setup|draft|check /tmp/fd-m1demo` — 견본 인증 모듈 레포에서 에픽 CU-DEMO를 시작하고 분석 초안을 자동 작성했다(haiku, 65초).

```
phase: ANALYSIS, events: epic.started → run.started → run.finished
runs: [{ run: 01M3XQ0QCY2X1035W4PQZTGWQ1, finished: true, handoff: true }]
phaseProblems: []                       ← 필수 섹션 4개 모두 작성, 인수인계 기록 섹션도 통과
editlog: records 2, mismatches 0
  replayMatchesDisk: analysis.md false  ← 초안 뒤 Flightdeck이 붙인 문단 ID가 기록되지 않음 → T4로 수정
                     handoff.md  true
hook: { edits: 2 }, denies: [], errors: []
checkpoints: ["b1e9bfe 에이전트 체크포인트 (턴 종료)"]
```

- 초안 품질: 요구사항 3개, 영향 범위(근거 파일 포함), 불명확한 점 4개(누구에게·왜 중요한지), 가정 4개. 인수인계 기록도 형식대로.
- 에이전트가 금지된 도구를 시도하지 않아 차단은 0건이었다(차단 동작은 훅 테스트로 확인).

## 구현 중 발견한 설계 문제 (design.md 미반영, 검토 후 반영)

| # | 절 | 현재 서술 | 문제 | 제안 | 근거 |
|---|---|---|---|---|---|
| T2 | §8.1, §5 | 비밀 파일 패턴(`checkpoint.exclude_secrets`)은 체크포인트에서 뺀다 | 복원은 "현재 트리 → 대상 체크포인트" 두 트리 병합이라, 한쪽에만 비밀 파일이 있으면 그 파일을 지운다. 구현 중 복원 직전 체크포인트에 패턴을 빠뜨려 `.env`가 지워지는 버그를 테스트가 잡았다. 패턴이 에픽 도중 바뀌어도(설정 업그레이드) 같은 일이 생긴다 | (a) 체크포인트와 복원은 **반드시 같은 패턴**을 쓴다(GitEngine에 한 번만 정하도록 구현함) (b) 복원 시 대상 체크포인트에 없는 파일 중 현재 패턴에 걸리는 파일은 지우지 않는다 (c) 에픽 도중 패턴이 바뀌면 다음 체크포인트부터 적용하고, 그 이전 체크포인트로의 복원은 비밀 파일을 건드리지 않는다고 명시 | `packages/git/test/git.test.ts` 복원 테스트 |
| T3 | §2.4 | 메타 브랜치는 `../<repo>.flightdeck/_meta` worktree로 다룬다 | 이벤트 추가는 파일 하나를 더하는 일이라 작업 폴더가 필요 없다. worktree를 쓰면 폴더 관리와 동시 쓰기 잠금이 추가로 필요하다 | `_meta` worktree를 없애고, git 저수준 명령(blob → 임시 index → commit-tree → update-ref CAS)으로 추가한다고 고친다(이렇게 구현함). 동시 20건 추가에서 유실·병합 커밋 0 | `packages/git/test/git.test.ts` 동시 추가 테스트 |
| T4 | §8.6 편집 경로 표, §3.2 | 편집 출처는 human, agent, agent_shell, patch, external | Flightdeck 자신이 문서를 바꾸는 경로(문단 ID 부여, 쓰레드 블록 렌더링)가 표에 없다. 실제 claude 초안 뒤 렌더링 변경이 기록되지 않아 `analysis.md`의 편집 기록 재적용 ≠ 디스크가 됐다 | 출처 `flightdeck`(reason: `paragraph_ids` \| `thread_render`)를 추가하고 렌더링 변경도 편집 기록에 남긴다(이렇게 구현함). coverage(§7.3)에서는 설명이 필요 없는 출처로 본다 | M1-4 실제 claude 확인, `workflow.test.ts` |
| T5 | §3.2 | 확장이 문서의 모든 문단·제목 앞에 ID를 붙인다 | "문단"의 범위가 정해져 있지 않다. 목록 전체를 한 블록으로 보면 "불명확한 점" 항목마다 질문 쓰레드를 달 수 없다(실제 초안의 불명확한 점 4개가 한 목록) | **최상위 목록 항목마다** ID를 붙인다. 하위 항목·이어지는 줄은 상위 항목에 속한다(이렇게 구현함). 목록 항목 사이에 HTML 주석이 들어가 미리보기에서 목록이 나뉘어 보일 수 있다 | `docs.test.ts`, `workflow.test.ts` |
| T6 | §8.1 구현 규칙, §8.6 셸 편집 | 임시 index는 사용자 index를 복사해 만든다(stat 캐시 재사용) | 복사하면 index 파일의 수정 시각이 새로 찍혀 git의 racy 검사가 꺼진다. 그러면 **같은 1초 안에 같은 크기로 바뀐 파일**을 "안 바뀜"으로 보고 예전 내용을 담는다. 체크포인트·셸 편집 기록에서 편집이 조용히 빠진다. 훅 테스트가 간헐적으로(4회 중 1회) 잡았다. 셸 재현: 시각이 새로 찍힌 복사 6/6회 예전 내용, 시각 보존 복사 0/6회 | 복사한 임시 index의 수정 시각을 원본과 같게 둔다(`utimes`, 이렇게 구현함). M0 5번 스파이크의 방식에도 같은 문제가 있었다 | `git.test.ts` racy 테스트, 셸 재현 |
| T1 | §3.1 | 쓰레드 ID는 `t-<ULID 앞 8자>` | ULID 앞 10자가 시각(밀리초)이라, 앞 8자는 약 1초(2¹⁰ms) 해상도다. 같은 1초 안에 만든 쓰레드는 ID가 겹친다. 여러 사람이 동시에 질문을 올리면 실제로 생긴다 | `t-<ULID 뒤 8자>`(난수 40비트) 또는 `t-<ULID 전체>`. 짧은 표시가 필요하면 화면에서만 줄인다 | `packages/core/test/docs.test.ts` "약 1초 안에 만든 쓰레드끼리 겹친다" |
