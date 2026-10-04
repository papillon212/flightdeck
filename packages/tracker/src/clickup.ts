// ClickUp REST v2 어댑터 (설계 §1.4, pipeline.yaml tracker.clickup).
// M2 스파이크(2026-10-04, 시험 리스트)로 확인한 것:
// - 목록: GET /list/{id}/task?tags[]=…&assignees[]=…  (include_markdown_description=true면 본문이 마크다운)
// - 상태: PUT /task/{id} {status} — 상태 이름 그대로 (사용자 정의 상태 포함)
// - 멘션: POST /task/{id}/comment {comment:[{type:"tag",user:{id}},{text}], notify_all:false}
//   comment_text에 "@이름"으로 들어간다. 읽기 API는 멘션 항목의 사용자 ID를 돌려주지 않는다.
import type { Phase } from "@flightdeck/schema";
import type { TrackerAdapter, TrackerEpic, TrackerUser } from "./types.ts";

export interface ClickUpConfig {
  token: string;
  list_ids: string[];
  /** Flightdeck 대상 일감의 태그 */
  tag?: string;
  /** 단계 → 상태 이름 */
  status_map: Partial<Record<Phase, string>>;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface Task {
  id: string;
  name: string;
  markdown_description?: string;
  description?: string;
  text_content?: string;
  url: string;
  status: { status: string };
  tags: { name: string }[];
}

export class ClickUpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`ClickUp ${what} 실패 (${status}): ${body.slice(0, 200)}`);
  }
}

/** ClickUp 일감 → Flightdeck 에픽 ID (설계 예시 CU-86abc123) */
export const clickupEpicId = (taskId: string) => `CU-${taskId}`;

export class ClickUpTracker implements TrackerAdapter {
  readonly id = "clickup";
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private cfg: ClickUpConfig) {
    this.base = cfg.baseUrl ?? "https://api.clickup.com/api/v2";
    this.f = cfg.fetch ?? fetch;
  }

  private async call<T>(what: string, method: string, p: string, body?: unknown): Promise<T> {
    const r = await this.f(this.base + p, {
      method,
      headers: { authorization: this.cfg.token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new ClickUpError(r.status, text, what);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private epic(t: Task): TrackerEpic {
    return {
      ref: t.id,
      epicId: clickupEpicId(t.id),
      title: t.name,
      body: (t.markdown_description ?? t.text_content ?? t.description ?? "").trim(),
      url: t.url,
      status: t.status.status,
      tags: t.tags.map((x) => x.name),
    };
  }

  async me(): Promise<TrackerUser> {
    const r = await this.call<{ user: { id: number; username: string } }>("사용자 조회", "GET", "/user");
    return { id: String(r.user.id), name: r.user.username };
  }

  async listAssignedEpics(me: TrackerUser): Promise<TrackerEpic[]> {
    const out: TrackerEpic[] = [];
    for (const list of this.cfg.list_ids) {
      for (let page = 0; ; page++) {
        const q = new URLSearchParams({ page: String(page), include_markdown_description: "true", subtasks: "true" });
        q.append("assignees[]", me.id);
        if (this.cfg.tag) q.append("tags[]", this.cfg.tag);
        const r = await this.call<{ tasks: Task[]; last_page?: boolean }>("일감 목록", "GET", `/list/${list}/task?${q}`);
        out.push(...r.tasks.map((t) => this.epic(t)));
        if (r.last_page !== false || !r.tasks.length) break;
      }
    }
    return out;
  }

  async getEpic(ref: string): Promise<TrackerEpic> {
    return this.epic(await this.call<Task>("일감 조회", "GET", `/task/${encodeURIComponent(ref)}?include_markdown_description=true`));
  }

  async setPhase(ref: string, phase: Phase): Promise<void> {
    const status = this.cfg.status_map[phase];
    if (!status) return;
    await this.call("상태 변경", "PUT", `/task/${encodeURIComponent(ref)}`, { status });
  }

  async setFields(_ref: string, _f: Record<string, string>): Promise<void> {
    // 사용자 정의 필드는 M2 범위 밖 (필드 ID 대응이 필요하다)
  }

  async notifyMention(ref: string, to: TrackerUser[], text: string, link: string): Promise<void> {
    if (!to.length) return;
    const comment = [...to.flatMap((u) => [{ type: "tag", user: { id: Number(u.id) } }, { text: " " }]), { text: `${text} · ${link}` }];
    await this.call("멘션 댓글", "POST", `/task/${encodeURIComponent(ref)}/comment`, { comment, notify_all: false });
  }
}
