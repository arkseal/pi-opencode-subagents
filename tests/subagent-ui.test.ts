import { describe, expect, it } from "bun:test";
import { cleanSubagentOutput, renderSubagentCall, renderSubagentResult } from "../src/subagent-ui";

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
});
