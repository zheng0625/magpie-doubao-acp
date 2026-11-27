import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureRuntime } from "../acp.mjs";
import { startLogin } from "../auth.mjs";

test("a fresh QR login provisions the runtime and opens the CLI's image", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "doubao-first-login-"));
  const script = join(root, "run.cjs");
  const installed = join(root, "installed");
  const failInstall = join(root, "fail-install");
  const image = join(root, "示例 login's QR.png");
  const priorCli = process.env.DOUBAO_CLI;
  const priorNode = process.env.DOUBAO_NODE;
  process.env.DOUBAO_CLI = script;
  process.env.DOUBAO_NODE = process.execPath;
  const log = [];
  try {
    writeFileSync(join(root, "install.cjs"), `
      const fs = require("node:fs");
      const path = require("node:path");
      if (fs.existsSync(path.join(__dirname, "fail-install"))) {
        console.error("下载进度 100%\\r官方安装程序失败");
        process.exitCode = 1;
      } else {
        setTimeout(() => fs.appendFileSync(path.join(__dirname, "installed"), "install\\n"), 80);
      }
    `);
    writeFileSync(script, `
      const fs = require("node:fs");
      const path = require("node:path");
      const args = process.argv.slice(2);
      const installed = path.join(__dirname, "installed");
      const signedIn = path.join(__dirname, "signed-in");
      if (!fs.existsSync(installed)) {
        console.error("运行时缺失");
        process.exitCode = 1;
      } else if (args[0] === "--version") {
        console.log("fixture 1.0.0");
      } else if (args[0] === "auth") {
        if (fs.existsSync(signedIn)) console.log("登录成功\\n用户 ID：10001");
        else process.exitCode = 1;
      } else if (args[0] === "login" && args[1] === "--qr=png") {
        const image = ${JSON.stringify(image)};
        fs.writeFileSync(image, "fixture");
        console.error("二维码图片：" + image);
        setTimeout(() => fs.writeFileSync(signedIn, "ok"), 90);
      } else process.exitCode = 1;
    `);

    const opened = [];
    const flow = startLogin({ log: (message) => log.push(message), openQr: (file) => opened.push(file) });
    assert.match(flow.instructions, /首次登录/);
    assert.equal(existsSync(installed), false, "setup starts after authorization returns");

    writeFileSync(failInstall, "fixture");
    await assert.rejects(flow.finish(), /运行时安装失败：官方安装程序失败/);
    assert.deepEqual(opened, []);
    unlinkSync(failInstall);

    const [result] = await Promise.all([flow.finish(new AbortController().signal), ensureRuntime()]);
    assert.equal(result.loggedIn, true);
    assert.equal(result.uid, "10001");
    assert.deepEqual(opened, [image]);
    assert.equal(readFileSync(installed, "utf8"), "install\n");
    assert.ok(log.some((line) => line.includes("runtime installed")));

    await flow.finish();
    assert.deepEqual(opened, [image], "an already signed-in CLI skips QR generation");
  } finally {
    if (priorCli === undefined) delete process.env.DOUBAO_CLI;
    else process.env.DOUBAO_CLI = priorCli;
    if (priorNode === undefined) delete process.env.DOUBAO_NODE;
    else process.env.DOUBAO_NODE = priorNode;
    rmSync(root, { recursive: true, force: true });
  }
});
