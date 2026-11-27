import assert from "node:assert/strict";
import test from "node:test";
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
