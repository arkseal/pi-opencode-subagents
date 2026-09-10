import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GRACE_PERIOD_MS = 3000;

class PinnedSubagentsWidget implements Component {
  constructor(
    private items: TrackedSubagent[],
    private runningCount: number,
    private completedCount: number,
    private frameIndex: number,
    private theme: any
  ) {}

  invalidate() {}

  render(width: number): string[] {
    const lines: string[] = [];
    const spinner = this.theme.fg("accent", SPINNER_FRAMES[this.frameIndex]);

    const titlePrefix = " Subagents ";
    const countStr = `(${this.runningCount} running${this.completedCount > 0 ? ` · ${this.completedCount} completed` : ""}) `;
    const headerPrefix = `${this.theme.fg("dim", "╭─")}${this.theme.bold(this.theme.fg("toolTitle", titlePrefix))}${this.theme.fg("accent", countStr)}`;
    const headerLen = visibleWidth(titlePrefix) + visibleWidth(countStr) + 2;
    const ruleDashes = Math.max(0, width - headerLen - 1);
    lines.push(`${headerPrefix}${this.theme.fg("dim", "─".repeat(ruleDashes))}`);

    for (const s of this.items) {
      const elapsedSec = (
        ((s.endTime ?? Date.now()) - s.startTime) /
        1000
      ).toFixed(1);

      // Dynamically budget title length based on available terminal width
      const maxTitleLen = Math.max(16, Math.floor(width * 0.45));
      const title = s.description || (s.task.length > maxTitleLen ? `${s.task.slice(0, maxTitleLen - 3)}...` : s.task);

      if (s.status === "running") {
        const icon = spinner;
        const mode = s.isolated ? this.theme.fg("dim", "[isolated]") : this.theme.fg("warning", "[shared]");
        const mainLine = `  ${icon} ${this.theme.fg("accent", `[${s.id}]`)} ${this.theme.bold(`"${title}"`)} · ${this.theme.fg("dim", `${elapsedSec}s`)} ${mode}`;
        lines.push(`${this.theme.fg("dim", "│")}${truncateToWidth(mainLine, width - 2)}`);

        if (s.currentLine) {
          const clean = stripTerminalSequences(s.currentLine.replace(/[\r\n\t]+/g, " ").trim());
          const truncated = truncateToWidth(clean, width - 8);
          lines.push(
            `${this.theme.fg("dim", "│")}   ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", truncated)}`
          );
        }
      } else if (s.status === "completed") {
        const doneLine = `  ${this.theme.fg("success", "●")} ${this.theme.fg("dim", `[${s.id}]`)} ${this.theme.fg("toolTitle", `"${title}"`)} · ${this.theme.fg("success", `done in ${elapsedSec}s`)}`;
        lines.push(`${this.theme.fg("dim", "│")}${truncateToWidth(doneLine, width - 2)}`);
      } else {
        const failLine = `  ${this.theme.fg("error", "▲")} ${this.theme.fg("dim", `[${s.id}]`)} ${this.theme.fg("error", `"${title}"`)} · ${this.theme.fg("error", `failed (exit ${s.exitCode ?? 1})`)}`;
        lines.push(`${this.theme.fg("dim", "│")}${truncateToWidth(failLine, width - 2)}`);
      }
    }

    lines.push(this.theme.fg("dim", "╰" + "─".repeat(Math.max(0, width - 1))));
    return lines;
  }
}

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
      (_tui: any, theme: any) =>
        new PinnedSubagentsWidget(items, runningCount, completedCount, this.frameIndex, theme),
      { placement: "belowEditor" }
    );
  }
}

export const globalSubagentTracker = new SubagentTracker();
