import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { createWorktree, cleanupWorktree, type WorktreeInfo } from "./worktree.js";
import { formatSubagentEnvelope } from "./envelope.js";
import { checkSubagentDepth } from "./depth-guard.js";
import { globalSubagentTracker } from "./tracker.js";
import { SubagentEventParser } from "./event-parser.js";
import { resolveAgent, type AgentProfile } from "./agents.js";

export interface ActiveSubagentHandle {
  id: string;
  child: ChildProcess;
  worktreeInfo?: WorktreeInfo;
  cwd: string;
  taskText: string;
  logFd?: number;
  logFile: string;
  abortHandler?: () => void;
  signal?: AbortSignal;
  isAborted?: boolean;
  suppressCallbacks?: boolean;
}

export const activeSubagentHandles = new Map<string, ActiveSubagentHandle>();
export const activeSubagentProcesses = new Map<string, ChildProcess>();

export async function waitForProcessExit(child: ChildProcess, timeoutMs = 2500): Promise<void> {
  if (!child || child.killed || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("close", done);
    child.once("exit", done);
    child.once("error", done);
  });
}

export function killProcessGroup(child: ChildProcess): void {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) return;

  try {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch {}

  const killTimeout = setTimeout(() => {
    try {
      if (!child.killed) {
        if (process.platform !== "win32") {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }
    } catch {}
  }, 2000);

  child.once("close", () => {
    clearTimeout(killTimeout);
  });
  if (typeof killTimeout.unref === "function") {
    killTimeout.unref();
  }
}

export function stopSubagent(id: string): boolean {
  const handle = activeSubagentHandles.get(id);
  const child = handle?.child ?? activeSubagentProcesses.get(id);
  if (!child && !handle) return false;

  if (handle) {
    handle.isAborted = true;
    handle.suppressCallbacks = true;
    if (handle.signal && handle.abortHandler) {
      handle.signal.removeEventListener("abort", handle.abortHandler);
    }
    if (handle.logFd !== undefined) {
      try {
        fsSync.closeSync(handle.logFd);
      } catch {}
      handle.logFd = undefined;
    }
    if (handle.worktreeInfo) {
      void cleanupWorktree(handle.cwd, handle.worktreeInfo, "aborted subagent").catch(() => {});
      handle.worktreeInfo = undefined;
    }
  }

  if (child) {
    killProcessGroup(child);
  }

  activeSubagentProcesses.delete(id);
  activeSubagentHandles.delete(id);
  globalSubagentTracker.registerFinish(id, { status: "aborted", exitCode: 130 });
  return true;
}

export async function shutdownSubagent(id: string, timeoutMs = 2500): Promise<boolean> {
  const handle = activeSubagentHandles.get(id);
  const child = handle?.child ?? activeSubagentProcesses.get(id);
  if (!child && !handle) return false;

  if (handle) {
    handle.isAborted = true;
    handle.suppressCallbacks = true;
    if (handle.signal && handle.abortHandler) {
      handle.signal.removeEventListener("abort", handle.abortHandler);
    }
    if (handle.logFd !== undefined) {
      try {
        fsSync.closeSync(handle.logFd);
      } catch {}
      handle.logFd = undefined;
    }
  }

  if (child && !child.killed && child.exitCode === null) {
    killProcessGroup(child);
    await waitForProcessExit(child, timeoutMs);
  }

  if (handle?.worktreeInfo) {
    try {
      await cleanupWorktree(handle.cwd, handle.worktreeInfo, "shutdown subagent");
    } catch {}
    handle.worktreeInfo = undefined;
  }

  activeSubagentProcesses.delete(id);
  activeSubagentHandles.delete(id);
  globalSubagentTracker.registerFinish(id, { status: "aborted", exitCode: 130 });
  return true;
}

export function stopAllSubagents(): number {
  let count = 0;
  const allIds = Array.from(new Set([...activeSubagentHandles.keys(), ...activeSubagentProcesses.keys()]));
  for (const id of allIds) {
    if (stopSubagent(id)) {
      count++;
    }
  }
  activeSubagentProcesses.clear();
  activeSubagentHandles.clear();
  globalSubagentTracker.stopAll();
  return count;
}

export async function shutdownAllSubagents(timeoutMs = 2500): Promise<number> {
  let count = 0;
  const allIds = Array.from(new Set([...activeSubagentHandles.keys(), ...activeSubagentProcesses.keys()]));
  await Promise.all(
    allIds.map(async (id) => {
      if (await shutdownSubagent(id, timeoutMs)) {
        count++;
      }
    })
  );
  activeSubagentProcesses.clear();
  activeSubagentHandles.clear();
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

export type SubagentModelOption =
  | string
  | {
      name?: string;
      model?: string;
      reasoning?: string;
      thinking?: string;
    };

export function buildPiArgs(options: {
  task: string;
  model?: string;
  reasoning?: string;
  thinking?: string;
}): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (options.model) {
    args.push("--model", options.model);
  }
  const thinking = options.reasoning ?? options.thinking;
  if (thinking) {
    args.push("--thinking", thinking);
  }
  args.push("-a", options.task);
  return args;
}

export interface SpawnSubagentOptions {
  cwd: string;
  isolated?: boolean;
  currentDepth?: number;
  task?: string;
  prompt?: string; // alias for task
  description?: string;
  agent?: string; // specialized agent (default "general", or "explore", etc.)
  sessionID?: string; // continue a previous child session
  background?: boolean; // background async execution (defaults to true)
  model?: SubagentModelOption;
  reasoning?: string;
  thinking?: string;
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
    model?: string;
    reasoning?: string;
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

  let modelName: string | undefined;
  let modelReasoning: string | undefined;
  if (typeof options.model === "string") {
    modelName = options.model;
  } else if (typeof options.model === "object" && options.model !== null) {
    modelName = options.model.name || options.model.model;
    modelReasoning = options.model.reasoning || options.model.thinking;
  }
  const thinking = options.reasoning ?? options.thinking ?? modelReasoning;

  const agentProfile: AgentProfile = await resolveAgent(options.agent, options.cwd);
  const effectiveModel = modelName ?? agentProfile.model;

  // Immediate abort check before allocating worktree or log file
  if (options.signal?.aborted) {
    const envelope = formatSubagentEnvelope({
      id,
      sessionID: id,
      status: "aborted",
      durationMs: 0,
      summary: "Subagent aborted before execution.",
      logFilePath: logFile,
      model: effectiveModel,
      reasoning: thinking,
    });
    return {
      output: envelope,
      details: {
        id,
        sessionID: id,
        agent: agentProfile.id,
        task: taskText,
        description: options.description,
        model: effectiveModel,
        reasoning: thinking,
        status: "aborted",
        exitCode: 130,
        durationMs: 0,
        logFile,
        isolated: false,
        summary: "Subagent aborted before execution.",
      },
    };
  }

  const isolatedRequested = options.isolated ?? true;
  let workDir = options.cwd;
  let worktreeInfo: WorktreeInfo | undefined;

  if (isolatedRequested) {
    worktreeInfo = await createWorktree(options.cwd, id);
    if (worktreeInfo) {
      workDir = worktreeInfo.path;
    }
  }

  const actuallyIsolated = Boolean(worktreeInfo);
  const initialLogSize = fsSync.existsSync(logFile) ? fsSync.statSync(logFile).size : 0;
  let logFd: number | undefined = fsSync.openSync(logFile, "a");

  let lastLine = "";
  let aborted = false;
  let lineBuffer = "";
  let lastAssistantText = "";
  let stderrText = "";
  const parser = new SubagentEventParser();

  // Assemble CLI arguments for the Pi subagent process
  const args = ["--mode", "json", "-p"];

  // Persistent session directory and session id for multi-turn continuation
  args.push("--session-dir", sessionsDir, "--session-id", id);

  // Model override
  if (effectiveModel) {
    args.push("--model", effectiveModel);
  }

  // Thinking / reasoning level
  if (thinking) {
    args.push("--thinking", thinking);
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

  const handle: ActiveSubagentHandle = {
    id,
    child,
    worktreeInfo,
    cwd: options.cwd,
    taskText,
    logFd,
    logFile,
    signal: options.signal,
  };

  activeSubagentProcesses.set(id, child);
  activeSubagentHandles.set(id, handle);

  const abortHandler = () => {
    aborted = true;
    handle.isAborted = true;
    killProcessGroup(child);
  };
  handle.abortHandler = abortHandler;

  if (options.signal) {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  const flushLineBuffer = () => {
    if (!lineBuffer.trim()) {
      lineBuffer = "";
      return;
    }
    const parsed = parser.parseLine(lineBuffer);
    if (parsed) {
      if (parsed.finalAssistantText) lastAssistantText = parsed.finalAssistantText;
      if (logFd !== undefined && parsed.transcriptLine) {
        try {
          fsSync.writeSync(logFd, `${parsed.transcriptLine}\n`);
        } catch {}
      }
    } else if (logFd !== undefined && !lineBuffer.startsWith("{")) {
      try {
        fsSync.writeSync(logFd, `${lineBuffer}\n`);
      } catch {}
    }
    lineBuffer = "";
  };

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
        if (parsed.transcriptLine && logFd !== undefined) {
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
        if (logFd !== undefined) {
          try {
            fsSync.writeSync(logFd, `${line}\n`);
          } catch {}
        }
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf-8");
    handleChunk(chunk);
  });

  const buildResultSummary = (code: number, exitStatus: string): string => {
    const stopReason = parser.getStopReason();
    const errorMsg = parser.getErrorMessage();

    if (exitStatus === "failed") {
      if (errorMsg) return `Error: ${errorMsg}`;
      if (lastAssistantText) return lastAssistantText;
      const stderrLines = stderrText
        .trim()
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (stderrLines.length > 0) {
        return `Error: ${stderrLines.slice(-5).join("\n")}`;
      }
      return stopReason ? `Subagent failed with stopReason: ${stopReason}` : `Subagent exited with code ${code}`;
    }

    if (lastAssistantText) return lastAssistantText;

    // Read only lines appended during this run from logFile
    try {
      if (fsSync.existsSync(logFile)) {
        const fileStat = fsSync.statSync(logFile);
        const readBytes = Math.max(0, fileStat.size - initialLogSize);
        if (readBytes > 0) {
          const buf = Buffer.alloc(readBytes);
          const fd = fsSync.openSync(logFile, "r");
          try {
            fsSync.readSync(fd, buf, 0, readBytes, initialLogSize);
            const rawOutput = buf.toString("utf-8");
            const lines = rawOutput.trim().split("\n").filter(Boolean);
            const humanLines = lines.filter((l) => !l.startsWith("{"));
            const tail = humanLines.slice(-10).join("\n").trim();
            if (tail) return tail;
          } finally {
            fsSync.closeSync(fd);
          }
        }
      }
    } catch {}

    return "(Subagent finished with no output)";
  };

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
      reasoning: thinking,
      isolated: actuallyIsolated,
      logFile,
    });

    let finished = false;
    const finishOnce = async (code: number) => {
      if (finished) return;
      finished = true;

      if (handle.suppressCallbacks) {
        return;
      }

      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      activeSubagentProcesses.delete(id);
      activeSubagentHandles.delete(id);

      flushLineBuffer();

      if (logFd !== undefined) {
        try {
          fsSync.closeSync(logFd);
        } catch {}
        logFd = undefined;
        handle.logFd = undefined;
      }

      const durationMs = Date.now() - startTime;
      const stopReason = parser.getStopReason();
      const errorMsg = parser.getErrorMessage();
      const hasErrorStop = stopReason === "error" || Boolean(errorMsg);
      const hasAbortedStop = stopReason === "aborted";

      const isSubagentAborted = aborted || handle.isAborted || hasAbortedStop;
      const status = isSubagentAborted ? "aborted" : (code === 0 && !hasErrorStop) ? "completed" : "failed";
      const effectiveExitCode = isSubagentAborted ? 130 : (hasErrorStop && code === 0) ? 1 : code;
      const summary = buildResultSummary(effectiveExitCode, status);

      let cleanupDetails;
      if (worktreeInfo) {
        try {
          cleanupDetails = await cleanupWorktree(options.cwd, worktreeInfo, taskText);
          handle.worktreeInfo = undefined;
        } catch {}
      }

      const stats = parser.getStats();

      try {
        globalSubagentTracker.registerFinish(id, {
          status,
          exitCode: effectiveExitCode,
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
          model: effectiveModel,
          reasoning: thinking,
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
        isolated: actuallyIsolated,
        model: effectiveModel,
        reasoning: thinking,
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
    reasoning: thinking,
    isolated: actuallyIsolated,
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
        model: modelName,
        reasoning: thinking,
        status: "running",
        elapsedMs: Date.now() - startTime,
        currentLine: lastLine,
        isolated: actuallyIsolated,
        logFile,
        stats: parser.getStats(),
      },
    });
  }, 100);

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => {
      activeSubagentProcesses.delete(id);
      activeSubagentHandles.delete(id);
      clearInterval(progressTimer);

      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      flushLineBuffer();

      if (logFd !== undefined) {
        try {
          fsSync.closeSync(logFd);
        } catch {}
        logFd = undefined;
        handle.logFd = undefined;
      }
      resolve(code ?? 1);
    });
    child.on("error", () => {
      activeSubagentProcesses.delete(id);
      activeSubagentHandles.delete(id);
      clearInterval(progressTimer);

      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      flushLineBuffer();

      if (logFd !== undefined) {
        try {
          fsSync.closeSync(logFd);
        } catch {}
        logFd = undefined;
        handle.logFd = undefined;
      }
      resolve(1);
    });
  });

  const durationMs = Date.now() - startTime;
  const stopReason = parser.getStopReason();
  const errorMsg = parser.getErrorMessage();
  const hasErrorStop = stopReason === "error" || Boolean(errorMsg);
  const hasAbortedStop = stopReason === "aborted";

  const isSubagentAborted = aborted || handle.isAborted || hasAbortedStop;
  const status = isSubagentAborted ? "aborted" : (exitCode === 0 && !hasErrorStop) ? "completed" : "failed";
  const effectiveExitCode = isSubagentAborted ? 130 : (hasErrorStop && exitCode === 0) ? 1 : exitCode;
  const summary = buildResultSummary(effectiveExitCode, status);

  let cleanupDetails;
  if (worktreeInfo) {
    try {
      cleanupDetails = await cleanupWorktree(options.cwd, worktreeInfo, taskText);
      handle.worktreeInfo = undefined;
    } catch {}
  }

  const stats = parser.getStats();

  globalSubagentTracker.registerFinish(id, {
    status,
    exitCode: effectiveExitCode,
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
    model: effectiveModel,
    reasoning: thinking,
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
      model: effectiveModel,
      reasoning: thinking,
      status,
      exitCode: isSubagentAborted ? 130 : exitCode,
      durationMs,
      logFile,
      isolated: actuallyIsolated,
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
