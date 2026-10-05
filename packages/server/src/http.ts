// flightdeck-server HTTP (설계 §11.2). 모듈 ①: 로그인, 설정 배포, 서버 서명 이벤트, 어드민 화면.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { keyFingerprint } from "@flightdeck/core";
import { buildConfig } from "./config.ts";
import { adminRoutes } from "./admin.ts";
import type { GitHost } from "./githost.ts";
import { RequestError, type EventSigner } from "./signer.ts";
import type { Member, ServerStore } from "./store.ts";

export interface AppOptions {
  store: ServerStore;
  signer: EventSigner;
  keys: { publicKey: string; privateKeyPem: string };
  /** 개발용 로그인 (설계 v0.12 M2: Google OAuth 클라이언트가 없을 때). 루프백 요청만 받는다 */
  devLogin?: boolean;
  google?: { clientId: string; clientSecret: string; publicUrl: string };
  sessionTtlMs?: number;
  /** 내장 git 서버 (§1.5, M5.5) */
  githost?: GitHost;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  opts: AppOptions;
  /** 로그인한 멤버 (없으면 null) */
  member: Member | null;
  body: () => Promise<string>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

export const isLoopback = (req: IncomingMessage) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new RequestError(413, "본문이 너무 크다"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sessionToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const m = /(?:^|;\s*)fd_session=([^;]+)/.exec(req.headers.cookie ?? "");
  return m ? decodeURIComponent(m[1]!) : null;
}

const oauthStates = new Map<string, { port?: number; expires: number }>();

export function createApp(opts: AppOptions) {
  const ttl = opts.sessionTtlMs ?? 30 * 24 * 3600_000;

  async function login(member: Member): Promise<string> {
    if (!member.active) throw new RequestError(403, `비활성 멤버: ${member.id}`);
    return opts.store.createSession(member.id, ttl);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    let bodyCache: Promise<string> | null = null;
    const token = sessionToken(req);
    const memberId = token ? await opts.store.sessionMember(token) : null;
    const member = memberId ? await opts.store.getMember(memberId) : null;
    // 편집 기록 묶음은 큰 파일의 내용을 담을 수 있다 (M7)
    const limit = url.pathname === "/editlog" ? 16 << 20 : 1 << 20;
    const ctx: Ctx = { req, res, url, opts, member: member?.active ? member : null, body: () => (bodyCache ??= readBody(req, limit)) };
    const p = url.pathname;
    try {
      if (p === "/health") return json(res, 200, { ok: true, server_key_fingerprint: keyFingerprint(opts.keys.publicKey) });

      // ── 로그인 (§12) ──
      if (p === "/auth/dev" && req.method === "POST") {
        if (!opts.devLogin || !isLoopback(req)) throw new RequestError(404, "개발용 로그인이 꺼져 있다");
        const { member: id } = JSON.parse(await ctx.body()) as { member?: string };
        const m = id ? await opts.store.getMember(id) : null;
        if (!m) throw new RequestError(403, `등록되지 않은 멤버: ${id}`);
        return json(res, 200, { token: await login(m), member: m.id });
      }
      if (p === "/auth/login" && req.method === "GET") {
        if (!opts.google) throw new RequestError(501, "Google 로그인이 설정되지 않았다 (OAuth 클라이언트 없음)");
        const state = randomBytes(16).toString("base64url");
        const port = Number(url.searchParams.get("port")) || undefined;
        oauthStates.set(state, { port, expires: Date.now() + 10 * 60_000 });
        const q = new URLSearchParams({ client_id: opts.google.clientId, redirect_uri: `${opts.google.publicUrl}/auth/callback`, response_type: "code", scope: "openid email", state, prompt: "select_account" });
        res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
        return void res.end();
      }
      if (p === "/auth/callback" && req.method === "GET") {
        if (!opts.google) throw new RequestError(501, "Google 로그인이 설정되지 않았다");
        const st = oauthStates.get(url.searchParams.get("state") ?? "");
        oauthStates.delete(url.searchParams.get("state") ?? "");
        if (!st || st.expires < Date.now()) throw new RequestError(400, "로그인 요청이 만료됐다. 다시 시도해 주세요");
        const email = await googleEmail(opts.google, url.searchParams.get("code") ?? "");
        const m = await opts.store.getMemberByEmail(email);
        if (!m) throw new RequestError(403, `서버에 등록되지 않은 계정: ${email}. 관리자에게 등록을 요청하세요`);
        const t = await login(m);
        if (st.port) {
          res.writeHead(302, { location: `http://127.0.0.1:${st.port}/callback?token=${encodeURIComponent(t)}` });
        } else {
          res.writeHead(302, { location: "/admin", "set-cookie": `fd_session=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/` });
        }
        return void res.end();
      }
      if (p === "/auth/logout" && req.method === "POST") {
        if (token) await opts.store.deleteSession(token);
        res.writeHead(302, { location: "/admin", "set-cookie": "fd_session=; Max-Age=0; Path=/" });
        return void res.end();
      }

      if (p.startsWith("/admin")) return await adminRoutes(ctx);

      // ── 내장 git (§1.5, M5.5) ──
      if (p === "/internal/git/pre-receive" && req.method === "POST") {
        // 레포 훅의 판정 요청. push ID를 모르면 거부하므로 루프백 확인은 이중 안전장치다
        if (!opts.githost || !isLoopback(req)) throw new RequestError(404, `없는 경로: ${p}`);
        return json(res, 200, await opts.githost.preReceive(JSON.parse(await ctx.body())));
      }
      const gm = /^\/git\/([^/]+)\.git(\/.*)$/.exec(p);
      if (gm && opts.githost) {
        // git 전용 토큰만 받는다 (Z3). 로그인 세션 토큰은 서명 요청까지 할 수 있어 git이 읽는 곳에 두지 않는다
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
        const pass = basic ? Buffer.from(basic[1]!, "base64").toString("utf8").split(":").slice(1).join(":") : "";
        const who = pass ? opts.githost.verifyToken(pass) : null;
        const m = who ? await opts.store.getMember(who) : null;
        if (!m?.active) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="flightdeck"', "content-type": "text/plain; charset=utf-8" });
          return void res.end(who ? `비활성 멤버: ${who}\n` : "Flightdeck git 토큰이 필요하다 (확장에서 서버 로그인)\n");
        }
        return await opts.githost.serve(req, res, gm[1]!, gm[2]!, m.id);
      }

      // ── API: 로그인 필요 ──
      if (!ctx.member) throw new RequestError(401, member && !member.active ? `비활성 멤버: ${member.id}` : "로그인이 필요하다");
      if (p === "/me" && req.method === "GET") {
        const m = ctx.member;
        return json(res, 200, { id: m.id, admin: m.admin, ...(m.tracker_id ? { tracker_id: m.tracker_id } : {}) });
      }
      if (p === "/config" && req.method === "GET") {
        const product = url.searchParams.get("product") ?? "";
        const c = await buildConfig(opts.store, product, opts.keys, url.searchParams.get("version") ?? undefined);
        if (!c) throw new RequestError(404, `설정이 없는 제품·버전: ${product}`);
        return json(res, 200, c);
      }
      // ── 편집 기록 (서버 ③, M7) ──
      if (p === "/editlog" && req.method === "POST") {
        const product = url.searchParams.get("product") ?? "";
        try {
          return json(res, 200, await opts.signer.uploadEditlog(ctx.member, product, JSON.parse(await ctx.body())));
        } catch (e) {
          // seq가 이어지지 않으면 서버의 마지막 seq를 그대로 돌려준다 (확장은 그 다음부터 다시 보낸다)
          if (e instanceof RequestError && e.status === 409 && e.message.startsWith("{")) return json(res, 409, { error: "편집 기록 seq가 이어지지 않는다", ...JSON.parse(e.message) });
          throw e;
        }
      }
      const el = /^\/editlog\/([^/]+)(\/blame)?$/.exec(p);
      if (el && req.method === "GET") {
        const product = url.searchParams.get("product") ?? "";
        const epic = decodeURIComponent(el[1]!);
        if (el[2]) return json(res, 200, await opts.signer.blame(product, epic, url.searchParams.get("file") ?? "", url.searchParams.get("rev") ?? ""));
        return json(res, 200, await opts.signer.getEditlog(product, epic, Number(url.searchParams.get("from")) || 1));
      }
      if (p === "/git/token" && req.method === "POST") {
        if (!opts.githost) throw new RequestError(404, "내장 git 서버가 꺼져 있다");
        return json(res, 200, { member: ctx.member.id, ...opts.githost.issueToken(ctx.member.id) });
      }
      if (p === "/events" && req.method === "POST") {
        const body = JSON.parse(await ctx.body());
        for (const k of ["product", "epic", "type"]) if (typeof body[k] !== "string") throw new RequestError(400, `${k}가 없다`);
        const r = await opts.signer.request(ctx.member, { product: body.product, epic: body.epic, type: body.type, data: body.data ?? {} });
        return json(res, 200, r);
      }
      // 반영 (§11.2). 서버가 마지막 승인·재보고 때 스스로 작업을 걸므로(M5 Y5) 이것은 재시도용이다. 검증은 작업 안에서 다시 한다
      if (p === "/land" && req.method === "POST") {
        const body = JSON.parse(await ctx.body());
        for (const k of ["product", "epic"]) if (typeof body[k] !== "string") throw new RequestError(400, `${k}가 없다`);
        return json(res, 202, opts.signer.land(body.product, body.epic));
      }
      const job = /^\/land\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(p);
      if (job && req.method === "GET") {
        const j = opts.signer.job(job[1]!);
        if (!j) throw new RequestError(404, "없는 반영 작업");
        return json(res, 200, j);
      }
      throw new RequestError(404, `없는 경로: ${req.method} ${p}`);
    } catch (e) {
      if (e instanceof RequestError) return json(res, e.status, { error: e.message });
      if (e instanceof SyntaxError) return json(res, 400, { error: `JSON 형식 오류: ${e.message}` });
      console.error(e);
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

/** Google 인가 코드 → 확인된 이메일 (M2에서는 OAuth 클라이언트가 없어 실제로 확인하지 못했다) */
async function googleEmail(g: NonNullable<AppOptions["google"]>, code: string): Promise<string> {
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: `${g.publicUrl}/auth/callback`, grant_type: "authorization_code" }),
  }).then((r) => r.json() as Promise<{ id_token?: string; error?: string }>);
  if (!tok.id_token) throw new RequestError(401, `Google 로그인 실패: ${tok.error ?? "id_token 없음"}`);
  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tok.id_token)}`).then((r) => r.json() as Promise<{ aud?: string; email?: string; email_verified?: string }>);
  if (info.aud !== g.clientId || info.email_verified !== "true" || !info.email) throw new RequestError(401, "Google 계정을 확인하지 못했다");
  return info.email;
}
