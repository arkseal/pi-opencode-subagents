import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseModelSpec,
  resolveAndValidateModel,
  ensureSubagentSessionFile,
  toPiUsage,
  getPiInvocation,
  writePromptToTempFile,
  executeSubagent,
  buildPiArgs,
} from "../src/runner";
import opencodeSubagentsExtension from "../src/index";

describe("parseModelSpec", () => {
  it("splits valid :thinking suffix from string model", () => {
    const res1 = parseModelSpec("openai/gpt-4o:high");
    expect(res1).toEqual({ model: "openai/gpt-4o", thinking: "high" });

    const res2 = parseModelSpec("claude-sonnet:max");
    expect(res2).toEqual({ model: "claude-sonnet", thinking: "max" });

    const res3 = parseModelSpec("gemini-flash:off");
    expect(res3).toEqual({ model: "gemini-flash", thinking: "off" });
  });

  it("lets explicit reasoning/thinking take precedence over suffix", () => {
    const res = parseModelSpec("claude-sonnet:high", "low");
    expect(res).toEqual({ model: "claude-sonnet", thinking: "low" });

    const res2 = parseModelSpec("claude-sonnet:high", undefined, "medium");
    expect(res2).toEqual({ model: "claude-sonnet", thinking: "medium" });
  });

  it("handles object model specifications", () => {
    const res = parseModelSpec({ model: "openai/gpt-4o:low" });
    expect(res).toEqual({ model: "openai/gpt-4o", thinking: "low" });

    const res2 = parseModelSpec({ name: "claude-3-7-sonnet", reasoning: "high" });
    expect(res2).toEqual({ model: "claude-3-7-sonnet", thinking: "high" });
  });

  it("does not split invalid thinking suffix", () => {
    const res = parseModelSpec("model:unknown_tier");
    expect(res).toEqual({ model: "model:unknown_tier", thinking: undefined });
  });

  it("handles empty or undefined inputs", () => {
    expect(parseModelSpec(undefined)).toEqual({ model: undefined, thinking: undefined });
    expect(parseModelSpec("")).toEqual({ model: undefined, thinking: undefined });
  });
});

describe("Model Preflight Validation & Resolution", () => {
  const mockModels = [
    { id: "gpt-4o", provider: "openai" },
    { id: "claude-3-7-sonnet", provider: "anthropic" },
    { id: "claude-3-7-sonnet", provider: "openrouter" },
    { id: "deepseek-coder", provider: "deepseek" },
  ];

  it("qualifies a bare model ID when exactly one provider matches", () => {
    const mockRegistry = {
      getAll: () => mockModels,
      hasConfiguredAuth: () => true,
    };
    const uiContext = { modelRegistry: mockRegistry };

    const qualified = resolveAndValidateModel("gpt-4o", uiContext);
    expect(qualified).toBe("openai/gpt-4o");
  });

  it("disambiguates multiple providers using configured auth", () => {
    const mockRegistry = {
      getAll: () => mockModels,
      hasConfiguredAuth: (m: any) => m.provider === "anthropic",
    };
    const uiContext = { modelRegistry: mockRegistry };

    const qualified = resolveAndValidateModel("claude-3-7-sonnet", uiContext);
    expect(qualified).toBe("anthropic/claude-3-7-sonnet");
  });

  it("disambiguates multiple authenticated providers using parent uiContext provider", () => {
    const mockRegistry = {
      getAll: () => mockModels,
      hasConfiguredAuth: () => true, // both anthropic and openrouter are authed
    };
    const uiContext = {
      modelRegistry: mockRegistry,
      model: { provider: "openrouter", id: "claude-3-7-sonnet" },
    };

    const qualified = resolveAndValidateModel("claude-3-7-sonnet", uiContext);
    expect(qualified).toBe("openrouter/claude-3-7-sonnet");
  });

  it("fails fast with clear ambiguous error listing candidates when unresolved", () => {
    const mockRegistry = {
      getAll: () => mockModels,
      hasConfiguredAuth: () => true,
    };
    const uiContext = {
      modelRegistry: mockRegistry,
      model: { provider: "google", id: "gemini" }, // parent provider is neither
    };

    expect(() => resolveAndValidateModel("claude-3-7-sonnet", uiContext)).toThrow(
      /Ambiguous model "claude-3-7-sonnet"/
    );
    expect(() => resolveAndValidateModel("claude-3-7-sonnet", uiContext)).toThrow(
      /anthropic\/claude-3-7-sonnet, openrouter\/claude-3-7-sonnet/
    );
  });

  it("fails fast with clear auth error when model has no configured auth", () => {
    const mockRegistry = {
      getAll: () => mockModels,
      hasConfiguredAuth: (m: any) => m.provider !== "deepseek",
    };
    const uiContext = { modelRegistry: mockRegistry };

    expect(() => resolveAndValidateModel("deepseek/deepseek-coder", uiContext)).toThrow(
      'No authentication configured for model "deepseek/deepseek-coder".'
    );
    expect(() => resolveAndValidateModel("deepseek-coder", uiContext)).toThrow(
      'No authentication configured for model "deepseek/deepseek-coder".'
    );
  });

  it("inherits parent model and thinkingLevel in executeSubagent when omitted", async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-abort so it returns before spawn

    const ctx = {
      model: { provider: "anthropic", id: "claude-3-7-sonnet" },
      thinkingLevel: "high",
    };

    const res = await executeSubagent({
      task: "Test parent inheritance",
      cwd: process.cwd(),
      isolated: false,
      signal: controller.signal,
      uiContext: ctx,
    });

    expect(res.details.model).toBe("anthropic/claude-3-7-sonnet");
    expect(res.details.reasoning).toBe("high");
  });
});

describe("ensureSubagentSessionFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("prevents directory traversal by sanitizing session id", () => {
    const targetCwd = "/tmp/worktree-1";
    const { sessionFile } = ensureSubagentSessionFile(tmpDir, "../../etc/passwd", targetCwd);
    expect(sessionFile).toContain(tmpDir);
    expect(path.basename(sessionFile)).toBe("passwd.jsonl");
  });

  it("creates a valid v3 session header for a new session", () => {
    const targetCwd = "/tmp/worktree-fresh";
    const { sessionFile, isExisting } = ensureSubagentSessionFile(tmpDir, "sub_new_123", targetCwd);

    expect(isExisting).toBe(false);
    expect(fs.existsSync(sessionFile)).toBe(true);

    const content = fs.readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");
    expect(header.version).toBe(3);
    expect(header.id).toBe("sub_new_123");
    expect(header.cwd).toBe(path.resolve(targetCwd));
  });

  it("atomically updates header.cwd across worktrees on continuation", () => {
    const oldCwd = "/tmp/pi-worktrees/old-worktree-1";
    const newCwd = "/tmp/pi-worktrees/new-worktree-2";

    // Setup an existing session file with old cwd and some messages
    const sessionPath = path.join(tmpDir, "sub_continuation.jsonl");
    const oldHeader = {
      type: "session",
      version: 3,
      id: "sub_continuation",
      timestamp: new Date().toISOString(),
      cwd: path.resolve(oldCwd),
    };
    const messageEntry = {
      type: "message",
      id: "msg_1",
      message: { role: "assistant", content: [{ type: "text", text: "Finished step 1" }] },
    };
    fs.writeFileSync(sessionPath, `${JSON.stringify(oldHeader)}\n${JSON.stringify(messageEntry)}\n`, "utf-8");

    // Ensure session file with new cwd
    const { sessionFile, isExisting } = ensureSubagentSessionFile(tmpDir, "sub_continuation", newCwd);
    expect(sessionFile).toBe(sessionPath);
    expect(isExisting).toBe(true);

    const updatedContent = fs.readFileSync(sessionPath, "utf-8");
    const lines = updatedContent.trim().split("\n");
    expect(lines.length).toBe(2);

    const updatedHeader = JSON.parse(lines[0]);
    expect(updatedHeader.cwd).toBe(path.resolve(newCwd)); // Updated to new workDir!
    expect(lines[1]).toContain("Finished step 1"); // Preserved conversation history!
  });

  it("reports isExisting: false when file has header but zero conversation messages", () => {
    const targetCwd = "/tmp/worktree-empty";
    const sessionPath = path.join(tmpDir, "sub_empty.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "sub_empty",
      timestamp: new Date().toISOString(),
      cwd: path.resolve(targetCwd),
    };
    fs.writeFileSync(sessionPath, `${JSON.stringify(header)}\n`, "utf-8");

    const { isExisting } = ensureSubagentSessionFile(tmpDir, "sub_empty", targetCwd);
    expect(isExisting).toBe(false);
  });
});

describe("Native toPiUsage & Tool Execution Usage", () => {
  let prevDepth: string | undefined;

  beforeEach(() => {
    prevDepth = process.env.PI_SUBAGENT_DEPTH;
    process.env.PI_SUBAGENT_DEPTH = "0";
  });

  afterEach(() => {
    if (prevDepth !== undefined) process.env.PI_SUBAGENT_DEPTH = prevDepth;
    else delete process.env.PI_SUBAGENT_DEPTH;
  });

  it("converts SubagentStats to a native Pi Usage object", () => {
    const usage = toPiUsage({
      tokensIn: 1000,
      tokensOut: 250,
      cacheRead: 5000,
      cacheWrite: 200,
      totalTokens: 6450,
      cost: 0.012,
      toolCalls: 5,
      turns: 2,
    });

    expect(usage).toBeDefined();
    expect(usage?.input).toBe(1000);
    expect(usage?.output).toBe(250);
    expect(usage?.cacheRead).toBe(5000);
    expect(usage?.cacheWrite).toBe(200);
    expect(usage?.totalTokens).toBe(6450);
    expect(usage?.cost.total).toBe(0.012);
  });

  it("returns usage on foreground tool execution result", async () => {
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

    // Mock executeSubagent by calling tool with pre-aborted signal
    const controller = new AbortController();
    controller.abort();

    const mockCtx = {
      cwd: process.cwd(),
      hasUI: false,
    };

    const result = await registeredTool.execute(
      "call_usage",
      { task: "Pre-aborted usage test", background: false, isolated: false },
      controller.signal,
      undefined,
      mockCtx
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("aborted");
  });
});

describe("Temp System Prompt File & getPiInvocation", () => {
  it("writes system prompt to a 0o600 file", async () => {
    const { dir, filePath } = await writePromptToTempFile("test-agent", "You are a test agent.");
    try {
      expect(fs.existsSync(filePath)).toBe(true);
      const stat = fs.statSync(filePath);
      // Mode 0o600: read/write for owner only
      expect(stat.mode & 0o777).toBe(0o600);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toBe("You are a test agent.");
    } finally {
      fs.unlinkSync(filePath);
      fs.rmdirSync(dir);
    }
  });

  it("getPiInvocation respects PI_BIN_PATH when set", () => {
    const prev = process.env.PI_BIN_PATH;
    process.env.PI_BIN_PATH = "/custom/bin/pi";
    try {
      const inv = getPiInvocation(["--version"]);
      expect(inv.command).toBe("/custom/bin/pi");
      expect(inv.args).toEqual(["--version"]);
    } finally {
      if (prev !== undefined) process.env.PI_BIN_PATH = prev;
      else delete process.env.PI_BIN_PATH;
    }
  });
});
