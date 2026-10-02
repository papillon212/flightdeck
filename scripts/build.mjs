// 실행물 묶기
// - dist/flightdeck-hook.mjs, dist/flightdeck-mcp.mjs: 훅 CLI, MCP 서버 (Node 단일 파일, ESM)
// - dist/fd-demo.mjs: 데모·통합 확인 스크립트
// - packages/vscode/ext/: VS Code 확장 (dist/extension.cjs + 위 실행 파일 + 내장 견본 설정)
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: "inline",
  logLevel: "warning",
};
const esm = {
  ...common,
  format: "esm",
  // CommonJS 의존성이 require를 쓸 수 있게
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

await Promise.all([
  build({ ...esm, entryPoints: ["packages/hook/src/main.ts"], outfile: "dist/flightdeck-hook.mjs" }),
  build({ ...esm, entryPoints: ["packages/mcp/src/main.ts"], outfile: "dist/flightdeck-mcp.mjs" }),
  build({ ...esm, entryPoints: ["packages/vscode/src/demo.ts"], outfile: "dist/fd-demo.mjs" }),
  build({ ...common, format: "cjs", entryPoints: ["packages/vscode/src/extension.ts"], outfile: "packages/vscode/ext/dist/extension.cjs", external: ["vscode"] }),
]);

const ext = "packages/vscode/ext";
await mkdir(`${ext}/dist`, { recursive: true });
for (const f of ["flightdeck-hook.mjs", "flightdeck-mcp.mjs"]) await cp(`dist/${f}`, `${ext}/dist/${f}`);
await rm(`${ext}/config`, { recursive: true, force: true });
await cp("examples/flightdeck-config/products/sample", `${ext}/config/sample`, { recursive: true });
console.log("built dist/{flightdeck-hook,flightdeck-mcp,fd-demo}.mjs, packages/vscode/ext/{dist,config}");
