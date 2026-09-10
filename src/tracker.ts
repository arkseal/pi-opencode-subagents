import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GRACE_PERIOD_MS = 1500;

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

class PinnedSubagentsWidget implements Component {
  constructor(private tracker: SubagentTracker, private theme: any) {}

  invalidate() {}

  render(width: number): string[] {
    const items = this.tracker.getActiveList();
    if (items.length === 0) return [];

    const runningCount = items.filter((s) => s.status === "running").length;
    const completedCount = items.length - runningCount;
    const spinner = this.theme.fg("accent", SPINNER_FRAMES[this.tracker.getFrameIndex()]);

    const lines: string[] = [];
    const maxSafeWidth = Math.max(20, width - 4);

    const titlePrefix = " Subagents ";
    const countStr = `(${runningCount} running${completedCount > 0 ? ` · ${completedCount} done` : ""}) `;
    const headerPrefix = `${this.theme.fg("dim", "╭─")}${this.theme.bold(this.theme.fg("toolTitle", titlePrefix))}${this.theme.fg("accent", countStr)}`;
    const headerLen = visibleWidth(titlePrefix) + visibleWidth(countStr) + 2;
    const ruleDashes = Math.max(0, maxSafeWidth - headerLen);
    lines.push(`${headerPrefix}${this.theme.fg("dim", "─".repeat(ruleDashes))}`);

    for (const s of items) {
      const elapsedSec = (
        ((s.endTime ?? Date.now()) - s.startTime) /
        1000
      ).toFixed(1);

      const maxTitleLen = Math.max(12, Math.floor(maxSafeWidth * 0.4));
      const title = s.description || (s.task.length > maxTitleLen ? `${s.task.slice(0, maxTitleLen - 3)}...` : s.task);

      if (s.status === "running") {
        const icon = spinner;
        const mode = s.isolated ? this.theme.fg("dim", "[isolated]") : this.theme.fg("warning", "[shared]");
        const mainLine = `  ${icon} ${this.theme.fg("accent", `[${s.id}]`)} ${this.theme.bold(`"${title}"`)} · ${this.theme.fg("dim", `${elapsedSec}s`)} ${mode}`;
        lines.push(`${this.theme.fg("dim", "│")}${truncateToWidth(mainLine, maxSafeWidth)}`);

        if (s.currentLine) {
          const clean = stripTerminalSequences(s.currentLine.replace(/[\r\n\t]+/g, " ").trim());
          const peek = truncateToWidth(clean, maxSafeWidth - 6);
          lines.push(
            `${this.theme.fg("dim", "│")}   ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", peek)}`
          );
        }
      } else if (s.status === "completed") {
        const doneLine = `  ${this.theme.fg("success", "●")} ${this.theme.fg("dim", `[${s.id}]`)} ${this.theme.fg("toolTitle", `"${title}"`)} · ${this.theme.fg("success", `done in ${elapsedSec}s`)}`;
        lines.push(`${this.theme.fg("dim", "│")}${truncateToWidth(doneLine, maxSafeWidth)}`);
      } else {
        const failLine = `  ${this.theme.fg("error", "▲")} ${this.theme.fg("dim", `[${s.id}]`)} ${this.theme.fg("error", `"${title}"`)} · ${this.theme.fg("error", `failed (exit ${s.exitCode ?? 1})`)}`;
        lines.push(`${this.theme.fg("dim", "│")}${truncateToWidth(failLine, maxSafeWidth)}`);
      }
    }

    lines.push(this.theme.fg("dim", "╰" + "─".repeat(maxSafeWidth)));
    return lines;
  }
}

export class SubagentTracker {
  private active = new Map<string, TrackedSubagent>();
  private recent: TrackedSubagent[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private frameIndex = 0;
  private uiContext: any = null;
  private isWidgetMounted = false;
  private sidebarRegistered = false;

  setUIContext(ctx: any) {
    this.uiContext = ctx;
    this.ensureSidebarPanel();
  }

  getFrameIndex(): number {
    return this.frameIndex;
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

    this.ensureSidebarPanel();
    this.ensureWidgetMounted();
    this.ensureTicker();
    this.notifyRender();
  }

  updatePeek(
    id: string,
    currentLine: string,
    priority: "low" | "normal" | "high" = "normal",
    lingerMs = 0
  ) {
    const item = this.active.get(id);
    if (!item || item.status !== "running") return;

    const singleLine = currentLine.replace(/[\r\n\t]+/g, " ").trim();
    if (!singleLine) return;

    const now = Date.now();

    if (item.lingerUntil && now < item.lingerUntil) {
      if (priority === "low") {
        return;
      }
      if (item.currentPriority === "high" && priority === "normal") {
        const timeRemaining = item.lingerUntil - now;
        if (timeRemaining > 1200) {
          return;
        }
      }
    }

    item.currentLine = singleLine;
    item.currentPriority = priority;
    item.lingerUntil = lingerMs > 0 ? now + lingerMs : undefined;

    this.notifyRender();
  }

  registerFinish(id: string, result: { status: "completed" | "failed" | "aborted"; exitCode?: number; durationMs?: number }) {
    const item = this.active.get(id);
    if (item) {
      item.status = result.status;
      item.exitCode = result.exitCode;
      item.endTime = Date.now();
      item.durationMs = result.durationMs ?? (item.endTime - item.startTime);
      item.currentLine = result.status === "completed" ? "Done" : `Exited with code ${result.exitCode ?? 1}`;
      this.recent = [item, ...this.recent.filter((r) => r.id !== id)].slice(0, 10);
    }

    const hasRunning = Array.from(this.active.values()).some((s) => s.status === "running");
    if (!hasRunning) {
      this.stopTicker();
      this.notifyRender();

      if (this.clearTimer) clearTimeout(this.clearTimer);
      this.clearTimer = setTimeout(() => {
        this.active.clear();
        this.unmountWidget();
        this.notifyRender();
      }, GRACE_PERIOD_MS);
    } else {
      this.notifyRender();
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
      this.notifyRender();
    }, 150);
  }

  private stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private ensureWidgetMounted() {
    if (this.isWidgetMounted || !this.uiContext?.hasUI) return;
    try {
      this.uiContext.ui.setWidget(
        "subagents-pinned",
        (_tui: any, theme: any) => new PinnedSubagentsWidget(this, theme),
        { placement: "belowEditor" }
      );
      this.isWidgetMounted = true;
    } catch {}
  }

  private unmountWidget() {
    if (!this.uiContext?.hasUI) return;
    try {
      this.uiContext.ui.setWidget("subagents-pinned", undefined);
      this.uiContext.ui.setStatus("subagents", undefined);
      this.uiContext.ui.requestRender();
    } catch {}
    this.isWidgetMounted = false;
  }

  private notifyRender() {
    if (!this.uiContext?.hasUI) return;

    const items = Array.from(this.active.values());
    const runningCount = items.filter((s) => s.status === "running").length;

    // 1. Update footer status line
    if (runningCount > 0) {
      const spinner = SPINNER_FRAMES[this.frameIndex];
      this.uiContext.ui.setStatus(
        "subagents",
        `${spinner} ${runningCount} subagent${runningCount > 1 ? "s" : ""} active`
      );
    } else {
      this.uiContext.ui.setStatus("subagents", undefined);
    }

    // 2. Request a render of the existing widget without unmounting/remounting
    try {
      this.uiContext.ui.requestRender();
    } catch {}

    // 3. Notify sidebar if available
    try {
      const g = globalThis as any;
      if (typeof g.__PI_SIDEBAR_TUI__?.requestRender === "function") {
        g.__PI_SIDEBAR_TUI__.requestRender();
      }
    } catch {}
  }

  private ensureSidebarPanel() {
    if (this.sidebarRegistered) return;
    const g = globalThis as any;
    if (typeof g.__PI_SIDEBAR_TUI__?.registerPanel === "function") {
      try {
        g.__PI_SIDEBAR_TUI__.registerPanel({
          id: "subagents",
          order: 15,
          render: (_ctx: any, width: number) => {
            const items = Array.from(this.active.values());
            if (items.length === 0) return [];

            const running = items.filter((s) => s.status === "running").length;
            const completed = items.length - running;
            const lines: string[] = [];

            const safeW = Math.max(10, width - 2);
            lines.push(`Subagents (${running} active${completed > 0 ? `, ${completed} done` : ""})`);

            for (const s of items) {
              const elapsed = (((s.endTime ?? Date.now()) - s.startTime) / 1000).toFixed(1);
              const icon = s.status === "running" ? SPINNER_FRAMES[this.frameIndex] : s.status === "completed" ? "●" : "▲";
              const title = s.description || (s.task.length > 24 ? `${s.task.slice(0, 21)}...` : s.task);
              lines.push(truncateToWidth(`  ${icon} "${title}" (${elapsed}s)`, safeW));
              if (s.currentLine && s.status === "running") {
                const clean = s.currentLine.replace(/[\r\n\t]+/g, " ").trim();
                lines.push(truncateToWidth(`    ↳ ${clean}`, safeW));
              }
            }
            return lines;
          },
        });
        this.sidebarRegistered = true;
      } catch {}
    }
  }
}

export const globalSubagentTracker = new SubagentTracker();
