import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Agent, StreamDelta, ToolResult, MicroagentConfig } from "@microagent/core";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

interface Props {
  agent: Agent;
  configPath: string | null;
}

interface OutputLine {
  type: "user" | "assistant" | "tool" | "error" | "info";
  text: string;
}

/** Read a local file and return a data URI, or return a URL as-is */
function resolveImage(input: string): string | null {
  // Already a URL
  if (input.startsWith("http://") || input.startsWith("https://") || input.startsWith("data:")) {
    return input;
  }
  // Local file — read and convert to base64 data URI
  const abs = resolve(input);
  if (!existsSync(abs)) return null;
  const buf = readFileSync(abs);
  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  const mime =
    ext === "png" ? "image/png"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp"
    : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export const Chat: React.FC<Props> = ({ agent, configPath }) => {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<OutputLine[]>([
    { type: "info", text: `microagent v0.1.0 — provider: ${agent.provider.name} — model: ${agent.provider.currentModel}` },
    { type: "info", text: `tools: ${agent.tools.list().join(", ") || "(none)"}` },
    { type: "info", text: 'Type your message. Press Ctrl+C to exit. Commands: /stats /tools /models /model /image /quit\n' },
  ]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);

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
      // /model <name> — switch the active model
      if (value.trim().startsWith("/model ")) {
        const newModel = value.trim().slice(7).trim();
        if (!newModel) {
          addLine({ type: "info", text: `Current model: ${agent.provider.currentModel}` });
          return;
        }
        agent.setModel(newModel);
        addLine({ type: "info", text: `Switched to model: ${newModel}` });
        // Persist to config file if available
        if (configPath) {
          try {
            const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) as MicroagentConfig : {} as MicroagentConfig;
            raw.provider = { ...raw.provider, model: newModel };
            mkdirSync(dirname(configPath), { recursive: true });
            writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
            addLine({ type: "info", text: `Config saved to ${configPath}` });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addLine({ type: "error", text: `Failed to save config: ${msg}` });
          }
        }
        return;
      }
      if (value.trim() === "/quit" || value.trim() === "/exit") {
        exit();
        return;
      }
      // /image <path-or-url> — queue an image for the next message
      if (value.trim().startsWith("/image ")) {
        const arg = value.trim().slice(7).trim();
        if (!arg) {
          addLine({ type: "error", text: "Usage: /image <file-path-or-url>" });
          return;
        }
        const url = resolveImage(arg);
        if (!url) {
          addLine({ type: "error", text: `File not found: ${arg}` });
          return;
        }
        setPendingImages((prev) => [...prev, url]);
        const isLocal = !arg.startsWith("http");
        addLine({ type: "info", text: `Image queued${isLocal ? ` (${arg})` : ""}. Type your message to send with the image.` });
        return;
      }

      addLine({ type: "user", text: pendingImages.length ? `${value} [+${pendingImages.length} image(s)]` : value });
      setBusy(true);
      setStreaming("");

      try {
        const images = pendingImages.length ? [...pendingImages] : undefined;
        setPendingImages([]);
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
        }, images);

        addLine({ type: "assistant", text: response });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLine({ type: "error", text: `Error: ${msg}` });
      } finally {
        setBusy(false);
        setStreaming("");
      }
    },
    [agent, addLine, exit, pendingImages, configPath]
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
