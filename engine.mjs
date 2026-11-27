// Turn engine ported from doubao-openai-proxy/acp-server.js:
// session resume by prefix hash, same-session serial / cross-session parallel
// scheduling, narration/delivery segmentation, live tool feed, optional watchdog.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { AcpClient, runCliFile, cliScript, ensureRuntime } from "./acp.mjs";
import { findCommand, enrichToolLog, truncCmd, latestPendingCommand } from "./trajectory.mjs";

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000);
const SESSION_MAX = 500;
const enc = new TextEncoder();

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// Callers (Qoder/Codex) embed auto-attached boilerplate INSIDE user-message
// content: <system-reminder> blocks (skill lists, MCP catalogs, currentDate),
// Codex's "# AGENTS.md instructions for …" header + <INSTRUCTIONS> block, and
// <environment_context>. Forwarding it leaks the caller's context into the
// doubao conversation and skews its auto-title, so drop it everywhere.
function stripCallerBoilerplate(s) {
  return String(s)
    .replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/gi, "")
    .replace(/<environment_context>[\s\S]*?(?:<\/environment_context>|$)/gi, "")
    .replace(/<instructions>[\s\S]*?(?:<\/instructions>|$)/gi, "")
    .replace(/^#[^\n]*AGENTS\.md instructions[^\n]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function textOf(content) {
  if (typeof content === "string") return stripCallerBoilerplate(content);
  if (Array.isArray(content)) return stripCallerBoilerplate(content.map((p) => { if (p.type === "text") return p.text; throw httpError(400, "only text content is supported"); }).join("\n"));
  return "";
}
function safeText(content) {
  if (typeof content === "string") return stripCallerBoilerplate(content);
  if (Array.isArray(content)) return stripCallerBoilerplate(content.map((p) => (p && p.type === "text" ? String(p.text || "") : "")).join("\n"));
  return content == null ? "" : stripCallerBoilerplate(String(content));
}
function buildPrompt(messages, keepSystem) {
  const sys = keepSystem
    ? messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).filter(Boolean).join("\n")
    : "";
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, text: textOf(m.content) }));
  if (!turns.length) throw httpError(400, "messages must contain at least one user message");
  const head = sys ? sys + "\n\n" : "";
  let p;
  if (turns.length === 1) p = head + turns[0].text;
  else {
    p = head + "以下是此前的对话记录：\n\n";
    for (const t of turns.slice(0, -1)) p += (t.role === "user" ? "User: " : "Assistant: ") + t.text + "\n\n";
    const last = turns[turns.length - 1];
    p += last.role === "user" ? "请继续对话，直接回复最后一条 User 消息，不要添加角色前缀：\nUser: " + last.text : "Assistant: " + last.text;
  }
  return withCwd(messages, p);
}
// The caller's project path lives inside the stripped boilerplate ("Primary
// working directory: …" or Codex's <cwd>…</cwd>). Keep just that one line so
// doubao knows which folder to operate on instead of searching the whole drive.
// Only user/system messages carry it; take the LAST hit (most recent context).
function rawText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.type === "text" ? String(p.text || "") : "")).join("\n");
  return content == null ? "" : String(content);
}
function cwdOf(messages) {
  let found = "";
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "system" && m.role !== "developer") continue;
    const raw = rawText(m.content);
    const tag = raw.match(/<cwd>\s*([^\n<]+?)\s*<\/cwd>/i);
    const line = raw.match(/(?:Primary working directory|Current working directory|working directory)\s*[:：]\s*([^\n]+)/i);
    const hit = (tag && tag[1]) || (line && line[1]);
    if (hit) found = hit.trim();
  }
  return found;
}
function withCwd(messages, text) {
  const c = cwdOf(messages);
  return c ? "当前项目目录：" + c + "\n\n" + text : text;
}
// Codex sends thread-title meta requests ("Generate a concise UI title …") as
// ordinary chat requests. Forwarding them makes doubao execute the meta prompt
// as a task and pollutes the account-side conversation list. Detect the strong
// signature (>=2 markers, one substantive user turn) and answer locally.
const TITLE_MARKERS = [
  "Generate a concise UI title",
  "Fill the structured title field",
  "short title for a task",
  "Generate a clear, informative task title",
];
function titleSubjectOf(messages) {
  const turns = messages.filter((m) => m.role === "assistant" || (m.role === "user" && safeText(m.content)));
  if (turns.length !== 1 || turns[0].role !== "user") return null;
  const text = safeText(turns[0].content);
  const boundary = "User prompt:";
  const i = text.indexOf(boundary);
  const instructions = i >= 0 ? text.slice(0, i) : text;
  if (TITLE_MARKERS.filter((s) => instructions.includes(s)).length < 2) return null;
  return (i >= 0 ? text.slice(i + boundary.length).trim() : text) || "新会话";
}
function localTitle(subject) {
  const line = subject.split("\n").map((l) => l.trim()).find(Boolean) || subject;
  const clean = line.replace(/[#*`>\[\]]/g, "").replace(/\s+/g, " ").trim().replace(/[。．.！!？?，,、:：;；\s]+$/g, "");
  return safeSlice(clean, 36) || "新会话";
}
function localTitleResponse(subject, body, modelId) {
  const title = localTitle(subject);
  const format = body.response_format;
  const properties = (format?.schema ?? format?.json_schema?.schema)?.properties;
  const fields = Object.entries(properties ?? {});
  let content = title;
  if (format?.type === "json_object") {
    content = JSON.stringify({ title });
  } else if (format?.type === "json_schema" && fields.length === 1 && fields[0][1]?.type === "string") {
    content = JSON.stringify({ [fields[0][0]]: title });
  }
  const created = Math.floor(Date.now() / 1000);
  const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const usage = { prompt_tokens: estimateTokens(subject), completion_tokens: estimateTokens(content), total_tokens: estimateTokens(subject) + estimateTokens(content) };
  if (body.stream !== true) {
    return new Response(JSON.stringify({ id, object: "chat.completion", created, model: modelId, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  const sse = (delta, finish) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish || null }] }) + "\n\n";
  let out = sse({ role: "assistant", content: "" }) + sse({ content }) + sse({}, "stop");
  if (body.stream_options && body.stream_options.include_usage) out += "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model: modelId, choices: [], usage }) + "\n\n";
  out += "data: [DONE]\n\n";
  return new Response(out, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}
function estimateTokens(s) { return Math.max(1, Math.ceil((s || "").length / 4)); }
// Strip ANSI escape sequences and non-printable control chars (keep \t\n\r) so
// colored command output doesn't surface as garbage in the reasoning stream.
function stripGarble(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
// Truncate by UTF-16 units without splitting a surrogate pair (a lone surrogate
// encodes to U+FFFD, which shows as 乱码 downstream).
function safeSlice(s, n) {
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
function hashMessages(modelId, msgs, ignoreCallerInstructions = false) {
  const identity = { m: modelId };
  if (ignoreCallerInstructions) {
    identity.cwd = cwdOf(msgs);
    msgs = msgs.filter(({ role }) => role !== "system" && role !== "developer");
  }
  const norm = msgs.map((m) => ({ role: String(m.role || "user"), content: safeText(m.content) }));
  return crypto.createHash("sha256").update(JSON.stringify({ ...identity, msgs: norm })).digest("hex");
}

// ---------- memory watchdog ----------
function snapshotProcs() {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      try { const j = JSON.parse(out.trim()); resolve(Array.isArray(j) ? j : [j]); } catch { resolve([]); }
    });
  });
}
function treeMemoryMB(procs, rootPids) {
  const byParent = new Map();
  for (const p of procs) { const k = p.ParentProcessId; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(p); }
  const seen = new Set(); const stack = [...rootPids]; let total = 0;
  while (stack.length) {
    const pid = stack.pop(); if (seen.has(pid)) continue; seen.add(pid);
    const kids = byParent.get(pid) || [];
    for (const k of kids) { total += (k.WorkingSetSize || 0) / 1048576; stack.push(k.ProcessId); }
  }
  return total;
}

// ---------- push-style SSE body ----------
function pushStream(onCancel) {
  let ctrl;
  const stream = new ReadableStream({
    start(c) { ctrl = c; },
    cancel() { onCancel(); },
  });
  return {
    stream,
    write(s) { try { ctrl.enqueue(enc.encode(s)); } catch {} },
    close() { try { ctrl.close(); } catch {} },
  };
}

export function createEngine({ root, option, log }) {
  const logger = log || (() => {});
  const env = process.env;
  const cwd = env.DOUBAO_ACP_CWD || path.join(root, "workspace");
  const tmpdir = path.join(root, "tmp");
  const permission = env.DOUBAO_ACP_PERMISSION || "bypass_permissions";
  const maxTurnMs = Number(env.DOUBAO_ACP_MAX_MS || 0);
  const memLimitMb = Number(env.DOUBAO_ACP_MEM_MB || 0);
  const memCheckMs = Number(env.DOUBAO_ACP_MEM_CHECK_MS || 10000);
  const maxConcurrency = Math.max(0, Number(env.DOUBAO_ACP_MAX_CONCURRENCY || 0));
  const toolDetail = Number(env.DOUBAO_ACP_TOOL_DETAIL || 200);
  const processMaxLines = Number(env.DOUBAO_ACP_PROCESS_MAX_LINES || 80);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(tmpdir, { recursive: true });

  const toolProgress = () => (option("tool_progress") ? (env.DOUBAO_ACP_TOOL_PROGRESS || "reasoning") : "off");
  const processAppendix = () => option("process_appendix") || env.DOUBAO_ACP_PROCESS_APPENDIX === "1";
  // Default: strip the calling agent's system/developer boilerplate (skill lists,
  // MCP catalogs, agent READMEs); doubao runs its own system prompt. Opt back in
  // with the forward_system option or DOUBAO_ACP_SYSTEM=full.
  const keepSystem = () => option("forward_system") || env.DOUBAO_ACP_SYSTEM === "full";

  // ---------- session store ----------
  const sessionsFile = path.join(root, "acp-sessions.json");
  const sessions = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, "utf8")); const now = Date.now();
    for (const [k, v] of Object.entries(raw)) if (v && v.sessionId && now - (v.at || 0) < SESSION_TTL_MS) sessions.set(k, v);
  } catch {}
  function saveSessions() {
    try {
      if (sessions.size > SESSION_MAX) {
        const sorted = [...sessions.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        for (const [k] of sorted.slice(0, sessions.size - SESSION_MAX)) sessions.delete(k);
      }
      fs.writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)));
    } catch {}
  }

  // ---------- models ----------
  let modelCache = { at: 0, models: [] };
  function fetchModels() {
    if (Date.now() - modelCache.at < 10 * 60 * 1000 && modelCache.models.length) return Promise.resolve(modelCache.models);
    if (!fs.existsSync(cliScript())) return Promise.resolve([]);
    return runCliFile(["model", "list", "--json"], cwd, tmpdir).then((m) => { if (m.length) modelCache = { at: Date.now(), models: m }; return modelCache.models; });
  }
  function resolveModel(requested, models) {
    if (!requested) return null;
    const q = String(requested).toLowerCase();
    return models.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q) || null;
  }

  // ---------- ACP child (lazy) ----------
  const acp = new AcpClient({ cwd, permission, maxTurnMs, log: logger });
  function ensureAcp() {
    if (!fs.existsSync(cliScript())) throw httpError(502, "doubao-cli not found: " + cliScript() + " (set DOUBAO_CLI)");
    return ensureRuntime(logger).then(() => acp.start());
  }

  // ---------- scheduling ----------
  let active = 0; const waiters = [];
  function acquireSlot() {
    if (maxConcurrency === 0 || active < maxConcurrency) { active++; return Promise.resolve(); }
    return new Promise((r) => waiters.push(r));
  }
  function releaseSlot() { const n = waiters.shift(); if (n) n(); else active--; }
  const sessionLocks = new Map();
  function enqueueTurn(lockKey, fn) {
    const run = () => acquireSlot().then(fn).finally(releaseSlot);
    if (!lockKey) return run();
    const prev = sessionLocks.get(lockKey) || Promise.resolve();
    const p = prev.then(run, run);
    const tail = p.then(() => {}, () => {});
    sessionLocks.set(lockKey, tail);
    tail.then(() => { if (sessionLocks.get(lockKey) === tail) sessionLocks.delete(lockKey); });
    return p;
  }

  async function startWatchdog(onBreach) {
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, memCheckMs));
        if (stopped) break;
        const procs = await snapshotProcs();
        const roots = new Set([acp.pid]);
        for (const p of procs) if (p.Name === "doubao.exe") roots.add(p.ProcessId);
        const mb = treeMemoryMB(procs, [...roots]);
        if (mb > memLimitMb) { onBreach(Math.round(mb)); break; }
      }
    };
    loop();
    return () => { stopped = true; };
  }

  // ---------- one turn ----------
  async function runTurn({ body, model, modelId, resumeId, fpKey, hash, prompt, last, t0, st, chunk, comment, separateProgress }) {
    let content = "", thinking = "", usage = null, stopReason = null, turnError = null;
    let stopWatchdog = null;
    const doCancel = (reason) => { if (st.sessionId && !st.cancelSent) { st.cancelSent = true; logger("cancel " + st.sessionId + " " + reason); acp.cancel(st.sessionId); } };
    st.doCancel = doCancel;

    let sawTool = false, plainStream = false, segBuf = "", preTimer = null;
    const toolLog = new Map();
    // Discrete reasoning blocks (narration / tool / plan) are separated by a blank
    // line so markdown renderers show distinct paragraphs instead of one wall of
    // text; streamed thought chunks keep their own internal newlines.
    let rKind = null;
    const emitReasoningBlock = (block) => {
      const s = (rKind ? "\n\n" : "") + block;
      rKind = "block"; thinking += s;
      chunk(separateProgress ? { doubao_progress: block } : { reasoning_content: s });
    };
    const flushNarration = () => {
      if (!segBuf) return;
      emitReasoningBlock("〔过程叙述〕" + segBuf.trim());
      segBuf = "";
    };
    let turnEnded = false;
    const trajCache = new Map();
    let lineChain = Promise.resolve();
    const progress = toolProgress();
    const formatLine = (rec) => {
      const mark = rec.status === "completed" ? "✓" : rec.status === "failed" ? "✗" : "…";
      return `[${rec.kind}] ${rec.title} ${mark}` + (rec.detail && rec.status === "completed" ? ` → ${rec.detail}` : "");
    };
    const emitToolLine = (rec, phase) => {
      if (turnEnded || st.aborted) return;
      if (phase === "start") { if (rec.started) return; rec.started = true; }
      else { if (rec.emitted) return; rec.emitted = true; }
      const line = formatLine(rec);
      if (progress === "reasoning") emitReasoningBlock(line);
      else if (progress === "comment") comment(line);
    };
    const toolRec = (u) => {
      const id = u.toolCallId || u.title || String(toolLog.size);
      const prev = toolLog.get(id) || {};
      const rec = { kind: u.kind || prev.kind || "tool", title: u.title || prev.title || id, status: u.status || prev.status || "", detail: prev.detail || "", raw: prev.raw, emitted: prev.emitted || false, started: prev.started || false };
      const raw = u.rawOutput != null ? u.rawOutput : (u.rawInput != null ? u.rawInput : null);
      if (raw != null) { const s = typeof raw === "string" ? raw : JSON.stringify(raw); rec.raw = s.slice(0, 4000); rec.detail = safeSlice(stripGarble(s).replace(/\s+/g, " ").trim(), toolDetail); }
      toolLog.set(id, rec);
      const final = rec.status === "completed" || rec.status === "failed" || !rec.status;
      return { rec, final };
    };
    const queueToolLine = (rec, phase) => {
      lineChain = lineChain.then(async () => {
        if (turnEnded || st.aborted) return;
        if (phase === "start") {
          if (rec.started) return;
          // Terminal events carry no command text; the trajectory's newest
          // result-less tool_call is the one running right now.
          if (/^(继续处理任务|Tool)/.test(rec.title)) {
            // Prefer the command carried in the event's own input, if any.
            let cmd = null;
            if (rec.raw) { try { const j = JSON.parse(rec.raw); cmd = j && (j.command || j.cmd); } catch {} }
            if (cmd) { rec.title = truncCmd(String(cmd)); }
            else {
              for (const delay of [0, 300, 900]) {
                if (delay) await new Promise((r) => setTimeout(r, delay));
                if (turnEnded || st.aborted) return;
                let hit = null; try { hit = latestPendingCommand(t0 - 5000); } catch {}
                if (hit) { rec.title = truncCmd(hit.command); rec.kind = hit.name; break; }
              }
            }
            // Adapter gives terminal calls a generic title and a bogus kind;
            // don't print a misleading "[read]" before the command is known.
            if (/^(继续处理任务|Tool)/.test(rec.title)) { rec.kind = "tool"; rec.title = "工具运行中"; }
          }
          emitToolLine(rec, "start");
          return;
        }
        if (rec.emitted) return;
        if (/^(继续处理任务|Tool)/.test(rec.title) && rec.raw) {
          for (const delay of (rec.status === "failed" ? [0, 500, 1500, 3000] : [0, 500, 1500])) {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            if (turnEnded || st.aborted) return;
            let hit = null; try { hit = findCommand(rec.raw, t0 - 5000, trajCache); } catch {}
            if (hit) { rec.title = truncCmd(hit.command); rec.kind = hit.name; break; }
          }
        }
        emitToolLine(rec, "final");
      });
    };

    const handler = (u) => {
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const t = u.content && u.content.text; if (!t) break;
          if (plainStream) { content += t; chunk({ content: t }); }
          else {
            segBuf += t;
            if (!sawTool && !preTimer) preTimer = setTimeout(() => { preTimer = null; plainStream = true; content += segBuf; chunk({ content: segBuf }); segBuf = ""; }, 3000);
          }
          break;
        }
        case "agent_thought_chunk": {
          const t = u.content && u.content.text;
          if (t) { const s = (rKind === "block" ? "\n\n" : "") + t; rKind = "thought"; thinking += s; chunk({ reasoning_content: s }); }
          break;
        }
        case "tool_call": case "tool_call_update": {
          sawTool = true;
          if (preTimer) { clearTimeout(preTimer); preTimer = null; }
          flushNarration();
          const { rec, final } = toolRec(u);
          queueToolLine(rec, final ? "final" : "start");
          break;
        }
        case "plan": { emitReasoningBlock("〔计划〕" + (u.entries || []).map((e) => e.content + ":" + e.status).join(" | ")); break; }
        case "usage_update": usage = u; break;
        default: break;
      }
    };

    try {
      await ensureAcp();
      // Concurrent identical requests must not each create a session: lock new
      // turns on the request fingerprint and re-resolve it inside the lock, so
      // the second waiter resumes the session the first one just created.
      const result = await enqueueTurn(resumeId || fpKey, async () => {
        if (!resumeId) {
          const hit = sessions.get(fpKey);
          if (hit && Date.now() - hit.at < SESSION_TTL_MS) resumeId = hit.sessionId;
        }
        let useResume = false;
        if (resumeId && acp.openSessions.has(resumeId)) { st.sessionId = resumeId; useResume = true; }
        else if (resumeId) {
          try { await acp.request("session/load", { sessionId: resumeId, cwd, mcpServers: [] }); st.sessionId = resumeId; useResume = true; acp.openSessions.add(resumeId); }
          catch (e) {
            if (/already_open|busy/i.test(e.message)) { st.sessionId = resumeId; useResume = true; acp.openSessions.add(resumeId); }
            else { logger("session/load failed, new session: " + e.message); st.sessionId = null; }
          }
        }
        if (!st.sessionId) { st.sessionId = (await acp.request("session/new", { cwd, mcpServers: [] })).sessionId; acp.openSessions.add(st.sessionId); useResume = false; }
        sessions.set(fpKey, { sessionId: st.sessionId, at: Date.now() }); saveSessions();
        prompt = useResume ? withCwd(body.messages, safeText(last.content)) : buildPrompt(body.messages, keepSystem());
        if (!useResume) resumeId = null;
        if (st.aborted) { doCancel("client disconnect"); return null; }
        acp.sessionHandlers.set(st.sessionId, handler);
        if (model) { try { await acp.request("session/set_model", { sessionId: st.sessionId, modelId: model.id }); } catch (e) { logger("set_model failed " + e.message); } }
        const effort = body.reasoning_effort;
        if (effort && model) { try { await acp.request("session/set_config_option", { sessionId: st.sessionId, configId: "effort", value: String(effort) }); } catch {} }

        stopWatchdog = memLimitMb > 0 ? await startWatchdog((mb) => { turnError = `memory watchdog: agent tree exceeded ${mb}MB > ${memLimitMb}MB, cancelled`; doCancel("memory"); }) : null;
        const turnTimeout = maxTurnMs > 0 ? setTimeout(() => { turnError = turnError || `turn exceeded ${maxTurnMs}ms, cancelled`; doCancel("timeout"); }, maxTurnMs) : null;

        let pr;
        try { pr = await acp.request("session/prompt", { sessionId: st.sessionId, prompt: [{ type: "text", text: prompt }] }); }
        catch (e) { turnError = turnError || e.message; }
        finally { clearTimeout(turnTimeout); }
        stopReason = pr && pr.stopReason;
        return pr;
      });
      if (stopWatchdog) stopWatchdog();
      acp.sessionHandlers.delete(st.sessionId);

      if (st.aborted) return { aborted: true, content, thinking, usage, modelId, resumeId, promptChars: prompt.length };
      await Promise.race([lineChain, new Promise((r) => setTimeout(r, 2500))]);
      turnEnded = true;
      if (preTimer) { clearTimeout(preTimer); preTimer = null; }
      if (!plainStream && segBuf) {
        while (segBuf) { const piece = safeSlice(segBuf, 64); content += piece; chunk({ content: piece }); segBuf = segBuf.slice(piece.length); }
      }
      if (processAppendix() && toolLog.size) {
        try { enrichToolLog(toolLog, t0 - 5000); } catch {}
        const lines = [...toolLog.values()].map((r, i) => `${i + 1}. [${r.kind}] ${r.title} ${r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "(" + (r.status || "?") + ")"}` + (r.detail ? ` → ${safeSlice(r.detail, 80)}` : ""));
        let shown = lines;
        if (lines.length > processMaxLines) {
          const head = Math.ceil(processMaxLines / 2), tail = Math.floor(processMaxLines / 2);
          shown = lines.slice(0, head).concat([`…（省略 ${lines.length - processMaxLines} 步）…`], lines.slice(-tail));
        }
        const appendix = `\n\n---\n**工具链工作流**（共 ${toolLog.size} 步）\n` + shown.join("\n") + "\n";
        content += appendix; chunk({ content: appendix });
      }
      if (turnError || (stopReason && stopReason !== "end_turn" && stopReason !== "cancelled")) {
        return { error: String(turnError || ("stopReason=" + stopReason)).slice(0, 500), content, thinking, usage, modelId, resumeId, promptChars: prompt.length };
      }
      if (stopReason === "cancelled" && !content) {
        return { error: turnError || "cancelled", content, thinking, usage, modelId, resumeId, promptChars: prompt.length };
      }
      if (st.sessionId && content) {
        const key = hash(body.messages.concat([{ role: "assistant", content }]));
        sessions.set(key, { sessionId: st.sessionId, at: Date.now(), model: modelId }); saveSessions();
      }
      return { ok: true, content, thinking, usage, stopReason, modelId, resumeId, sessionId: st.sessionId, promptChars: prompt.length };
    } catch (e) {
      if (stopWatchdog) stopWatchdog();
      if (st.sessionId) acp.sessionHandlers.delete(st.sessionId);
      return { error: String(e.message || e).slice(0, 500), content, thinking, usage, modelId, resumeId, promptChars: prompt.length };
    }
  }

  // ---------- OpenAI chat completion ----------
  async function completion(body, signal, { responses = false } = {}) {
    const t0 = Date.now();
    if (!body || typeof body !== "object" || !Array.isArray(body.messages) || !body.messages.length) throw httpError(400, "messages is required and must be a non-empty array");
    // Request capture for diagnosing caller aux traffic (Qoder title/summary
    // calls). Toggle without restart: create <root>/capture.on, or set env.
    const captureDir = env.DOUBAO_ACP_CAPTURE || (fs.existsSync(path.join(root, "capture.on")) ? path.join(root, "capture") : "");
    if (captureDir) {
      try { fs.mkdirSync(captureDir, { recursive: true }); fs.writeFileSync(path.join(captureDir, Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ".json"), JSON.stringify(body)); } catch {}
    }
    const stream = body.stream === true;
    if (env.DOUBAO_ACP_LOCAL_TITLE !== "0") {
      const subject = titleSubjectOf(body.messages);
      if (subject != null) {
        const modelId = typeof body.model === "string" && body.model ? body.model : "doubao-default";
        logger(JSON.stringify({ ev: "local-title", model: modelId, chars: subject.length }));
        return localTitleResponse(subject, body, modelId);
      }
    }
    const models = await fetchModels().catch(() => []);
    const model = resolveModel(body.model, models);
    const modelId = model ? model.id : (models.find((m) => m.is_default) || models[0] || {}).id || "doubao-default";

    // Codex can add developer instructions to each Responses turn. Ignore them
    // in session keys when the prompt builder also drops them. Keep the cwd.
    const ignoreCallerInstructions = responses && !keepSystem();
    const hash = (messages) => hashMessages(modelId, messages, ignoreCallerInstructions);
    const fpKey = "fp:" + hash(body.messages);
    const last = body.messages[body.messages.length - 1];
    let resumeId = null, prompt;
    if (last && last.role === "user" && body.messages.length > 1) {
      const hit = sessions.get(hash(body.messages.slice(0, -1)));
      if (hit && Date.now() - hit.at < SESSION_TTL_MS) resumeId = hit.sessionId;
    }
    // Retries / duplicate sends of the same request carry no new history, so the
    // prefix-hash miss above would spawn a fresh doubao conversation each time.
    // Fall back to a fingerprint of the full incoming messages to reuse the
    // session already started for that identical request.
    if (!resumeId) {
      const hit = sessions.get(fpKey);
      if (hit && Date.now() - hit.at < SESSION_TTL_MS) resumeId = hit.sessionId;
    }
    prompt = resumeId ? withCwd(body.messages, safeText(last.content)) : buildPrompt(body.messages, keepSystem());
    if (resumeId && !prompt.trim()) resumeId = null;
    if (signal?.aborted) throw httpError(499, "client aborted before the turn began");

    const created = Math.floor(Date.now() / 1000);
    const completionId = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
    const st = { aborted: false, sessionId: null, cancelSent: false, doCancel: null };
    const onAbort = () => { st.aborted = true; if (st.doCancel) st.doCancel("client disconnect"); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const sseLine = (delta, finish) => "data: " + JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish || null }] }) + "\n\n";
    const usageOf = (r) => ({ prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(r.content + r.thinking), total_tokens: estimateTokens(prompt) + estimateTokens(r.content + r.thinking) });
    const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    const errJson = (status, message, type) => new Response(JSON.stringify({ error: { message, type: type || "invalid_request_error", code: status } }), { status, headers: jsonHeaders });

    if (!stream) {
      const noop = () => {};
      try {
        const r = await runTurn({ body, model, modelId, resumeId, fpKey, hash, prompt, last, t0, st, chunk: noop, comment: noop });
        if (st.aborted) return errJson(499, "client aborted", "upstream_error");
        if (r.error) return errJson(502, r.error, "upstream_error");
        const message = { role: "assistant", content: r.content };
        if (r.thinking) message.reasoning_content = r.thinking;
        const resp = { id: completionId, object: "chat.completion", created, model: modelId, choices: [{ index: 0, message, finish_reason: "stop" }], usage: usageOf(r) };
        if (r.usage) resp.doubao_context_usage = r.usage;
        return new Response(JSON.stringify(resp), { status: 200, headers: jsonHeaders });
      } finally { signal?.removeEventListener("abort", onAbort); }
    }

    const out = pushStream(onAbort);
    const chunk = (delta, finish) => { if (!st.aborted) out.write(sseLine(delta, finish)); };
    const comment = (text) => { if (!st.aborted && toolProgress() === "comment") out.write(": " + text.replace(/\n/g, " ") + "\n\n"); };
    out.write(sseLine({ role: "assistant", content: "" }));
    const keepalive = setInterval(() => { if (!st.aborted) out.write(": keepalive\n\n"); }, 5000);

    (async () => {
      try {
        const r = await runTurn({ body, model, modelId, resumeId, fpKey, hash, prompt, last, t0, st, chunk, comment, separateProgress: responses });
        if (st.aborted) return;
        if (r.error) { out.write("data: " + JSON.stringify({ error: { message: r.error, type: "upstream_error" } }) + "\n\n"); return; }
        chunk({}, "stop");
        if (body.stream_options && body.stream_options.include_usage) {
          out.write("data: " + JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model: modelId, choices: [], usage: usageOf(r) }) + "\n\n");
        }
        out.write("data: [DONE]\n\n");
        logger(JSON.stringify({ ev: "chat", ok: true, model: modelId, resume: Boolean(r.resumeId), ms: Date.now() - t0, outChars: r.content.length, session: r.sessionId, stopReason: r.stopReason }));
      } catch (e) {
        if (!st.aborted) out.write("data: " + JSON.stringify({ error: { message: String(e.message || e).slice(0, 500), type: "upstream_error" } }) + "\n\n");
      } finally {
        clearInterval(keepalive);
        signal?.removeEventListener("abort", onAbort);
        out.close();
      }
    })();

    return new Response(out.stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
  }

  return { completion, fetchModels, resolveModel, stats: () => ({ active, queued: waiters.length, sessions: sessions.size, acpPid: acp.pid, cwd, permission }) };
}

export const _internal = { stripCallerBoilerplate, buildPrompt, cwdOf, withCwd, titleSubjectOf, localTitle, hashMessages, safeSlice, stripGarble };
