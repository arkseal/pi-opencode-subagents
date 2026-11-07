import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import opencodeSubagentsExtension from "../src/index";
import { activeSubagentProcesses, executeSubagent } from "../src/runner";

describe("Session Lifecycle & Persistence Integration", () => {
  let prevDepth: string | undefined;

  beforeEach(() => {
    prevDepth = process.env.PI_SUBAGENT_DEPTH;
    process.env.PI_SUBAGENT_DEPTH = "0";
  });

  afterEach(() => {
    if (prevDepth !== undefined) {
      process.env.PI_SUBAGENT_DEPTH = prevDepth;
    } else {
      delete process.env.PI_SUBAGENT_DEPTH;
    }
  });

  it("registers session_shutdown listener that stops active subagents", async () => {
    let shutdownHandler: any = null;
    const registeredTools: any[] = [];

    const mockPi: any = {
      on: (event: string, handler: any) => {
        if (event === "session_shutdown") {
          shutdownHandler = handler;
        }
      },
      registerTool: (tool: any) => {
        registeredTools.push(tool);
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };

    opencodeSubagentsExtension(mockPi);
    expect(typeof shutdownHandler).toBe("function");

    // Spawn a dummy background subagent
    const sub = await executeSubagent({
      task: "Dummy background task for shutdown test",
      cwd: process.cwd(),
      isolated: false,
    });

    expect(activeSubagentProcesses.has(sub.details.id)).toBe(true);

    // Trigger session shutdown
    await shutdownHandler({ reason: "quit" }, {});
    expect(activeSubagentProcesses.has(sub.details.id)).toBe(false);
  });

  it("persists subagent records via pi.appendEntry", async () => {
    const appendedEntries: any[] = [];
    let toolDef: any = null;

    const mockPi: any = {
      on: () => {},
      registerTool: (tool: any) => {
        if (tool.name === "subagent") {
          toolDef = tool;
        }
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: (type: string, data: any) => {
        appendedEntries.push({ type, data });
      },
    };

    opencodeSubagentsExtension(mockPi);
    expect(toolDef).toBeDefined();

    const mockCtx: any = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getEntries: () => [],
      },
    };

    // Execute with background = true
    await toolDef.execute("call-1", { task: "Persist test background", background: true, isolated: false }, undefined, undefined, mockCtx);

    // Execute with pre-aborted signal
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    await toolDef.execute("call-2", { task: "Pre-aborted task", background: false, isolated: false }, abortCtrl.signal, undefined, mockCtx);

    // Non-background completed task should append subagent_record entry
    const record = appendedEntries.find((e) => e.type === "subagent_record");
    expect(record).toBeDefined();
    expect(record.data.task).toBe("Pre-aborted task");
    expect(record.data.status).toBe("aborted");
  });

  it("rejects execution when task and prompt are empty", async () => {
    let toolDef: any = null;
    const mockPi: any = {
      on: () => {},
      registerTool: (tool: any) => {
        if (tool.name === "subagent") toolDef = tool;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };

    opencodeSubagentsExtension(mockPi);

    const mockCtx: any = {
      cwd: process.cwd(),
      hasUI: false,
    };

    expect(
      toolDef.execute("call-err", { task: "   " }, undefined, undefined, mockCtx)
    ).rejects.toThrow("A task or prompt must be specified");
  });

  it("sets terminate: true on background subagent launch so main chat ends while waiting", async () => {
    let toolDef: any = null;
    let shutdownHandler: any = null;
    const mockPi: any = {
      on: (event: string, handler: any) => {
        if (event === "session_shutdown") shutdownHandler = handler;
      },
      registerTool: (tool: any) => {
        if (tool.name === "subagent") toolDef = tool;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };

    opencodeSubagentsExtension(mockPi);
    const mockCtx: any = { cwd: process.cwd(), hasUI: false };

    const res = await toolDef.execute(
      "call-bg-term",
      { task: "Background task that should terminate main turn", background: true, isolated: false },
      undefined,
      undefined,
      mockCtx
    );

    expect(res.terminate).toBe(true);
    expect(res.details.status).toBe("running");

    if (shutdownHandler) {
      await shutdownHandler({ reason: "quit" }, {});
    }
  });
});
