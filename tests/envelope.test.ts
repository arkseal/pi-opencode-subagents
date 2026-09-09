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
});
