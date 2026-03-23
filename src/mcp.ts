import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "./logger.js";
import type { McpServerConfig } from "./types.js";

const log = createLogger("mcp");

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Which MCP server provides this tool */
  serverName: string;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  tools: McpTool[];
}

export class McpManager {
  private connections = new Map<string, McpConnection>();

  async connect(servers: Record<string, McpServerConfig>): Promise<void> {
    const connectPromises = Object.entries(servers).map(async ([name, config]) => {
      try {
        await this.connectServer(name, config);
        log.info(`MCP 服务器已连接: ${name} (${config.transport || "stdio"})`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`MCP 服务器连接失败: ${name} — ${errMsg}`);
      }
    });
    await Promise.all(connectPromises);
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
    const transportType = config.transport || "stdio";

    if (transportType === "stdio") {
      if (!config.command) throw new Error(`MCP server "${name}": command is required for stdio`);
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env as Record<string, string> | undefined,
      });
    } else if (transportType === "sse") {
      if (!config.url) throw new Error(`MCP server "${name}": url is required for sse`);
      transport = new SSEClientTransport(new URL(config.url));
    } else if (transportType === "streamable-http") {
      if (!config.url) throw new Error(`MCP server "${name}": url is required for streamable-http`);
      transport = new StreamableHTTPClientTransport(new URL(config.url));
    } else {
      throw new Error(`MCP server "${name}": unknown transport "${transportType}"`);
    }

    const client = new Client(
      { name: "wechat-ai", version: "0.1.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    // Discover tools
    const toolsResult = await client.listTools();
    const tools: McpTool[] = (toolsResult.tools || []).map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema as Record<string, unknown>,
      serverName: name,
    }));

    log.info(`${name}: 发现 ${tools.length} 个工具`);

    this.connections.set(name, { client, transport, tools });
  }

  /** Get all available tools across all connected servers */
  getTools(): McpTool[] {
    const allTools: McpTool[] = [];
    for (const conn of this.connections.values()) {
      allTools.push(...conn.tools);
    }
    return allTools;
  }

  /** Convert MCP tools to OpenAI function calling format */
  getOpenAITools(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    return this.getTools().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  /** Call a tool by name */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Find which server has this tool
    for (const [, conn] of this.connections) {
      const tool = conn.tools.find((t) => t.name === toolName);
      if (tool) {
        const result = await conn.client.callTool({ name: toolName, arguments: args });
        // Extract text from result content
        const texts: string[] = [];
        if (Array.isArray(result.content)) {
          for (const item of result.content) {
            if (item.type === "text" && typeof item.text === "string") {
              texts.push(item.text);
            }
          }
        }
        return texts.join("\n") || JSON.stringify(result.content);
      }
    }
    throw new Error(`MCP tool "${toolName}" not found`);
  }

  async disconnect(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        await conn.client.close();
        log.info(`MCP 服务器已断开: ${name}`);
      } catch {
        // swallow
      }
    }
    this.connections.clear();
  }
}
