import { describe, expect, it } from "bun:test";
import { getSubagentDir, getSubagentSessionsDir, buildPiArgs } from "../src/runner";
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

describe("buildPiArgs", () => {
  it("builds default CLI args for standard subagent task", () => {
    const args = buildPiArgs({ task: "Write tests for auth module" });
    expect(args).toEqual(["--mode", "json", "-p", "--no-session", "-a", "Write tests for auth module"]);
  });

  it("appends --model when model is specified", () => {
    const args = buildPiArgs({
      task: "Refactor database query",
      model: "anthropic/claude-3-7-sonnet",
    });
    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "anthropic/claude-3-7-sonnet",
      "-a",
      "Refactor database query",
    ]);
  });

  it("appends model with thinking shorthand directly", () => {
    const args = buildPiArgs({
      task: "Solve competitive programming problem",
      model: "claude-sonnet:high",
    });
    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "claude-sonnet:high",
      "-a",
      "Solve competitive programming problem",
    ]);
  });

  it("appends --thinking when reasoning is specified", () => {
    const args = buildPiArgs({
      task: "Analyze race condition",
      reasoning: "high",
    });
    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--thinking",
      "high",
      "-a",
      "Analyze race condition",
    ]);
  });

  it("appends --thinking when thinking alias is specified", () => {
    const args = buildPiArgs({
      task: "Analyze race condition",
      thinking: "low",
    });
    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--thinking",
      "low",
      "-a",
      "Analyze race condition",
    ]);
  });

  it("appends both --model and --thinking when both are specified", () => {
    const args = buildPiArgs({
      task: "Complex architecture design",
      model: "gemini-3.8-flash",
      reasoning: "max",
    });
    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "gemini-3.8-flash",
      "--thinking",
      "max",
      "-a",
      "Complex architecture design",
    ]);
  });
});
