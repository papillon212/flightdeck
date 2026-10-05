// flightdeck-server 실행 (설계 §11.5). M2: 모듈 ① (로그인·설정 배포·서버 서명·어드민).
//
// 환경변수
//   FD_DATA_DIR        서버 데이터 폴더 (서버 키, 제품 레포 사본). 기본 ./.flightdeck-server
//   FD_DATABASE_URL    PostgreSQL 연결 문자열. 없으면 --memory가 있어야 한다(재시작하면 사라짐)
//   FD_HOST, FD_PORT   기본 127.0.0.1:8787
//   FD_DEV_LOGIN=1     개발용 로그인. FD_HOST가 루프백일 때만 켤 수 있다
//   FD_GOOGLE_CLIENT_ID, FD_GOOGLE_CLIENT_SECRET, FD_PUBLIC_URL   Google 로그인
// 인자
//   --memory                         메모리 저장소
//   --bootstrap-admin <id>:<email>   활성 어드민이 없으면 이 어드민을 만든다
//   --import-product <폴더>          <폴더>/pipeline.yaml, rules/*.md를 그 제품의 설정이 없을 때 첫 버전으로 가져온다
//   --repo <url|builtin>             가져올 때 pipeline.yaml의 repo를 이 값으로 바꾼다
//   --import-repo <url>              --import-product 제품이 내장 git(repo: builtin)이고 내장 레포가 없으면, 이 레포의 모든 ref를 가져와 만든다 (M5.5 Z1).
//                                    없으면 어드민 화면(제품 → git 레포)에서 가져오거나 빈 레포를 만든다 (Z8)
// 명령
//   flightdeck-server backup <폴더>  내장 git 레포마다 bundle을 만들고 검증한다 (M5.5 Z6)
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { generateServerKey, keyFingerprint, publicKeyOf } from "@flightdeck/core";
import { parsePipeline } from "@flightdeck/schema";
import { BUILTIN_REPO, GitHost } from "./githost.ts";
import { createApp } from "./http.ts";
import { LiveHub } from "./live.ts";
import { PgStore } from "./pg.ts";
import { EventSigner } from "./signer.ts";
import { MemoryStore, type ServerStore } from "./store.ts";

/** 서버 키: <dataDir>/server-key.pem. 없으면 만든다 (설계 §12) */
export async function loadServerKey(dataDir: string): Promise<{ publicKey: string; privateKeyPem: string }> {
  const file = path.join(dataDir, "server-key.pem");
  if (!existsSync(file)) {
    const k = generateServerKey();
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, k.privateKeyPem, { mode: 0o600 });
  }
  await chmod(file, 0o600);
  const privateKeyPem = await readFile(file, "utf8");
  return { privateKeyPem, publicKey: publicKeyOf(privateKeyPem) };
}

/** 제품 설정 폴더(pipeline.yaml + rules/*.md)를 읽는다 */
export async function readProductDir(dir: string, repo?: string): Promise<{ product: string; pipeline_yaml: string; rules: Record<string, string> }> {
  let yaml = await readFile(path.join(dir, "pipeline.yaml"), "utf8");
  if (repo) yaml = yaml.replace(/^repo:.*$/m, `repo: ${repo}`);
  const rules: Record<string, string> = {};
  const rdir = path.join(dir, "rules");
  if (existsSync(rdir)) for (const f of await readdir(rdir)) if (f.endsWith(".md")) rules[f.slice(0, -3)] = await readFile(path.join(rdir, f), "utf8");
  return { product: parsePipeline(yaml).product, pipeline_yaml: yaml, rules };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dataDir = path.resolve(process.env.FD_DATA_DIR ?? ".flightdeck-server");
  if (process.argv[2] === "backup") {
    const out = process.argv[3];
    if (!out) throw new Error("사용법: flightdeck-server backup <폴더>");
    const keys = await loadServerKey(dataDir);
    const host = new GitHost({ dataDir, secret: keys.privateKeyPem, trust: async () => ({ mode: "dev" }), isActive: async () => false, target: async () => "main" });
    for (const f of await host.backup(out)) console.log(f);
    return;
  }
  const host = process.env.FD_HOST ?? "127.0.0.1";
  const port = Number(process.env.FD_PORT ?? 8787);
  const devLogin = process.env.FD_DEV_LOGIN === "1";
  if (devLogin && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("FD_DEV_LOGIN은 루프백 주소에서만 켤 수 있다");

  let store: ServerStore;
  if (process.env.FD_DATABASE_URL) store = await PgStore.connect(process.env.FD_DATABASE_URL);
  else if (process.argv.includes("--memory")) store = new MemoryStore();
  else throw new Error("FD_DATABASE_URL이 없다 (시험용은 --memory)");

  const boot = arg("--bootstrap-admin");
  if (boot && !(await store.listMembers()).some((m) => m.active && m.admin)) {
    const [id, email] = boot.split(":") as [string, string];
    await store.upsertMember({ id, email, active: true, admin: true }, "bootstrap");
  }
  const imp = arg("--import-product");
  let imported: string | undefined;
  if (imp) {
    const p = await readProductDir(imp, arg("--repo"));
    imported = p.product;
    if (!(await store.currentConfig(p.product))) await store.addConfigVersion({ ...p, created_by: "bootstrap", note: `가져옴: ${imp}` });
  }

  const keys = await loadServerKey(dataDir);
  let signer: EventSigner | undefined;
  const githost = new GitHost({
    dataDir,
    secret: keys.privateKeyPem,
    trust: () => signer!.trust(),
    isActive: async (m) => !!(await store.getMember(m))?.active,
    target: async (product) => {
      const cfg = await store.currentConfig(product);
      return cfg ? parsePipeline(cfg.pipeline_yaml).landing.target : "main";
    },
  });
  signer = new EventSigner({ store, dataDir, ...keys, githost });
  // 내장 git 제품: 있는 레포는 훅을 다시 설치하고, 없는 레포는 --import-repo가 있을 때만 가져온다.
  // 그 밖에는 어드민 화면에서 가져오거나 만든다 (M5.5 Z8: 빈 레포를 저절로 만들면 가져오기가 막힌다)
  for (const { product } of await store.listProducts()) {
    const cfg = await store.currentConfig(product);
    if (!cfg) continue;
    // 설정 하나가 깨져도 서버는 뜬다: 그 제품만 건너뛰고 알린다 (어드민 화면에서 고친다)
    let repo: string;
    try { repo = parsePipeline(cfg.pipeline_yaml).repo; } catch (e) {
      const issue = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues?.[0];
      const why = issue ? `${issue.path.join(".") || "(전체)"}: ${issue.message}` : e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.error(`[config] ${product}: 설정을 읽지 못해 건너뛴다 (${why})`);
      continue;
    }
    if (repo !== BUILTIN_REPO) continue;
    const importUrl = product === imported ? arg("--import-repo") : undefined;
    if ((await githost.repoInfo(product)).exists || importUrl) await githost.ensureRepo(product, importUrl ? { importUrl } : {});
    else console.log(`[git] ${product}: 내장 레포가 없다. 어드민 화면에서 가져오거나 만드세요`);
  }
  const g = process.env.FD_GOOGLE_CLIENT_ID && process.env.FD_GOOGLE_CLIENT_SECRET
    ? { clientId: process.env.FD_GOOGLE_CLIENT_ID, clientSecret: process.env.FD_GOOGLE_CLIENT_SECRET, publicUrl: process.env.FD_PUBLIC_URL ?? `http://${host}:${port}` }
    : undefined;
  const app = createApp({ store, signer, keys, devLogin, githost, live: new LiveHub(), ...(g ? { google: g } : {}) });
  githost.attach(`http://${host === "::1" ? "[::1]" : host}:${port}`);
  // 반영 보조 경로 (§11.1): 1분마다 반영 대기 에픽을 찾는다. 재시작 뒤 복구도 이것으로 한다
  const scan = () => void signer.scanLanding().catch((e) => console.error("[land scan]", e instanceof Error ? e.message : e));
  setTimeout(scan, 5_000);
  setInterval(scan, Number(process.env.FD_LAND_SCAN_MS) || 60_000);
  createServer((req, res) => void app(req, res)).listen(port, host, () => {
    console.log(`flightdeck-server http://${host}:${port}  server key ${keyFingerprint(keys.publicKey)}${devLogin ? "  (개발용 로그인 켜짐)" : ""}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("flightdeck-server.mjs")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
