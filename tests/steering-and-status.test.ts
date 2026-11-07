import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  steerSubagent,
  inspectSubagent,
  executeSubagent,
  activeSubagentHandles,
  activeSubagentProcesses,
  stopAllSubagents,
} from "../src/runner";
import { SubagentEventParser } from "../src/event-parser";
import { globalSubagentTracker } from "../src/tracker";
import opencodeSubagentsExtension from "../src/index";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { PassThrough } from "node:stream";

describe("Subagent Live Steering & Status Inspection", () => {
  let tmpLog: string;

  beforeEach(() => {
    stopAllSubagents();
    activeSubagentHandles.clear();
    activeSubagentProcesses.clear();
    tmpLog = path.join(os.tmpdir(), `test_steer_${Date.now()}.log`);
    fs.writeFileSync(tmpLog, "");
  });

  afterEach(() => {
    stopAllSubagents();
    activeSubagentHandles.clear();
    activeSubagentProcesses.clear();
    try {
      if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    } catch {}
  });

  it("steerSubagent writes RPC command to stdin and records metadata", () => {
    const mockStdin = new PassThrough();
    const mockChild: any = {
      stdin: mockStdin,
      killed: false,
      exitCode: null,
      pid: 12345,
      kill: () => {},
      once: () => {},
    };

    let stdinData = "";
    mockStdin.on("data", (chunk) => {
      stdinData += chunk.toString("utf-8");
    });

    const parser = new SubagentEventParser();
    const handle: any = {
      id: "sub_test_steer_1",
      child: mockChild,
      cwd: process.cwd(),
      taskText: "Initial task",
      logFile: tmpLog,
      parser,
      sessionFile: "/tmp/session.jsonl",
      useRpc: true,
      pendingSteers: 0,
      steeredMessages: [],
    };

    activeSubagentHandles.set("sub_test_steer_1", handle);
    activeSubagentProcesses.set("sub_test_steer_1", mockChild);

    const result = steerSubagent("sub_test_steer_1", "Focus on authentication first", "steer");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("steered");
    expect(handle.pendingSteers).toBe(1);
    expect(handle.steeredMessages.length).toBe(1);
    expect(handle.steeredMessages[0].text).toBe("Focus on authentication first");
    expect(handle.steeredMessages[0].mode).toBe("steer");

    // Verify RPC command sent to child stdin
    expect(stdinData).toContain('"type":"steer"');
    expect(stdinData).toContain('"message":"Focus on authentication first"');
  });

  it("steerSubagent returns not_running when subagent is not active", () => {
    const result = steerSubagent("non_existent_id", "Hello subagent", "steer");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_running");
    expect(result.message).toContain("not currently running");
  });

  it("executeSubagent steers running subagent instead of spawning duplicate competing process", async () => {
    const mockStdin = new PassThrough();
    let writtenToStdin = "";
    mockStdin.on("data", (c) => {
      writtenToStdin += c.toString("utf-8");
    });

    const mockChild: any = {
      stdin: mockStdin,
      killed: false,
      exitCode: null,
      pid: 99999,
      kill: () => {},
      once: () => {},
    };

    const parser = new SubagentEventParser();
    const handle: any = {
      id: "running_session_123",
      child: mockChild,
      cwd: process.cwd(),
      taskText: "Initial task",
      logFile: tmpLog,
      parser,
      sessionFile: "/tmp/session.jsonl",
      useRpc: true,
      pendingSteers: 0,
      steeredMessages: [],
      agent: "general",
    };

    activeSubagentHandles.set("running_session_123", handle);
    activeSubagentProcesses.set("running_session_123", mockChild);

    // Call executeSubagent with the already running sessionID
    const res = await executeSubagent({
      sessionID: "running_session_123",
      task: "Steer: please check routes/auth.ts",
      cwd: process.cwd(),
    });

    expect(res.details.status).toBe("running");
    expect(res.details.steered).toBe(true);
    expect(writtenToStdin).toContain('"message":"Steer: please check routes/auth.ts"');
    expect(handle.pendingSteers).toBe(1);
  });

  it("inspectSubagent summarizes all subagents when id is omitted", () => {
    globalSubagentTracker.registerStart({
      id: "active_sub_1",
      task: "Refactor backend API",
      agent: "general",
      model: "anthropic/claude-3-7-sonnet",
      isolated: true,
      logFile: tmpLog,
    });
    globalSubagentTracker.updatePeek("active_sub_1", "Running tests on auth routes...");

    const inspection = inspectSubagent(undefined);
    expect(inspection.output).toContain("Subagents Overview");
    expect(inspection.output).toContain("active_sub_1");
    expect(inspection.output).toContain("Refactor backend API");
    expect(inspection.output).toContain("Running tests on auth routes...");
    expect(inspection.details.active.length).toBeGreaterThanOrEqual(1);
  });

  it("inspectSubagent formats detailed live status report when sessionID is provided", () => {
    const parser = new SubagentEventParser();
    // Simulate streaming events in parser
    parser.parseLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "call_inspect_1",
        toolName: "grep",
        args: { pattern: "export function login" },
      })
    );

    const mockChild: any = {
      killed: false,
      exitCode: null,
      stdin: new PassThrough(),
      kill: () => {},
      once: () => {},
    };

    const handle: any = {
      id: "detailed_sub_456",
      child: mockChild,
      cwd: process.cwd(),
      taskText: "Audit auth functions",
      logFile: tmpLog,
      parser,
      sessionFile: "/tmp/session.jsonl",
      useRpc: true,
      pendingSteers: 0,
      steeredMessages: [],
      agent: "explore",
      model: "google/gemini-2.5-pro",
    };

    activeSubagentHandles.set("detailed_sub_456", handle);
    globalSubagentTracker.registerStart({
      id: "detailed_sub_456",
      task: "Audit auth functions",
      agent: "explore",
      model: "google/gemini-2.5-pro",
      isolated: true,
      logFile: tmpLog,
    });

    const report = inspectSubagent("detailed_sub_456");
    expect(report.output).toContain("Subagent Status: `detailed_sub_456`");
    expect(report.output).toContain("- **Status**: running");
    expect(report.output).toContain("- **Agent**: explore");
    expect(report.output).toContain("- **Model**: google/gemini-2.5-pro");
    expect(report.output).toContain("export function login");
    expect(report.output).toContain("Currently Running Tools");
    expect(report.output).toContain("Tip: Call subagent with sessionID=\"detailed_sub_456\"");
  });

  it("subagent tool handles action='list', action='status', and action='abort'", async () => {
    let subagentTool: any;
    let subagentStatusTool: any;

    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        if (t.name === "subagent") subagentTool = t;
        if (t.name === "subagent_status") subagentStatusTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };

    opencodeSubagentsExtension(mockPi);
    expect(subagentTool).toBeDefined();
    expect(subagentStatusTool).toBeDefined();

    // 1. action: 'list'
    const listRes = await subagentTool.execute("tc_1", { action: "list" }, undefined, undefined, { cwd: process.cwd() });
    expect(listRes.content[0].text).toBeDefined();

    // 2. action: 'status' with sessionID
    const statusRes = await subagentTool.execute("tc_2", { action: "status", sessionID: "some_sub_id" }, undefined, undefined, { cwd: process.cwd() });
    expect(statusRes.content[0].text).toContain("Subagent Status: `some_sub_id`");

    // 3. dedicated subagent_status tool
    const statusToolRes = await subagentStatusTool.execute("tc_3", { sessionID: "some_sub_id" });
    expect(statusToolRes.content[0].text).toContain("Subagent Status: `some_sub_id`");

    // 4. action: 'abort'
    const abortRes = await subagentTool.execute("tc_4", { action: "abort", sessionID: "some_sub_id" }, undefined, undefined, { cwd: process.cwd() });
    expect(abortRes.content[0].text).toContain("some_sub_id");
  });

  it("subagent tool steers running session with action='steer'", async () => {
    let subagentTool: any;
    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        if (t.name === "subagent") subagentTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };
    opencodeSubagentsExtension(mockPi);

    const mockStdin = new PassThrough();
    let stdinData = "";
    mockStdin.on("data", (chunk) => {
      stdinData += chunk.toString("utf-8");
    });

    const parser = new SubagentEventParser();
    const handle: any = {
      id: "active_run_999",
      child: {
        stdin: mockStdin,
        killed: false,
        exitCode: null,
        kill: () => {},
        once: () => {},
      },
      cwd: process.cwd(),
      taskText: "Working",
      logFile: tmpLog,
      parser,
      sessionFile: "/tmp/session.jsonl",
      useRpc: true,
      pendingSteers: 0,
      steeredMessages: [],
    };
    activeSubagentHandles.set("active_run_999", handle);

    const steerRes = await subagentTool.execute(
      "tc_steer",
      {
        sessionID: "active_run_999",
        action: "steer",
        task: "Please use grep instead of glob",
      },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    expect(steerRes.content[0].text).toContain("Guidance delivered to subagent active_run_999");
    expect(stdinData).toContain('"type":"steer"');
    expect(stdinData).toContain('"message":"Please use grep instead of glob"');
  });

  it("subagent tool auto-targets single running subagent when sessionID is omitted on steer", async () => {
    let subagentTool: any;
    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        if (t.name === "subagent") subagentTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };
    opencodeSubagentsExtension(mockPi);

    const mockStdin = new PassThrough();
    let stdinData = "";
    mockStdin.on("data", (chunk) => {
      stdinData += chunk.toString("utf-8");
    });

    const parser = new SubagentEventParser();
    const handle: any = {
      id: "solo_runner_1",
      child: {
        stdin: mockStdin,
        killed: false,
        exitCode: null,
        kill: () => {},
        once: () => {},
      },
      cwd: process.cwd(),
      taskText: "Solo task",
      logFile: tmpLog,
      parser,
      sessionFile: "/tmp/session.jsonl",
      useRpc: true,
      pendingSteers: 0,
      steeredMessages: [],
    };
    activeSubagentHandles.set("solo_runner_1", handle);

    // Call steer with no sessionID
    const steerRes = await subagentTool.execute(
      "tc_auto_steer",
      {
        action: "steer",
        task: "Change directory to src/",
      },
      undefined,
      undefined,
      { cwd: process.cwd() }
    );

    expect(steerRes.content[0].text).toContain("Guidance delivered to subagent solo_runner_1");
    expect(stdinData).toContain('"message":"Change directory to src/"');
  });

  it("subagent tool throws clear error when sessionID is omitted on steer and no subagents are running", async () => {
    let subagentTool: any;
    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        if (t.name === "subagent") subagentTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };
    opencodeSubagentsExtension(mockPi);

    activeSubagentHandles.clear();

    await expect(
      subagentTool.execute(
        "tc_no_running",
        { action: "steer", task: "Any command" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow("No running subagents to steer");
  });

  it("subagent tool throws clear error listing running IDs when sessionID is omitted and multiple are running", async () => {
    let subagentTool: any;
    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        if (t.name === "subagent") subagentTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };
    opencodeSubagentsExtension(mockPi);

    activeSubagentHandles.set("agent_one", {
      id: "agent_one",
      child: { killed: false, exitCode: null } as any,
    } as any);
    activeSubagentHandles.set("agent_two", {
      id: "agent_two",
      child: { killed: false, exitCode: null } as any,
    } as any);

    await expect(
      subagentTool.execute(
        "tc_multi_running",
        { action: "steer", task: "Any command" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow('Multiple subagents are currently running ("agent_one", "agent_two")');
  });

  it("subagent_status has renderCall and renderResult handlers for Pi TUI", () => {
    let subagentStatusTool: any;
    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        if (t.name === "subagent_status") subagentStatusTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };
    opencodeSubagentsExtension(mockPi);

    expect(typeof subagentStatusTool.renderCall).toBe("function");
    expect(typeof subagentStatusTool.renderResult).toBe("function");

    const mockTheme = {
      fg: (_name: string, str: string) => str,
      bold: (str: string) => str,
      bg: (_name: string, str: string) => str,
    };

    // Test renderCall
    const callComp = subagentStatusTool.renderCall({ sessionID: "sub_123" }, mockTheme, {});
    expect(callComp.render(80).join(" ")).toContain("[sub_123]");

    const allComp = subagentStatusTool.renderCall({}, mockTheme, {});
    expect(allComp.render(80).join(" ")).toContain("(all subagents)");

    // Test renderResult
    const resComp = subagentStatusTool.renderResult(
      {
        content: [{ type: "text", text: "### Subagent Status: `sub_123`\n- Status: running" }],
        details: { sessionID: "sub_123", status: "running" },
      },
      { expanded: false },
      mockTheme,
      {}
    );
    const rendered = resComp.render(80).join("\n");
    expect(rendered).toContain("Subagent Status: sub_123");
    expect(rendered).toContain("- Status: running");
  });

  it("handles RPC initial prompt rejection by ending stdin and recording error", async () => {
    const prevBin = process.env.PI_BIN_PATH;
    const prevRpc = process.env.PI_SUBAGENT_USE_RPC;
    const scriptPath = path.join(os.tmpdir(), `rpc_prompt_fail_${Date.now()}.mjs`);

    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
let stdinEnded = false;
process.stdin.on("end", () => {
  stdinEnded = true;
  process.exit(1);
});
process.stdin.on("data", (chunk) => {
  const str = chunk.toString("utf-8");
  if (str.includes('"init-prompt"')) {
    process.stdout.write(JSON.stringify({
      id: "init-prompt",
      type: "response",
      command: "prompt",
      success: false,
      error: "Authentication failed: invalid token",
    }) + "\\n");
  }
});
setTimeout(() => {
  if (!stdinEnded) process.exit(99);
}, 2500);
`,
      { mode: 0o755 }
    );

    process.env.PI_BIN_PATH = scriptPath;
    process.env.PI_SUBAGENT_USE_RPC = "1";

    try {
      let bgCompleteCalled = false;
      let bgStatus = "";
      let bgError = "";

      const execPromise = executeSubagent({
        task: "Test task that fails at RPC prompt",
        cwd: process.cwd(),
        isolated: false,
        background: true,
        onBackgroundComplete: (res) => {
          bgCompleteCalled = true;
          bgStatus = res.status;
          bgError = res.errorMessage || "";
        },
      });

      const launchResult = await execPromise;
      expect(launchResult.details.status).toBe("running");

      // Await child process termination (which only happens because stdin was ended by runner.ts!)
      let iterations = 0;
      while (!bgCompleteCalled && iterations < 30) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        iterations++;
      }

      expect(bgCompleteCalled).toBe(true);
      expect(bgStatus).toBe("failed");
      expect(bgError).toContain("Authentication failed: invalid token");
    } finally {
      if (prevBin !== undefined) process.env.PI_BIN_PATH = prevBin;
      else delete process.env.PI_BIN_PATH;
      if (prevRpc !== undefined) process.env.PI_SUBAGENT_USE_RPC = prevRpc;
      else delete process.env.PI_SUBAGENT_USE_RPC;
      try {
        fs.unlinkSync(scriptPath);
      } catch {}
    }
  });

  it("decrements pendingSteers and ends stdin on failed steer response when agent already settled", async () => {
    const prevBin = process.env.PI_BIN_PATH;
    const prevRpc = process.env.PI_SUBAGENT_USE_RPC;
    const scriptPath = path.join(os.tmpdir(), `rpc_steer_fail_${Date.now()}.mjs`);

    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
let stdinEnded = false;
process.stdin.on("end", () => {
  stdinEnded = true;
  process.exit(0);
});
process.stdin.on("data", (chunk) => {
  const str = chunk.toString("utf-8");
  for (const line of str.split("\\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed.id === "init-prompt") {
        // Initial prompt accepted
        process.stdout.write(JSON.stringify({
          id: "init-prompt",
          type: "response",
          command: "prompt",
          success: true
        }) + "\\n");
      } else if (parsed.type === "steer") {
        // Turn 1 settles while steer is pending
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        // Then steer command is rejected by RPC
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            id: parsed.id,
            type: "response",
            command: "steer",
            success: false,
            error: "Agent busy or queue full"
          }) + "\\n");
        }, 30);
      }
    } catch {}
  }
});
setTimeout(() => {
  if (!stdinEnded) process.exit(99);
}, 2500);
`,
      { mode: 0o755 }
    );

    process.env.PI_BIN_PATH = scriptPath;
    process.env.PI_SUBAGENT_USE_RPC = "1";

    try {
      let bgCompleteCalled = false;
      let bgStatus = "";

      const launchResult = await executeSubagent({
        task: "Test steer settlement edge case",
        cwd: process.cwd(),
        isolated: false,
        background: true,
        onBackgroundComplete: (res) => {
          bgCompleteCalled = true;
          bgStatus = res.status;
        },
      });

      const handle = activeSubagentHandles.get(launchResult.details.id)!;
      expect(handle).toBeDefined();

      // Steer subagent while turn 1 is running
      const steerRes = steerSubagent(launchResult.details.id, "Try a different approach", "steer");
      expect(steerRes.ok).toBe(true);
      expect(steerRes.status).toBe("steered");
      expect(handle.pendingSteers).toBe(1);

      // Await child process termination (stdin ended after steer rejection)
      let iterations = 0;
      while (!bgCompleteCalled && iterations < 30) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        iterations++;
      }

      expect(bgCompleteCalled).toBe(true);
      expect(bgStatus).toBe("failed");
      expect(handle.pendingSteers).toBe(0);
    } finally {
      if (prevBin !== undefined) process.env.PI_BIN_PATH = prevBin;
      else delete process.env.PI_BIN_PATH;
      if (prevRpc !== undefined) process.env.PI_SUBAGENT_USE_RPC = prevRpc;
      else delete process.env.PI_SUBAGENT_USE_RPC;
      try {
        fs.unlinkSync(scriptPath);
      } catch {}
    }
  });
});
