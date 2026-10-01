#!/usr/bin/env node
// M0 스파이크용 훅. 모든 훅 이벤트의 입력을 그대로 기록하고, 설정(config.json)에 따라 응답한다.
// - SessionStart / UserPromptSubmit: 추가 컨텍스트 주입
// - PreToolUse: 경로·명령 패턴으로 차단, 파일 편집 도구는 변경 전 내용 스냅샷
// - PostToolUse: 변경 후 내용 스냅샷, 의견 대기열(opinions/)이 있으면 추가 컨텍스트로 주입
// - (cfg.shellSnapshot) Bash 전후로 작업 트리를 임시 index에 write-tree 해서 셸이 바꾼 파일을 잡는다
// 상태 디렉터리는 FD_STATE 환경변수로 받는다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const STATE = process.env.FD_STATE;
if (!STATE) process.exit(0);
fs.mkdirSync(path.join(STATE, "snap"), { recursive: true });
fs.mkdirSync(path.join(STATE, "opinions"), { recursive: true });
fs.mkdirSync(path.join(STATE, "opinions-delivered"), { recursive: true });

const ev = JSON.parse(fs.readFileSync(0, "utf8"));
const cfg = readJson(path.join(STATE, "config.json")) ?? {};
const now = () => new Date().toISOString();

append("hook-log.jsonl", { at: now(), event: ev.hook_event_name, input: ev });

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

switch (ev.hook_event_name) {
  case "SessionStart":
    if (cfg.sessionStartContext) respond("SessionStart", { additionalContext: cfg.sessionStartContext });
    break;

  case "UserPromptSubmit": {
    const ctx = [cfg.promptContext, ...drainOpinions()].filter(Boolean).join("\n");
    if (ctx) respond("UserPromptSubmit", { additionalContext: ctx });
    break;
  }

  case "PreToolUse": {
    const urgent = urgentReason();
    if (urgent) respond("PreToolUse", { permissionDecision: "deny", permissionDecisionReason: urgent });
    if (FILE_TOOLS.has(ev.tool_name)) snapshot("pre");
    if (ev.tool_name === "Bash" && cfg.shellSnapshot) fs.writeFileSync(snapPath("pre-tree"), worktreeTree());
    const reason = denyReason();
    if (reason) respond("PreToolUse", { permissionDecision: "deny", permissionDecisionReason: reason });
    break;
  }

  case "PostToolUse": {
    if (FILE_TOOLS.has(ev.tool_name)) {
      snapshot("post");
      const pre = readSnap("pre");
      const post = readSnap("post");
      append("edits.jsonl", {
        at: now(),
        tool_use_id: ev.tool_use_id,
        tool: ev.tool_name,
        file: ev.tool_input?.file_path,
        pre_hash: pre === null ? null : sha(pre),
        post_hash: post === null ? null : sha(post),
        tool_input: ev.tool_input,
        tool_response_keys: Object.keys(ev.tool_response ?? {}),
      });
    }
    if (ev.tool_name === "Bash" && cfg.shellSnapshot && fs.existsSync(snapPath("pre-tree"))) {
      const pre_tree = fs.readFileSync(snapPath("pre-tree"), "utf8");
      const post_tree = worktreeTree();
      if (pre_tree !== post_tree) append("shell-edits.jsonl", { at: now(), tool_use_id: ev.tool_use_id, cmd: ev.tool_input?.command, pre_tree, post_tree });
    }
    const ops = drainOpinions();
    if (ops.length) respond("PostToolUse", { additionalContext: ops.join("\n") });
    break;
  }
}
process.exit(0);

function respond(hookEventName, fields) {
  const out = { hookSpecificOutput: { hookEventName, ...fields } };
  append("hook-out.jsonl", { at: now(), out });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function denyReason() {
  const fp = ev.tool_input?.file_path ?? ev.tool_input?.notebook_path;
  if (fp && cfg.denyPath && new RegExp(cfg.denyPath).test(fp)) return `Flightdeck: 이 단계에서는 ${fp}에 쓸 수 없습니다.`;
  const cmd = ev.tool_name === "Bash" ? ev.tool_input?.command : null;
  if (cmd && cfg.denyBash && new RegExp(cfg.denyBash).test(cmd)) return `Flightdeck: git 등 금지된 명령입니다 (${cmd}).`;
  return null;
}

function snapshot(kind) {
  const fp = ev.tool_input?.file_path;
  if (!fp) return;
  const content = fs.existsSync(fp) ? fs.readFileSync(fp) : null;
  const meta = { file: fp, exists: content !== null };
  fs.writeFileSync(snapPath(kind) + ".json", JSON.stringify(meta));
  if (content !== null) fs.writeFileSync(snapPath(kind), content);
}

function readSnap(kind) {
  const meta = readJson(snapPath(kind) + ".json");
  if (!meta?.exists) return null;
  return fs.readFileSync(snapPath(kind));
}

function snapPath(kind) {
  return path.join(STATE, "snap", `${ev.tool_use_id}.${kind}`);
}

// 급한 의견(설계 §8.4): urgent/ 대기열에 의견이 있으면 이 도구 호출을 거부하고 의견을 사유로 돌려준다.
// 같은 assistant 메시지에서 이미 요청된 나머지 도구 호출도 거부한다. 다음 모델 턴(다른 메시지)이 되면 해제한다.
// 메시지 구분은 transcript_path에서 tool_use_id가 들어 있는 assistant 메시지의 message.id로 한다.
// transcript는 PreToolUse 시점에 아직 기록되지 않았을 수 있다. 그때는 직전 거부로부터 SAME_BATCH_MS 안에 온 호출을
// 같은 메시지로 본다(새 턴은 모델 응답을 기다려야 하므로 보통 그보다 늦다). 틀리면 새 턴 첫 호출이 한 번 거부된다(안전한 쪽).
function urgentReason() {
  const SAME_BATCH_MS = 1000;
  const dir = path.join(STATE, "urgent");
  const activeFile = path.join(STATE, "urgent-active.json");
  fs.mkdirSync(dir, { recursive: true });
  const msgId = assistantMessageId(ev.tool_use_id);
  const queued = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  if (queued.length) {
    const body = queued.map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim()).join("\n");
    for (const f of queued) fs.renameSync(path.join(dir, f), path.join(STATE, "opinions-delivered", f));
    fs.writeFileSync(activeFile, JSON.stringify({ msgId, body, lastDenyAt: Date.now() }));
    append("urgent-log.jsonl", { at: now(), action: "deliver", tool: ev.tool_name, tool_use_id: ev.tool_use_id, msgId });
    return `${body}\n(Flightdeck: 긴급 의견 때문에 이 도구 호출을 실행하지 않았습니다. 이번 메시지에서 요청한 나머지 도구 호출도 실행되지 않습니다. 의견을 반영해 다시 계획하세요.)`;
  }
  const active = readJson(activeFile);
  if (!active) return null;
  const gapMs = Date.now() - active.lastDenyAt;
  // 판정: transcript에서 메시지를 찾았으면 메시지 ID로, 못 찾았으면 시간 간격으로
  const rule = msgId && active.msgId ? "message_id" : "time_gap";
  const same = rule === "message_id" ? msgId === active.msgId : gapMs < SAME_BATCH_MS;
  if (same) {
    fs.writeFileSync(activeFile, JSON.stringify({ ...active, msgId: active.msgId ?? msgId, lastDenyAt: Date.now() }));
    append("urgent-log.jsonl", { at: now(), action: "deny_same_message", rule, gapMs, tool: ev.tool_name, tool_use_id: ev.tool_use_id, msgId });
    return "Flightdeck: 앞선 긴급 의견 때문에 이번 메시지의 나머지 도구 호출은 실행하지 않았습니다.";
  }
  fs.rmSync(activeFile);
  append("urgent-log.jsonl", { at: now(), action: "clear", rule, gapMs, tool: ev.tool_name, tool_use_id: ev.tool_use_id, msgId, prevMsgId: active.msgId });
  return null;
}

function assistantMessageId(toolUseId) {
  if (!ev.transcript_path || !toolUseId || !fs.existsSync(ev.transcript_path)) return null;
  const lines = fs.readFileSync(ev.transcript_path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(toolUseId)) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (o.type === "assistant" && (o.message?.content ?? []).some((b) => b.type === "tool_use" && b.id === toolUseId)) return o.message.id;
    } catch {}
  }
  return null;
}

// 브랜치·index·작업 트리를 건드리지 않고 현재 작업 트리 전체를 tree 객체로 만든다 (.gitignore 대상 제외)
// 디스크 바이트를 그대로 담기 위해 줄바꿈 변환(core.autocrlf)과 .gitattributes(GIT_ATTR_SOURCE=빈 트리)를 끈다.
function worktreeTree() {
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const env = { ...process.env, GIT_INDEX_FILE: path.join(STATE, "shell.index"), GIT_ATTR_SOURCE: EMPTY_TREE };
  const git = (...args) => execFileSync("git", ["-C", ev.cwd, "-c", "core.autocrlf=false", ...args], { env, encoding: "utf8" }).trim();
  git("add", "-A", ".");
  return git("write-tree");
}

function drainOpinions() {
  const dir = path.join(STATE, "opinions");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  return files.map((f) => {
    const body = fs.readFileSync(path.join(dir, f), "utf8").trim();
    fs.renameSync(path.join(dir, f), path.join(STATE, "opinions-delivered", f));
    append("opinions-log.jsonl", { at: now(), event: ev.hook_event_name, tool_use_id: ev.tool_use_id, file: f });
    return body;
  });
}

function append(name, obj) {
  fs.appendFileSync(path.join(STATE, name), JSON.stringify(obj) + "\n");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
