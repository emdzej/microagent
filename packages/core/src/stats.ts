import type { TokenUsage } from "./types.js";

/** Tracks cumulative token usage and timing across the session */
export class UsageStats {
  private requests = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private startTime = Date.now();
  private toolCallCount = 0;

  record(usage: TokenUsage): void {
    this.requests++;
    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
    this.totalCacheReadTokens += usage.cacheReadTokens ?? 0;
    this.totalCacheWriteTokens += usage.cacheWriteTokens ?? 0;
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
      cacheReadTokens: this.totalCacheReadTokens,
      cacheWriteTokens: this.totalCacheWriteTokens,
      toolCalls: this.toolCallCount,
      elapsedMs: Date.now() - this.startTime,
    };
  }

  format(): string {
    const s = this.summary;
    const elapsed = (s.elapsedMs / 1000).toFixed(1);
    const lines = [
      `tokens: ${s.totalTokens} (prompt: ${s.promptTokens}, completion: ${s.completionTokens})`,
    ];
    // Only shown once the provider has reported cache activity — on a provider
    // that does not cache, a permanent "cache: 0/0" line is just noise.
    if (s.cacheReadTokens || s.cacheWriteTokens) {
      lines.push(`cache: ${s.cacheReadTokens} read, ${s.cacheWriteTokens} written`);
    }
    lines.push(
      `requests: ${s.requests} | tool calls: ${s.toolCalls} | elapsed: ${elapsed}s`
    );
    return lines.join("\n");
  }
}
