import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeSubagent } from "../src/runner";
import { SubagentEventParser } from "../src/event-parser";
import {
  checkSubagentCompletionOnDisk,
  SubagentTracker,
} from "../src/tracker";
import { renderSubagentResponseMessage } from "../src/subagent-ui";
import opencodeSubagentsExtension from "../src/index";

describe("SubagentEventParser Retry & Recovery", () => {
  it("recovers from Turn 1 error when Turn 2 succeeds via auto-retry", () => {
    const parser = new SubagentEventParser();

    // Turn 1 fails
    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Rate limit reached: retry after 2s",
        },
      })
    );
    expect(parser.getStopReason()).toBe("error");
    expect(parser.getErrorMessage()).toContain("Rate limit reached");

    // Pi initiates auto-retry
    const retryStart = parser.parseLine(
      JSON.stringify({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
      })
    );
    expect(retryStart?.peek).toBe("retrying (attempt 1/3)...");
    expect(parser.getStopReason()).toBeUndefined();
    expect(parser.getErrorMessage()).toBeUndefined();

    // Turn 2 starts
    parser.parseLine(
      JSON.stringify({
        type: "message_start",
        message: { role: "assistant" },
      })
    );

    // Turn 2 succeeds
    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Successfully completed task." }],
          stopReason: "stop",
        },
      })
    );

    // Pi agent ends
    const endParsed = parser.parseLine(
      JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Rate limit reached: retry after 2s",
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Successfully completed task." }],
            stopReason: "stop",
          },
        ],
      })
    );

    expect(parser.getStopReason()).toBe("stop");
    expect(parser.getErrorMessage()).toBeUndefined();
    expect(parser.getLastAssistantText()).toBe("Successfully completed task.");
    expect(endParsed?.finalAssistantText).toBe("Successfully completed task.");
  });

  it("ignores agent_end when willRetry is true", () => {
    const parser = new SubagentEventParser();
    const parsed = parser.parseLine(
      JSON.stringify({
        type: "agent_end",
        willRetry: true,
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "Transient error" },
        ],
      })
    );
    expect(parsed).toBeUndefined();
  });
});

describe("checkSubagentCompletionOnDisk", () => {
  let tmpSessionsDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-disk-check-"));
    origEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpSessionsDir;
    fs.mkdirSync(path.join(tmpSessionsDir, "subagents", "sessions"), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) process.env.PI_CODING_AGENT_DIR = origEnv;
    else delete process.env.PI_CODING_AGENT_DIR;
    try {
      fs.rmSync(tmpSessionsDir, { recursive: true, force: true });
    } catch {}
  });

  it("returns failed when last assistant message had stopReason error", () => {
    const sessionsDir = path.join(tmpSessionsDir, "subagents", "sessions");
    const filePath = path.join(sessionsDir, "agent_fail_1.jsonl");

    const header = { type: "session", version: 3, id: "agent_fail_1", cwd: "/tmp" };
    const errMessage = {
      type: "message",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Model quota exhausted",
      },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(errMessage)}\n`, "utf-8");

    const result = checkSubagentCompletionOnDisk("agent_fail_1");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("Model quota exhausted");
  });

  it("returns aborted when last assistant message had stopReason aborted", () => {
    const sessionsDir = path.join(tmpSessionsDir, "subagents", "sessions");
    const filePath = path.join(sessionsDir, "agent_abort_1.jsonl");

    const header = { type: "session", version: 3, id: "agent_abort_1", cwd: "/tmp" };
    const abortMessage = {
      type: "message",
      message: { role: "assistant", content: [], stopReason: "aborted" },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(abortMessage)}\n`, "utf-8");

    const result = checkSubagentCompletionOnDisk("agent_abort_1");
    expect(result.status).toBe("aborted");
  });

  it("returns completed when assistant message has text content", () => {
    const sessionsDir = path.join(tmpSessionsDir, "subagents", "sessions");
    const filePath = path.join(sessionsDir, "agent_ok_1.jsonl");

    const header = { type: "session", version: 3, id: "agent_ok_1", cwd: "/tmp" };
    const okMessage = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        stopReason: "stop",
      },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(okMessage)}\n`, "utf-8");

    const result = checkSubagentCompletionOnDisk("agent_ok_1");
    expect(result.status).toBe("completed");
  });

  it("returns failed when process is inactive and session has no completed assistant message", () => {
    const sessionsDir = path.join(tmpSessionsDir, "subagents", "sessions");
    const filePath = path.join(sessionsDir, "agent_empty_1.jsonl");

    const header = { type: "session", version: 3, id: "agent_empty_1", cwd: "/tmp" };
    fs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, "utf-8");

    const result = checkSubagentCompletionOnDisk("agent_empty_1");
    expect(result.status).toBe("failed");
  });
});

describe("Native Pi UI & Widget Error Handling", () => {
  let prevDepth: string | undefined;

  beforeEach(() => {
    prevDepth = process.env.PI_SUBAGENT_DEPTH;
    process.env.PI_SUBAGENT_DEPTH = "0";
  });

  afterEach(() => {
    if (prevDepth !== undefined) process.env.PI_SUBAGENT_DEPTH = prevDepth;
    else delete process.env.PI_SUBAGENT_DEPTH;
  });

  it("renders failed subagent in PinnedSubagentsWidget with · N failed in header", () => {
    const tracker = new SubagentTracker();
    tracker.setDisplayMode("both");
    let capturedWidget: any = null;

    tracker.setUIContext({
      hasUI: true,
      ui: {
        setWidget: (_name: string, factory: any) => {
          capturedWidget = factory;
        },
        setStatus: () => {},
      },
    });

    tracker.registerStart({
      id: "agent-f1",
      task: "Failing task",
      isolated: true,
      logFile: "/tmp/f1.log",
    });

    const tracked = tracker.getActiveList()[0];
    tracked.status = "failed";

    const mockTheme = {
      fg: (_color: string, str: string) => str,
      bold: (str: string) => str,
      dim: (str: string) => str,
    };

    const widget = capturedWidget({ requestRender: () => {} }, mockTheme);
    const rendered = widget.render(80).join("\n");

    expect(rendered).toContain("1 failed");
    expect(rendered).not.toContain("1 done");

    // Also verify aborted counts as failed
    tracked.status = "aborted";
    const renderedAbort = widget.render(80).join("\n");
    expect(renderedAbort).toContain("1 failed");
    expect(renderedAbort).not.toContain("1 done");
  });

  it("renders Subagent failed header and uses toolErrorBg in renderSubagentResponseMessage", () => {
    let capturedBg: string | undefined;
    const mockTheme = {
      fg: (color: string, str: string) => `[${color}]${str}[/${color}]`,
      bold: (str: string) => `<b>${str}</b>`,
      bg: (color: string, str: string) => {
        capturedBg = color;
        return str;
      },
    };

    const failMessage = {
      content: "Error: Process exited with 1",
      details: {
        id: "sub_err",
        status: "failed",
        durationMs: 1200,
      },
    };

    const comp: any = renderSubagentResponseMessage(failMessage, { expanded: false }, mockTheme);
    comp.render(80);
    const text = comp.children?.[0]?.text || "";

    expect(text).toContain("Subagent failed");
    expect(capturedBg).toBe("toolErrorBg");

    const abortMessage = {
      content: "Aborted",
      details: {
        id: "sub_abort",
        status: "aborted",
        durationMs: 800,
      },
    };

    const compAbort: any = renderSubagentResponseMessage(abortMessage, { expanded: false }, mockTheme);
    compAbort.render(80);
    const textAbort = compAbort.children?.[0]?.text || "";

    expect(textAbort).toContain("Subagent aborted");
    expect(capturedBg).toBe("toolErrorBg");
  });
});

describe("Error Handling End-to-End & Buffer Separation", () => {
  let tmpDir: string;
  let prevBinPath: string | undefined;
  let prevDepth: string | undefined;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-e2e-test-"));
    prevBinPath = process.env.PI_BIN_PATH;
    prevDepth = process.env.PI_SUBAGENT_DEPTH;
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_SUBAGENT_DEPTH = "0";
    process.env.PI_CODING_AGENT_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevBinPath !== undefined) {
      process.env.PI_BIN_PATH = prevBinPath;
    } else {
      delete process.env.PI_BIN_PATH;
    }
    if (prevDepth !== undefined) {
      process.env.PI_SUBAGENT_DEPTH = prevDepth;
    } else {
      delete process.env.PI_SUBAGENT_DEPTH;
    }
    if (prevAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("prevents stderr diagnostics from corrupting partial stdout NDJSON chunks", async () => {
    const scriptPath = path.join(tmpDir, "interleaved-mock.mjs");
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
// 1. Partial stdout chunk
process.stdout.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Interleaved');

// 2. Immediate stderr chunk while stdout line is incomplete
process.stderr.write('\\x1b[33m[diagnostic warning]\\x1b[0m cache miss on session cwd\\n');

// 3. Complete the stdout line
process.stdout.write(' output success"}}\\n');

// 4. Send message_end and agent_end
const endMsg = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Interleaved output success" }],
    stopReason: "stop",
    usage: { input: 100, output: 50, cost: { total: 0.001 } }
  }
});
process.stdout.write(endMsg + '\\n');

const agentEnd = JSON.stringify({
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "Interleaved output success" }],
    stopReason: "stop",
    usage: { input: 100, output: 50, cost: { total: 0.001 } }
  }]
});
process.stdout.write(agentEnd + '\\n');
process.exit(0);
`,
      { mode: 0o755 }
    );

    process.env.PI_BIN_PATH = scriptPath;

    const res = await executeSubagent({
      task: "Interleaved test",
      cwd: tmpDir,
      background: false,
      isolated: false,
    });

    expect(res.details.status).toBe("completed");
    expect(res.details.summary).toBe("Interleaved output success");

    const logContent = fs.readFileSync(res.details.logFile, "utf-8");
    expect(logContent).toContain("[stderr] [diagnostic warning] cache miss on session cwd");
  });

  it("surfaces ENOENT spawn errors cleanly in foreground execution", async () => {
    process.env.PI_BIN_PATH = "/path/to/definitely/nonexistent_pi_bin_12345";

    const res = await executeSubagent({
      task: "Spawn error test",
      cwd: tmpDir,
      background: false,
      isolated: false,
    });

    expect(res.details.status).toBe("failed");
    expect(res.details.summary).toContain("Failed to spawn subagent process:");
    expect(res.details.summary).toContain("ENOENT");
  });

  it("surfaces ENOENT spawn errors cleanly in background execution", async () => {
    process.env.PI_BIN_PATH = "/path/to/definitely/nonexistent_pi_bin_12345";

    let bgCompletedResult: any = null;
    await new Promise<void>(async (resolve) => {
      await executeSubagent({
        task: "Spawn error bg test",
        cwd: tmpDir,
        background: true,
        isolated: false,
        onBackgroundComplete: (result) => {
          bgCompletedResult = result;
          resolve();
        },
      });
    });

    expect(bgCompletedResult).not.toBeNull();
    expect(bgCompletedResult.status).toBe("failed");
    expect(bgCompletedResult.summary).toContain("Failed to spawn subagent process:");
    expect(bgCompletedResult.summary).toContain("ENOENT");
  });

  it("includes partial assistant prose before failure in summary instead of hiding it", async () => {
    const scriptPath = path.join(tmpDir, "partial-fail-mock.mjs");
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const msg1 = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Analysis: Found critical vulnerability in auth.ts:42" }],
    stopReason: "stop"
  }
});
process.stdout.write(msg1 + '\\n');

const msgFail = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "Connection terminated unexpectedly by provider"
  }
});
process.stdout.write(msgFail + '\\n');

const agentEnd = JSON.stringify({
  type: "agent_end",
  messages: [
    { role: "assistant", content: [{ type: "text", text: "Analysis: Found critical vulnerability in auth.ts:42" }], stopReason: "stop" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection terminated unexpectedly by provider" }
  ]
});
process.stdout.write(agentEnd + '\\n');
process.exit(1);
`,
      { mode: 0o755 }
    );

    process.env.PI_BIN_PATH = scriptPath;

    const res = await executeSubagent({
      task: "Partial fail test",
      cwd: tmpDir,
      background: false,
      isolated: false,
    });

    expect(res.details.status).toBe("failed");
    expect(res.details.summary).toContain("Error: Connection terminated unexpectedly by provider");
    expect(res.details.summary).toContain("Partial output before failure:");
    expect(res.details.summary).toContain("Analysis: Found critical vulnerability in auth.ts:42");
  });

  it("returns native usage on foreground execute() and attaches usage to tool result", async () => {
    const scriptPath = path.join(tmpDir, "usage-mock.mjs");
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const msg = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "All operations done." }],
    stopReason: "stop",
    usage: {
      input: 500,
      output: 150,
      cacheRead: 2000,
      cacheWrite: 0,
      cost: { total: 0.005 }
    }
  }
});
process.stdout.write(msg + '\\n');

const agentEnd = JSON.stringify({
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "All operations done." }],
    stopReason: "stop",
    usage: {
      input: 500,
      output: 150,
      cacheRead: 2000,
      cacheWrite: 0,
      cost: { total: 0.005 }
    }
  }]
});
process.stdout.write(agentEnd + '\\n');
process.exit(0);
`,
      { mode: 0o755 }
    );

    process.env.PI_BIN_PATH = scriptPath;

    let registeredTool: any = null;
    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        registeredTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
    };

    opencodeSubagentsExtension(mockPi);

    const mockCtx = {
      cwd: tmpDir,
      hasUI: false,
    };

    const toolResult = await registeredTool.execute(
      "call_usage_run",
      { task: "Run with usage", background: false, isolated: false },
      undefined,
      undefined,
      mockCtx
    );

    expect(toolResult.isError).toBe(false);
    expect(toolResult.usage).toBeDefined();
    expect(toolResult.usage.input).toBe(500);
    expect(toolResult.usage.output).toBe(150);
    expect(toolResult.usage.cacheRead).toBe(2000);
    expect(toolResult.usage.totalTokens).toBe(2650);
    expect(toolResult.usage.cost.total).toBe(0.005);
  });

  it("returns isError: true synchronously on preflight model failure in background mode without double-delivering", async () => {
    let registeredTool: any = null;
    let sendMessageCount = 0;
    let sendUserMessageCount = 0;

    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        registeredTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
      sendMessage: () => {
        sendMessageCount++;
      },
      sendUserMessage: () => {
        sendUserMessageCount++;
      },
      events: { emit: () => {} },
    };

    opencodeSubagentsExtension(mockPi);

    const mockCtx = {
      cwd: tmpDir,
      hasUI: false,
      modelRegistry: {
        getAll: () => [
          { id: "gpt-4o", provider: "openai" },
          { id: "gpt-4o", provider: "azure" },
        ],
        hasConfiguredAuth: () => true,
      },
    };

    // Ambiguous model specification in background mode
    const toolResult = await registeredTool.execute(
      "call_preflight_bg",
      { task: "Test ambiguous model", model: "gpt-4o", background: true, isolated: false },
      undefined,
      undefined,
      mockCtx
    );

    expect(toolResult.isError).toBe(true);
    expect(toolResult.details.status).toBe("failed");
    expect(toolResult.details.errorMessage).toContain('Ambiguous model "gpt-4o"');
    expect(toolResult.content[0].text).toContain('Ambiguous model "gpt-4o"');

    // CRITICAL: Ensure no background callback fired and no double-delivery occurred into main chat
    expect(sendMessageCount).toBe(0);
    expect(sendUserMessageCount).toBe(0);
  });

  it("returns isError: true synchronously on preflight model failure in foreground mode", async () => {
    let registeredTool: any = null;
    const mockPi: any = {
      on: () => {},
      registerTool: (t: any) => {
        registeredTool = t;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
      events: { emit: () => {} },
    };

    opencodeSubagentsExtension(mockPi);

    const mockCtx = {
      cwd: tmpDir,
      hasUI: false,
      modelRegistry: {
        getAll: () => [{ id: "deepseek-coder", provider: "deepseek" }],
        hasConfiguredAuth: () => false, // Unauthenticated
      },
    };

    const toolResult = await registeredTool.execute(
      "call_preflight_fg",
      { task: "Test unauthenticated model", model: "deepseek-coder", background: false, isolated: false },
      undefined,
      undefined,
      mockCtx
    );

    expect(toolResult.isError).toBe(true);
    expect(toolResult.details.status).toBe("failed");
    expect(toolResult.details.errorMessage).toContain('No authentication configured for model "deepseek/deepseek-coder"');
  });

  it("cleans up temporary system prompt directory when subagent completes", async () => {
    const scriptPath = path.join(tmpDir, "explore-mock.mjs");
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const msg = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Exploration finished." }],
    stopReason: "stop"
  }
});
process.stdout.write(msg + '\\n');
process.exit(0);
`,
      { mode: 0o755 }
    );

    process.env.PI_BIN_PATH = scriptPath;

    // Run explore agent which has a non-empty system prompt (injecting via 0o600 temp file)
    const res = await executeSubagent({
      task: "Inspect directories",
      agent: "explore",
      cwd: tmpDir,
      isolated: false,
      background: false,
    });

    expect(res.details.status).toBe("completed");

    // Verify no pi-subagent-prompt-* directory was left orphaned
    const remainingTempDirs = fs
      .readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith("pi-subagent-prompt-"));
    expect(remainingTempDirs.length).toBe(0);
  });
});
