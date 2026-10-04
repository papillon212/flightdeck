// flightdeck-server HTTP (설계 §11.2). 모듈 ①: 로그인, 설정 배포, 서버 서명 이벤트, 어드민 화면.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { keyFingerprint } from "@flightdeck/core";
import { buildConfig } from "./config.ts";
import { adminRoutes } from "./admin.ts";
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
    const ctx: Ctx = { req, res, url, opts, member: member?.active ? member : null, body: () => (bodyCache ??= readBody(req)) };
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
