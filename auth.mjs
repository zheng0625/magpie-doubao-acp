// Doubao CLI account flows: status probe and QR login. Credentials stay in the
// CLI's own store (DPAPI on Windows); the plugin never reads or keeps tokens.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureCli, ensureRuntime } from "./acp.mjs";

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

function openImage(file, log) {
  const windows = process.platform === "win32";
  const [cmd, args] = windows
    ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "Invoke-Item -LiteralPath $env:DOUBAO_ACP_QR_IMAGE -ErrorAction Stop"]]
    : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  const env = windows ? { ...process.env, DOUBAO_ACP_QR_IMAGE: file } : process.env;
  return new Promise((resolve, reject) => {
    const opener = spawn(cmd, args, { env, stdio: "ignore", windowsHide: true });
    opener.once("error", reject);
    opener.once("close", (code) => {
      if (code === 0) { log("login qr image opened"); resolve(); }
      else reject(new Error("无法打开豆包登录二维码图片（退出码 " + code + "）。"));
    });
  });
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

// Start the download and QR flow in Magpie's waiting callback, so the sign-in
// screen is visible while a new machine is downloading the runtime.
export function startLogin({ log = () => {}, openQr = openImage } = {}) {
  return {
    instructions: "首次登录会下载并安装豆包 CLI 运行时。二维码打开后，请用豆包 App 扫码并在手机上确认。",
    async finish(signal) {
      signal?.throwIfAborted();
      await ensureRuntime(log);
      signal?.throwIfAborted();
      const current = await authStatus({ signal });
      if (current.loggedIn) return current;
      signal?.throwIfAborted();

      const openSignal = new AbortController();
      const loginSignal = signal ? AbortSignal.any([signal, openSignal.signal]) : openSignal.signal;
      let opening;
      const login = await captureCli(["login", "--qr=png"], {
        timeoutMs: 600000,
        signal: loginSignal,
        onOutput(out, err) {
          if (opening) return;
          const file = qrPathOf(out + "\n" + err);
          if (!file) return;
          opening = Promise.resolve().then(() => openQr(file, log)).catch((error) => {
            openSignal.abort(new Error("无法打开豆包登录二维码。请检查系统的 PNG 默认应用后重试。"));
            log("doubao login QR could not be opened: " + error.message);
          });
        },
      });
      await opening;
      loginSignal.throwIfAborted();
      if (login.timedOut) throw new Error("豆包扫码登录超时，请重试。");
      if (login.code !== 0) throw new Error("豆包登录未完成：" + (login.err || login.out).trim().split(/[\r\n]+/).at(-1)?.slice(0, 220));
      const verified = await authStatus({ verify: true, signal });
      signal?.throwIfAborted();
      if (!verified.loggedIn) throw new Error("登录后验证失败：" + verified.raw.slice(-300));
      return verified;
    },
  };
}
