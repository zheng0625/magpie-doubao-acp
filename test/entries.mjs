// Offline tests: login/logout entry points are exposed (no quota hook anymore).
// No network turn, no CLI logout. Usage: node test/entries.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logout } from "../auth.mjs";
import { _internal } from "../index.mjs";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

await test("plugin exposes login/logout entry points and no usage hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "doubao-acp-entries-"));
  const priorCwd = process.env.DOUBAO_ACP_CWD;
  process.env.DOUBAO_ACP_CWD = join(root, "workspace");
  try {
    const hooks = _internal.createHooks({ directory: root, magpie: { option: () => undefined }, client: { app: { log: () => {} } } });
    assert.equal(hooks.auth.usage, undefined, "quota display removed");
    const labels = hooks.auth.methods.map((l) => l.label);
    assert.ok(labels.some((l) => l.includes("扫码登录")), "oauth login present");
    assert.ok(labels.some((l) => l.includes("直接启用")), "keyless login present");
    assert.ok(labels.some((l) => l.includes("退出")), "logout entry point present");
    assert.equal(typeof logout, "function");
  } finally {
    if (priorCwd === undefined) delete process.env.DOUBAO_ACP_CWD;
    else process.env.DOUBAO_ACP_CWD = priorCwd;
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nPASS (${passed} tests)`);
process.exit(0);
