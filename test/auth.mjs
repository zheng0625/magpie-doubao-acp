// Auth flow test against the real CLI (read-only + already-login short-circuit;
// never completes a QR scan, never touches credentials).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internal } from "../index.mjs";
import { authStatus, startLogin } from "../auth.mjs";
import { cliScript, nodeBin, ensureRuntime } from "../acp.mjs";

console.log("cliScript:", cliScript());
console.log("nodeBin:", nodeBin());
await ensureRuntime(console.log);
console.log("runtime ok");

const st = await authStatus();
console.log("status:", JSON.stringify({ loggedIn: st.loggedIn, uid: st.uid }));
if (!st.loggedIn) { console.error("FAIL: expected logged-in CLI on this machine"); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), "doubao-acp-auth-"));
const hooks = _internal.createHooks({ directory: root, magpie: { option: () => undefined }, client: { app: { log: async () => {} } } });
const methods = hooks.auth.methods;
console.log("methods:", methods.map((m) => `${m.type}:${m.label}`).join(" | "));

// keyless api method: already logged in -> success with metadata
const api = methods.find((m) => m.type === "api");
const r1 = await api.authorize();
console.log("api authorize:", JSON.stringify(r1));
if (r1.type !== "success" || !r1.key) { console.error("FAIL api authorize"); process.exit(1); }

// oauth method: already logged in -> authorize + callback short-circuit
const oauth = methods.find((m) => m.type === "oauth");
const ctl = new AbortController();
const a = await oauth.authorize(undefined, { signal: ctl.signal });
console.log("oauth authorize:", JSON.stringify({ instructions: a.instructions, method: a.method, opened: a.opened, hasCallback: typeof a.callback === "function" }));
if (typeof a.callback !== "function" || a.method !== "auto") { console.error("FAIL oauth authorize shape"); process.exit(1); }
const r2 = await a.callback(undefined, { signal: ctl.signal });
console.log("oauth callback:", JSON.stringify(r2));
if (r2.type !== "success" || !r2.accountId) { console.error("FAIL oauth callback"); process.exit(1); }

// startLogin short-circuit when logged in
const flow = await startLogin({});
const st2 = await flow.finish();
if (!st2.loggedIn) { console.error("FAIL startLogin finish"); process.exit(1); }
console.log("startLogin short-circuit ok");

console.log("\nPASS");