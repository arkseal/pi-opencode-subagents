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

    const actualRoot = await git(repoRoot, ["rev-parse", "--show-toplevel"]);

    // Check if HEAD exists (empty repo check)
    let baseSha: string;
    try {
      baseSha = await git(actualRoot, ["rev-parse", "HEAD"]);
    } catch {
      // Empty repo with no commits yet - cannot create worktree from HEAD
      return undefined;
    }

    const branch = `subagent/${agentId}-${randomUUID().slice(0, 6)}`;
    const worktreePath = path.join(os.tmpdir(), "pi-worktrees", `${agentId}-${randomUUID().slice(0, 6)}`);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await git(actualRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"]);

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
  let root = repoRoot;
  try {
    root = await git(repoRoot, ["rev-parse", "--show-toplevel"]);
  } catch {}

  try {
    const status = await git(info.path, ["status", "--porcelain"]);
    if (status.length > 0) {
      hasChanges = true;
      await git(info.path, ["add", "-A"]);
      const safeMsg = commitMessage.trim()
        ? commitMessage.replace(/[\r\n]+/g, " ").slice(0, 120)
        : "automated changes";
      await git(info.path, [
        "-c",
        "user.name=Pi Subagent",
        "-c",
        "user.email=subagent@pi.local",
        "commit",
        "--no-verify",
        "-m",
        `subagent: ${safeMsg}`,
      ]);
      await git(info.path, ["branch", "-f", info.branch]);
    }

    await git(root, ["worktree", "remove", "--force", info.path]);
    await git(root, ["worktree", "prune"]);
  } catch {
    try {
      await fs.rm(info.path, { recursive: true, force: true });
      await git(root, ["worktree", "prune"]);
    } catch {}
  }

  return {
    hasChanges,
    branch: hasChanges ? info.branch : undefined,
    path: info.path,
  };
}
