import type { TokenUsage } from "./types.js";

/** Tracks cumulative token usage and timing across the session */
export class UsageStats {
  private requests = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;
  private startTime = Date.now();
  private toolCallCount = 0;

  record(usage: TokenUsage): void {
    this.requests++;
    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
  }

  recordToolCall(): void {
    this.toolCallCount++;
  }

  get summary() {
    return {
      requests: this.requests,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      totalTokens: this.totalTokens,
      toolCalls: this.toolCallCount,
      elapsedMs: Date.now() - this.startTime,
    };
  }

  format(): string {
    const s = this.summary;
    const elapsed = (s.elapsedMs / 1000).toFixed(1);
    return [
      `tokens: ${s.totalTokens} (prompt: ${s.promptTokens}, completion: ${s.completionTokens})`,
      `requests: ${s.requests} | tool calls: ${s.toolCalls} | elapsed: ${elapsed}s`,
    ].join("\n");
  }
}
