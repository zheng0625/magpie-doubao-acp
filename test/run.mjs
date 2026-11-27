// Standalone test: drives the plugin hooks directly (no magpie needed).
// Usage: node test/run.mjs [question]
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internal } from "../index.mjs";
const { createHooks, ORIGIN } = _internal;

const root = mkdtempSync(join(tmpdir(), "doubao-acp-test-"));
process.env.DOUBAO_ACP_CWD = join(root, "workspace");
const logs = [];
const input = {
  directory: root,
  magpie: { option: (_p, key) => ({ tool_progress: true, process_appendix: false })[key] },
  client: { app: { log: async (o) => logs.push(o.message) } },
};
const hooks = createHooks(input);
const cfg = {};
await hooks.config(cfg);
console.log("provider config:", JSON.stringify(cfg.provider["doubao-acp"]));

const models = await hooks.provider.models({ models: {} });
const ids = Object.keys(models);
console.log("models:", ids.length, ids.slice(0, 5).join(", "));
if (!ids.length) { console.error("FAIL: no models"); process.exit(1); }

const loader = await hooks.auth.loader(async () => ({ type: "api", key: "DOUBAO_ACP_LOCAL" }));
const url = ORIGIN + "/magpie/v1/chat/completions";
const ask = (messages, opts = {}) => loader.fetch(url, {
  method: "POST",
  body: JSON.stringify({ model: ids[0], messages, stream: true, ...opts }),
  signal: opts.signal,
});

async function readSse(res, onDelta) {
  if (res.status !== 200) { console.error("FAIL status", res.status, await res.text()); process.exit(1); }
  const dec = new TextDecoder();
  let buf = "", content = "", reasoning = "", done = false, error = null;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") { done = true; continue; }
        const j = JSON.parse(payload);
        if (j.error) { error = j.error; continue; }
        const d = j.choices?.[0]?.delta || {};
        if (d.content) { content += d.content; onDelta?.("content", d.content); }
        if (d.reasoning_content) { reasoning += d.reasoning_content; onDelta?.("reasoning", d.reasoning_content); }
      }
    }
  }
  return { content, reasoning, done, error };
}

// 1. plain Q&A, streaming
const q = process.argv[2] || "只回复两个字母：OK";
console.log("\n--- turn 1:", q);
const t0 = Date.now();
const r1 = await readSse(await ask([{ role: "user", content: q }]), (kind, t) => {
  if (kind === "content") process.stdout.write(t);
});
console.log("\nturn1:", JSON.stringify({ ms: Date.now() - t0, done: r1.done, error: r1.error, content: r1.content.slice(0, 200), reasoningChars: r1.reasoning.length }));
if (r1.error || !r1.done || !r1.content) { console.error("FAIL turn 1"); process.exit(1); }

// 2. resume: history prefix must hit the stored session
const sessionsFile = join(root, "doubao-acp", "acp-sessions.json");
const stored = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : {};
console.log("sessions stored:", Object.keys(stored).length);
if (!Object.keys(stored).length) { console.error("FAIL: no session stored"); process.exit(1); }
console.log("\n--- turn 2 (resume): 我上一句让你回复什么？只回复那个内容");
const r2 = await readSse(await ask([
  { role: "user", content: q },
  { role: "assistant", content: r1.content },
  { role: "user", content: "我上一句让你回复什么？只回复那个内容" },
]));
console.log("turn2:", JSON.stringify({ done: r2.done, error: r2.error, content: r2.content.slice(0, 200) }));
const resumed = logs.some((l) => /resume":true/.test(l));
console.log("resume hit (log):", resumed);
if (r2.error || !r2.content) { console.error("FAIL turn 2"); process.exit(1); }

// 3. non-stream
console.log("\n--- turn 3 (non-stream)");
const res3 = await loader.fetch(url, { method: "POST", body: JSON.stringify({ model: ids[0], messages: [{ role: "user", content: "只回复两个字母：OK" }], stream: false }) });
const j3 = await res3.json();
console.log("turn3:", JSON.stringify({ status: res3.status, content: j3.choices?.[0]?.message?.content?.slice(0, 100), usage: j3.usage }));
if (res3.status !== 200 || !j3.choices?.[0]?.message?.content) { console.error("FAIL turn 3"); process.exit(1); }

// 4. cancel mid-turn
console.log("\n--- turn 4 (cancel after 2s)");
const ctl = new AbortController();
const res4 = await ask([{ role: "user", content: "请数到 100，每个数字一行，慢慢数" }], { signal: ctl.signal });
setTimeout(() => ctl.abort(), 2000);
let closed = false;
try { for await (const _ of res4.body) {} closed = true; } catch { closed = true; }
console.log("turn4 stream closed after abort:", closed);
const cancelled = logs.some((l) => /cancel .* client disconnect/.test(l));
console.log("session/cancel sent (log):", cancelled);

console.log("\nPASS");
process.exit(0);