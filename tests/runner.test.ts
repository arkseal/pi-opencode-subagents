import { describe, expect, it } from "bun:test";
import { buildPiArgs } from "../src/runner";

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
