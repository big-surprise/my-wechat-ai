import { createLogger } from "../logger.js";
import type { Provider, ProviderOptions, ProviderConfig, ToolConfig } from "../types.js";

const log = createLogger("claude");

const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"];

/** Strip smart quotes, BOM, and whitespace that Windows clipboard may inject into API keys */
function sanitizeKey(key: string): string {
  return key.replace(/[\u200B-\u200D\uFEFF\u201C\u201D\u2018\u2019\u00AB\u00BB"']/g, "").trim();
}

export class ClaudeAgentProvider implements Provider {
  readonly name = "claude-agent";
  private config: ProviderConfig;
  private toolConfig?: ToolConfig;
  private sessions = new Map<string, string>(); // userId -> sessionId

  constructor(config: ProviderConfig, toolConfig?: ToolConfig) {
    this.config = config;
    this.toolConfig = toolConfig;
  }

  async query(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Use project-configured API key if available, otherwise SDK falls back to ~/.claude
    const rawKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (rawKey) {
      process.env.ANTHROPIC_API_KEY = sanitizeKey(rawKey);
    }

    const allowedTools = options?.allowedTools
      || (this.config.allowedTools as string[])
      || DEFAULT_TOOLS;

    const existingSession = this.sessions.get(sessionId);
    const sdkOptions: Record<string, unknown> = {
      allowedTools,
      permissionMode: "acceptEdits" as const,
    };

    if (options?.maxTokens) {
      sdkOptions.maxTokens = options.maxTokens;
    }

    if (options?.cwd) {
      sdkOptions.cwd = options.cwd;
    }

    // Resume existing session for conversation continuity
    if (existingSession) {
      sdkOptions.resume = existingSession;
    }

    if (options?.systemPrompt) {
      sdkOptions.systemPrompt = options.systemPrompt;
    }

    // Pass tool configuration from config file
    if (this.toolConfig) {
      sdkOptions.toolConfig = this.toolConfig;
    }

    log.info(`Querying Claude (session: ${sessionId.slice(0, 8)}...)`);

    let result = "";
    let newSessionId: string | undefined;

    try {
      for await (const message of query({
        prompt,
        options: sdkOptions as any,
      })) {
        // Capture session ID from init message
        if (isInitMessage(message)) {
          newSessionId = message.session_id;
        }

        // Capture result text
        if (isResultMessage(message)) {
          result = message.result;
        }

        // Capture assistant text messages for streaming
        if (isAssistantMessage(message)) {
          // accumulate text from assistant messages
          const textContent = extractText(message);
          if (textContent) {
            result = textContent;
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Claude query failed: ${errMsg}`);
      throw err;
    }

    // Store session for continuity
    if (newSessionId) {
      this.sessions.set(sessionId, newSessionId);
    }

    if (!result) {
      result = "(No response from Claude)";
    }

    log.info(`Response: ${result.length} chars`);
    return result;
  }
}

// ── Message type guards ──

function isInitMessage(msg: any): msg is { type: "system"; subtype: "init"; session_id: string } {
  return msg?.type === "system" && msg?.subtype === "init" && typeof msg?.session_id === "string";
}

function isResultMessage(msg: any): msg is { result: string } {
  return typeof msg?.result === "string";
}

function isAssistantMessage(msg: any): msg is { type: "assistant"; message: { content: unknown[] } } {
  return msg?.type === "assistant" && msg?.message?.content;
}

function extractText(msg: any): string | null {
  if (!msg?.message?.content) return null;
  const parts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}
