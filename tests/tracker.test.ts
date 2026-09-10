import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SubagentTracker } from "../src/tracker";

describe("SubagentTracker", () => {
  let tracker: SubagentTracker;
  let mockCtx: any;
  let capturedWidget: any = null;
  let capturedPlacement: any = null;
  let capturedStatus: any = null;

  beforeEach(() => {
    tracker = new SubagentTracker();
    capturedWidget = null;
    capturedPlacement = null;
    capturedStatus = null;

    mockCtx = {
      hasUI: true,
      ui: {
        setWidget: (key: string, content: any, options: any) => {
          if (key === "subagents-pinned") {
            capturedWidget = content;
            capturedPlacement = options?.placement;
          }
        },
        setStatus: (key: string, text: any) => {
          if (key === "subagents") {
            capturedStatus = text;
          }
        },
      },
    };

    tracker.setUIContext(mockCtx);
  });

  it("registers subagent start, mounts pinned widget below editor, and updates status indicator", () => {
    tracker.registerStart({
      id: "agent-1",
      task: "Search for nodejs releases",
      description: "NodeJS Search",
      isolated: true,
      logFile: "/tmp/agent-1.log",
    });

    const active = tracker.getActiveList();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("agent-1");
    expect(active[0].status).toBe("running");

    expect(capturedPlacement).toBe("belowEditor");
    expect(typeof capturedWidget).toBe("function");
    expect(capturedStatus).toContain("1 subagent active");
  });

  it("updates live peek line as progress arrives", () => {
    tracker.registerStart({
      id: "agent-1",
      task: "Fetch example.com",
      isolated: false,
      logFile: "/tmp/agent-1.log",
    });

    tracker.updatePeek("agent-1", "Parsing HTML DOM tree...");

    const active = tracker.getActiveList();
    expect(active[0].currentLine).toBe("Parsing HTML DOM tree...");
  });

  it("tracks multiple concurrent subagents simultaneously", () => {
    tracker.registerStart({
      id: "agent-1",
      task: "Task 1",
      isolated: true,
      logFile: "/tmp/agent-1.log",
    });

    tracker.registerStart({
      id: "agent-2",
      task: "Task 2",
      isolated: false,
      logFile: "/tmp/agent-2.log",
    });

    const active = tracker.getActiveList();
    expect(active.length).toBe(2);
    expect(capturedStatus).toContain("2 subagents active");
  });

  it("moves finished subagents to recent list", () => {
    tracker.registerStart({
      id: "agent-done",
      task: "Quick task",
      isolated: true,
      logFile: "/tmp/agent-done.log",
    });

    tracker.registerFinish("agent-done", {
      status: "completed",
      durationMs: 1500,
    });

    const recent = tracker.getRecentList();
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe("agent-done");
    expect(recent[0].status).toBe("completed");
    expect(recent[0].durationMs).toBe(1500);
  });

  it("strips newlines from peek text to prevent TUI box misalignment", () => {
    tracker.registerStart({
      id: "agent-code",
      task: "Code task",
      isolated: true,
      logFile: "/tmp/agent-code.log",
    });

    tracker.updatePeek("agent-code", "const a = 1;\nconst b = 2;\nreturn a + b;");

    const active = tracker.getActiveList();
    expect(active[0].currentLine).not.toContain("\n");
    expect(active[0].currentLine).toBe("const a = 1; const b = 2; return a + b;");
  });

  it("lingers completed tool output and blocks low-priority updates during linger window", () => {
    tracker.registerStart({
      id: "agent-linger",
      task: "Linger test",
      isolated: true,
      logFile: "/tmp/agent-linger.log",
    });

    // High priority tool completion with 2000ms linger
    tracker.updatePeek("agent-linger", 'globbed "*.ts" (5 files found)', "high", 2000);

    let active = tracker.getActiveList();
    expect(active[0].currentLine).toBe('globbed "*.ts" (5 files found)');

    // Low priority update immediately following (like thinking or text delta)
    tracker.updatePeek("agent-linger", "thinking...", "low");

    active = tracker.getActiveList();
    // Must remain lingering on the tool completion!
    expect(active[0].currentLine).toBe('globbed "*.ts" (5 files found)');
  });
});
