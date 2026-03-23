import { createLogger } from "../logger.js";
import type { Provider, ProviderOptions, ProviderConfig } from "../types.js";

const log = createLogger("openai-compat");

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const MAX_TOOL_ROUNDS = 10;

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  private config: ProviderConfig;
  private histories = new Map<string, ChatMessage[]>();

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    this.config = config;
  }

  async query(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): Promise<string> {
    const baseUrl = this.config.baseUrl;
    const apiKey = this.config.apiKey || process.env[this.config.apiKeyEnv as string || ""];
    const model = options?.model || (this.config.model as string);

    if (!baseUrl) throw new Error(`${this.name}: baseUrl is required`);
    if (!apiKey) throw new Error(`${this.name}: apiKey is required`);
    if (!model) throw new Error(`${this.name}: model is required`);

    // Build conversation history
    let history = this.histories.get(sessionId);
    if (!history) {
      history = [];
      this.histories.set(sessionId, history);
    }

    const messages: ChatMessage[] = [];

    // System prompt
    const systemPrompt = options?.systemPrompt || (this.config.systemPrompt as string);
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    // Conversation history (keep last N turns)
    const maxHistory = (this.config.maxHistory as number) || 20;
    const recentHistory = history.slice(-maxHistory);
    messages.push(...recentHistory);

    // Current user message (with optional images)
    const images = options?.media?.filter((m) => m.type === "image" && m.url) || [];
    if (images.length > 0) {
      const parts: ContentPart[] = [];
      if (prompt && prompt !== "[媒体消息]") {
        parts.push({ type: "text", text: prompt });
      } else {
        parts.push({ type: "text", text: "请描述这张图片" });
      }
      for (const img of images) {
        parts.push({ type: "image_url", image_url: { url: img.url! } });
      }
      messages.push({ role: "user", content: parts });
      log.info(`附带 ${images.length} 张图片`);
    } else {
      messages.push({ role: "user", content: prompt });
    }

    log.info(`Querying ${this.name} (model: ${model}, session: ${sessionId.slice(0, 8)}...)`);

    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const tools = options?.mcpTools;
    const callTool = options?.mcpCallTool;
    const hasTools = tools && tools.length > 0 && callTool;

    // Tool calling loop
    let reply = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: options?.maxTokens || (this.config.maxTokens as number) || 4096,
        temperature: (this.config.temperature as number) ?? 0.7,
      };

      if (hasTools) {
        body.tools = tools;
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        log.error(`${this.name} API error ${res.status}: ${errBody.slice(0, 200)}`);
        throw new Error(`${this.name} API error: ${res.status}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      const choice = data.choices[0];
      if (!choice) throw new Error(`${this.name}: empty response`);

      if (data.usage) {
        log.info(`Tokens: ${data.usage.prompt_tokens} in / ${data.usage.completion_tokens} out`);
      }

      const assistantMsg = choice.message;

      // If no tool calls, we're done
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0 || !callTool) {
        reply = (typeof assistantMsg.content === "string" ? assistantMsg.content : null) || "(No response)";
        break;
      }

      // Add assistant message with tool calls to messages
      messages.push({
        role: "assistant",
        content: assistantMsg.content,
        tool_calls: assistantMsg.tool_calls,
      });

      // Execute each tool call
      for (const tc of assistantMsg.tool_calls) {
        const fnName = tc.function.name;
        let fnArgs: Record<string, unknown>;
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch {
          fnArgs = {};
        }

        log.info(`工具调用: ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);

        let toolResult: string;
        try {
          toolResult = await callTool(fnName, fnArgs);
        } catch (err) {
          toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
          log.error(`工具调用失败: ${fnName} — ${toolResult}`);
        }

        messages.push({
          role: "tool",
          content: toolResult,
          tool_call_id: tc.id,
        });
      }

      // Continue loop — send tool results back to model
      log.info(`工具调用完成 (round ${round + 1}), 继续处理...`);
    }

    // Update history (only user message and final reply, not tool calls)
    history.push({ role: "user", content: prompt });
    history.push({ role: "assistant", content: reply });

    log.info(`Response: ${reply.length} chars`);
    return reply;
  }
}
