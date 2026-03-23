import { createLogger } from "./logger.js";
import type {
  Channel,
  Provider,
  InboundMessage,
  WaiConfig,
  ProviderOptions,
} from "./types.js";
import { WeixinChannel } from "./channels/weixin.js";
import { ClaudeAgentProvider } from "./providers/claude-agent.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

const log = createLogger("网关");

const DEBOUNCE_MS = 1500;

interface MessageBuffer {
  messages: InboundMessage[];
  timer: ReturnType<typeof setTimeout>;
}

export class Gateway {
  private channels = new Map<string, Channel>();
  private providers = new Map<string, Provider>();
  private config: WaiConfig;
  // Debounce buffer: accumulates messages within DEBOUNCE_MS window
  private buffers = new Map<string, MessageBuffer>();
  // Whether AI is currently processing for a given user
  private processing = new Set<string>();
  // Queue for messages that arrive while AI is processing
  private queues = new Map<string, InboundMessage[]>();

  constructor(config: WaiConfig) {
    this.config = config;
  }

  init(): void {
    for (const [name, chConfig] of Object.entries(this.config.channels)) {
      if (chConfig.enabled === false) continue;
      switch (chConfig.type) {
        case "weixin":
          this.channels.set(name, new WeixinChannel(chConfig));
          break;
        default:
          log.warn(`未知渠道类型: ${chConfig.type}`);
      }
    }

    for (const [name, provConfig] of Object.entries(this.config.providers)) {
      switch (provConfig.type) {
        case "claude-agent":
          this.providers.set(name, new ClaudeAgentProvider(provConfig));
          break;
        case "openai-compatible":
          this.providers.set(name, new OpenAICompatibleProvider(name, provConfig));
          break;
        default:
          log.warn(`未知模型类型: ${provConfig.type}`);
      }
    }

    log.info(`已初始化 ${this.channels.size} 个渠道, ${this.providers.size} 个模型`);
  }

  async login(channelName: string): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`渠道 "${channelName}" 不存在`);
    }
    await channel.login();
  }

  async start(): Promise<void> {
    if (this.providers.size === 0) {
      throw new Error("未配置任何模型");
    }

    const startPromises = [...this.channels.entries()].map(([name, channel]) => {
      log.info(`启动渠道: ${name}`);
      return channel.start((msg) => this.handleMessage(msg)).catch((err) => {
        log.error(`渠道 ${name} 异常: ${err instanceof Error ? err.message : err}`);
      });
    });

    await Promise.all(startPromises);
  }

  async stop(): Promise<void> {
    log.info("正在关闭...");
    const stops = [...this.channels.values()].map((ch) => ch.stop());
    await Promise.allSettled(stops);
    log.info("已关闭");
  }

  private handleMessage(msg: InboundMessage): void {
    // Commands bypass debounce, execute immediately
    if (msg.text.startsWith("/")) {
      this.handleCommand(msg);
      return;
    }

    const key = `${msg.channel}:${msg.senderId}`;

    // If AI is processing, queue the message
    if (this.processing.has(key)) {
      const queue = this.queues.get(key) || [];
      queue.push(msg);
      this.queues.set(key, queue);
      log.info(`消息已排队 (AI处理中), 队列长度: ${queue.length}`);
      return;
    }

    // Debounce: accumulate messages within time window
    const existing = this.buffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = setTimeout(() => this.flushBuffer(key), DEBOUNCE_MS);
    } else {
      this.buffers.set(key, {
        messages: [msg],
        timer: setTimeout(() => this.flushBuffer(key), DEBOUNCE_MS),
      });
    }
  }

  private async flushBuffer(key: string): Promise<void> {
    const buf = this.buffers.get(key);
    if (!buf || buf.messages.length === 0) return;
    this.buffers.delete(key);

    // Merge all buffered messages into one
    const merged = this.mergeMessages(buf.messages);
    await this.processMessage(merged);

    // After processing, check if there are queued messages
    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      this.queues.delete(key);
      // Feed queued messages back through debounce
      for (const msg of queue) {
        this.handleMessage(msg);
      }
    }
  }

  private mergeMessages(messages: InboundMessage[]): InboundMessage {
    if (messages.length === 1) return messages[0]!;

    const last = messages[messages.length - 1]!;
    const mergedText = messages.map((m) => m.text).join("\n");
    log.info(`合并 ${messages.length} 条消息`);

    return { ...last, text: mergedText };
  }

  private async processMessage(msg: InboundMessage): Promise<void> {
    const key = `${msg.channel}:${msg.senderId}`;
    this.processing.add(key);

    try {
      const providerName = this.config.userRoutes?.[msg.senderId]
        || this.config.defaultProvider;
      const provider = this.providers.get(providerName);

      if (!provider) {
        log.error(`模型 "${providerName}" 未找到`);
        return;
      }

      log.info(`调用 ${providerName} 处理中...`);

      const channel = this.channels.get(msg.channel);
      if (channel && "sendTyping" in channel) {
        (channel as any).sendTyping(msg.senderId, msg.replyToken);
      }

      const options: ProviderOptions = {};
      if (this.config.systemPrompt) {
        options.systemPrompt = this.config.systemPrompt;
      }

      const sessionKey = `${msg.channel}:${msg.senderId}`;
      const response = await provider.query(msg.text, sessionKey, options);

      if (!channel) return;

      await channel.send({
        targetId: msg.senderId,
        text: response,
        replyToken: msg.replyToken,
      });

      log.info(`已回复 (${response.length} 字符)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`处理消息失败: ${errMsg}`);

      try {
        const channel = this.channels.get(msg.channel);
        if (channel) {
          await channel.send({
            targetId: msg.senderId,
            text: `[出错了] 处理消息失败，请重试。`,
            replyToken: msg.replyToken,
          });
        }
      } catch {
        // swallow
      }
    } finally {
      this.processing.delete(key);
    }
  }

  private async handleCommand(msg: InboundMessage): Promise<void> {
    const channel = this.channels.get(msg.channel);
    if (!channel) return;

    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0]!.toLowerCase();
    const arg = parts[1];

    switch (cmd) {
      case "/model": {
        if (!arg) {
          const current = this.config.userRoutes?.[msg.senderId] || this.config.defaultProvider;
          const available = [...this.providers.keys()].join(", ");
          await channel.send({
            targetId: msg.senderId,
            text: `当前模型: ${current}\n可用模型: ${available}\n用法: /model <名称>`,
            replyToken: msg.replyToken,
          });
        } else if (this.providers.has(arg.toLowerCase())) {
          const provider = arg.toLowerCase();
          if (!this.config.userRoutes) this.config.userRoutes = {};
          this.config.userRoutes[msg.senderId] = provider;
          await channel.send({
            targetId: msg.senderId,
            text: `已切换到: ${provider}`,
            replyToken: msg.replyToken,
          });
        } else {
          await channel.send({
            targetId: msg.senderId,
            text: `未知模型: ${arg}\n可用: ${[...this.providers.keys()].join(", ")}`,
            replyToken: msg.replyToken,
          });
        }
        break;
      }

      case "/help": {
        await channel.send({
          targetId: msg.senderId,
          text: [
            "wechat-ai 指令:",
            "/model [名称] - 切换AI模型",
            "/help - 显示帮助",
            "/ping - 检查状态",
          ].join("\n"),
          replyToken: msg.replyToken,
        });
        break;
      }

      case "/ping": {
        await channel.send({
          targetId: msg.senderId,
          text: `pong (${Date.now() - msg.timestamp}ms)`,
          replyToken: msg.replyToken,
        });
        break;
      }

      default: {
        await channel.send({
          targetId: msg.senderId,
          text: `未知指令: ${cmd}，试试 /help`,
          replyToken: msg.replyToken,
        });
      }
    }
  }
}
