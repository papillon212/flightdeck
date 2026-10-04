// 세션 원본 저장소 (설계 §6.4 3계층, §2.1 refs/flightdeck/runs/<epic>).
// 파일: <run-id>/<session-id>.jsonl.gz (허용 목록 필터 + 비밀값 가림 + gzip). 턴이 끝날 때마다 그 세션 파일을 새로 쓴다(M4 제안 X7).
// 메타 브랜치처럼 작업 폴더 없이 저수준 명령으로 커밋하고, update-ref는 CAS로 한다.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, GitError, gitBuffer, isMissingRemoteRef } from "./exec.ts";

const ZERO = "0000000000000000000000000000000000000000";

export class RunStore {
  constructor(readonly repo: string) {}

  static ref(epic: string): string {
    return `refs/flightdeck/runs/${epic}`;
  }

  private g(args: string[], extra: { env?: Record<string, string>; input?: string } = {}) {
    return git(args, { cwd: this.repo, ...extra });
  }

  async head(epic: string): Promise<string | null> {
    return (await this.g(["rev-parse", "-q", "--verify", RunStore.ref(epic)]).catch(() => "")).trim() || null;
  }

  /** 파일 하나를 넣거나 바꾼다. 같은 내용이면 커밋하지 않는다. 새 끝을 돌려준다 */
  async put(epic: string, file: string, data: Buffer, message = `run ${file}`): Promise<string> {
    const tmp = await mkdtemp(path.join(tmpdir(), "fd-runs-"));
    try {
      const blobFile = path.join(tmp, "blob");
      await writeFile(blobFile, data);
      const blob = (await this.g(["hash-object", "-w", blobFile])).trim();
      for (let attempt = 1; ; attempt++) {
        const old = await this.head(epic);
        if (old && (await this.g(["rev-parse", "-q", "--verify", `${old}:${file}`]).catch(() => "")).trim() === blob) return old;
        const env = { GIT_INDEX_FILE: path.join(tmp, `index${attempt}`) };
        try {
          if (old) await this.g(["read-tree", old], { env });
          await this.g(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env });
          const tree = (await this.g(["write-tree"], { env })).trim();
          const commit = (await this.g(["commit-tree", tree, ...(old ? ["-p", old] : [])], { input: `${message}\n` })).trim();
          await this.g(["update-ref", RunStore.ref(epic), commit, old ?? ZERO]);
          return commit;
        } catch (e) {
          if (!(e instanceof GitError) || attempt >= 20) throw e;
          await new Promise((r) => setTimeout(r, Math.random() * 50));
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async files(epic: string): Promise<string[]> {
    const head = await this.head(epic);
    if (!head) return [];
    return (await this.g(["ls-tree", "-r", "-z", "--name-only", head])).split("\0").filter(Boolean);
  }

  async get(epic: string, file: string): Promise<Buffer> {
    return gitBuffer(["cat-file", "blob", `${RunStore.ref(epic)}:${file}`], { cwd: this.repo });
  }

  /** 원격의 세션 원본을 받는다 (읽기만 하는 쪽: 리뷰어·질문 대상). 없으면 false */
  async fetch(epic: string, remote = "origin"): Promise<boolean> {
    const ref = RunStore.ref(epic);
    try {
      await this.g(["fetch", "-q", "--no-tags", remote, `+${ref}:${ref}`]);
      return true;
    } catch (e) {
      if (e instanceof GitError && isMissingRemoteRef(e)) return false;
      throw e;
    }
  }
}
