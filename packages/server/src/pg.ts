// PostgreSQL 저장소 (설계 §11.5). 테이블은 처음 연결할 때 만든다.
import pg from "pg";
import { nowIso } from "@flightdeck/core";
import type { EditMemo, EditRecord } from "@flightdeck/schema";
import { contiguous, newToken, nextMemberState, tokenHash, type AuditEntry, type ConfigVersion, type Member, type ServerStore } from "./store.ts";

const SCHEMA = `
create table if not exists fd_members (
  id text primary key, email text not null unique, tracker_id text,
  active boolean not null, admin boolean not null, deactivated_at text);
create table if not exists fd_sessions (token_hash text primary key, member text not null, expires_at timestamptz not null);
create table if not exists fd_config_versions (
  product text not null, seq integer not null, version text not null, pipeline_yaml text not null, rules jsonb not null,
  created_by text not null, created_at text not null, note text, primary key (product, seq), unique (product, version));
create table if not exists fd_audit (id bigserial primary key, at text not null, actor text not null, action text not null, detail jsonb);
create table if not exists fd_editlog (product text not null, epic text not null, seq integer not null, record jsonb not null, primary key (product, epic, seq));
create table if not exists fd_memos (product text not null, epic text not null, memos jsonb not null, primary key (product, epic));
`;

type Row = Record<string, any>;
const member = (r: Row): Member => ({
  id: r.id, email: r.email, active: r.active, admin: r.admin,
  ...(r.tracker_id ? { tracker_id: r.tracker_id } : {}),
  ...(r.deactivated_at ? { deactivated_at: r.deactivated_at } : {}),
});
const version = (r: Row): ConfigVersion => ({
  product: r.product, version: r.version, pipeline_yaml: r.pipeline_yaml, rules: r.rules,
  created_by: r.created_by, created_at: r.created_at, ...(r.note ? { note: r.note } : {}),
});

export class PgStore implements ServerStore {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    await pool.query(SCHEMA);
    return new PgStore(pool);
  }

  private q(sql: string, params: unknown[] = []) {
    return this.pool.query(sql, params);
  }

  private async record(actor: string, action: string, detail: unknown) {
    await this.q("insert into fd_audit (at, actor, action, detail) values ($1,$2,$3,$4)", [nowIso(), actor, action, JSON.stringify(detail)]);
  }

  async listMembers() {
    return (await this.q("select * from fd_members order by id")).rows.map(member);
  }
  async getMember(id: string) {
    const r = (await this.q("select * from fd_members where id=$1", [id])).rows[0];
    return r ? member(r) : null;
  }
  async getMemberByEmail(email: string) {
    const r = (await this.q("select * from fd_members where lower(email)=lower($1)", [email])).rows[0];
    return r ? member(r) : null;
  }
  async upsertMember(m: Omit<Member, "deactivated_at">, actor: string) {
    const next = nextMemberState(await this.getMember(m.id), m);
    await this.q(
      `insert into fd_members (id,email,tracker_id,active,admin,deactivated_at) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set email=$2, tracker_id=$3, active=$4, admin=$5, deactivated_at=$6`,
      [next.id, next.email, next.tracker_id ?? null, next.active, next.admin, next.deactivated_at ?? null],
    );
    await this.record(actor, "member.upsert", next);
    return next;
  }

  async createSession(memberId: string, ttlMs: number) {
    const t = newToken();
    await this.q("insert into fd_sessions values ($1,$2,$3)", [tokenHash(t), memberId, new Date(Date.now() + ttlMs)]);
    return t;
  }
  async sessionMember(token: string) {
    const r = (await this.q("select member from fd_sessions where token_hash=$1 and expires_at > now()", [tokenHash(token)])).rows[0];
    return r ? (r.member as string) : null;
  }
  async deleteSession(token: string) {
    await this.q("delete from fd_sessions where token_hash=$1", [tokenHash(token)]);
  }

  async listProducts() {
    const rows = (await this.q("select distinct on (product) product, version from fd_config_versions order by product, seq desc")).rows;
    return rows.map((r) => ({ product: r.product as string, current: r.version as string }));
  }
  async addConfigVersion(v: Omit<ConfigVersion, "version" | "created_at">) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [v.product]);
      const seq = Number((await client.query("select coalesce(max(seq),0)+1 as n from fd_config_versions where product=$1", [v.product])).rows[0].n);
      const cv: ConfigVersion = { ...v, version: `${v.product}-v${seq}`, created_at: nowIso() };
      await client.query("insert into fd_config_versions values ($1,$2,$3,$4,$5,$6,$7,$8)", [cv.product, seq, cv.version, cv.pipeline_yaml, JSON.stringify(cv.rules), cv.created_by, cv.created_at, cv.note ?? null]);
      await client.query("insert into fd_audit (at, actor, action, detail) values ($1,$2,$3,$4)", [cv.created_at, cv.created_by, "config.version", JSON.stringify({ product: cv.product, version: cv.version, note: cv.note })]);
      await client.query("commit");
      return cv;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  async getConfigVersion(product: string, ver: string) {
    const r = (await this.q("select * from fd_config_versions where product=$1 and version=$2", [product, ver])).rows[0];
    return r ? version(r) : null;
  }
  async currentConfig(product: string) {
    const r = (await this.q("select * from fd_config_versions where product=$1 order by seq desc limit 1", [product])).rows[0];
    return r ? version(r) : null;
  }
  async listConfigVersions(product: string) {
    return (await this.q("select * from fd_config_versions where product=$1 order by seq desc", [product])).rows.map(version);
  }

  async editlogLast(product: string, epic: string) {
    return Number((await this.q("select coalesce(max(seq),0) as n from fd_editlog where product=$1 and epic=$2", [product, epic])).rows[0].n);
  }
  async appendEditlog(product: string, epic: string, records: EditRecord[]) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`editlog:${product}:${epic}`]);
      const last = Number((await client.query("select coalesce(max(seq),0) as n from fd_editlog where product=$1 and epic=$2", [product, epic])).rows[0].n);
      if (!contiguous(last, records)) {
        await client.query("rollback");
        return false;
      }
      for (const r of records) await client.query("insert into fd_editlog values ($1,$2,$3,$4)", [product, epic, r.seq, JSON.stringify(r)]);
      await client.query("commit");
      return true;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  async editlog(product: string, epic: string, fromSeq = 1) {
    return (await this.q("select record from fd_editlog where product=$1 and epic=$2 and seq >= $3 order by seq", [product, epic, fromSeq])).rows.map((r) => r.record as EditRecord);
  }
  async setMemos(product: string, epic: string, memos: EditMemo[]) {
    await this.q("insert into fd_memos values ($1,$2,$3) on conflict (product, epic) do update set memos=$3", [product, epic, JSON.stringify(memos)]);
  }
  async memos(product: string, epic: string) {
    return ((await this.q("select memos from fd_memos where product=$1 and epic=$2", [product, epic])).rows[0]?.memos as EditMemo[] | undefined) ?? [];
  }

  async addAudit(actor: string, action: string, detail: unknown): Promise<void> {
    await this.record(actor, action, detail);
  }

  async audit(limit = 100): Promise<AuditEntry[]> {
    return (await this.q("select at, actor, action, detail from fd_audit order by id desc limit $1", [limit])).rows as AuditEntry[];
  }
  async close() {
    await this.pool.end();
  }
}
