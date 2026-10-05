// flightdeck-server 모듈 ① (설계 §2.5, §11.2, §12): 개발용 로그인, 서명한 설정, 서버 서명 이벤트, 어드민.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactHash, configHash, generateServerKey, keyFingerprint, reduce, trustFromConfig, ulid, verifyConfig, verifyEvent, type SignedConfig } from "@flightdeck/core";
import { git, GitEngine, RemoteEventStore } from "@flightdeck/git";
import type { Event } from "@flightdeck/schema";
import { createApp, EventSigner, MemoryStore, PgStore, readProductDir, type ServerStore } from "../src/index.ts";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/flightdeck-config/products/sample");
const EPIC = "CU-42";
const ANALYSIS = "## 요구사항 요약\n토큰 회전\n\n## 영향 범위\nsrc/auth\n\n## 불명확한 점\n- TTL?\n\n## 가정\n30분\n";

let root: string, remote: string, owner: string, base: string, srv: Server, url: string, store: MemoryStore;
const keys = generateServerKey();
const tokens: Record<string, string> = {};

async function api(who: string | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url + p, {
    method,
    redirect: "manual",
    headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data, headers: r.headers };
}

const ownerStore = () => new RemoteEventStore(owner, "origin", { backoffMs: 5 });
async function clientState() {
  const cfg = (await api("dh.lee", "GET", "/config?product=sample")).data as SignedConfig;
  const s = ownerStore();
  await s.sync();
  return reduce(EPIC, await s.list(EPIC), trustFromConfig(cfg.payload));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fd-server-test-"));
  remote = path.join(root, "product.git");
  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  owner = path.join(root, "owner");
  await git(["init", "-q", "-b", "main", owner], { cwd: root });
  for (const [k, v] of [["user.name", "dh.lee"], ["user.email", "dh@e.com"]]) await git(["config", k!, v!], { cwd: owner });
  await writeFile(path.join(owner, "README.md"), "# product\n");
  await git(["add", "."], { cwd: owner });
  await git(["commit", "-q", "-m", "init"], { cwd: owner });
  await git(["remote", "add", "origin", remote], { cwd: owner });
  await git(["push", "-q", "origin", "main"], { cwd: owner });
  base = (await git(["rev-parse", "HEAD"], { cwd: owner })).trim();

  store = new MemoryStore();
  await store.upsertMember({ id: "dh.lee", email: "dh@e.com", active: true, admin: true, tracker_id: "3624282" }, "test");
  await store.upsertMember({ id: "park", email: "park@e.com", active: true, admin: false }, "test");
  await store.upsertMember({ id: "choi", email: "choi@e.com", active: true, admin: false }, "test");
  await store.addConfigVersion({ ...(await readProductDir(SAMPLE, remote)), created_by: "test" });
  const signer = new EventSigner({ store, dataDir: path.join(root, "server"), ...keys });
  const app = createApp({ store, signer, keys, devLogin: true });
  srv = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

afterAll(async () => {
  srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe("로그인·멤버 (§12)", () => {
  it("개발용 로그인: 등록된 멤버만 토큰을 받고, /me로 나를 안다", async () => {
    for (const m of ["dh.lee", "park", "choi"]) {
      const r = await api(null, "POST", "/auth/dev", { member: m });
      expect(r.status).toBe(200);
      tokens[m] = r.data.token;
    }
    expect((await api(null, "POST", "/auth/dev", { member: "ghost" })).status).toBe(403);
    expect((await api("park", "GET", "/me")).data).toEqual({ id: "park", admin: false });
    expect((await api(null, "GET", "/me")).status).toBe(401);
    expect((await api(null, "GET", "/auth/login")).status).toBe(501); // OAuth 클라이언트 없음
  });

  it("비활성 멤버는 기존 세션도 쓸 수 없다", async () => {
    await store.upsertMember({ id: "choi", email: "choi@e.com", active: false, admin: false }, "test");
    expect((await api("choi", "GET", "/me")).data).toEqual({ error: "비활성 멤버: choi" });
    expect((await api(null, "POST", "/auth/dev", { member: "choi" })).status).toBe(403);
  });
});

describe("설정 배포 (§2.5)", () => {
  it("서버가 서명한 설정: 지문이 맞으면 검증되고, 바뀌었거나 지문이 다르면 거부", async () => {
    const c = (await api("park", "GET", "/config?product=sample")).data as SignedConfig;
    const fp = keyFingerprint(keys.publicKey);
    const p = verifyConfig(c, fp);
    expect(p.version).toBe("sample-v1");
    expect(p.members.map((m) => m.id)).toEqual(["choi", "dh.lee", "park"]);
    expect(JSON.stringify(p)).not.toContain("@e.com"); // 이메일은 내보내지 않는다
    expect(Object.keys(p.deactivated)).toEqual(["choi"]);
    expect(() => verifyConfig({ ...c, payload: { ...c.payload, pipeline_yaml: c.payload.pipeline_yaml + "\n# 변조" } }, fp)).toThrow(/서명이 맞지 않는다/);
    expect(() => verifyConfig(c, keyFingerprint(generateServerKey().publicKey))).toThrow(/지문이 다르다/);
    expect((await api("park", "GET", "/config?product=nope")).status).toBe(404);
  });
});

// git 원격 왕복이 많아 전체 테스트를 함께 돌리면 기본 5초를 넘길 수 있다
describe("서버 서명 이벤트 (§3.1, §4.2, §12)", { timeout: 60_000 }, () => {
  it("에픽 시작: 요청자가 담당자, 현재 설정 버전, 원격 main의 base_sha", async () => {
    expect((await api("dh.lee", "POST", "/events", { product: "sample", epic: EPIC, type: "epic.started", data: { base_sha: "f".repeat(40) } })).status).toBe(409);
    const r = await api("dh.lee", "POST", "/events", { product: "sample", epic: EPIC, type: "epic.started", data: { tracker_ref: "86abc", base_sha: base, owner: "park" } });
    expect(r.status).toBe(200);
    const e = r.data.event as Event;
    expect(r.data.pushed).toBe(true);
    expect(e).toMatchObject({ author: "dh.lee", data: { owner: "dh.lee", config_version: "sample-v1", tracker_ref: "86abc" } }); // 요청의 owner는 무시
    expect(verifyEvent(e, keys.publicKey)).toBe(true);
    const s = await clientState();
    expect(s).toMatchObject({ phase: "ANALYSIS", owner: "dh.lee" });
    const again = await api("dh.lee", "POST", "/events", { product: "sample", epic: EPIC, type: "epic.started", data: { base_sha: base } });
    expect(again).toMatchObject({ status: 409, data: { error: expect.stringContaining("이미 시작된 에픽") } });
  });

  it("설정 내용 해시 (M5.5 Z9): epic.started에 서명되고, 같은 버전 ID에 다른 내용을 가진 서버는 서명하지 않는다", async () => {
    const started = (await ownerStore().list(EPIC)).find((e) => e.type === "epic.started")!;
    expect((started.data as { config_hash?: string }).config_hash).toBe(configHash((await store.currentConfig("sample"))!));
    // DB를 바꾼 서버: sample-v1이라는 ID는 같지만 룰 한 줄이 다르다
    const other = new MemoryStore();
    await other.upsertMember({ id: "dh.lee", email: "dh@e.com", active: true, admin: true }, "test");
    const p = await readProductDir(SAMPLE, remote);
    await other.addConfigVersion({ ...p, rules: { ...p.rules, common: p.rules.common + "\n바뀐 줄\n" }, created_by: "test" });
    expect((await other.currentConfig("sample"))!.version).toBe("sample-v1");
    const s2 = new EventSigner({ store: other, dataDir: path.join(root, "server2"), ...keys });
    const m = (await other.getMember("dh.lee"))!;
    await expect(s2.request(m, { product: "sample", epic: EPIC, type: "phase.completed", data: { phase: "ANALYSIS" } })).rejects.toThrow(/설정 불일치: 이 에픽은 sample-v1/);
  });

  it("단계 완료: 에픽 브랜치 공유·형식·쓰레드·담당자·artifact_hash를 모두 확인한 뒤 서명", async () => {
    const done = (who: string, data: Record<string, unknown> = {}) => api(who, "POST", "/events", { product: "sample", epic: EPIC, type: "phase.completed", data: { phase: "ANALYSIS", ...data } });
    expect((await done("dh.lee")).data.error).toMatch(/에픽 브랜치가 원격에 없음/);

    const eng = new GitEngine(owner);
    const { path: wt } = await eng.createEpicWorktree(EPIC, base);
    const doc = path.join(wt, ".flightdeck/epics", EPIC, "analysis.md");
    await mkdir(path.dirname(doc), { recursive: true });
    await writeFile(doc, "## 요구사항 요약\n토큰 회전\n");
    await eng.commit(wt, [path.relative(wt, doc)], "공유");
    await eng.pushEpicBranch(EPIC);
    expect((await done("dh.lee")).data.error).toMatch(/형식 문제.*영향 범위/);

    await writeFile(doc, ANALYSIS);
    await eng.commit(wt, [path.relative(wt, doc)], "공유");
    await eng.pushEpicBranch(EPIC);
    const thread = { v: 1, id: ulid(), type: "thread.created", epic: EPIC, author: "dh.lee", at: new Date().toISOString(), data: { thread: "t-AAAAAAAA", phase: "ANALYSIS", file: "analysis.md", anchor: { type: "paragraph", pid: "p:a91c" }, kind: "question", to: ["park"], body: "TTL?" } } as Event;
    await ownerStore().append(thread); // 일반 이벤트: 확장이 직접 쓴다
    expect((await done("dh.lee")).data.error).toMatch(/열린 쓰레드 1개/);

    await ownerStore().append({ v: 1, id: ulid(), type: "thread.resolved", epic: EPIC, author: "dh.lee", at: new Date().toISOString(), data: { thread: "t-AAAAAAAA" } } as Event);
    expect((await done("park")).data.error).toMatch(/담당자만 단계를 완료할 수 있음 \(요청자: park/);
    expect((await done("dh.lee", { artifact_hash: artifactHash("다른 내용") })).data.error).toMatch(/요청한 내용과 다름/);
    expect((await api("dh.lee", "POST", "/events", { product: "sample", epic: EPIC, type: "review.approved", data: {} })).data.error).toBe("리뷰 요청 전");
    expect((await api("dh.lee", "POST", "/events", { product: "sample", epic: EPIC, type: "gate.reported", data: {} })).status).toBe(400); // 아직 지원하지 않음

    const ok = await done("dh.lee", { artifact_hash: artifactHash(ANALYSIS) });
    expect(ok.status).toBe(200);
    expect(ok.data.event.data).toEqual({ phase: "ANALYSIS", artifact_hash: artifactHash(ANALYSIS) });
    expect((await clientState()).phase).toBe("DESIGN");
  });

  it("동시에 들어온 요청은 제품별로 하나씩 처리한다 (한쪽만 성공)", async () => {
    const epic = "CU-43";
    const rs = await Promise.all([1, 2, 3].map(() => api("dh.lee", "POST", "/events", { product: "sample", epic, type: "epic.started", data: { base_sha: base } })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });
});

describe("어드민 화면 (§2.5)", () => {
  let cookie = "";
  it("로그인 전에는 로그인 화면, 개발용 로그인은 어드민만 고를 수 있다", async () => {
    const r = await api(null, "GET", "/admin");
    expect(r.status).toBe(401);
    expect(r.data).toContain('<option>dh.lee</option>');
    expect(r.data).not.toContain("<option>park</option>");
    const login = await api(null, "POST", "/admin/dev-login", "member=dh.lee", { "content-type": "application/x-www-form-urlencoded" });
    expect(login.status).toBe(303);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await api(null, "GET", "/admin", undefined, { cookie })).data).toContain("park@e.com");
    expect((await api("park", "GET", "/admin")).status).toBe(403);
  });

  it("파이프라인 저장 = 새 설정 버전. 틀린 YAML은 저장하지 않고 이유를 보여준다", async () => {
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const h = { cookie, "content-type": "application/x-www-form-urlencoded" };
    const bad = await api(null, "POST", "/admin/products/sample", form({ pipeline_yaml: "version: 2\n" }), h);
    expect(bad.status).toBe(400);
    expect(bad.data).toContain("저장하지 않았다");
    const cur = (await store.currentConfig("sample"))!;
    const ok = await api(null, "POST", "/admin/products/sample", form({ pipeline_yaml: cur.pipeline_yaml.replace("max_turns: 200", "max_turns: 150"), "rule:common": "공통", note: "턴 줄임" }), h);
    expect(ok.status).toBe(303);
    expect((await store.currentConfig("sample"))!).toMatchObject({ version: "sample-v2", created_by: "dh.lee", rules: { common: "공통" } });
    expect((await store.getConfigVersion("sample", "sample-v1"))!.pipeline_yaml).toContain("max_turns: 200"); // 이전 버전은 그대로
    const cross = await api(null, "POST", "/admin/members", form({ id: "x", email: "x@e.com", active: "on" }), { ...h, origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    expect((await store.audit()).map((a) => a.action)).toContain("config.version");
  });
});

describe("티어 리뷰 서명 (§4.2 v0.13)", { timeout: 60_000 }, () => {
  const E = "CU-50";
  const DESIGN = "## 개요\n회전\n\n## 변경 컴포넌트\nauth\n\n## 인터페이스\nrefresh()\n\n## 데이터 변경\n없음\n\n## 테스트 계획\n단위\n\n## 리스크\n재사용 탐지\n";
  let wt: string;
  const eng = () => new GitEngine(owner);
  const ev = (who: string, type: string, data: Record<string, unknown> = {}) => api(who, "POST", "/events", { product: "sample", epic: E, type, data });
  const put = async (file: string, text: string) => {
    const f = path.join(wt, ".flightdeck/epics", E, file);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, text);
    await eng().commit(wt, [path.relative(wt, f)], `공유 ${file}`);
    return eng().pushEpicBranch(E);
  };
  const state = async () => {
    const cfg = (await api("dh.lee", "GET", "/config?product=sample")).data as SignedConfig;
    const s = ownerStore();
    await s.sync();
    const { parsePipeline } = await import("@flightdeck/schema");
    return reduce(E, await s.list(E), trustFromConfig(cfg.payload), { pipelines: () => parsePipeline(cfg.payload.pipeline_yaml) });
  };

  beforeAll(async () => {
    // 티어 리뷰어: lead = park, architect = lee (새 설정 버전, 새 에픽부터)
    await store.upsertMember({ id: "lee", email: "lee@e.com", active: true, admin: false }, "test");
    tokens.lee = (await api(null, "POST", "/auth/dev", { member: "lee" })).data.token;
    const cur = (await store.currentConfig("sample"))!;
    await store.addConfigVersion({ ...cur, pipeline_yaml: cur.pipeline_yaml.replace(/leads: \[kim\]/, "leads: [park]").replace(/architects: \[park, lee\]/, "architects: [lee]"), created_by: "test", note: "M3 리뷰어" });
    expect((await ev("dh.lee", "epic.started", { base_sha: base })).status).toBe(200);
    wt = (await eng().createEpicWorktree(E, base)).path;
    await put("analysis.md", ANALYSIS);
    expect((await ev("dh.lee", "phase.completed", { phase: "ANALYSIS" })).status).toBe(200);
    expect((await state()).phase).toBe("DESIGN");
  });

  it("리뷰 요청: 담당자만, 원격 design.md 형식 확인, commit·해시는 서버가 채운다", async () => {
    expect((await ev("dh.lee", "review.requested", { phase: "DESIGN" })).data.error).toMatch(/design.md가 없음/);
    const c1 = await put("design.md", DESIGN);
    expect((await ev("park", "review.requested", { phase: "DESIGN" })).data.error).toMatch(/담당자만 리뷰를 요청할 수 있음/);
    const r = await ev("dh.lee", "review.requested", { phase: "DESIGN", artifact_hash: artifactHash(DESIGN) });
    expect(r.status).toBe(200);
    expect(r.data.event.data).toEqual({ phase: "DESIGN", artifact_hash: artifactHash(DESIGN), commit: c1 });
  });

  it("승인: 서버가 현재 티어를 채우고, 차례·리뷰어·요청 뒤 변경을 확인한다", async () => {
    expect((await ev("lee", "review.approved")).data.error).toMatch(/lead 티어 리뷰어가 아님/); // 현재 차례는 lead
    expect((await ev("park", "review.approved", { tier: "architect" })).data.error).toBe("현재 차례는 lead 티어");
    // 담당자가 요청 뒤 몰래 고치면 승인할 수 없다
    const changed = DESIGN.replace("재사용 탐지", "재사용 탐지, 토큰 탈취");
    await put("design.md", changed);
    expect((await ev("park", "review.approved")).data.error).toMatch(/리뷰 요청 뒤 design.md를 고쳤다/);
    expect((await ev("dh.lee", "review.requested", { phase: "DESIGN" })).status).toBe(200); // 다시 요청
    const a1 = await ev("park", "review.approved");
    expect(a1.status).toBe(200);
    expect(a1.data.event.data).toEqual({ phase: "DESIGN", tier: "lead", artifact_hash: artifactHash(changed) });
    expect((await state()).phase).toBe("DESIGN");
    const a2 = await ev("lee", "review.approved");
    expect(a2.data.event.data.tier).toBe("architect");
    expect((await state()).phase).toBe("IMPLEMENTATION"); // 마지막 티어 승인으로 자동 전환
  });
});

// PostgreSQL 저장소: FD_TEST_PG=<연결 문자열>이 있을 때만 (Docker로 띄운 DB)
describe.skipIf(!process.env.FD_TEST_PG)("PgStore", () => {
  let pgs: ServerStore;
  beforeAll(async () => {
    pgs = await PgStore.connect(process.env.FD_TEST_PG!);
  });
  afterAll(async () => pgs?.close());

  it("멤버·비활성 시각·세션·설정 버전", async () => {
    const id = `t${Date.now()}`;
    await pgs.upsertMember({ id, email: `${id}@e.com`, active: true, admin: false }, "test");
    const off = await pgs.upsertMember({ id, email: `${id}@e.com`, active: false, admin: false }, "test");
    expect(off.deactivated_at).toBeTruthy();
    expect((await pgs.upsertMember({ id, email: `${id}@e.com`, active: false, admin: false }, "test")).deactivated_at).toBe(off.deactivated_at); // 처음 비활성 시각 유지
    expect((await pgs.getMemberByEmail(`${id.toUpperCase()}@E.COM`))?.id).toBe(id);
    const t = await pgs.createSession(id, 60_000);
    expect(await pgs.sessionMember(t)).toBe(id);
    await pgs.deleteSession(t);
    expect(await pgs.sessionMember(t)).toBeNull();
    const product = `p${Date.now()}`;
    const vs = await Promise.all([1, 2, 3].map((n) => pgs.addConfigVersion({ product, pipeline_yaml: `# ${n}`, rules: { common: "x" }, created_by: id })));
    expect(vs.map((v) => v.version).sort()).toEqual([`${product}-v1`, `${product}-v2`, `${product}-v3`]);
    expect((await pgs.currentConfig(product))?.version).toBe(`${product}-v3`);
    expect((await pgs.listProducts()).find((p) => p.product === product)?.current).toBe(`${product}-v3`);
  });

  it("편집 기록: seq가 이어질 때만, 동시에 붙여도 한쪽만, 큰 from도 (M7)", async () => {
    const product = `p${Date.now()}`;
    const rec = (seq: number) => ({ epic: "CU-1", file: "f", seq, base_hash: null, range: [0, 0] as [number, number], insert: `${seq}`, source: { kind: "human" as const, member: "x" }, ts: "2026-10-05T00:00:00.000Z" });
    expect(await pgs.appendEditlog(product, "CU-1", [rec(2)])).toBe(false);
    const both = await Promise.all([pgs.appendEditlog(product, "CU-1", [rec(1), rec(2)]), pgs.appendEditlog(product, "CU-1", [rec(1)])]);
    expect(both.filter(Boolean)).toHaveLength(1);
    const last = await pgs.editlogLast(product, "CU-1");
    expect(last).toBeGreaterThanOrEqual(1);
    expect(await pgs.editlog(product, "CU-1", Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect((await pgs.editlog(product, "CU-1")).map((r) => r.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
    await pgs.setMemos(product, "CU-1", [{ epic: "CU-1", file: "f", seqs: [1, 1], memo: "m", member: "x", at: "2026-10-05T00:00:00.000Z" }]);
    expect((await pgs.memos(product, "CU-1")).map((m) => m.memo)).toEqual(["m"]);
  });
});
