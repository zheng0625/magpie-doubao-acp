import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { _internal } from "../index.mjs";
import { responsesCompletion } from "../responses.mjs";

test("streams tool progress as commentary before the final answer", { timeout: 3000 }, async () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let source;
  const engine = {
    completion(body, _signal, options) {
      assert.deepEqual(body.messages, [
        { role: "system", content: "调用者说明" },
        { role: "user", content: "前一问" },
        { role: "assistant", content: "前一答" },
        { role: "user", content: "继续" },
      ]);
      assert.equal(options.responses, true);
      assert.equal(body.reasoning_effort, "medium");
      return new Response(new ReadableStream({ start(controller) { source = controller; } }));
    },
  };
  const reply = await responsesCompletion(engine, {
    model: "fixture", stream: true, instructions: "调用者说明", reasoning: { effort: "medium" },
    input: [
      { role: "user", content: [{ type: "input_text", text: "前一问" }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "上一轮工具进度" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "上一轮摘要" }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "前一答" }] },
      { role: "user", content: "继续" },
    ],
  });
  const send = (body) => source.enqueue(enc.encode(`data: ${JSON.stringify({ id: "chatcmpl-test", created: 40, model: "fixture", ...body })}\n\n`));
  const sendDelta = (delta) => send({ choices: [{ delta }] });
  const reader = reply.body.getReader();
  const readEvent = async () => {
    const { done, value } = await reader.read();
    assert.equal(done, false);
    return JSON.parse(dec.decode(value).split("\n")[1].slice(6));
  };

  sendDelta({ role: "assistant", content: "" });
  sendDelta({ doubao_progress: "正在运行工具" });
  assert.equal((await readEvent()).type, "response.created");
  const start = await readEvent();
  assert.equal(start.type, "response.output_item.added");
  assert.equal(start.item.phase, "commentary");
  assert.equal((await readEvent()).type, "response.content_part.added");
  const progress = await readEvent();
  assert.equal(progress.type, "response.output_text.delta");
  assert.equal(progress.delta, "正在运行工具");
  assert.equal((await readEvent()).type, "response.output_text.done");
  assert.equal((await readEvent()).type, "response.content_part.done");
  const committedProgress = await readEvent();
  assert.equal(committedProgress.type, "response.output_item.done");
  assert.equal(committedProgress.item.phase, "commentary");

  sendDelta({ doubao_progress: "工具已完成" });
  sendDelta({ reasoning_content: "摘要" });
  sendDelta({ content: "最终答复" });
  send({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 12, total_tokens: 17 } });
  source.enqueue(enc.encode("data: [DONE]\n\n"));
  source.close();
  let completed;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const event = JSON.parse(dec.decode(value).split("\n")[1].slice(6));
    if (event.type === "response.completed") completed = event.response;
  }
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.output.map((item) => item.phase ?? item.type), ["commentary", "commentary", "reasoning", "final_answer"]);
  assert.equal(completed.output[0].content[0].text, "正在运行工具");
  assert.equal(completed.output[1].content[0].text, "工具已完成");
  assert.equal(completed.output[3].content[0].text, "最终答复");
  assert.equal(completed.usage.total_tokens, 17);
});

test("Codex title requests with a context envelope return locally on both APIs", async () => {
  const root = mkdtempSync(join(tmpdir(), "doubao-title-test-"));
  const script = join(root, "fixture.cjs");
  const called = join(root, "cli-called");
  const priorCli = process.env.DOUBAO_CLI;
  const priorCwd = process.env.DOUBAO_ACP_CWD;
  const priorTitle = process.env.DOUBAO_ACP_LOCAL_TITLE;
  process.env.DOUBAO_CLI = script;
  process.env.DOUBAO_ACP_CWD = join(root, "workspace");
  delete process.env.DOUBAO_ACP_LOCAL_TITLE;
  try {
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(called)}, "unexpected CLI call");`);
    const hooks = _internal.createHooks({ directory: root });
    const loader = await hooks.auth.loader();
    const messages = [
      { role: "developer", content: "caller instructions" },
      { role: "user", content: "<environment_context><cwd>example</cwd></environment_context>" },
      { role: "user", content: "Generate a concise UI title.\nFill the structured title field with plain text.\n\nUser prompt:\n读取当前文件夹。" },
    ];
    const schema = {
      type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false,
    };
    const request = (route, body) => loader.fetch(loader.baseURL + route, {
      method: "POST", body: JSON.stringify({ model: "title-fixture", ...body }),
    });

    const streaming = await request("/responses", {
      stream: true,
      input: messages.map(({ role, content }) => ({ role, content: [{ type: "input_text", text: content }] })),
      text: { format: { type: "json_schema", name: "thread_title", schema, strict: true } },
    });
    assert.equal(streaming.status, 200);
    const events = (await streaming.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const completed = events.find((event) => event.type === "response.completed");
    assert.equal(completed.response.output[0].phase, "final_answer");
    assert.deepEqual(JSON.parse(completed.response.output[0].content[0].text), { title: "读取当前文件夹" });

    const chat = await request("/chat/completions", {
      messages, response_format: { type: "json_schema", json_schema: { name: "thread_title", schema, strict: true } },
    });
    assert.equal(chat.status, 200);
    assert.deepEqual(JSON.parse((await chat.json()).choices[0].message.content), { title: "读取当前文件夹" });

    const plain = await request("/chat/completions", { messages });
    assert.equal((await plain.json()).choices[0].message.content, "读取当前文件夹");
    assert.equal(existsSync(called), false);
    assert.equal(existsSync(join(root, "doubao-acp", "acp-sessions.json")), false);
  } finally {
    for (const [key, value] of Object.entries({ DOUBAO_CLI: priorCli, DOUBAO_ACP_CWD: priorCwd, DOUBAO_ACP_LOCAL_TITLE: priorTitle })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
