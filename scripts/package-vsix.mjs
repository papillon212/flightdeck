// VS Code 확장 설치 파일(VSIX) 만들기: 빌드 → packages/vscode/ext를 묶어 dist/flightdeck-<version>.vsix
// 마켓플레이스에 올리지 않고 팀에 파일로 나눈다(code --install-extension <파일>).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ext = path.join(root, "packages/vscode/ext");
const { version } = JSON.parse(readFileSync(path.join(ext, "package.json"), "utf8"));
const out = path.join(root, "dist", `flightdeck-${version}.vsix`);

execFileSync("node", [path.join(root, "scripts/build.mjs")], { stdio: "inherit", cwd: root });
mkdirSync(path.dirname(out), { recursive: true });
// --no-dependencies: 확장은 하나의 번들(dist/extension.cjs + 훅·MCP 실행 파일)이라 node_modules가 필요 없다
execFileSync(path.join(root, "node_modules/.bin/vsce"), ["package", "--no-dependencies", "--skip-license", "--allow-missing-repository", "--out", out], { stdio: "inherit", cwd: ext });
console.log(`만들었다: ${path.relative(root, out)}`);
