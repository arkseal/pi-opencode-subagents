import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorktree, cleanupWorktree } from "../src/worktree";

const execAsync = promisify(execFile);

describe("Git Worktree Isolation", () => {
  let mainRepo: string;

  beforeEach(async () => {
    mainRepo = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-repo-"));
    await execAsync("git", ["init", "-b", "main"], { cwd: mainRepo });
    await execAsync("git", ["config", "user.name", "Tester"], { cwd: mainRepo });
    await execAsync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo });
    await fs.writeFile(path.join(mainRepo, "base.txt"), "initial content\n");
    await execAsync("git", ["add", "."], { cwd: mainRepo });
    await execAsync("git", ["commit", "-m", "initial commit"], { cwd: mainRepo });
  });

  afterEach(async () => {
    await fs.rm(mainRepo, { recursive: true, force: true });
  });

  it("creates an isolated detached worktree at HEAD", async () => {
    const info = await createWorktree(mainRepo, "test1");
    expect(info).toBeDefined();
    expect(info!.path).toContain("test1");

    // Modify a file in the worktree
    await fs.writeFile(path.join(info!.path, "base.txt"), "modified in worktree\n");

    // Main repo must stay untouched
    const mainContent = await fs.readFile(path.join(mainRepo, "base.txt"), "utf-8");
    expect(mainContent).toBe("initial content\n");

    // Cleanup worktree
    const cleanup = await cleanupWorktree(mainRepo, info!, "completed task");
    expect(cleanup.hasChanges).toBe(true);
    expect(cleanup.branch).toBeDefined();
  });

  it("removes worktree cleanly when no changes were made", async () => {
    const info = await createWorktree(mainRepo, "test2");
    expect(info).toBeDefined();

    const cleanup = await cleanupWorktree(mainRepo, info!, "read only task");
    expect(cleanup.hasChanges).toBe(false);

    // Verify worktree folder was deleted
    expect(fs.stat(info!.path)).rejects.toThrow();
  });

  it("handles worktree creation from a nested subdirectory", async () => {
    const subDir = path.join(mainRepo, "nested", "subfolder");
    await fs.mkdir(subDir, { recursive: true });

    const info = await createWorktree(subDir, "test-nested");
    expect(info).toBeDefined();

    await fs.writeFile(path.join(info!.path, "nested-file.txt"), "sub contents");
    const cleanup = await cleanupWorktree(subDir, info!, "nested worktree task");
    expect(cleanup.hasChanges).toBe(true);
    expect(cleanup.branch).toBeDefined();
  });

  it("returns undefined cleanly for newly initialized repo with no commits", async () => {
    const emptyRepo = await fs.mkdtemp(path.join(os.tmpdir(), "empty-repo-"));
    await execAsync("git", ["init"], { cwd: emptyRepo });

    const info = await createWorktree(emptyRepo, "test-empty");
    expect(info).toBeUndefined();

    await fs.rm(emptyRepo, { recursive: true, force: true });
  });

  it("commits worktree changes even without repository user config", async () => {
    const noAuthorRepo = await fs.mkdtemp(path.join(os.tmpdir(), "no-author-repo-"));
    await execAsync("git", ["init", "-b", "main"], { cwd: noAuthorRepo });
    await fs.writeFile(path.join(noAuthorRepo, "file.txt"), "hello\n");
    // Initial commit with explicit flags
    await execAsync(
      "git",
      ["-c", "user.name=Initial", "-c", "user.email=init@test.local", "add", "."],
      { cwd: noAuthorRepo }
    );
    await execAsync(
      "git",
      ["-c", "user.name=Initial", "-c", "user.email=init@test.local", "commit", "-m", "init"],
      { cwd: noAuthorRepo }
    );

    const info = await createWorktree(noAuthorRepo, "test-no-author");
    expect(info).toBeDefined();

    await fs.writeFile(path.join(info!.path, "file.txt"), "updated in worktree\n");

    // cleanupWorktree should succeed using fallback author config
    const cleanup = await cleanupWorktree(noAuthorRepo, info!, "change without author");
    expect(cleanup.hasChanges).toBe(true);
    expect(cleanup.branch).toBeDefined();

    await fs.rm(noAuthorRepo, { recursive: true, force: true });
  });
});
