import { describe, expect, it } from "bun:test";
import { cleanSubagentOutput, renderSubagentCall, renderSubagentResult, buildSubagentStatsSummary, formatSubagentStats } from "../src/subagent-ui";

// Mock theme object matching Pi's theme interface
const mockTheme = {
  fg: (name: string, str: string) => `[${name}]${str}[/${name}]`,
  bold: (str: string) => `<b>${str}</b>`,
};

describe("cleanSubagentOutput", () => {
  it("strips XML envelope tags and trailing transcript line", () => {
    const raw = `<task-result id="subagent_123" status="completed" duration="3.2s">
Here is the core summary of the findings.
Everything looks clean.
Full transcript: /tmp/pi-subagents/subagent_123.log
</task-result>`;

    const cleaned = cleanSubagentOutput(raw);
    expect(cleaned).not.toContain("<task-result");
    expect(cleaned).not.toContain("</task-result>");
    expect(cleaned).not.toContain("Full transcript:");
    expect(cleaned).toContain("Here is the core summary of the findings.");
    expect(cleaned).toContain("Everything looks clean.");
  });

  it("handles empty or plain text cleanly", () => {
    expect(cleanSubagentOutput("")).toBe("");
    expect(cleanSubagentOutput("Plain text without xml")).toBe("Plain text without xml");
  });
});

describe("renderSubagentCall", () => {
  it("renders tool call header with task excerpt", () => {
    const component = renderSubagentCall(
      { task: "Search documentation and fix typos", isolated: true },
      mockTheme,
      { isPartial: false }
    );

    const rendered = component.render(120).join(" ");
    expect(rendered).toContain("Subagent");
    expect(rendered).toContain("Search documentation and fix typos");
    expect(rendered).toContain("[isolated]");
  });

  it("uses explicit description when provided", () => {
    const component = renderSubagentCall(
      { task: "A very long detailed prompt that goes on and on...", description: "Fix Typos", isolated: false },
      mockTheme,
      { isPartial: false }
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Fix Typos");
    expect(rendered).toContain("[shared]");
  });
});

describe("renderSubagentResult", () => {
  it("renders in-progress streaming view when isPartial is true", () => {
    const component = renderSubagentResult(
      { content: [] },
      { expanded: false, isPartial: true },
      mockTheme,
      {
        executionStarted: Date.now() - 2500,
        result: { details: { elapsedMs: 2500, currentLine: "Cloning repository..." } },
      }
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Running subagent");
  });

  it("renders completed collapsed view with clean summary and gutter", () => {
    const component = renderSubagentResult(
      {
        content: [{ type: "text", text: "<task-result>All tests passed\nCoverage 98%</task-result>" }],
        details: {
          id: "subagent_abc",
          status: "completed",
          durationMs: 3400,
          summary: "All tests passed\nCoverage 98%",
        },
      },
      { expanded: false, isPartial: false },
      mockTheme,
      {}
    );

    const rendered = component.render(120).join(" ");
    expect(rendered).toContain("●");
    expect(rendered).toContain("Subagent completed");
    expect(rendered).toContain("in 3.4s");
    expect(rendered).toContain("[subagent_abc]");
    expect(rendered).toContain("All tests passed");
    expect(rendered).not.toContain("<task-result>");
  });

  it("renders expanded view with transcript and log details", () => {
    const component = renderSubagentResult(
      {
        content: [{ type: "text", text: "Full detailed output here" }],
        details: {
          id: "subagent_xyz",
          status: "completed",
          durationMs: 1200,
          logFile: "/tmp/pi-subagents/subagent_xyz.log",
          worktree: { path: "/tmp/worktree", branch: "subagent/branch-1" },
          summary: "Full detailed output here",
        },
      },
      { expanded: true, isPartial: false },
      mockTheme,
      {}
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Log File:");
    expect(rendered).toContain("/tmp/pi-subagents/subagent_xyz.log");
    expect(rendered).toContain("Worktree:");
    expect(rendered).toContain("subagent/branch-1");
  });

  it("renders failure view when subagent errors", () => {
    const component = renderSubagentResult(
      {
        isError: true,
        content: [{ type: "text", text: "Process exited with code 1" }],
        details: {
          id: "subagent_fail",
          status: "failed",
          exitCode: 1,
          durationMs: 800,
          summary: "Process exited with code 1",
        },
      },
      { expanded: false, isPartial: false },
      mockTheme,
      {}
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("▲");
    expect(rendered).toContain("Subagent failed (exit 1)");
  });

  it("renders subagent stats badge in main chat result", () => {
    const component = renderSubagentResult(
      {
        content: [{ type: "text", text: "Task completed successfully" }],
        details: {
          id: "subagent_stats_1",
          status: "completed",
          durationMs: 2500,
          summary: "Task completed successfully",
          stats: {
            tokensIn: 3450,
            tokensOut: 120,
            cacheRead: 8500,
            cacheWrite: 0,
            totalTokens: 12070,
            cost: 0.003,
            toolCalls: 4,
            turns: 2,
          },
        },
      },
      { expanded: false, isPartial: false },
      mockTheme,
      {}
    );

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("3.5k"); // tokens in
    expect(rendered).toContain("in");
    expect(rendered).toContain("120");  // tokens out
    expect(rendered).toContain("out");
    expect(rendered).toContain("8.5k"); // cache read
    expect(rendered).toContain("cache");
    expect(rendered).toContain("tools");
  });

  it("renders detailed token breakdown in expanded view", () => {
    const component = renderSubagentResult(
      {
        content: [{ type: "text", text: "Task completed" }],
        details: {
          id: "subagent_stats_exp",
          status: "completed",
          durationMs: 3000,
          summary: "Task completed",
          stats: {
            tokensIn: 10500,
            tokensOut: 650,
            cacheRead: 25000,
            cacheWrite: 0,
            totalTokens: 36150,
            cost: 0.015,
            toolCalls: 5,
            turns: 3,
          },
        },
      },
      { expanded: true, isPartial: false },
      mockTheme,
      {}
    );

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Tokens:");
    expect(rendered).toContain("10,500 in");
    expect(rendered).toContain("650 out");
    expect(rendered).toContain("25,000 cache read");
    expect(rendered).toContain("36,150 total");
    expect(rendered).toContain("5 tool calls");
    expect(rendered).toContain("3 turns");
  });

  it("buildSubagentStatsSummary aggregates stats across all subagents", () => {
    const items = [
      {
        id: "subagent_1",
        task: "First task",
        status: "completed" as const,
        startTime: Date.now() - 4000,
        durationMs: 4000,
        stats: {
          tokensIn: 2000,
          tokensOut: 100,
          cacheRead: 5000,
          cacheWrite: 0,
          totalTokens: 7100,
          cost: 0.002,
          toolCalls: 2,
          turns: 2,
        },
      },
      {
        id: "subagent_2",
        task: "Second task",
        status: "completed" as const,
        startTime: Date.now() - 6000,
        durationMs: 6000,
        stats: {
          tokensIn: 5000,
          tokensOut: 300,
          cacheRead: 10000,
          cacheWrite: 0,
          totalTokens: 15300,
          cost: 0.005,
          toolCalls: 4,
          turns: 3,
        },
      },
    ];

    const summary = buildSubagentStatsSummary(items);
    expect(summary.text).toContain("Subagent Stats Summary");
    expect(summary.text).toContain("Total: 2 subagents");
    expect(summary.details.totalTokens).toBe(22400);
    expect(summary.details.totalIn).toBe(7000);
    expect(summary.details.totalOut).toBe(400);
    expect(summary.details.totalCache).toBe(15000);
    expect(summary.details.totalToolCalls).toBe(6);
  });
});
