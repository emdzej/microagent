import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Agent, StreamDelta, ToolResult, MicroagentConfig } from "@microagent/core";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveImage } from "../util/resolve-image.js";

interface Props {
  agent: Agent;
  configPath: string | null;
}

interface OutputLine {
  type: "user" | "assistant" | "tool" | "error" | "info";
  text: string;
}

export const Chat: React.FC<Props> = ({ agent, configPath }) => {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<OutputLine[]>([
    { type: "info", text: `microagent v0.1.0 — ${agent.provider.name}/${agent.provider.currentModel} — providers: ${agent.providerNames.join(", ")}` },
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
        addLine({ type: "info", text: "Fetching models from all providers..." });
        try {
          const models = await agent.listAllModels();
          if (!models.length) {
            addLine({ type: "info", text: "No models found." });
          } else {
            // Group by provider
            const grouped = new Map<string, string[]>();
            for (const m of models) {
              const list = grouped.get(m.provider) ?? [];
              list.push(m.id);
              grouped.set(m.provider, list);
            }
            for (const [prov, ids] of grouped) {
              const active = prov === agent.provider.name ? " (active)" : "";
              addLine({ type: "info", text: `\n  ${prov}${active}:` });
              for (const id of ids) {
                const current = prov === agent.provider.name && id === agent.provider.currentModel ? " ←" : "";
                addLine({ type: "info", text: `    ${prov}/${id}${current}` });
              }
            }
            addLine({ type: "info", text: `\n${models.length} model(s) across ${grouped.size} provider(s).` });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLine({ type: "error", text: `Failed to list models: ${msg}` });
        }
        return;
      }
      // /model <provider/model> or /model <model> — switch the active model
      if (value.trim().startsWith("/model ")) {
        const spec = value.trim().slice(7).trim();
        if (!spec) {
          addLine({ type: "info", text: `Current: ${agent.provider.name}/${agent.provider.currentModel}` });
          return;
        }
        try {
          const { provider: provName, model: newModel } = agent.setModel(spec);
          addLine({ type: "info", text: `Switched to ${provName}/${newModel}` });
          // Persist to config file if available
          if (configPath) {
            try {
              const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) as MicroagentConfig : {} as MicroagentConfig;
              if (raw.providers?.length) {
                const pc = raw.providers.find((p) => (p.name ?? p.type) === provName || p.type === provName);
                if (pc) pc.model = newModel;
                raw.activeProvider = provName;
              } else if (raw.provider) {
                raw.provider.model = newModel;
              }
              mkdirSync(dirname(configPath), { recursive: true });
              writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
              addLine({ type: "info", text: `Config saved to ${configPath}` });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              addLine({ type: "error", text: `Failed to save config: ${msg}` });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLine({ type: "error", text: msg });
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
