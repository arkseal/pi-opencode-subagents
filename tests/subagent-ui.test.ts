import { describe, expect, it } from "bun:test";
import {
  cleanSubagentOutput,
  renderSubagentCall,
  renderSubagentResult,
  buildSubagentStatsSummary,
  formatSubagentStats,
  renderSubagentResponseMessage,
  preserveBg,
} from "../src/subagent-ui";

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

  it("strips OpenCode <subagent> envelope tags", () => {
    const raw = `<subagent sessionID="subagent_xyz" state="completed">
Discovered 3 route definitions in src/routes.
Full transcript: /tmp/pi-subagents/subagent_xyz.log
</subagent>`;

    const cleaned = cleanSubagentOutput(raw);
    expect(cleaned).not.toContain("<subagent");
    expect(cleaned).not.toContain("</subagent>");
    expect(cleaned).not.toContain("Full transcript:");
    expect(cleaned).toContain("Discovered 3 route definitions in src/routes.");
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

  it("renders specialized agent and background badges in call header", () => {
    const component = renderSubagentCall(
      { task: "Explore codebase architecture", agent: "explore", background: true, isolated: true },
      mockTheme,
      { isPartial: false }
    );

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("[explore]");
    expect(rendered).toContain("background");
    expect(rendered).toContain("[isolated]");
  });

  it("renders model badge in tool call header when model is provided", () => {
    const component = renderSubagentCall(
      { task: "Review PR", model: "openai/gpt-4o" },
      mockTheme,
      { isPartial: false }
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("[openai/gpt-4o]");
  });

  it("renders model and reasoning badge when both model and reasoning are provided", () => {
    const component = renderSubagentCall(
      { task: "Math proof", model: "anthropic/claude-3-7-sonnet", reasoning: "high" },
      mockTheme,
      { isPartial: false }
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("[anthropic/claude-3-7-sonnet:high]");
  });

  it("renders reasoning badge when only reasoning/thinking is provided", () => {
    const component = renderSubagentCall(
      { task: "Deep analysis", reasoning: "max" },
      mockTheme,
      { isPartial: false }
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("[reasoning:max]");
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

  it("renders running view when background subagent is still active", () => {
    const component = renderSubagentResult(
      {
        content: [{ type: "text", text: "Working in background..." }],
        details: {
          id: "subagent_running_1",
          status: "running",
          background: true,
          startTime: Date.now() - 1000,
        },
      },
      { expanded: false, isPartial: false },
      mockTheme,
      {}
    );

    const rendered = component.render(120).join(" ");
    expect(rendered).toContain("Running subagent in background");
    expect(rendered).not.toContain("Subagent completed");
    expect(rendered).toContain("[subagent_running_1]");
    expect(typeof (component as any).invalidate).toBe("function");
    expect(() => (component as any).invalidate()).not.toThrow();
  });

  it("preserveBg neutralizes \\x1b[0m and \\x1b[49m to prevent box background leaks", () => {
    const textWithReset = "Prefix \x1b[0m... Middle \x1b[49m Suffix";
    const sanitized = preserveBg(textWithReset);
    expect(sanitized).not.toContain("\x1b[0m");
    expect(sanitized).not.toContain("\x1b[49m");
    expect(sanitized).toContain("\x1b[39;22;23;24m");
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

  it("renders model and reasoning in expanded view when provided", () => {
    const component = renderSubagentResult(
      {
        content: [{ type: "text", text: "Done" }],
        details: {
          id: "subagent_model_exp",
          status: "completed",
          durationMs: 1200,
          model: "gemini-3.8-flash",
          reasoning: "high",
          summary: "Done",
        },
      },
      { expanded: true, isPartial: false },
      mockTheme,
      {}
    );

    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Model:");
    expect(rendered).toContain("gemini-3.8-flash");
    expect(rendered).toContain("(high reasoning)");
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

describe("renderSubagentResponseMessage", () => {
  it("renders compact preview when expanded is false", () => {
    const message = {
      content: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      details: {
        id: "sub_compact_1",
        status: "completed",
        durationMs: 3400,
        stats: { tokensIn: 1000, tokensOut: 200, toolCalls: 3, totalTokens: 1200 },
      },
    };

    const component: any = renderSubagentResponseMessage(message, { expanded: false }, mockTheme);
    const textChild = component.children?.[0];
    const rendered = textChild?.text || "";

    expect(rendered).toContain("Subagent completed");
    expect(rendered).toContain("[sub_compact_1]");
    expect(rendered).toContain("in 3.4s");
    expect(rendered).toContain("Line 1");
    expect(rendered).toContain("Line 2");
    expect(rendered).toContain("Line 3");
    expect(rendered).toContain("ctrl+o to expand");
    // Should NOT show line 5 in compact 3-line preview
    expect(rendered).not.toContain("Line 5");
  });

  it("renders full output when expanded is true", () => {
    const message = {
      content: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      details: {
        id: "sub_compact_2",
        status: "completed",
        durationMs: 4000,
        logFile: "/tmp/sub2.log",
      },
    };

    const component: any = renderSubagentResponseMessage(message, { expanded: true }, mockTheme);
    const textChild = component.children?.[0];
    const rendered = textChild?.text || "";

    expect(rendered).toContain("Subagent completed");
    expect(rendered).toContain("Line 1");
    expect(rendered).toContain("Line 5");
    expect(rendered).toContain("Full transcript: /tmp/sub2.log");
  });
});
