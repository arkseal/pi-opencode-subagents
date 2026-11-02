import { describe, expect, it } from "bun:test";
import { getSubagentDir, getSubagentSessionsDir } from "../src/runner";
import * as fs from "node:fs";

describe("Subagent Runner Configuration", () => {
  it("resolves and creates subagent directories and session storage", () => {
    const dir = getSubagentDir();
    expect(fs.existsSync(dir)).toBe(true);

    const sessionsDir = getSubagentSessionsDir();
    expect(fs.existsSync(sessionsDir)).toBe(true);
    expect(sessionsDir).toContain("sessions");
  });

  it("formats subagent completion envelope with stats and transcript link", () => {
    const { formatSubagentEnvelope } = require("../src/envelope");
    const envelope = formatSubagentEnvelope({
      id: "sub_test1",
      sessionID: "sub_test1",
      status: "completed",
      durationMs: 2500,
      summary: "Found 5 matches in codebase.",
      stats: {
        totalTokens: 1200,
        tokensIn: 1000,
        tokensOut: 200,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.005,
        toolCalls: 3,
        turns: 2,
      },
      logFilePath: "/tmp/sub_test1.log",
    });

    expect(envelope).toContain('<subagent sessionID="sub_test1" state="completed" duration="2.5s"');
    expect(envelope).toContain("Found 5 matches in codebase.");
    expect(envelope).toContain("Stats: 1.0k in · 200 out · 3 tools · $0.005");
    expect(envelope).toContain("Full transcript: /tmp/sub_test1.log");
    expect(envelope).toContain("</subagent>");
  });

  it("defaults to non-blocking background mode when background is omitted", async () => {
    const { executeSubagent, stopSubagent } = require("../src/runner");
    const result = await executeSubagent({
      task: "Echo test default background",
      cwd: process.cwd(),
      isolated: false,
    });

    expect(result.details.background).toBe(true);
    expect(result.details.status).toBe("running");
    expect(result.output).toContain("working in the background");

    // Clean up process
    stopSubagent(result.details.id);
  });
});
