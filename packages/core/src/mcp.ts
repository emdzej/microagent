import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, ToolPlugin, ToolDefinition } from "./types.js";

/** Manages connections to MCP servers and exposes their tools as plugins */
export class McpManager {
  private clients = new Map<string, Client>();

  async connect(config: McpServerConfig): Promise<ToolPlugin[]> {
    const client = new Client({ name: "microagent", version: "0.1.0" });

    if (config.transport === "stdio") {
      if (!config.command) throw new Error(`MCP server "${config.name}": stdio requires command`);
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
      });
      await client.connect(transport);
    } else {
      if (!config.url) throw new Error(`MCP server "${config.name}": http requires url`);
      const transport = new StreamableHTTPClientTransport(new URL(config.url));
      await client.connect(transport);
    }

    this.clients.set(config.name, client);

    const { tools } = await client.listTools();
    return tools.map((tool): ToolPlugin => ({
      definition: {
        name: `${config.name}__${tool.name}`,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
      },
      execute: async (args) => {
        const result = await client.callTool({ name: tool.name, arguments: args });
        if (result.isError) {
          throw new Error(
            (result.content as Array<{ text?: string }>)
              .map((c) => c.text ?? "")
              .join("\n")
          );
        }
        return (result.content as Array<{ text?: string }>)
          .map((c) => c.text ?? "")
          .join("\n");
      },
    }));
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close().catch(() => {});
    }
    this.clients.clear();
  }
}
