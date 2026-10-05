// Google Meet 연동 (설계 §10.1·§10.3, M0 10·12번, M6 제안 G2·G5·G6). VS Code API를 쓰지 않는다.
// - MeetAdapter: 공간 만들기(회의록·전사 자동 생성 요청), 회의 기록·회의록 문서·전사 항목 조회
// - RestMeet: Google REST + OAuth 토큰 공급자 (설정 flightdeck.googleClientId가 있을 때, PKCE + 루프백)
// - GwsMeet: 설치된 gws CLI에 위임 (개발용, M0에서 쓴 것)
// - FixtureMeet: 시험용 회의 자료 폴더 (notes.md, transcript.json). 실제 회의 없이 앵커링·게시를 확인한다
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { TranscriptEntry } from "@flightdeck/core";

export interface MeetSpace {
  name: string;
  uri: string;
  code?: string;
  /** 요청한 회의록·전사 자동 생성이 실제로 설정됐는지 (G2) */
  artifacts?: { notes: string; transcript: string };
}

export interface ConferenceRecord {
  name: string;
  startTime: string;
  endTime?: string;
}

export interface MeetArtifacts {
  notes: { name: string; state: string; docId?: string }[];
  transcripts: { name: string; state: string; docId?: string }[];
}

export interface MeetAdapter {
  readonly kind: string;
  createSpace(): Promise<MeetSpace>;
  /** 그 공간의 회의 기록 (최신이 끝) */
  conferences(space: string): Promise<ConferenceRecord[]>;
  artifacts(conference: string): Promise<MeetArtifacts>;
  transcriptEntries(transcript: string): Promise<TranscriptEntry[]>;
  docText(docId: string): Promise<string>;
}

/** 회의록 만들기 요청 (G2): 회의록·전사 자동 생성 */
export const SPACE_REQUEST = { config: { artifactConfig: { smartNotesConfig: { autoSmartNotesGeneration: "ON" }, transcriptionConfig: { autoTranscriptionGeneration: "ON" } } } };

// ---------------------------------------------------------------- 응답 해석 (REST·gws 공통)

export function parseSpace(o: any): MeetSpace {
  const a = o?.config?.artifactConfig;
  return {
    name: String(o.name),
    uri: String(o.meetingUri),
    ...(o.meetingCode ? { code: String(o.meetingCode) } : {}),
    artifacts: { notes: a?.smartNotesConfig?.autoSmartNotesGeneration ?? "알 수 없음", transcript: a?.transcriptionConfig?.autoTranscriptionGeneration ?? "알 수 없음" },
  };
}

const docIdOf = (x: any): string | undefined => x?.docsDestination?.document;

export function parseArtifacts(notes: any, transcripts: any): MeetArtifacts {
  return {
    notes: (notes?.smartNotes ?? []).map((n: any) => ({ name: n.name, state: n.state, ...(docIdOf(n) ? { docId: docIdOf(n) } : {}) })),
    transcripts: (transcripts?.transcripts ?? []).map((t: any) => ({ name: t.name, state: t.state, ...(docIdOf(t) ? { docId: docIdOf(t) } : {}) })),
  };
}

export function parseEntries(pages: any[]): TranscriptEntry[] {
  return pages.flatMap((p) => (p?.transcriptEntries ?? []).map((e: any) => ({ participant: String(e.participant ?? ""), startTime: String(e.startTime ?? ""), ...(e.endTime ? { endTime: String(e.endTime) } : {}), text: String(e.text ?? "") })));
}

/** Docs 문서 본문 텍스트 (첫 탭 = 회의록, M0 10번) */
export function docBodyText(doc: any): string {
  const content = doc?.body?.content ?? doc?.tabs?.[0]?.documentTab?.body?.content ?? [];
  const out: string[] = [];
  for (const el of content) {
    const parts = el?.paragraph?.elements ?? [];
    const line = parts.map((p: any) => p?.textRun?.content ?? "").join("");
    if (line) out.push(line);
  }
  return out.join("").trim();
}

// ---------------------------------------------------------------- Google REST

export type TokenProvider = () => Promise<string>;

export class RestMeet implements MeetAdapter {
  readonly kind = "google";
  constructor(
    private token: TokenProvider,
    private f: typeof fetch = fetch,
  ) {}

  private async call(method: string, url: string, body?: unknown): Promise<any> {
    const r = await this.f(url, { method, headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`Google API ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async createSpace() {
    return parseSpace(await this.call("POST", "https://meet.googleapis.com/v2/spaces", SPACE_REQUEST));
  }
  async conferences(space: string) {
    const q = new URLSearchParams({ filter: `space.name="${space}"` });
    const r = await this.call("GET", `https://meet.googleapis.com/v2/conferenceRecords?${q}`);
    return ((r.conferenceRecords ?? []) as any[]).map((c) => ({ name: c.name, startTime: c.startTime, ...(c.endTime ? { endTime: c.endTime } : {}) })).sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  }
  async artifacts(conference: string) {
    return parseArtifacts(await this.call("GET", `https://meet.googleapis.com/v2/${conference}/smartNotes`), await this.call("GET", `https://meet.googleapis.com/v2/${conference}/transcripts`));
  }
  async transcriptEntries(transcript: string) {
    const pages: any[] = [];
    let token = "";
    for (let i = 0; i < 50; i++) {
      const p = await this.call("GET", `https://meet.googleapis.com/v2/${transcript}/entries?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
      pages.push(p);
      if (!p.nextPageToken) break;
      token = p.nextPageToken;
    }
    return parseEntries(pages);
  }
  async docText(docId: string) {
    return docBodyText(await this.call("GET", `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`));
  }
}

/**
 * 데스크톱 OAuth (§10.3, G5): PKCE + 루프백. 받은 토큰은 호출하는 쪽이 저장한다(refresh token).
 * 클라이언트가 없어(M2부터 미결) 실제로는 확인하지 못했다
 */
export async function googleDesktopLogin(o: { clientId: string; clientSecret?: string; scopes: string[]; open: (url: string) => void | Promise<void>; f?: typeof fetch }): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.searchParams.get("state") !== state) return void res.end("state 불일치");
      res.end("Flightdeck: Google 로그인 완료. 이 창을 닫으세요.");
      srv.close();
      const c = u.searchParams.get("code");
      c ? resolve({ code: c, redirect: `http://127.0.0.1:${(srv.address() as { port: number }).port}` }) : reject(new Error(u.searchParams.get("error") ?? "인가 코드 없음"));
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      const q = new URLSearchParams({ client_id: o.clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code", scope: o.scopes.join(" "), code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" });
      void o.open(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
    });
    setTimeout(() => (srv.close(), reject(new Error("Google 로그인 시간 초과"))), 5 * 60_000).unref();
  });
  const r = await (o.f ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: code.code, client_id: o.clientId, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}), redirect_uri: code.redirect, grant_type: "authorization_code", code_verifier: verifier }),
  });
  const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!t.access_token) throw new Error(`Google 로그인 실패: ${t.error ?? r.status}`);
  return { access_token: t.access_token, ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}), expires_in: t.expires_in ?? 3600 };
}

export const MEET_SCOPES = ["https://www.googleapis.com/auth/meetings.space.created", "https://www.googleapis.com/auth/documents.readonly"];

// ---------------------------------------------------------------- gws CLI (개발용)

function gws(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => (err ? reject(new Error(`gws ${args.slice(0, 3).join(" ")} 실패: ${(stderr || stdout || String(err)).slice(0, 300)}`)) : resolve(stdout)));
  });
}

const json = (s: string) => {
  const i = s.indexOf("{");
  return i < 0 ? {} : JSON.parse(s.slice(i));
};

export class GwsMeet implements MeetAdapter {
  readonly kind = "gws";
  constructor(private bin = "gws") {}
  async createSpace() {
    return parseSpace(json(await gws(this.bin, ["meet", "spaces", "create", "--json", JSON.stringify(SPACE_REQUEST)])));
  }
  async conferences(space: string) {
    const r = json(await gws(this.bin, ["meet", "conferenceRecords", "list", "--params", JSON.stringify({ filter: `space.name="${space}"` })]));
    return ((r.conferenceRecords ?? []) as any[]).map((c) => ({ name: c.name, startTime: c.startTime, ...(c.endTime ? { endTime: c.endTime } : {}) })).sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  }
  /** 최근 회의 기록 (공간 필터 없이, 구조 확인용) */
  async recentConferences(): Promise<(ConferenceRecord & { space: string })[]> {
    const r = json(await gws(this.bin, ["meet", "conferenceRecords", "list", "--params", JSON.stringify({ pageSize: 10 })]));
    return ((r.conferenceRecords ?? []) as any[]).map((c) => ({ name: c.name, space: c.space, startTime: c.startTime, ...(c.endTime ? { endTime: c.endTime } : {}) }));
  }
  async artifacts(conference: string) {
    const n = json(await gws(this.bin, ["meet", "conferenceRecords", "smartNotes", "list", "--params", JSON.stringify({ parent: conference })]));
    const t = json(await gws(this.bin, ["meet", "conferenceRecords", "transcripts", "list", "--params", JSON.stringify({ parent: conference })]));
    return parseArtifacts(n, t);
  }
  async transcriptEntries(transcript: string) {
    const out = await gws(this.bin, ["meet", "conferenceRecords", "transcripts", "entries", "list", "--params", JSON.stringify({ parent: transcript, pageSize: 100 }), "--page-all"]);
    return parseEntries(out.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l)));
  }
  async docText(docId: string) {
    return docBodyText(json(await gws(this.bin, ["docs", "documents", "get", "--params", JSON.stringify({ documentId: docId })])));
  }
}

// ---------------------------------------------------------------- 시험용 회의 자료

/** dir/notes.md(회의록), dir/transcript.json(전사 항목 배열). 공간은 가짜, 회의는 곧바로 끝난 것으로 본다 */
export class FixtureMeet implements MeetAdapter {
  readonly kind = "fixture";
  constructor(private dir: string) {}
  async createSpace() {
    return { name: `spaces/fixture-${randomBytes(4).toString("hex")}`, uri: "https://meet.google.com/fix-ture-xyz", code: "fix-ture-xyz", artifacts: { notes: "ON", transcript: "ON" } };
  }
  async conferences(_space: string) {
    return [{ name: "conferenceRecords/fixture", startTime: new Date(Date.now() - 30 * 60_000).toISOString(), endTime: new Date().toISOString() }];
  }
  async artifacts(_c: string) {
    return {
      notes: existsSync(path.join(this.dir, "notes.md")) ? [{ name: "smartNotes/fixture", state: "FILE_GENERATED", docId: "fixture-notes" }] : [],
      transcripts: existsSync(path.join(this.dir, "transcript.json")) ? [{ name: "transcripts/fixture", state: "FILE_GENERATED", docId: "fixture-transcript" }] : [],
    };
  }
  async transcriptEntries(_t: string) {
    return JSON.parse(await readFile(path.join(this.dir, "transcript.json"), "utf8")) as TranscriptEntry[];
  }
  async docText(_id: string) {
    return readFile(path.join(this.dir, "notes.md"), "utf8");
  }
}

// ---------------------------------------------------------------- 회의록 기다리기 (§10.1 ⑤, S1)

export interface CollectedNotes {
  conference: ConferenceRecord | null;
  notes: string | null;
  notesDoc?: string;
  transcript: TranscriptEntry[];
  /** 기다린 시간 (ms) */
  waited: number;
}

/** 회의가 끝나고 회의록이 생길 때까지 1분 간격으로 본다. 시간을 넘기면 회의록 없이(전사는 있으면) 돌려준다 */
export async function waitForNotes(meet: MeetAdapter, space: string, o: { intervalMs?: number; timeoutMs?: number; onWait?: (msg: string) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<CollectedNotes> {
  const t0 = Date.now();
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const interval = o.intervalMs ?? 60_000;
  const timeout = o.timeoutMs ?? 30 * 60_000;
  for (;;) {
    const confs = (await meet.conferences(space)).filter((c) => c.endTime);
    const conf = confs.at(-1) ?? null;
    if (conf) {
      const a = await meet.artifacts(conf.name);
      const note = a.notes.find((n) => n.state === "FILE_GENERATED" && n.docId);
      const tr = a.transcripts.find((t) => t.state === "FILE_GENERATED");
      if (note) {
        return { conference: conf, notes: await meet.docText(note.docId!), notesDoc: note.docId!, transcript: tr ? await meet.transcriptEntries(tr.name) : [], waited: Date.now() - t0 };
      }
      if (Date.now() - t0 > timeout) return { conference: conf, notes: null, transcript: tr ? await meet.transcriptEntries(tr.name) : [], waited: Date.now() - t0 };
      o.onWait?.(`회의록 준비 중 (보통 수 분, ${Math.round((Date.now() - t0) / 60_000)}분 지남)`);
    } else {
      if (Date.now() - t0 > timeout) return { conference: null, notes: null, transcript: [], waited: Date.now() - t0 };
      o.onWait?.("회의 기록을 기다리는 중 (회의가 끝나면 생깁니다)");
    }
    await sleep(interval);
  }
}
