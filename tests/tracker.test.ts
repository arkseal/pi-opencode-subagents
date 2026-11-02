import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentTracker } from "../src/tracker";

describe("SubagentTracker", () => {
  let tracker: SubagentTracker;
  let mockCtx: any;
  let capturedWidget: any = null;
  let capturedPlacement: any = null;
  let capturedStatus: any = null;
  let testAgentDir: string;

  beforeEach(() => {
    testAgentDir = mkdtempSync(join(tmpdir(), "subagents-test-"));
    process.env.PI_CODING_AGENT_DIR = testAgentDir;

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

  afterEach(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {}
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

  it("registers subagent start with custom model and reasoning", () => {
    tracker.registerStart({
      id: "agent-custom",
      task: "Optimize query plan",
      model: "openai/gpt-4o",
      reasoning: "high",
      isolated: true,
      logFile: "/tmp/agent-custom.log",
    });

    const active = tracker.getActiveList();
    expect(active.length).toBe(1);
    expect(active[0].model).toBe("openai/gpt-4o");
    expect(active[0].reasoning).toBe("high");
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

  it("stores and preserves stats when subagent finishes", () => {
    tracker.registerStart({
      id: "agent-stats",
      task: "Stats task",
      isolated: true,
      logFile: "/tmp/agent-stats.log",
    });

    const stats = {
      tokensIn: 500,
      tokensOut: 100,
      cacheRead: 2000,
      cacheWrite: 0,
      totalTokens: 2600,
      cost: 0.005,
      toolCalls: 3,
      turns: 2,
    };

    tracker.registerFinish("agent-stats", {
      status: "completed",
      durationMs: 2500,
      stats,
    });

    const recent = tracker.getRecentList();
    expect(recent[0].stats).toBeDefined();
    expect(recent[0].stats?.totalTokens).toBe(2600);
    expect(recent[0].stats?.toolCalls).toBe(3);
  });

  it("allows toggling sidebar panel enabled state", () => {
    expect(tracker.isSidebarEnabled()).toBe(true);

    tracker.setSidebarEnabled(false);
    expect(tracker.isSidebarEnabled()).toBe(false);

    tracker.setSidebarEnabled(true);
    expect(tracker.isSidebarEnabled()).toBe(true);
  });

  it("renders completed subagents in sidebar panel with green status", () => {
    let capturedPanel: any = null;
    (globalThis as any).__PI_SIDEBAR_TUI__ = {
      registerPanel: (panel: any) => {
        capturedPanel = panel;
        return () => {};
      },
      unregisterPanel: () => {},
      fg: (color: string, str: string) => `[${color}]${str}[/${color}]`,
      bold: (str: string) => `*${str}*`,
      dim: (str: string) => `~${str}~`,
    };

    tracker.registerStart({
      id: "agent-green",
      task: "Check green color",
      isolated: true,
      logFile: "/tmp/green.log",
    });

    // Subagent completes
    const tracked = tracker.getActiveList()[0];
    tracked.status = "completed";
    tracked.endTime = Date.now();

    expect(capturedPanel).not.toBeNull();
    const rendered = capturedPanel.render({ spinnerFrame: 0 }, 80);
    const joined = rendered.join("\n");

    // Completed subagents must display green bullet [success]●[/success] and done time in green!
    expect(joined).toContain("[success]●[/success]");
    expect(joined).toContain("[success]done in");

    delete (globalThis as any).__PI_SIDEBAR_TUI__;
  });

  it("supports 3-way toggle between input-only, sidebar-only, and both", () => {
    // Mode 1: input-only (only above text input)
    tracker.setDisplayMode("input");
    expect(tracker.getDisplayMode()).toBe("input");
    expect(tracker.isWidgetEnabled()).toBe(true);
    expect(tracker.isSidebarEnabled()).toBe(false);

    // Mode 2: sidebar-only (only sidebar)
    tracker.setDisplayMode("sidebar");
    expect(tracker.getDisplayMode()).toBe("sidebar");
    expect(tracker.isWidgetEnabled()).toBe(false);
    expect(tracker.isSidebarEnabled()).toBe(true);

    // Mode 3: both (above text input & sidebar)
    tracker.setDisplayMode("both");
    expect(tracker.getDisplayMode()).toBe("both");
    expect(tracker.isWidgetEnabled()).toBe(true);
    expect(tracker.isSidebarEnabled()).toBe(true);

    // Cycle through modes: both -> input -> sidebar -> both
    const cycled1 = tracker.cycleDisplayMode();
    expect(cycled1).toBe("input");

    const cycled2 = tracker.cycleDisplayMode();
    expect(cycled2).toBe("sidebar");

    const cycled3 = tracker.cycleDisplayMode();
    expect(cycled3).toBe("both");
  });

  it("overrides older 'running' entries with newer 'completed' entries for the same ID on restore", () => {
    const items: any[] = [
      {
        id: "bg_sub_1",
        task: "Background task",
        status: "running",
        startTime: 1000,
        isolated: true,
        logFile: "/tmp/bg1.log",
      },
      {
        id: "bg_sub_1",
        task: "Background task",
        status: "completed",
        startTime: 1000,
        endTime: 5000,
        durationMs: 4000,
        isolated: true,
        logFile: "/tmp/bg1.log",
      },
    ];

    tracker.restoreRecent(items);
    const recent = tracker.getRecentList();
    const found = recent.find((r) => r.id === "bg_sub_1");
    expect(found).toBeDefined();
    expect(found?.status).toBe("completed");
    expect(found?.durationMs).toBe(4000);
  });

  it("animates braille spinner in sidebar panel for running subagents", () => {
    let capturedPanel: any = null;
    (globalThis as any).__PI_SIDEBAR_TUI__ = {
      registerPanel: (panel: any) => {
        capturedPanel = panel;
        return () => {};
      },
      unregisterPanel: () => {},
      fg: (color: string, str: string) => `[${color}]${str}[/${color}]`,
      bold: (str: string) => `*${str}*`,
      dim: (str: string) => `~${str}~`,
    };

    tracker.registerStart({
      id: "agent-spin",
      task: "Spinning subagent",
      isolated: true,
      logFile: "/tmp/spin.log",
    });

    expect(capturedPanel).not.toBeNull();
    const rendered = capturedPanel.render({}, 80);
    const joined = rendered.join("\n");

    const brailleFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const containsBraille = brailleFrames.some((frame) => joined.includes(frame));
    expect(containsBraille).toBe(true);

    delete (globalThis as any).__PI_SIDEBAR_TUI__;
  });

  it("accurately counts all completed subagents in sidebar header and shows +more indicator when > 5", () => {
    let capturedPanel: any = null;
    (globalThis as any).__PI_SIDEBAR_TUI__ = {
      registerPanel: (panel: any) => {
        capturedPanel = panel;
        return () => {};
      },
      unregisterPanel: () => {},
      fg: (color: string, str: string) => `[${color}]${str}[/${color}]`,
      bold: (str: string) => `*${str}*`,
      dim: (str: string) => `~${str}~`,
    };

    // Register 8 subagents
    for (let i = 1; i <= 8; i++) {
      tracker.registerStart({
        id: `agent-count-${i}`,
        task: `Task ${i}`,
        isolated: true,
        logFile: `/tmp/agent-${i}.log`,
      });
      tracker.registerFinish(`agent-count-${i}`, {
        status: "completed",
        durationMs: 1000 * i,
      });
    }

    expect(capturedPanel).not.toBeNull();
    const rendered = capturedPanel.render({}, 80);
    const joined = rendered.join("\n");

    // Header MUST show 8 done, not 5!
    expect(joined).toContain("(8 done)");
    // Must show clickable View more button
    expect(joined).toContain("[View 3 more subagents]");

    // Click the button via onClick
    expect(typeof capturedPanel.onClick).toBe("function");
    capturedPanel.onClick("[View 3 more subagents]", 10);

    const renderedAll = capturedPanel.render({}, 80).join("\n");
    expect(renderedAll).toContain("[Show less]");
    expect(renderedAll).toContain("Task 8");
    expect(renderedAll).toContain("Task 1");

    // Click on a subagent line to verify it opens the viewer
    let openedId: string | undefined;
    tracker.openViewer = async (id?: string) => {
      openedId = id;
    };
    capturedPanel.onClick("Task 8", 2);
    expect(openedId).toBe("agent-count-8");

    delete (globalThis as any).__PI_SIDEBAR_TUI__;
  });
});
