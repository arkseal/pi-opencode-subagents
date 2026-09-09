import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branch?: string;
  path?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execAsync("git", args, { cwd });
  return stdout.trim();
}

export async function createWorktree(
  repoRoot: string,
  agentId: string
): Promise<WorktreeInfo | undefined> {
  try {
    const isGit = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (isGit !== "true") return undefined;

    const baseSha = await git(repoRoot, ["rev-parse", "HEAD"]);
    const branch = `subagent/${agentId}-${randomUUID().slice(0, 6)}`;
    const worktreePath = path.join(os.tmpdir(), "pi-worktrees", `${agentId}-${randomUUID().slice(0, 6)}`);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await git(repoRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"]);

    return { path: worktreePath, branch, baseSha };
  } catch {
    return undefined;
  }
}

export async function cleanupWorktree(
  repoRoot: string,
  info: WorktreeInfo,
  commitMessage: string
): Promise<WorktreeCleanupResult> {
  let hasChanges = false;
  try {
    const status = await git(info.path, ["status", "--porcelain"]);
    if (status.length > 0) {
      hasChanges = true;
      await git(info.path, ["add", "-A"]);
      await git(info.path, ["commit", "-m", `subagent: ${commitMessage.slice(0, 120)}`]);
      await git(info.path, ["branch", info.branch]);
    }

    await git(repoRoot, ["worktree", "remove", "--force", info.path]);
    await git(repoRoot, ["worktree", "prune"]);
  } catch {
    try {
      await fs.rm(info.path, { recursive: true, force: true });
      await git(repoRoot, ["worktree", "prune"]);
    } catch {}
  }

  return {
    hasChanges,
    branch: hasChanges ? info.branch : undefined,
    path: info.path,
  };
}
