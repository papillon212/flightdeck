// 어드민 화면 (설계 §2.5, §11.2 /admin/*): 멤버 등록·비활성, 제품별 파이프라인·룰 편집(저장 = 새 설정 버전), 변경 이력.
// 서버가 그리는 단순한 HTML 폼이다. 쿠키 세션(SameSite=Strict) + POST의 Origin 확인.
import { parsePipeline } from "@flightdeck/schema";
import { isLoopback, type Ctx } from "./http.ts";
import { RequestError } from "./signer.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const PRODUCT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RULE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function page(title: string, body: string, who?: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Flightdeck 어드민</title><style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--accent:#0b5cad;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f2f2f2;--muted:#a1a1a6;--line:#3a3a3c;--accent:#6aa9ff;--bad:#ff8a80}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1000px;padding:16px}
a{color:var(--accent)}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600}textarea{width:100%;font:13px/1.4 ui-monospace,monospace;box-sizing:border-box}
input,select,textarea,button{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
button{cursor:pointer}nav{display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:16px;flex-wrap:wrap}
.muted{color:var(--muted)}.bad{color:var(--bad)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style></head><body><nav><strong>Flightdeck 어드민</strong><a href="/admin">멤버·제품</a><a href="/admin/audit">변경 이력</a>
${who ? `<span class="muted" style="margin-left:auto">${esc(who)}</span><form method="post" action="/auth/logout"><button>로그아웃</button></form>` : ""}</nav>
<h1>${esc(title)}</h1>${body}</body></html>`;
}

function send(ctx: Ctx, status: number, html: string, headers: Record<string, string> = {}) {
  ctx.res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  ctx.res.end(html);
}

const redirect = (ctx: Ctx, to: string, headers: Record<string, string> = {}) => {
  ctx.res.writeHead(303, { location: to, ...headers });
  ctx.res.end();
};

async function form(ctx: Ctx): Promise<URLSearchParams> {
  const origin = ctx.req.headers.origin;
  if (origin && origin !== `http://${ctx.req.headers.host}` && origin !== `https://${ctx.req.headers.host}`) throw new RequestError(403, "다른 출처의 요청");
  return new URLSearchParams(await ctx.body());
}

export async function adminRoutes(ctx: Ctx): Promise<void> {
  const { url, req, opts } = ctx;
  const p = url.pathname;

  // 개발용 로그인 (루프백만)
  if (p === "/admin/dev-login" && req.method === "POST") {
    if (!opts.devLogin || !isLoopback(req)) throw new RequestError(404, "개발용 로그인이 꺼져 있다");
    const m = await opts.store.getMember((await form(ctx)).get("member") ?? "");
    if (!m?.active) throw new RequestError(403, "등록되지 않았거나 비활성인 멤버");
    const t = await opts.store.createSession(m.id, 12 * 3600_000);
    return redirect(ctx, "/admin", { "set-cookie": `fd_session=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/` });
  }

  if (!ctx.member) {
    const members = opts.devLogin && isLoopback(req) ? (await opts.store.listMembers()).filter((m) => m.active && m.admin) : [];
    const dev = members.length
      ? `<form method="post" action="/admin/dev-login" class="row"><span>개발용 로그인</span><select name="member">${members.map((m) => `<option>${esc(m.id)}</option>`).join("")}</select><button>들어가기</button></form>`
      : "";
    const google = opts.google ? `<p><a href="/auth/login">Google 계정으로 로그인</a></p>` : `<p class="muted">Google 로그인이 설정되지 않았다.</p>`;
    return send(ctx, 401, page("로그인", google + dev));
  }
  if (!ctx.member.admin) return send(ctx, 403, page("권한 없음", `<p>${esc(ctx.member.id)}은(는) 어드민이 아니다.</p>`, ctx.member.id));
  const who = ctx.member.id;

  if (p === "/admin" && req.method === "GET") {
    const members = await opts.store.listMembers();
    const products = await opts.store.listProducts();
    const rows = members
      .map(
        (m) => `<tr><td>${esc(m.id)}</td><td>${esc(m.email)}</td><td>${esc(m.tracker_id)}</td><td>${m.active ? "활성" : `<span class="bad">비활성</span> <span class="muted">${esc(m.deactivated_at)}</span>`}</td><td>${m.admin ? "어드민" : ""}</td>
<td><form method="post" action="/admin/members" class="row"><input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="email" value="${esc(m.email)}"><input type="hidden" name="tracker_id" value="${esc(m.tracker_id)}">${m.admin ? `<input type="hidden" name="admin" value="on">` : ""}${m.active ? "" : `<input type="hidden" name="active" value="on">`}<button>${m.active ? "비활성으로" : "다시 활성으로"}</button></form></td></tr>`,
      )
      .join("");
    return send(
      ctx,
      200,
      page(
        "멤버·제품",
        `<h2>멤버</h2><table><tr><th>멤버 ID</th><th>Google 이메일</th><th>일감 도구 ID</th><th>상태</th><th></th><th></th></tr>${rows}</table>
<h3>등록·수정</h3><form method="post" action="/admin/members" class="row">
<input name="id" placeholder="멤버 ID (예: dh.lee)" required pattern="[a-z0-9][a-z0-9._-]*"><input name="email" type="email" placeholder="Google 이메일" required>
<input name="tracker_id" placeholder="일감 도구 ID"><label><input type="checkbox" name="active" checked> 활성</label><label><input type="checkbox" name="admin"> 어드민</label><button>저장</button></form>
<h2>제품</h2><table><tr><th>제품</th><th>현재 설정 버전</th></tr>${products.map((x) => `<tr><td><a href="/admin/products/${esc(x.product)}">${esc(x.product)}</a></td><td>${esc(x.current)}</td></tr>`).join("")}</table>
<form method="get" action="/admin/products/new" class="row" style="margin-top:8px"><input name="product" placeholder="새 제품 ID" pattern="[a-z0-9][a-z0-9-]*" required><button>만들기</button></form>`,
        who,
      ),
    );
  }

  if (p === "/admin/members" && req.method === "POST") {
    const f = await form(ctx);
    const id = f.get("id") ?? "";
    const email = f.get("email") ?? "";
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !email.includes("@")) throw new RequestError(400, "멤버 ID 또는 이메일 형식이 틀렸다");
    if (id === who && f.get("active") !== "on") throw new RequestError(400, "자기 자신은 비활성으로 바꿀 수 없다");
    const tracker = f.get("tracker_id")?.trim();
    await opts.store.upsertMember({ id, email, ...(tracker ? { tracker_id: tracker } : {}), active: f.get("active") === "on", admin: f.get("admin") === "on" }, who);
    return redirect(ctx, "/admin");
  }

  const prod = /^\/admin\/products\/([^/]+)$/.exec(p);
  if (p === "/admin/products/new" && req.method === "GET") {
    const id = url.searchParams.get("product") ?? "";
    if (!PRODUCT.test(id)) throw new RequestError(400, "제품 ID 형식이 틀렸다");
    return redirect(ctx, `/admin/products/${id}`);
  }
  if (prod && req.method === "GET") {
    const product = decodeURIComponent(prod[1]!);
    const cur = await opts.store.currentConfig(product);
    const versions = await opts.store.listConfigVersions(product);
    const rules = cur?.rules ?? { common: "", analysis: "", design: "" };
    return send(ctx, 200, editor(product, cur?.version ?? null, cur?.pipeline_yaml ?? `version: 1\nproduct: ${product}\nrepo: \n`, rules, versions.map((v) => ({ version: v.version, by: v.created_by, at: v.created_at, note: v.note })), null, who));
  }
  if (prod && req.method === "POST") {
    const product = decodeURIComponent(prod[1]!);
    if (!PRODUCT.test(product)) throw new RequestError(400, "제품 ID 형식이 틀렸다");
    const f = await form(ctx);
    const yaml = f.get("pipeline_yaml") ?? "";
    const rules: Record<string, string> = {};
    for (const [k, v] of f) if (k.startsWith("rule:") && RULE.test(k.slice(5))) rules[k.slice(5)] = v;
    const newName = f.get("new_rule_name")?.trim();
    if (newName) {
      if (!RULE.test(newName)) throw new RequestError(400, "룰 이름 형식이 틀렸다");
      rules[newName] = f.get("new_rule_body") ?? "";
    }
    try {
      const pl = parsePipeline(yaml);
      if (pl.product !== product) throw new Error(`pipeline.yaml의 product(${pl.product})가 이 제품(${product})과 다르다`);
    } catch (e) {
      const cur = await opts.store.listConfigVersions(product);
      return send(ctx, 400, editor(product, cur[0]?.version ?? null, yaml, rules, cur.map((v) => ({ version: v.version, by: v.created_by, at: v.created_at, note: v.note })), e instanceof Error ? e.message : String(e), who));
    }
    await opts.store.addConfigVersion({ product, pipeline_yaml: yaml, rules, created_by: who, ...(f.get("note") ? { note: f.get("note")! } : {}) });
    return redirect(ctx, `/admin/products/${product}`);
  }

  if (p === "/admin/audit" && req.method === "GET") {
    const log = await opts.store.audit(200);
    return send(ctx, 200, page("변경 이력", `<table><tr><th>시각</th><th>누가</th><th>무엇</th><th>내용</th></tr>${log.map((l) => `<tr><td>${esc(l.at)}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td><code>${esc(JSON.stringify(l.detail))}</code></td></tr>`).join("")}</table>`, who));
  }

  throw new RequestError(404, `없는 경로: ${req.method} ${p}`);
}

function editor(product: string, version: string | null, yaml: string, rules: Record<string, string>, versions: { version: string; by: string; at: string; note?: string }[], error: string | null, who: string): string {
  return page(
    `제품 ${product}`,
    `<p class="muted">현재 설정 버전: ${esc(version ?? "없음")}. 저장하면 새 버전이 생기고, 새 에픽부터 그 버전을 쓴다. 진행 중 에픽은 시작할 때의 버전을 그대로 쓴다.</p>
${error ? `<p class="bad">저장하지 않았다: ${esc(error)}</p>` : ""}
<form method="post"><h2>pipeline.yaml</h2><textarea name="pipeline_yaml" rows="24">${esc(yaml)}</textarea>
<h2>룰</h2>${Object.entries(rules).map(([k, v]) => `<h3>rules/${esc(k)}.md</h3><textarea name="rule:${esc(k)}" rows="8">${esc(v)}</textarea>`).join("")}
<h3>룰 추가</h3><div class="row"><input name="new_rule_name" placeholder="이름 (예: implementation)"></div><textarea name="new_rule_body" rows="4"></textarea>
<p class="row"><input name="note" placeholder="변경 메모" style="flex:1"><button>새 버전으로 저장</button></p></form>
<h2>버전</h2><table><tr><th>버전</th><th>누가</th><th>언제</th><th>메모</th></tr>${versions.map((v) => `<tr><td>${esc(v.version)}</td><td>${esc(v.by)}</td><td>${esc(v.at)}</td><td>${esc(v.note)}</td></tr>`).join("")}</table>`,
    who,
  );
}
