// Offline unit tests: prompt sanitization, cwd extraction, title detection.
// No CLI, no network. Usage: node test/unit.mjs
import assert from "node:assert/strict";
import { _internal } from "../engine.mjs";
const { stripCallerBoilerplate, buildPrompt, cwdOf, titleSubjectOf, localTitle, hashMessages } = _internal;

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok -", name); };

const REMINDER_CWD = "D:\\example\\current-project";
const ENV_CWD = "D:\\example\\other-project";
const REMINDER = `<system-reminder>\n# Environment\n- Primary working directory: ${REMINDER_CWD}\n- Platform: win32\n</system-reminder>`;
const AGENTS_MD = `# AGENTS.md instructions for ${ENV_CWD}\n\n<INSTRUCTIONS>\n# Git 约定\n- 使用配置好的 Git 身份。\n\n--- project-doc ---\n# 仓库维护约定\n- 更新 CHANGELOG.md。\n</INSTRUCTIONS>`;
const ENV_CTX = `<environment_context>\n  <cwd>${ENV_CWD}</cwd>\n  <shell>powershell</shell>\n</environment_context>`;

test("strips closed and unclosed system-reminder", () => {
  assert.equal(stripCallerBoilerplate("任务A\n" + REMINDER + "\n任务B"), "任务A\n\n任务B");
  assert.equal(stripCallerBoilerplate("任务A\n<system-reminder>unclosed boilerplate"), "任务A");
});

test("strips AGENTS.md header and INSTRUCTIONS block", () => {
  const out = stripCallerBoilerplate(AGENTS_MD + ENV_CTX + "了解当前项目");
  assert.equal(out, "了解当前项目");
});

test("strips environment_context but keeps surrounding user text", () => {
  assert.equal(stripCallerBoilerplate("前文\n" + ENV_CTX + "\n后文"), "前文\n\n后文");
});

test("strips unclosed INSTRUCTIONS to end", () => {
  assert.equal(stripCallerBoilerplate("任务\n<INSTRUCTIONS>\nsecret rules"), "任务");
});

test("cwdOf reads <cwd> tag and Primary working directory line", () => {
  assert.equal(cwdOf([{ role: "user", content: ENV_CTX + "问题" }]), ENV_CWD);
  assert.equal(cwdOf([{ role: "user", content: REMINDER + "问题" }]), REMINDER_CWD);
});

test("cwdOf ignores assistant text and takes the last hit", () => {
  const msgs = [
    { role: "user", content: "<cwd>D:\\old</cwd>旧问题" },
    { role: "assistant", content: "working directory: D:\\fake" },
    { role: "user", content: "<cwd>D:\\new</cwd>新问题" },
  ];
  assert.equal(cwdOf(msgs), "D:\\new");
});

test("buildPrompt drops system by default, keeps cwd line + clean text", () => {
  const msgs = [
    { role: "system", content: "caller system boilerplate" },
    { role: "user", content: REMINDER + AGENTS_MD + "只回复OK" },
  ];
  const p = buildPrompt(msgs, false);
  assert.equal(p, `当前项目目录：${REMINDER_CWD}\n\n只回复OK`);
  assert.ok(!p.includes("boilerplate") && !p.includes("INSTRUCTIONS") && !p.includes("Git"));
});

test("buildPrompt keepSystem forwards system text", () => {
  const p = buildPrompt([{ role: "system", content: "SYS" }, { role: "user", content: "问题" }], true);
  assert.ok(p.startsWith("SYS\n\n"));
});

const TITLE_META = "You are a helpful assistant. Your job is to provide a short title for a task that will be created from that prompt.\nGenerate a concise UI title (up to 36 characters) for this task.\nFill the structured title field with plain text.\nGenerate a clear, informative task title based solely on the prompt provided.\n\nUser prompt:\n了解当前项目";

test("titleSubjectOf detects Codex title meta request", () => {
  const msgs = [{ role: "system", content: "big caller system prompt" }, { role: "user", content: AGENTS_MD + ENV_CTX + TITLE_META }];
  assert.equal(titleSubjectOf(msgs), "了解当前项目");
});

test("titleSubjectOf ignores a separate context-only user message", () => {
  const msgs = [
    { role: "developer", content: "caller instructions" },
    { role: "user", content: AGENTS_MD + ENV_CTX },
    { role: "user", content: TITLE_META + "中的 User prompt: 字段" },
  ];
  assert.equal(titleSubjectOf(msgs), "了解当前项目中的 User prompt: 字段");
});

test("titleSubjectOf rejects ordinary and multi-turn requests", () => {
  assert.equal(titleSubjectOf([{ role: "user", content: "Generate a concise UI title 帮我写代码" }]), null);
  assert.equal(titleSubjectOf([{ role: "user", content: TITLE_META }, { role: "assistant", content: "x" }, { role: "user", content: "继续" }]), null);
  assert.equal(titleSubjectOf([{ role: "user", content: "继续修复" }, { role: "user", content: TITLE_META }]), null);
  assert.equal(titleSubjectOf([{ role: "user", content: "请分析这个示例\nUser prompt:\n" + TITLE_META }]), null);
  assert.equal(titleSubjectOf([{ role: "user", content: "只回复OK" }]), null);
});

test("localTitle cleans markdown/punctuation and caps at 36 units", () => {
  assert.equal(localTitle("# 了解当前项目。"), "了解当前项目");
  assert.equal(localTitle("修复登录 bug\n更多细节第二行"), "修复登录 bug");
  const long = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题请求";
  assert.ok(localTitle(long).length <= 36);
  assert.equal(localTitle("   "), "新会话");
});

test("hashMessages ignores boilerplate differences (retry dedup)", () => {
  const a = [{ role: "user", content: REMINDER + "读取当前文件夹" }];
  const b = [{ role: "user", content: REMINDER.replace("win32", "win32-x64") + "读取当前文件夹" }];
  assert.equal(hashMessages("m1", a), hashMessages("m1", b));
  assert.notEqual(hashMessages("m1", a), hashMessages("m2", a));
});

test("Responses session keys ignore dropped developer instructions and retain the cwd", () => {
  const history = [{ role: "user", content: "第一问" }, { role: "assistant", content: "第一答" }];
  const developer = { role: "developer", content: "Codex 追加的说明" };
  const withDeveloper = [...history, developer];
  const withCwd = [...history, { ...developer, content: "<cwd>D:\\other-project</cwd>" }];
  assert.equal(hashMessages("m1", history, true), hashMessages("m1", withDeveloper, true));
  assert.notEqual(hashMessages("m1", history, true), hashMessages("m1", withCwd, true));
  assert.notEqual(hashMessages("m1", history), hashMessages("m1", withDeveloper));
});

console.log(`\nPASS (${passed} tests)`);
