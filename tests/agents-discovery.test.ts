import { describe, expect, it } from "bun:test";
import { discoverAgents, resolveAgent } from "../src/agents";
import * as path from "node:path";

describe("Agent Discovery with Real Test Subagents", () => {
  const cwd = path.resolve(__dirname, "../..");

  it("discovers builtin and custom test agents in .opencode/agents and .pi/agents", async () => {
    const agents = await discoverAgents(cwd);
    const agentIds = agents.map((a) => a.id);

    // Builtins
    expect(agentIds).toContain("general");
    expect(agentIds).toContain("explore");

    // Custom test agents
    expect(agentIds).toContain("reviewer");
    expect(agentIds).toContain("tester");
    expect(agentIds).toContain("debugger");
    expect(agentIds).toContain("documenter");
  });

  it("resolves custom test agent 'reviewer' with correct configuration", async () => {
    const reviewer = await resolveAgent("reviewer", cwd);
    expect(reviewer).toBeDefined();
    expect(reviewer.id).toBe("reviewer");
    expect(reviewer.name).toBe("Reviewer");
    expect(reviewer.description).toContain("Reviews code changes");
    expect(reviewer.tools).toEqual(["read", "glob", "grep", "bash"]);
    expect(reviewer.excludeTools).toEqual(["edit", "write", "subagent"]);
    expect(reviewer.system).toContain("You are an expert code reviewer");
  });

  it("resolves custom test agent 'tester' with correct tools", async () => {
    const tester = await resolveAgent("tester", cwd);
    expect(tester.id).toBe("tester");
    expect(tester.tools).toContain("edit");
    expect(tester.tools).toContain("write");
    expect(tester.tools).toContain("bash");
    expect(tester.system).toContain("test automation specialist");
  });

  it("resolves custom test agent 'documenter' from .pi/agents", async () => {
    const doc = await resolveAgent("documenter", cwd);
    expect(doc.id).toBe("documenter");
    expect(doc.description).toContain("Technical writer");
    expect(doc.excludeTools).toContain("subagent");
  });
});
