# Flightdeck — 설계 문서 v0.8

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
| D12 | git의 역할 | **저장소로만 사용**. 사용자는 git을 직접 다루지 않으며, 모든 git 명령은 확장이 실행. git 호스트는 push/fetch 대상일 뿐(GitHub·GitLab·Gitea·SSH 무관) |
| D13 | 승인·반영 | **PR 없음**. 승인은 메타 브랜치의 **서명된 이벤트**. 마지막 검증 티어가 승인하면 **반영 서버가 검증 후 main에 push**. main push 권한은 서버 봇 계정만 가짐 |
| D14 | 실행 맥락 공유 | 세션 원본을 통째로 넘기지 않음. **결과물 + 인수인계 기록**을 기본으로 하고, 원본은 **필요할 때 검색해 일부만** 사용 (토큰 절감) |
| D15 | 설정 관리 | pipeline.yaml·rules·멤버 공개키는 관리자만 push할 수 있는 **설정 레포**에 둔다. 서버가 읽어 서명해 배포한다. 에픽은 시작할 때 설정 버전을 고정 |
| D16 | 테스트 검증 | **A안**: 서버는 서명·티어·해시·diff 대조·형식만 다시 검증하고, lint/test는 실행자의 **서명된 결과 보고**를 신뢰. 서버 재실행(B안)은 이후 추가 |
| D17 | 협업 방식 | **조종수 1명 + 실시간 관찰자**. 동시 편집 없음. 관찰자는 대화·편집을 실시간으로 보고 **조종수에게** 의견을 낸다. 에이전트에 전달할지는 조종수가 정한다. 조종은 요청·수락으로 넘긴다 (§8) |
| D18 | 편집 출처 | 확장이 잡은 모든 편집(에디터·에이전트·셸 결과·외부 반영)을 **편집 기록**으로 서버에 저장. 쓰는 사람이 한 명이라 기록이 하나의 순서열이 되어, 충돌 해결 없이 위치 고정과 출처 조회가 정확함 (§8.6) |
| D19 | Claude Code 연동 방식 | **대화 UI를 다시 만들지 않는다.** Claude Code의 공식 확장 지점(SessionStart·UserPromptSubmit·PreToolUse·PostToolUse·Stop 훅, MCP 서버)에만 붙는다. Claude Code 기능과 업데이트는 그대로 따라감. Zed(ACP) 등 다른 에디터에서도 같은 연동이 동작 |
| D20 | 에이전트 확장 | 에이전트별 차이는 **AgentAdapter** 안에 가둔다(§6.5). 1차 Claude Code, 이후 Codex CLI → Gemini CLI → jcode 등. 지원 등급(완전·부분·최소)에 따라 기능이 달라지지만 **관문은 동일**. 한 에픽 안에서 에이전트를 섞어 쓸 수 있음 |

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
│  상태 계산(reducer) · 서명 검증 · 쓰레드 렌더/파싱 · 위치 추적 · coverage │
│                          │                                           │
│              Git Engine (확장 내부 전용, 사용자 노출 없음)               │
│   worktree: 에픽 / 리뷰 / 관찰(읽기 전용) / 메타                        │
└──────┬──────────────────────────────┬────────────────┬───────────────┘
       │ git fetch/push                │ REST           │ REST
       │ (main 제외)                    │                │
┌──────▼───────────────────┐  ┌───────▼──────┐  ┌──────▼────────────────┐
│ Git 원격 저장소            │  │ 일감 도구      │  │ Google Workspace      │
│  main  ◄── 서버만 push     │  │ (ClickUp →    │  │  Meet API · Docs API  │
│  flightdeck/<epic>         │  │  Jira 등)     │  └───────────────────────┘
│  flightdeck-meta           │  └──────────────┘
│  refs/flightdeck/*         │
│  flightdeck-config (별도)   │◄── 관리자만 push
└──────▲───────────────────┘
       │ fetch / main push (봇 자격 증명)
┌──────┴───────────────────────────────────────┐
│ flightdeck-server                              │◄── 확장: REST + WebSocket
│  ① 설정 배포 (서버 서명)                        │
│  ② 반영: 검증 → rebase → main push             │
│  ③ 편집 기록: 편집 순서열 저장, 출처·위치 조회     │
│  ④ 실시간 중계: 조종수 → 관찰자 (대화·편집 스트림), │
│     관찰자 → 조종수 (의견), 조종 넘기기            │
│  PostgreSQL (편집 기록·세션 상태)                │
└──────────────────────────────────────────────┘
```

### 1.1 진실의 원천(Source of Truth)

| 데이터 | 원천 | 비고 |
|---|---|---|
| 문서 본문, 코드, impl-log | 에픽 브랜치 `flightdeck/<epic-id>` | 확장이 커밋 |
| 쓰레드·댓글·승인·단계 전환 | 메타 브랜치 `flightdeck-meta` | **서명된** 이벤트 파일, append-only (§3.1, §12) |
| 진행 중 작업 상태 | 체크포인트 ref `refs/flightdeck/ckpt/…` | §8.1 |
| 편집 기록 (출처 포함) | **flightdeck-server ③** | §8.6. git 체크포인트는 편집 기록 위치(seq)를 참조 |
| 조종 상태·관찰 세션 | **flightdeck-server ④** | §8.2. 조종 넘기기 결과는 메타 이벤트로도 남김 |
| 에이전트 세션 원본 | 실행 ref `refs/flightdeck/runs/<epic-id>` | §6.4 |
| 회의 요약 | Google Docs (Gemini 회의록) | 가져와서 메타 이벤트로 변환 |
| 파이프라인·룰·멤버 공개키 | **설정 레포** `flightdeck-config` | 서버가 서명해 배포 (§2.5) |
| 완료된 결과 | `main` | **반영 서버만 push** (§11) |

- 현재 상태는 모든 확장이 **같은 reducer(`packages/core`)**로 계산한다. 입력은 메타 이벤트와 에픽 브랜치다.
- 서명이 유효하지 않거나 권한이 없는 이벤트는 reducer가 무시한다.

### 1.2 Git 사용 원칙

- 사용자는 브랜치, 커밋, push, 병합을 **보지도 다루지도 않는다.** 확장의 `GitEngine`만 git을 호출한다.
- 사용자에게 보이는 개념은 **에픽, 단계, 쓰레드, 승인, 체크포인트**뿐이다.
- 사용자 편집 저장: 사람이 worktree에서 편집하면 확장이 체크포인트로 자동 저장한다(§8.1). 단계 전환이나 제출 때는 에픽 브랜치에 커밋한다.
- 충돌 처리
  - 쓰레드 블록 영역은 렌더링 결과라 충돌이 생기지 않는다.
  - 문서 본문이 충돌하면 확장의 병합 화면에서 "내 것 / 상대 것 / 직접 수정"으로 고른다. git 용어는 노출하지 않는다.
- 원격 인증
  - 사용자 PC의 기존 git 자격 증명(SSH 키, credential helper)을 쓴다. 호스트 API는 쓰지 않는다.
  - 개발자 계정에는 **main push 권한이 없다.** 저장소 호스트에서 main 보호 설정을 한 번 해 두고, 서버 봇 계정만 허용한다. PR 기능이 아니라 브랜치 쓰기 권한만 설정한다.

### 1.3 저장 인터페이스

```ts
interface EventStore {
  append(event: SignedEvent): Promise<void>;       // 메타 브랜치에 파일 추가 + push
  list(epicId: string): Promise<SignedEvent[]>;
  watch(onChange: () => void): Disposable;         // ls-remote 폴링
}
```

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

- 체크포인트와 세션 원본은 크기가 크다. 그래서 **별도 ref**에 둔다. ref를 지우면 원격 저장소에서 실제로 공간이 회수된다(gc).
- fetch 설정(refspec)은 확장이 관리한다.

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
    ├── events/<ULID>-<member>.json    # 파일 1개 = 서명된 이벤트 1개
    └── sessions/<sid>/focus-<member>.jsonl
```

### 2.4 로컬 worktree (확장이 관리, 사용자는 "창"으로만 인식)

| 경로 | 용도 |
|---|---|
| `../<repo>.flightdeck/<epic-id>` | 에픽 작업 폴더 (담당자, 질문 받은 사람) |
| `../<repo>.flightdeck/<epic-id>#review-<member>` | 리뷰 전용 사본 (§9.3) |
| `../<repo>.flightdeck/<epic-id>@live` | 관찰자용 읽기 전용 창. 조종수의 편집 스트림이 실시간 적용됨 (§8.3) |
| `../<repo>.flightdeck/<epic-id>#ask` | 조종수의 개인 질문용 읽기 전용 사본. 현재 체크포인트 기준 (§3.6) |
| `../<repo>.flightdeck/_meta` | 메타 브랜치 |

### 2.5 설정 레포 `flightdeck-config` (관리자만 push)

```
flightdeck-config/
├── server.pub                      # 반영 서버 공개키
├── members/<member>.pub            # 멤버 공개키 (§12)
└── products/<product>/             # 제품 레포별 설정
    ├── pipeline.yaml               # §5
    └── rules/{common,analysis,design,implementation,verification}.md
```

- **관리자의 push = 설정 승인**이다. 별도 관리 화면 없이 git 이력이 변경 감사 기록이 된다. 관리자는 일반 git 도구로 이 레포를 다룬다. 사용자 git 비노출 원칙(D12)은 일반 참여자에게만 적용한다.
- **설정 버전** = 설정 레포 커밋 해시.
- **배포**
  - 확장이 `GET /config?product=<p>`로 설정을 받는다. 응답은 `{version, pipeline, rules, members}`이고 서버 서명이 붙는다.
  - 받은 설정을 `.flightdeck/.runtime/config/<version>/`에 캐시한다.
  - 서버가 죽어 있으면 캐시를 쓴다. 단, 새 에픽 시작과 반영은 할 수 없다.
- **버전 고정**
  - `epic.started`에 `config_version`을 기록한다. reducer와 서버는 그 에픽을 **고정된 버전의 파이프라인**으로 판정한다.
  - 진행 중 에픽에 새 설정을 적용하려면 담당자가 "설정 업그레이드"를 해야 한다. `epic.config_upgraded` 이벤트가 남고, 이미 받은 승인은 새 규칙으로 다시 판정한다.
- 에픽 브랜치에서 설정을 고칠 수 없다. 레포 안에 설정 파일이 없고, 에이전트의 `.flightdeck/.runtime/` 쓰기도 차단한다.

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
  "data": { "thread": "t-01JB2X4K", "body": "30분, 슬라이딩 갱신입니다." },
  "sig": "ed25519:…"
}
```

| 이벤트 타입 | data |
|---|---|
| `epic.started` | tracker_ref, owner, base_sha, config_version |
| `epic.config_upgraded` | from_version, to_version |
| `thread.created` | thread, phase, file, anchor(§3.5), kind, to[], body |
| `thread.replied` | thread, body, source(`human`\|`agent`\|`session`), patch?(수정 제안, §9.3) |
| `thread.resolved` / `thread.reopened` | thread |
| `thread.moved` | thread, anchor |
| `patch.applied` | thread, commit |
| `phase.completed` | phase (담당자의 "분석 완료" 등) |
| `review.approved` | phase, tier, artifact_hash (§4.2) |
| `review.edited` | phase, commit |
| `phase.reverted` | from, to, reason |
| `run.started` / `run.finished` | run_id, phase, member, ckpt_from, ckpt_to |
| `gate.reported` | commit, commands[{cmd, exit, summary, log_hash}] (실행자 서명, §7.5) |
| `pilot.changed` | from, to, reason(`handoff`\|`request`\|`takeover`), ckpt, handoff_run (§8.5) |
| `land.requested` | head_sha |
| `epic.landed` | main_commit, approvals[] (**서버 서명**) |
| `land.rejected` | reason, details (**서버 서명**) |
| `session.started` / `session.ended` / `session.published` | sid, … |

- 파일 이름은 `<ULID>-<member>.json`이다. 내용 충돌이 없다. push가 거절되면 `fetch → rebase → push`를 자동으로 재시도한다.
- 쓰레드 ID는 `t-<ULID 앞 8자>`다.

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
  - 확장이 문서의 모든 문단·제목 앞에 붙인다. 쓰레드 앵커는 이 ID를 가리킨다.
  - 에이전트와 사람은 ID를 지우거나 바꾸면 안 된다. 저장할 때 확장이 검사해 복원한다(§6.2).
  - 새 문단에는 확장이 저장 시 새 ID를 붙인다.
- 쓰레드 블록은 확장이 관리하는 렌더링 영역이다. 직접 수정해도 다시 렌더링하면 사라진다.

### 3.3 코드 쓰레드

- 앵커: `{file, ckpt|commit, range, context(앞뒤 3줄), symbol?}`
- VS Code **Comments API**로 거터에 표시한다.
- `kind`
  - `question`: 질문
  - `change_request`: 수정 요청
  - `note`: 참고

### 3.4 생명주기와 권한

| 동작 | 권한 |
|---|---|
| 생성 | 해당 단계 담당자 / 현재 티어 리뷰어 |
| 답글 | 쓰레드 참여자 + 멘션 대상 |
| resolve / reopen | 쓰레드 생성자 (분석 단계에서는 담당자) |
| 수정 제안 반영 | 담당자 |

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
| 3 | **diff 줄 매핑** + `git blame -M -C` | 편집 기록 밖에서 들어온 변경(main rebase 등). 가져온 diff도 "외부 반영" 편집으로 기록되므로 대부분 1번으로 처리됨 |
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
  - 두 곳 모두 훅이 쓰기와 셸을 차단한다. 기록되지 않는 경로로 코드가 바뀌는 것을 막기 위해서다.
- **"쓰레드에 올리기"**: 사용자가 명시적으로 올린 내용만 기록한다.

### 3.7 알림

| 상황 | 방법 |
|---|---|
| VS Code 실행 중 | 20초마다 `ls-remote`로 확인 → 바뀌었으면 fetch → reducer 결과에서 나에게 해당하는 항목을 VS Code 알림으로 표시 |
| VS Code 꺼짐 | 행위자의 확장이 일감 도구에 @멘션 댓글을 남김 (리뷰 차례, 질문 대상) |

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
| DESIGN | `agent_drafting` → `owner_review` → `tier[1..n]_review` | `design.md`, handoff | 각 티어 `review.approved` + 열린 쓰레드 0 |
| IMPLEMENTATION | `agent_working` → `log_finalizing` → `gate_check` | 코드, impl-log, trace, handoff | 스키마 + coverage 100% + 명령 통과 |
| VERIFICATION | `owner_review` → `tier[1..n]_review` | 코드 쓰레드 | 각 티어 `review.approved` + 열린 change_request 0 |
| LANDING | `requested` → `server_verifying` → `pushing` | main 커밋 | 서버의 `epic.landed` (§11) |
| DONE | — | — | — |

### 4.2 티어 승인 (서명된 이벤트)

- 티어 차례가 되면 행위자의 확장이 다음 리뷰어에게 VS Code 알림과 일감 도구 멘션을 보낸다.
- 승인 = `review.approved` 이벤트이고, 리뷰어 개인 키로 서명한다(§12).
  - `artifact_hash`: 승인 시점 산출물의 해시. 설계 단계는 `design.md`, 검증 단계는 에픽 브랜치 tree 해시.
- reducer가 승인을 유효로 인정하는 조건
  - 서명이 유효하다.
  - 리뷰어가 해당 티어 멤버다.
  - 현재 차례의 티어다.
  - `reapproval: on_change`이면 `artifact_hash`가 현재 산출물과 같다. 다르면 그 티어부터 다시 승인받는다.
- 리뷰어 직접 수정: 확장이 에픽 브랜치에 커밋하고 `review.edited` 이벤트를 남긴다.
- 수정 요청: `change_request` 쓰레드를 만든다. 리뷰 사본에서 만든 **수정 제안(패치)**을 붙일 수 있다(§9.3).

### 4.3 되돌림

- VERIFICATION에서 "구현 재개"를 누르면 IMPLEMENTATION으로 돌아간다.
  - 에이전트는 change_request 쓰레드와 직전 handoff를 입력으로 작업한다.
  - impl-log에는 **새 Step을 추가**한다.
- LANDING 실패(충돌, 게이트 재검사 실패)도 IMPLEMENTATION으로 돌아간다(§11).
- DESIGN에서 분석 누락이 발견되면 ANALYSIS로 되돌릴 수 있다.

---

## 5. pipeline.yaml

위치: `flightdeck-config/products/<product>/pipeline.yaml` (§2.5)

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

members:                           # 공개키는 flightdeck-config/members/
  groups:
    leads: [kim]
    architects: [park, lee]
    qa: [choi]
  tracker_ids:
    dh.lee: 1111111
    kim: 1234567
    park: 2345678

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
      tiers:
        - { name: lead,      reviewers: { group: leads },      min_approvals: 1 }
        - { name: architect, reviewers: { group: architects }, min_approvals: 1 }
    skip:
      - when: { tracker_tags: [bugfix], size: [XS, S] }
        tiers: [architect]

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

session:
  provider: google_meet
  gemini_notes: required
  transcript: optional
  notify_mentions_via_tracker: true

landing:
  target: main
  strategy: squash                 # squash | merge
  on_main_moved: recheck           # recheck: 서버 재검증 + 실행자 재보고 통과 시 재승인 불필요
  test_verification: reported      # reported(A안: 서명된 보고 신뢰) | server_run(B안, 이후)
  records:
    keep: [epic.md, analysis.md, design.md, impl-log.md, runs/, threads/, sessions/]
    drop: [trace.jsonl, state.json]

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
| 편집 기록·trace·앵커·체크포인트 | **PostToolUse 훅** | §7.2, §8.6 |
| 관찰자 의견 전달 | **PostToolUse / UserPromptSubmit 훅** 추가 컨텍스트 | §8.4 |
| 실행 종료 | **Stop 훅** | handoff 작성 요청, 체크포인트, `run.finished` |
| Flightdeck 도구 | **MCP 서버** | 아래 표 |

#### 설정 배치

확장은 에픽 worktree에 다음 파일을 만들고 git 추적에서 뺀다(`.git/info/exclude`).
- `.claude/settings.local.json`: 훅 등록, Flightdeck MCP 서버 활성화, 권장 기본 모델(`pipeline.agent.model`)
- `.mcp.json`: flightdeck MCP 서버

사용자 전역 설정(`~/.claude/`)은 건드리지 않는다. 모델은 **권장 기본값**일 뿐이며 조종수가 `/model`로 바꿀 수 있다.

#### 자동 초안 (headless)

- 일감 접수 직후의 분석 초안처럼 사람이 없는 실행만 백그라운드 `claude -p`로 돌린다.
  - 같은 훅이 적용된다. `settings.local.json`이 worktree에 있기 때문이다.
- 끝나면 확장이 조종수에게 알린다. 조종수는 그 세션을 **이어서(resume)** 대화형으로 계속한다. 본인 계정·본인 PC이므로 이어가기가 가능하다.

#### 강제의 위치

- 사용자는 worktree의 Claude Code 설정을 고쳐 훅을 끌 수 있다. 그래서 **훅은 편의와 즉시 피드백을 위한 장치이고, 강제는 관문이 한다.**
- 훅을 끄고 고친 내용은 다음 경로로 걸러진다.
  - 파일 감시에 "외부 도구" 변경으로 잡혀 메모가 필수가 된다(§7.4).
  - diff 대조와 반영 서버 검증에서 걸린다.
- 정확한 훅 입출력(추가 컨텍스트 필드, 실행 중 전달 가능 여부), `.mcp.json` 최초 승인 흐름, resume 동작은 M0에서 확정한다.

| MCP 도구 | 설명 |
|---|---|
| `flightdeck_get_epic` | 일감 원문, 현재 단계 |
| `flightdeck_list_threads` | 단계·상태별 쓰레드 |
| `flightdeck_get_handoffs` | 이전 실행들의 인수인계 기록 |
| `flightdeck_search_run` | **세션 원본 검색**: 관련 구간만 반환 (§6.4) |
| `flightdeck_reply_thread` | 에이전트 답글 (수정 요청 반영 시에만) |
| `flightdeck_log_step` | impl-log Step 추가 (+ 체크포인트 생성) |
| `flightdeck_submit` | 산출물 제출 → 로컬 게이트 검사 |

### 6.2 단계별 도구 권한 (PreToolUse 훅)

| 단계 | 쓰기 허용 | 셸 |
|---|---|---|
| ANALYSIS | `analysis.md`, `runs/<run-id>/handoff.md` | 읽기 전용 허용 목록 |
| DESIGN | `design.md`, `runs/<run-id>/handoff.md` | 읽기 전용 허용 목록 |
| IMPLEMENTATION | `.flightdeck/` 제외 전체 + `impl-log.md`, handoff | 허용 (**모든 git 명령 차단**, `rm -rf` 등 차단) |
| VERIFICATION | 없음 | 테스트 실행만 |

- 에이전트도 git 명령을 쓸 수 없다. 버전 관리는 확장만 한다(D12).
- 모든 단계에서 다음 경로의 읽기·쓰기를 차단한다. 설정 캐시와 훅·MCP 설정을 에이전트가 조작하는 것을 막기 위해서다.
  - `.flightdeck/.runtime/`
  - 어댑터의 `protectedPaths()`. 예: Claude Code는 `.claude/settings.local.json`, `.mcp.json`. Codex는 `.codex/`
- 표의 "쓰기", "셸"은 공통 개념이다. 실제 도구 이름(Edit/Write/Bash, apply_patch/shell 등)은 어댑터가 공통 이벤트로 바꿔 판정한다.
- 저장할 때마다 다음을 검사한다. 위반하면 원복하고 경고를 남긴다.
  - 쓰레드 블록 변경
  - 문단 ID(`p:`) 삭제·변경

### 6.3 산출물 스키마

- `analysis.md`: `## 요구사항 요약`, `## 영향 범위`, `## 불명확한 점`, `## 가정`
- `design.md`: `## 개요`, `## 변경 컴포넌트`, `## 인터페이스`, `## 데이터 변경`, `## 테스트 계획`, `## 리스크`

### 6.4 실행 기록 3계층 (토큰 절감형 맥락 공유)

세션 원본을 통째로 공유하면 토큰이 많이 든다. 이어받는 쪽이 전체 대화를 다시 읽어야 하고, 프롬프트 캐시는 계정 단위라 다른 사람에게는 효과가 없다. 그래서 다음 실행자와 리뷰어에게는 **결과물과 인수인계 기록**을 기본으로 주고, 원본은 **필요할 때 검색**하게 한다.

| 계층 | 내용 | 크기 | 로딩 |
|---|---|---|---|
| 1. 결과물 | analysis/design.md, impl-log, 쓰레드 | 작음 | 항상 |
| 2. 인수인계 기록 `runs/<run-id>/handoff.md` | 실행 마지막에 에이전트가 작성 (형식 강제) | 수 KB | 항상 |
| 3. 세션 원본 | Claude Code 세션 JSONL. 비밀값 제거 후 압축, `refs/flightdeck/runs/<epic-id>`에 저장 | 큼 | `flightdeck_search_run`으로 **관련 구간만** |

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
- 비밀값 제거
  - 환경변수 값, 토큰 패턴(정규식), `.env` 내용을 저장 전에 가린다.
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
  extractEdits(e: ToolEvent): Edit[];              // Edit/Write, apply_patch 등 → 공통 편집 기록 (§8.6)
  transcript?(s: SessionRef): AsyncIterable<TranscriptItem>; // 관찰 뷰·원본 검색용
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
3. **impl-log `changes`는 편집 기록으로 자동 생성한다.** 에이전트는 Step마다 의도·결정·대안·리뷰 포인트만 쓴다. 파일·줄 범위를 직접 쓰지 않는다.
4. **설명 없는 변경**의 정의
   - Step에 속하지 않는 에이전트 편집
   - Step 설명이 비어 있는 편집
   - **메모가 없는 직접 수정**: 출처가 `human` 또는 `external`인 편집(§7.4)
5. 설명 없는 변경이 1개라도 있으면 게이트가 실패한다. `coverage_ignore`는 제외한다.
6. 같은 계산을 **반영 서버가 서버의 편집 기록으로 다시 한다**(§11.3).
7. **보조 수단**: 편집 기록이 없는 구간(서버 장애 중 재전송 실패 등)은 체크포인트 체인 diff(`ckpt(Step n-1) → ckpt(Step n)`)로 추적한다. 해당 hunk는 "기록 누락"으로 표시해 리뷰어에게 보여준다.

### 7.4 직접 수정 메모 (필수)

사람이 에이전트를 거치지 않고 고친 코드는 **반드시 메모가 있어야** 한다. 메모가 없으면 구현 게이트와 반영 서버 검증을 통과하지 못한다.

| 대상 | 출처 | 메모를 받는 방법 |
|---|---|---|
| 조종수의 에디터 편집 | `human:<member>` | 확장이 연속된 직접 수정을 **수정 묶음**으로 자동으로 묶는다(같은 파일, 2분 이내 간격). 체크포인트 생성 시나 제출 전에 "메모 필요 n건" 패널에서 묶음마다 한 줄 메모를 쓴다 |
| 리뷰어의 직접 수정 (`review.edited`) | `human:<member>` | 커밋 전에 메모 입력창이 뜬다. 메모 없이는 커밋되지 않는다 |
| 외부 도구 변경 | `external:unknown` | 아래 "외부 변경 감지" 참고. 직접 수정과 같은 방식으로 메모를 받는다 |
| 수정 제안 반영 | `patch:<thread>/<member>` | 연결된 쓰레드가 설명이므로 메모가 필요 없다 |

- 메모는 수정 묶음 단위로 편집 기록에 붙는다(`edit_group.memo`). 리뷰어는 구현 기록의 해당 Step 옆에서 "직접 수정 n건 + 메모"를 본다.
- 메모 형식: 한 줄 이상. 선택적으로 관련 쓰레드나 설계 문단(`design.md#p:xxxx`)을 연결할 수 있다.

**외부 변경 감지**
- 확장은 에픽 작업 폴더를 파일 감시한다.
- 디스크 변경이 다음 세 경로 어디에도 해당하지 않으면 출처 `external:unknown`으로 편집 기록에 남긴다.
  - VS Code 에디터 편집
  - Flightdeck 실행 에이전트의 hooks
  - 그 에이전트의 셸 명령 구간
- 예: 직접 띄운 Claude Code, 다른 에디터, 터미널 명령
- 감지 즉시 조종수에게 "Flightdeck 밖에서 수정됨" 알림을 띄운다.

### 7.5 테스트 결과 보고 (A안)

- 구현 게이트의 `commands`(lint/test)는 **에이전트가 아니라 확장**이 직접 실행한다. 에이전트가 결과를 꾸밀 수 없게 하기 위해서다.
- 실행 결과는 실행자의 키로 서명해 `gate.reported` 이벤트로 남긴다.
  - 내용: 대상 커밋, 명령별 종료 코드, 요약, 로그 해시
  - 전체 로그는 `refs/flightdeck/runs/<epic-id>`에 보관한다.
- 서버는 다음만 확인한다. 테스트를 다시 돌리지는 않는다.
  - 보고가 **반영 대상 커밋**에 대한 것인가
  - 서명이 유효한가
  - 모든 명령의 종료 코드가 0인가
- **신뢰 경계**: 보고를 꾸미려면 확장을 고의로 변조해야 한다. 그래도 **누가 통과를 보고했는지**는 서명으로 남는다.
- 서버 재실행(B안)은 `landing.test_verification: server_run`으로 이후 추가한다.

---

## 8. 작업 공유

### 8.1 체크포인트

- 체크포인트는 **브랜치와 작업 트리를 건드리지 않는 숨은 커밋**이다. 임시 index + `write-tree` + `commit-tree` + `update-ref`로 만든다.
- 생성 시점
  - 에이전트: `flightdeck_log_step`마다, 그리고 편집 후 30초 유휴 시
  - 사람: 저장 시(디바운스 10초)
- 커밋 메시지 trailer: `Flightdeck-Run`, `Flightdeck-Step`, `Flightdeck-Source(agent|human)`
- 생성 직후 push한다(`refs/flightdeck/ckpt/<epic-id>/<member>`).
- **되돌리기**: Phase Panel의 타임라인에서 아무 체크포인트나 골라 "이 시점으로 복원"을 할 수 있다. 복원 직전 상태도 체크포인트로 남겨서 복원을 취소할 수 있다.
- **비교**: 두 체크포인트 사이 diff를 보여준다.

- 체크포인트에는 그 시점의 편집 기록 순번(`Flightdeck-Seq`)을 trailer로 남긴다. git 스냅샷과 편집 기록이 서로를 가리킨다.

### 8.2 조종수 모델

XP 페어 프로그래밍에서는 드라이버가 작성하고 내비게이터가 방향을 잡는다. 에이전트 시대에는 **에이전트가 작성하고 사람들이 방향을 잡는다**. 그래서 같은 텍스트를 함께 고치는 동시 편집 대신, **한 명이 조종하고 나머지가 실시간으로 보며 의견을 내는** 구조로 한다.

| 역할 | 할 수 있는 일 |
|---|---|
| **조종수** (에픽당 1명) | 작업 폴더 쓰기, 에이전트 실행·지시, 관찰자 의견 처리, 조종 넘기기 |
| **관찰자** (여러 명) | 대화·편집 실시간 보기, 조종수에게 의견 보내기, 쓰레드 작성, 조종 요청 |

- 조종 상태는 서버 ④가 관리한다. 넘길 때마다 `pilot.changed` 메타 이벤트(서명)를 남긴다.
- 조종수만 에픽 작업 폴더에 쓸 수 있다.
  - 조종수가 아닌 사람의 에픽 창은 **읽기 전용**으로 열린다(`<epic-id>@live`).
  - 리뷰 사본(§9.3)은 이와 별개로 각자 자유롭게 쓸 수 있다.
- 처음 조종수는 담당자다. 단계마다 조종수를 바꿀 수 있다. 예: 설계 수정 반영은 아키텍트가 직접 조종.

### 8.3 실시간 관찰

조종수 쪽 확장이 두 가지 스트림을 서버 ④로 흘려보낸다. 관찰자의 VS Code에는 약 1초 안에 반영된다.

| 스트림 | 내용 | 관찰자 화면 |
|---|---|---|
| **대화 스트림** | 조종수 세션의 대화 전체: 조종수의 지시, 에이전트 메시지, 도구 호출, 결과. 출처는 두 가지다. ① 훅이 알려준 **세션 기록 파일(`transcript_path`)을 따라 읽기** ② 훅 이벤트 자체. 세션 기록 파일 형식은 공식 규격이 아니므로 너그러운 파서를 쓰고, 읽지 못하면 ②만으로 진행 상황을 보여준다 | Flightdeck 패널의 **읽기 전용 대화 뷰** (입력 기능 없음) |
| **편집 스트림** | 편집 기록(§8.6)을 생기는 즉시 전송 | 읽기 전용 창에 바로 적용. 바뀐 파일·줄 강조, "조종수 커서 따라가기" 선택 가능 |

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
| **쓰레드로 남기기** | 해당 위치에 쓰레드를 만든다 (공식 기록) |
| **답장** | 관찰자에게만 짧게 답한다 |
| **닫기** | 처리 없이 닫는다 |

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
| 조종수의 에디터 편집 | `onDidChangeTextDocument` | `human:<member>` |
| 에이전트 파일 편집 | `tool.after` 훅 → 어댑터의 `extractEdits()` (Claude Code는 Edit/Write 변경 전후, Codex는 패치) | `agent:<adapter>/<run>/<step>/<message_id>` |
| 에이전트 셸 결과 (포맷터·코드 생성 등) | 명령 전후 파일 감시 → diff를 편집으로 변환 | `agent_shell:<run>/<step>/<cmd>` |
| 수정 제안 반영 | 패치 적용 | `patch:<thread>/<member>` |
| 외부 반영 (main rebase 등) | diff를 편집으로 변환 | `external:<commit>` |
| 외부 도구 변경 (Flightdeck 밖 에이전트·에디터·터미널) | 파일 감시. 위 경로에 해당하지 않는 디스크 변경 | `external:unknown` (메모 필수, §7.4) |

```json
{
  "epic": "CU-86abc123", "file": "src/auth/token.ts", "seq": 1842,
  "base_hash": "…",                       // 편집 직전 파일 해시 (순서 검증)
  "range": [1203, 1240], "insert": "…",   // 오프셋 기준 교체
  "source": { "kind": "agent", "member": "dh.lee", "run": "01JB7…", "step": 3, "message": "msg_…" },
  "ts": "2026-10-02T10:01:22.481+09:00"
}
```

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

1. 리뷰어가 `리뷰 시작`을 누르면 **리뷰 전용 사본**(`<epic-id>#review-<member>`)이 에픽 HEAD 기준으로 생긴다.
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
4. 리뷰어가 사본에서 고친 내용은 쓰레드에 **수정 제안(패치)**으로 첨부한다. 담당자가 `수정 제안 반영`을 누르면 에픽 브랜치에 적용되고 `patch.applied`가 남는다.
5. 승인을 누르면 `review.approved`(서명)가 남는다. 리뷰 사본은 정리 대상이 된다.

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
  ⑤ 주최자 확장이 회의록 생성 대기
     conferenceRecords.list → smartNotes.list → docsDestination → Docs API로 본문 조회
     (transcript 사용 시 transcripts.entries도 조회)
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

### 10.3 연동 요건

| 항목 | 내용 |
|---|---|
| Google 인증 | 데스크톱 OAuth(PKCE + loopback). Workspace 내부 앱으로 등록 |
| OAuth 범위 | `meetings.space.created`, `documents.readonly` |
| 요금제 | Gemini 회의록: Business Standard/Plus, Enterprise Standard/Plus 등 |
| 언어 | 한국어 지원, 회의당 한 언어 |
| 회의 길이 | 권장 15분 이상 |
| 주최자 | 회의 시작자 = 주최자 = 게시 담당 |

---

## 11. main 반영 (LANDING) — 반영 서버

PR 없이 반영한다. 사용자에게는 "반영 중 → 완료"만 보인다. main push는 **반영 서버만** 할 수 있다.

### 11.1 흐름

1. 마지막 검증 티어가 승인하면 승인자의 확장이 `land.requested` 이벤트를 남기고 `POST /land`를 호출한다.
2. 서버는 작업(job)을 비동기로 처리하고, 결과를 `epic.landed` 또는 `land.rejected` 이벤트로 메타 브랜치에 남긴다. 확장은 이 이벤트를 기다린다.
3. **보조 경로**: 서버도 1분마다 메타 브랜치를 확인한다. LANDING 상태인데 처리되지 않은 에픽이 있으면 처리한다. 확장의 호출이 실패했을 때를 위한 것이다.

### 11.2 서버 API

| API | 설명 |
|---|---|
| `GET /config?product=<p>` | 서버가 서명한 설정 (§2.5) |
| `POST /land` | `{epic, head_sha}` → `202 {job}` |
| `GET /land/<job>` | 진행 상태 |
| `GET /health` | 상태 확인 |

- 모든 요청은 **멤버 키 서명**이 필요하다. 서명 대상은 메서드, 경로, 본문 해시, 시각이다. 시각 오차는 ±5분까지 허용한다.
- 서버는 사내망에만 둔다.

### 11.3 서버 검증·반영 절차

서버는 클라이언트가 계산한 결과를 믿지 않고 **처음부터 다시 계산**한다. 같은 `packages/core`를 쓰므로 판정 기준은 같다.

```
1. fetch: main, flightdeck/<epic>, flightdeck-meta, refs/flightdeck/ckpt|runs/<epic>
2. epic.started의 config_version으로 설정 레포에서 파이프라인·멤버 공개키 로드
3. reducer 재실행
   - 모든 이벤트 서명 검증 (설정 레포 공개키 기준)
   - 단계 순서, 각 티어 승인의 유효성 (멤버·순서·artifact_hash)
   - 열린 쓰레드 / change_request 0
4. 형식 검증: analysis·design 섹션, impl-log, handoff
5. coverage 재계산: 서버 ③의 편집 기록으로 hunk별 출처·Step 조회
   (기록 누락 구간은 체크포인트 체인 diff로 보조)
6. 테스트 보고 확인 (A안): head_sha에 대한 gate.reported의 서명 유효, 모든 exit 0
   └─ 3~6 중 하나라도 실패 → land.rejected(reason) → 담당자에게 알림
7. main 위로 rebase (서버 작업 디렉터리)
   ├─ 충돌 → land.rejected(conflict) → IMPLEMENTATION으로 되돌림
   │        에이전트가 충돌 해결 Step 추가 → 검증 단계 재진입 (reapproval 정책 적용)
   └─ main이 base 이후 움직였음 (on_main_moved: recheck)
        → rebase 결과를 에픽 브랜치에 push (force-with-lease)
        → 서버가 rebase 결과로 coverage 재계산
        → land.rejected(needs_report, rebased_sha)
        → 담당자 확장이 자동으로 commands 실행 → gate.reported → POST /land 재요청
          (사람의 재승인은 필요 없음)
8. landing.records.drop 제거 → squash 커밋. trailer는 다음과 같다:
     Flightdeck-Epic: CU-86abc123
     Flightdeck-Config: <config_version>
     Flightdeck-Approvals: <review.approved 이벤트 id 목록>
     Flightdeck-Landed-By: flightdeck-server
9. main fast-forward push (봇 자격 증명)
   └─ 경합으로 거절 → 1부터 재시도 (최대 3회)
10. epic.landed (서버 서명) → 메타 push
11. 정리 예약: 에픽 브랜치 삭제, 메타 디렉터리 정리, ckpt/runs ref는 retention 후 삭제
```

- 일감 상태를 DONE으로 바꾸는 일은 `epic.landed`를 받은 확장이 개인 토큰으로 한다(§1.4 reconcile). 서버는 일감 도구 토큰을 갖지 않는다.

### 11.4 우회 차단

- **차단**
  - 저장소 호스트에서 main 쓰기를 **서버 봇 계정만** 허용한다. force push도 금지한다. 처음에 한 번 설정하면 된다.
  - 개발자 계정과 에이전트는 main에 쓸 수 없다.
- **감사(이중 안전장치)**
  - 확장은 계속 main 이력을 검사한다.
  - trailer가 없거나 대응하는 `epic.landed` 서버 서명이 없는 커밋이 보이면 관리자에게 경고한다.
  - 봇 자격 증명 유출을 감지하기 위한 장치다.

### 11.5 서버 운영

| 항목 | 내용 |
|---|---|
| 형태 | flightdeck-server 컨테이너 1개(모듈 ①~④) + PostgreSQL. TypeScript, `core`·`git`·`schema` 패키지 재사용 |
| 통신 | REST(설정·반영) + WebSocket(편집 기록 전송, 실시간 중계, 의견) |
| 저장 | PostgreSQL: 편집 기록, 조종·관찰 세션 상태, 반영 작업. 디스크: 레포 미러 캐시 |
| 상태 | 반영 작업은 재시작 시 메타 브랜치를 다시 훑어 복구한다. 편집 기록은 DB에 영속한다. 실시간 스트림은 메모리 중계만 하고 저장하지 않는다(원본은 실행 기록 §6.4) |
| 비밀 | ① main push 자격 증명: 봇 SSH 키 또는 토큰, **해당 레포 쓰기만** ② 서버 서명 개인키 ③ DB 자격 증명 |
| 배치 | 사내망 |
| 장애 시 | 반영·새 에픽 시작·실시간 관찰이 멈춘다. **조종수의 작업은 계속된다.** 편집 기록은 로컬에 쌓았다가 복구 후 재전송한다. 쓰레드·승인은 메타 브랜치라 영향이 없다 |

---

## 12. 서명과 신뢰

PR 리뷰라는 외부 증거가 없다. 그래서 승인의 진위를 **서명**으로 보장한다. **신뢰의 기준점은 설정 레포**다. 이 레포는 관리자만 push할 수 있다.

| 키 | 생성 | 공개키 위치 | 서명 대상 |
|---|---|---|---|
| 멤버 키 (ed25519) | 확장 최초 실행 시. 개인키는 `SecretStorage` | `flightdeck-config/members/<member>.pub` | 모든 이벤트, 서버 API 요청 |
| 서버 키 (ed25519) | 서버 설치 시. 개인키는 서버 비밀 저장소 | `flightdeck-config/server.pub` | 설정 응답, `epic.landed`, `land.rejected` |

- **멤버 등록**
  1. 신규 멤버가 확장에서 `키 등록 요청`을 실행한다. 공개키와 지문이 표시되고, 관리자에게 일감 도구 멘션이 간다.
  2. 관리자가 설정 레포 `members/`에 공개키를 push한다.
  3. 서버와 확장이 다음 설정 조회 때 반영한다.
- **서버 키 최초 신뢰**: 관리자가 확장 설정 두 가지를 팀에 배포한다.
  - `flightdeck.serverUrl`
  - `flightdeck.serverKeyFingerprint`
  
  확장은 설정 응답의 서명을 이 지문으로 검증한다.
- **reducer가 무시하는 이벤트**
  - 서명이 없거나 틀린 이벤트
  - 설정 레포에 없는 키의 이벤트
  - 권한 밖의 이벤트
  - 서버 키가 아닌 키로 서명된 `epic.landed`/`land.rejected`
- **키 폐기**: 관리자가 설정 레포에서 공개키를 `members/revoked/<member>-<시각>.pub`로 옮긴다. 폐기 시각 이전 이벤트는 유효하다.

---

## 13. 코드베이스 구성

```
flightdeck/
├── docs/design.md
├── packages/
│   ├── schema/    # zod 스키마: 이벤트, pipeline.yaml, impl-log, handoff, state
│   ├── core/      # reducer, 서명 검증, 쓰레드 렌더/파싱, 위치 추적, coverage (순수 로직)
│   ├── git/       # GitEngine: worktree·체크포인트·ref·rebase·push (확장 내부 전용)
│   ├── tracker/   # TrackerAdapter + clickup
│   ├── agent/     # AgentAdapter 인터페이스 + claude-code 구현 (codex, gemini-cli는 이후)
│   ├── hook/      # flightdeck-hook: 모든 에이전트 훅의 공통 진입점. 어댑터로 입출력 변환 후 공통 처리 (세션 등록·룰 주입·권한·편집 기록·의견 전달·체크포인트), 확장과 로컬 IPC
│   ├── mcp/       # flightdeck MCP 서버 (search_run 포함)
│   ├── server/    # flightdeck-server: config · landing · editlog · live 모듈
│   └── vscode/    # VS Code 확장
└── examples/
    └── flightdeck-config/   # 설정 레포 템플릿 (pipeline.yaml, rules/, members/)
```

---

## 14. 마일스톤

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **M0 스파이크** | ① Comments API를 markdown에 적용 ② 대화형 Claude Code + worktree의 `settings.local.json` 훅(권한 차단·trace·사용자 설정과 병합, `.mcp.json` 최초 승인 흐름) ③ 훅 추가 컨텍스트로 **실행 중** 의견 전달(PostToolUse)과 단계 룰 갱신(UserPromptSubmit)이 되는지 ③-1 headless 초안 세션을 대화형으로 이어가기(resume) ③-2 `transcript_path` 세션 기록 파일 실시간 읽기 ④ Meet 회의록·전사 조회 ⑤ 메타 브랜치 동시 push ⑥ 체크포인트 숨은 커밋 push/fetch ⑦ 에디터·에이전트·셸 편집을 오프셋 편집 기록으로 빠짐없이 잡을 수 있는지(재적용 시 파일 해시 일치) | 각 항목 가능/불가 판정 |
| **M1 로컬 단일 사용자** | core reducer·렌더러, **문단 ID + 편집 추적**, GitEngine 기초, **AgentAdapter 인터페이스 + claude-code 어댑터**, ANALYSIS 에이전트, handoff | 혼자 분석 → 설계 초안 |
| **M2 원격 협업** | 서명 이벤트, 메타 브랜치 EventStore, 알림, ClickUp 일감 수신, **설정 레포 + 서버의 설정 배포**, 멤버 키 등록 | 2인이 원격으로 분석 Q&A |
| **M3 설계 티어** | 티어 승인(서명), reapproval, 수정 요청 반영 | 설계가 2티어 통과 |
| **M4 구현·기록** | 구현 에이전트, **체크포인트**, impl-log·trace, Step별 coverage, **세션 원본 저장·검색** | 설명 없는 hunk 차단 확인 |
| **M5 검증·반영** | 코드 쓰레드, **리뷰 사본 + 수정 제안**, 테스트 결과 보고, **반영 서버 검증·rebase·main push**, main 보호 설정, 감사 | 실제 에픽 1개가 서버를 통해 main까지 |
| **M6 회의** | Meet 연동, 포커스 이벤트, 회의록 앵커링 | 회의 요약이 올바른 쓰레드에 게시 |
| **M7 편집 기록** | 서버 ③, 편집 경로 4종 수집, 줄 단위 출처 조회, 앵커·coverage를 편집 기록 기반으로 전환, impl-log `changes` 자동 생성 | 모든 hunk의 출처가 조회되고, 쓰레드가 대규모 수정 후에도 위치 유지 |
| **M8 조종수 모델** | 서버 ④, 대화·편집 실시간 스트림, 관찰자 읽기 전용 창, 의견 보내기·처리, 조종 요청·넘기기·강제 인수 | 관찰자가 1초 안에 조종수 작업을 보고, 의견이 에이전트까지 전달됨 |
| **M9 에이전트 확장** | codex 어댑터 → gemini-cli 어댑터 → jcode 등 (훅 세부 확인 후 등급 결정), 지원 등급 표시, 에이전트 혼용 조종 넘기기 | Claude Code → Codex로 조종을 넘겨 같은 에픽을 main까지 반영 |

---

## 15. 미결 사항

1. **개인 구독 사용량 한도**: 긴 구현 실행이 한도에 걸릴 수 있다. `max_turns`와 모델 선택으로 조절한다.
2. **저장소 크기**: 체크포인트와 세션 원본의 retention 기본값(14일/30일)이 적절한지 시범 운영 후 조정한다.
3. **서버 배치와 봇 계정** (M5 전까지)
   - 서버 배치: flightdeck-server(컨테이너 + PostgreSQL + 레포 미러 디스크)를 둘 환경, DB 방식, 팀원 접속 경로(사내망/VPN, 도메인·TLS), 비밀값 보관 위치
   - git 호스트 종류와 봇 방식: GitHub App / deploy key / 프로젝트 토큰 / 봇 사용자. 계정 생성·키 교체 담당
   - main 보호 설정: 봇만 쓰기, force push 금지. 커미터 이름·이메일
   - TeamCity의 main push 여부: 버전 올림 커밋·태그 등이 있으면 허용 목록 추가 또는 반영 서버로 이전
   - 설정 레포 관리자 지정
4. **서버 테스트 재실행(B안)**: 이후 추가. 테스트 실행 환경(DB 등 의존성) 구성 방식은 그때 정한다.
5. **제품명 사용 가능 여부**: 외부 공개 전에 "Flightdeck"이 VS Code 마켓플레이스, npm 패키지 이름(`flightdeck`, `@flightdeck/*`), 도메인, 상표에서 비어 있는지 확인해야 한다.

### 해결됨
- 에이전트 과금 → 개인 Claude 구독 + Claude Code CLI (D9)
- 일감 도구 토큰 → 개인 토큰 + reconcile (D10)
- 기록 누적 → 정리 정책 (D11, §11.3, §2.1)
- PR 의존 제거 → 서명 이벤트 승인 + 반영 서버 (D12, D13, §11, §12)
- 실행 맥락 공유 비용 → 3계층 기록 (D14, §6.4)
- main 우회 → 서버 봇만 main 쓰기 + 감사 (§11.4)
- pipeline.yaml 조작 → 설정 레포 + 에픽별 버전 고정 (D15, §2.5)
- 테스트 검증 수준 → A안, 서명된 보고 신뢰 (D16, §7.5)
- 실시간 협업 방식 → 조종수 1명 + 관찰자 + 의견, 동시 편집 없음 (D17, §8.2~8.5)
- 편집 출처 정확도 → 서버 편집 기록 (D18, §8.6)
- 직접 수정 설명 → 메모 필수, 외부 도구 변경도 감지해 메모 필수 (§7.4)
- Claude Code 내부 형식 의존 → **버전 업 시 즉시 대응**. 운영 방식:
  - 확장이 설치된 Claude Code 버전을 확인한다.
  - 검증된 버전 목록에 없으면 관찰 뷰를 **훅 이벤트만 쓰는 최소 모드**로 자동 전환하고, 관리자에게 알린다.
  - 세션 기록 파일 파서는 실제 세션 기록 샘플로 회귀 테스트한다.
- 특정 에이전트 의존 → AgentAdapter + 지원 등급, 관문은 에이전트 무관 (D20, §6.5)
- Workspace 요금제 → 사용 중인 요금제가 Gemini 회의록을 지원함 (2026-10-01 확인)
- Remote Control → Flightdeck 범위 밖. 사용자가 자기 Claude Code 세션에서 알아서 사용 (Flightdeck 실행기는 headless라 연동하지 않음)
