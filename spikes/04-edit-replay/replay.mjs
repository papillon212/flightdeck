#!/usr/bin/env node
// 훅으로 잡은 편집을 설계 §8.6 형식의 편집 기록으로 바꾸고, base 상태에서 순서대로 다시 적용해
// 실제 작업 트리와 파일 해시(디스크 원본 바이트 기준)가 일치하는지 확인한다.
// 사용: node replay.mjs <STATE_DIR> <WORKTREE> <BASE_DIR>
//
// 편집을 만드는 방식 두 가지를 비교한다.
// - payload: 훅 페이로드(tool_input, tool_response.originalFile)만 사용. 디스크를 읽지 않는다.
// - disk:    훅이 PreToolUse/PostToolUse 시점에 뜬 디스크 스냅샷(snap/<id>.pre|post)을 사용.
// Bash는 두 방식 모두 훅이 남긴 전후 tree(shell-edits.jsonl)의 diff로 만든다 (출처 agent_shell).
// 오프셋은 JS 문자열 인덱스(UTF-16 code unit, VS Code와 같은 기준). 해시는 UTF-8 바이트의 sha256.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const [STATE, WT, BASE_DIR] = process.argv.slice(2);
const wtReal = fs.realpathSync(WT);
const git = (args) => execFileSync("git", ["-C", wtReal, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const sha = (s) => (s === null || s === undefined ? null : crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex"));
const short = (h) => (h ? h.slice(0, 10) : "∅");
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const rel = (abs) => path.relative(wtReal, abs);

const hookLog = readJsonl(path.join(STATE, "hook-log.jsonl"));
const shellByTool = new Map(readJsonl(path.join(STATE, "shell-edits.jsonl")).map((e) => [e.tool_use_id, e]));
const disk = readDir(wtReal);

let allOk = true;
for (const mode of ["payload", "disk"]) {
  const { editlog, checks, state } = build(mode);
  fs.writeFileSync(path.join(STATE, `editlog-${mode}.jsonl`), editlog.map((e) => JSON.stringify(e)).join("\n") + "\n");

  console.log(`\n######## 방식: ${mode}`);
  console.log("== 편집 기록 (§8.6 형식, insert는 앞 30자)");
  for (const e of editlog) {
    const body = e.delete ? "DELETE" : `[${e.range}] ← ${JSON.stringify(e.insert.slice(0, 30))}${e.insert.length > 30 ? `…(${e.insert.length})` : ""}`;
    console.log(`#${String(e.seq).padEnd(2)} ${e.file.padEnd(11)} base=${short(e.base_hash)} ${body}  (${e.source.kind}${e.source.cmd ? ": " + e.source.cmd.replace(wtReal + "/", "") : ""})`);
  }
  console.log("== 도구 호출 단위: 기록의 변경 전 해시가 재적용 상태와 같은가(순서 검증), 적용 결과가 그 시점 디스크와 같은가");
  for (const c of checks) console.log(`  seq ${c.seqs.padEnd(6)} ${c.file.padEnd(11)} 순서 ${c.chain ? "OK" : "MISMATCH"}   결과 ${c.post === null ? "n/a" : c.post ? "OK" : "MISMATCH"}`);

  console.log("== 최종 파일 해시: 재적용 vs 디스크");
  let ok = true;
  for (const f of [...new Set([...state.keys(), ...disk.keys()])].sort()) {
    const a = sha(state.get(f));
    const b = sha(disk.get(f));
    ok &&= a === b;
    console.log(`  ${a === b ? "MATCH   " : "MISMATCH"} ${f.padEnd(11)} replay=${short(a)} disk=${short(b)}`);
  }
  console.log(`결과(${mode}): ${ok ? "전체 일치" : "불일치 있음"} (파일 ${disk.size}개, 편집 ${editlog.length}건)`);
  if (mode === "disk") allOk = ok;
}
process.exit(allOk ? 0 : 1);

function build(mode) {
  const state = readDir(BASE_DIR);
  const editlog = [];
  const checks = [];
  let seq = 0;

  for (const { input: ev } of hookLog) {
    if (ev.hook_event_name !== "PostToolUse") continue;
    const src = { kind: "agent", tool: ev.tool_name, tool_use_id: ev.tool_use_id, prompt_id: ev.prompt_id };

    if (ev.tool_name === "Edit" || ev.tool_name === "Write") {
      const file = rel(ev.tool_input.file_path);
      const snapPre = readSnap(ev.tool_use_id, "pre");
      const snapPost = readSnap(ev.tool_use_id, "post");
      let pre, ops;
      if (mode === "payload") {
        const r = ev.tool_response ?? {};
        pre = r.originalFile ?? null; // Write 신규 생성이면 null
        ops = ev.tool_name === "Edit"
          ? replaceOps(pre, r.oldString ?? ev.tool_input.old_string, r.newString ?? ev.tool_input.new_string, r.replaceAll ?? ev.tool_input.replace_all)
          : [diffOp(pre ?? "", ev.tool_input.content)];
      } else {
        pre = snapPre;
        ops = [diffOp(pre ?? "", snapPost)];
      }
      record(file, pre, ops, src, snapPost);
    }

    if (ev.tool_name === "Bash" && shellByTool.has(ev.tool_use_id)) {
      const s = shellByTool.get(ev.tool_use_id);
      for (const line of git(["diff-tree", "-r", "--no-renames", s.pre_tree, s.post_tree]).split("\n").filter(Boolean)) {
        const [meta, file] = line.split("\t");
        const [, , preBlob, postBlob, status] = meta.split(" ");
        const pre = status === "A" ? null : git(["cat-file", "blob", preBlob]);
        const post = status === "D" ? null : git(["cat-file", "blob", postBlob]);
        record(file, pre, post === null ? [{ delete: true }] : [diffOp(pre ?? "", post)], { kind: "agent_shell", cmd: s.cmd, tool_use_id: ev.tool_use_id }, post);
      }
    }
  }
  return { editlog, checks, state };

  function record(file, pre, ops, source, actualPost) {
    const cur = state.has(file) ? state.get(file) : null;
    const chain = sha(cur) === sha(pre);
    let doc = cur ?? "";
    const first = seq + 1;
    for (const op of ops) {
      const base_hash = sha(state.has(file) ? doc : null);
      if (op.delete) {
        editlog.push({ file, seq: ++seq, base_hash, delete: true, source });
        state.delete(file);
        continue;
      }
      editlog.push({ file, seq: ++seq, base_hash, range: op.range, insert: op.insert, source });
      doc = doc.slice(0, op.range[0]) + op.insert + doc.slice(op.range[1]);
      state.set(file, doc);
    }
    checks.push({ file, seqs: `${first}-${seq}`, chain, post: actualPost === undefined ? null : sha(state.get(file) ?? null) === sha(actualPost) });
  }
}

function readSnap(id, kind) {
  const meta = JSON.parse(fs.readFileSync(path.join(STATE, "snap", `${id}.${kind}.json`), "utf8"));
  return meta.exists ? fs.readFileSync(path.join(STATE, "snap", `${id}.${kind}`), "utf8") : null;
}

// 디렉터리의 모든 파일을 원본 바이트 그대로 읽는다 (.git, .claude 제외)
function readDir(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === ".git" || d.name === ".claude") continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out.set(path.relative(root, p), fs.readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return out;
}

// Edit: old → new 치환을 오프셋 편집 목록으로. 각 범위는 앞 편집이 적용된 뒤의 좌표다.
function replaceOps(pre, oldS, newS, all) {
  const ops = [];
  let from = 0;
  let delta = 0;
  while (true) {
    const i = pre.indexOf(oldS, from);
    if (i < 0) break;
    ops.push({ range: [i + delta, i + delta + oldS.length], insert: newS });
    delta += newS.length - oldS.length;
    from = i + oldS.length;
    if (!all) break;
  }
  if (!ops.length) throw new Error(`old_string을 originalFile에서 찾지 못함: ${JSON.stringify(oldS).slice(0, 60)}`);
  return ops;
}

// 공통 앞부분·뒷부분을 뺀 최소 교체 1건. 서로게이트 쌍을 자르지 않게 경계를 맞춘다.
function diffOp(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  return { range: [p, a.length - s], insert: b.slice(p, b.length - s) };
}
function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }
