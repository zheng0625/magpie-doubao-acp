// Doubao CLI account flows: status probe and QR login. Credentials stay in the
// CLI's own store (DPAPI on Windows); the plugin never reads or keeps tokens.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { captureCli, cliScript, nodeBin, childEnv, ensureRuntime } from "./acp.mjs";

export async function authStatus({ verify = false, signal } = {}) {
  const r = await captureCli(["auth", "status", ...(verify ? ["--verify"] : [])], { timeoutMs: 30000, signal });
  const out = (r.out + "\n" + r.err).trim();
  const uid = (out.match(/用户 ID：\s*(\d+)/) || [])[1] || "";
  return { loggedIn: r.code === 0 && /登录成功/.test(out), uid, raw: out, code: r.code };
}

// 退出豆包 CLI 登录。CLI 的 logout 会同时停止该账号下运行中的任务，
// 凭据由 CLI 自己清除；插件不接触凭据。返回 { ok, uid, raw, code }。
export async function logout({ signal } = {}) {
  const before = await authStatus({ signal });
  const r = await captureCli(["logout"], { timeoutMs: 30000, signal });
  const out = (r.out + "\n" + r.err).trim();
  const after = await authStatus({ signal });
  return { ok: !after.loggedIn, uid: before.uid, raw: out, code: r.code };
}

function openImage(file) {
  const [cmd, args] = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-Command", `Start-Process -LiteralPath '${file.replace(/'/g, "''")}'`]]
    : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  try { spawn(cmd, args, { stdio: "ignore", windowsHide: true, detached: true }).unref(); } catch {}
}

// `login --qr=png` prints a temp image path (format not contractually fixed);
// accept any .png path on a line that actually exists on disk.
function qrPathOf(text) {
  const cands = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.toLowerCase().endsWith(".png")) cands.push(t);
    const m = line.match(/([A-Za-z]:[\\/].+?\.png|\/.+?\.png)/);
    if (m) cands.push(m[1]);
  }
  return cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || "";
}

// Returns { instructions, finish(signal) }. When the CLI is already logged in
// it short-circuits (doubao login itself does the same) and finish resolves
// immediately; otherwise a login child waits for the QR scan.
export async function startLogin({ signal, log = () => {} } = {}) {
  await ensureRuntime(log);
  const st = await authStatus({ signal });
  if (st.loggedIn) {
    return { instructions: "豆包 CLI 已登录（用户 " + (st.uid || "本机账号") + "），无需扫码。", finish: async () => st };
  }
  const child = spawn(nodeBin(), [cliScript(), "login", "--qr=png"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "", opened = false;
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", (e) => { err += String(e.message || e); resolve(null); });
  });
  child.stdout.on("data", (d) => {
    out += d.toString("utf8");
    if (!opened) { const p = qrPathOf(out); if (p) { opened = true; openImage(p); log("login qr image opened: " + p); } }
  });
  child.stderr.on("data", (d) => { err += d.toString("utf8"); });
  const kill = () => { try { child.kill(); } catch {} };
  if (signal?.aborted) kill();
  else signal?.addEventListener("abort", kill, { once: true });
  return {
    instructions: "登录二维码图片将自动打开，请用豆包 App 扫码并在手机上确认。若图片未打开，请在终端运行 doubao login。",
    finish: async (sig) => {
      if (sig) { if (sig.aborted) kill(); else sig.addEventListener("abort", kill, { once: true }); }
      const code = await exitPromise;
      signal?.removeEventListener("abort", kill);
      if (code !== 0) throw new Error("豆包登录未完成：" + (err || out).trim().slice(-300));
      const verified = await authStatus({ verify: true });
      if (!verified.loggedIn) throw new Error("登录后验证失败：" + verified.raw.slice(-300));
      return verified;
    },
  };
}