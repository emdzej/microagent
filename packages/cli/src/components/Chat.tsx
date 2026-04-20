import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Agent, StreamDelta, ToolResult } from "@microagent/core";

interface Props {
  agent: Agent;
}

interface OutputLine {
  type: "user" | "assistant" | "tool" | "error" | "info";
  text: string;
}

export const Chat: React.FC<Props> = ({ agent }) => {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<OutputLine[]>([
    { type: "info", text: `microagent v0.1.0 — provider: ${agent.provider.name}` },
    { type: "info", text: `tools: ${agent.tools.list().join(", ") || "(none)"}` },
    { type: "info", text: 'Type your message. Press Ctrl+C to exit. Commands: /stats /tools /models /quit\n' },
  ]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);

  const addLine = useCallback((line: OutputLine) => {
    setOutput((prev) => [...prev, line]);
  }, []);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      setInput("");

      if (value.trim() === "/stats") {
        addLine({ type: "info", text: agent.stats.format() });
        return;
      }
      if (value.trim() === "/tools") {
        const tools = agent.tools.list();
        addLine({ type: "info", text: `Registered tools (${tools.length}): ${tools.join(", ")}` });
        return;
      }
      if (value.trim() === "/models") {
        addLine({ type: "info", text: "Fetching models..." });
        try {
          const models = await agent.provider.listModels();
          if (!models.length) {
            addLine({ type: "info", text: "No models found." });
          } else {
            addLine({ type: "info", text: `Available models (${models.length}):` });
            for (const m of models) {
              addLine({ type: "info", text: `  ${m.id}` });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLine({ type: "error", text: `Failed to list models: ${msg}` });
        }
        return;
      }
      if (value.trim() === "/quit" || value.trim() === "/exit") {
        exit();
        return;
      }

      addLine({ type: "user", text: value });
      setBusy(true);
      setStreaming("");

      try {
        const response = await agent.run(value, {
          onDelta: (delta: StreamDelta) => {
            if (delta.type === "text" && delta.text) {
              setStreaming((prev) => prev + delta.text);
            }
            if (delta.type === "done") {
              setStreaming("");
            }
          },
          onToolCall: (name: string, _args: Record<string, unknown>) => {
            addLine({ type: "tool", text: `→ calling ${name}` });
          },
          onToolResult: (name: string, result: ToolResult) => {
            const preview = result.content.slice(0, 200);
            const suffix = result.content.length > 200 ? "..." : "";
            addLine({
              type: result.isError ? "error" : "tool",
              text: `← ${name}: ${preview}${suffix}`,
            });
          },
        });

        addLine({ type: "assistant", text: response });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLine({ type: "error", text: `Error: ${msg}` });
      } finally {
        setBusy(false);
        setStreaming("");
      }
    },
    [agent, addLine, exit]
  );

  return (
    <Box flexDirection="column" padding={1}>
      {/* Output history */}
      {output.map((line, i) => (
        <Box key={i}>
          <Text
            color={
              line.type === "user"
                ? "cyan"
                : line.type === "assistant"
                  ? "green"
                  : line.type === "tool"
                    ? "yellow"
                    : line.type === "error"
                      ? "red"
                      : "gray"
            }
          >
            {line.type === "user" ? "▸ " : line.type === "assistant" ? "◂ " : "  "}
            {line.text}
          </Text>
        </Box>
      ))}

      {/* Streaming output */}
      {streaming && (
        <Box>
          <Text color="green" dimColor>
            ◂ {streaming}▊
          </Text>
        </Box>
      )}

      {/* Input */}
      <Box marginTop={1}>
        <Text color={busy ? "gray" : "blue"} bold>
          {busy ? "⟳ " : "❯ "}
        </Text>
        {busy ? (
          <Text dimColor>thinking...</Text>
        ) : (
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
        )}
      </Box>

      {/* Status bar */}
      <Box marginTop={1}>
        <Text dimColor>
          tokens: {agent.stats.summary.totalTokens} | calls: {agent.stats.summary.toolCalls} |{" "}
          reqs: {agent.stats.summary.requests}
        </Text>
      </Box>
    </Box>
  );
};
