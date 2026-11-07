import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  CONFIG_DIR_NAME,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createWorktree, cleanupWorktree, type WorktreeInfo } from "./worktree.js";
import { formatSubagentEnvelope } from "./envelope.js";
import { checkSubagentDepth } from "./depth-guard.js";
import { globalSubagentTracker } from "./tracker.js";
import { SubagentEventParser, type SubagentStats } from "./event-parser.js";
import { resolveAgent, type AgentProfile } from "./agents.js";

function safeGetAgentDir(): string {
  try {
    if (typeof getAgentDir === "function") {
      return getAgentDir();
    }
  } catch {}
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

async function safeWithFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  if (typeof withFileMutationQueue === "function") {
    return withFileMutationQueue(filePath, fn);
  }
  return fn();
}

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
  cleanupTempPrompt?: () => void;
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
    if (handle.cleanupTempPrompt) {
      handle.cleanupTempPrompt();
      handle.cleanupTempPrompt = undefined;
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
    if (handle.cleanupTempPrompt) {
      handle.cleanupTempPrompt();
      handle.cleanupTempPrompt = undefined;
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
  const homePiDir = path.join(safeGetAgentDir(), "subagents");
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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  if (process.env.PI_BIN_PATH) {
    return { command: process.env.PI_BIN_PATH, args };
  }
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fsSync.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

export async function writePromptToTempFile(
  agentName: string,
  prompt: string
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await safeWithFileMutationQueue(filePath, async () => {
    await fs.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

export function ensureSubagentSessionFile(
  sessionsDir: string,
  id: string,
  cwd: string
): { sessionFile: string; isExisting: boolean } {
  const sanitizedId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!sanitizedId || sanitizedId === "." || sanitizedId === "..") {
    throw new Error(`Invalid subagent session id: "${id}"`);
  }

  if (!fsSync.existsSync(sessionsDir)) {
    fsSync.mkdirSync(sessionsDir, { recursive: true });
  }

  const directFile = path.join(sessionsDir, `${sanitizedId}.jsonl`);
  let targetFile: string | null = null;

  if (fsSync.existsSync(directFile) && fsSync.statSync(directFile).size > 0) {
    targetFile = directFile;
  } else {
    try {
      const files = fsSync.readdirSync(sessionsDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        if (file === `${sanitizedId}.jsonl` || file.endsWith(`_${sanitizedId}.jsonl`)) {
          const fp = path.join(sessionsDir, file);
          if (fsSync.statSync(fp).size > 0) {
            targetFile = fp;
            break;
          }
        }
      }
      if (!targetFile) {
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const fp = path.join(sessionsDir, file);
          try {
            const fd = fsSync.openSync(fp, "r");
            const buf = Buffer.alloc(1024);
            const bytesRead = fsSync.readSync(fd, buf, 0, 1024, 0);
            fsSync.closeSync(fd);
            if (bytesRead > 0) {
              const firstLine = buf.toString("utf-8").split("\n")[0];
              const parsed = JSON.parse(firstLine);
              if (parsed?.type === "session" && (parsed.id === id || parsed.id === sanitizedId)) {
                targetFile = fp;
                break;
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  const resolvedCwd = path.resolve(cwd);

  if (targetFile) {
    const content = fsSync.readFileSync(targetFile, "utf-8");
    const lines = content.split("\n");
    const firstLine = lines[0]?.trim();
    if (firstLine) {
      try {
        const header = JSON.parse(firstLine);
        if (header && header.type === "session") {
          if (header.cwd !== resolvedCwd) {
            header.cwd = resolvedCwd;
            lines[0] = JSON.stringify(header);
            const tempFile = `${targetFile}.tmp.${randomUUID()}`;
            fsSync.writeFileSync(tempFile, lines.join("\n"), "utf-8");
            fsSync.renameSync(tempFile, targetFile);
          }
          const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
          const isExisting = nonEmptyLines.length > 1;
          return { sessionFile: targetFile, isExisting };
        }
      } catch {}
    }
  }

  const sessionFile = targetFile || directFile;
  const header = {
    type: "session",
    version: 3,
    id: sanitizedId,
    timestamp: new Date().toISOString(),
    cwd: resolvedCwd,
  };
  const tempFile = `${sessionFile}.tmp.${randomUUID()}`;
  fsSync.writeFileSync(tempFile, `${JSON.stringify(header)}\n`, "utf-8");
  fsSync.renameSync(tempFile, sessionFile);
  return { sessionFile, isExisting: false };
}

export type SubagentModelOption =
  | string
  | {
      name?: string;
      model?: string;
      reasoning?: string;
      thinking?: string;
    };

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseModelSpec(
  rawModel?: SubagentModelOption,
  rawReasoning?: string,
  rawThinking?: string
): { model?: string; thinking?: string } {
  let modelStr: string | undefined;
  let modelThinking: string | undefined;

  if (typeof rawModel === "string") {
    modelStr = rawModel.trim();
  } else if (typeof rawModel === "object" && rawModel !== null) {
    modelStr = (rawModel.model || rawModel.name)?.trim();
    modelThinking = rawModel.reasoning || rawModel.thinking;
  }

  let thinkingSuffix: string | undefined;
  if (modelStr) {
    const lastColon = modelStr.lastIndexOf(":");
    if (lastColon !== -1) {
      const suffix = modelStr.slice(lastColon + 1).toLowerCase();
      if (VALID_THINKING_LEVELS.has(suffix)) {
        modelStr = modelStr.slice(0, lastColon);
        thinkingSuffix = suffix;
      }
    }
  }

  const explicitThinking = rawReasoning ?? rawThinking ?? modelThinking;
  const thinking = explicitThinking ?? thinkingSuffix;

  return {
    model: modelStr || undefined,
    thinking: thinking || undefined,
  };
}

export function resolveAndValidateModel(
  model: string | undefined,
  uiContext?: any
): string | undefined {
  if (!model) return undefined;
  const modelRegistry = uiContext?.modelRegistry;
  if (!modelRegistry || typeof modelRegistry.getAll !== "function") {
    return model;
  }

  const allModels: Array<{ id: string; provider: string }> = modelRegistry.getAll();
  if (!Array.isArray(allModels) || allModels.length === 0) {
    return model;
  }

  const hasSlash = model.includes("/");
  let qualifiedModel = model;

  if (!hasSlash) {
    const bareLower = model.toLowerCase();
    const matching = allModels.filter((m) => m.id.toLowerCase() === bareLower);

    if (matching.length === 1) {
      const matched = matching[0];
      if (typeof modelRegistry.hasConfiguredAuth === "function" && !modelRegistry.hasConfiguredAuth(matched)) {
        throw new Error(`No authentication configured for model "${matched.provider}/${matched.id}".`);
      }
      qualifiedModel = `${matched.provider}/${matched.id}`;
    } else if (matching.length > 1) {
      let authedMatches = matching;
      if (typeof modelRegistry.hasConfiguredAuth === "function") {
        const authed = matching.filter((m) => modelRegistry.hasConfiguredAuth(m));
        if (authed.length > 0) {
          authedMatches = authed;
        }
      }

      if (authedMatches.length === 1) {
        const matched = authedMatches[0];
        qualifiedModel = `${matched.provider}/${matched.id}`;
      } else if (authedMatches.length > 1) {
        const parentProvider = uiContext?.model?.provider;
        const parentMatch = parentProvider
          ? authedMatches.find((m) => m.provider.toLowerCase() === parentProvider.toLowerCase())
          : undefined;

        if (parentMatch) {
          qualifiedModel = `${uiContext.model.provider}/${parentMatch.id}`;
        } else {
          const candidates = authedMatches.map((m) => `${m.provider}/${m.id}`).join(", ");
          throw new Error(
            `Ambiguous model "${model}". Multiple providers match: ${candidates}. Please specify "provider/model".`
          );
        }
      }
    }
  } else {
    const [prov, ...rest] = model.split("/");
    const id = rest.join("/");
    const matched = allModels.find(
      (m) => m.provider.toLowerCase() === prov.toLowerCase() && m.id.toLowerCase() === id.toLowerCase()
    );
    if (matched && typeof modelRegistry.hasConfiguredAuth === "function" && !modelRegistry.hasConfiguredAuth(matched)) {
      throw new Error(`No authentication configured for model "${matched.provider}/${matched.id}".`);
    }
  }

  return qualifiedModel;
}

export function toPiUsage(stats?: SubagentStats): Usage | undefined {
  if (!stats) return undefined;
  const input = stats.tokensIn ?? 0;
  const output = stats.tokensOut ?? 0;
  const cacheRead = stats.cacheRead ?? 0;
  const cacheWrite = stats.cacheWrite ?? 0;
  const totalTokens = stats.totalTokens ?? (input + output + cacheRead + cacheWrite);
  const cost = stats.cost ?? 0;

  if (totalTokens === 0 && cost === 0) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: totalTokens > 0 ? totalTokens : input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: cost,
    },
  };
}

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
  args.push("--", options.task);
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
    errorMessage?: string;
    worktree?: any;
  }) => void;
}

export async function executeSubagent(options: SpawnSubagentOptions): Promise<{ output: string; details: any }> {
  checkSubagentDepth(options.currentDepth ?? 0);
  const subagentDir = getSubagentDir();
  const sessionsDir = getSubagentSessionsDir();

  const taskText = options.task || options.prompt || "";
  const id = options.sessionID ?? `subagent_${randomUUID().slice(0, 8)}`;
  const logFile = path.join(subagentDir, `${id}.log`);
  const startTime = Date.now();

  const parsedOption = parseModelSpec(options.model, options.reasoning, options.thinking);
  const agentProfile: AgentProfile = await resolveAgent(options.agent, options.cwd);
  const parsedProfileModel = parseModelSpec(agentProfile.model);

  let effectiveModel = parsedOption.model ?? parsedProfileModel.model;
  let thinking = parsedOption.thinking ?? parsedProfileModel.thinking;

  if (!effectiveModel) {
    if (options.uiContext?.model) {
      effectiveModel = `${options.uiContext.model.provider}/${options.uiContext.model.id}`;
    }
    if (!thinking && options.uiContext?.thinkingLevel) {
      thinking = options.uiContext.thinkingLevel;
    }
  }

  // Preflight model validation (blocks invalid/ambiguous/unauthenticated models before worktree creation or spawning)
  try {
    effectiveModel = resolveAndValidateModel(effectiveModel, options.uiContext);
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const envelope = formatSubagentEnvelope({
      id,
      sessionID: id,
      status: "failed",
      durationMs: 0,
      summary: errorMsg,
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
        status: "failed",
        exitCode: 1,
        durationMs: 0,
        logFile,
        isolated: false,
        summary: errorMsg,
        errorMessage: errorMsg,
      },
    };
  }

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

  // Manage native session file with valid header and cwd matching current workDir
  const sessionInfo = ensureSubagentSessionFile(sessionsDir, id, workDir);
  const sessionFile = sessionInfo.sessionFile;
  const isContinuation = Boolean(options.sessionID && sessionInfo.isExisting);

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const cleanupTempPrompt = () => {
    if (tmpPromptPath) {
      try {
        fsSync.unlinkSync(tmpPromptPath);
      } catch {}
      tmpPromptPath = null;
    }
    if (tmpPromptDir) {
      try {
        fsSync.rmSync(tmpPromptDir, { recursive: true, force: true });
      } catch {}
      tmpPromptDir = null;
    }
  };

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let lastLine = "";
  let aborted = false;
  let lastAssistantText = "";
  let stderrText = "";
  let spawnError: string | undefined;
  const parser = new SubagentEventParser();

  // Assemble CLI arguments for the Pi subagent process
  const args = ["--mode", "json", "-p"];

  // Persistent session directory and concrete session file for multi-turn continuation
  args.push("--session-dir", sessionsDir, "--session", sessionFile);

  // Model override
  if (effectiveModel) {
    args.push("--model", effectiveModel);
  }

  // Thinking / reasoning level
  if (thinking) {
    args.push("--thinking", thinking);
  }

  // Inject agent system prompt via 0o600 temp file
  if (agentProfile.system && agentProfile.system.trim()) {
    try {
      const tmpPrompt = await writePromptToTempFile(agentProfile.name || agentProfile.id, agentProfile.system);
      tmpPromptDir = tmpPrompt.dir;
      tmpPromptPath = tmpPrompt.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    } catch (err) {
      cleanupTempPrompt();
      if (worktreeInfo) {
        await cleanupWorktree(options.cwd, worktreeInfo, "prompt temp file creation error").catch(() => {});
      }
      throw err;
    }
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

  args.push("--", effectivePrompt);

  const invocation = getPiInvocation(args);
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: workDir,
      env: {
        ...process.env,
        PI_SUBAGENT_DEPTH: String((options.currentDepth ?? 0) + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    cleanupTempPrompt();
    if (logFd !== undefined) {
      try {
        fsSync.closeSync(logFd);
      } catch {}
      logFd = undefined;
    }
    if (worktreeInfo) {
      await cleanupWorktree(options.cwd, worktreeInfo, "spawn failed").catch(() => {});
    }
    throw err;
  }

  const handle: ActiveSubagentHandle = {
    id,
    child,
    worktreeInfo,
    cwd: options.cwd,
    taskText,
    logFd,
    logFile,
    signal: options.signal,
    cleanupTempPrompt,
  };

  activeSubagentProcesses.set(id, child);
  activeSubagentHandles.set(id, handle);

  const abortHandler = () => {
    aborted = true;
    handle.isAborted = true;
    cleanupTempPrompt();
    killProcessGroup(child);
  };
  handle.abortHandler = abortHandler;

  if (options.signal) {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  const processStdoutLine = (line: string) => {
    if (!line.trim()) return;
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
  };

  const handleStdoutChunk = (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf-8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      processStdoutLine(line);
    }
  };

  const handleStderrChunk = (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf-8");
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const clean = stripTerminalSequences(rawLine.replace(/[\r\n\t]+/g, " ").trim());
      if (!clean) continue;
      stderrText += (stderrText ? "\n" : "") + clean;
      if (logFd !== undefined) {
        try {
          fsSync.writeSync(logFd, `[stderr] ${clean}\n`);
        } catch {}
      }
      lastLine = clean;
      globalSubagentTracker.updatePeek(id, lastLine, "normal", 1500);
    }
  };

  const flushBuffers = () => {
    if (stdoutBuffer.trim()) {
      processStdoutLine(stdoutBuffer);
      stdoutBuffer = "";
    }
    if (stderrBuffer.trim()) {
      const clean = stripTerminalSequences(stderrBuffer.replace(/[\r\n\t]+/g, " ").trim());
      if (clean) {
        stderrText += (stderrText ? "\n" : "") + clean;
        if (logFd !== undefined) {
          try {
            fsSync.writeSync(logFd, `[stderr] ${clean}\n`);
          } catch {}
        }
        lastLine = clean;
        globalSubagentTracker.updatePeek(id, lastLine, "normal", 1500);
      }
      stderrBuffer = "";
    }
  };

  child.stdout?.on("data", handleStdoutChunk);
  child.stderr?.on("data", handleStderrChunk);

  const buildResultSummary = (code: number, exitStatus: string): string => {
    const stopReason = parser.getStopReason();
    const errorMsg = parser.getErrorMessage();

    if (exitStatus === "failed" || exitStatus === "aborted") {
      let reason: string;
      if (spawnError) {
        reason = `Failed to spawn subagent process: ${spawnError}`;
      } else if (errorMsg) {
        reason = `Error: ${errorMsg}`;
      } else {
        const stderrLines = stderrText
          .trim()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (stderrLines.length > 0) {
          reason = `Error: ${stderrLines.slice(-5).join("\n")}`;
        } else if (stopReason) {
          reason = `Subagent ${exitStatus} with stopReason: ${stopReason}`;
        } else {
          reason = `Subagent exited with code ${code}`;
        }
      }

      if (lastAssistantText && lastAssistantText.trim()) {
        return `${reason}\n\nPartial output before failure:\n${lastAssistantText.trim()}`;
      }
      return reason;
    }

    if (lastAssistantText && lastAssistantText.trim()) {
      return lastAssistantText.trim();
    }

    if (parser.getStats().toolCalls > 0) {
      const calls = parser.getStats().toolCalls;
      return `(Subagent completed ${calls} tool call${calls === 1 ? "" : "s"} with no final text response)`;
    }

    // Read only human prose lines appended during this run from logFile
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
            const humanLines = lines.filter(
              (l) =>
                !l.startsWith("{") &&
                !l.startsWith("-> [tool]") &&
                !l.startsWith("<- [tool]") &&
                !l.startsWith("[stderr]")
            );
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

      cleanupTempPrompt();

      if (handle.suppressCallbacks) {
        return;
      }

      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      activeSubagentProcesses.delete(id);
      activeSubagentHandles.delete(id);

      flushBuffers();

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
      const hasErrorStop = stopReason === "error" || Boolean(errorMsg) || Boolean(spawnError);
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
          errorMessage: spawnError ? `Failed to spawn subagent process: ${spawnError}` : (errorMsg || (status === "failed" ? summary : undefined)),
          summary,
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
          errorMessage: spawnError ? `Failed to spawn subagent process: ${spawnError}` : errorMsg,
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
    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
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
        model: effectiveModel,
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

      flushBuffers();
      cleanupTempPrompt();

      if (logFd !== undefined) {
        try {
          fsSync.closeSync(logFd);
        } catch {}
        logFd = undefined;
        handle.logFd = undefined;
      }
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
      activeSubagentProcesses.delete(id);
      activeSubagentHandles.delete(id);
      clearInterval(progressTimer);

      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      flushBuffers();
      cleanupTempPrompt();

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
  const hasErrorStop = stopReason === "error" || Boolean(errorMsg) || Boolean(spawnError);
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
    errorMessage: spawnError ? `Failed to spawn subagent process: ${spawnError}` : (errorMsg || (status === "failed" ? summary : undefined)),
    summary,
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
      exitCode: isSubagentAborted ? 130 : effectiveExitCode,
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
