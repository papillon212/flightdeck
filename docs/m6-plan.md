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
| M6-1~M6-3 | `56c2de5` | schema: `session.started`(공간·자동 생성 결과)·`session.ended`·`session.focus`(G1)·`session.published`(요약 내용), 쓰레드의 `source: session`·`sid`. core: 회의 상태·권한(주최자만 끝내고 게시, 주최자는 참여자가 아니어도 요약 답글), 앵커링 지시문·출력 해석, 검토 초안(G3), 요약 파일. 확장: Meet 어댑터(REST+PKCE, gws 위임, 시험 자료), 회의록 대기(1분, 30분, 회의록 없음 경로), 회의 시작·참여·종료·초안 만들기·게시, 포커스 기록, 게시된 요약을 조종수가 에픽 브랜치에 커밋 |
| M6-4 | (이번 커밋) | 실제 Google API 조회 경로 확인, 실제 VS Code 시나리오(아래), 메타 브랜치 감시 수정 |

### M6 완료 확인 결과 (2026-10-05)

**(a) 실제 Google Meet API** (gws 위임, 사용자 계정, 읽기 전용. 내용은 출력하지 않고 개수·상태·길이만): 최근 회의 기록 10개 조회, 공간별 회의 기록 조회(`space.name` 필터), 회의록(`smartNotes`) `FILE_GENERATED` → Docs 본문 1,904자·2,532자, 전사 항목 98건·88건(페이지 처리, 필드 participant·startTime·endTime·text). **공간 만들기는 확인하지 못했다**: gws 로그인 범위가 `meetings.space.readonly`뿐이라 `meetings.space.created`가 없다(범위를 늘리려면 사용자가 브라우저로 다시 로그인해야 한다). Flightdeck 자체 OAuth 클라이언트도 없어 REST+PKCE 경로는 가짜 응답으로만 확인했다.

**(b) 실제 VS Code 2창** (주최자 dh.lee, 참여자 park) + PostgreSQL 서버 + 내장 git + 실제 ClickUp(CU-z8r3fdngqt). 회의는 시험용 회의 자료(회의록·전사 5문장, `flightdeck.meet: fixture`), 앵커링은 **실제 claude(haiku) 1회**. 회의 시작은 명령의 입력 창 대신 같은 함수를 불렀다.

| 단계 | 결과 |
|---|---|
| 질문 → 회의 시작 | dh.lee가 분석 문서의 TTL 항목에 park에게 질문 → 회의 시작(`session.started`) → park 질문 창에 "회의를 시작했습니다" 알림 |
| 포커스 | park이 회의 중 분석 문서의 TTL 줄, `src/token.js`의 `reused` 줄을 봄 → 회의가 끝나자 포커스 4건을 올림(종료 9초 뒤) |
| 앵커링 (실제 claude, 31초) | TTL 결정 → **그 질문 쓰레드**, 재사용 탐지 결정 → **park이 보던 `src/token.js` 35행**(포커스 사용), 할 일 2건 → 에픽 전체 |
| 검토 → 게시 | 초안 문서 그대로 게시: 쓰레드 답글 1(`source: session`), 코드 쓰레드 1, `session.published` → 조종수(dh.lee) 확장이 `sessions/<sid>.md`를 에픽 브랜치에 커밋 |
| 참여자 | park에게 "@dh.lee이(가) 답했습니다: 액세스 토큰 TTL 30분, 슬라이딩 갱신 방식으로 결정" 알림 |

찾아 고친 것: 1차 시도(CU-z8r3fdngm5, 중단)에서 park의 포커스가 올라오지 않았다. 다른 코드(시나리오 대기 루프, 같은 레포의 다른 창, 받은 질문 조회)가 메타 브랜치를 먼저 받으면 창의 감시가 "받은 것 없음"으로 보고 화면을 갱신하지 않았기 때문이다(M8의 넘겨받음 알림과 같은 원인). 감시가 원격 비교와 함께 **로컬 메타 끝이 지난번 알린 뒤 바뀌었는지**도 본다(테스트 추가).

확인하지 못한 것: 실제 회의(사람이 말하는 회의의 Gemini 회의록)로 끝까지, 공간 만들기와 회의록·전사 자동 켜기(범위 필요), Flightdeck OAuth 앱, 사람의 클릭(제목 입력, 게시 명령).
