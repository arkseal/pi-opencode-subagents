import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SubagentViewer, getAnimatedProgressBar } from "../src/subagent-viewer";
import { SubagentTracker } from "../src/tracker";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const mockTheme = {
  fg: (name: string, str: string) => str,
  bold: (str: string) => str,
};

describe("SubagentViewer", () => {
  let tmpLog: string;

  beforeEach(() => {
    tmpLog = path.join(os.tmpdir(), `test_subagent_${Date.now()}.log`);
    fs.writeFileSync(tmpLog, "Line 1: Starting test\nLine 2: Running command\nLine 3: Finished\n");
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpLog);
    } catch {}
  });

  it("renders header, log content, and keybinding footer", () => {
    let closed = false;
    const tracker = new SubagentTracker();
    tracker.registerStart({
      id: "test_sub_1",
      task: "Inspect directory files",
      isolated: true,
      logFile: tmpLog,
    });

    const viewer = new SubagentViewer({
      id: "test_sub_1",
      task: "Inspect directory files",
      logPath: tmpLog,
      theme: mockTheme,
      tui: { requestRender: () => {} },
      tracker,
      done: () => {
        closed = true;
      },
    });

    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("Subagent Transcript: [test_sub_1]");
    expect(rendered).toContain("Inspect directory files");
    expect(rendered).toContain("Line 1: Starting test");
    expect(rendered).toContain("Esc/q: Close");
  });

  it("pins title and divider to the top lines of transcript view even when scrolled", () => {
    const tracker = new SubagentTracker();
    const viewer = new SubagentViewer({
      id: "test_sub_pin",
      task: "Pinned task",
      logPath: tmpLog,
      theme: mockTheme,
      tui: { requestRender: () => {}, terminal: { rows: 20 } },
      tracker,
      done: () => {},
    });

    const lines = viewer.render(80);
    // Line 0 is top title, Line 1 is top divider
    expect(lines[0]).toContain("Subagent Transcript: [test_sub_pin]");
    expect(lines[1]).toContain("─");

    // Scroll down
    viewer.handleInput("\x1b[B"); // Down arrow
    const scrolledLines = viewer.render(80);
    expect(scrolledLines[0]).toContain("Subagent Transcript: [test_sub_pin]");
    expect(scrolledLines[1]).toContain("─");
  });

  it("closes when escape or q is pressed", () => {
    let closed = false;
    const tracker = new SubagentTracker();
    const viewer = new SubagentViewer({
      id: "test_sub_2",
      task: "Quick task",
      logPath: tmpLog,
      theme: mockTheme,
      tui: { requestRender: () => {} },
      tracker,
      done: () => {
        closed = true;
      },
    });

    viewer.handleInput("q");
    expect(closed).toBe(true);
  });

  it("closes directly on one escape when opened for a specific subagent even with multiple subagents", () => {
    let closed = false;
    const tracker = new SubagentTracker();
    tracker.registerStart({ id: "agent_1", task: "Task 1", isolated: true, logFile: tmpLog });
    tracker.registerStart({ id: "agent_2", task: "Task 2", isolated: true, logFile: tmpLog });

    const viewer = new SubagentViewer({
      id: "agent_1",
      task: "Task 1",
      logPath: tmpLog,
      theme: mockTheme,
      tui: { requestRender: () => {} },
      tracker,
      canGoBackToList: false,
      done: () => {
        closed = true;
      },
    });

    viewer.handleInput("\x1b"); // Escape
    expect(closed).toBe(true);
  });

  it("handles mouse wheel scroll up and down", () => {
    const tracker = new SubagentTracker();
    let renderRequested = 0;
    const viewer = new SubagentViewer({
      id: "test_sub_3",
      task: "Scroll test",
      logPath: tmpLog,
      theme: mockTheme,
      tui: {
        terminal: { write: () => {} },
        requestRender: () => {
          renderRequested++;
        },
      },
      tracker,
      done: () => {},
    });

    // Send mouse wheel up (SGR 1006)
    viewer.handleInput("\x1b[<64;20;10M");
    expect(renderRequested).toBeGreaterThan(0);

    const prevCount = renderRequested;
    // Send mouse wheel down (SGR 1006)
    viewer.handleInput("\x1b[<65;20;10M");
    expect(renderRequested).toBeGreaterThan(prevCount);

    // Also test normalized TuiMouseEvent handleMouse
    const resUp = viewer.handleMouse({ type: "wheel", wheelDelta: -1 });
    expect(resUp?.handled).toBe(true);

    const resDown = viewer.handleMouse({ type: "wheel", wheelDelta: 1 });
    expect(resDown?.handled).toBe(true);
  });

  it("renders native Pi selector list when multiple subagents exist", () => {
    const tracker = new SubagentTracker();
    tracker.registerStart({
      id: "sub_alpha",
      task: "Alpha task for testing",
      agent: "general",
      isolated: true,
      logFile: tmpLog,
    });
    tracker.registerStart({
      id: "sub_beta",
      task: "Beta task for exploring",
      agent: "explore",
      isolated: true,
      logFile: tmpLog,
    });

    let closed = false;
    const viewer = new SubagentViewer({
      theme: mockTheme,
      tui: { requestRender: () => {} },
      tracker,
      done: () => {
        closed = true;
      },
    });

    const rendered = viewer.render(80).join("\n");
    // Verify native Pi header
    expect(rendered).toContain("Subagents");
    expect(rendered).toContain("Select a subagent to view live transcript");

    // Verify cursor and items layout (Pi UserMessageSelectorComponent style)
    expect(rendered).toContain("› Alpha task for testing");
    expect(rendered).toContain("Beta task for exploring");
    expect(rendered).toContain("[sub_alpha]");
    expect(rendered).toContain("[sub_beta]");

    // Verify keybinding footer
    expect(rendered).toContain("↑/↓ navigate");
    expect(rendered).toContain("enter view transcript");
    expect(rendered).toContain("esc close");
  });

  it("navigates selection and transitions between list and transcript modes", () => {
    const tracker = new SubagentTracker();
    tracker.registerStart({
      id: "sub_1",
      task: "First task",
      agent: "general",
      isolated: true,
      logFile: tmpLog,
    });
    tracker.registerStart({
      id: "sub_2",
      task: "Second task",
      agent: "explore",
      isolated: true,
      logFile: tmpLog,
    });

    let closed = false;
    let renders = 0;
    const viewer = new SubagentViewer({
      theme: mockTheme,
      tui: { requestRender: () => { renders++; } },
      tracker,
      done: () => {
        closed = true;
      },
    });

    // Initially on first item
    let output = viewer.render(80).join("\n");
    expect(output).toContain("› First task");

    // Move down
    viewer.handleInput("j");
    output = viewer.render(80).join("\n");
    expect(output).toContain("› Second task");

    // Press Enter to view transcript for Second task
    viewer.handleInput("\r");
    output = viewer.render(80).join("\n");
    expect(output).toContain("Subagent Transcript: [sub_2]");
    expect(output).toContain("Agent: explore");
    expect(output).toContain("Line 1: Starting test");
    expect(output).toContain("Back to list");

    // Press Esc to return back to list
    viewer.handleInput("\x1b");
    output = viewer.render(80).join("\n");
    expect(output).toContain("Subagents");
    expect(output).toContain("Select a subagent to view live transcript");
    expect(closed).toBe(false);

    // Press Esc from list to close
    viewer.handleInput("\x1b");
    expect(closed).toBe(true);
  });

  it("animates moving progress bar across frames", () => {
    const bar0 = getAnimatedProgressBar(0, 8);
    const bar3 = getAnimatedProgressBar(3, 8);
    expect(bar0).toContain("█");
    expect(bar3).toContain("█");
    expect(bar0).not.toBe(bar3);
  });

  it("renders animated progress bar and live activity peek for running subagent in list", () => {
    const tracker = new SubagentTracker();
    tracker.registerStart({
      id: "sub_running",
      task: "Active running task",
      agent: "explore",
      isolated: true,
      logFile: tmpLog,
    });
    tracker.updatePeek("sub_running", "Searching for files in src/...");

    const viewer = new SubagentViewer({
      initialMode: "list",
      theme: mockTheme,
      tui: { requestRender: () => {} },
      tracker,
      done: () => {},
    });

    const output = viewer.render(80).join("\n");
    expect(output).toContain("running");
    expect(output).toContain("[sub_running]");
    // Checks that progress bar and peek are rendered
    expect(output).toContain("░");
    expect(output).toContain("Searching for files in src/...");
  });

  it("renders structured chat turns from session JSONL file", () => {
    const subId = "sub_jsonl_chat_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const entries = [
      { type: "session", id: subId },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "You are a subagent spawned by another session.\nCalculate sum of 2 and 2." }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "echo 4" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "bash",
          content: [{ type: "text", text: "4\n" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The sum of 2 and 2 is 4." }],
        },
      },
    ];

    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Calculate sum of 2 and 2",
        agent: "general",
        isolated: false,
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {} },
        tracker,
        done: () => {},
      });

      const output = viewer.render(80).join("\n");
      // Header check
      expect(output).toContain("Subagent Transcript: [sub_jsonl_chat_test]");
      expect(output).toContain("[read-only]");

      // Chat turn checks
      expect(output).toContain("Calculate sum of 2 and 2.");
      expect(output).toContain("$ echo 4");
      expect(output).toContain("4");
      expect(output).toContain("The sum of 2 and 2 is 4.");
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("expands and collapses tool outputs with ctrl+o", () => {
    const subId = "sub_tool_expand_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const manyLines = Array.from({ length: 25 }, (_, i) => `log line ${i + 1}`).join("\n");
    const entries = [
      { type: "session", id: subId },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_bash_long", name: "bash", arguments: { command: "cat long.txt" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_bash_long",
          toolName: "bash",
          content: [{ type: "text", text: manyLines }],
        },
      },
    ];

    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Long output test",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {} },
        tracker,
        done: () => {},
      });

      // Default: collapsed preview with ctrl+o hint
      let rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("ctrl+o to expand");
      expect(rendered).not.toContain("log line 24");

      // Press ctrl+o (\x0f) to expand
      viewer.handleInput("\x0f");
      rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("log line 24");

      // Press ctrl+o again to collapse
      viewer.handleInput("\x0f");
      rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("ctrl+o to expand");
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("hides and reveals thinking block with alt+t and ctrl+t", () => {
    const subId = "sub_thinking_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const entries = [
      { type: "session", id: subId },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Deep architectural reasoning about state machines." },
            { type: "text", text: "Ready to proceed." },
          ],
        },
      },
    ];

    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Thinking test",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {} },
        tracker,
        done: () => {},
      });

      // Initially thinking is visible
      let rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("Deep architectural reasoning");

      // Toggle off with alt+t (\x1bt)
      viewer.handleInput("\x1bt");
      rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("Thinking... (press alt+t to expand)");
      expect(rendered).not.toContain("Deep architectural reasoning");

      // Toggle back on with ctrl+t (\x14)
      viewer.handleInput("\x14");
      rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("Deep architectural reasoning");
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("focuses input dock on i, accepts typing, and steers running subagent on Enter", () => {
    const { PassThrough } = require("node:stream");
    const { activeSubagentHandles, activeSubagentProcesses, stopAllSubagents } = require("../src/runner");
    const { SubagentEventParser } = require("../src/event-parser");

    stopAllSubagents();
    const mockStdin = new PassThrough();
    let written = "";
    mockStdin.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf-8");
    });

    const mockChild: any = {
      stdin: mockStdin,
      killed: false,
      exitCode: null,
      pid: 8888,
      kill: () => {},
      once: () => {},
    };

    const handle: any = {
      id: "sub_interactive_steer",
      child: mockChild,
      cwd: process.cwd(),
      taskText: "Running task",
      logFile: tmpLog,
      parser: new SubagentEventParser(),
      sessionFile: "/tmp/s.jsonl",
      useRpc: true,
      pendingSteers: 0,
      steeredMessages: [],
    };

    activeSubagentHandles.set("sub_interactive_steer", handle);
    activeSubagentProcesses.set("sub_interactive_steer", mockChild);

    const tracker = new SubagentTracker();
    tracker.registerStart({
      id: "sub_interactive_steer",
      task: "Running task",
      logFile: tmpLog,
    });

    const viewer = new SubagentViewer({
      id: "sub_interactive_steer",
      initialMode: "transcript",
      theme: mockTheme,
      tui: { requestRender: () => {} },
      tracker,
      done: () => {},
    });

    // 1. Initial state: unfocused placeholder
    let output = viewer.render(80).join("\n");
    expect(output).toContain("Press i or Tab to chat with / steer this subagent");

    // 2. Press 'i' to focus input dock
    viewer.handleInput("i");
    output = viewer.render(80).join("\n");
    expect(output).toContain("Chat / Steer Subagent");
    expect(output).toContain("Enter submit");

    // 3. Type message: "check database queries"
    for (const ch of "check database queries") {
      viewer.handleInput(ch);
    }
    output = viewer.render(80).join("\n");
    expect(output).toContain("check database queries");

    // 4. Press Enter to submit steering message
    viewer.handleInput("\r");
    expect(written).toContain('"type":"steer"');
    expect(written).toContain('"message":"check database queries"');

    // 5. Notice shown and returned to unfocused
    output = viewer.render(80).join("\n");
    expect(output).toContain("Steered running subagent");

    stopAllSubagents();
  });

  it("handles backspace, ctrl+u, and escape inside input mode", () => {
    const tracker = new SubagentTracker();
    tracker.registerStart({
      id: "sub_input_editing",
      task: "Editing test",
      logFile: tmpLog,
    });

    const viewer = new SubagentViewer({
      id: "sub_input_editing",
      initialMode: "transcript",
      theme: mockTheme,
      tui: { requestRender: () => {} },
      tracker,
      done: () => {},
    });

    // Focus input mode
    viewer.handleInput("i");

    // Type "hello"
    for (const ch of "hello") viewer.handleInput(ch);
    let output = viewer.render(80).join("\n");
    expect(output).toContain("hello");

    // Backspace: deletes 'o'
    viewer.handleInput("\x7f");
    output = viewer.render(80).join("\n");
    expect(output).toContain("hell");
    expect(output).not.toContain("hello");

    // Ctrl+U clears line
    viewer.handleInput("\x15");
    output = viewer.render(80).join("\n");
    expect(output).not.toContain("hell");

    // Type "cancel me"
    for (const ch of "cancel me") viewer.handleInput(ch);
    expect(viewer.render(80).join("\n")).toContain("cancel me");

    // Escape exits input mode without submitting
    viewer.handleInput("\x1b");
    output = viewer.render(80).join("\n");
    expect(output).toContain("Press i or Tab to chat with / steer this subagent");
    expect(output).not.toContain("cancel me");
  });

  it("ensures ANSI background colors inside shaded boxes are preserved without \x1b[0m reset leaks", () => {
    const subId = "sub_preserve_bg_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const entries = [
      { type: "session", id: subId },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Test with \x1b[0m reset inside user prompt" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_bg_read", name: "read", arguments: { path: "src/runner.ts" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_bg_read",
          toolName: "read",
          content: [{ type: "text", text: "const x = \x1b[31m1\x1b[0m + \x1b[32m2\x1b[49m;" }],
          durationMs: 120,
        },
      },
    ];

    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const customTheme = {
        fg: (_name: string, str: string) => str,
        bold: (str: string) => str,
        bg: (name: string, str: string) => `\x1b[48;${name}m${str}\x1b[49m`,
      };

      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Preserve bg test",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: customTheme,
        tui: { requestRender: () => {} },
        tracker,
        done: () => {},
      });

      const rendered = viewer.render(80).join("\n");
      // Verify tool call header formatted cleanly
      expect(rendered).toContain("read src/runner.ts");
      expect(rendered).toContain("Took 120ms");

      // Verify that inner \x1b[0m and \x1b[49m were neutralized inside shaded box lines
      // Notice: \x1b[0m is replaced with \x1b[39;22;23;24m and \x1b[49m stripped so background stays intact
      expect(rendered).toContain("\x1b[39;22;23;24m");
      expect(rendered).toContain("src/runner.ts");
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("renders specialized tool call headers for edit, write, grep, glob with duration timings", () => {
    const subId = "sub_specialized_tools_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const entries = [
      { type: "session", id: subId },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_edit", name: "edit", arguments: { path: "src/index.ts" } },
            { type: "toolCall", id: "tc_write", name: "write", arguments: { path: "docs/readme.md" } },
            { type: "toolCall", id: "tc_grep", name: "grep", arguments: { pattern: "SubagentViewer", path: "src" } },
            { type: "toolCall", id: "tc_glob", name: "glob", arguments: { pattern: "**/*.test.ts" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_edit",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully edited" }],
          durationMs: 85,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_write",
          toolName: "write",
          content: [{ type: "text", text: "Written 50 bytes" }],
          durationMs: 40,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_grep",
          toolName: "grep",
          content: [{ type: "text", text: "Found 2 matches" }],
          durationMs: 250,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_glob",
          toolName: "glob",
          content: [{ type: "text", text: "Found 12 files" }],
          durationMs: 15,
        },
      },
    ];

    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Specialized tools test",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {}, terminal: { rows: 60 } },
        tracker,
        done: () => {},
      });

      const rendered = viewer.render(80).join("\n");
      expect(rendered).toContain("edit src/index.ts");
      expect(rendered).toContain("Took 85ms");
      expect(rendered).toContain("write docs/readme.md");
      expect(rendered).toContain("Took 40ms");
      expect(rendered).toContain('grep "SubagentViewer" src');
      expect(rendered).toContain("Took 250ms");
      expect(rendered).toContain('glob "**/*.test.ts"');
      expect(rendered).toContain("Took 15ms");
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("auto-follows scrolling when autoTail is true as new content arrives", () => {
    const subId = "sub_autotail_follow_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const entries: any[] = [{ type: "session", id: subId }];
    entries.push({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Starting conversation turn" }] },
    });
    for (let i = 1; i <= 15; i++) {
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Assistant turn message ${i} with substantial output` }],
        },
      });
    }
    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Auto-follow test",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {}, terminal: { rows: 18 } },
        tracker,
        done: () => {},
      });

      // Initial render: autoTail is true by default
      const rendered1 = viewer.render(80).join("\n");
      expect((viewer as any).autoTail).toBe(true);
      expect((viewer as any).lastMaxScrollOffset).toBeGreaterThan(0);
      expect((viewer as any).scrollOffset).toBe((viewer as any).lastMaxScrollOffset);
      expect(rendered1).toContain("Assistant turn message 15");
      expect(rendered1).not.toContain("↓ Jump to latest message · Ctrl+End");

      const initialOffset = (viewer as any).scrollOffset;

      // Append 5 more messages to simulate subagent streaming more turns
      for (let i = 16; i <= 20; i++) {
        entries.push({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Assistant turn message ${i} with substantial output` }],
          },
        });
      }
      fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

      (viewer as any).reloadChat();
      const rendered2 = viewer.render(80).join("\n");

      // Auto-tail should have scrolled down automatically to the new max offset
      expect((viewer as any).autoTail).toBe(true);
      expect((viewer as any).scrollOffset).toBeGreaterThan(initialOffset);
      expect((viewer as any).scrollOffset).toBe((viewer as any).lastMaxScrollOffset);
      expect(rendered2).toContain("Assistant turn message 20");
      expect(rendered2).not.toContain("↓ Jump to latest message · Ctrl+End");

      viewer.dispose();
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("stops auto-following on scroll up, displays floating Jump to latest button, and preserves scroll offset when new messages arrive", () => {
    const subId = "sub_scroll_up_freeze_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const entries: any[] = [{ type: "session", id: subId }];
    entries.push({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Turn 1" }] },
    });
    for (let i = 1; i <= 20; i++) {
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Paragraph block ${i} detailing subagent output` }],
        },
      });
    }
    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Scroll freeze test",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {}, terminal: { rows: 18 } },
        tracker,
        done: () => {},
      });

      // Initial render establishes lastMaxScrollOffset at bottom
      viewer.render(80);
      expect((viewer as any).autoTail).toBe(true);
      const bottomOffset = (viewer as any).lastMaxScrollOffset;
      expect(bottomOffset).toBeGreaterThan(5);

      // Scroll up with 'k' key
      viewer.handleInput("k");
      viewer.handleInput("k");
      viewer.handleInput("k");

      expect((viewer as any).autoTail).toBe(false);
      expect((viewer as any).scrollOffset).toBe(bottomOffset - 3);

      const renderedScrolled = viewer.render(80).join("\n");
      // Floating indicator button must be displayed
      expect(renderedScrolled).toContain("↓ Jump to latest message · Ctrl+End");
      expect((viewer as any).jumpToEndRect).toBeDefined();

      const savedOffset = (viewer as any).scrollOffset;

      // Also verify mouse wheel up sets autoTail = false
      viewer.handleMouse({ type: "wheel", wheelDelta: -1 });
      expect((viewer as any).autoTail).toBe(false);
      expect((viewer as any).scrollOffset).toBe(savedOffset - 3);

      const offsetAfterWheel = (viewer as any).scrollOffset;

      // Append 10 more messages while scrolled up
      for (let i = 21; i <= 30; i++) {
        entries.push({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Paragraph block ${i} detailing subagent output` }],
          },
        });
      }
      fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

      (viewer as any).reloadChat();
      const renderedAfterNewMessages = viewer.render(80).join("\n");

      // autoTail must remain false and viewport must NOT yank down!
      expect((viewer as any).autoTail).toBe(false);
      expect((viewer as any).scrollOffset).toBe(offsetAfterWheel);
      expect((viewer as any).scrollOffset).toBeLessThan((viewer as any).lastMaxScrollOffset);
      expect(renderedAfterNewMessages).toContain("↓ Jump to latest message · Ctrl+End");

      viewer.dispose();
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("jumps to latest message and resumes auto-follow on ctrl+end, mouse click, and scrolling down", () => {
    const subId = "sub_jump_bottom_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    const entries: any[] = [{ type: "session", id: subId }];
    entries.push({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Start" }] },
    });
    for (let i = 1; i <= 25; i++) {
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Entry line item ${i}` }],
        },
      });
    }
    fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Jump to bottom test",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {}, terminal: { rows: 18 } },
        tracker,
        done: () => {},
      });

      // 1. Scroll up using pageUp
      viewer.render(80);
      viewer.handleInput("\x1b[5~"); // pageUp
      const scrolledRender = viewer.render(80).join("\n");
      expect((viewer as any).autoTail).toBe(false);
      expect(scrolledRender).toContain("↓ Jump to latest message · Ctrl+End");

      // Test 1: Jump to bottom via ctrl+end key
      viewer.handleInput("\x1b[1;5F"); // ctrl+end sequence
      expect((viewer as any).autoTail).toBe(true);
      expect((viewer as any).scrollOffset).toBe((viewer as any).lastMaxScrollOffset);

      const renderAfterCtrlEnd = viewer.render(80).join("\n");
      expect(renderAfterCtrlEnd).not.toContain("↓ Jump to latest message · Ctrl+End");
      expect((viewer as any).jumpToEndRect).toBeUndefined();

      // Verify auto-following resumes after ctrl+end
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Post-ctrl-end entry line item 26" }],
        },
      });
      fs.writeFileSync(jsonlFile, entries.map((e) => JSON.stringify(e)).join("\n"));
      (viewer as any).reloadChat();
      const renderResumed1 = viewer.render(80).join("\n");
      expect((viewer as any).autoTail).toBe(true);
      expect(renderResumed1).toContain("Post-ctrl-end entry line item 26");

      // Test 2: Jump to bottom via mouse click on floating button
      viewer.handleInput("k");
      viewer.handleInput("k");
      viewer.handleInput("k");
      viewer.render(80);
      expect((viewer as any).autoTail).toBe(false);
      const rect = (viewer as any).jumpToEndRect;
      expect(rect).toBeDefined();

      // Click on the button
      const handledClick = viewer.handleMouse({
        type: "click",
        x: rect.colStart + 3,
        y: rect.row,
      });
      expect(handledClick?.handled).toBe(true);
      expect((viewer as any).autoTail).toBe(true);
      expect((viewer as any).scrollOffset).toBe((viewer as any).lastMaxScrollOffset);
      expect(viewer.render(80).join("\n")).not.toContain("↓ Jump to latest message · Ctrl+End");

      // Test 3: Jump to bottom via SGR mouse left-click input
      viewer.handleInput("k");
      viewer.handleInput("k");
      viewer.render(80);
      expect((viewer as any).autoTail).toBe(false);
      const rectSgr = (viewer as any).jumpToEndRect;
      expect(rectSgr).toBeDefined();

      // Send SGR mouse press (\x1b[<0;col;rowM with 1-based coordinates)
      viewer.handleInput(`\x1b[<0;${rectSgr.colStart + 5};${rectSgr.row + 1}M`);
      expect((viewer as any).autoTail).toBe(true);
      expect((viewer as any).scrollOffset).toBe((viewer as any).lastMaxScrollOffset);
      expect(viewer.render(80).join("\n")).not.toContain("↓ Jump to latest message · Ctrl+End");

      // Test 4: Jump to bottom by scrolling down to the bottom
      viewer.handleInput("k");
      viewer.render(80);
      expect((viewer as any).autoTail).toBe(false);

      // Scroll down until reaching bottom
      viewer.handleInput("j");
      expect((viewer as any).autoTail).toBe(true);
      expect((viewer as any).scrollOffset).toBe((viewer as any).lastMaxScrollOffset);
      expect(viewer.render(80).join("\n")).not.toContain("↓ Jump to latest message · Ctrl+End");

      viewer.dispose();
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });

  it("synthesizes initial user message and streams live tools when JSONL has only session header", () => {
    const subId = "sub_live_first_turn_test";
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "subagents", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const jsonlFile = path.join(sessionsDir, `2026-10-25T00-00-00-000Z_${subId}.jsonl`);

    // Only 1-line session header on disk
    fs.writeFileSync(jsonlFile, JSON.stringify({ type: "session", id: subId }) + "\n");

    try {
      const tracker = new SubagentTracker();
      tracker.registerStart({
        id: subId,
        task: "Synthesized prompt for first turn",
        logFile: tmpLog,
      });

      const viewer = new SubagentViewer({
        id: subId,
        task: "Synthesized prompt for first turn",
        initialMode: "transcript",
        theme: mockTheme,
        tui: { requestRender: () => {} },
        tracker,
        done: () => {},
      });

      const rendered = viewer.render(80).join("\n");
      // The transcript must not be empty: the initial user message synthesized from task must be visible
      expect(rendered).toContain("Synthesized prompt for first turn");

      viewer.dispose();
    } finally {
      try {
        fs.unlinkSync(jsonlFile);
      } catch {}
    }
  });
});
