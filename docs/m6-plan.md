# M6 회의 — 구현 계획

- 기준: [design.md](design.md) v0.17 §10(실시간 세션: Google Meet + Gemini), §3.1 `session.*`, §2.3 포커스, §14 M6, [m0-results.md](m0-results.md) 10·12번
- 완료 기준: **회의 요약이 올바른 쓰레드에 게시**
  - "회의 시작"으로 Meet 공간을 만들고 참여자에게 알린다. 회의 중 각자의 포커스(파일·줄)를 기록한다.
  - 회의가 끝나면 주최자 확장이 회의록(과 전사)을 기다려 가져오고, 주최자의 Claude Code가 요약을 쓰레드·문서 위치·에픽에 앵커링한다.
  - 주최자가 검토·수정해 게시하면 `thread.replied(source: session)`·`thread.created`·`sessions/<sid>.md`로 남는다.

## 제약 (이 PC에서 할 수 있는 것)

- **Flightdeck 자체 Google OAuth 클라이언트가 없다**(M2부터 미결). 그래서 확장의 Google 인증은 두 경로를 둔다: ① 데스크톱 OAuth(PKCE + 루프백, 클라이언트 ID 설정 시) ② 개발용: 설치된 `gws` CLI(M0에서 쓴 것)에 위임.
- **Gemini 회의록은 실제 사람이 말하는 회의가 있어야 생긴다.** 회의록 생성 경로는 M0 12번(실제 29분 회의, 종료 뒤 4분 안 생성)으로 확인했다. 이번에 사용자 회의 내용을 읽거나 시험 레포(GitHub)에 올리지 않는다.
- 그래서 완료 확인은 둘로 나눈다: (a) 실제 Google API로 공간 만들기·회의 기록 조회 경로(내용 없이 구조만) (b) 회의록·전사·포커스를 담은 **시험용 회의 자료**로 앵커링·검토·게시 전 과정(실제 VS Code, 실제 claude 1회). 실제 회의로 끝까지 하는 확인은 사용자가 짧은 시험 회의를 할 수 있을 때 한다.

## 범위

| 포함 | 제외 |
|---|---|
| MeetAdapter: 공간 만들기(회의록·전사 자동 켜기 요청), 회의 기록·회의록 문서·전사 항목 조회 | Calendar 일정 만들기 |
| 인증: 데스크톱 OAuth(PKCE) 구현 + gws 위임(개발용) | Flightdeck OAuth 앱 등록 (관리자 일) |
| `session.started`/`session.ended`/`session.published`, 포커스 기록 | 회의 중 실시간 자막 |
| 회의록 대기(1분 폴링, 30분 타임아웃, 회의록 없음 경로) | |
| 앵커링(주최자 Claude Code headless), 검토 화면(초안 문서), 게시 | |

## 단계

| 단계 | 패키지 | 내용 | 완료 확인 |
|---|---|---|---|
| M6-1 | `schema`, `core` | 세션 이벤트 스키마·reducer(진행 중 회의), 포커스 이벤트, 앵커링 입력 만들기·출력 검증, 검토 초안 문서 형식(파싱·렌더) | 단위 테스트 |
| M6-2 | `meet`(신규) | MeetAdapter 인터페이스, Google REST 구현(OAuth 토큰 공급자), gws 공급자, 회의록 대기 | 단위 테스트(가짜 fetch) + 실제 API 구조 확인 |
| M6-3 | `vscode`, `hook` | 회의 시작·참여·종료 명령, 포커스 기록(활성 에디터·선택 줄), 회의록 대기 표시, 앵커링 실행, 검토 초안 열기, 게시 | workflow 테스트 |
| M6-4 | — | 실제 VS Code 2창: 시험용 회의 자료로 앵커링(실제 claude 1회) → 검토 → 게시 → 상대 창에 답글. 실제 API로 공간 만들기·조회 | 완료 기준 (a)(b) |

## 미리 보이는 설계 문제 (구현 전 제안)

| # | 절 | 현재 서술 | 문제 | 제안 |
|---|---|---|---|---|
| G1 | §2.3, §10.1 ④ | 포커스는 메타 브랜치 `sessions/<sid>/focus-<member>.jsonl` 파일 | 내장 git pre-receive(M5.5)는 메타 브랜치에 이벤트 파일 추가만 허용한다. 파일 종류가 늘면 규칙이 복잡해진다 | 포커스도 **이벤트**로 남긴다: `session.focus {sid, entries[{ts, file, range}]}`(멤버마다 회의 끝에 1건, 1,000개까지). 메타 규칙(추가만·자기 이름)이 그대로 적용된다 |
| G2 | §10.1 ① | 확장이 `spaces.create`로 공간 생성 | 회의록 자동 켜기는 공간 설정(`artifactConfig`)으로 요청할 수 있지만, Workspace 정책·요금제에 따라 무시될 수 있다 | 만들 때 회의록·전사 자동 생성을 요청하고, 결과 공간 설정을 `session.started`에 남긴다. 회의 중 회의록이 꺼져 있으면 주최자 확장이 "회의록을 켜 주세요"를 알린다(회의 시작 후 2분, conferenceRecords로 확인 가능하면) |
| G3 | §10.1 ⑥⑦ | 주최자 검토: 문장 수정·삭제·앵커 이동 | 검토 UI가 정해지지 않았다 | 앵커링 결과를 **검토 초안 문서**(`.flightdeck/.runtime/sessions/<sid>.md`, 항목마다 `<!-- flightdeck:session-item target=… -->` 블록)로 연다. 주최자가 문장을 고치거나 블록을 지우고, `target=`을 바꿔 앵커를 옮긴다. "게시"가 그 문서를 읽어 이벤트로 만든다. 쓰레드 초안 블록(§3.2)과 같은 방식이라 별도 화면이 필요 없다 |
| G4 | §10.1 ⑧ | `thread.replied(source=session)` 또는 `thread.created` + `sessions/<sid>.md` | 대상별 이벤트·권한 | 쓰레드 대상 → `thread.replied {source: session}`(주최자가 그 쓰레드 참여자가 아니어도 허용: reducer에서 `source: session`은 그 회의 참여자면 답글 가능). 문서·코드 위치 대상 → `thread.created {kind: note, source: session}`. 에픽 대상 → `sessions/<sid>.md`에만. `sessions/<sid>.md`(전체 요약·결정·할 일·회의록 링크)는 에픽 브랜치에 커밋(담당자·조종수가 아니면 다음 공유 때 담당자 확장이 받아 커밋). `session.published {sid, items}`로 끝낸다 |
| G5 | §10.3 인증 | 데스크톱 OAuth(PKCE + loopback) | 클라이언트가 없다 | 설정 `flightdeck.googleClientId`가 있으면 PKCE, 없으면 개발 모드에서만 `gws` 위임(`flightdeck.gwsPath`). 토큰은 SecretStorage. 범위: `meetings.space.created`, `documents.readonly` |
| G6 | §10.1 ⑤ | 회의록 없음 경로 | 30분 기다리는 동안 VS Code를 닫으면 | 대기 상태를 로컬(`sessions/<sid>.json`)에 두고 창을 열 때 이어서 기다린다. 30분 뒤에도 없으면 포커스만으로 에픽 단위 요약 초안(사람이 씀)을 연다 |

## 결정

(대기)

## 진행 결과

| 단계 | 커밋 | 결과 |
|---|---|---|
