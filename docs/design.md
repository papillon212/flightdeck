# Flightdeck — 설계 문서 v0.16

> 코딩 에이전트 시대의 원격 페어 프로그래밍 워크플로우 도구
> 작성일: 2026-10-01 · 상태: 초안(Draft)
> 제품명: **Flightdeck** (2026-10-01 확정, 외부 공개 예정. 이전 코드명 Together)
>
> **변경 이력**
> - v0.2: 자체 서버 제거. git, 일감 도구, Google Meet/Gemini로 대체.
> - v0.3: 개인 Claude Code CLI로 에이전트 실행. 일감 도구 어댑터 분리. 머지 시 기록 정리.
> - **v0.4**
>   - **git은 저장소로만 사용.** git 명령은 확장 내부에서만 실행.
>   - **PR 없음.** 승인은 서명된 이벤트로 처리하고, 마지막 검증 승인 시 확장이 main에 바로 반영.
>   - Delta 수준 협업을 위한 개선 추가: 실행 기록 3계층, 단계별 체크포인트, 따라보기, 리뷰 전용 작업 폴더, 편집 추적 기반 위치 고정.
> - **v0.5**
>   - **반영 서버(flightdeck-landing) 도입.** main push 권한은 서버만 가짐.
>   - pipeline.yaml·rules·멤버 공개키를 관리자 전용 **설정 레포**로 이동하고, 서버가 서명해 배포.
>   - 반영 전 서버가 승인·diff 대조를 직접 다시 검증. 테스트는 실행자의 서명된 보고를 신뢰(서버 재실행은 이후).
> - **v0.6**
>   - **조종수 모델**: 작업 폴더에 쓰는 사람은 한 번에 한 명(조종수). 나머지는 실시간으로 관찰하고, 조종수에게 의견을 낸다. 필요하면 조종을 넘긴다.
>   - 동시 편집(CRDT)은 하지 않는다. 에이전트 시대에는 두 사람이 같은 부분을 동시에 편집할 이유가 거의 없다.
>   - **편집 기록 서버**: 모든 편집을 출처(멤버·실행·Step·대화 메시지)와 함께 기록. 위치 고정과 diff 대조를 편집 기록 기반으로 전환.
>   - 서버 이름을 flightdeck-server로 바꾸고 모듈을 나눔: 설정 배포 · 반영 · 편집 기록 · 실시간 중계.
> - **v0.7**
>   - **대화 화면을 만들지 않는다.** 조종수는 Claude Code(공식 VS Code 확장 또는 터미널)를 그대로 쓴다.
>   - Flightdeck는 Claude Code의 공식 확장 지점(hooks·MCP)에만 붙는다. 모델 변경, plan 모드, 슬래시 명령, 권한 창 등은 Claude Code 기본 기능 그대로 사용.
>   - headless 실행은 자동 초안에만 쓰고, 조종수가 같은 세션을 이어서(resume) 대화형으로 계속한다.
> - **v0.8**
>   - **AgentAdapter** 도입. 1차는 Claude Code이고, 이후 Codex CLI, Gemini CLI, jcode 등으로 확장한다.
>   - 지원 등급(완전·부분·최소)을 두고, 관문은 에이전트와 무관하게 동일하게 적용한다.
>   - 조종 넘기기·리뷰는 에이전트 종류와 무관하므로 한 에픽 안에서 여러 에이전트를 섞어 쓸 수 있다.
> - **v0.9** (M0 로컬 검증 1~5 반영, 근거: [m0-results.md](m0-results.md))
>   - 에이전트 편집은 도구 페이로드가 아니라 **훅이 뜬 디스크 전후 스냅샷**으로 기록한다. 오프셋 단위와 해시 기준을 명시했다(§8.6).
>   - 체크포인트·셸 스냅샷은 **디스크 바이트 그대로** 저장한다(줄바꿈 변환·`.gitattributes` 끔). 복원 절차와 CAS를 명시했다(§8.1).
>   - transcript는 **허용 목록 필터**를 거쳐서만 중계·저장한다(개인 정보 보호, §6.4, §8.3).
>   - 훅 연동의 확정 사항(입출력 필드, resume, 신뢰 확인 창, 환경변수, 훅 오류 처리)을 §6.1에 기록했다.
>   - 의견 전달 시점(다음 모델 턴), 대화 스트림 단위(블록), 메타 push 재시도 정책을 구체화했다.
> - **v0.10** (M0 검증 6~10 반영: `.mcp.json` 승인, VS Code 확장, 공식 Claude Code VS Code 확장, GitHub, Meet)
>   - `settings.local.json`에 MCP 서버 승인과 **도구 호출 권한을 둘 다** 넣는다(§6.1).
>   - 신뢰는 **진입점마다 다르다**: 터미널은 Claude Code 신뢰, VS Code는 VS Code 작업 영역 신뢰(§6.1, §9.1).
>   - 에디터 이벤트로 들어오는 **외부 변경을 구별**하는 규칙, IME 이벤트 묶음, 쓰레드 위치는 `thread.range`가 아니라 편집 기록으로 계산(§3.3, §7.4, §8.6).
>   - GitHub에서는 ref를 지워도 커밋이 남는다: 체크포인트에서 비밀 파일 제외(§2.1, §8.1). 메타 브랜치 반영 지연을 명시(§3.7).
>   - Meet 회의록·전사는 한 문서의 두 탭, 전사는 `transcripts.entries` 사용(§10.1).
>   - (2026-10-02, M0 12 반영) 회의록 대기: 1분 폴링, 보통 수 분, 30분 타임아웃(§10.1). M0 완료 표시(§14).
> - **v0.11** (M1 구현 중 발견한 문제 반영, 근거: [m1-plan.md](m1-plan.md) T1~T8)
>   - 외부 변경은 **편집 기록 재적용 결과 ≠ 디스크**로 판단한다. 셸·다른 에디터 등 경로와 상관없이 잡힌다(§7.4).
>   - 문단 ID 훼손은 파일 원복이 아니라 **ID만 복원**한다. 줄 단위 대응, 제자리 수정 처리, 통째 삭제는 복원하지 않음(§3.2, §6.2).
>   - 쓰레드 ID를 `t-<ULID 뒤 8자>`로 바꿨다. 앞 8자는 시각이라 1초 안에 만든 쓰레드끼리 겹쳤다(§3.1).
>   - 문단 ID 단위에 **최상위 목록 항목**을 넣었다. "불명확한 점" 항목마다 쓰레드를 단다(§3.2).
>   - 메타 브랜치는 worktree 없이 git 저수준 명령으로 추가한다. `_meta` worktree를 없앴다(§1, §2.4, §3.1).
>   - Flightdeck 자신의 렌더링(문단 ID, 쓰레드 블록)도 편집 기록에 남긴다. 출처 `flightdeck`(§8.6).
>   - 체크포인트: 복원과 비밀 파일 패턴, racy git 대응(임시 index 수정 시각 보존)(§8.1).
>   - resume은 같은 실행을 잇고 `run.finished`는 여러 번 올 수 있다(§6.1).
>   - (2026-10-02, M0 11 반영) **급한 의견**: PreToolUse 거부로 같은 턴 안에서 전달, 같은 메시지는 1초 시간 간격으로 판정(§8.4). **훅 실패 시 기본 동작**을 경로별로 정함: 차단은 fail-closed, 기록은 fail-open(§6.1). 도구 실행·transcript 기록 시점을 §6.1에 기록.
> - **v0.12** (M2 계획 검토 반영, 근거: [m2-plan.md](m2-plan.md) U1~U7)
>   - **서명은 단계 통과에만.** 파이프라인에 정의된 단계 통과 이벤트(에픽 시작, 단계 완료, 티어 승인, 테스트 보고, 반영 결과)는 확장이 서버에 요청하고 **서버가 검증한 뒤 서버 키로 서명**해 기록한다. 쓰레드·답글 등 일반 이벤트는 서명하지 않는다. 멤버 개인 키를 없앴다(§3.1, §4.2, §12).
>   - **설정 레포를 없앴다.** 파이프라인·룰·멤버는 서버 DB에 두고 **서버 어드민 화면**에서 관리한다. 모든 사용자는 서버에 등록된 사람이고, **Google 계정으로 로그인**한다(§2.5, §11.2, §12).
>   - 질문 대상이 문서를 볼 수 있게 쓰레드를 만들 때 산출물을 에픽 브랜치에 커밋해 push한다(§3.1, §2.4).
>   - 메타 브랜치도 force push·삭제를 막고, 확장은 이력 재작성을 감지한다(§2.1).
>   - 일감 멘션은 새 질문과 리뷰 차례에만 남긴다(§3.7).
>   - **내장 git 서버를 기본**으로 하고, 외부 git 미러·외부 git 단독 방식도 지원한다. 내장 방식은 ref 규칙을 서버가 강제한다(D21, §1.5, M5.5).
>   - (2026-10-04, M2 완료 확인 반영 V1) 한 PC 안의 편집 기록 쓰기는 **직렬화**하고, 재적용 중 `base_hash`가 맞지 않는 기록은 건너뛰고 보고한다(§8.6). M2 완료 표시(§14).
> - **v0.13** (M3 계획 검토 반영, 근거: [m3-plan.md](m3-plan.md) W1~W8)
>   - 티어 리뷰는 서버 서명 이벤트 **`review.requested`**로 시작하고, 마지막 티어 승인으로 다음 단계에 자동으로 넘어간다(§3.1, §4.1, §4.2).
>   - 재승인 기준인 "현재 산출물"은 **마지막 리뷰 요청의 해시**다. 고치면 다시 요청하고, 해시가 다른 승인은 무효다(§4.2).
>   - **티어는 일감의 검증 단계**이고 티어마다 심사 담당자가 있다. 담당자가 없는 티어는 건너뛴다. 건너뛰기는 판단이 아니라 설정이다. `skip` 규칙(태그·크기)을 없앴다(§4.2, §5).
>   - 담당자가 어떤 티어의 **유일한** 리뷰어면 그 티어까지는 스스로 승인할 수 있다(§4.2).
>   - 리뷰어 직접 수정(`review.edited`)을 없애고 **조종수에게 수정 제안**으로 통일했다(§3.4, §4.2, §9.3).
>   - 리뷰어 본인이 연 쓰레드가 열려 있으면 그 리뷰어의 승인은 거부한다(§4.2).
>   - 리뷰어 창에도 에이전트 설정을 넣는다(리뷰 정책). 에이전트가 문서에 **쓰레드 초안 블록**을 쓰면, 사람이 확인해 올린다(§3.2, §3.6, §6.2).
> - **v0.14** (M4 구현·완료 확인 반영, 근거: [m4-plan.md](m4-plan.md) X1~X12)
>   - impl-log는 **`flightdeck_log_step`으로만** 쓴다. 체크포인트를 먼저 만들고 Step을 기록한다. 편집이 속하는 Step = 마지막 기록 Step + 1(§6.2, §7.1, §7.3).
>   - coverage는 로컬 편집 기록으로 계산하고, 외부 변경은 체크포인트·제출 때 잡는다. 서버의 재계산은 편집 기록 서버(M7) 이후. 메모 범위는 고친 줄로 좁힌다(§7.3, §7.4).
>   - 테스트 결과 보고(`gate.reported`)를 M4로 당겼다. `phase.completed(IMPLEMENTATION)`에 검사한 커밋을 적고, 같은 커밋의 통과 보고가 있어야 한다(§3.1, §4.1, §7.5).
>   - 복원도 편집 기록에 남기고 출처를 되살린다. 복원은 제품 코드만 되돌린다(§8.1, §8.6).
>   - 훅은 ref를 백그라운드로 올리고, 세션 원본은 턴마다 저장한다. 비밀값은 이름이 비밀 같은 환경변수·토큰 패턴·`.env` 값만 가린다(§6.4, §8.1). 실패한 도구 호출 훅(`PostToolUseFailure`)도 등록한다(§6.1).
> - **v0.15** (M5 구현·완료 확인 반영, 근거: [m5-plan.md](m5-plan.md) Y1~Y9)
>   - 검증 리뷰도 서버 서명 `review.requested`로 시작한다. **같은 커밋의 통과 테스트 보고**가 있어야 요청할 수 있다. 구현 완료 직후 첫 요청을 내고, 수정 제안을 반영한 뒤의 "다시 요청"은 관문 검사 → 커밋 → 테스트 → 보고 → 요청 순서다(§4.1, §4.2).
>   - 검증 리뷰어의 창 자체가 **쓰기 가능한 리뷰 사본**이다. 수정 제안은 사본의 diff를 `change_request` 쓰레드(만들 때 또는 답글)에 패치로 붙인다. 반영은 패치 적용이고 편집 출처는 `patch`다(§2.4, §3.1, §9.3).
>   - 코드 쓰레드 위치는 M7 전까지 리뷰 커밋 기준 **diff 줄 매핑**으로 계산한다(§3.3, §3.5).
>   - 반영 작업은 **서버가 마지막 승인에 서명할 때 바로 건다.** `land.requested`를 없앴다(§11.1).
>   - main이 움직였으면 rebase 대신 **main을 에픽 브랜치에 병합한 커밋**을 서버가 올린다. 담당자 확장이 자동으로 테스트를 다시 보고하면 서버가 다시 반영한다(§11.3).
>   - squash에는 `keep` 목록의 기록만 남기고, 코드 쓰레드 기록은 서버가 만든다. main 감사는 가장 오래된 에픽의 base부터 보고, 예외 목록을 둔다(§5, §11.3, §11.4).
> - **v0.16** (M5.5 시나리오에서 찾은 문제, 근거: [m5.5-plan.md](m5.5-plan.md) Z9. Z1~Z8은 결정 대기)
>   - `epic.started`에 **설정 내용 해시**를 서명한다. 같은 버전 ID에 다른 내용이면 "설정 불일치"로 표시하고 판정하지 않는다(§2.5, §3.1).

---

## 0. 확정된 결정 사항

| # | 항목 | 결정 |
|---|---|---|
| D1 | 실시간 세션 | **Google Meet + Gemini 회의록**. 세션 종료 후 회의록을 가져와 해당 쓰레드에 댓글로 기록 |
| D2 | 쓰레드 위치 | 분석/설계 문서는 **문서 안 인라인 블록**, 코드는 **별도 저장(sidecar)** |
| D3 | 레포 구조 | MVP는 **단일 모듈(단일 레포)** |
| D4 | IDE | **VS Code 먼저** |
| D5 | 에이전트 산출물 | 형식·권한 **강제** |
| D6 | 리뷰어 환경 | 모든 참여자 **IDE 사용 필수** |
| D7 | diff 대조 | 구현 기록과 실제 diff를 대조해 **설명 없는 변경 차단** |
| D8 | 서버 | **flightdeck-server** 하나. 모듈: ① 설정 배포 ② 반영(main push) ③ 편집 기록 ④ 실시간 중계. 쓰레드·승인·알림은 지금처럼 git(메타 브랜치)과 확장이 처리. 서버 장애 시 반영·관찰만 멈추고 조종수의 작업은 계속됨(편집 기록은 로컬에 쌓았다가 재전송). 이 문서의 "반영 서버"는 ②번 모듈을 가리킴 |
| D9 | 에이전트 실행 | 1차 대상은 각자 **개인 Claude 구독으로 로그인한 Claude Code** (다른 에이전트는 D20). 조종수는 **대화형 Claude Code를 직접** 쓰고, headless(`claude -p`)는 자동 초안에만 사용 (§6.1) |
| D10 | 일감 관리 도구 | **TrackerAdapter**로 추상화. 1차 ClickUp. 모든 호출은 행위자 본인의 개인 토큰으로 |
| D11 | 머지 후 정리 | 메타 이벤트·체크포인트·세션 원본은 정리. main에는 사람이 읽는 기록만 남김 |
| D12 | git의 역할 | **저장소로만 사용**. 사용자는 git을 직접 다루지 않으며, 모든 git 명령은 확장이 실행. git 호스트는 push/fetch 대상일 뿐(내장 git 서버·GitHub·GitLab·Gitea 무관, D21) |
| D13 | 승인·반영 | **PR 없음**. 승인은 확장에서 누르고, 서버가 파이프라인 기준으로 검증해 **서버 키로 서명한 이벤트**를 메타 브랜치에 남긴다. 마지막 검증 티어가 승인하면 **반영 서버가 검증 후 main에 push**. main push 권한은 서버 봇 계정만 가짐 |
| D14 | 실행 맥락 공유 | 세션 원본을 통째로 넘기지 않음. **결과물 + 인수인계 기록**을 기본으로 하고, 원본은 **필요할 때 검색해 일부만** 사용 (토큰 절감) |
| D15 | 설정 관리 | pipeline.yaml·rules·멤버는 **서버 DB**에 두고 **서버 어드민 화면**에서 관리한다. 모든 사용자는 서버에 등록돼 있고 Google 계정으로 로그인한다. 서버가 설정을 서명해 배포한다. 에픽은 시작할 때 설정 버전을 고정 |
| D16 | 테스트 검증 | **A안**: 서버는 서명·티어·해시·diff 대조·형식만 다시 검증하고, lint/test는 실행자가 보고한 결과(서버가 받아 서명)를 신뢰. 서버 재실행(B안)은 이후 추가 |
| D17 | 협업 방식 | **조종수 1명 + 실시간 관찰자**. 동시 편집 없음. 관찰자는 대화·편집을 실시간으로 보고 **조종수에게** 의견을 낸다. 에이전트에 전달할지는 조종수가 정한다. 조종은 요청·수락으로 넘긴다 (§8) |
| D18 | 편집 출처 | 확장이 잡은 모든 편집(에디터·에이전트·셸 결과·외부 반영)을 **편집 기록**으로 서버에 저장. 쓰는 사람이 한 명이라 기록이 하나의 순서열이 되어, 충돌 해결 없이 위치 고정과 출처 조회가 정확함 (§8.6) |
| D19 | Claude Code 연동 방식 | **대화 UI를 다시 만들지 않는다.** Claude Code의 공식 확장 지점(SessionStart·UserPromptSubmit·PreToolUse·PostToolUse·Stop 훅, MCP 서버)에만 붙는다. Claude Code 기능과 업데이트는 그대로 따라감. Zed(ACP) 등 다른 에디터에서도 같은 연동이 동작 |
| D20 | 에이전트 확장 | 에이전트별 차이는 **AgentAdapter** 안에 가둔다(§6.5). 1차 Claude Code, 이후 Codex CLI → Gemini CLI → jcode 등. 지원 등급(완전·부분·최소)에 따라 기능이 달라지지만 **관문은 동일**. 한 에픽 안에서 에이전트를 섞어 쓸 수 있음 |
| D21 | git 호스트 방식 | **내장 git 서버를 기본**으로 한다. flightdeck-server가 git 저장소를 직접 제공하고 ref 규칙을 서버에서 강제한다. CI/CD 연계가 필요하면 main(과 태그)을 외부 git에 **미러**한다. GitHub·GitLab 등 **외부 git만 쓰는 방식**도 지원한다. 이때는 보호 규칙을 호스트 설정에 맡기고 확장이 이력 재작성을 감지한다 (§1.5) |

---

## 1. 전체 구조

```
┌──────────────────────────── 각 참여자 PC ─────────────────────────────┐
│ VS Code + flightdeck-vscode 확장                                       │
│  에이전트 CLI (Claude Code·Codex·Gemini…) ◄─ hooks · MCP ┐              │
│        (AgentAdapter가 도구별 차이 흡수)                   │              │
│  Flightdeck 패널: Phase · Comments · 관찰 뷰 · 의견 · 메모 ┘               │
│                          │                                           │
│              Flightdeck Client Core (packages/core)                    │
│  상태 계산(reducer) · 서버 서명 검증 · 쓰레드 렌더/파싱 · 위치 추적 · coverage │
│                          │                                           │
│              Git Engine (확장 내부 전용, 사용자 노출 없음)               │
│   worktree: 에픽 / 리뷰 / 관찰(읽기 전용)                               │
└──────┬──────────────────────────────┬────────────────┬───────────────┘
       │ git fetch/push                │ REST           │ REST
       │ (main 제외)                    │                │
┌──────▼───────────────────┐  ┌───────▼──────┐  ┌──────▼────────────────┐
│ Git 원격 (기본: 서버 내장)  │  │ 일감 도구      │  │ Google Workspace      │
│  main  ◄── 서버만 push     │  │ (ClickUp →    │  │  Meet API · Docs API  │
│  flightdeck/<epic>         │  │  Jira 등)     │  └───────────────────────┘
│  flightdeck-meta           │  └──────────────┘
│  refs/flightdeck/*         │
└──────▲───────────────────┘
       │ fetch / main·meta push (봇 자격 증명)
┌──────┴───────────────────────────────────────┐
│ flightdeck-server                              │◄── 확장: REST + WebSocket (Google 로그인)
│  ① 설정·서명: 어드민 화면(파이프라인·멤버),      │◄── 관리자: 어드민 웹
│     설정 배포, 단계 통과 이벤트 검증·서명         │
│  ② 반영: 검증 → squash → main push             │
│  ③ 편집 기록: 편집 순서열 저장, 출처·위치 조회     │
│  ④ 실시간 중계: 조종수 → 관찰자 (대화·편집 스트림), │
│     관찰자 → 조종수 (의견), 조종 넘기기            │
│  PostgreSQL (설정·멤버·편집 기록·세션 상태)       │
└──────────────────────────────────────────────┘
```

### 1.1 진실의 원천(Source of Truth)

| 데이터 | 원천 | 비고 |
|---|---|---|
| 문서 본문, 코드, impl-log | 에픽 브랜치 `flightdeck/<epic-id>` | 확장이 커밋 |
| 쓰레드·댓글·승인·단계 전환 | 메타 브랜치 `flightdeck-meta` | 이벤트 파일, append-only. 단계 통과 이벤트는 **서버 서명** (§3.1, §12) |
| 진행 중 작업 상태 | 체크포인트 ref `refs/flightdeck/ckpt/…` | §8.1 |
| 편집 기록 (출처 포함) | **flightdeck-server ③** | §8.6. git 체크포인트는 편집 기록 위치(seq)를 참조 |
| 조종 상태·관찰 세션 | **flightdeck-server ④** | §8.2. 조종 넘기기 결과는 메타 이벤트로도 남김 |
| 에이전트 세션 원본 | 실행 ref `refs/flightdeck/runs/<epic-id>` | §6.4 |
| 회의 요약 | Google Docs (Gemini 회의록) | 가져와서 메타 이벤트로 변환 |
| 파이프라인·룰·멤버 | **서버 DB** (어드민 화면에서 관리) | 서버가 서명해 배포 (§2.5) |
| 완료된 결과 | `main` | **반영 서버만 push** (§11) |

- 현재 상태는 모든 확장이 **같은 reducer(`packages/core`)**로 계산한다. 입력은 메타 이벤트와 에픽 브랜치다.
- 권한이 없는 이벤트, 그리고 서버 서명이 필요한데 서명이 없거나 틀린 이벤트는 reducer가 무시한다(§12).

### 1.2 Git 사용 원칙

- 사용자는 브랜치, 커밋, push, 병합을 **보지도 다루지도 않는다.** 확장의 `GitEngine`만 git을 호출한다.
- 사용자에게 보이는 개념은 **에픽, 단계, 쓰레드, 승인, 체크포인트**뿐이다.
- 사용자 편집 저장: 사람이 worktree에서 편집하면 확장이 체크포인트로 자동 저장한다(§8.1). 단계 전환이나 제출 때는 에픽 브랜치에 커밋한다.
- 충돌 처리
  - 쓰레드 블록 영역은 렌더링 결과라 충돌이 생기지 않는다.
  - 문서 본문이 충돌하면 확장의 병합 화면에서 "내 것 / 상대 것 / 직접 수정"으로 고른다. git 용어는 노출하지 않는다.
- 원격 인증
  - 내장 git 서버: 확장이 git credential helper를 제공하고, 서버 로그인 세션으로 인증한다(§1.5).
  - 외부 git: 사용자 PC의 기존 git 자격 증명(SSH 키, credential helper)을 쓴다. 호스트 API는 쓰지 않는다.
  - 개발자 계정에는 **main push 권한이 없다.** 내장 git 서버는 서버가 거부하고, 외부 git은 호스트에서 main 보호 설정을 한 번 해 두고 서버 봇 계정만 허용한다. PR 기능이 아니라 브랜치 쓰기 권한만 설정한다.

### 1.3 저장 인터페이스

```ts
interface EventStore {
  append(event: SignedEvent): Promise<void>;       // 메타 브랜치에 파일 추가 + push
  list(epicId: string): Promise<SignedEvent[]>;
  watch(onChange: () => void): Disposable;         // ls-remote 폴링
}
```

- `append`는 작업 폴더 없이 git 저수준 명령으로 커밋한다: blob 작성 → 임시 index에 이벤트 파일 추가 → `write-tree` → `commit-tree` → `update-ref`(CAS). CAS가 실패하면 새 끝 위에 다시 만든다. 이벤트 추가는 파일 하나를 더하는 일이라 작업 폴더가 필요 없고, 동시 추가도 CAS로 처리된다(M1: 동시 20건 유실·병합 커밋 0).
- `append`는 쓰기 전에 그 이벤트를 넣은 reducer 결과를 미리 계산한다. reducer가 무시할 이벤트(권한·관문·ID 중복)는 쓰지 않고 이유를 사용자에게 알린다. 메타 브랜치는 append-only라 한번 쓰면 지울 수 없기 때문이다.
- 확장이 직접 `append`하는 것은 **일반 이벤트**뿐이다. 서버 서명이 필요한 이벤트(§12)는 확장이 서버 API로 요청하고, 서버가 검증·서명해 메타 브랜치에 push한다. 확장은 다음 fetch에서 받는다.

### 1.4 TrackerAdapter

```ts
interface TrackerAdapter {
  id: "clickup" | "jira" | string;
  listAssignedEpics(me: TrackerUser): Promise<TrackerEpic[]>;
  getEpic(ref: string): Promise<TrackerEpic>;
  setPhase(ref: string, phase: Phase): Promise<void>;
  setFields(ref: string, f: Record<string, string>): Promise<void>;
  notifyMention(ref: string, to: TrackerUser[], text: string, link: string): Promise<void>;
  me(): Promise<TrackerUser>;
}
```

- 토큰은 각자의 개인 토큰이다. VS Code `SecretStorage`에 보관한다.
- 단계 전환을 일으킨 사람의 확장이 `setPhase`를 호출한다.
- 누락 대비 **조정(reconcile)**: 에픽을 열고 있는 확장이 "reducer 단계 ≠ 일감 상태"이면 상태를 맞춘다. 여러 번 실행돼도 결과가 같다.
- **알림 경로**: VS Code가 꺼져 있을 때는 리뷰 차례와 쓰레드 멘션을 모두 이 어댑터의 `notifyMention`(일감 댓글 @멘션)으로 받는다.

### 1.5 git 호스트 (D21)

확장은 git을 push·fetch 대상으로만 쓰므로(D12) 호스트가 바뀌어도 확장의 git 사용은 같다. 다른 것은 **ref 보호 규칙을 누가 강제하느냐**다.

| 방식 | 내용 | 보호 규칙 |
|---|---|---|
| **내장** (기본) | flightdeck-server가 git smart HTTP(`git http-backend`)로 레포를 제공한다. 인증은 서버 로그인 세션이고, 확장이 git credential helper를 제공한다 | 서버의 `pre-receive` 훅이 강제한다(아래 표) |
| **내장 + 외부 미러** | 내장을 원본으로 두고, 서버가 main(과 태그)만 외부 git(GitHub 등)에 미러 push한다. CI/CD는 미러의 main을 본다 | 내장과 같다. 미러 대상은 서버 봇 외에는 쓰기 금지로 둔다 |
| **외부** | GitHub·GitLab·Gitea 등을 원격으로 쓴다 | 호스트의 브랜치 보호 설정(main: 봇만, `flightdeck-meta`: force push·삭제 금지)에 맡긴다. 호스트가 강제하지 못하는 규칙은 확장·서버가 **감지**해 관리자에게 경고한다(§2.1, §11.4) |

내장 git 서버의 `pre-receive` 규칙:

| ref | 허용 |
|---|---|
| `main` | 서버(반영 모듈)만 |
| `flightdeck-meta` | fast-forward만. 새 커밋은 `epics/<epic>/events/`에 **파일 추가만** 한다(수정·삭제 거부). 일반 이벤트의 `author`와 파일 이름의 멤버가 push한 멤버와 같아야 한다. 서버 서명 이벤트는 서버만 추가한다 |
| `flightdeck/<epic>` | 그 에픽의 담당자·현재 조종수(fast-forward만), 서버(main 병합 커밋, 반영 후 삭제) |
| `refs/flightdeck/ckpt/<epic>/<member>` | 그 멤버만 |
| `refs/flightdeck/runs/<epic>` | 그 에픽의 실행자, 서버(정리) |
| 그 밖의 ref | 거부 |

- 내장 방식에서는 일반 이벤트도 사실상 위조할 수 없다. 서명은 없지만 push한 사람과 작성자가 같은지 서버가 확인하기 때문이다.
- 레포 데이터는 서버 디스크에 있다. 백업은 서버 운영에 포함한다(§11.5). 서버가 죽으면 push·fetch가 멈추지만 조종수의 로컬 작업은 계속되고, 복구 후 밀린 이벤트를 보낸다(§3.1 재시도와 같은 경로).
- 코드 브라우징 웹 화면은 제공하지 않는다. 필요하면 외부 미러에서 본다.

---

## 2. 저장 구조

### 2.1 ref 구성

| ref | 내용 | 수명 |
|---|---|---|
| `main` | 완료된 결과. **서버만 push** | 영구 |
| `flightdeck/<epic-id>` | 에픽 작업 브랜치 | main 반영 후 삭제 |
| `flightdeck-meta` | 이벤트, 멤버 공개키, 회의 포커스 | 영구 (머지된 에픽 디렉터리는 정리) |
| `refs/flightdeck/ckpt/<epic-id>/<member>` | 멤버별 체크포인트 체인 | main 반영 후 `retention.ckpt_days`(기본 14일) 뒤 삭제 |
| `refs/flightdeck/runs/<epic-id>` | 에이전트 세션 원본 (압축) | main 반영 후 `retention.runs_days`(기본 30일) 뒤 삭제 |

- 체크포인트와 세션 원본은 크기가 크다. 그래서 **별도 ref**에 둔다. ref를 지우면 결국 원격 저장소에서 공간이 회수된다(gc). 회수 시점은 호스트가 정한다.
  - **GitHub에서는 ref를 지워도 커밋이 바로 사라지지 않는다.** 삭제 직후에도 SHA를 알면 레포 읽기 권한자가 fetch할 수 있다(M0 확인). 따라서 체크포인트·세션 원본에 한 번 들어간 비밀값은 ref 삭제로 지울 수 없다. 저장 전에 걸러야 한다(§6.4 비밀값 제거, §8.1 비밀 파일 제외).
- `refs/flightdeck/*`는 브랜치가 아니므로 브랜치 목록·브랜치 보호 규칙·Actions 트리거에 나타나지 않는다(GitHub 확인).
- **메타 브랜치 보호**: append-only는 약속만으로는 지켜지지 않는다. 쓰기 권한이 있으면 force push나 브랜치 삭제로 질문·승인 이벤트를 없앨 수 있다. 내장 git 서버는 이를 서버에서 거부한다(§1.5). 외부 git은 호스트에서 `flightdeck-meta`도 **force push·삭제 금지**로 설정한다(main 보호와 함께 처음에 한 번). 어느 방식이든 확장은 fetch한 메타 브랜치가 이전에 본 끝을 포함하지 않으면(이력 재작성) 받아들이지 않고 관리자에게 경고한다.
- fetch 설정(refspec)은 확장이 관리한다. `refs/flightdeck/*`는 기본 clone/fetch로 받아지지 않으므로 필요한 refspec(예: `+refs/flightdeck/ckpt/<epic-id>/*:refs/flightdeck/ckpt/<epic-id>/*`)을 명시해 fetch한다.

### 2.2 에픽 브랜치

```
<repo>/
└── .flightdeck/
    ├── .runtime/                   # 확장이 생성, git 제외 (설정 캐시, 에이전트 실행 설정)
    └── epics/<epic-id>/
        ├── epic.md                 # 일감 스냅샷 (읽기 전용)
        ├── state.json              # 단계 전환 시 스냅샷
        ├── analysis.md             # 분석 + 인라인 쓰레드
        ├── design.md               # 설계 + 인라인 쓰레드
        ├── impl-log.md             # 구현 기록 (형식 강제)
        ├── trace.jsonl             # 에이전트 도구 호출 자동 수집
        ├── runs/<run-id>/handoff.md  # 실행 인수인계 기록 (§6.4)
        ├── threads/code.json       # 코드 쓰레드 스냅샷
        └── sessions/<sid>.md       # 회의 요약 스냅샷
```

### 2.3 메타 브랜치

```
flightdeck-meta/
└── epics/<epic-id>/
    ├── events/<ULID>-<member>.json    # 파일 1개 = 이벤트 1개 (단계 통과 이벤트는 서버 서명)
    └── sessions/<sid>/focus-<member>.jsonl
```

### 2.4 로컬 worktree (확장이 관리, 사용자는 "창"으로만 인식)

| 경로 | 용도 |
|---|---|
| `../<repo>.flightdeck/<epic-id>` | 에픽 작업 폴더 (담당자). 질문 받은 사람과 설계 리뷰어는 에픽 브랜치를 **읽기 전용**으로 연다. 검증 리뷰어에게는 같은 경로가 리뷰 요청 커밋의 **쓰기 가능한 리뷰 사본**이다(§9.3). 쓰레드 블록 렌더링과 리뷰 사본의 편집은 편집 기록에 남기지 않는다 |
| `../<repo>.flightdeck/<epic-id>@live` | 관찰자용 읽기 전용 창. 조종수의 편집 스트림이 실시간 적용됨 (§8.3) |
| `../<repo>.flightdeck/<epic-id>#ask` | 조종수의 개인 질문용 읽기 전용 사본. 현재 체크포인트 기준 (§3.6) |

### 2.5 설정: 서버 DB + 어드민 화면

```
flightdeck-server DB
├── members      # 멤버 ID, Google 계정 이메일, 그룹, 일감 도구 사용자 ID, 활성 여부, 어드민 여부
└── products/<product>
    ├── config_versions[]           # 설정 버전마다 변경 불가 스냅샷
    │   ├── pipeline.yaml           # §5
    │   └── rules/{common,analysis,design,implementation,verification}.md
    └── current                     # 새 에픽이 쓰는 버전
```

- 관리자는 서버의 **어드민 화면**(웹)에서 멤버를 등록하고 파이프라인·룰을 고친다. 저장할 때마다 새 설정 버전이 생기고, 누가 언제 무엇을 바꿨는지가 감사 기록으로 남는다.
- **모든 사용자는 서버에 등록된 멤버다.** 확장은 Google 계정으로 서버에 로그인하고, 등록된 이메일이면 그 멤버가 된다(§12). 등록되지 않았거나 비활성인 계정은 쓸 수 없다.
- **설정 버전** = 서버가 저장 시 부여한 버전 ID. 한 번 만든 버전은 바뀌지 않는다.
- **배포**
  - 확장이 `GET /config?product=<p>`로 설정을 받는다. 응답은 `{version, pipeline, rules, members}`이고 서버 서명이 붙는다.
  - 받은 설정을 `.flightdeck/.runtime/config/<version>/`에 캐시한다.
  - 서버가 죽어 있으면 캐시를 쓴다. 쓰레드·답글은 계속할 수 있지만, 서버 서명이 필요한 일(새 에픽 시작, 단계 완료, 승인, 반영)은 할 수 없다.
  - 개발용으로 로컬 설정 폴더(`flightdeck.configDir`)를 쓰는 모드는 **개발 모드에서만** 켤 수 있다. 이 모드의 에픽은 서버 서명이 없어 서버 검증을 통과하지 못한다.
- **버전 고정**
  - `epic.started`에 `config_version`을 기록한다. reducer와 서버는 그 에픽을 **고정된 버전의 파이프라인**으로 판정한다.
  - **설정 내용 해시**: 버전 ID는 서버 DB 안에서만 유일하다(DB 교체·이전, 백업 일부 복원 때 같은 ID가 다른 내용을 가리킬 수 있다). 그래서 `epic.started`에 `config_hash`(pipeline.yaml과 룰 전체의 정규화 JSON sha256)도 서명한다.
    - 서버·확장은 받은 설정의 해시를 비교한다. 다르면 그 에픽을 **설정 불일치**로 표시하고, 이후 서버 서명 이벤트를 판정하지 않는다. 다른 규칙으로 조용히 계산하지 않는다. 서버는 서명·반영을 거부하고, 확장은 상태 바에 표시하며, main 감사는 우회와 구별해 알린다.
    - 확장은 받은 설정·캐시·서버 가운데 해시가 맞는 것을 쓴다.
    - 복구는 관리자가 원래 설정을 같은 내용으로 다시 넣는 것이다. 해시가 맞으면 그대로 이어진다.
    - 해시가 없던 때 시작한 에픽은 버전 ID만으로 판정한다.
  - 진행 중 에픽에 새 설정을 적용하려면 담당자가 "설정 업그레이드"를 해야 한다. `epic.config_upgraded` 이벤트(서버 서명)가 남고, 이미 받은 승인은 새 규칙으로 다시 판정한다.
- 에픽 브랜치에서 설정을 고칠 수 없다. 레포 안에 설정 파일이 없고, 에이전트의 `.flightdeck/.runtime/` 쓰기도 차단한다.
- 멤버 정보는 설정 버전과 별도로 **현재 값**을 쓴다. 멤버를 비활성으로 바꾸면 그 뒤로 서버가 그 멤버의 요청을 받지 않는다. 이미 서명된 이벤트는 그대로 유효하다.

---

## 3. 쓰레드

### 3.1 이벤트

```json
{
  "v": 1,
  "id": "01JB3K9PZQ8W5R2N7T4M6X1C0D",
  "type": "thread.replied",
  "epic": "CU-86abc123",
  "author": "park",
  "at": "2026-10-01T11:03:00+09:00",
  "data": { "thread": "t-01JB2X4K", "body": "30분, 슬라이딩 갱신입니다.", "source": "human" }
}
```

| 이벤트 타입 | data | 서버 서명 |
|---|---|---|
| `epic.started` | tracker_ref, owner, base_sha, config_version, config_hash(설정 내용 해시, §2.5) | ✅ |
| `epic.config_upgraded` | from_version, to_version | ✅ |
| `thread.created` | thread, phase, file, anchor(§3.3, §3.5), kind, to[], body, commit?(문서 공유 커밋), source?(`human`\|`agent`, 쓰레드 초안 §3.2), patch?(수정 제안, `change_request`만, §9.3) | |
| `thread.replied` | thread, body, source(`human`\|`agent`\|`session`), patch?(수정 제안, §9.3) | |
| `thread.resolved` / `thread.reopened` | thread | |
| `thread.moved` | thread, anchor | |
| `patch.applied` | thread, commit(패치를 만든 리뷰 커밋). 담당자만 | |
| `phase.completed` | phase, artifact_hash, commit?(IMPLEMENTATION: 검사한 에픽 브랜치 커밋. 같은 커밋의 통과 `gate.reported`가 있어야 한다) (담당자의 "분석 완료", "구현 완료") | ✅ |
| `review.requested` | phase, artifact_hash, commit (담당자의 리뷰 요청, §4.2. VERIFICATION은 `artifact_hash`=`tree:<tree>`, 같은 커밋의 통과 `gate.reported`가 있어야 한다) | ✅ |
| `review.approved` | phase, tier, artifact_hash (§4.2) | ✅ |
| `phase.reverted` | from, to, reason (DESIGN→ANALYSIS, VERIFICATION→IMPLEMENTATION, §4.3) | |
| `run.started` / `run.finished` | run_id, phase, member, ckpt_from, ckpt_to | |
| `gate.reported` | commit, commands[{cmd, exit, summary, log_hash}] (§7.5). IMPLEMENTATION·VERIFICATION·LANDING(재보고)에서 | ✅ |
| `pilot.changed` | from, to, reason(`handoff`\|`request`\|`takeover`), ckpt, handoff_run (§8.5) | |
| `epic.landed` | main_commit, approvals[] | ✅ |
| `land.rejected` | reason(`needs_report`\|`conflict`\|`invalid`), rebased_sha?(needs_report: 서버가 올린 병합 커밋), details? (§11.3) | ✅ |
| `session.started` / `session.ended` / `session.published` | sid, … | |

- **서버 서명 이벤트**는 단계를 넘기는 효력이 있는 이벤트다(§12). 확장이 서버에 요청하면 서버가 요청자(로그인한 멤버)·파이프라인·현재 상태를 검증하고, `author`에 요청자를 적어 서버 키로 서명한 뒤 메타 브랜치에 push한다. 서명 대상은 `sig`를 뺀 이벤트의 **정규화 JSON**(RFC 8785 JCS: 키 정렬, 공백 없음, UTF-8)이고, `sig`는 `ed25519:<base64>`다.
- **일반 이벤트**는 서명하지 않는다. `author`는 확장이 로그인한 멤버 ID로 채운다. 저장소 쓰기 권한이 있으면 위조할 수 있지만, 일반 이벤트로는 단계를 넘길 수 없다.
- `thread.created`의 `commit`: 쓰레드를 만들 때 담당자의 확장이 산출물을 에픽 브랜치에 커밋해 push하고 그 커밋을 적는다. 질문 대상은 이 커밋으로 질문이 달린 문서를 본다(§2.4). 담당자가 이후 고친 내용은 다음 공유 커밋(쓰레드 생성, 단계 완료) 때 보인다.

- 파일 이름은 `<ULID>-<member>.json`이다. 내용 충돌이 없다. push가 거절되면 `fetch → rebase → push`를 자동으로 재시도한다.
  - 거절 사유(non-fast-forward, `cannot lock ref` 등)와 무관하게 같은 경로로 재시도한다. 지수 백오프에 지터를 둔다.
  - 재시도 상한에 걸려도 이벤트를 버리지 않는다. 로컬 커밋으로 남겨 두고 다음 주기에 다시 보낸다(append-only라 안전).
  - 대기 중인 이벤트는 한 번의 push로 묶어 보낸다.
  - M0 확인: 클라이언트 10개가 동시에 연속 push해도 유실·rebase 충돌 0, 선형 이력. 경합이 심하면 한 이벤트가 수십 번 밀릴 수 있다.
- 쓰레드 ID는 `t-<쓰레드를 만든 이벤트 ULID의 뒤 8자>`다. ULID 앞 10자는 시각이라, 앞 8자를 쓰면 1초 안에 만든 쓰레드끼리 겹친다(M1에서 실제로 겹침). 뒤 8자는 난수 40비트다.

### 3.2 문서 인라인 쓰레드

```markdown
<!-- p:7f3a -->
### 3.2 토큰 갱신
<!-- p:a91c -->
액세스 토큰은 Redis에 저장하고 만료 시 리프레시 토큰으로 갱신한다.

<!-- flightdeck:thread id=t-01JB2X4K status=resolved anchor=p:a91c -->
> **❓ @dh.lee → @park** · 2026-10-01 10:12
> TTL은 요구사항상 몇 분인가요?
>
> **💬 @park** · 2026-10-01 11:03
> 30분, 슬라이딩 갱신입니다.
>
> **🎙 회의 s-01JB5A 요약** · 2026-10-01 14:30 · [Gemini 회의록](https://docs.google.com/…)
> 리프레시 토큰 회전 적용하기로 결정.
<!-- /flightdeck:thread -->
```

- **문단 고정 ID** `<!-- p:xxxx -->`
  - 확장이 문서의 모든 블록 앞에 붙인다. 쓰레드 앵커는 이 ID를 가리킨다.
  - 블록 단위: 제목 한 줄, 문단(빈 줄로 나뉜 줄들), **최상위 목록 항목 하나**, 코드 블록. 들여쓴 하위 항목과 이어지는 줄은 상위 항목에 속한다. 목록 항목마다 ID를 붙여야 "불명확한 점" 항목별로 쓰레드를 달 수 있다(M1: 실제 초안의 불명확한 점 4개가 한 목록). 목록 항목 사이에 주석이 들어가 미리보기에서 목록이 나뉘어 보일 수 있다.
  - 에이전트와 사람은 ID를 지우거나 바꾸면 안 된다. 저장할 때 확장이 검사해 **ID만 복원**한다(§6.2). 같은 저장의 다른 수정은 그대로 둔다.
  - **복원 규칙** (M1 확인)
    - 기준은 마지막으로 확인된 내용(편집 기록 재적용 결과)이다. 줄 단위 diff로 이전 블록과 새 문서의 줄을 대응시킨다.
    - ID가 사라졌는데 그 블록의 줄이 하나라도 남았으면, 남은 첫 줄 앞에 원래 ID를 되살린다. ID 줄 내용만 지워 빈 줄이 남았으면 그 빈 줄을 ID 줄로 바꾼다.
    - ID와 블록 줄이 지워진 바로 그 자리에 새 줄이 들어왔으면(제자리 수정: ID를 지우고 문구도 고침), 들어온 블록 중 ID 없는 첫 블록에 원래 ID를 되살린다.
    - ID가 이전에 없던 ID로 바뀌었으면 원래 ID로 되돌린다. 문단을 ID째 복사해 붙여 중복이 생기면 원래 블록 쪽만 남기고, 붙인 쪽은 새 ID를 받는다.
    - 블록 줄이 하나도 남지 않고 그 자리에 들어온 내용도 없으면 블록을 통째로 지운 것이다. 복원하지 않는다. 그 ID의 쓰레드는 위치를 잃는다(§3.5).
    - 복원 시점: 에디터 저장은 **저장 직전**(`onWillSaveTextDocument`, 디스크 쓰기와 경쟁하지 않음), 에이전트·셸·외부 변경은 문서를 다시 그릴 때. 에이전트 파일 도구 편집은 훅이 즉시 되돌리고 사유를 에이전트에게 알린다.
  - 새 문단에는 확장이 저장 시 새 ID를 붙인다.
- 쓰레드 블록은 확장이 관리하는 렌더링 영역이다. 직접 수정해도 다시 렌더링하면 사라진다.
- **쓰레드 초안 블록**: 사람이 자기 에이전트에게 "이 문단에 질문 달아 줘", "그 쓰레드에 이렇게 답해 줘"라고 지시할 수 있도록, 에이전트(또는 사람)가 문서에 초안을 쓴다. 파일 편집만 할 수 있는 에이전트에서도 동작한다.

  ```markdown
  <!-- flightdeck:draft kind=question to=dh.lee -->
  재사용 탐지 시 모든 세션을 끊는 근거는 무엇인가요?
  <!-- /flightdeck:draft -->

  <!-- flightdeck:draft reply=t-01JB2X4K -->
  30분, 슬라이딩 갱신입니다.
  <!-- /flightdeck:draft -->
  ```

  - 새 쓰레드(`kind`=`question`\|`change_request`\|`note`, `to`=쉼표로 구분한 멤버)의 앵커는 초안 바로 위 블록의 문단 ID다. 답글은 `reply=<쓰레드 ID>`.
  - 확장은 저장·파일 변경 때 초안을 찾아 Comments에 **초안으로 표시**한다. 사람이 "올리기"(한 건씩 또는 모두)를 눌러야 이벤트가 된다. 메타 브랜치는 지울 수 없고 그 사람 이름으로 남기 때문이다. 올린 초안은 문서에서 지우고 쓰레드 블록으로 다시 그린다. 이벤트에는 `source: agent`를 남긴다.
  - 권한은 일반 쓰레드와 같다(§3.4). 권한 밖의 초안은 올리기 전에 이유를 보여 준다.

### 3.3 코드 쓰레드

- 앵커: `{type: code, file, rev(리뷰 요청 커밋), range, context(앞뒤 3줄), symbol?}`
- **M7 전까지의 위치 계산**: 편집 기록 기반 이동(§3.5)은 편집 기록 서버(M7)부터다. 그 전에는 리뷰어의 사본에서는 앵커 줄 그대로, 담당자 작업 폴더에서는 `rev → 작업 트리` diff(`git diff -U0`)로 줄을 옮긴다(§3.5 대체 수단 3번). 줄이 지워졌으면 가장 가까운 줄에 "위치 잃음"으로 표시한다.
- 리뷰 사본(§9.3)에서 만든 쓰레드에는 수정 제안 패치를 바로 붙일 수 있다(`thread.created.patch`).
- VS Code **Comments API**로 거터에 표시한다. markdown 문서(분석·설계)의 텍스트 에디터에서도 동작한다(M0 확인). markdown 미리보기 화면에는 표시되지 않는다.
- **쓰레드 위치의 기준은 편집 기록이다.** VS Code는 편집에 따라 쓰레드를 **화면에서는** 옮기지만, 확장이 읽는 `CommentThread.range` 값은 갱신하지 않는다(M0 확인). 그래서 앵커를 저장·전송할 때 `thread.range`를 읽지 않고 편집 기록으로 계산한 위치(§3.5)를 쓴다. 창을 다시 열 때는 그 위치로 쓰레드를 만든다.
- `kind`
  - `question`: 질문
  - `change_request`: 수정 요청
  - `note`: 참고

### 3.4 생명주기와 권한

| 동작 | 권한 |
|---|---|
| 생성 | 해당 단계 담당자 / 현재 티어 리뷰어 (리뷰 요청 이후) |
| 답글 | 쓰레드 참여자 + 멘션 대상 |
| resolve / reopen | 쓰레드 생성자 (분석 단계에서는 담당자) |
| 수정 제안 반영 | 조종수 (에픽 브랜치에 쓰는 사람은 조종수 한 명, D17) |

### 3.5 위치 고정 (편집 기록 기반)

쓰레드 앵커를 **편집 기록 위치**로 저장한다: `{file, seq, offset_start, offset_end}`. 여기서 `seq`는 그 파일의 편집 기록 순번이다(§8.6).
- 이후의 편집은 모두 하나의 순서열이므로, 앵커를 편집 순서대로 이동시키면 **추측 없이 현재 위치**가 나온다.
- Delta의 "편집 단위 고정"과 같은 원리다.
- 쓰는 사람이 한 명이라 동시 편집 변환(OT/CRDT)도 필요 없다.

편집 기록으로 따라갈 수 없는 경우에만 아래 대체 수단을 순서대로 쓴다.

| 순서 | 방법 | 쓰이는 경우 |
|---|---|---|
| 1 | **편집 기록 변환** (기본) | 조종수의 에디터·에이전트·셸 편집, 수정 제안 반영 |
| 2 | **문단 고정 ID** (§3.2) | 분석/설계 문서. 편집 기록과 함께 이중 안전장치 |
| 3 | **diff 줄 매핑** + `git blame -M -C` | 편집 기록 밖에서 들어온 변경(main 병합 등). 가져온 diff도 "외부 반영" 편집으로 기록되므로 대부분 1번으로 처리됨. M7 전까지 코드 쓰레드는 이 방법만 쓴다(§3.3) |
| 4 | **심볼 기준** (LSP 문서 심볼) | 편집 기록 누락 시 |
| 5 | 유사도 검색(임계 0.6) → 실패하면 **고아 쓰레드** | 최후 수단 |

- 서버 장애로 편집 기록이 늦게 올라가도, 확장은 로컬 편집 기록으로 앵커를 먼저 이동시킨다. 재접속하면 서버와 맞춘다.

### 3.6 개인 에이전트 질문 (기록 안 남김)

- **공식 실행과 개인 질문의 구분**
  - **공식 실행** = 조종수의 에픽 작업 폴더에서 연 Claude Code 세션. 기록되고 관찰자에게 중계된다.
  - **개인 질문** = 그 밖의 모든 세션. 기록하지 않는다.
- **"내 에이전트에게 묻기"**: 쓰레드를 인용해 Claude Code 세션을 연다. 이벤트도 세션 원본도 남기지 않는다.
  - 조종수는 **질문용 읽기 전용 사본**(`<epic-id>#ask`, 현재 체크포인트 기준)에서 연다.
  - 관찰자는 자신의 읽기 전용 관찰 창(`@live`)에서 연다.
  - 질문 대상·리뷰어는 자신의 읽기 전용 창(§2.4)에서 연다.
  - 모든 곳에서 훅이 셸을 읽기 전용 명령으로 제한하고, 쓰기는 **산출물 문서의 쓰레드 초안 블록**(§3.2)만 허용한다. 기록되지 않는 경로로 코드·문서 내용이 바뀌는 것을 막기 위해서다. 초안 블록 밖의 변경은 확장이 되돌린다.
  - MCP 도구(에픽·쓰레드·인수인계 기록)는 그대로 쓴다. 에이전트가 쓰레드의 답글·해결 상태까지 읽고 문서를 검사한다.
- **"쓰레드에 올리기"**: 사용자가 명시적으로 올린 내용만 기록한다. 에이전트가 쓴 초안도 사람이 올려야 기록된다(§3.2).

### 3.7 알림

| 상황 | 방법 |
|---|---|
| VS Code 실행 중 | 20초마다 `ls-remote`로 확인 → 바뀌었으면 fetch → reducer 결과에서 나에게 해당하는 항목을 VS Code 알림으로 표시 |
| VS Code 꺼짐 | 행위자의 확장이 일감 도구에 @멘션 댓글을 남김 (**새 질문의 대상, 리뷰 차례**에만) |

- 행위자는 상대의 VS Code가 켜져 있는지 알 수 없으므로 위 두 경우에는 항상 멘션한다. 답글·해결은 VS Code 알림만 보낸다. 답글마다 멘션하면 일감 댓글이 대화로 넘친다.
- 멘션 본문은 "질문 1건 · analysis.md · <링크>"처럼 짧게 하고 질문 내용은 넣지 않는다. 일감 도구에 내용이 복제되지 않게 하기 위해서다.
- VS Code 알림은 나에게 해당하는 **새** 항목만 띄운다. 이미 알린 항목은 로컬에 기록해 다시 띄우지 않는다.

- **메타 브랜치는 실시간 경로가 아니다.** GitHub 왕복은 push·fetch 각 약 4초이고, 여러 명이 동시에 push하면 이벤트 반영이 수십 초까지 밀린다(M0: 5명이 쉬지 않고 push할 때 최대 75초). 쓰레드·승인은 "수 초~수십 초 안에" 보이면 충분하다. 1초 안에 보여야 하는 것(대화·편집·의견)은 서버 ④로 보낸다(§8.3).

---

## 4. 단계 상태 머신

### 4.1 단계

```
          ┌──────────── change_request / 반영 실패 ──────────┐
          ▼                                                  │
INTAKE → ANALYSIS → DESIGN → IMPLEMENTATION → VERIFICATION → LANDING → DONE
              ▲         │
              └ 재분석 ──┘
```

| 단계 | 하위 상태 | 산출물 | 종료 조건 |
|---|---|---|---|
| INTAKE | — | `epic.md`, worktree | 자동 |
| ANALYSIS | `agent_drafting` → `questioning` → `owner_review` | `analysis.md`, handoff | 쓰레드 전부 resolved + `phase.completed` |
| DESIGN | `agent_drafting` → `owner_review` → (`review.requested`) → `tier[k]_review` … | `design.md`, handoff | 리뷰어가 있는 모든 티어의 `review.approved` + 열린 쓰레드 0. 마지막 승인으로 자동 전환 |
| IMPLEMENTATION | `agent_working` → `log_finalizing` → `gate_check` | 코드, impl-log, trace, handoff | 스키마 + coverage 100% + 명령 통과. 담당자의 "구현 완료" → 확장이 관문 검사·커밋·명령 실행 → `gate.reported` → `phase.completed(commit)` (§7.5) |
| VERIFICATION | (`review.requested`) → `tier[1..n]_review` | 코드 쓰레드, 수정 제안 | 리뷰어가 있는 모든 티어의 `review.approved` + 열린 쓰레드 0. 마지막 승인으로 자동 전환. 첫 리뷰 요청은 구현 완료 직후 확장이 낸다 |
| LANDING | `pending` → (`needs_report` → `pending`) | main 커밋 | 서버의 `epic.landed` (§11). `land.rejected(conflict\|invalid)`면 IMPLEMENTATION |
| DONE | — | — | — |

### 4.2 티어 승인 (서버 서명 이벤트)

- **티어는 일감의 검증 단계**다. 파이프라인이 단계별로 티어 순서(예: lead → architect)와 티어마다 심사하는 리뷰어를 정한다. **리뷰어가 없는 티어는 건너뛴다.** 건너뛰기는 그때그때 판단하지 않고 설정으로 정한다(§5).
- **리뷰 요청** = `review.requested {phase, artifact_hash, commit}` (서버 서명). 담당자가 산출물을 에픽 브랜치에 공유하고 요청하면, 서버가 원격 문서의 형식(§6.3)과 해시를 확인해 서명한다. 리뷰어는 이 커밋을 읽기 전용 창으로 본다(§2.4).
  - **검증 단계**: `artifact_hash`=`tree:<커밋의 tree>`. 서버는 그 커밋이 원격 에픽 브랜치 끝이고 **같은 커밋의 서명된 테스트 보고가 모두 통과**일 때만 서명한다. 리뷰어는 이 커밋의 쓰기 가능한 리뷰 사본으로 본다(§9.3).
  - 구현 완료(`phase.completed`) 직후 확장이 첫 검증 리뷰 요청을 낸다. 수정 제안을 반영한 뒤의 **검증 다시 요청**은 관문 검사(§7.3) → 커밋·공유 → 명령 실행 → `gate.reported` → `review.requested` 순서다.
- 티어 차례가 되면 행위자의 확장이 그 티어 리뷰어에게 VS Code 알림과 일감 도구 멘션을 보낸다.
- 승인 = `review.approved` 이벤트다. 리뷰어가 확장에서 승인을 누르면 확장이 서버에 요청하고, 서버가 아래 조건을 검증한 뒤 서버 키로 서명해 기록한다(§12). 담당자의 단계 완료(`phase.completed`)도 같은 방식이다.
  - `artifact_hash`: 승인하는 산출물의 해시. 설계 단계는 `design.md`, 검증 단계는 에픽 브랜치 tree 해시(`tree:<tree>`).
- **현재 산출물** = 마지막 `review.requested`의 해시. reducer는 파일을 보지 않으므로 이것을 기준으로 삼는다. 담당자가 문서를 고치면 다시 요청해야 한다.
- 서버(서명 전)와 reducer(받은 뒤)가 승인을 유효로 인정하는 조건
  - 서버 서명이 유효하다.
  - 리뷰어가 해당 티어의 리뷰어다.
  - 현재 차례의 티어다. 현재 티어 = 유효 승인이 `min_approvals`에 못 미치는 첫 티어(리뷰어 없는 티어 제외).
  - `artifact_hash`가 현재 산출물과 같다. 서버는 원격 에픽 브랜치의 문서와도 같은지 본다(요청 뒤 몰래 고친 문서의 승인 방지).
  - **담당자 자신의 승인**은, 담당자가 어떤 티어의 **유일한** 리뷰어일 때만 유효하다. 그때 담당자는 그 티어까지(그 티어와 앞 티어)를 스스로 승인할 수 있다. 그 밖의 티어는 다른 사람이 승인한다.
  - 담당자가 아닌 한 사람의 승인은 한 티어에만 센다(앞 티어에서 승인한 사람은 뒤 티어에서 세지 않는다).
  - 승인하는 리뷰어 **본인이 연 쓰레드가 열려 있으면** 거부한다(먼저 해결). 다른 사람의 열린 쓰레드는 막지 않지만, 마지막 티어 승인 시점에 열린 쓰레드가 0이어야 단계가 넘어간다.
- **재승인** (`reapproval`)
  - `on_change`: 다시 요청해 해시가 바뀌면, 해시가 다른 이전 승인은 모두 무효다. 결과적으로 첫 티어부터 다시 승인받는다.
  - `never`: 이전 승인을 유지한다.
- 수정 요청: `change_request` 쓰레드를 만든다. 리뷰 사본에서 만든 **수정 제안(패치)**을 붙일 수 있고, **조종수**가 반영한다(§9.3). 리뷰어는 에픽 브랜치에 직접 쓰지 않는다(D17: 에픽 브랜치에 쓰는 사람은 조종수 한 명).

### 4.3 되돌림

- VERIFICATION에서 "구현 재개"를 누르면 IMPLEMENTATION으로 돌아간다.
  - 에이전트는 change_request 쓰레드와 직전 handoff를 입력으로 작업한다.
  - impl-log에는 **새 Step을 추가**한다.
- LANDING 실패(충돌, 재검증 실패)도 IMPLEMENTATION으로 돌아간다(§11). main 이동으로 인한 재보고(`needs_report`)는 되돌림이 아니다.
- DESIGN에서 분석 누락이 발견되면 ANALYSIS로 되돌릴 수 있다.

---

## 5. pipeline.yaml

위치: 서버 DB의 제품별 설정 버전. 어드민 화면에서 편집한다(§2.5)

```yaml
version: 1
product: ad-platform
repo: git@git.example.com:anypointmedia/ad-platform.git

agent:
  allowed: [claude-code, codex, gemini-cli]   # 이 제품에서 허용하는 에이전트
  min_support: partial                        # full | partial | minimal. 이보다 낮은 등급은 공식 실행 불가
  defaults:                                   # 권장 기본 모델 (조종수가 바꿀 수 있음)
    claude-code: claude-opus-5-5
  max_turns: 200

members:                           # 멤버 자체(이메일·일감 도구 ID)는 어드민의 멤버 목록에서 관리
  groups:
    leads: [kim]
    architects: [park, lee]
    qa: [choi]

tracker:
  provider: clickup
  clickup:
    list_ids: ["901234567"]
    tag: flightdeck
    status_map:
      ANALYSIS: "분석"
      DESIGN: "설계"
      IMPLEMENTATION: "구현"
      VERIFICATION: "검증"
      DONE: "완료"

phases:
  analysis:
    rules: rules/analysis.md
    gate: { threads_resolved: true, owner_approval: true }

  design:
    rules: rules/design.md
    review:
      reapproval: on_change
      tiers:                       # 검증 단계 순서. 리뷰어(그룹)가 비어 있는 티어는 건너뛴다 (§4.2)
        - { name: lead,      reviewers: { group: leads },      min_approvals: 1 }
        - { name: architect, reviewers: { group: architects }, min_approvals: 1 }

  implementation:
    rules: rules/implementation.md
    gate:
      impl_log_schema: true
      coverage: 1.0
      coverage_ignore: ["pnpm-lock.yaml", "**/*.generated.ts"]
      commands: [pnpm lint, pnpm test]

  verification:
    rules: rules/verification.md
    review:
      reapproval: on_change
      tiers:
        - { name: lead, reviewers: { group: leads }, min_approvals: 1 }
        - { name: qa,   reviewers: { group: qa },    min_approvals: 1 }

checkpoint:
  agent: per_step_or_idle          # impl-log Step마다 + 편집 후 30초 유휴 시
  human_on_save: true              # 사람 편집도 저장 시 체크포인트
  idle_seconds: 30
  exclude_secrets: [".env", ".env.*", "*.pem", "*.key"]   # 체크포인트에 넣지 않음 (§8.1)

session:
  provider: google_meet
  gemini_notes: required
  transcript: optional
  notify_mentions_via_tracker: true

landing:
  target: main
  strategy: squash                 # squash | merge
  on_main_moved: recheck           # recheck: 서버가 main 병합 커밋을 올리고, 실행자 재보고 통과 시 재승인 불필요
  test_verification: reported      # reported(A안: 서명된 보고 신뢰) | server_run(B안, 이후)
  records:                         # squash 커밋의 .flightdeck/epics/<epic>/ 아래에는 keep에 맞는 것만 남는다
    keep: [epic.md, analysis.md, design.md, impl-log.md, runs/, threads/, sessions/]
    drop: [trace.jsonl, state.json]   # 문서화용 (keep에 없으면 어차피 빠진다)
  audit_allow: []                  # main 감사 예외 커밋 sha (어드민이 확인한 것, §11.4)

pilot:
  takeover_after_minutes: 10       # 조종수 연결 끊김 후 강제 인수 가능 시간
  takeover_by: [owner]             # owner | 그룹명

retention:
  ckpt_days: 14
  runs_days: 30
  editlog_days: 90                 # 이후 줄 단위 출처 요약만 보관
```

---

## 6. 에이전트 실행

### 6.1 실행: 에이전트 CLI를 그대로 쓰고, Flightdeck는 확장 지점에 붙는다

> 이 절은 1차 대상인 **Claude Code** 기준으로 쓴다. 다른 에이전트는 같은 구조를 AgentAdapter(§6.5)로 옮긴다.

- **전제**: 참여자 각자가 Claude Code를 설치하고 개인 Claude 구독으로 로그인해 둔다.
- Agent SDK를 쓰지 않는 이유: Agent SDK 문서는 사전 승인 없이 SDK 기반 제품에 claude.ai 로그인을 제공하는 것을 허용하지 않는다. 그래서 사용자가 설치한 Claude Code를 직접 쓴다.
- **대화 UI를 만들지 않는다.** 조종수는 에픽 작업 폴더에서 **Claude Code를 평소처럼** 연다. 공식 VS Code 확장이든 터미널이든 상관없다.
  - 모델·effort 변경, plan 모드, 슬래시 명령, 권한 확인, 이미지, `@` 파일 지정, 중단·이어가기, 대화 압축, Remote Control은 전부 Claude Code 기본 기능이다.
  - Flightdeck는 이 기능들을 다시 만들지 않는다.

#### 연동 지점

| Flightdeck 기능 | Claude Code 확장 지점 | 동작 |
|---|---|---|
| 공식 실행 등록 | **SessionStart 훅** | 세션 시작 시 `flightdeck-hook`이 확장(로컬 IPC)에 등록 → `run.started`. `session_id`와 `transcript_path`를 실행(run)과 연결 |
| 단계 룰·에픽 맥락 주입 | **SessionStart 훅** 추가 컨텍스트 | 현재 단계 룰(`rules/common.md`, `rules/<phase>.md`), 일감 요약, 열린 쓰레드 요약, 직전 handoff |
| 단계 전환 반영 | **UserPromptSubmit 훅** 추가 컨텍스트 | 세션 중에 단계가 바뀌면 다음 프롬프트에 새 단계 룰을 붙인다. 세션을 다시 열 필요 없음 |
| 단계별 권한 강제 | **PreToolUse 훅** | 현재 단계를 동적으로 읽어 허용·거부(§6.2). 설정을 단계마다 다시 만들 필요 없음 |
| 편집 기록·trace·앵커·체크포인트 | **PostToolUse 훅** + **PostToolUseFailure 훅** | §7.2, §8.6. 실패한 도구 호출(예: 종료 코드가 0이 아닌 Bash)은 PostToolUse 대신 PostToolUseFailure가 온다. 등록하지 않으면 실패한 셸 명령이 바꾼 파일이 기록되지 않는다(M4) |
| 관찰자 의견 전달 | **PostToolUse / UserPromptSubmit 훅** 추가 컨텍스트 | §8.4 |
| 턴·실행 종료 | **Stop·SessionEnd 훅** | 체크포인트, 세션 원본 저장(§6.4), ref 백그라운드 push(§8.1). 세션 종료 시 `run.finished` |
| Flightdeck 도구 | **MCP 서버** | 아래 표 |

#### 설정 배치

확장은 에픽 worktree에 다음 파일을 만들고 git 추적에서 뺀다(`.git/info/exclude`).
- `.claude/settings.local.json`: 훅 등록, Flightdeck MCP 서버 승인과 도구 권한, 권장 기본 모델(`pipeline.agent.model`)
- `.mcp.json`: flightdeck MCP 서버

```json
{
  "hooks": { "SessionStart": […], "UserPromptSubmit": […], "PreToolUse": […], "PostToolUse": […], "Stop": […] },
  "enabledMcpjsonServers": ["flightdeck"],
  "permissions": { "allow": ["mcp__flightdeck"] }
}
```

- **MCP 서버 승인과 도구 호출 권한은 별개다**(M0 확인).
  - `.mcp.json`만 두면 대화형은 "New MCP server found in this project" 창을 띄우고, 기본 선택은 "사용 안 함"이다. `enabledMcpjsonServers`가 있으면 이 창이 뜨지 않는다.
  - 서버를 승인해도 도구 호출 권한이 없으면 headless(`-p`)에서 Flightdeck 도구 호출이 거절된다. `permissions.allow`에 `mcp__flightdeck`을 넣는다.

사용자 전역 설정(`~/.claude/`)은 건드리지 않는다. 모델은 **권장 기본값**일 뿐이며 조종수가 `/model`로 바꿀 수 있다.
- 사용자 전역 훅(`~/.claude/settings.json`)과 worktree 훅은 같은 세션에서 함께 실행된다(M0 확인).
- **신뢰는 진입점마다 다르다**(M0 확인). 신뢰하기 전에는 프로젝트 설정(훅)이 적용되지 않는다고 보고 안내한다.

| 진입점 | 신뢰 방식 | 범위 | Flightdeck의 안내 |
|---|---|---|---|
| 터미널 `claude` | Claude Code 자체 신뢰 확인 창. 기본 선택이 "No, exit" | **원본 레포 경로** 기준(`~/.claude.json`). 한 번 신뢰하면 이후 에픽 worktree는 다시 묻지 않음 | 첫 에픽 때 "터미널에서 열면 이 레포를 신뢰해 주세요" |
| VS Code 안의 Claude Code | 자체 창 없음. **VS Code 작업 영역 신뢰**를 따름(상단 제한 모드 배너의 Manage) | 폴더 단위. 에픽 worktree는 에픽마다 다른 폴더 | 첫 에픽 때 **worktree 상위 폴더 `../<repo>.flightdeck/`을 신뢰**하도록 안내. 하위 폴더 전부에 적용됨 |
| headless(`-p`) | 신뢰 확인을 건너뜀 | — | — |

  - 확장은 `~/.claude.json`이나 VS Code 신뢰 목록을 직접 고치지 않는다.
  - Flightdeck 확장은 `capabilities.untrustedWorkspaces: false`로 둔다. 제한 모드에서는 동작하지 않고 신뢰를 안내한다.
- **설정 검증**: `-p` 모드는 검증에 실패한 설정 파일을 경고 없이 무시한다. 확장은 `settings.local.json`을 쓸 때 스키마를 검증하고, 세션이 시작됐는데 SessionStart 훅이 오지 않으면 "훅 미동작"으로 표시한다.
- **경로 정규화**: 훅 입력의 `cwd`·`file_path`는 실제 경로(예: macOS `/tmp` → `/private/tmp`)로 들어온다. 쓰기 허용 목록·보호 경로(§6.2) 판정은 양쪽을 realpath로 정규화한 뒤 비교한다.

#### 자동 초안 (headless)

- 일감 접수 직후의 분석 초안처럼 사람이 없는 실행만 백그라운드 `claude -p`로 돌린다.
  - 같은 훅이 적용된다. `settings.local.json`이 worktree에 있기 때문이다.
- 끝나면 확장이 조종수에게 알린다. 조종수는 그 세션을 **이어서(resume)** 대화형으로 계속한다. 본인 계정·본인 PC이므로 이어가기가 가능하다.
  - `claude --resume <session_id>`는 같은 `session_id`, 같은 transcript 파일을 이어 쓴다. 훅에는 SessionStart `source: "resume"`이 온다(M0 확인).
  - 그래서 resume은 **같은 실행(run)을 잇는다.** 세션을 닫을 때마다 `run.finished`가 다시 기록될 수 있고, reducer는 마지막 것(`ckpt_to`)을 쓴다(M1: 초안 실행을 이어서 작업한 뒤 종료가 2회 기록됨). 실행을 확정하는 시점은 handoff 작성과 단계 완료다.
- 확장이 claude를 띄울 때는 부모 프로세스에서 물려받은 `CLAUDECODE`·`CLAUDE_CODE_*` 환경변수를 지운다. 예를 들어 `CLAUDE_CODE_CHILD_SESSION`이 상속되면 대화형 세션이 transcript를 저장하지 않는다.

#### 강제의 위치

- 사용자는 worktree의 Claude Code 설정을 고쳐 훅을 끌 수 있다. 그래서 **훅은 편의와 즉시 피드백을 위한 장치이고, 강제는 관문이 한다.**
- 훅을 끄고 고친 내용은 다음 경로로 걸러진다.
  - 파일 감시에 "외부 도구" 변경으로 잡혀 메모가 필수가 된다(§7.4).
  - diff 대조와 반영 서버 검증에서 걸린다.
- **훅 오류는 실행을 막지 않는다.** 종료 코드 2가 아닌 훅 오류(예외, 비정상 종료)는 에이전트 실행을 그대로 진행시키고, 모델과 사용자 모두 알아채지 못한다. 그래서 다음을 둔다.
  - `flightdeck-hook`은 자체 오류를 확장에 보고하고, 확장은 "훅 오류 n건"을 표시한다.
  - 훅 오류로 빠진 편집은 외부 변경 감지(§7.4)가 `external:unknown`으로 잡는다.
- **훅 실패 시 기본 동작을 경로마다 정한다.** `flightdeck-hook`은 내부 예외를 모두 잡아서 아래 기본값으로 응답한다. 예외가 그대로 새면 Claude Code는 실행을 진행시키므로, 차단 경로가 조용히 뚫린다(M0 확인: 훅 버그로 급한 의견 차단이 첫 호출 뒤 풀림).

| 경로 | 실패 시 | 이유 |
|---|---|---|
| 차단: 단계별 권한(§6.2), 보호 경로, 급한 의견(§8.4) | **거부(fail-closed)**. 사유: "Flightdeck 훅 오류로 이 도구 호출을 막았습니다" | 막아야 할 호출이 실행되는 쪽이 더 위험하다. 잘못 막으면 모델이 사유를 보고 멈추거나 다시 시도한다 |
| 기록: 편집 기록, trace, 체크포인트, 대화 스트림 | **허용(fail-open)** | 기록 실패로 작업을 멈추면 안 된다. 빠진 편집은 외부 변경 감지(§7.4)와 체크포인트 diff(§7.3 7번)로 보완한다 |
| 컨텍스트 주입: 단계 룰, 일반 의견 | 허용, 다음 훅에서 다시 시도 | 주입 실패는 실행을 막을 이유가 아니다. 의견은 대기열에 남아 다음 PostToolUse·UserPromptSubmit에서 다시 주입된다 |

#### 훅 입출력 (Claude Code, M0 확정)

| 항목 | 내용 |
|---|---|
| 공통 입력 | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `prompt_id`, `hook_event_name` |
| 도구 훅 입력 | `tool_name`, `tool_input`, `tool_use_id`. PostToolUse는 `tool_response`, `duration_ms` 추가 |
| SessionStart 입력 | `source` (`startup` \| `resume` 등) |
| Stop 입력 | `last_assistant_message`, `stop_hook_active` |
| 추가 컨텍스트 | `{"hookSpecificOutput": {"hookEventName": <이벤트>, "additionalContext": "…"}}`. SessionStart·UserPromptSubmit·PostToolUse에서 동작. transcript에 `hook_additional_context`로 남는다 |
| 차단 | PreToolUse에서 `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "…"}}`. `--allowedTools`·권한 설정보다 우선하며, 사유가 오류 tool_result로 모델에 전달된다 |
| 실행 중 전달 | 가능. PostToolUse 추가 컨텍스트는 다음 모델 턴부터 반영된다. 같은 턴 안에서 막아야 하면 PreToolUse 거부를 쓴다(§8.4 급한 의견) |
| 도구 실행 시점 | Claude Code는 assistant 메시지가 **다 오기 전에** 도구 실행을 시작한다(M0: 첫 도구의 PreToolUse가 같은 메시지의 나머지 도구 호출 블록보다 먼저 옴). 그래서 PreToolUse 시점에 그 메시지의 도구 호출 전체를 알 수 없다 |
| transcript 기록 시점 | transcript는 바로 기록되지 않는다. PreToolUse 시점에 그 도구 호출 줄이 아직 파일에 없는 경우가 많다. 훅의 판단 근거로 transcript를 쓰지 않고, 관찰 뷰(§8.3)처럼 늦어도 되는 용도에만 쓴다 |

- 편집 기록의 `source.message`(§8.6)에는 `prompt_id`와 `tool_use_id`를 쓴다.
- 위 훅 입출력은 공식 VS Code 확장 안의 Claude Code에서도 같게 동작한다(M0 확인: 훅 4종, MCP 도구, 사용자 권한 모드가 `auto`일 때의 deny).

| MCP 도구 | 설명 |
|---|---|
| `flightdeck_get_epic` | 일감 원문, 현재 단계 |
| `flightdeck_list_threads` | 단계·상태별 쓰레드 |
| `flightdeck_get_handoffs` | 이전 실행들의 인수인계 기록 |
| `flightdeck_search_run` | **세션 원본 검색**: 관련 구간만 반환 (§6.4) |
| `flightdeck_reply_thread` | 에이전트 답글 (수정 요청 반영 시에만) |
| `flightdeck_log_step` | impl-log Step 추가·고쳐 쓰기. impl-log를 쓰는 **유일한 경로**다(§7.1) |
| `flightdeck_submit` | 구현 관문 검사(impl-log 형식, 설명 없는 변경). 제출 자체는 사람이 확장에서 한다 |

- Claude Code는 MCP 도구를 지연 로딩해, 처음에는 도구 검색(`ToolSearch`)으로 찾는다(M0 확인). 도구 설명에 에이전트가 검색할 단어(쓰레드, 인수인계, 단계, 구현 기록, 제출 등)를 넣는다. 단계 룰(SessionStart 컨텍스트)에도 쓸 도구 이름을 적는다.

### 6.2 단계별 도구 권한 (PreToolUse 훅)

| 단계 | 쓰기 허용 | 셸 |
|---|---|---|
| ANALYSIS | `analysis.md`, `runs/<run-id>/handoff.md` | 읽기 전용 허용 목록 |
| DESIGN | `design.md`, `runs/<run-id>/handoff.md` | 읽기 전용 허용 목록 |
| IMPLEMENTATION | `.flightdeck/` 제외 전체 + 이번 실행의 handoff. impl-log는 `flightdeck_log_step`으로만, trace는 훅이 쓴다 | 허용 (**모든 git 명령 차단**, `rm -rf` 등 차단) |
| VERIFICATION (담당자) | 없음 | 테스트 실행만(관문 명령) |
| 리뷰 사본 (검증 리뷰어, §9.3) | `.flightdeck/` 제외 전체. 기록하지 않는다 | 허용 (**모든 git 명령 차단**) |
| 읽기 전용 창 (질문 대상·설계 리뷰어, 단계 무관) | 산출물 문서의 **쓰레드 초안 블록**만 (§3.2). 그 밖의 변경은 확장이 되돌린다 | 읽기 전용 허용 목록 |

- 에이전트도 git 명령을 쓸 수 없다. 버전 관리는 확장만 한다(D12).
- 모든 단계에서 다음 경로의 읽기·쓰기를 차단한다. 설정 캐시와 훅·MCP 설정을 에이전트가 조작하는 것을 막기 위해서다.
  - `.flightdeck/.runtime/`
  - 어댑터의 `protectedPaths()`. 예: Claude Code는 `.claude/settings.local.json`, `.mcp.json`. Codex는 `.codex/`
- 표의 "쓰기", "셸"은 공통 개념이다. 실제 도구 이름(Edit/Write/Bash, apply_patch/shell 등)은 어댑터가 공통 이벤트로 바꿔 판정한다.
- 저장할 때마다 다음을 검사하고 고친 뒤 경고를 남긴다. 파일 전체를 원복하지 않는다(같은 저장의 정상 편집까지 지우므로).
  - 쓰레드 블록 변경: 렌더링 영역이라 다시 그리면 원래대로 돌아온다.
  - 문단 ID(`p:`) 삭제·변경: ID만 복원한다(§3.2 복원 규칙).

### 6.3 산출물 스키마

- `analysis.md`: `## 요구사항 요약`, `## 영향 범위`, `## 불명확한 점`, `## 가정`
- `design.md`: `## 개요`, `## 변경 컴포넌트`, `## 인터페이스`, `## 데이터 변경`, `## 테스트 계획`, `## 리스크`

### 6.4 실행 기록 3계층 (토큰 절감형 맥락 공유)

세션 원본을 통째로 공유하면 토큰이 많이 든다. 이어받는 쪽이 전체 대화를 다시 읽어야 하고, 프롬프트 캐시는 계정 단위라 다른 사람에게는 효과가 없다. 그래서 다음 실행자와 리뷰어에게는 **결과물과 인수인계 기록**을 기본으로 주고, 원본은 **필요할 때 검색**하게 한다.

| 계층 | 내용 | 크기 | 로딩 |
|---|---|---|---|
| 1. 결과물 | analysis/design.md, impl-log, 쓰레드 | 작음 | 항상 |
| 2. 인수인계 기록 `runs/<run-id>/handoff.md` | 실행 마지막에 에이전트가 작성 (형식 강제) | 수 KB | 항상 |
| 3. 세션 원본 | Claude Code 세션 JSONL. 비밀값 제거 후 압축, `refs/flightdeck/runs/<epic-id>`의 `<run-id>/<session-id>.jsonl.gz`에 저장. **턴이 끝날 때마다(Stop)와 세션 종료 때** 그 세션 파일을 새로 쓴다(긴 세션 중에도 검색할 수 있게). 구현 관문 명령의 전체 로그도 `gate/<commit>/<n>.log.gz`로 둔다 | 큼 | `flightdeck_search_run`으로 **관련 구간만**. 리뷰어·질문 대상은 원격 ref를 받아 검색한다 |

handoff.md 형식(강제):

```markdown
# Run 01JB7… · DESIGN · @dh.lee

## 목표
## 읽은 파일          <!-- 경로 + 왜 읽었는지 한 줄 -->
## 결정과 이유
## 버린 대안          <!-- 대안 + 버린 이유 -->
## 실패한 시도        <!-- 시도 + 실패 원인 -->
## 가정
## 남은 리스크
## 다음 실행자에게
```

- `flightdeck_search_run(run_id?, query, max_tokens=2000)`
  - 원본 메시지를 키워드·BM25로 검색한다.
  - 앞뒤 맥락을 포함한 발췌만 반환한다.
- **기록 종류 허용 목록 필터** (비밀값 제거보다 먼저)
  - transcript에는 대화뿐 아니라 세션 시작 때 에이전트에게 넘긴 배경 정보도 기록된다. 계정 이메일, 사용자 전역 `CLAUDE.md`, 개인 자동 메모리, 개인 플러그인·MCP 목록, 시스템 프롬프트 전체가 여기에 해당한다(M0 확인).
  - 그래서 저장·중계할 기록 종류를 **허용 목록**으로 정한다: 사람의 프롬프트, 에이전트의 텍스트·도구 호출, 도구 결과, Flightdeck이 주입한 컨텍스트(`hook_additional_context`). 나머지는 모두 버린다.
  - 차단 목록이 아니라 허용 목록이므로, 에이전트 업데이트로 새 기록 종류가 생겨도 기본적으로 걸러진다. 허용 목록은 어댑터가 정한다(`transcript()`, §6.5).
  - 부수 효과로 크기도 크게 준다(작은 세션 260KB 중 약 90%가 버리는 부분).
- 비밀값 제거
  - 저장 전에 가린다(`[REDACTED]`): 이름이 비밀처럼 보이는 환경변수(`TOKEN`·`SECRET`·`KEY`·`PASSWORD`·`CREDENTIAL`·`AUTH` 포함)의 값, 토큰 패턴(`sk-…`, `ghp_…`, `github_pat_…`, ClickUp `pk_…`, Slack `xox?-…`, AWS `AKIA…`, JWT, PEM 개인키), 작업 폴더 `.env*` 파일의 값.
  - 환경변수 값을 모두 가리지는 않는다. `HOME`·`PATH` 같은 경로까지 가리면 원본이 읽히지 않는다(M4 X6).
  - M4 실측: 실제 세션 40항목이 허용한 종류(사람 프롬프트, 에이전트 메시지·도구 호출, 도구 결과, Flightdeck 주입 맥락)만 남았고 이메일·`CLAUDE.md`·메모리 내용은 없었다.
  - 세션 시작 시 "이 실행은 기록됩니다"를 표시한다.
- **개인 에이전트 질문(§3.6)은 이 기록 대상이 아니다.**

### 6.5 AgentAdapter (에이전트 확장)

에이전트 CLI마다 다른 부분(설정 파일, 훅 입출력, 편집 형식, 세션 기록)을 어댑터 안에 가둔다. Flightdeck의 나머지(core, 서버, 관문, 패널)는 에이전트 종류를 모른다.

```ts
interface AgentAdapter {
  id: "claude-code" | "codex" | "gemini-cli" | "jcode" | string;
  detect(): Promise<{ installed: boolean; version?: string }>;
  installConfig(worktree: string, hookCmd: string, mcp: McpSpec): Promise<void>; // 도구별 설정 파일에 훅·MCP 등록
  protectedPaths(): string[];                      // 에이전트가 고치면 안 되는 설정 파일 (§6.2)
  parseHookEvent(raw: unknown): HookEvent;         // 도구별 훅 입력 → 공통 이벤트
  renderHookResponse(r: HookResponse): HookOutput; // 허용/거부/추가 컨텍스트 → 도구별 출력·종료 코드
  extractEdits(e: ToolEvent, before: FileSnapshot, after: FileSnapshot): Edit[]; // 디스크 전후 스냅샷 → 공통 편집 기록. 페이로드는 범위 분할 힌트 (§8.6)
  transcript?(s: SessionRef): AsyncIterable<TranscriptItem>; // 관찰 뷰·원본 검색용. 허용 목록 필터 적용 (§6.4)
  headless?(prompt: string, o: RunOpts): Promise<SessionRef>; // 자동 초안
  resumeCommand?(s: SessionRef): string;           // 초안 이어가기
  capabilities: {
    sessionStartContext: boolean;  // 세션 시작 시 룰·맥락 주입
    promptContext: boolean;        // 프롬프트 제출 시 컨텍스트 추가
    preToolBlock: boolean;         // 도구 실행 전 차단
    postToolEdits: boolean;        // 도구 실행 후 편집 내용 확보
    midRunContext: boolean;        // 실행 중 컨텍스트 추가 (의견 전달)
    transcript: boolean;
    resume: boolean;
  };
}
```

#### 공통 이벤트 대응

| 공통 이벤트 | Claude Code | Codex CLI | Gemini CLI | jcode |
|---|---|---|---|---|
| `session.start` | SessionStart | SessionStart | SessionStart | M0 확인 |
| `prompt.submit` | UserPromptSubmit | UserPromptSubmit | M0 확인 | M0 확인 |
| `tool.before` | PreToolUse | PreToolUse (+ PermissionRequest) | BeforeTool (종료 코드 2로 차단) | M0 확인 |
| `tool.after` | PostToolUse | PostToolUse | AfterTool | M0 확인 |
| `session.stop` | Stop | Stop | M0 확인 | M0 확인 |
| 레포 단위 설정 | `.claude/settings.local.json`, `.mcp.json` | `<repo>/.codex/hooks.json`, `config.toml` | `settings.json` | M0 확인 |
| 파일 편집 형식 | Edit/Write (변경 전후 문자열) | 주로 `apply_patch` (패치) | M0 확인 | M0 확인 |
| 구독 사용 | Claude 구독 | ChatGPT 구독 | Google 계정 | 여러 공급자 |

#### 지원 등급

| 등급 | 조건 | 동작 |
|---|---|---|
| **완전 지원** | `sessionStartContext`, `preToolBlock`, `postToolEdits` + MCP | 모든 기능. 에이전트 편집에 출처가 정확히 붙는다 |
| **부분 지원** | 위 일부 + MCP | 없는 기능만 대체한다. 예: `midRunContext`가 없으면 의견을 다음 프롬프트에 붙인다. `transcript`가 없으면 관찰 뷰를 훅 이벤트만으로 보여준다 |
| **최소 지원** | MCP만 | 에이전트 편집이 파일 감시에 "외부 도구"로 잡혀 **메모가 필요**하다(§7.4). 쓸 수는 있지만 불편하다 |

- 확장은 `detect()`와 `capabilities`로 등급을 계산해 에픽 상세에 표시한다.
- **관문은 등급과 무관하다.** diff 대조, 메모 필수, 반영 서버 검증은 편집 기록과 git만 보기 때문에, 어떤 에이전트를 쓰든 main에 들어가는 기준은 같다.
- 버전 대응(§15 해결됨)은 어댑터별로 한다. 어댑터마다 검증된 버전 목록과 세션 기록 샘플 회귀 테스트를 둔다.

#### 여러 에이전트 혼용

- 조종 넘기기(§8.5)와 리뷰(§9.3)는 세션을 이어받지 않고 **handoff + 원본 검색**으로 넘긴다. 그래서 에이전트 종류와 무관하게 동작한다.
  - 예: 설계는 Claude Code를 쓰는 아키텍트가 조종 → 구현은 Codex를 쓰는 개발자가 넘겨받음 → 리뷰어는 Gemini CLI로 리뷰 사본 검토
- `flightdeck_search_run`은 MCP 도구라서 어느 에이전트에서든 호출된다. 다른 에이전트가 만든 세션 원본의 파싱은 원본을 만든 쪽 어댑터가 맡는다(`runs/<run-id>`에 `agent` 기록).
- 룰 파일(`rules/*.md`)은 에이전트 공통이다. 에이전트별 보정이 필요하면 `rules/<phase>.<agent-id>.md`를 추가로 둔다. 있으면 공통 룰 뒤에 덧붙인다.

---

## 7. 구현 기록과 diff 대조

### 7.1 impl-log.md (강제)

- impl-log는 **`flightdeck_log_step`으로만** 쓴다. 에이전트는 Step의 제목·`design_ref`·의도·결정·검토한 대안·리뷰 포인트·검증을 넘기고, Flightdeck이 렌더링한다(편집 출처 `flightdeck/impl_log`). 에이전트의 직접 쓰기는 훅이 거부한다. 자동 기입 필드(`ckpt`, `changes`)를 에이전트가 지우거나 틀리게 쓰지 않게 하기 위해서다.
- 순서: 그 Step까지의 코드를 체크포인트로 남김 → Step 작성(`ckpt` = 그 체크포인트). impl-log 자체는 다음 체크포인트에 들어간다.
- 고칠 때는 `step: n`을 주어 같은 Step을 다시 쓴다. 에이전트가 제목에 붙인 "Step n:"은 떼어 낸다.
- **Step 하나를 구현 → 확인 → 기록한 뒤 다음 Step으로 간다.** 여러 Step 분량을 한 번에 쓰고 몰아서 기록하면 뒤 Step의 `changes`가 빈다(M4 실측). 단계 룰에 적고, `changes`가 빈 Step은 기록 응답으로 알려 준다. 문서·확인만 하는 Step도 있으므로 형식 오류로 막지는 않는다.
- 형식 검사(`impl_log_schema`): Step 번호가 1부터 빠짐없이, `ckpt`가 커밋, `design_ref`가 design.md에 있는 문단 ID, 글 항목이 모두 채워짐.
- 끝에 **`## 직접 수정 메모`** 섹션을 Flightdeck이 그린다(§7.4).

````markdown
## Step 3: 리프레시 토큰 회전

```yaml
design_ref: design.md#p:a91c
ckpt: 9c1e2f0            # 이 Step 완료 시점 체크포인트 (자동 기입)
changes:                 # 편집 기록으로 자동 생성 (§7.3). 에이전트가 쓰지 않음
  - src/auth/token.ts:40-72
  - src/auth/token.test.ts:10-55
verification: "pnpm test auth  # ✅ 12 passed"
```

**의도** 설계 3.2의 회전 정책 구현.

**결정** 회전 이력은 Redis Set으로 관리.

**검토한 대안** DB 테이블 저장 — 조회 빈도 대비 과도하여 기각.

**리뷰 포인트** `token.ts:58` 경쟁 조건 처리 — 확인 권장.
````

### 7.2 trace.jsonl (PostToolUse 훅)

```json
{"ts":"2026-10-02T10:01:22+09:00","tool":"Edit","file":"src/auth/token.ts","range":[40,72],"step":3}
{"ts":"2026-10-02T10:03:10+09:00","tool":"Bash","cmd":"pnpm test auth","exit":0,"step":3}
```

### 7.3 coverage 검사 (편집 기록 기반)

편집 기록(§8.6)에는 모든 편집의 **출처(멤버·실행·Step·원인 메시지)**가 들어 있다. 그래서 "어떤 변경이 어느 Step에서 왜 생겼나"는 추정이 아니라 **조회**로 얻는다.

1. 최종 diff(`base → HEAD`)의 각 hunk에 대해, 그 줄을 마지막으로 만든 편집들을 편집 기록에서 찾는다(줄 단위 출처 조회).
2. 그 편집들의 Step을 확인한다.
   - 에이전트 편집: `run`, `step`이 기록되어 있다.
   - 사람 편집: 출처가 `human`이다.
   - 셸 결과: 출처가 `agent_shell:<명령>`이다.
   - Flightdeck 렌더링(문단 ID, 쓰레드 블록): 출처가 `flightdeck`이다. 설명이 필요 없다(§8.6).
3. **impl-log `changes`는 편집 기록으로 자동 생성한다.** 에이전트는 Step마다 의도·결정·대안·리뷰 포인트만 쓴다. 파일·줄 범위를 직접 쓰지 않는다.
4. **설명 없는 변경**의 정의
   - Step에 속하지 않는 에이전트 편집
   - Step 설명이 비어 있는 편집
   - **메모가 없는 직접 수정**: 출처가 `human` 또는 `external`인 편집(§7.4)
5. 설명 없는 변경이 1개라도 있으면 게이트가 실패한다. `coverage_ignore`는 제외한다.
6. 같은 계산을 **반영 서버가 서버의 편집 기록으로 다시 한다**(§11.3). 서버 편집 기록은 M7이므로, 그 전까지 서버는 impl-log 형식과 테스트 보고만 확인하고 coverage는 확장이 계산한 것에 맡긴다.
7. **보조 수단**: 편집 기록이 없는 구간(서버 장애 중 재전송 실패 등)은 체크포인트 체인 diff(`ckpt(Step n-1) → ckpt(Step n)`)로 추적한다. 해당 hunk는 "기록 누락"으로 표시해 리뷰어에게 보여준다.

**계산 방법 (M4)**
- 대상: 최종 diff(`base → 작업 트리`)에서 `.flightdeck/`(Flightdeck 기록), `coverage_ignore`, 비밀 파일을 뺀 파일.
- 파일마다 base 내용에서 편집 기록을 순서대로 재적용하며 **문자마다 출처**를 붙인다. 지운 자리에는 길이 0인 삭제 표시를 남긴다. 같은 출처가 넣고 지운 것은 흔적을 남기지 않는다.
- 재적용 결과 ≠ 디스크면, 그 차이를 `external:unknown`으로 먼저 기록한다(체크포인트·제출 때, §7.4). 저장하지 않은 에디터 편집이 있으면 이 확인을 미룬다(사람 편집은 저장 전에도 기록되므로, 그대로 비교하면 사람 편집을 외부 변경으로 잘못 기록한다).
- hunk 안의 출처가 모두 설명되면 통과다. 출처가 하나도 없는 hunk는 기록 누락이라 설명 없음이다.
- **편집이 속하는 Step** = 그 편집 시점의 "마지막 기록 Step + 1"(에픽 단위 번호). Step은 끝날 때 기록하므로, 마지막 `log_step` 뒤의 에이전트 편집은 기록되지 않은 Step에 속해 설명 없는 변경이 된다.

### 7.4 직접 수정 메모 (필수)

사람이 에이전트를 거치지 않고 고친 코드는 **반드시 메모가 있어야** 한다. 메모가 없으면 구현 게이트와 반영 서버 검증을 통과하지 못한다.

| 대상 | 출처 | 메모를 받는 방법 |
|---|---|---|
| 조종수의 에디터 편집 | `human:<member>` | 확장이 연속된 직접 수정을 **수정 묶음**으로 자동으로 묶는다(같은 파일, 2분 이내 간격). 체크포인트 생성 시나 제출 전에 "메모 필요 n건" 패널에서 묶음마다 한 줄 메모를 쓴다 |
| 외부 도구 변경 | `external:unknown` | 아래 "외부 변경 감지" 참고. 직접 수정과 같은 방식으로 메모를 받는다 |
| 수정 제안 반영 | `patch:<thread>/<member>` | 연결된 쓰레드가 설명이므로 메모가 필요 없다 |

- 수정 묶음 = 같은 파일·같은 출처(사람·외부)의 연속된 설명 없는 편집(2분 이내). 묶음의 줄 범위는 hunk 전체가 아니라 **그 편집들의 문자가 있는 줄**이다(새 파일은 파일 전체가 hunk 하나라, hunk로 잡으면 한 줄 수정이 파일 전체로 보인다, M4 실측).
- 메모는 `{file, seqs:[처음, 끝], memo}`로 로컬에 저장하고(M7에서 서버로), **impl-log.md의 `## 직접 수정 메모`**에도 Flightdeck이 그린다(파일·줄 범위·작성자·메모). 리뷰어는 에픽 브랜치에서 본다.
- 메모 형식: 한 줄 이상. 선택적으로 관련 쓰레드나 설계 문단(`design.md#p:xxxx`)을 연결할 수 있다.

**외부 변경 감지**
- 확장은 에픽 작업 폴더를 파일 감시한다.
- 디스크 변경이 다음 세 경로 어디에도 해당하지 않으면 출처 `external:unknown`으로 편집 기록에 남긴다.
  - VS Code 에디터 편집
  - Flightdeck 실행 에이전트의 hooks
  - 그 에이전트의 셸 명령 구간
- 예: 직접 띄운 Claude Code, 다른 에디터, 터미널 명령(sed, python 등)
- **판단 방법: 편집 기록 재적용 결과 ≠ 디스크** (M1 확인). 위 세 경로의 편집은 모두 편집 기록에 이미 있으므로, 그 파일의 편집 기록을 순서대로 재적용한 결과가 기대 내용이다. 디스크가 이와 다르면 그 차이가 기록되지 않은 변경이다. 차이를 편집으로 바꿔 `external:unknown`으로 기록한다. 그래서 변경 경로와 상관없이 잡히고, 기록 후에는 항상 "재적용 = 디스크"가 유지된다.
  - 확인 시점: 파일 감시 알림 뒤(약 1초 디바운스), 문서를 다시 그릴 때, 단계 완료 때. 확장이 꺼져 있던 동안의 변경은 다음에 열 때 잡힌다.
  - M1은 산출물(analysis.md, design.md)에 적용했다. 코드 파일 전체로 넓히는 것은 M7(편집 기록 서버)에서 한다.
- 감지 즉시 조종수에게 "Flightdeck 밖에서 수정됨" 알림을 띄운다.
- **에디터 이벤트로 들어오는 외부 변경**(M0 확인)
  - VS Code에 **열려 있는** 파일을 외부 도구가 바꾸면, VS Code가 디스크를 다시 읽으면서 `onDidChangeTextDocument` 편집 이벤트가 온다. 그대로 두면 `human:<member>`로 잘못 기록된다.
  - 판별 규칙: **이벤트 직후 문서 내용 == 디스크 내용**이면 사람 편집이 아니라 디스크 재로드다. 사람 편집은 저장 전이라 디스크와 다르다(M0: 사람 편집 10건 모두 다름, 외부 변경 1건만 같음).
  - 재로드로 분류된 변경이 같은 시점의 에이전트 훅 기록(§8.6)과 내용이 같으면 이미 기록된 에이전트 편집이므로 버린다. 다르면 `external:unknown`으로 기록한다.
  - `TextDocument.isDirty`는 판별에 쓸 수 없다. 파일을 연 뒤 첫 편집에서도 `false`로 나온다.
  - **열려 있지 않은** 파일의 외부 변경은 에디터 이벤트가 없다. 파일 감시로만 잡힌다.

### 7.5 테스트 결과 보고 (A안)

- 구현 게이트의 `commands`(lint/test)는 **에이전트가 아니라 확장**이 직접 실행한다. 에이전트가 결과를 꾸밀 수 없게 하기 위해서다.
- 실행 결과는 확장이 서버에 보고하고, 서버가 보고자(로그인한 멤버)를 적어 서명한 `gate.reported` 이벤트로 남긴다.
  - 내용: 대상 커밋, 명령별 종료 코드, 요약, 로그 해시
  - 전체 로그는 `refs/flightdeck/runs/<epic-id>`에 보관한다.
- **구현 완료** 순서: 저장 → 외부 변경 기록 → coverage·impl-log 검사(실패하면 커밋하지 않음) → 에픽 브랜치에 커밋(비밀 파일 제외)·공유 → 명령 실행 → `gate.reported` → `phase.completed {phase: IMPLEMENTATION, commit}`. 서버는 그 커밋이 원격 에픽 브랜치 끝이고, impl-log 형식이 맞고, 그 커밋의 서명된 보고가 모두 종료 코드 0일 때 서명한다(`artifact_hash` = 그 커밋의 tree). reducer도 같은 커밋의 통과 보고를 요구한다.
- `gate.reported`는 담당자가 낸다. 서버는 보고한 커밋이 원격 에픽 브랜치에 있는지 본다.
- 서버는 다음만 확인한다. 테스트를 다시 돌리지는 않는다.
  - 보고가 **반영 대상 커밋**에 대한 것인가
  - 서명이 유효한가
  - 모든 명령의 종료 코드가 0인가
- **신뢰 경계**: 보고를 꾸미려면 확장을 고의로 변조해야 한다. 그래도 **누가 통과를 보고했는지**는 서버 서명 이벤트로 남는다.
- 서버 재실행(B안)은 `landing.test_verification: server_run`으로 이후 추가한다.

---

## 8. 작업 공유

### 8.1 체크포인트

- 체크포인트는 **브랜치와 작업 트리를 건드리지 않는 숨은 커밋**이다. 임시 index + `write-tree` + `commit-tree` + `update-ref`로 만든다.
- 생성 시점
  - 에이전트: `flightdeck_log_step`마다, 그리고 편집 후 30초 유휴 시
  - 사람: 저장 시(디바운스 10초)
- 커밋 메시지 trailer: `Flightdeck-Run`, `Flightdeck-Step`, `Flightdeck-Source(agent|human)`
- 생성 직후 push한다(`refs/flightdeck/ckpt/<epic-id>/<member>`). 훅 안에서는 기다리지 않고 **분리된 백그라운드 `git push`**를 띄운다(GitHub 왕복 약 4초 동안 에이전트가 멈추지 않게, M4). 실패하면 다음 push가 다시 올린다.
- 생성 시점의 구현: Step 끝은 `flightdeck_log_step`, 턴 종료는 Stop 훅, 에이전트 유휴·사람 저장은 확장의 타이머.
- **되돌리기**: Phase Panel의 타임라인에서 아무 체크포인트나 골라 "이 시점으로 복원"을 할 수 있다. 복원 직전 상태도 체크포인트로 남겨서 복원을 취소할 수 있다.
  - 복원은 **제품 코드만** 되돌린다. `.flightdeck/` 아래 기록(impl-log·trace·handoff)은 그대로 둔다. Step 체크포인트는 그 Step 기록보다 먼저 만들어지므로, 함께 되돌리면 그 Step 기록이 사라진다(M4).
  - 복원도 편집 기록에 남긴다(출처 `restore`, 파일 전체 교체, 그 체크포인트의 `Flightdeck-Seq`). coverage는 복원된 파일의 출처를 그 seq 시점의 출처로 되살린다. 내용이 맞지 않으면(기록 누락) 그 줄은 메모가 필요하다. 기록하지 않으면 복원이 외부 변경(메모 필수)으로 잡힌다.
- **비교**: 두 체크포인트 사이 diff를 보여준다.

- 체크포인트에는 그 시점의 편집 기록 순번(`Flightdeck-Seq`)을 trailer로 남긴다. git 스냅샷과 편집 기록이 서로를 가리킨다.

**구현 규칙 (M0 확인)**
- **디스크 바이트 그대로 저장한다.** 체크포인트를 만드는 git 호출에는 `-c core.autocrlf=false`와 `GIT_ATTR_SOURCE=<빈 트리 4b825dc…>`를 줘서 줄바꿈 변환과 레포 `.gitattributes`(filter 포함)를 끈다. 그래야 편집 기록의 `base_hash`(§8.6)와 체크포인트가 같은 바이트를 가리키고, 복원 결과가 그 시점 디스크와 바이트 단위로 같다.
  - 대가: LFS 대상 파일도 원본 그대로 체크포인트에 들어간다. 체크포인트는 별도 ref라 retention 후 회수된다(§2.1).
  - 에픽 브랜치 커밋(단계 전환·제출)은 레포 규칙대로 변환한다. 체크포인트만 예외다.
- **비밀 파일은 체크포인트에 넣지 않는다.** `.env`, `*.pem`, `*.key` 등 비밀 파일 패턴(`pipeline.yaml`에서 관리)을 임시 index에서 뺀다. GitHub에서는 ref를 지워도 커밋이 SHA로 남기 때문이다(§2.1). 이 파일들은 편집 기록에서도 내용 없이 "변경됨"만 남긴다.
- 임시 index는 사용자 index를 복사해 만든다(stat 캐시 재사용). 사용자 index·HEAD·브랜치는 건드리지 않는다.
  - **복사한 임시 index의 수정 시각을 원본과 같게 둔다.** 복사로 시각이 새로 찍히면 git의 racy 검사가 꺼져서, 같은 1초 안에 같은 크기로 바뀐 파일을 "안 바뀜"으로 보고 예전 내용을 담는다. 그러면 체크포인트·셸 편집 기록에서 편집이 조용히 빠진다(M1: 셸 재현에서 시각이 새로 찍힌 복사 6/6회 예전 내용, 시각 보존 0/6회).
- `update-ref`는 항상 **이전 값을 지정(CAS)**한다. 커스텀 ref에는 reflog가 남지 않으므로 덮어쓰기 실수를 되돌릴 수단이 없다. 이력은 커밋 체인(parent)으로만 따라간다.
- **복원 절차**: 복원 직전 상태를 체크포인트로 남김 → 임시 index에 현재 트리를 `read-tree` → `update-index --refresh`로 stat 정보 채움 → `read-tree -m -u <현재 트리> <대상 체크포인트>`. 대상에 없는 파일의 삭제까지 처리되고 사용자 index는 그대로다.
- **복원과 비밀 파일**: 복원은 "현재 트리 → 대상 체크포인트" 두 트리 병합이라, 한쪽에만 있는 파일은 지우거나 만든다. 그래서 체크포인트와 복원은 **반드시 같은 비밀 파일 패턴**을 쓴다(패턴은 GitEngine에 한 번만 정한다). 그러면 비밀 파일은 양쪽 트리에서 모두 빠져 복원해도 지워지지 않는다(M1: 패턴을 빠뜨린 복원이 `.env`를 지우는 버그를 테스트가 잡음). 에픽 도중 패턴이 바뀌면(설정 업그레이드) 다음 체크포인트부터 적용하고, 그 이전 체크포인트로 복원할 때도 현재 패턴의 파일은 건드리지 않는다.

### 8.2 조종수 모델

XP 페어 프로그래밍에서는 드라이버가 작성하고 내비게이터가 방향을 잡는다. 에이전트 시대에는 **에이전트가 작성하고 사람들이 방향을 잡는다**. 그래서 같은 텍스트를 함께 고치는 동시 편집 대신, **한 명이 조종하고 나머지가 실시간으로 보며 의견을 내는** 구조로 한다.

| 역할 | 할 수 있는 일 |
|---|---|
| **조종수** (에픽당 1명) | 작업 폴더 쓰기, 에이전트 실행·지시, 관찰자 의견 처리, 조종 넘기기 |
| **관찰자** (여러 명) | 대화·편집 실시간 보기, 조종수에게 의견 보내기, 쓰레드 작성, 조종 요청 |

- 조종 상태는 서버 ④가 관리한다. 넘길 때마다 `pilot.changed` 메타 이벤트를 남긴다.
- 조종수만 에픽 작업 폴더에 쓸 수 있다.
  - 조종수가 아닌 사람의 에픽 창은 **읽기 전용**으로 열린다(`<epic-id>@live`).
  - 리뷰 사본(§9.3)은 이와 별개로 각자 자유롭게 쓸 수 있다.
- 처음 조종수는 담당자다. 단계마다 조종수를 바꿀 수 있다. 예: 설계 수정 반영은 아키텍트가 직접 조종.

### 8.3 실시간 관찰

조종수 쪽 확장이 두 가지 스트림을 서버 ④로 흘려보낸다. 관찰자의 VS Code에는 약 1초 안에 반영된다.

| 스트림 | 내용 | 관찰자 화면 |
|---|---|---|
| **대화 스트림** | 조종수 세션의 대화: 조종수의 지시, 에이전트 메시지, 도구 호출, 결과. 출처는 두 가지다. ① 훅이 알려준 **세션 기록 파일(`transcript_path`)을 따라 읽기** ② 훅 이벤트 자체. 세션 기록 파일 형식은 공식 규격이 아니므로 너그러운 파서를 쓰고, 읽지 못하면 ②만으로 진행 상황을 보여준다. **§6.4의 허용 목록 필터를 거친 기록만** 보낸다 | Flightdeck 패널의 **읽기 전용 대화 뷰** (입력 기능 없음) |
| **편집 스트림** | 편집 기록(§8.6)을 생기는 즉시 전송 | 읽기 전용 창에 바로 적용. 바뀐 파일·줄 강조, "조종수 커서 따라가기" 선택 가능 |

- **반영 단위는 블록이다.** 세션 기록 파일에는 에이전트 메시지가 토큰 단위가 아니라 블록(생각·도구 호출·텍스트)이 끝날 때마다 기록된다. 블록이 기록된 뒤 관찰자가 읽기까지는 1초 안이다(M0: 85~600ms). 긴 답변이나 긴 생각은 끝날 때까지 보이지 않는다. 그동안은 훅 이벤트(②)로 "작업 중"을 표시한다.
- **사람이 보는 것은 토큰을 쓰지 않는다.** 그래서 관찰자에게는 대화 전체를 보여준다. 에이전트에게 넘기는 맥락만 3계층 기록(§6.4)으로 줄인다.
- 쓰는 사람이 한 명이라 관찰자 쪽은 편집을 **순서대로 적용**만 하면 된다. 충돌 해결이 없다.
- 늦게 들어온 관찰자는 최신 체크포인트와 그 이후 편집 기록을 받아 따라잡는다.
- 개인 에이전트 질문(§3.6)은 조종수의 것이든 관찰자의 것이든 스트림에 포함되지 않는다. 공식 실행만 스트림 대상이다.

### 8.4 의견 (관찰자 → 조종수)

관찰자는 조종하지 않는다. 대신 **조종수에게** 의견을 보낸다. 에이전트에 전달할지는 조종수가 정한다.

- **보내는 곳**
  - 실시간 대화 뷰의 특정 메시지·도구 호출
  - 편집 중인 파일의 특정 줄
  - 일반 의견
- **조종수 쪽 표시**: 의견 패널에 쌓인다. 실행 중이면 상태 바에 배지로 알린다.
- **조종수의 처리**

| 처리 | 동작 |
|---|---|
| **에이전트에 전달** | 그대로 또는 고쳐서 전달 대기열에 넣는다. 에이전트가 실행 중이면 **다음 PostToolUse 훅의 추가 컨텍스트**로 들어간다. 멈춰 있으면 조종수의 다음 프롬프트에 **UserPromptSubmit 훅**이 붙인다. 표시 형식: `[관찰자 @park 의견 · 조종수 전달] …` |
| **급한 의견으로 전달** | 중지·금지처럼 지금 계획을 끊어야 하는 의견. **다음 PreToolUse 훅이 그 도구 호출을 거부**하고 의견을 거부 사유로 돌려준다. 같은 메시지에서 이미 요청된 나머지 도구 호출도 거부한다. 실행 중인 계획을 끊으므로 조종수가 명시적으로 고를 때만 쓴다 |
| **쓰레드로 남기기** | 해당 위치에 쓰레드를 만든다 (공식 기록) |
| **답장** | 관찰자에게만 짧게 답한다 |
| **닫기** | 처리 없이 닫는다 |

- **반영 시점**
  - 일반 전달: PostToolUse로 주입된 의견은 **다음 모델 턴부터** 반영된다. 에이전트가 한 턴에 여러 도구 호출을 이미 요청했다면, 남은 호출은 의견과 무관하게 그대로 실행된다(M0 확인: 파일 3개 쓰기를 한 메시지로 요청한 경우).
  - 급한 의견: **같은 턴 안에서** 반영된다. M0에서 한 메시지로 요청된 파일 쓰기 3개가 모두 거부됐고, 모델은 다음 턴에 의견대로 다시 계획했다.
- **급한 의견의 "같은 메시지" 판정**
  - 직전 거부로부터 **1초 안에** 온 도구 호출을 같은 메시지의 나머지 호출로 보고 거부한다. 그보다 늦으면 새 턴으로 보고 해제한다. 같은 메시지 안의 호출 간격은 수백 ms(M0: 272·280ms)이고, 새 턴은 모델 응답을 기다려야 하므로 보통 수 초 걸린다(M0: 4.5초).
  - transcript로 메시지 ID를 비교하는 방식은 쓰지 않는다. PreToolUse 시점에는 해당 도구 호출이 transcript에 아직 기록되지 않은 경우가 많기 때문이다(§6.1 훅 입출력).
  - 판정이 틀리는 경우는 모델이 1초 안에 다음 턴을 낸 경우다. 그때는 새 턴 첫 호출이 한 번 더 거부되고, 모델이 사유를 보고 다시 시도한다(안전한 쪽으로 틀림).
  - 급한 의견 경로는 훅 오류 시 거부로 응답한다(fail-closed, §6.1).

- **기록**
  - 에이전트에 전달된 의견은 실행 기록의 일부가 된다(세션 원본, handoff에 반영).
  - 나머지 의견과 답장은 관찰 세션이 끝나면 지운다. 남기고 싶으면 "쓰레드로 남기기"를 쓴다.
  - 개인 에이전트 질문을 기록하지 않는 원칙과 같다. 공식 기록은 명시적으로 올린 것만 남긴다.

### 8.5 조종 넘기기

```
관찰자 [조종 요청] ──► 조종수에게 알림 ──► [수락] / [거절]
                                           │
조종수 [조종 넘기기 → 멤버 선택] ─────────────┤
                                           ▼
   1. 에이전트가 실행 중이면 현재 도구 호출이 끝난 뒤 멈춤 (조종수가 "즉시 중단"도 선택 가능)
   2. 조종수가 handoff를 남김 (에이전트 자동 작성 + 조종수 한 줄 메모)
   3. 체크포인트 생성 → push
   4. pilot.changed 이벤트 → 새 조종수의 창이 쓰기 가능으로 전환, 이전 조종수는 관찰자로
   5. 새 조종수가 에픽 작업 폴더에서 Claude Code를 연다
      → SessionStart 훅이 handoff와 실행 기록 검색 도구(§6.4)를 맥락으로 넣는다
```

- **세션을 그대로 이어받지 않는다.** 계정이 달라 이어받을 수 없고, 이어받으면 전체 대화를 다시 읽느라 토큰이 많이 든다. 새 조종수는 **handoff + 필요 시 원본 검색**으로 시작한다(D14).
- **조종수 이탈**: 조종수가 10분 넘게 연결이 끊기면 담당자(또는 다음 순위 멤버)가 **강제 인수**할 수 있다. 서버에 올라온 마지막 편집 기록과 체크포인트에서 이어간다. 강제 인수는 `pilot.changed(reason=takeover)`로 기록한다.

### 8.6 편집 기록 (서버 ③)

확장이 잡는 모든 편집을 **출처와 함께** 하나의 순서열로 기록한다.

| 편집 경로 | 잡는 방법 | 출처 |
|---|---|---|
| 조종수의 에디터 편집 | `onDidChangeTextDocument`. 이벤트 안의 변경들은 모두 이벤트 전 문서 기준 오프셋이므로 뒤에서부터 적용한다. 디스크 재로드 이벤트는 제외한다(§7.4) | `human:<member>` |
| 에이전트 파일 편집 | `tool.before`·`tool.after` 훅이 대상 파일의 **디스크 내용을 직접 읽어** 전후 스냅샷을 뜬다 → 어댑터의 `extractEdits()`가 편집으로 변환. 도구 페이로드(Claude Code의 Edit 변경 전후 문자열, Codex의 패치)는 범위를 잘게 나누는 힌트로만 쓴다 | `agent:<adapter>/<run>/<step>/<prompt_id>/<tool_use_id>` |
| 에이전트 셸 결과 (포맷터·코드 생성 등) | 셸 도구의 `tool.before`·`tool.after`에서 임시 index로 작업 트리 tree를 만들고(`add -A` + `write-tree`, §8.1과 같은 바이트 그대로 옵션), 두 tree의 diff를 편집으로 변환 | `agent_shell:<run>/<step>/<cmd>` |
| 수정 제안 반영 | 패치 적용 | `patch:<thread>/<member>` |
| Flightdeck 렌더링 (문단 ID 부여·복원, 쓰레드 블록) | 확장이 문서를 다시 그릴 때 전후 diff를 편집으로 변환. 기록하지 않으면 편집 기록 재적용 결과가 디스크와 어긋난다(M1: 실제 초안 뒤 어긋남 확인) | `flightdeck:<member>/<paragraph_ids \| thread_render>`. coverage(§7.3)에서 설명이 필요 없는 출처 |
| 체크포인트 복원 | 바뀐 파일마다 파일 전체 교체 (§8.1) | `restore:<member>/<ckpt>/<seq>` |
| 외부 반영 (반영 서버의 main 병합 커밋으로 fast-forward 등, §11.3) | diff를 편집으로 변환 | `external:<commit>` |
| 외부 도구 변경 (Flightdeck 밖 에이전트·에디터·터미널) | 파일 감시. 위 경로에 해당하지 않는 디스크 변경 | `external:unknown` (메모 필수, §7.4) |

```json
{
  "epic": "CU-86abc123", "file": "src/auth/token.ts", "seq": 1842,
  "base_hash": "…",                       // 편집 직전 파일 해시 (순서 검증)
  "range": [1203, 1240], "insert": "…",   // 오프셋 기준 교체
  "source": { "kind": "agent", "member": "dh.lee", "run": "01JB7…", "step": 3, "prompt_id": "…", "tool_use_id": "toolu_…" },
  "ts": "2026-10-02T10:01:22.481+09:00"
}
```

- **오프셋과 해시의 기준**
  - `range`는 UTF-16 code unit 오프셋이다(VS Code `TextDocument`와 같은 기준).
  - `base_hash`는 **디스크 원본 바이트**의 sha256이다. git 블롭이나 줄바꿈을 정규화한 문자열이 아니다.
- **도구 페이로드만으로 기록하지 않는 이유**: Claude Code가 훅에 주는 변경 전 내용(`tool_response.originalFile`)은 줄바꿈이 LF로 바뀌어 있다. 디스크는 CRLF 그대로다. 그래서 페이로드만으로 계산한 오프셋은 CRLF 파일에서 줄마다 어긋난다. M0에서 디스크 스냅샷 방식으로 편집 10건(replace_all, 한글·이모지, CRLF, 끝 개행 없음, 2만 줄 파일, 생성·덮어쓰기, 셸 `sed -i`)을 재적용했고, 파일 10개 모두 해시가 일치했다.
- **범위는 잘게 나눈다.** 전후 스냅샷의 공통 앞뒤만 빼면, 한 번에 여러 곳을 바꾼 편집(replace_all 등)이 바뀌지 않은 부분까지 포함한 큰 덩어리가 된다. 그 안의 앵커(§3.5)는 위치를 잃는다. 줄 단위 → 글자 단위 diff로 나누거나, 페이로드의 바뀐 문자열 위치를 디스크 내용에서 다시 찾는다.
- **쓰기 직렬화**: 조종수는 한 명이어도 한 PC 안에 편집 기록을 쓰는 경로가 여럿이다(질문 공유의 렌더링, 파일 감시·원격 감시의 새로 고침, 에디터 저장, 훅). "재적용으로 기준 계산 → 디스크 쓰기 → 기록 추가"를 **한 묶음으로 직렬화**한다. 확장 안에서는 렌더링 큐로, 훅과 확장 사이는 편집 기록 파일 잠금으로 한다. M2 실측: 두 렌더링이 겹쳐 같은 쓰레드 블록 렌더링이 두 번 기록됐고, 재적용이 범위 밖 오류로 멈춰 화면 갱신·알림이 끊겼다.
- **재적용과 불일치**: 재적용 중 `base_hash`가 현재 내용과 맞지 않는 기록은 **적용하지 않고 불일치로 보고**한다. 다른 내용 위에서 만든 편집이라 적용하면 엉뚱한 결과가 되거나 범위를 벗어난다.
- **출처 오염 방지**: `tool.before`~`tool.after` 사이에 조종수가 에디터로 같은 파일을 고치면 그 변경까지 에이전트 편집으로 잡힌다. 긴 셸 명령(빌드·코드 생성) 동안 생길 수 있다. 확장은 같은 구간의 에디터 편집(`onDidChangeTextDocument`)을 빼고 기록한다.
- **에디터 편집 검증 결과(M0)**: 다중 위치 편집, undo/redo, CRLF 문서(API로 넣은 `\n`이 `\r\n`으로 기록됨), 저장 시 자동 수정(`trimTrailingWhitespace`, `insertFinalNewline`, 저장 직전 별도 이벤트로 옴), 한글 IME 조합까지 재적용 결과가 디스크와 바이트 단위로 같았다.
- **IME 이벤트 묶음**: 한글 IME는 조합 단계마다 이벤트가 온다(한 글자에 2~4건, 예: `ㅊ → 추 → 축`). 같은 위치의 연속 변경을 짧은 간격(예: 300ms)으로 묶어 하나의 편집으로 저장·전송한다. 묶은 결과도 재적용 해시가 같아야 한다.
- **전송**: 생기는 즉시 WebSocket으로 보낸다. 끊겨 있으면 로컬에 쌓았다가 재접속 시 보낸다. 서버는 `base_hash`로 순서를 검증한다.
- **제공하는 조회**
  - 줄 단위 출처: 이 줄은 누가, 어느 실행·Step에서, 어떤 대화 때문에 만들었나
  - 앵커 이동(§3.5)
  - Step별 변경(§7.3)
- **에디터 통합**: 줄에 마우스를 올리면 출처가 보인다. "이 변경의 대화 보기"를 누르면 실행 기록의 해당 메시지를 연다.
- **범위**: 텍스트 파일만 대상이다. 바이너리·생성 파일·의존성 폴더는 `coverage_ignore`와 같은 규칙으로 제외하고, 체크포인트로만 추적한다.
- **보관**: main 반영 후 `retention.editlog_days`(기본 90일)가 지나면 줄 단위 출처 요약만 남기고 원본 편집을 정리한다.

---

## 9. VS Code 확장 UX

### 9.1 진입 흐름

```
일감 등록 (담당자 지정 + flightdeck 태그)
  → 담당자 확장이 60초 주기 조회로 감지 → 알림 "새 에픽 CU-86abc123 · 토큰 갱신 개선 [시작]"
  → [시작] (내부: worktree 생성, epic.md 커밋, push, epic.started 이벤트)
         → 새 창으로 열기 → 백그라운드 claude -p로 분석 초안 작성 (자동 초안, §6.1)
  → 초안 완료 알림 → [이어서 작업]: Claude Code에서 그 세션을 이어서 대화형으로 계속
```

- 첫 에픽의 [이어서 작업] 전에 신뢰를 안내한다(§6.1). 신뢰하지 않으면 Flightdeck 훅이 동작하지 않는다.
  - VS Code: "에픽 작업 폴더의 상위 폴더 `../<repo>.flightdeck/`을 신뢰해 주세요." 한 번 신뢰하면 이후 에픽 창은 묻지 않는다.
  - 터미널 `claude`: "처음 열 때 나오는 신뢰 확인 창에서 'Yes'를 골라 주세요(기본값은 'No, exit')." 레포 기준이라 한 번이면 된다.

### 9.2 화면

- **Activity Bar: Flightdeck**
  - `내 할 일`: 답할 쓰레드, 내 리뷰 차례, 내 에픽
  - `에픽 상세`
    - 단계 진행 바와 티어 승인 현황
    - 열린 쓰레드
    - **조종 상태**: 현재 조종수, 관찰자 목록, 조종 요청
    - **체크포인트 타임라인**: 복원·비교
  - `실시간`
    - 관찰자: 조종수 대화의 **읽기 전용 뷰**. 메시지마다 의견을 남길 수 있다.
    - 조종수: 의견 패널을 본다. 조종수의 대화 화면은 Claude Code 자체이고, Flightdeck는 대화 입력 UI를 만들지 않는다.
  - `실행 기록`: 실행(run)별 handoff 요약. 원본 검색창이 있다.
  - `구현 기록`: impl-log Step이 나온다. 클릭하면 해당 Step의 체크포인트 diff를 연다. 리뷰 포인트 체크리스트와 coverage 요약이 있다.
- **에디터**
  - 라인 선택 → `Flightdeck: 쓰레드 만들기`
  - 줄 hover로 편집 출처를 본다(§8.6).
  - 관찰자는 줄을 선택해 `의견 보내기`를 할 수 있다.
- **상태 바**: `Flightdeck · CU-86abc123 · DESIGN(architect) · 🧑‍✈️ dh.lee · 관찰 2 · 의견 1`
- **명령**: `분석 완료` · `승인` · `수정 요청` · `수정 제안 반영` · `구현 재개` · `회의 시작` · `관찰 시작` · `의견 보내기` · `조종 요청` · `조종 넘기기` · `리뷰 시작` · `내 에이전트에게 묻기`

### 9.3 리뷰 (Delta의 리뷰 하위 스레드에 해당)

1. 검증 리뷰어의 에픽 창은 **리뷰 요청 커밋의 쓰기 가능한 사본**이다(경로는 다른 리뷰어의 읽기 전용 창과 같다, §2.4). 창이 둘이면 어디서 쓰레드를 다는지 헷갈리므로 따로 만들지 않는다. 다시 요청되면 사본이 새 리뷰 커밋으로 옮겨진다(고치던 내용은 옮겨 담는다).
   - 리뷰어와 그 에이전트는 사본을 자유롭게 고치고 테스트를 돌릴 수 있다. 기록하지 않고, git 명령만 막는다(§6.2).
2. 리뷰어의 에이전트는 다음을 컨텍스트로 받는다.
   - 결과물
   - 모든 handoff
   - diff
   - `flightdeck_search_run` 도구
   
   "왜 X를 안 썼나" 같은 질문은 원본을 검색해 답한다.
3. 리뷰 순서
   - design.md 요약을 본다.
   - 구현 기록에서 Step별 의도와 리뷰 포인트를 읽는다.
   - 필요한 Step만 골라 diff를 연다.
   - coverage에서 강조된 hunk(`human`/`agent_shell`)를 확인한다.
4. 리뷰어가 사본에서 고친 내용은 쓰레드에 **수정 제안(패치)**으로 첨부한다. 리뷰어는 에픽 브랜치에 직접 쓰지 않는다.
   - `수정 제안 만들기` = 사본의 리뷰 커밋 대비 diff(`.flightdeck/` 제외)를 새 `change_request` 쓰레드(`thread.created.patch`) 또는 답글(`thread.replied.patch`)에 붙인다. 패치는 메타 이벤트에 그대로 넣고 **64KB**로 제한한다. 붙인 뒤 사본은 리뷰 커밋으로 되돌린다.
   - **조종수**가 `수정 제안 반영`을 누르면 작업 폴더에 `git apply`로 적용한다(맞지 않으면 이유를 알리고 중단, 제안자에게 다시 만들어 달라고 답글). 바뀐 파일은 출처 `patch:<thread>/<member>`로 편집 기록에 남아 메모가 필요 없다(§7.4). `patch.applied {thread, commit: 패치를 만든 리뷰 커밋}`이 남고, 이어서 검증 다시 요청(§4.2)을 한다.
   - 설계 문서 리뷰(M3)는 리뷰 요청 커밋의 읽기 전용 창에서 한다. 리뷰어의 에이전트가 문서·쓰레드를 검사하고, 지시받은 질문·수정 요청·답글을 쓰레드 초안으로 쓴다(§3.2, §3.6). 리뷰어가 확인해 올린다.
5. 승인을 누르면 서버가 검증해 `review.approved`(서버 서명)를 남긴다. 반영 후 리뷰 사본은 정리 대상이 된다.

---

## 10. 실시간 세션 (Google Meet + Gemini)

### 10.1 흐름

```
[회의 시작]
  ① 확장이 Meet API spaces.create로 회의 공간 생성 (가능하면 Gemini 회의록·전사 자동 켜기)
  ② session.started 이벤트 → 참여자 알림 → [참여]: 브라우저로 Meet
  ③ 회의 중: 각자의 확장이 포커스 이벤트 기록 {ts, file, line_range}
[회의 종료]
  ④ 포커스 파일을 메타 브랜치 sessions/<sid>/에 push
  ⑤ 주최자 확장이 회의록 생성 대기 (smartNotes.state == FILE_GENERATED, 1분 간격 폴링)
     주최자에게 "회의록 준비 중(보통 수 분)" 표시. M0: 29분 회의 종료 후 전사 3분, 회의록 4분 안에 생성
     30분이 지나도 생성되지 않으면 아래 "회의록 없음" 경로로 간다. 전사는 있으면 쓴다
     conferenceRecords.list → smartNotes.list → docsDestination.document → Docs API로 본문 조회
     (transcript 사용 시 transcripts.entries도 조회. 페이지 처리)
     회의록이 생성되지 않으면(회의록 꺼짐 등) 포커스 이벤트만으로 에픽 단위 기록을 남긴다
  ⑥ Claude(주최자의 Claude Code)로 앵커링:
     입력 = 회의록 + (전사) + 포커스 이벤트 + 관련 문서 섹션·열린 쓰레드
     출력 = [{target: thread_id | {file, range} | epic, summary, decisions[], actions[]}]
  ⑦ 주최자 검토: 문장 수정 / 삭제 / 앵커 이동
  ⑧ [게시] → thread.replied(source=session) 또는 thread.created + sessions/<sid>.md
```

### 10.2 앵커링 전략

| 우선순위 | 근거 | 사용 조건 |
|---|---|---|
| 1 | 전사 문장 시각 ↔ 그 시각 다수 참여자의 포커스 위치 | transcript 켜짐 |
| 2 | 회의록 내용 ↔ 쓰레드·문서 섹션 의미 유사도 (Claude 판정) | 항상 |
| 3 | 매칭 실패 → 에픽 단위 요약 | — |

**회의록·전사 데이터 형태 (M0 확인)**
- Gemini 회의록과 전사는 **한 Docs 문서의 두 탭**이다(첫 탭: 회의록, 둘째 탭: 전사). `documents.get` 기본 호출은 첫 탭만 돌려준다. 회의록은 첫 탭으로 충분하다.
- 전사는 Docs 탭 텍스트가 아니라 **`transcripts.entries`**를 쓴다. 항목마다 `participant`, `startTime`, `endTime`, `languageCode`, `text`가 있어서 1순위 앵커링(전사 시각 ↔ 포커스 위치)에 바로 쓸 수 있다. 회의 18분에 100건 이상이 나오므로 페이지 처리가 필요하다.

### 10.3 연동 요건

| 항목 | 내용 |
|---|---|
| Google 인증 | 데스크톱 OAuth(PKCE + loopback). Workspace 내부 앱으로 등록 |
| OAuth 범위 | `meetings.space.created`, `documents.readonly`. `meetings.space.created`는 **Flightdeck이 만든 회의 공간만** 조회할 수 있다. 그래서 [회의 시작]으로 연 회의만 대상이고, 일반 Meet 링크로 연 회의는 가져오지 않는다. 범위를 추가하면 기존 액세스 토큰을 버리고 새로 받는다 |
| 요금제 | Gemini 회의록: Business Standard/Plus, Enterprise Standard/Plus 등 |
| 언어 | 한국어 지원, 회의당 한 언어 |
| 회의 길이 | 권장 15분 이상 |
| 주최자 | 회의 시작자 = 주최자 = 게시 담당 |

---

## 11. main 반영 (LANDING) — 반영 서버

PR 없이 반영한다. 사용자에게는 "반영 중 → 완료"만 보인다. main push는 **반영 서버만** 할 수 있다.

### 11.1 흐름

1. 서버가 마지막 검증 티어 승인(→ LANDING)에 서명하면 **바로 반영 작업(job)을 등록**한다. 승인 서명은 서버가 하므로 확장을 거칠 필요가 없다. `land.requested` 이벤트는 쓰지 않는다.
2. 서버는 작업을 비동기로 처리하고, 결과를 `epic.landed` 또는 `land.rejected` 이벤트로 메타 브랜치에 남긴다. 확장은 이 이벤트를 기다린다.
3. **보조 경로**: 서버는 1분마다 메타 브랜치를 확인해, LANDING(`pending`)인데 처리되지 않은 에픽을 처리한다(재시작 복구). 담당자는 `POST /land`로 다시 걸 수 있다.

### 11.2 서버 API

| API | 설명 |
|---|---|
| `GET /auth/login`, `GET /auth/callback` | Google 로그인 (§12) |
| `GET /me` | 로그인한 멤버 정보(멤버 ID, 그룹) |
| `GET /config?product=<p>` | 서버가 서명한 설정 (§2.5) |
| `POST /events` | 서버 서명 이벤트 요청 `{type, epic, data}` → 검증 후 서명·메타 push → `{event}` (§3.1, §12) |
| `POST /land` | `{product, epic}` → `202 {job}` (재시도용. 보통은 서버가 스스로 건다) |
| `GET /land/<job>` | 진행 상태 |
| `GET /health` | 상태 확인 |
| `/admin/*` | 어드민 화면: 멤버 등록·비활성, 제품별 파이프라인·룰 편집, 설정 버전·변경 이력 (어드민 멤버만) |

- 모든 요청은 로그인 세션 토큰이 필요하다(`/health`, `/auth/*` 제외). 토큰은 확장의 `SecretStorage`에 보관한다.
- 서버는 사내망에만 둔다.

### 11.3 서버 검증·반영 절차

서버는 클라이언트가 계산한 결과를 믿지 않고 **처음부터 다시 계산**한다. 같은 `packages/core`를 쓰므로 판정 기준은 같다.

```
1. fetch: main, flightdeck/<epic>, flightdeck-meta
2. epic.started의 config_version으로 서버 DB에서 파이프라인 로드
3. reducer 재실행
   - 서버 서명 이벤트의 서명 검증
   - 단계 순서, 각 티어 승인의 유효성 (멤버·순서·artifact_hash)
   - 열린 쓰레드 / change_request 0
   - 검증한 커밋(landing.commit) = 원격 에픽 브랜치 끝
4. 형식 검증: impl-log (analysis·design·handoff는 단계 통과 때 이미 검증)
5. coverage 재계산: 서버 ③의 편집 기록으로 hunk별 출처·Step 조회 (M7 이후.
   그 전에는 담당자 확장의 관문 검사와 서명된 단계 완료를 신뢰)
6. 테스트 보고 확인 (A안): 검증한 커밋의 gate.reported 서명 유효, 모든 exit 0
   └─ 3~6 중 하나라도 실패 → land.rejected(invalid) → IMPLEMENTATION
7. main이 검증한 커밋의 조상이 아니면 (main이 움직였음, on_main_moved: recheck)
   main을 에픽 브랜치에 병합한다. rebase하지 않는다: 에픽 브랜치 이력을 다시 쓰지 않아
   담당자 작업 폴더·체크포인트가 갈라지지 않고, squash라 이력 모양은 main에 남지 않는다
   ├─ git merge-tree로 작업 폴더 없이 판정. 충돌 → land.rejected(conflict) → IMPLEMENTATION
   │        에이전트가 충돌 해결 Step 추가 → 검증 단계 재진입 (reapproval 정책 적용)
   └─ 병합 커밋(부모: 검증한 커밋, main)을 에픽 브랜치에 push (fast-forward)
        → land.rejected(needs_report, rebased_sha=병합 커밋) → LANDING(needs_report)
        → 담당자 확장이 작업 폴더를 그 커밋으로 fast-forward(바뀐 파일은 external:<commit>)
          → commands 실행 → gate.reported(병합 커밋)
        → 서버가 그 보고에 서명하면서 LANDING(pending)으로 돌리고 바로 반영 작업을 다시 건다
          (사람의 재승인은 필요 없음. 확장이 꺼져 있으면 열 때 이어서 한다)
8. squash 커밋 = main 위에 검증한 커밋의 tree. `.flightdeck/epics/<epic>/` 아래는
   landing.records.keep에 맞는 것만 남기고, threads/code.json은 그 시점 코드 쓰레드로 서버가 만든다.
   메시지 = 일감 제목 + trailer:
     Flightdeck-Epic: CU-86abc123
     Flightdeck-Config: <config_version>
     Flightdeck-Approvals: <review.approved 이벤트 id 목록>
     Flightdeck-Landed-By: flightdeck-server
9. main fast-forward push (봇 자격 증명)
   └─ 경합으로 거절 → 1부터 재시도 (최대 3회)
10. epic.landed (서버 서명) → 메타 push → DONE
11. 정리: 에픽 브랜치 삭제. 메타 디렉터리 정리, ckpt/runs ref는 retention 후 삭제(예약, 이후)
```

- 일감 상태를 DONE으로 바꾸는 일은 `epic.landed`를 받은 확장이 개인 토큰으로 한다(§1.4 reconcile). 서버는 일감 도구 토큰을 갖지 않는다.

### 11.4 우회 차단

- **차단**
  - 내장 git 서버: `pre-receive`가 서버 외의 main push를 거부한다(§1.5). 외부 미러의 main도 서버 봇만 쓸 수 있게 둔다.
  - 외부 git: 저장소 호스트에서 main 쓰기를 **서버 봇 계정만** 허용한다. force push도 금지한다. 처음에 한 번 설정하면 된다.
  - 개발자 계정과 에이전트는 main에 쓸 수 없다.
- **감사(이중 안전장치)**
  - 확장은 계속 main 이력을 검사한다.
  - 시작점은 메타 브랜치의 가장 오래된 `epic.started.base_sha`다. Flightdeck 도입 전 커밋은 보지 않는다.
  - 그 뒤 main first-parent 커밋 중 trailer `Flightdeck-Epic`이 없거나, 그 에픽의 서명된 `epic.landed.main_commit`과 다른 커밋이 보이면 경고한다(VS Code 알림, 출력 창).
  - 어드민이 확인한 커밋은 `landing.audit_allow`(§5)에 넣어 예외로 둔다.
  - 봇 자격 증명 유출과 외부 git의 보호 설정 누락을 감지하기 위한 장치다(M5: 시험 레포에 직접 push한 커밋 2개를 잡음).

### 11.5 서버 운영

| 항목 | 내용 |
|---|---|
| 형태 | flightdeck-server 컨테이너 1개(모듈 ①~④) + PostgreSQL. TypeScript, `core`·`git`·`schema` 패키지 재사용 |
| 통신 | REST(설정·반영) + WebSocket(편집 기록 전송, 실시간 중계, 의견) |
| 저장 | PostgreSQL: 멤버, 설정 버전·변경 이력, 로그인 세션, 편집 기록, 조종·관찰 세션 상태, 반영 작업. 디스크: 내장 git 레포(백업 대상) 또는 외부 레포 미러 캐시 |
| 상태 | 반영 작업은 재시작 시 메타 브랜치를 다시 훑어 복구한다. 편집 기록은 DB에 영속한다. 실시간 스트림은 메모리 중계만 하고 저장하지 않는다(원본은 실행 기록 §6.4) |
| 비밀 | ① main·메타 브랜치 push 자격 증명: 봇 SSH 키 또는 토큰, **해당 레포 쓰기만** ② 서버 서명 개인키 ③ DB 자격 증명 ④ Google OAuth 클라이언트 비밀 |
| 배치 | 사내망 |
| 장애 시 | 반영·새 에픽 시작·단계 완료·승인·실시간 관찰이 멈춘다. **조종수의 작업은 계속된다.** 쓰레드·답글도 메타 브랜치라 계속된다. 편집 기록은 로컬에 쌓았다가 복구 후 재전송한다 |

---

## 12. 서명과 신뢰

PR 리뷰라는 외부 증거가 없다. 그래서 **단계를 넘기는 이벤트**의 진위를 **서버 서명**으로 보장한다. **신뢰의 기준점은 서버**다. 서버는 로그인한 멤버의 요청을 파이프라인 기준으로 검증한 뒤에만 서명한다.

| 키 | 생성 | 공개키 배포 | 서명 대상 |
|---|---|---|---|
| 서버 키 (ed25519) | 서버 설치 시. 개인키는 서버 비밀 저장소 | 설정 응답에 포함, 지문은 확장 설정 | 설정 응답, 서버 서명 이벤트(§3.1 표의 ✅) |

멤버 개인 키는 두지 않는다. 멤버의 신원은 **Google 로그인**으로 확인한다.

- **멤버 등록**: 관리자가 어드민 화면에서 멤버 ID, Google 계정 이메일, 그룹, 일감 도구 사용자 ID를 등록한다. 등록되지 않은 계정은 로그인해도 쓸 수 없다.
- **로그인**: 확장이 브라우저로 서버의 Google 로그인을 열고, 서버가 등록된 이메일인지 확인해 세션 토큰을 준다. 확장은 `GET /me`로 내 멤버 ID를 알고, 일반 이벤트의 `author`에 쓴다.
- **서명 요청**: 확장이 `POST /events`로 단계 통과 이벤트를 요청하면, 서버는 메타 브랜치를 fetch해 reducer로 현재 상태를 계산하고 다음을 확인한다. 모두 맞으면 `author`=요청자로 서명해 push한다.
  - 요청자가 파이프라인상 그 이벤트를 낼 수 있는 사람인가(담당자, 해당 티어 그룹 멤버)
  - 지금 그 이벤트를 낼 차례인가(단계·티어 순서, 관문 조건: 열린 쓰레드 0 등)
  - `artifact_hash`가 에픽 브랜치의 산출물과 같은가
- **서버 키 최초 신뢰**: 관리자가 확장 설정 두 가지를 팀에 배포한다.
  - `flightdeck.serverUrl`
  - `flightdeck.serverKeyFingerprint`
  
  확장은 설정 응답과 서버 서명 이벤트를 이 지문의 키로 검증한다.
- **reducer가 무시하는 이벤트**
  - 서버 서명이 필요한데 서명이 없거나 틀린 이벤트
  - 권한 밖의 일반 이벤트(작성자 기준, §3.4)
- **멤버 비활성**: 관리자가 어드민에서 비활성으로 바꾸면 서버가 그 뒤의 요청을 받지 않는다. 이미 서명된 이벤트는 유효하다. 일반 이벤트는 서명이 없으므로, 비활성 이후 시각의 일반 이벤트는 reducer가 무시한다.

---

## 13. 코드베이스 구성

```
flightdeck/
├── docs/design.md
├── packages/
│   ├── schema/    # zod 스키마: 이벤트, pipeline.yaml, impl-log, handoff, state
│   ├── core/      # reducer, 서버 서명 검증, 쓰레드 렌더/파싱, 위치 추적, coverage (순수 로직)
│   ├── git/       # GitEngine: worktree·체크포인트·ref·세션 원본·push (확장 내부 전용)
│   ├── tracker/   # TrackerAdapter + clickup
│   ├── agent/     # AgentAdapter 인터페이스 + claude-code 구현 (codex, gemini-cli는 이후)
│   ├── hook/      # flightdeck-hook: 모든 에이전트 훅의 공통 진입점. 어댑터로 입출력 변환 후 공통 처리 (세션 등록·룰 주입·권한·편집 기록·의견 전달·체크포인트), 확장과 로컬 IPC
│   ├── mcp/       # flightdeck MCP 서버 (search_run 포함)
│   ├── server/    # flightdeck-server: config(어드민·설정·서명) · landing · editlog · live 모듈
│   └── vscode/    # VS Code 확장
└── examples/
    └── flightdeck-config/   # 제품 설정 예시 (pipeline.yaml, rules/). 서버 초기 데이터로 가져올 수 있다
```

---

## 14. 마일스톤

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **M0 스파이크** | ① Comments API를 markdown에 적용 ② 대화형 Claude Code + worktree의 `settings.local.json` 훅(권한 차단·trace·사용자 설정과 병합, `.mcp.json` 최초 승인 흐름) ③ 훅 추가 컨텍스트로 **실행 중** 의견 전달(PostToolUse)과 단계 룰 갱신(UserPromptSubmit)이 되는지 ③-1 headless 초안 세션을 대화형으로 이어가기(resume) ③-2 `transcript_path` 세션 기록 파일 실시간 읽기 ④ Meet 회의록·전사 조회 ⑤ 메타 브랜치 동시 push ⑥ 체크포인트 숨은 커밋 push/fetch ⑦ 에디터·에이전트·셸 편집을 오프셋 편집 기록으로 빠짐없이 잡을 수 있는지(재적용 시 파일 해시 일치)<br>**결과(2026-10-02, 완료)**: ①~⑦ 모두 **가능**. "불가" 없음 ([m0-results.md](m0-results.md)). ④는 지난 회의 조회와 실제 회의의 회의록 생성 시간(4분 이내)까지 확인했다. Flightdeck 자체 OAuth 앱 + `meetings.space.created`로 연 회의의 회의록 자동 켜기는 M6에서 확인한다 | 각 항목 가능/불가 판정 |
| **M1 로컬 단일 사용자** | core reducer·렌더러, **문단 ID + 편집 추적**, GitEngine 기초, **AgentAdapter 인터페이스 + claude-code 어댑터**, ANALYSIS 에이전트, handoff | 혼자 분석 → 설계 초안 |
| **M2 원격 협업** | 서버 서명 이벤트, 메타 브랜치 EventStore, 알림, ClickUp 일감 수신, **서버 어드민(멤버·설정) + 설정 배포**, Google 로그인<br>**결과(2026-10-04, 완료)**: 실제 VS Code 두 창(멤버 둘, 한 PC) + GitHub + 서버 + ClickUp으로 분석 Q&A 전 단계 통과 ([m2-plan.md](m2-plan.md)). Google 로그인(OAuth 클라이언트 없음, 개발용 로그인으로 진행)과 실제 여러 사람의 사용은 완성 뒤 확인한다 | 2인이 원격으로 분석 Q&A |
| **M3 설계 티어** | 리뷰 요청·티어 승인(서버 서명), reapproval, 리뷰어 없는 티어 건너뛰기, 수정 요청 쓰레드, 리뷰어 창의 에이전트(리뷰 정책, 쓰레드 초안 블록)<br>**결과(2026-10-04, 완료)**: 실제 VS Code 세 창(담당자·lead·architect)에서 리뷰어의 에이전트(실제 claude)가 쓴 수정 요청 초안 → 올리기 → 담당자 수정·재요청 → 1티어부터 재승인 → 2티어 승인으로 IMPLEMENTATION ([m3-plan.md](m3-plan.md)) | 설계가 2티어 통과 |
| **M4 구현·기록** | 구현 에이전트, **체크포인트**, impl-log·trace, Step별 coverage, **세션 원본 저장·검색**, 테스트 결과 보고(M5에서 당김)<br>**결과(2026-10-05, 완료)**: 실제 VS Code 두 창에서 에이전트(실제 claude)가 2 Step 구현·기록 → 사람 직접 수정·외부 변경으로 제출 차단 → 메모 → 서명된 테스트 보고·구현 완료로 VERIFICATION → 다른 멤버의 에이전트가 세션 원본을 검색해 결정 근거를 찾음 ([m4-plan.md](m4-plan.md)) | 설명 없는 hunk 차단 확인 |
| **M5 검증·반영** | 코드 쓰레드, **리뷰 사본 + 수정 제안**, **반영 서버 검증·main 병합·squash·main push**, main 보호 설정, 감사<br>**결과(2026-10-05, 완료)**: 실제 VS Code 세 창(담당자·검증 lead·qa)에서 리뷰어의 에이전트(실제 claude)가 리뷰 사본에서 고친 수정 제안 → 담당자 반영·다시 요청 → 1티어부터 재승인 → 2티어 승인 → main 이동으로 병합 커밋·자동 재보고 → 서버가 main에 squash push·`epic.landed`로 DONE → main 감사가 직접 push 커밋을 잡음 ([m5-plan.md](m5-plan.md)). GitHub main 보호 설정은 봇 방식 결정 뒤(§15) | 실제 에픽 1개가 서버를 통해 main까지 |
| **M6 회의** | Meet 연동, 포커스 이벤트, 회의록 앵커링. Flightdeck OAuth 앱으로 만든 회의 공간의 회의록 자동 켜기·`meetings.space.created` 범위 확인(M0에서 넘어옴) | 회의 요약이 올바른 쓰레드에 게시 |
| **M7 편집 기록** | 서버 ③, 편집 경로 4종 수집, 줄 단위 출처 조회, 앵커·coverage를 편집 기록 기반으로 전환, impl-log `changes` 자동 생성 | 모든 hunk의 출처가 조회되고, 쓰레드가 대규모 수정 후에도 위치 유지 |
| **M8 조종수 모델** | 서버 ④, 대화·편집 실시간 스트림, 관찰자 읽기 전용 창, 의견 보내기·처리, 조종 요청·넘기기·강제 인수 | 관찰자가 1초 안에 조종수 작업을 보고, 의견이 에이전트까지 전달됨 |
| **M5.5 내장 git 서버** | git smart HTTP, 로그인 세션 기반 credential helper, `pre-receive` ref 규칙(§1.5), 외부 미러(main·태그), 백업. 외부 git 방식은 그대로 지원 | M5의 에픽 흐름이 내장 git 서버로 main까지 가고, 규칙 위반 push(메타 이벤트 수정, 남의 이름 이벤트, main 직접 push)가 거부됨 |
| **M9 에이전트 확장** | codex 어댑터 → gemini-cli 어댑터 → jcode 등 (훅 세부 확인 후 등급 결정), 지원 등급 표시, 에이전트 혼용 조종 넘기기 | Claude Code → Codex로 조종을 넘겨 같은 에픽을 main까지 반영 |

---

## 15. 미결 사항

1. **개인 구독 사용량 한도**: 긴 구현 실행이 한도에 걸릴 수 있다. `max_turns`와 모델 선택으로 조절한다.
2. **저장소 크기**: 체크포인트와 세션 원본의 retention 기본값(14일/30일)이 적절한지 시범 운영 후 조정한다.
3. **서버 배치와 봇 계정** (M5 전까지)
   - 서버 배치: flightdeck-server(컨테이너 + PostgreSQL + 레포 미러 디스크)를 둘 환경, DB 방식, 팀원 접속 경로(사내망/VPN, 도메인·TLS), 비밀값 보관 위치
   - git 호스트: 기본은 **내장 git 서버**(D21, 2026-10-04). 외부 미러·외부 git 방식에서는 **GitHub**(2026-10-01 확정). 봇 방식(GitHub App / deploy key / 봇 사용자)과 계정 생성·키 교체 담당은 미정
   - main 보호 설정: 봇만 쓰기, force push 금지. `flightdeck-meta` force push·삭제 금지(§2.1). 커미터 이름·이메일
   - TeamCity의 main push 여부: 버전 올림 커밋·태그 등이 있으면 허용 목록 추가 또는 반영 서버로 이전
   - 어드민 멤버 지정, 서버용 Google OAuth 클라이언트 발급
4. **서버 테스트 재실행(B안)**: 이후 추가. 테스트 실행 환경(DB 등 의존성) 구성 방식은 그때 정한다.
5. **제품명 사용 가능 여부**: 외부 공개 전에 "Flightdeck"이 VS Code 마켓플레이스, npm 패키지 이름(`flightdeck`, `@flightdeck/*`), 도메인, 상표에서 비어 있는지 확인해야 한다.

### 해결됨
- 에이전트 과금 → 개인 Claude 구독 + Claude Code CLI (D9)
- 일감 도구 토큰 → 개인 토큰 + reconcile (D10)
- 기록 누적 → 정리 정책 (D11, §11.3, §2.1)
- PR 의존 제거 → 서버 서명 이벤트 승인 + 반영 서버 (D12, D13, §11, §12)
- 실행 맥락 공유 비용 → 3계층 기록 (D14, §6.4)
- main 우회 → 서버 봇만 main 쓰기 + 감사 (§11.4)
- pipeline.yaml 조작 → 서버 DB + 어드민 + 에픽별 버전 고정 (D15, §2.5)
- 테스트 검증 수준 → A안, 서버가 받아 서명한 보고 신뢰 (D16, §7.5)
- 실시간 협업 방식 → 조종수 1명 + 관찰자 + 의견, 동시 편집 없음 (D17, §8.2~8.5)
- 편집 출처 정확도 → 서버 편집 기록 (D18, §8.6)
- 직접 수정 설명 → 메모 필수, 외부 도구 변경도 감지해 메모 필수 (§7.4)
- Claude Code 내부 형식 의존 → **버전 업 시 즉시 대응**. 운영 방식:
  - 확장이 Claude Code 버전을 **세션마다** 확인한다. 세션 기록 파일의 각 줄에 있는 `version`을 쓴다. Claude Code는 자동 업데이트되므로 확장 시작 시 한 번 확인하는 것으로는 부족하다(M0 중 2.1.285 → 2.1.286 업데이트를 실제로 겪음).
  - 검증된 버전 목록에 없으면 관찰 뷰를 **훅 이벤트만 쓰는 최소 모드**로 자동 전환하고, 관리자에게 알린다.
  - 세션 기록 파일 파서는 실제 세션 기록 샘플로 회귀 테스트한다.
- 특정 에이전트 의존 → AgentAdapter + 지원 등급, 관문은 에이전트 무관 (D20, §6.5)
- Workspace 요금제 → 사용 중인 요금제가 Gemini 회의록을 지원함 (2026-10-01 확인)
- Remote Control → Flightdeck 범위 밖. 사용자가 자기 Claude Code 세션에서 알아서 사용 (Flightdeck 실행기는 headless라 연동하지 않음)
