// flightdeck MCP 서버 실행 파일. 사용: flightdeck-mcp --repo <제품 레포> --epic <에픽 ID>
import path from "node:path";
import { GitEngine } from "@flightdeck/git";
import { serve } from "./server.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} 인자가 없습니다`);
  return v;
}

const dataDir = await new GitEngine(arg("repo")).dataDir();
serve({ statePath: path.join(dataDir, "state", `${arg("epic")}.json`) });
