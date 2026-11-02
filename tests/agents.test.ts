import { describe, expect, it } from "bun:test";
import {
  BUILTIN_AGENTS,
  PROMPT_EXPLORE,
  formatAvailableAgentsDescription,
  parseAgentMarkdown,
  resolveAgent,
} from "../src/agents";

describe("Agent Profiles & Builtins", () => {
  it("provides general and explore builtin agents", () => {
    expect(BUILTIN_AGENTS.length).toBeGreaterThanOrEqual(2);

    const general = BUILTIN_AGENTS.find((a) => a.id === "general");
    expect(general).toBeDefined();
    expect(general?.mode).toBe("subagent");
    expect(general?.excludeTools).toContain("subagent");

    const explore = BUILTIN_AGENTS.find((a) => a.id === "explore");
    expect(explore).toBeDefined();
    expect(explore?.mode).toBe("subagent");
    expect(explore?.system).toBe(PROMPT_EXPLORE);
    expect(explore?.tools).toEqual(["read", "glob", "grep", "web_fetch", "websearch", "bash"]);
    expect(explore?.excludeTools).toEqual(["edit", "write", "subagent"]);
  });

  it("resolves explore agent by name or id case-insensitively", async () => {
    const byId = await resolveAgent("explore", process.cwd());
    expect(byId.id).toBe("explore");

    const byName = await resolveAgent("Explore", process.cwd());
    expect(byName.id).toBe("explore");
  });

  it("falls back to general when agent is unknown or omitted", async () => {
    const omitted = await resolveAgent(undefined, process.cwd());
    expect(omitted.id).toBe("general");

    const unknown = await resolveAgent("nonexistent_agent_xyz", process.cwd());
    expect(unknown.id).toBe("general");
  });

  it("formats available agents into a clean description list", () => {
    const desc = formatAvailableAgentsDescription(BUILTIN_AGENTS);
    expect(desc).toContain("Available subagents:");
    expect(desc).toContain("- general:");
    expect(desc).toContain("- explore:");
  });
});

describe("Markdown Agent Parser", () => {
  it("parses valid frontmatter and markdown body as system prompt", () => {
    const md = `---
description: Reviews changes for correctness and security
mode: subagent
model: anthropic/claude-sonnet-4-0
tools:
  - read
  - grep
  - glob
---

You are a security code reviewer. Review changes for vulnerabilities.`;

    const agent = parseAgentMarkdown(md, "reviewer");
    expect(agent).not.toBeNull();
    expect(agent?.id).toBe("reviewer");
    expect(agent?.description).toBe("Reviews changes for correctness and security");
    expect(agent?.model).toBe("anthropic/claude-sonnet-4-0");
    expect(agent?.mode).toBe("subagent");
    expect(agent?.tools).toEqual(["read", "grep", "glob"]);
    expect(agent?.system).toBe("You are a security code reviewer. Review changes for vulnerabilities.");
  });

  it("rejects primary-only agents from running as subagents", () => {
    const md = `---
description: Primary conversational agent
mode: primary
---

Primary agent prompt.`;

    const agent = parseAgentMarkdown(md, "orchestrator");
    expect(agent).toBeNull();
  });

  it("accepts mode: all as subagent capable", () => {
    const md = `---
description: Works everywhere
mode: all
---

Prompt here.`;

    const agent = parseAgentMarkdown(md, "versatile");
    expect(agent).not.toBeNull();
    expect(agent?.mode).toBe("all");
  });
});
