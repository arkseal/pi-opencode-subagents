import { Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GRACE_PERIOD_MS = 3000;
const BOX_WIDTH = 74;

export interface TrackedSubagent {
  id: string;
  task: string;
  description?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "aborted";
  currentLine?: string;
  currentPriority?: "low" | "normal" | "high";
  lingerUntil?: number;
  isolated: boolean;
  logFile: string;
  exitCode?: number;
}

export class SubagentTracker {
  private active = new Map<string, TrackedSubagent>();
  private recent: TrackedSubagent[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private frameIndex = 0;
  private uiContext: any = null;

  setUIContext(ctx: any) {
    this.uiContext = ctx;
  }

  registerStart(subagent: {
    id: string;
    task: string;
    description?: string;
    isolated: boolean;
    logFile: string;
  }) {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }

    const tracked: TrackedSubagent = {
      id: subagent.id,
      task: subagent.task,
      description: subagent.description,
      startTime: Date.now(),
      status: "running",
      isolated: subagent.isolated,
      logFile: subagent.logFile,
      currentLine: "Initializing subagent process...",
      currentPriority: "low",
    };

    this.active.set(subagent.id, tracked);
    this.ensureTicker();
    this.updateWidget();
  }

  updatePeek(
    id: string,
    currentLine: string,
    priority: "low" | "normal" | "high" = "normal",
    lingerMs = 0
  ) {
    const item = this.active.get(id);
    if (!item || item.status !== "running") return;

    // Strictly sanitize: replace any newlines, carriage returns, or tabs with single space
    const singleLine = currentLine.replace(/[\r\n\t]+/g, " ").trim();
    if (!singleLine) return;

    const now = Date.now();

    // If a higher or equal priority peek is currently lingering, honor its linger window
    if (item.lingerUntil && now < item.lingerUntil) {
      // Low priority (thinking, code generation deltas) cannot overwrite lingering messages
      if (priority === "low") {
        return;
      }
      // If current is HIGH (e.g. tool completed) and new is NORMAL (new tool start),
      // allow at least 1.2s before overriding so the user can read what just completed
      if (item.currentPriority === "high" && priority === "normal") {
        const timeRemaining = item.lingerUntil - now;
        if (timeRemaining > 1300) {
          return;
        }
      }
    }

    item.currentLine = singleLine;
    item.currentPriority = priority;
    item.lingerUntil = lingerMs > 0 ? now + lingerMs : undefined;
    this.updateWidget();
  }

  registerFinish(id: string, result: { status: "completed" | "failed" | "aborted"; exitCode?: number; durationMs?: number }) {
    const item = this.active.get(id);
    if (item) {
      item.status = result.status;
      item.exitCode = result.exitCode;
      item.endTime = Date.now();
      item.durationMs = result.durationMs ?? (item.endTime - item.startTime);
      item.currentLine = result.status === "completed" ? "Done" : `Exited with code ${result.exitCode ?? 1}`;

      // Move to recent list
      this.recent = [item, ...this.recent.filter((r) => r.id !== id)].slice(0, 10);
    }

    // Check if any subagents are still actively running
    const hasRunning = Array.from(this.active.values()).some((s) => s.status === "running");
    if (!hasRunning) {
      this.stopTicker();
      this.updateWidget();

      // Clear after grace period
      if (this.clearTimer) clearTimeout(this.clearTimer);
      this.clearTimer = setTimeout(() => {
        this.active.clear();
        this.clearWidget();
      }, GRACE_PERIOD_MS);
    } else {
      this.updateWidget();
    }
  }

  getActiveList(): TrackedSubagent[] {
    return Array.from(this.active.values());
  }

  getRecentList(): TrackedSubagent[] {
    return this.recent;
  }

  private ensureTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.updateWidget();
    }, 100);
  }

  private stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private clearWidget() {
    if (!this.uiContext?.hasUI) return;
    try {
      this.uiContext.ui.setWidget("subagents-pinned", undefined);
      this.uiContext.ui.setStatus("subagents", undefined);
    } catch {}
  }

  updateWidget() {
    if (!this.uiContext?.hasUI) return;

    const items = Array.from(this.active.values());
    if (items.length === 0) {
      this.clearWidget();
      return;
    }

    const runningCount = items.filter((s) => s.status === "running").length;
    const completedCount = items.length - runningCount;

    // 1. Update footer status indicator
    if (runningCount > 0) {
      const spinner = SPINNER_FRAMES[this.frameIndex];
      this.uiContext.ui.setStatus(
        "subagents",
        `${spinner} ${runningCount} subagent${runningCount > 1 ? "s" : ""} active`
      );
    } else {
      this.uiContext.ui.setStatus("subagents", undefined);
    }

    // 2. Render pinned widget below editor
    this.uiContext.ui.setWidget(
      "subagents-pinned",
      (_tui: any, theme: any) => {
        const text = new Text("", 0, 0);
        const spinner = theme.fg("accent", SPINNER_FRAMES[this.frameIndex]);
        const innerWidth = BOX_WIDTH - 2;

        let titleStr = ` Active Subagents (${runningCount} running`;
        if (completedCount > 0) {
          titleStr += ` · ${completedCount} completed`;
        }
        titleStr += ") ";

        const lines: string[] = [];
        const headerDashes = Math.max(0, innerWidth - visibleWidth(titleStr) - 1);
        lines.push(
          `${theme.fg("toolTitle", "╭─")}${theme.fg("toolTitle", theme.bold(titleStr))}${theme.fg("dim", "─".repeat(headerDashes))}${theme.fg("toolTitle", "╮")}`
        );

        for (const s of items) {
          const elapsedSec = (
            ((s.endTime ?? Date.now()) - s.startTime) /
            1000
          ).toFixed(1);
          const title = s.description || (s.task.length > 36 ? `${s.task.slice(0, 33)}...` : s.task);

          if (s.status === "running") {
            const icon = spinner;
            const mode = s.isolated ? theme.fg("dim", "[isolated]") : theme.fg("warning", "[shared]");
            const mainContent = ` ${icon} ${theme.fg("accent", `[${s.id}]`)} ${theme.bold(`"${title}"`)} · ${theme.fg("dim", `${elapsedSec}s`)} ${mode}`;
            const padMain = Math.max(0, innerWidth - visibleWidth(mainContent));
            lines.push(
              `${theme.fg("toolTitle", "│")}${mainContent}${" ".repeat(padMain)}${theme.fg("toolTitle", "│")}`
            );

            if (s.currentLine) {
              const clean = stripTerminalSequences(s.currentLine.replace(/[\r\n\t]+/g, " ").trim());
              const truncated = truncateToWidth(clean, innerWidth - 6);
              const peekContent = `   ${theme.fg("muted", "↳")} ${theme.fg("dim", truncated)}`;
              const padPeek = Math.max(0, innerWidth - visibleWidth(peekContent));
              lines.push(
                `${theme.fg("toolTitle", "│")}${peekContent}${" ".repeat(padPeek)}${theme.fg("toolTitle", "│")}`
              );
            }
          } else if (s.status === "completed") {
            const doneContent = ` ${theme.fg("success", "●")} ${theme.fg("dim", `[${s.id}]`)} ${theme.fg("toolTitle", `"${title}"`)} · ${theme.fg("success", `done in ${elapsedSec}s`)}`;
            const padDone = Math.max(0, innerWidth - visibleWidth(doneContent));
            lines.push(
              `${theme.fg("toolTitle", "│")}${doneContent}${" ".repeat(padDone)}${theme.fg("toolTitle", "│")}`
            );
          } else {
            const failContent = ` ${theme.fg("error", "▲")} ${theme.fg("dim", `[${s.id}]`)} ${theme.fg("error", `"${title}"`)} · ${theme.fg("error", `failed (exit ${s.exitCode ?? 1})`)}`;
            const padFail = Math.max(0, innerWidth - visibleWidth(failContent));
            lines.push(
              `${theme.fg("toolTitle", "│")}${failContent}${" ".repeat(padFail)}${theme.fg("toolTitle", "│")}`
            );
          }
        }

        lines.push(
          `${theme.fg("toolTitle", "╰" + "─".repeat(innerWidth) + "╯")}`
        );

        text.setText(lines.join("\n"));
        return text;
      },
      { placement: "belowEditor" }
    );
  }
}

export const globalSubagentTracker = new SubagentTracker();
