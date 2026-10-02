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

## 구현 중 발견한 설계 문제 (design.md 미반영, 검토 후 반영)

| # | 절 | 현재 서술 | 문제 | 제안 | 근거 |
|---|---|---|---|---|---|
| T1 | §3.1 | 쓰레드 ID는 `t-<ULID 앞 8자>` | ULID 앞 10자가 시각(밀리초)이라, 앞 8자는 약 1초(2¹⁰ms) 해상도다. 같은 1초 안에 만든 쓰레드는 ID가 겹친다. 여러 사람이 동시에 질문을 올리면 실제로 생긴다 | `t-<ULID 뒤 8자>`(난수 40비트) 또는 `t-<ULID 전체>`. 짧은 표시가 필요하면 화면에서만 줄인다 | `packages/core/test/docs.test.ts` "약 1초 안에 만든 쓰레드끼리 겹친다" |
