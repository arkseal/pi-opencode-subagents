import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { createWorktree, cleanupWorktree } from "./worktree.js";
import { formatSubagentEnvelope } from "./envelope.js";
import { checkSubagentDepth } from "./depth-guard.js";
import { globalSubagentTracker } from "./tracker.js";
import { SubagentEventParser } from "./event-parser.js";
import { resolveAgent, type AgentProfile } from "./agents.js";

export const activeSubagentProcesses = new Map<string, ChildProcess>();

export function stopSubagent(id: string): boolean {
  const child = activeSubagentProcesses.get(id);
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {}
    activeSubagentProcesses.delete(id);
    globalSubagentTracker.registerFinish(id, { status: "aborted", exitCode: 130 });
    return true;
  }
  return false;
}

export function stopAllSubagents(): number {
  let count = 0;
  for (const [id, child] of activeSubagentProcesses.entries()) {
    try {
      child.kill("SIGTERM");
    } catch {}
    globalSubagentTracker.registerFinish(id, { status: "aborted", exitCode: 130 });
    count++;
  }
  activeSubagentProcesses.clear();
  globalSubagentTracker.stopAll();
  return count;
}

export function getSubagentDir(): string {
  const homePiDir = path.join(os.homedir(), ".pi", "agent", "subagents");
  try {
    if (!fsSync.existsSync(homePiDir)) {
      fsSync.mkdirSync(homePiDir, { recursive: true });
    }
    return homePiDir;
  } catch {
    const tmpDir = path.join(os.tmpdir(), "pi-subagents");
    if (!fsSync.existsSync(tmpDir)) {
      fsSync.mkdirSync(tmpDir, { recursive: true });
    }
    return tmpDir;
  }
}

export function getSubagentSessionsDir(): string {
  const subagentDir = getSubagentDir();
  const sessionsDir = path.join(subagentDir, "sessions");
  if (!fsSync.existsSync(sessionsDir)) {
    try {
      fsSync.mkdirSync(sessionsDir, { recursive: true });
    } catch {}
  }
  return sessionsDir;
}

export interface SpawnSubagentOptions {
  task?: string;
  prompt?: string; // alias for task
  description?: string;
  agent?: string; // specialized agent (default "general", or "explore", etc.)
  sessionID?: string; // continue a previous child session
  background?: boolean; // background async execution (defaults to true)
  model?: string; // model override
  cwd: string;
  isolated?: boolean; // defaults to true
  currentDepth?: number; // defaults to 0
  onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: any }) => void;
  signal?: AbortSignal;
  uiContext?: any;
  onBackgroundComplete?: (result: {
    id: string;
    sessionID: string;
    status: string;
    durationMs: number;
    summary: string;
    stats?: any;
    logFile?: string;
    worktree?: any;
  }) => void;
}

export async function executeSubagent(options: SpawnSubagentOptions): Promise<{ output: string; details: any }> {
  checkSubagentDepth(options.currentDepth ?? 0);
  const subagentDir = getSubagentDir();
  const sessionsDir = getSubagentSessionsDir();

  const taskText = options.task || options.prompt || "";
  const isContinuation = Boolean(options.sessionID);
  const id = options.sessionID ?? `subagent_${randomUUID().slice(0, 8)}`;
  const logFile = path.join(subagentDir, `${id}.log`);
  const startTime = Date.now();

  const agentProfile: AgentProfile = await resolveAgent(options.agent, options.cwd);
  const effectiveModel = options.model ?? agentProfile.model;

  const isolated = options.isolated ?? true;
  let workDir = options.cwd;
  let worktreeInfo;

  if (isolated) {
    worktreeInfo = await createWorktree(options.cwd, id);
    if (worktreeInfo) {
      workDir = worktreeInfo.path;
    }
  }

  const logFd = fsSync.openSync(logFile, "a");

  let lastLine = "";
  let aborted = false;
  let lineBuffer = "";
  let lastAssistantText = "";
  const parser = new SubagentEventParser();

  // Assemble CLI arguments for the Pi subagent process
  const args = ["--mode", "json", "-p"];

  // Persistent session directory and session id for multi-turn continuation
  args.push("--session-dir", sessionsDir, "--session-id", id);

  // Model override
  if (effectiveModel) {
    args.push("--model", effectiveModel);
  }

  // Inject agent system prompt
  if (agentProfile.system) {
    args.push("--append-system-prompt", agentProfile.system);
  }

  // Tool whitelisting and exclusions based on agent profile
  if (agentProfile.tools && agentProfile.tools.length > 0) {
    args.push("--tools", agentProfile.tools.join(","));
  }
  if (agentProfile.excludeTools && agentProfile.excludeTools.length > 0) {
    args.push("--exclude-tools", agentProfile.excludeTools.join(","));
  }

  // Prompt prefix (for new sessions only, matching OpenCode semantics)
  const effectivePrompt = isContinuation
    ? taskText
    : ["You are a subagent spawned by another session.", taskText].join("\n");

  args.push("-a", effectivePrompt);

  const child = spawn("pi", args, {
    cwd: workDir,
    env: {
      ...process.env,
      PI_SUBAGENT_DEPTH: String((options.currentDepth ?? 0) + 1),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeSubagentProcesses.set(id, child);

  if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => {
        aborted = true;
        try {
          child.kill("SIGTERM");
        } catch {}
      },
      { once: true }
    );
  }

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    lineBuffer += text;

    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parser.parseLine(line);
      if (parsed) {
        if (parsed.peek) {
          lastLine = parsed.peek;
          globalSubagentTracker.updatePeek(id, lastLine, parsed.priority, parsed.lingerMs);
        }
        if (parsed.transcriptLine) {
          try {
            fsSync.writeSync(logFd, `${parsed.transcriptLine}\n`);
          } catch {}
        }
        if (parsed.finalAssistantText) {
          lastAssistantText = parsed.finalAssistantText;
        }
      } else if (!line.startsWith("{")) {
        const clean = line.replace(/[\r\n\t]+/g, " ").trim();
        lastLine = clean;
        globalSubagentTracker.updatePeek(id, lastLine, "normal", 1000);
        try {
          fsSync.writeSync(logFd, `${line}\n`);
        } catch {}
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  // Background Execution Mode (defaults to true: non-blocking)
  const isBackground = options.background !== false;
  if (isBackground) {
    globalSubagentTracker.registerStart({
      id,
      sessionID: id,
      task: taskText,
      description: options.description,
      agent: agentProfile.id,
      background: true,
      model: effectiveModel,
      isolated,
      logFile,
    });

    let finished = false;
    const finishOnce = async (code: number) => {
      if (finished) return;
      finished = true;
      activeSubagentProcesses.delete(id);
      try {
        fsSync.closeSync(logFd);
      } catch {}

      const durationMs = Date.now() - startTime;
      let summary = lastAssistantText;
      if (!summary) {
        try {
          const rawOutput = await fs.readFile(logFile, "utf-8");
          const lines = rawOutput.trim().split("\n");
          summary = lines.slice(-20).join("\n").trim() || "(Subagent finished with no output)";
        } catch {
          summary = `Subagent exited with code ${code}`;
        }
      }

      let cleanupDetails;
      if (worktreeInfo) {
        try {
          cleanupDetails = await cleanupWorktree(options.cwd, worktreeInfo, taskText);
        } catch {}
      }

      const status = aborted ? "aborted" : code === 0 ? "completed" : "failed";
      const stats = parser.getStats();

      try {
        globalSubagentTracker.registerFinish(id, {
          status,
          exitCode: code,
          durationMs,
          stats,
        });
      } catch {}

      const durationSec = (durationMs / 1000).toFixed(1);
      const title = options.description || (taskText.length > 30 ? `${taskText.slice(0, 27)}...` : taskText);
      try {
        options.uiContext?.ui?.notify?.(
          `Subagent [${id}] "${title}" ${status} in ${durationSec}s`,
          status === "completed" ? "info" : "error"
        );
      } catch {}

      try {
        options.onBackgroundComplete?.({
          id,
          sessionID: id,
          status,
          durationMs,
          summary,
          stats,
          logFile,
          worktree: worktreeInfo
            ? {
                path: worktreeInfo.path,
                branch: worktreeInfo.branch,
                hasChanges: cleanupDetails?.hasChanges,
              }
            : undefined,
        });
      } catch {}
    };

    child.on("exit", (code) => {
      void finishOnce(code ?? 0);
    });
    child.on("close", (code) => {
      void finishOnce(code ?? 0);
    });
    child.on("error", () => {
      void finishOnce(1);
    });

    return {
      output: [
        `The subagent is working in the background (sessionID: ${id}). You will be notified automatically when it finishes.`,
        "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
        "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
      ].join("\n"),
      details: {
        id,
        sessionID: id,
        status: "running",
        background: true,
        agent: agentProfile.id,
        task: taskText,
        description: options.description,
        logFile,
        isolated,
        model: effectiveModel,
      },
    };
  }

  // Foreground Execution Mode
  globalSubagentTracker.registerStart({
    id,
    sessionID: id,
    task: taskText,
    description: options.description,
    agent: agentProfile.id,
    background: false,
    model: effectiveModel,
    isolated,
    logFile,
  });

  const progressTimer = setInterval(() => {
    options.onUpdate?.({
      content: [{ type: "text", text: lastLine || "Subagent working..." }],
      details: {
        id,
        sessionID: id,
        agent: agentProfile.id,
        task: taskText,
        description: options.description,
        status: "running",
        elapsedMs: Date.now() - startTime,
        currentLine: lastLine,
        isolated,
        logFile,
        model: effectiveModel,
        stats: parser.getStats(),
      },
    });
  }, 100);

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => {
      activeSubagentProcesses.delete(id);
      clearInterval(progressTimer);
      try {
        fsSync.closeSync(logFd);
      } catch {}
      resolve(code ?? 1);
    });
    child.on("error", () => {
      activeSubagentProcesses.delete(id);
      clearInterval(progressTimer);
      try {
        fsSync.closeSync(logFd);
      } catch {}
      resolve(1);
    });
  });

  const durationMs = Date.now() - startTime;
  let summary = lastAssistantText;
  if (!summary) {
    try {
      const rawOutput = await fs.readFile(logFile, "utf-8");
      const lines = rawOutput.trim().split("\n");
      summary = lines.slice(-20).join("\n").trim() || "(Subagent finished with no output)";
    } catch {
      summary = `Subagent exited with code ${exitCode}`;
    }
  }

  let cleanupDetails;
  if (worktreeInfo) {
    cleanupDetails = await cleanupWorktree(options.cwd, worktreeInfo, taskText);
  }

  const status = aborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
  const stats = parser.getStats();

  globalSubagentTracker.registerFinish(id, {
    status,
    exitCode,
    durationMs,
    stats,
  });

  const envelope = formatSubagentEnvelope({
    id,
    sessionID: id,
    status,
    durationMs,
    summary,
    logFilePath: logFile,
    stats,
  });

  return {
    output: envelope,
    details: {
      id,
      sessionID: id,
      agent: agentProfile.id,
      task: taskText,
      description: options.description,
      status,
      exitCode,
      durationMs,
      logFile,
      isolated,
      model: effectiveModel,
      worktree: worktreeInfo
        ? {
            path: worktreeInfo.path,
            branch: worktreeInfo.branch,
            hasChanges: cleanupDetails?.hasChanges,
          }
        : undefined,
      cleanup: cleanupDetails,
      summary,
      stats,
    },
  };
}
