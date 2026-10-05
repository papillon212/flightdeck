# Flightdeck 설치 안내 (여러 기기에서 시험 사용)

이 문서는 팀이 Flightdeck을 여러 기기에서 처음 써 보기 위한 절차다. 서버를 맡는 사람(어드민)은 1~3절을 따르고, 멤버는 4절부터 보면 된다.

현재 상태에 맞춘 구성이다.

- 로그인은 개발용 로그인(멤버 ID를 골라 들어가기)만 실제로 확인되었다. Google 로그인은 OAuth 클라이언트가 아직 없어 확인되지 않았다.
- 개발용 로그인은 서버가 루프백(127.0.0.1)에서만 열 때 켜진다. 그래서 멤버는 **SSH 터널**로 서버 기기의 127.0.0.1:8787에 붙는다.
- TLS는 없다. 모든 통신이 SSH 터널 안으로 지나가므로 따로 필요하지 않다.

## 1. 구성

```
 멤버 기기 (VS Code + Flightdeck 확장 + Claude Code)
   └─ 127.0.0.1:8787 ──SSH 터널──▶ 서버 기기 127.0.0.1:8787
                                     ├─ flightdeck-server (Node 22+)
                                     │    ├─ 서명·반영·어드민 화면·실시간 관찰 중계
                                     │    └─ 내장 git  /git/<제품>.git   (기본, 외부 git도 가능)
                                     └─ PostgreSQL (멤버·설정 버전·회의·편집 기록)
```

- 확장이 서버와 주고받는 것(로그인, 이벤트 서명, `git push`/`fetch`, 실시간 관찰)은 모두 이 터널 하나로 지나간다.
- 에이전트(Claude Code)는 각 멤버의 기기에서 각자 개인 구독으로 실행된다. 서버는 에이전트를 실행하지 않는다.
- 일감 도구(ClickUp)는 각 멤버가 자기 개인 토큰으로 직접 부른다.

## 2. 서버 기기 준비 (어드민)

필요한 것: macOS 또는 Linux, Node.js 22 이상, pnpm, git, Docker(PostgreSQL용), sshd. 멤버가 SSH로 들어올 수 있어야 한다.

### 2.1 PostgreSQL

```sh
docker run -d --name flightdeck-pg --restart unless-stopped \
  -e POSTGRES_USER=flightdeck -e POSTGRES_PASSWORD='<비밀번호>' -e POSTGRES_DB=flightdeck \
  -p 127.0.0.1:5432:5432 -v flightdeck-pg:/var/lib/postgresql/data postgres:16
```

테이블은 서버가 처음 뜰 때 만든다.

### 2.2 코드 받기와 빌드

```sh
git clone <flightdeck 레포> /srv/flightdeck/app && cd /srv/flightdeck/app
pnpm install --frozen-lockfile
pnpm build            # dist/flightdeck-server.mjs 등
```

### 2.3 제품 설정 준비

제품 하나에 설정 폴더 하나를 둔다: `pipeline.yaml`과 `rules/*.md`. 견본은 `examples/flightdeck-config/products/sample/`에 있다.

- 이 견본을 복사해 `product`, `tracker.clickup.list_ids`(일감을 가져올 ClickUp 목록), 승인 그룹 같은 값을 팀에 맞게 고친다.
- 처음 가져온 뒤에는 어드민 화면에서 고친다. 고쳐서 저장할 때마다 새 설정 버전이 된다.

### 2.4 server.env

```sh
cp deploy/server/server.env.example deploy/server/server.env
chmod 600 deploy/server/server.env
```

각 값의 뜻은 파일의 주석에 있다. 처음 한 번은 다음 값이 중요하다.

| 변수 | 뜻 |
|---|---|
| `FD_DATA_DIR` | 서버 서명 키·내장 git 레포·서버 작업 사본이 놓이는 폴더. 백업 대상이다 |
| `FD_DATABASE_URL` | 2.1의 PostgreSQL |
| `FD_HOST` / `FD_PORT` | `127.0.0.1` / `8787` 그대로 둔다 |
| `FD_DEV_LOGIN=1` | 개발용 로그인 |
| `FD_BOOTSTRAP_ADMIN` | `멤버ID:이메일`. 어드민이 한 명도 없을 때만 만든다 |
| `FD_IMPORT_PRODUCT` | 2.3의 설정 폴더. 그 제품의 설정이 없을 때만 가져온다 |
| `FD_PRODUCT_REPO` | `builtin`(서버 내장 git, 기본) 또는 외부 git URL |
| `FD_IMPORT_REPO` | 내장 git일 때 처음 레포를 채울 원본(기존 GitHub 레포 등). 서버 기기가 이 레포를 읽을 수 있어야 한다 |

`server.env`는 `.gitignore`에 들어 있다. 레포에 올리지 않는다.

### 2.5 서버 시작

```sh
deploy/server/start.sh
```

시작 로그 마지막 줄에 서버 키 지문이 나온다.

```
flightdeck-server http://127.0.0.1:8787  server key SHA256:xxxxxxxx…  (개발용 로그인 켜짐)
```

- `SHA256:…` 값을 멤버들에게 나눠 준다. 확장은 이 지문으로 서버가 서명한 이벤트를 검증한다.
- 서버 키는 `FD_DATA_DIR/server-key.pem`이다. 이 키를 잃으면 지금까지의 서명을 검증할 수 없다(5절 백업).
- `[config] <제품>: 설정을 읽지 못해 건너뛴다`가 나오면 그 제품의 설정이 깨진 것이다. 서버는 뜨므로 어드민 화면에서 고친다.

계속 켜 두려면 OS의 서비스로 등록한다. 예시는 다음과 같다.

- macOS: `~/Library/LaunchAgents`의 plist에서 `ProgramArguments`에 `start.sh` 경로를 넣고 `KeepAlive`를 켠다.
- Linux: systemd 유닛의 `ExecStart=/srv/flightdeck/app/deploy/server/start.sh`, `Restart=always`.

### 2.6 어드민 화면: 멤버와 제품

서버 기기에서, 또는 터널을 연 기기에서 브라우저로 `http://127.0.0.1:8787/admin`을 연다. "개발용 로그인"에서 어드민 멤버를 골라 들어간다.

1. **멤버 등록**: 멤버 ID, 이메일, ClickUp 멤버 ID(`tracker_id`)를 넣는다. 멤버 ID는 멤버가 확장 설정 `flightdeck.devLoginMember`에 넣을 값이다.
2. **제품 확인**: 제품 페이지에서 파이프라인·룰을 확인하고 고친다.
3. **내장 레포**: `FD_IMPORT_REPO`로 가져오지 않았다면 제품 페이지에서 "모든 ref 가져오기"(기존 레포 URL) 또는 "빈 레포 만들기"를 한다. 내장 레포가 생기기 전까지 git 요청은 503이다.
4. **외부 미러(선택)**: `pipeline.yaml`에 `mirror: {url, refs}`를 두면 반영된 main을 GitHub 등에 밀어 준다. 상태는 어드민 첫 화면의 "외부 미러" 칸에 나온다.

### 2.7 멤버의 SSH 접근

멤버마다 서버 기기에 SSH로 들어올 수 있게 한다. 셸이 필요 없으면 포트 포워딩만 허용하는 계정으로 두는 것이 좋다.

```
# 서버 기기 ~flightdeck-tunnel/.ssh/authorized_keys 한 줄 예시
restrict,port-forwarding,permitopen="127.0.0.1:8787" ssh-ed25519 AAAA… member@laptop
```

### 2.8 멤버에게 줄 것

- VSIX 파일: `pnpm package` → `dist/flightdeck-0.1.0.vsix`
- 서버 키 지문 `SHA256:…`
- 제품 ID, 각자의 멤버 ID
- SSH 대상(예: `flightdeck-tunnel@flightdeck-host`)
- 이 레포의 `deploy/member/` 스크립트 두 개, 또는 레포 자체

## 3. 기존 외부 git으로 쓰는 경우

내장 git은 기본이지만 필수가 아니다. `FD_PRODUCT_REPO`에 외부 git URL(예: `git@github.com:my-org/my-product.git`)을 넣으면 다음과 같이 된다.

- 레포는 그 외부 git에 있고, 멤버는 평소처럼 외부 git에서 clone·push한다.
- 서버 기기도 그 레포에 push할 수 있어야 한다. 서버가 main에 반영한다.
- 4절의 "서버 레포 받기" 대신 외부 git에서 clone한다.

## 4. 멤버 기기 준비

필요한 것은 다음과 같다. `setup.sh`가 확인한다.

- VS Code와 `code` 명령: VS Code에서 "Shell Command: Install 'code' command in PATH"
- git과 git 사용자 이름·이메일(`git config --global user.name/user.email`)
- Node.js 22 이상: 에이전트 훅이 `node`로 실행된다
- Claude Code: 설치 후 각자 개인 구독으로 로그인한다(`claude` 한 번 실행)
- 서버 기기로의 SSH 접근(2.7)

### 4.1 터널

```sh
deploy/member/tunnel.sh flightdeck-tunnel@flightdeck-host
```

- 이 기기의 127.0.0.1:8787을 서버 기기의 127.0.0.1:8787로 잇는다. 끊기면 3초 뒤 다시 잇는다.
- **Flightdeck으로 작업하는 동안 켜 둔다.** 꺼지면 로그인·제출·관찰·`git push`가 모두 멈춘다.
- 이 기기에서 8787을 이미 쓰고 있으면 두 번째 인자로 다른 포트를 주고, 4.2의 `--server-url`도 맞춘다.

### 4.2 확장 설치와 설정

```sh
deploy/member/setup.sh --vsix flightdeck-0.1.0.vsix \
  --server-key 'SHA256:xxxxxxxx…' --product my-product --member my.id --write-settings
```

1. 필요한 프로그램을 확인한다.
2. VSIX를 설치한다.
3. `--write-settings`가 있으면 VS Code 사용자 설정에 다음을 넣는다. 원래 파일은 `settings.json.bak-<시각>`으로 남긴다.

```json
{
  "flightdeck.serverUrl": "http://127.0.0.1:8787",
  "flightdeck.serverKeyFingerprint": "SHA256:…",
  "flightdeck.product": "my-product",
  "flightdeck.devLoginMember": "my.id"
}
```

- 설정 파일에 주석이 있으면 고치지 않고 넣을 내용만 보여 준다. 그때는 "Preferences: Open User Settings (JSON)"에서 직접 넣는다.
- 스크립트 없이 하려면 다음과 같이 한다. 확장 보기의 `…` → "VSIX에서 설치…"로 VSIX를 고르고, 위 설정을 직접 넣는다.

### 4.3 처음 쓰기

1. VS Code를 다시 열고 명령 팔레트에서 **Flightdeck: 서버 레포 받기**를 실행한다. 받을 폴더를 고르면 레포를 받아 연다.
   - 외부 git 제품이면 대신 평소처럼 clone해서 연다.
   - 내장 git의 인증은 확장이 서버에서 받은 git 전용 토큰으로 한다(7일, 저절로 갱신). 따로 비밀번호를 넣지 않는다.
2. **Flightdeck: 일감 도구(ClickUp) 개인 토큰 설정**에서 내 ClickUp 개인 토큰(`pk_…`)을 넣는다. 토큰은 VS Code 비밀 저장소에만 둔다.
3. Flightdeck 패널에서 **새 에픽 (내 일감에서 시작)** → 일감을 고르면 에픽 창이 열린다.
4. 처음 여는 에픽 창은 "이 폴더의 작성자를 신뢰"를 눌러야 Flightdeck 훅과 설정이 동작한다.

### 4.4 회의 기능 (선택)

회의는 `flightdeck.meet` 설정으로 고른다.

- `google`: Google Meet API를 직접 부른다. Google OAuth 데스크톱 클라이언트가 필요하다(`flightdeck.googleClientId`/`googleClientSecret`). 아직 발급되지 않았다.
- `gws`: `gws` CLI를 쓴다. 회의록 읽기는 되지만 회의 공간 만들기는 권한(scope)이 없어 확인되지 않았다.
- `fixture`: 시험 자료(`flightdeck.meetFixtureDir`)로 회의를 흉내 낸다.

## 5. 백업

```sh
deploy/server/backup.sh            # FD_BACKUP_DIR/<날짜-시각>/ 에 만든다
```

| 파일 | 내용 |
|---|---|
| `git/<제품>-<시각>.bundle` | 내장 git 레포 전체(모든 ref). 만든 뒤 `git bundle verify`까지 한다 |
| `db.dump` | PostgreSQL(`pg_dump --format=custom`). `FD_PG_CONTAINER`가 있으면 컨테이너 안에서 뜬다 |
| `server-key.pem` | 서버 서명 키(권한 600) |

- 백업 주기는 아직 정하지 않았다(설계 §15). cron 등으로 원하는 주기에 돌린다. 예: `0 3 * * * /srv/flightdeck/app/deploy/server/backup.sh`
- 백업 폴더에는 서명 키가 있다. 서버 데이터와 같은 수준으로 보호한다.

복원 순서는 다음과 같다.

1. `FD_DATA_DIR`에 `server-key.pem`을 둔다.
2. `pg_restore --clean -d <DB> db.dump`로 DB를 되살린다.
3. `git clone --mirror <bundle> FD_DATA_DIR/hosted/<제품>.git`로 레포를 되살린다.
4. 서버를 시작한다. 시작할 때 훅을 다시 설치한다.

## 6. 업데이트

- **서버**: `git pull && pnpm install --frozen-lockfile && pnpm build` 후 서버를 다시 시작한다. 데이터·키·DB는 그대로 쓴다.
- **확장**: 새 VSIX를 받아 `setup.sh --vsix <새 파일> …`(설정은 그대로라 `--write-settings`는 빼도 된다) 또는 "VSIX에서 설치…" 후 VS Code를 다시 연다.
- 서버와 확장은 같은 커밋에서 빌드한 것을 함께 쓴다.

## 7. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 로그인이 401, "서버에 연결할 수 없다" | 터널이 켜져 있는지(`curl http://127.0.0.1:8787/health`), `flightdeck.devLoginMember`가 어드민 화면에 등록된 활성 멤버인지 |
| 터널이 `bind: Address already in use` | 이 기기에서 8787을 다른 프로그램이 쓰고 있다. 다른 포트를 쓰고 `flightdeck.serverUrl`을 맞춘다 |
| "서버 키 지문이 다르다" | `flightdeck.serverKeyFingerprint`가 서버 시작 로그의 값과 같은지. 서버 데이터 폴더를 새로 만들면 키가 바뀐다 |
| 에이전트가 동작하지 않거나 훅 오류가 난다 | 터미널에서 `node -v`가 22 이상인지. 훅과 MCP 서버는 PATH의 `node`로 실행된다. nvm 등으로 깔아 VS Code가 그 PATH를 못 받으면 터미널에서 `code`로 연다 |
| 에픽 창에서 Flightdeck이 반응하지 않는다 | 창을 "신뢰"했는지 |
| `git push`가 거절된다 | 정상일 수 있다. 서버는 main 직접 push, 다른 사람 이름의 이벤트, 메타 이벤트 수정을 거절한다. 거절 메시지를 본다 |
| git 요청이 503 | 그 제품의 내장 레포가 아직 없다(2.6의 3) |
| 일감 목록이 비어 있다 | ClickUp 토큰, `tracker.clickup.list_ids`, 어드민의 `tracker_id`, 일감에 `tag`(예: `flightdeck`)가 붙어 있는지 |

## 8. 한계와 보안 주의

- **개발용 로그인**: 터널에 붙은 사람은 등록된 아무 멤버로나 로그인할 수 있다. 신뢰하는 사람에게만 SSH 접근을 준다. 실제 운영은 Google 로그인(OAuth 클라이언트 발급 후 `FD_DEV_LOGIN` 끄기) 뒤에 한다.
- **TLS 없음**: 서버는 루프백 HTTP만 연다. 터널 없이 외부에 열지 않는다.
- **시험 범위**: macOS의 VS Code에서만 실제로 확인했다. Linux·Windows 멤버 기기는 확인되지 않았다.
- **확장 배포**: VSIX를 직접 나눠 준다. 마켓플레이스에 올리지 않았고, 자동 업데이트도 없다.
- **회의**: Google Meet 회의 공간 만들기는 OAuth 클라이언트가 필요하다(4.4).
