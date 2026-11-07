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
  preserved?: boolean;
  error?: string;
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

  let branchCreated: string | undefined;

  try {
    const status = await git(info.path, ["status", "--porcelain"]);
    if (status.length > 0) {
      hasChanges = true;
      await git(info.path, ["add", "-A"]);
      const safeMsg = commitMessage.trim()
        ? commitMessage.replace(/[\r\n]+/g, " ").slice(0, 120)
        : "automated changes";

      const commitArgs = [
        "-c",
        "user.name=Pi Subagent",
        "-c",
        "user.email=subagent@pi.local",
        "commit",
        "-m",
        `subagent: ${safeMsg}`,
      ];

      // Try standard commit first to respect repository hooks
      let commitOk = false;
      try {
        await git(info.path, commitArgs);
        commitOk = true;
      } catch {
        // Fallback with --no-verify only if standard commit failed (e.g. strict pre-commit hook in subagent)
        try {
          await git(info.path, [...commitArgs.slice(0, 4), "--no-verify", ...commitArgs.slice(4)]);
          commitOk = true;
        } catch (commitErr: any) {
          // If commit failed, DO NOT remove the dirty worktree to prevent data loss!
          return {
            hasChanges: true,
            preserved: false,
            path: info.path,
            error: `Failed to commit worktree changes: ${commitErr?.message || String(commitErr)}. Worktree preserved at ${info.path}`,
          };
        }
      }

      if (commitOk) {
        // Create branch without -f to prevent overwriting existing branches
        let targetBranch = info.branch;
        try {
          await git(info.path, ["branch", targetBranch]);
          branchCreated = targetBranch;
        } catch {
          // If branch name collision, generate collision-free unique branch name
          targetBranch = `${info.branch}-${randomUUID().slice(0, 6)}`;
          try {
            await git(info.path, ["branch", targetBranch]);
            branchCreated = targetBranch;
          } catch (branchErr: any) {
            // If branch creation failed, DO NOT remove worktree to prevent data loss!
            return {
              hasChanges: true,
              preserved: false,
              path: info.path,
              error: `Failed to create branch for worktree: ${branchErr?.message || String(branchErr)}. Worktree preserved at ${info.path}`,
            };
          }
        }
      }
    }

    // Only clean up worktree if there were no changes, or changes were safely committed and branched
    await git(root, ["worktree", "remove", "--force", info.path]);
    await git(root, ["worktree", "prune"]);

    return {
      hasChanges,
      branch: branchCreated,
      path: info.path,
      preserved: true,
    };
  } catch (err: any) {
    if (hasChanges && !branchCreated) {
      // DO NOT delete dirty worktree on failed preservation!
      return {
        hasChanges: true,
        preserved: false,
        path: info.path,
        error: `Cleanup preservation error: ${err?.message || String(err)}. Worktree preserved at ${info.path}`,
      };
    }

    try {
      await fs.rm(info.path, { recursive: true, force: true });
      await git(root, ["worktree", "prune"]);
    } catch {}

    return {
      hasChanges,
      branch: branchCreated,
      path: info.path,
      preserved: Boolean(branchCreated) || !hasChanges,
    };
  }
}
