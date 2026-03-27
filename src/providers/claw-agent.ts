import { agent } from "claw-agent-sdk";
import { createLogger } from "../logger.js";
import type { Provider, ProviderConfig, ProviderOptions, ProviderResponse } from "../types.js";

const log = createLogger("claw-agent");

/**
 * Claw Agent Provider — 通过 claw-agent-sdk 让任何模型获得 Agent 能力
 * 替代 openai-compatible，内置搜索、文件操作等工具
 */
export class ClawAgentProvider implements Provider {
  readonly name: string;
  private config: ProviderConfig;

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    this.config = config;
  }

  async query(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): Promise<string> {
    const apiKey = this.config.apiKey || process.env[(this.config.apiKeyEnv as string) || ""] || "";
    if (!apiKey) {
      throw new Error(`${this.name}: API Key 未设置`);
    }

    const model = options?.model || (this.config.model as string);
    log.info(`Querying ${this.name} (model: ${model}, session: ${sessionId.slice(0, 8)}...)`);

    // 每次 query 创建新 agent 以确保最新配置
    const ai = agent({
      provider: {
        baseUrl: this.config.baseUrl as string,
        apiKey,
        model,
      },
      tools: true,
      maxTurns: 10,
      maxTokens: (options?.maxTokens as number) || (this.config.maxTokens as number) || 4096,
      systemPrompt: options?.systemPrompt || (this.config.systemPrompt as string) || undefined,
      cwd: options?.cwd || process.cwd(),
    });

    const result = await ai.run(prompt);

    // 打印工具调用日志
    for (const step of result.steps) {
      log.info(`工具调用: ${step.tool}(${JSON.stringify(step.input).slice(0, 100)}) [${step.duration}ms]`);
    }

    if (result.usage.totalTokens > 0) {
      log.info(`Tokens: ${result.usage.promptTokens} in / ${result.usage.completionTokens} out`);
    }
    log.info(`Response: ${result.text.length} chars, ${result.steps.length} tool calls, ${result.duration}ms`);

    return result.text;
  }

  async *stream(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): AsyncIterable<ProviderResponse> {
    const apiKey = this.config.apiKey || process.env[(this.config.apiKeyEnv as string) || ""] || "";
    if (!apiKey) {
      throw new Error(`${this.name}: API Key 未设置`);
    }

    const model = options?.model || (this.config.model as string);
    log.info(`Streaming ${this.name} (model: ${model}, session: ${sessionId.slice(0, 8)}...)`);

    const ai = agent({
      provider: {
        baseUrl: this.config.baseUrl as string,
        apiKey,
        model,
      },
      tools: true,
      maxTurns: 10,
      maxTokens: (options?.maxTokens as number) || (this.config.maxTokens as number) || 4096,
      systemPrompt: options?.systemPrompt || (this.config.systemPrompt as string) || undefined,
      cwd: options?.cwd || process.cwd(),
    });

    for await (const chunk of ai.stream(prompt)) {
      if (chunk.type === "text" && chunk.text) {
        yield { text: chunk.text, done: false };
      }
      if (chunk.type === "tool_start") {
        log.info(`工具调用: ${chunk.tool}`);
      }
      if (chunk.type === "tool_end" && chunk.step) {
        log.info(`工具完成: ${chunk.tool} [${chunk.step.duration}ms]`);
      }
      if (chunk.type === "done") {
        yield { text: "", done: true };
      }
    }
  }
}
