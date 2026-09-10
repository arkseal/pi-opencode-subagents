import { Text } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GRACE_PERIOD_MS = 3000;

export interface TrackedSubagent {
  id: string;
  task: string;
  description?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "aborted";
  currentLine?: string;
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
    };

    this.active.set(subagent.id, tracked);
    this.ensureTicker();
    this.updateWidget();
  }

  updatePeek(id: string, currentLine: string) {
    const item = this.active.get(id);
    if (item && item.status === "running") {
      item.currentLine = currentLine.trim();
      this.updateWidget();
    }
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
        `⚡ ${spinner} ${runningCount} subagent${runningCount > 1 ? "s" : ""} active`
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

        let titleStr = `⚡ Active Subagents (${runningCount} running`;
        if (completedCount > 0) {
          titleStr += ` · ${completedCount} completed`;
        }
        titleStr += ")";

        const lines: string[] = [];
        lines.push(
          `${theme.fg("toolTitle", "╭─ ")}${theme.fg("toolTitle", theme.bold(titleStr))} ${theme.fg("dim", "─".repeat(Math.max(10, 60 - titleStr.length)))}${theme.fg("toolTitle", "╮")}`
        );

        for (const s of items) {
          const elapsedSec = (
            ((s.endTime ?? Date.now()) - s.startTime) /
            1000
          ).toFixed(1);
          const title = s.description || (s.task.length > 40 ? `${s.task.slice(0, 37)}...` : s.task);

          if (s.status === "running") {
            const icon = spinner;
            const mode = s.isolated ? theme.fg("dim", "[isolated]") : theme.fg("warning", "[shared]");
            lines.push(
              `${theme.fg("toolTitle", "│")} ${icon} ${theme.fg("accent", `[${s.id}]`)} ${theme.bold(`"${title}"`)} · ${theme.fg("dim", `${elapsedSec}s`)} ${mode}`
            );

            if (s.currentLine) {
              const peek = s.currentLine.length > 70 ? `${s.currentLine.slice(0, 67)}...` : s.currentLine;
              lines.push(
                `${theme.fg("toolTitle", "│")}   ${theme.fg("muted", "↳")} ${theme.fg("dim", peek)}`
              );
            }
          } else if (s.status === "completed") {
            lines.push(
              `${theme.fg("toolTitle", "│")} ${theme.fg("success", "●")} ${theme.fg("dim", `[${s.id}]`)} ${theme.fg("toolTitle", `"${title}"`)} · ${theme.fg("success", `done in ${elapsedSec}s`)}`
            );
          } else {
            lines.push(
              `${theme.fg("toolTitle", "│")} ${theme.fg("error", "▲")} ${theme.fg("dim", `[${s.id}]`)} ${theme.fg("error", `"${title}"`)} · ${theme.fg("error", `failed (exit ${s.exitCode ?? 1})`)}`
            );
          }
        }

        lines.push(
          `${theme.fg("toolTitle", "╰" + "─".repeat(68) + "╯")}`
        );

        text.setText(lines.join("\n"));
        return text;
      },
      { placement: "belowEditor" }
    );
  }
}

export const globalSubagentTracker = new SubagentTracker();
