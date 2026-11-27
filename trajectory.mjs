// ACP terminal events carry no command text; recover it from the agent's
// on-disk trajectory by matching normalized output. Ported from acp-server.js.
import fs from "node:fs";
import path from "node:path";

const AGENT_DATA = path.join(process.env.LOCALAPPDATA || "", "doubao_cli", "agent_mode");

export function recentTrajectories(sinceMs) {
  const out = [];
  try {
    for (const uid of fs.readdirSync(AGENT_DATA)) {
      const sessRoot = path.join(AGENT_DATA, uid, "workspace", ".sessions");
      let sids; try { sids = fs.readdirSync(sessRoot); } catch { continue; }
      for (const sid of sids) {
        const agentsDir = path.join(sessRoot, sid, "agents");
        let aids; try { aids = fs.readdirSync(agentsDir); } catch { continue; }
        for (const aid of aids) {
          const f = path.join(agentsDir, aid, "system", "trajectory.jsonl");
          try { if (fs.statSync(f).mtimeMs >= sinceMs) out.push(f); } catch {}
        }
      }
    }
  } catch {}
  return out;
}

function readLines(file) {
  let text;
  try {
    const st = fs.statSync(file); const size = Math.min(st.size, 8 * 1024 * 1024);
    const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size); fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function parseTrajectory(file) {
  const calls = new Map(); const done = new Set(); const results = [];
  for (const j of readLines(file)) {
    if (j.role === "assistant" && Array.isArray(j.tool_calls)) {
      for (const tc of j.tool_calls) {
        const fn = tc.function || {};
        let args = fn.arguments; if (typeof args === "string") { try { args = JSON.parse(args); } catch {} }
        calls.set(tc.id, { name: fn.name || "tool", command: (args && (args.command || args.cmd)) || (args ? JSON.stringify(args).slice(0, 160) : "") });
      }
    } else if (j.role === "tool" && j.tool_call_id) {
      done.add(j.tool_call_id);
      const c = calls.get(j.tool_call_id);
      if (c) results.push({ name: c.name, command: c.command, output: String(j.content || "") });
    }
  }
  return { calls, done, results };
}

export function trajectoryCalls(file) {
  return parseTrajectory(file).results;
}

// The assistant tool_call entry lands on disk before the tool runs, so the
// newest call without a tool result is the one currently executing. Lets the
// live feed show the real command at tool START, not only at completion.
export function latestPendingCommand(sinceMs) {
  const files = recentTrajectories(sinceMs);
  const withPending = [];
  for (const f of files) {
    const { calls, done } = parseTrajectory(f);
    const pending = [...calls.entries()].filter(([id]) => !done.has(id)).map(([, c]) => c).filter((c) => c.command);
    if (pending.length) withPending.push(pending);
  }
  // More than one session has a running tool: can't attribute safely, skip.
  if (withPending.length !== 1) return null;
  const p = withPending[0];
  return p[p.length - 1];
}

export function enrichToolLog(toolLog, sinceMs) {
  const generic = [...toolLog.values()].filter((r) => /^(继续处理任务|Tool)/.test(r.title) && r.raw);
  if (!generic.length) return;
  const norm = (s) => s.replace(/\r\n/g, "\n").trim();
  for (const f of recentTrajectories(sinceMs)) {
    for (const c of trajectoryCalls(f)) {
      if (!c.command) continue;
      const out = norm(c.output);
      const sm = out.match(/stdout: ([\s\S]*)$/);
      const stdout = sm ? sm[1].trim() : out;
      for (const r of generic) {
        const raw = norm(r.raw);
        if (!raw) continue;
        if (stdout === raw || (raw.length >= 4 && out.includes(raw))) {
          r.title = truncCmd(c.command);
          r.kind = c.name;
        }
      }
    }
  }
}

export function findCommand(raw, sinceMs, cache) {
  const norm = (s) => s.replace(/\r\n/g, "\n").trim();
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  const rawN = norm(raw);
  if (!rawN) return null;
  const cands = [rawN];
  if (/^[[{]/.test(rawN)) {
    try {
      const j = JSON.parse(rawN);
      for (const k of ["stderr", "stdout", "content", "text", "output"]) {
        const v = j && j[k];
        if (typeof v === "string" && v.trim()) cands.push(norm(v));
      }
    } catch {}
  }
  const rawF = cands.map(flat);
  for (const f of recentTrajectories(sinceMs)) {
    let entries;
    try {
      const mtime = fs.statSync(f).mtimeMs;
      const hit = cache && cache.get(f);
      if (hit && hit.mtime === mtime) entries = hit.entries;
      else { entries = trajectoryCalls(f); if (cache) cache.set(f, { mtime, entries }); }
    } catch { continue; }
    for (const c of entries) {
      if (!c.command) continue;
      const out = norm(c.output);
      const sm = out.match(/stdout: ([\s\S]*)$/);
      const stdout = sm ? sm[1].trim() : out;
      const em = out.match(/stderr: ([\s\S]*)$/);
      const stderr = em ? em[1].trim() : "";
      const outF = flat(out);
      for (let i = 0; i < cands.length; i++) {
        const r = cands[i];
        if (!r) continue;
        if (stdout === r || stderr === r || out === r || (r.length >= 4 && (out.includes(r) || outF.includes(rawF[i])))) return { name: c.name, command: c.command };
      }
    }
  }
  return null;
}

export function truncCmd(s) {
  if (s.length <= 120) return s;
  let end = 120;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  let cut = s.slice(0, end);
  const i = Math.max(cut.lastIndexOf("\\"), cut.lastIndexOf("/"));
  if (i > 60) cut = cut.slice(0, i);
  return cut + "…";
}