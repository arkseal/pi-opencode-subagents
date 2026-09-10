import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SubagentViewer } from "../src/subagent-viewer";
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
  });
});
