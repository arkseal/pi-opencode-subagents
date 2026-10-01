import { describe, expect, it } from "bun:test";
import { formatTaskResultEnvelope, truncateToBudget } from "../src/envelope";

describe("Subagent Task Result Envelope", () => {
  it("wraps clean concise output in structured XML envelope", () => {
    const envelope = formatTaskResultEnvelope({
      id: "agent-a123",
      status: "completed",
      durationMs: 4500,
      summary: "Found 2 unused dependencies in package.json and removed them.",
      logFilePath: "/tmp/pi-subagents/agent-a123.log",
    });

    expect(envelope).toContain('<task-result id="agent-a123" status="completed" duration="4.5s">');
    expect(envelope).toContain("Found 2 unused dependencies");
    expect(envelope).toContain("Full transcript: /tmp/pi-subagents/agent-a123.log");
    expect(envelope).toContain("</task-result>");
  });

  it("truncates oversized output to preserve parent context budget", () => {
    const hugeOutput = "A".repeat(8000);
    const truncated = truncateToBudget(hugeOutput, 500);

    expect(truncated.length).toBeLessThanOrEqual(550);
    expect(truncated).toContain("[Output truncated to fit context budget]");
  });

  it("includes stats attributes and summary in the envelope when stats are available", () => {
    const envelope = formatTaskResultEnvelope({
      id: "agent-stats-env",
      status: "completed",
      durationMs: 3200,
      summary: "Refactored module successfully",
      stats: {
        tokensIn: 4500,
        tokensOut: 320,
        cacheRead: 12000,
        cacheWrite: 0,
        totalTokens: 16820,
        cost: 0.008,
        toolCalls: 3,
        turns: 2,
      },
    });

    expect(envelope).toContain('tokens_in="4500"');
    expect(envelope).toContain('tokens_out="320"');
    expect(envelope).toContain('cache_read="12000"');
    expect(envelope).toContain('tool_calls="3"');
    expect(envelope).toContain("Stats: 4.5k in · 320 out · 12.0k cache · 3 tools · $0.008");
  });
});
