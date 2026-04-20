import { describe, it, expect } from "vitest";
import { UsageStats } from "../src/stats.js";

describe("UsageStats", () => {
  it("tracks token usage", () => {
    const stats = new UsageStats();
    stats.record({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    stats.record({ promptTokens: 200, completionTokens: 80, totalTokens: 280 });
    stats.recordToolCall();

    const s = stats.summary;
    expect(s.requests).toBe(2);
    expect(s.promptTokens).toBe(300);
    expect(s.completionTokens).toBe(130);
    expect(s.totalTokens).toBe(430);
    expect(s.toolCalls).toBe(1);
    expect(s.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("formats stats as string", () => {
    const stats = new UsageStats();
    stats.record({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    const formatted = stats.format();
    expect(formatted).toContain("tokens: 15");
    expect(formatted).toContain("requests: 1");
  });
});
