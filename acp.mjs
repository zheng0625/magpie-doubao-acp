// ACP client: persistent `doubao acp serve` child over stdio JSON-RPC.
// Ported from doubao-openai-proxy/acp-server.js; lazy-started on first use.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";

// Resolve the CLI from (1) DOUBAO_CLI override, (2) the plugin's own deps,
// (3) magpie's shared plugin tree (local-path plugins don't see it via normal
// upward resolution), (4) the global npm install.
export function cliScript() {
  if (process.env.DOUBAO_CLI) return process.env.DOUBAO_CLI;
  const pluginsDir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "magpie", "plugins", "package.json");
  for (const base of [import.meta.url, pluginsDir]) {
    try { return createRequire(base).resolve("@bytedance/doubao-cli/scripts/run.cjs"); } catch {}
  }
  return path.join(process.env.APPDATA || "", "npm", "node_modules", "@bytedance", "doubao-cli", "scripts", "run.cjs");
}
// Prefer node when present; the magpie host is Bun and end users may have no
// node at all — run.cjs also runs under Bun (verified), so fall back to the
// host executable instead of failing.
let nodeBinCache;
export function nodeBin() {
  if (process.env.DOUBAO_NODE) return process.env.DOUBAO_NODE;
  if (nodeBinCache !== undefined) return nodeBinCache;
  const r = spawnSync("node", ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  nodeBinCache = !r.error && r.status === 0 ? "node" : process.execPath;
  return nodeBinCache;
}

// Async CLI invocation with captured output (login/auth/install flows).
export function captureCli(args, { cwd, timeoutMs = 30000, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(nodeBin(), [cliScript(), ...args], { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); if (out.length > 1e6) out = out.slice(-1e6); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); if (err.length > 1e6) err = err.slice(-1e6); });
    child.on("exit", (code) => finish(code));
    child.on("error", (e) => { err += String(e.message || e); finish(null); });
    if (signal) {
      const onAbort = () => { try { child.kill(); } catch {} };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// Bun does not run untrusted packages' postinstall, so the platform binary
// (downloaded by scripts/install.cjs into %LOCALAPPDATA%/doubao_cli/app) may be
// missing even though the npm package resolved. Probe --version; repair once.
let runtimeRepair = null;
let runtimeOk = false;
export async function ensureRuntime(log = () => {}) {
  if (runtimeOk) return;
  const probe = await captureCli(["--version"], { timeoutMs: 20000 });
  if (probe.code === 0) { runtimeOk = true; return; }
  if (!runtimeRepair) {
    runtimeRepair = (async () => {
      const install = path.join(path.dirname(path.dirname(cliScript())), "scripts", "install.cjs");
      if (!fs.existsSync(install)) throw new Error("doubao-cli 运行时缺失且找不到安装脚本：" + install);
      log("doubao runtime missing, running install.cjs");
      const inst = await new Promise((resolve) => {
        const child = spawn(nodeBin(), [install], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "", err = "", done = false;
        const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out, err }); };
        const t = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 600000);
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("exit", finish); child.on("error", (e) => { err += String(e.message || e); finish(null); });
      });
      if (inst.code !== 0) throw new Error("doubao-cli 运行时安装失败：" + (inst.err || inst.out).slice(-400));
      const re = await captureCli(["--version"], { timeoutMs: 20000 });
      if (re.code !== 0) throw new Error("doubao-cli 运行时安装后仍不可用：" + (re.err || re.out).slice(-400));
      runtimeOk = true;
      log("doubao runtime installed");
    })().finally(() => { runtimeRepair = null; });
  }
  await runtimeRepair;
}

// magpie's plugin host patches Bun.spawn to re-inject its own proxy into any
// child whose env has no *_PROXY var (host `proxied()` guard). That proxy is
// the tray's startup-time detection — a Qoder/Clash port that may since have
// died, leaving every doubao API connection stuck in SYN_SENT (~60s) and the
// local device showing "offline" so the agent falls back to the cloud host.
// Pre-set a non-empty placeholder so the guard keeps our env instead of
// injecting the stale one, and NO_PROXY=* makes the CLI bypass it and connect
// directly (the machine already routes via Clash TUN).
export function childEnv() {
  const env = { ...process.env };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) delete env[k];
  env.HTTPS_PROXY = "http://127.0.0.1:0";
  env.HTTP_PROXY = "http://127.0.0.1:0";
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  return env;
}

export function runCliFile(args, cwd, tmpdir) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(6).toString("hex");
    const outFile = path.join(tmpdir, id + ".out");
    let outFd;
    try { outFd = fs.openSync(outFile, "w"); } catch { return resolve([]); }
    const child = spawn(nodeBin(), [cliScript(), ...args], { cwd, env: childEnv(), stdio: ["pipe", outFd, "ignore"], windowsHide: true });
    fs.closeSync(outFd); child.stdin.end();
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      let models = [];
      try {
        for (const line of fs.readFileSync(outFile, "utf8").split("\n")) {
          const t = line.trim(); if (!t) continue;
          try { const ev = JSON.parse(t); if (ev.type === "result" && ev.result && ev.result.type === "model_list") models = ev.result.models || []; } catch {}
        }
      } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      resolve(models);
    };
    child.on("exit", finish); child.on("error", finish);
    setTimeout(() => { try { child.kill(); } catch {} finish(); }, 30000);
  });
}

export class AcpClient {
  constructor({ cwd, permission, maxTurnMs, log }) {
    this.cwd = cwd; this.permission = permission; this.maxTurnMs = maxTurnMs; this.log = log || (() => {});
    this.child = null; this.nextId = 1; this.pending = new Map(); this.sessionHandlers = new Map();
    this.openSessions = new Set(); this.buf = ""; this.ready = null; this.pid = null;
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(nodeBin(), [cliScript(), "acp", "serve", "--permission-mode", this.permission, "-C", this.cwd], { cwd: this.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child; this.pid = child.pid;
      child.stdout.on("data", (c) => this._onData(c));
      child.stderr.on("data", (c) => { this.log("[acp-stderr] " + c.toString("utf8").slice(-500)); });
      child.on("exit", (code) => {
        this.log("acp child exited " + code);
        for (const [, p] of this.pending) p.reject(new Error("acp child exited"));
        this.pending.clear(); this.openSessions.clear(); this.sessionHandlers.clear();
        this.child = null; this.ready = null;
      });
      child.on("error", (e) => { this.log("acp spawn error " + e.message); this.ready = null; reject(e); });
      this._initialize().then(resolve).catch(reject);
    });
    return this.ready;
  }
  async _initialize() {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "magpie-doubao-acp", title: "Doubao ACP magpie plugin", version: "0.1.0" } });
    this.notify("notifications/initialized", {});
    this.log("acp initialized " + JSON.stringify(init.agentInfo || {}));
    return init;
  }
  _onData(c) {
    this.buf += c.toString("utf8"); let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method === "session/update") {
        const h = this.sessionHandlers.get(m.params.sessionId); if (h) h(m.params.update);
      } else if (m.method && m.id != null) {
        this._onAgentRequest(m);
      }
    }
  }
  _onAgentRequest(m) {
    if (m.method === "session/request_permission") {
      const opts = (m.params && m.params.options) || [];
      const allow = opts.find((o) => o.kind === "allow_always") || opts.find((o) => o.kind === "allow_once") || opts[0];
      const result = allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
      this._reply(m.id, result);
    } else {
      this._reply(m.id, {});
    }
  }
  _reply(id, result) { try { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); } catch {} }
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error("acp not running"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
      catch (e) { this.pending.delete(id); return reject(e); }
      if (this.maxTurnMs > 0) setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("acp request timeout: " + method)); } }, this.maxTurnMs + 60000);
    });
  }
  notify(method, params) { try { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); } catch {} }
  cancel(sessionId) { this.notify("session/cancel", { sessionId }); }
  kill() { try { this.child && this.child.kill(); } catch {} }
}