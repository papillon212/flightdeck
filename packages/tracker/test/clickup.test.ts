// ClickUp 어댑터: M2 스파이크(시험 리스트)에서 기록한 응답 모양으로 검증한다.
import { describe, expect, it } from "vitest";
import { ClickUpError, ClickUpTracker, reconcile } from "../src/index.ts";

const TASK = {
  id: "z8r3fdn5a0",
  name: "[Flightdeck 스파이크] 토큰 갱신 개선",
  markdown_description: "리프레시 토큰을 회전시킨다.\n\n*   재사용 탐지",
  url: "https://app.clickup.com/t/z8r3fdn5a0",
  status: { status: "to do", type: "open" },
  tags: [{ name: "flightdeck" }],
};

function fake(routes: Record<string, (body: any) => unknown>) {
  const calls: { method: string; url: string; body: any; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, url, body, auth: new Headers(init.headers).get("authorization") });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ err: "Route not found", ECODE: "APP_001" }), { status: 404 });
    return new Response(JSON.stringify(h(body)), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const cfg = (f: typeof fetch) => new ClickUpTracker({ token: "pk_test", list_ids: ["1100340000095094"], tag: "flightdeck", status_map: { ANALYSIS: "분석", DESIGN: "설계" }, fetch: f });

describe("ClickUpTracker (설계 §1.4)", () => {
  it("me, 배정된 일감(태그·담당자 필터, 마크다운 본문), 에픽 ID", async () => {
    const { f, calls } = fake({
      "GET /api/v2/user": () => ({ user: { id: 3624282, username: "doohwan lee" } }),
      "GET /api/v2/list/1100340000095094/task": () => ({ tasks: [TASK], last_page: true }),
    });
    const t = cfg(f);
    const me = await t.me();
    expect(me).toEqual({ id: "3624282", name: "doohwan lee" });
    expect(await t.listAssignedEpics(me)).toEqual([
      { ref: "z8r3fdn5a0", epicId: "CU-z8r3fdn5a0", title: TASK.name, body: TASK.markdown_description, url: TASK.url, status: "to do", tags: ["flightdeck"] },
    ]);
    const q = new URL(calls[1]!.url).searchParams;
    expect(q.getAll("assignees[]")).toEqual(["3624282"]);
    expect(q.getAll("tags[]")).toEqual(["flightdeck"]);
    expect(q.get("include_markdown_description")).toBe("true");
    expect(calls.every((c) => c.auth === "pk_test")).toBe(true); // 개인 토큰 (D10)
  });

  it("단계 → 상태 이름, 대응 없는 단계는 호출하지 않음, reconcile은 다를 때만 바꾼다", async () => {
    let status = "to do";
    const { f, calls } = fake({
      "GET /api/v2/task/z8r3fdn5a0": () => ({ ...TASK, status: { status } }),
      "PUT /api/v2/task/z8r3fdn5a0": (b) => ((status = b.status), { ...TASK, status: { status } }),
    });
    const t = cfg(f);
    await t.setPhase("z8r3fdn5a0", "IMPLEMENTATION"); // 대응 없음
    expect(calls).toHaveLength(0);
    const map = (p: string) => ({ ANALYSIS: "분석", DESIGN: "설계" })[p];
    expect(await reconcile(t, "z8r3fdn5a0", "ANALYSIS", map)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { status: "분석" } });
    expect(await reconcile(t, "z8r3fdn5a0", "ANALYSIS", map)).toBe(false); // 같으면 그대로
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("멘션 댓글: 대상마다 tag 항목, 내용은 짧게, 모두에게 알리지 않음", async () => {
    const { f, calls } = fake({ "POST /api/v2/task/z8r3fdn5a0/comment": () => ({ id: 1 }) });
    await cfg(f).notifyMention("z8r3fdn5a0", [{ id: "3624282" }, { id: "2345678" }], "질문 1건 · analysis.md", "vscode://flightdeck/CU-z8r3fdn5a0");
    expect(calls[0]!.body).toEqual({
      comment: [{ type: "tag", user: { id: 3624282 } }, { text: " " }, { type: "tag", user: { id: 2345678 } }, { text: " " }, { text: "질문 1건 · analysis.md · vscode://flightdeck/CU-z8r3fdn5a0" }],
      notify_all: false,
    });
    await cfg(f).notifyMention("z8r3fdn5a0", [], "x", "y");
    expect(calls).toHaveLength(1);
  });

  it("오류는 상태 코드와 본문을 담아 던진다", async () => {
    const { f } = fake({});
    await expect(cfg(f).getEpic("nope")).rejects.toBeInstanceOf(ClickUpError);
    await expect(cfg(f).getEpic("nope")).rejects.toThrow(/일감 조회 실패 \(404\)/);
  });
});
