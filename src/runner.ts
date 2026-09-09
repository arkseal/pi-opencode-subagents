import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { createWorktree, cleanupWorktree } from "./worktree.js";
import { formatTaskResultEnvelope } from "./envelope.js";
import { checkSubagentDepth } from "./depth-guard.js";

const SUBAGENT_DIR = path.join(os.tmpdir(), "pi-subagents");

function ensureSubagentDir() {
  if (!fsSync.existsSync(SUBAGENT_DIR)) {
    fsSync.mkdirSync(SUBAGENT_DIR, { recursive: true });
  }
}

export interface SpawnSubagentOptions {
  task: string;
  cwd: string;
  isolated?: boolean; // defaults to true
  currentDepth?: number; // defaults to 0
}

export async function executeSubagent(options: SpawnSubagentOptions): Promise<{ output: string; details: any }> {
  checkSubagentDepth(options.currentDepth ?? 0);
  ensureSubagentDir();

  const id = `subagent_${randomUUID().slice(0, 8)}`;
  const logFile = path.join(SUBAGENT_DIR, `${id}.log`);
  const startTime = Date.now();

  const isolated = options.isolated ?? true;
  let workDir = options.cwd;
  let worktreeInfo;

  if (isolated) {
    worktreeInfo = await createWorktree(options.cwd, id);
    if (worktreeInfo) {
      workDir = worktreeInfo.path;
    }
  }

  // Spawn child pi process in the isolated working directory
  const logFd = fsSync.openSync(logFile, "a");

  const child = spawn(
    "pi",
    ["-p", "--no-session", options.task],
    {
      cwd: workDir,
      env: {
        ...process.env,
        PI_SUBAGENT_DEPTH: String((options.currentDepth ?? 0) + 1),
      },
      stdio: ["ignore", logFd, logFd],
    }
  );

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => {
      try {
        fsSync.closeSync(logFd);
      } catch {}
      resolve(code ?? 1);
    });
    child.on("error", () => {
      try {
        fsSync.closeSync(logFd);
      } catch {}
      resolve(1);
    });
  });

  const durationMs = Date.now() - startTime;
  let summary = "";
  try {
    const rawOutput = await fs.readFile(logFile, "utf-8");
    const lines = rawOutput.trim().split("\n");
    // Grab the last 20 lines of the child's output as the summary
    summary = lines.slice(-20).join("\n").trim() || "(Subagent finished with no output)";
  } catch {
    summary = `Subagent exited with code ${exitCode}`;
  }

  let cleanupDetails;
  if (worktreeInfo) {
    cleanupDetails = await cleanupWorktree(options.cwd, worktreeInfo, options.task);
  }

  const envelope = formatTaskResultEnvelope({
    id,
    status: exitCode === 0 ? "completed" : "failed",
    durationMs,
    summary,
    logFilePath: logFile,
  });

  return {
    output: envelope,
    details: {
      id,
      exitCode,
      durationMs,
      logFile,
      isolated,
      cleanup: cleanupDetails,
    },
  };
}
