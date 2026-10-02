// 실행물 묶기: 훅 CLI와 MCP 서버를 각각 Node 단일 파일(ESM)로 만든다.
// 결과: dist/flightdeck-hook.mjs, dist/flightdeck-mcp.mjs
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "inline",
  logLevel: "warning",
  // CommonJS 의존성이 require를 쓸 수 있게
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

await Promise.all([
  build({ ...common, entryPoints: ["packages/hook/src/main.ts"], outfile: "dist/flightdeck-hook.mjs" }),
  build({ ...common, entryPoints: ["packages/mcp/src/main.ts"], outfile: "dist/flightdeck-mcp.mjs" }),
  build({ ...common, entryPoints: ["packages/vscode/src/demo.ts"], outfile: "dist/fd-demo.mjs" }),
]);
console.log("built dist/flightdeck-hook.mjs, dist/flightdeck-mcp.mjs, dist/fd-demo.mjs");
