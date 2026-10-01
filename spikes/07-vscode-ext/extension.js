// M0 스파이크 확장 (설계 §3.2·§3.3 Comments API, §8.6 에디터 편집 기록).
// - 작업 폴더의 텍스트 파일을 시작 시점 디스크 바이트로 base/에 보관한다.
// - onDidChangeTextDocument를 shadow 문서에 적용하며, 매 이벤트마다 문서 텍스트와 같은지 확인하고 editlog.jsonl에 남긴다.
// - "편집 기록 검증": base + 편집 기록을 순서대로 재적용해 디스크 바이트와 해시를 비교한다.
// - markdown 문서에 Comments API 쓰레드를 만든다.
// - 상태 디렉터리에 auto 파일이 있으면 자동 테스트 → 검증 → 창 종료까지 한다.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const STATE = process.env.FD_STATE || "/tmp/fd-spike7/state";
const shadows = new Map(); // fsPath → 마지막으로 알고 있는 문서 텍스트
let seq = 0;
let out;
let controller;

const sha = (s) => (s === null || s === undefined ? null : crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex"));
const short = (h) => (h ? h.slice(0, 10) : "∅");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const inRoot = (p) => p.startsWith(root() + path.sep);
const rel = (p) => path.relative(root(), p);
const append = (name, obj) => fs.appendFileSync(path.join(STATE, name), JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n");
const say = (s) => { out.appendLine(s); append("report.log.jsonl", { line: s }); };

function walk(dir, base = dir, acc = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === ".git" || d.name === ".vscode") continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, base, acc);
    else acc.push(path.relative(base, p));
  }
  return acc;
}

function activate(ctx) {
  if (!vscode.workspace.workspaceFolders) return;
  out = vscode.window.createOutputChannel("Flightdeck Spike");
  fs.mkdirSync(path.join(STATE, "base"), { recursive: true });

  // base: 시작 시점 디스크 바이트
  if (fs.readdirSync(path.join(STATE, "base")).length === 0) {
    for (const f of walk(root())) {
      fs.mkdirSync(path.dirname(path.join(STATE, "base", f)), { recursive: true });
      fs.copyFileSync(path.join(root(), f), path.join(STATE, "base", f));
    }
  }

  const track = (doc) => {
    if (doc.uri.scheme !== "file" || !inRoot(doc.uri.fsPath)) return;
    if (shadows.has(doc.uri.fsPath)) return;
    const text = doc.getText();
    shadows.set(doc.uri.fsPath, text);
    const disk = fs.existsSync(doc.uri.fsPath) ? fs.readFileSync(doc.uri.fsPath, "utf8") : null;
    append("opens.jsonl", { file: rel(doc.uri.fsPath), doc_hash: sha(text), disk_hash: sha(disk), same_as_disk: text === disk, eol: doc.eol === vscode.EndOfLine.CRLF ? "CRLF" : "LF" });
  };
  vscode.workspace.textDocuments.forEach(track);
  ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(track));

  ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const doc = e.document;
    if (doc.uri.scheme !== "file" || !inRoot(doc.uri.fsPath) || e.contentChanges.length === 0) return;
    const prev = shadows.has(doc.uri.fsPath) ? shadows.get(doc.uri.fsPath) : null;
    // 한 이벤트의 변경들은 모두 이벤트 전 문서 기준 오프셋이다 → 뒤에서부터 적용
    let text = prev ?? "";
    for (const c of [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      text = text.slice(0, c.rangeOffset) + c.text + text.slice(c.rangeOffset + c.rangeLength);
    }
    const actual = doc.getText();
    // 외부 변경 판별 후보: VS Code가 디스크를 다시 읽은 경우라면 이벤트 직후 문서 = 디스크
    const diskNow = fs.existsSync(doc.uri.fsPath) ? fs.readFileSync(doc.uri.fsPath, "utf8") : null;
    append("editlog.jsonl", {
      equals_disk_after: actual === diskNow,
      seq: ++seq,
      file: rel(doc.uri.fsPath),
      base_hash: sha(prev),
      changes: e.contentChanges.map((c) => ({ offset: c.rangeOffset, len: c.rangeLength, text: c.text })),
      reason: e.reason === vscode.TextDocumentChangeReason.Undo ? "undo" : e.reason === vscode.TextDocumentChangeReason.Redo ? "redo" : null,
      dirty_after: doc.isDirty,
      version: doc.version,
      after_hash: sha(actual),
      shadow_ok: prev !== null && text === actual,
    });
    shadows.set(doc.uri.fsPath, actual);
  }));

  ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!inRoot(doc.uri.fsPath)) return;
    const disk = fs.readFileSync(doc.uri.fsPath, "utf8");
    append("saves.jsonl", { file: rel(doc.uri.fsPath), doc_hash: sha(doc.getText()), disk_hash: sha(disk), match: doc.getText() === disk });
  }));

  // Comments API (설계 §3.2 문서 인라인 쓰레드의 에디터 표시)
  controller = vscode.comments.createCommentController("flightdeck-spike", "Flightdeck");
  controller.commentingRangeProvider = {
    provideCommentingRanges: (doc) => (doc.languageId === "markdown" ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
  };
  ctx.subscriptions.push(controller);
  ctx.subscriptions.push(vscode.commands.registerCommand("flightdeckSpike.reply", (reply) => {
    const t = reply.thread;
    t.comments = [...t.comments, comment(reply.text, "나")];
    append("comments.jsonl", { event: "reply_from_ui", file: rel(t.uri.fsPath), line: t.range.start.line, body: reply.text });
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand("flightdeckSpike.verify", verify));
  ctx.subscriptions.push(vscode.commands.registerCommand("flightdeckSpike.autoTest", autoTest));

  if (fs.existsSync(path.join(STATE, "auto"))) {
    setTimeout(async () => {
      try {
        await autoTest();
        verify();
      } catch (err) {
        append("errors.jsonl", { error: String(err && err.stack || err) });
      }
      fs.writeFileSync(path.join(STATE, "done"), "1");
      await vscode.commands.executeCommand("workbench.action.quit");
    }, 2000);
  } else {
    out.show(true);
    say("Flightdeck Spike 활성화. 직접 편집한 뒤 명령 팔레트에서 'Flightdeck Spike: 편집 기록 검증'을 실행하세요.");
  }
}

function comment(body, author) {
  return { body: new vscode.MarkdownString(body), mode: vscode.CommentMode.Preview, author: { name: author } };
}

async function open(file) {
  const doc = await vscode.workspace.openTextDocument(path.join(root(), file));
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  return { doc, ed };
}

async function autoTest() {
  say("== 자동 테스트 시작");

  // 1. Comments API: 문단 ID 아래 줄에 쓰레드 → 위에 3줄 삽입 → 쓰레드 위치
  {
    const { doc, ed } = await open("analysis.md");
    const line = doc.getText().split("\n").findIndex((l) => l.includes("<!-- p:a91c -->")) + 1;
    const thread = controller.createCommentThread(doc.uri, new vscode.Range(line, 0, line, 0), [comment("TTL은 요구사항상 몇 분인가요?", "@dh.lee → @park")]);
    thread.label = "❓ 질문";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const before = thread.range.start.line;
    await ed.edit((b) => b.insert(new vscode.Position(0, 0), "추가 1\n추가 2\n추가 3\n"));
    await sleep(500);
    const after = thread.range.start.line;
    append("comments.jsonl", { event: "thread_shift", file: "analysis.md", before, after, expected: before + 3 });
    say(`Comments: 쓰레드 줄 ${before} → 위에 3줄 삽입 후 ${after} (기대 ${before + 3})`);
    // 쓰레드가 있는 줄 자체를 지우면?
    await ed.edit((b) => b.delete(new vscode.Range(after, 0, after + 1, 0)));
    await sleep(500);
    append("comments.jsonl", { event: "thread_line_deleted", line_after_delete: thread.range.start.line });
    say(`Comments: 쓰레드 줄 삭제 후 위치 ${thread.range.start.line}`);
    await doc.save();
  }

  // 2. 한글·이모지 입력, 다중 위치 한 번에 편집, undo
  {
    const { doc, ed } = await open("ko.txt");
    await ed.edit((b) => b.insert(doc.lineAt(0).range.end, " 안녕🌏"));
    await ed.edit((b) => {
      b.replace(new vscode.Range(1, 0, 1, 2), "두번째");
      b.insert(new vscode.Position(2, 0), "끝>");
    });
    await vscode.commands.executeCommand("undo");
    await sleep(200);
    await vscode.commands.executeCommand("redo");
    await sleep(200);
    await doc.save();
  }

  // 3. CRLF 파일에 "\n" 삽입 (문서 EOL로 바뀌는지)
  {
    const { doc, ed } = await open("crlf.txt");
    await ed.edit((b) => b.insert(new vscode.Position(1, 0), "NEW\n"));
    await doc.save();
  }

  // 4. 저장 시 자동 수정 (trimTrailingWhitespace, insertFinalNewline)
  {
    const { doc, ed } = await open("a.ts");
    await ed.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, "\n// added   "));
    await doc.save();
  }

  // 5. 외부 도구가 "열려 있는" 파일을 바꿈 → VS Code가 다시 읽으며 변경 이벤트가 오는가
  {
    const before = seq;
    cp.execFileSync("sed", ["-i", "", "s/셋째/EXTERNAL/", path.join(root(), "ko.txt")]);
    await sleep(3000);
    append("external.jsonl", { case: "open_file", file: "ko.txt", events: seq - before });
    say(`외부 변경(열린 파일 ko.txt): 변경 이벤트 ${seq - before}건`);
  }

  // 6. 외부 도구가 "열려 있지 않은" 파일을 바꿈
  {
    const before = seq;
    cp.execFileSync("sed", ["-i", "", "s/line2/EXTERNAL/", path.join(root(), "notes.txt")]);
    await sleep(2000);
    append("external.jsonl", { case: "closed_file", file: "notes.txt", events: seq - before });
    say(`외부 변경(닫힌 파일 notes.txt): 변경 이벤트 ${seq - before}건`);
  }
  say("== 자동 테스트 끝");
}

function verify() {
  say("== 편집 기록 검증: base + 편집 기록 재적용 vs 디스크");
  const log = fs.existsSync(path.join(STATE, "editlog.jsonl"))
    ? fs.readFileSync(path.join(STATE, "editlog.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const state = new Map();
  for (const f of walk(path.join(STATE, "base"))) state.set(f, fs.readFileSync(path.join(STATE, "base", f), "utf8"));
  let chainBad = 0;
  for (const e of log) {
    const cur = state.has(e.file) ? state.get(e.file) : null;
    if (sha(cur) !== e.base_hash) chainBad++;
    let text = cur ?? "";
    for (const c of [...e.changes].sort((a, b) => b.offset - a.offset)) text = text.slice(0, c.offset) + c.text + text.slice(c.offset + c.len);
    state.set(e.file, text);
  }
  const shadowBad = log.filter((e) => !e.shadow_ok).length;
  say(`이벤트 ${log.length}건, 이벤트마다 shadow=문서 불일치 ${shadowBad}건, base_hash 순서 불일치 ${chainBad}건`);
  let ok = 0, bad = 0;
  for (const f of walk(root())) {
    const disk = fs.readFileSync(path.join(root(), f), "utf8");
    const match = sha(state.get(f)) === sha(disk);
    match ? ok++ : bad++;
    say(`  ${match ? "MATCH   " : "MISMATCH"} ${f.padEnd(12)} replay=${short(sha(state.get(f)))} disk=${short(sha(disk))}`);
  }
  say(`결과: 일치 ${ok} / 불일치 ${bad}`);
  append("verify.jsonl", { events: log.length, shadowBad, chainBad, ok, bad });
}

function deactivate() {}
module.exports = { activate, deactivate };
