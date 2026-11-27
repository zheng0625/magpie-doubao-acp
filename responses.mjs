// Render ACP progress as Responses commentary so Codex can display it while the agent works.
const enc = new TextEncoder();
const sseHeaders = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" };

function invalidRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function chatRequest(request) {
  if (typeof request?.input !== "string" && !Array.isArray(request?.input)) {
    throw invalidRequest("input must be a string or an array");
  }
  const messages = [];
  if (typeof request.instructions === "string" && request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }
  const input = typeof request.input === "string" ? [{ role: "user", content: request.input }] : request.input;
  for (const item of input) {
    if (!item || (item.type && item.type !== "message") || item.phase === "commentary") continue;
    if (!["user", "assistant", "system", "developer"].includes(item.role)) continue;
    let content = item.content;
    if (Array.isArray(content)) {
      content = content.map((part) => {
        if (!["input_text", "output_text", "text"].includes(part?.type) || typeof part.text !== "string") {
          throw invalidRequest("only text content is supported");
        }
        return part.text;
      }).join("\n");
    }
    if (typeof content !== "string") throw invalidRequest("message content must be text");
    messages.push({ role: item.role, content });
  }
  if (!messages.some(({ role }) => role === "user")) throw invalidRequest("input must contain a user message");
  return {
    model: request.model,
    messages,
    stream: request.stream === true,
    stream_options: { include_usage: true },
    reasoning_effort: request.reasoning?.effort,
  };
}

function responseOf(chat) {
  return {
    id: "resp_" + chat.id.replace(/^chatcmpl-/, ""),
    object: "response",
    created_at: chat.created,
    model: chat.model,
    status: "in_progress",
    output: [],
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function usageOf(usage) {
  return usage ? {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.completion_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.total_tokens,
  } : null;
}

function outputItem(response, kind) {
  const suffix = response.id.slice(5) + "_" + response.output.length;
  return kind === "reasoning"
    ? { id: "rs_" + suffix, type: "reasoning", status: "in_progress", summary: [] }
    : { id: "msg_" + suffix, type: "message", status: "in_progress", role: "assistant", phase: kind, content: [] };
}

function outputPart(item) {
  return item.type === "reasoning"
    ? { type: "summary_text", text: "" }
    : { type: "output_text", text: "", annotations: [] };
}

function responseStream(chat) {
  const decoder = new TextDecoder();
  let buffer = "", response, item, part, kind, usage, sequence = 0, finished = false;

  function emit(controller, name, fields) {
    const type = "response." + name;
    const data = JSON.stringify({ type, sequence_number: sequence++, ...fields });
    controller.enqueue(enc.encode(`event: ${type}\ndata: ${data}\n\n`));
  }

  function itemEvents() {
    return {
      id: { item_id: item.id, output_index: response.output.length },
      index: item.type === "reasoning" ? { summary_index: 0 } : { content_index: 0 },
      part: item.type === "reasoning" ? "reasoning_summary_part" : "content_part",
      text: item.type === "reasoning" ? "reasoning_summary_text" : "output_text",
    };
  }

  function endItem(controller, status) {
    if (!item) return;
    const events = itemEvents();
    emit(controller, events.text + ".done", { ...events.id, ...events.index, text: part.text });
    emit(controller, events.part + ".done", { ...events.id, ...events.index, part });
    const parts = item.type === "reasoning" ? "summary" : "content";
    item[parts].push(part);
    item.status = status;
    emit(controller, "output_item.done", { output_index: events.id.output_index, item });
    response.output.push(item);
    item = undefined;
  }

  function delta(controller, text, nextKind) {
    if (!text) return;
    if (!item || nextKind !== kind) {
      endItem(controller, "completed");
      kind = nextKind;
      item = outputItem(response, kind);
      part = outputPart(item);
      const events = itemEvents();
      emit(controller, "output_item.added", { output_index: events.id.output_index, item });
      emit(controller, events.part + ".added", { ...events.id, ...events.index, part });
    }
    const events = itemEvents();
    part.text += text;
    emit(controller, events.text + ".delta", { ...events.id, ...events.index, delta: text });
  }

  function finish(controller, error) {
    if (!response || finished) return;
    finished = true;
    endItem(controller, error ? "incomplete" : "completed");
    response.status = error ? "failed" : "completed";
    if (error) response.error = { code: "server_error", message: error };
    response.usage = usageOf(usage);
    emit(controller, response.status, { response });
  }

  function frame(controller, raw) {
    if (raw.startsWith(":")) {
      controller.enqueue(enc.encode(raw + "\n\n"));
      return;
    }
    const line = raw.split("\n").find((value) => value.startsWith("data:"));
    if (!line || finished) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { finish(controller); return; }
    const event = JSON.parse(data);
    if (event.error) { finish(controller, event.error.message || "ACP turn failed"); return; }
    if (!response) {
      response = responseOf(event);
      emit(controller, "created", { response });
    }
    if (event.usage) usage = event.usage;
    const chunk = event.choices?.[0]?.delta;
    if (chunk) {
      if (chunk.doubao_progress) {
        delta(controller, chunk.doubao_progress, "commentary");
        endItem(controller, "completed");
      }
      delta(controller, chunk.reasoning_content, "reasoning");
      delta(controller, chunk.content, "final_answer");
    }
  }

  return chat.body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        frame(controller, buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
      }
    },
    flush(controller) { finish(controller, "ACP stream ended before completion"); },
  }));
}

export async function responsesCompletion(engine, request, signal) {
  const body = chatRequest(request);
  const chat = await engine.completion(body, signal, { responses: true });
  if (!chat.ok) return chat;
  if (body.stream) return new Response(responseStream(chat), { headers: sseHeaders });

  const result = await chat.json();
  const response = responseOf(result);
  const message = result.choices[0].message;
  const parts = [["reasoning", message.reasoning_content], ["final_answer", message.content]];
  for (const [kind, text] of parts) {
    if (!text) continue;
    const item = outputItem(response, kind);
    const part = { ...outputPart(item), text };
    if (kind === "reasoning") item.summary.push(part);
    else item.content.push(part);
    item.status = "completed";
    response.output.push(item);
  }
  response.status = "completed";
  response.usage = usageOf(result.usage);
  return Response.json(response, { headers: { "cache-control": "no-store" } });
}
