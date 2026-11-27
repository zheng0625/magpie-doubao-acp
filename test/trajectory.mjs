// Offline unit tests for trajectory parsing + live "running command" lookup.
// Redirects LOCALAPPDATA to a temp fixture BEFORE importing trajectory.mjs.
// No CLI, no network. Usage: node test/trajectory.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbtraj-"));
process.env.LOCALAPPDATA = tmp;
const { trajectoryCalls, latestPendingCommand } = await import("../trajectory.mjs");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok -", name); };

function writeTraj(sid, aid, lines) {
  const dir = path.join(tmp, "doubao_cli", "agent_mode", "fixture-user", "workspace", ".sessions", sid, "agents", aid, "system");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "trajectory.jsonl");
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}
const call = (id, command) => ({ role: "assistant", tool_calls: [{ id, function: { name: "PowerShell", arguments: JSON.stringify({ command }) } }] });
const result = (id, output) => ({ role: "tool", tool_call_id: id, content: output });

const f1 = writeTraj("s1", "a1", [call("t1", "echo hi"), result("t1", "stdout: hi"), call("t2", "Get-ChildItem -Force")]);

test("trajectoryCalls pairs completed calls only", () => {
  const r = trajectoryCalls(f1);
  assert.equal(r.length, 1);
  assert.equal(r[0].command, "echo hi");
  assert.equal(r[0].output, "stdout: hi");
});

test("latestPendingCommand returns the running (result-less) call", () => {
  const hit = latestPendingCommand(Date.now() - 60000);
  assert.ok(hit);
  assert.equal(hit.command, "Get-ChildItem -Force");
  assert.equal(hit.name, "PowerShell");
});

test("latestPendingCommand null when all calls completed", () => {
  fs.writeFileSync(f1, [call("t1", "echo hi"), result("t1", "stdout: hi")].map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(latestPendingCommand(Date.now() - 60000), null);
});

test("latestPendingCommand null when two sessions have running tools (ambiguous)", () => {
  fs.writeFileSync(f1, [call("t2", "Get-ChildItem -Force")].map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeTraj("s2", "a2", [call("u1", "python other.py")]);
  assert.equal(latestPendingCommand(Date.now() - 60000), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nPASS (${passed} tests)`);
