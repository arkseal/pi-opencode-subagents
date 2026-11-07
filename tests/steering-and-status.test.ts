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
});
