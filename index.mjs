// magpie provider plugin: Doubao CLI ACP agent, no external proxy.
// The bridge logic lives in engine.mjs (ported from doubao-openai-proxy).
import { join } from "node:path";
import { homedir } from "node:os";
import { createEngine } from "./engine.mjs";
import { authStatus, startLogin, logout } from "./auth.mjs";
import { responsesCompletion } from "./responses.mjs";

const PROVIDER = "doubao-acp";
const ORIGIN = "https://doubao-acp.magpie.local";
const API_PATH = "/magpie/v1/chat/completions";
const RESPONSES_PATH = "/magpie/v1/responses";
const OPTION_DEFAULTS = { tool_progress: true, process_appendix: false, forward_system: false };

function errorResponse(error) {
  const status = Number(error?.status) || 502;
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message || "豆包 ACP 插件请求未完成。"),
        type: status === 401 ? "authentication_error" : "upstream_error",
        code: status,
      },
    }),
    { status: status >= 400 && status <= 599 ? status : 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}

function modelsView(models) {
  return Object.fromEntries(models.map((m) => [m.id, {
    id: m.id,
    name: m.name || m.id,
    npm: "@ai-sdk/openai-compatible",
    also: ["@ai-sdk/openai"],
    api: { id: m.id, url: ORIGIN + "/magpie/v1", npm: "@ai-sdk/openai-compatible" },
    limit: { context: 131072, output: 32768 },
    reasoning: true,
    tool_call: false,
    toolCallEmulated: false,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      reasoning: true,
      toolcall: false,
      attachment: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  }]));
}

function createHooks(input = {}) {
  const root = join(input.directory || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie"), PROVIDER);
  const option = (key) => {
    const v = input.magpie?.option?.(PROVIDER, key);
    return typeof v === "boolean" ? v : OPTION_DEFAULTS[key];
  };
  const log = (...a) => {
    try { input.client?.app?.log?.({ service: PROVIDER, level: "info", message: a.map(String).join(" ") }); } catch {}
  };
  const engine = createEngine({ root, option, log });

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "豆包 CLI · ACP",
        npm: "@ai-sdk/openai-compatible",
        api: ORIGIN + "/magpie/v1",
        // ACP owns tool execution. Magpie's hosted-search wrapper expects
        // client tool calls and flattens the Responses commentary stream.
        searches: true,
        models: {},
      };
    },
    auth: {
      provider: PROVIDER,
      options: [
        {
          key: "tool_progress",
          label: "工具链实时呈现",
          description: "实时显示工具开始和完成事件。Codex 使用过程消息，Chat Completions 使用 reasoning 流。",
          default: true,
        },
        {
          key: "process_appendix",
          label: "正文附工作流回顾",
          description: "默认关闭。开启后在最终回复末尾附加工具链工作流列表。",
          default: false,
        },
        {
          key: "forward_system",
          label: "转发调用方系统提示",
          description: "默认关闭：剥离 Qoder/Codex 等调用方的 system/developer 消息（技能清单、MCP 目录、各 agent README 等），豆包用自身系统提示。开启后原样转发。",
          default: false,
        },
      ],
      methods: [
        {
          type: "oauth",
          label: "扫码登录豆包 CLI",
          description: "打开豆包登录二维码，用豆包 App 扫码确认。凭据由豆包 CLI 自行保管，插件不接触。",
          async authorize(_inputs, { signal } = {}) {
            try {
              const flow = await startLogin({ signal, log });
              return {
                url: "",
                instructions: flow.instructions,
                method: "auto",
                opened: true,
                async callback(_code, { signal: sig } = {}) {
                  try {
                    const st = await flow.finish(sig);
                    return { type: "success", access: "doubao-cli-local", refresh: "", accountId: "豆包 CLI · " + (st.uid || "本机账号"), name: st.uid ? "用户 " + st.uid : "豆包用户", uid: st.uid };
                  } catch (e) {
                    return { type: "failed", error: String(e.message || e).slice(0, 300) };
                  }
                },
              };
            } catch (e) {
              return { type: "failed", error: String(e.message || e).slice(0, 300) };
            }
          },
        },
        {
          type: "api",
          keyless: true,
          label: "本机已登录，直接启用（无需密钥）",
          async authorize() {
            const st = await authStatus();
            if (!st.loggedIn) return { type: "failed", error: "豆包 CLI 未登录。请改用扫码登录，或在终端运行 doubao login。" };
            return { type: "success", key: "DOUBAO_ACP_LOCAL", metadata: { email: "豆包 CLI · " + (st.uid || "本机账号") } };
          },
        },
        {
          type: "api",
          keyless: true,
          label: "退出豆包 CLI 登录（doubao logout）",
          description: "退出本机豆包 CLI 登录，并停止该账号下运行中的任务。magpie 账号卡片可用「退出」单独移除；重新启用请扫码登录。",
          async authorize(_inputs, { signal } = {}) {
            try {
              const r = await logout({ signal });
              if (r.ok) return { type: "failed", error: "✓ 已退出豆包 CLI 登录" + (r.uid ? "（用户 " + r.uid + "）" : "") + "。重新启用请扫码登录；magpie 账号可在卡片上单独移除。" };
              return { type: "failed", error: "退出未确认完成：" + (r.raw || "").slice(-200) };
            } catch (e) {
              return { type: "failed", error: String(e.message || e).slice(0, 300) };
            }
          },
        },
      ],
      async loader() {
        return {
          baseURL: ORIGIN + "/magpie/v1",
          apiKey: "MAGPIE_DOUBAO_ACP_INTERNAL",
          async fetch(input, init = {}) {
            try {
              const u = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
              if (u.origin !== ORIGIN || (u.pathname !== API_PATH && u.pathname !== RESPONSES_PATH)) throw Object.assign(new Error("本插件只接收 Chat Completions 和 Responses 请求。"), { status: 400 });
              if (init.method && init.method.toUpperCase() !== "POST") throw Object.assign(new Error("请使用 POST 请求。"), { status: 405 });
              const raw = init.body;
              if (typeof raw !== "string" && !(raw instanceof Uint8Array)) throw Object.assign(new Error("请求正文需要 JSON。"), { status: 400 });
              if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw Object.assign(new Error("请求正文超过大小限制。"), { status: 413 });
              let body;
              try { body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
              catch { throw Object.assign(new Error("请求正文 JSON 格式不正确。"), { status: 400 }); }
              return await (u.pathname === RESPONSES_PATH
                ? responsesCompletion(engine, body, init.signal)
                : engine.completion(body, init.signal));
            } catch (e) {
              return errorResponse(e);
            }
          },
        };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider) {
        try {
          const models = await engine.fetchModels();
          return models.length ? modelsView(models) : provider.models || {};
        } catch {
          return provider.models || {};
        }
      },
    },
  };
}

export default async function DoubaoAcpPlugin(input) {
  return createHooks(input);
}
export const _internal = { createHooks, modelsView, errorResponse, PROVIDER, ORIGIN };
