// In dev mode (Vite proxy), use /api prefix. In production (static serving), routes are at root.
const BASE = import.meta.env.DEV ? "/api" : "";

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "error";
  content: string;
}

export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface Stats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  elapsedMs: number;
}

export interface StreamCallbacks {
  onText: (text: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, content: string, isError?: boolean) => void;
  onComplete: (response: string, stats: Stats) => void;
  onError: (error: string) => void;
}

export async function fetchHealth() {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}

export async function fetchTools() {
  const res = await fetch(`${BASE}/tools`);
  return (await res.json()).tools as Array<{ name: string; description: string }>;
}

export async function fetchStats(): Promise<Stats> {
  const res = await fetch(`${BASE}/stats`);
  return res.json();
}

export function streamChat(message: string, callbacks: StreamCallbacks): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok) {
        callbacks.onError(`HTTP ${res.status}: ${await res.text()}`);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            const data = JSON.parse(line.slice(6));
            switch (eventType) {
              case "delta":
                if (data.type === "text" && data.text) callbacks.onText(data.text);
                break;
              case "tool_call":
                callbacks.onToolCall(data.name, data.args);
                break;
              case "tool_result":
                callbacks.onToolResult(data.name, data.content, data.isError);
                break;
              case "complete":
                callbacks.onComplete(data.response, data.stats);
                break;
              case "error":
                callbacks.onError(data.error);
                break;
            }
            eventType = "";
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        callbacks.onError((err as Error).message);
      }
    }
  })();

  return () => controller.abort();
}
