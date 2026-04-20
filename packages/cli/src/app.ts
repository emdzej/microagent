import React from "react";
import { render } from "ink";
import { Agent } from "@microagent/core";
import type { MicroagentConfig } from "@microagent/core";
import { Chat } from "./components/Chat.js";
import { registerBuiltinTools } from "./tools/index.js";

export async function startChat(config: MicroagentConfig): Promise<void> {
  const agent = new Agent(config);
  registerBuiltinTools(agent.tools);
  await agent.init(config.mcpServers);

  const { waitUntilExit } = render(React.createElement(Chat, { agent }));

  await waitUntilExit();
  await agent.shutdown();
}
