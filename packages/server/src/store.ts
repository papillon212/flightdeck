// 서버 저장소 (설계 §2.5, §11.5): 멤버, 로그인 세션, 제품별 설정 버전, 변경 이력.
// 운영은 PostgreSQL(pg.ts), 테스트는 메모리 구현.
import { createHash, randomBytes } from "node:crypto";
import { nowIso } from "@flightdeck/core";

export interface Member {
  id: string;
  /** Google 계정 이메일 (로그인 시 이것으로 멤버를 찾는다) */
  email: string;
  /** 일감 도구 사용자 ID (§1.4 notifyMention) */
  tracker_id?: string;
  active: boolean;
  admin: boolean;
  /** 비활성으로 바꾼 시각. 이 시각 이후의 일반 이벤트는 reducer가 무시한다 (§12) */
  deactivated_at?: string;
}

export interface ConfigVersion {
  product: string;
  /** 설정 버전 ID. 한 번 만들면 바뀌지 않는다 */
  version: string;
  pipeline_yaml: string;
  /** rules/<이름>.md → 내용 */
  rules: Record<string, string>;
  created_by: string;
  created_at: string;
  note?: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: unknown;
}

export interface ServerStore {
  listMembers(): Promise<Member[]>;
  getMember(id: string): Promise<Member | null>;
  getMemberByEmail(email: string): Promise<Member | null>;
  /** 등록·수정. 활성 → 비활성이면 deactivated_at을 채우고, 다시 활성이면 지운다 */
  upsertMember(m: Omit<Member, "deactivated_at">, actor: string): Promise<Member>;

  createSession(member: string, ttlMs: number): Promise<string>;
  /** 유효한 세션의 멤버. 만료·없음은 null */
  sessionMember(token: string): Promise<string | null>;
  deleteSession(token: string): Promise<void>;

  listProducts(): Promise<{ product: string; current: string | null }[]>;
  /** 새 설정 버전을 만들고 현재 버전으로 둔다 */
  addConfigVersion(v: Omit<ConfigVersion, "version" | "created_at">): Promise<ConfigVersion>;
  getConfigVersion(product: string, version: string): Promise<ConfigVersion | null>;
  currentConfig(product: string): Promise<ConfigVersion | null>;
  listConfigVersions(product: string): Promise<ConfigVersion[]>;

  audit(limit?: number): Promise<AuditEntry[]>;
  /** 저장소 밖의 어드민 작업(내장 레포 가져오기 등)을 변경 이력에 남긴다 */
  addAudit(actor: string, action: string, detail: unknown): Promise<void>;
  close(): Promise<void>;
}

/** 세션 토큰은 해시로만 저장한다 */
export const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export function nextMemberState(prev: Member | null, m: Omit<Member, "deactivated_at">, at = nowIso()): Member {
  const deactivated_at = m.active ? undefined : (prev && !prev.active ? prev.deactivated_at : at);
  return { ...m, ...(deactivated_at ? { deactivated_at } : {}) };
}

export class MemoryStore implements ServerStore {
  private members = new Map<string, Member>();
  private sessions = new Map<string, { member: string; expires: number }>();
  private versions = new Map<string, ConfigVersion[]>();
  private log: AuditEntry[] = [];

  private record(actor: string, action: string, detail: unknown) {
    this.log.push({ at: nowIso(), actor, action, detail });
  }

  async listMembers() {
    return [...this.members.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  async getMember(id: string) {
    return this.members.get(id) ?? null;
  }
  async getMemberByEmail(email: string) {
    return [...this.members.values()].find((m) => m.email.toLowerCase() === email.toLowerCase()) ?? null;
  }
  async upsertMember(m: Omit<Member, "deactivated_at">, actor: string) {
    const next = nextMemberState(this.members.get(m.id) ?? null, m);
    this.members.set(m.id, next);
    this.record(actor, "member.upsert", next);
    return next;
  }

  async createSession(member: string, ttlMs: number) {
    const t = newToken();
    this.sessions.set(tokenHash(t), { member, expires: Date.now() + ttlMs });
    return t;
  }
  async sessionMember(token: string) {
    const s = this.sessions.get(tokenHash(token));
    return s && s.expires > Date.now() ? s.member : null;
  }
  async deleteSession(token: string) {
    this.sessions.delete(tokenHash(token));
  }

  async listProducts() {
    return [...this.versions.entries()].map(([product, vs]) => ({ product, current: vs.at(-1)?.version ?? null }));
  }
  async addConfigVersion(v: Omit<ConfigVersion, "version" | "created_at">) {
    const list = this.versions.get(v.product) ?? [];
    const cv: ConfigVersion = { ...v, version: `${v.product}-v${list.length + 1}`, created_at: nowIso() };
    list.push(cv);
    this.versions.set(v.product, list);
    this.record(v.created_by, "config.version", { product: cv.product, version: cv.version, note: cv.note });
    return cv;
  }
  async getConfigVersion(product: string, version: string) {
    return this.versions.get(product)?.find((v) => v.version === version) ?? null;
  }
  async currentConfig(product: string) {
    return this.versions.get(product)?.at(-1) ?? null;
  }
  async listConfigVersions(product: string) {
    return [...(this.versions.get(product) ?? [])].reverse();
  }

  async audit(limit = 100) {
    return this.log.slice(-limit).reverse();
  }
  async addAudit(actor: string, action: string, detail: unknown) {
    this.record(actor, action, detail);
  }
  async close() {}
}
