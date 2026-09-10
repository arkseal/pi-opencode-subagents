import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  private frameIndex = 0;
  private uiContext: any = null;
  private sidebarRegistered = false;

  setUIContext(ctx: any) {
    this.uiContext = ctx;
    this.ensureSidebarPanel();
    // Clean up any stale legacy widget below the editor
    this.clearStaleWidget();
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
    this.clearStaleWidget();
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

    const singleLine = stripTerminalSequences(currentLine.replace(/[\r\n\t]+/g, " ").trim());
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
      this.recent = [item, ...this.recent.filter((r) => r.id !== id)].slice(0, 15);
      this.active.delete(id);
    }

    const hasRunning = Array.from(this.active.values()).some((s) => s.status === "running");
    if (!hasRunning) {
      this.stopTicker();
      this.clearStatus();
    }
    this.notifyRender();
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

  private clearStaleWidget() {
    if (!this.uiContext?.hasUI) return;
    try {
      this.uiContext.ui.setWidget("subagents-pinned", undefined);
    } catch {}
  }

  private clearStatus() {
    if (!this.uiContext?.hasUI) return;
    try {
      this.uiContext.ui.setStatus("subagents", undefined);
      this.uiContext.ui.requestRender();
    } catch {}
  }

  private notifyRender() {
    if (!this.uiContext?.hasUI) return;

    const runningCount = Array.from(this.active.values()).filter((s) => s.status === "running").length;

    // 1. Update native footer status line
    if (runningCount > 0) {
      const spinner = SPINNER_FRAMES[this.frameIndex];
      this.uiContext.ui.setStatus(
        "subagents",
        `${spinner} ${runningCount} subagent${runningCount > 1 ? "s" : ""} active`
      );
    } else {
      this.uiContext.ui.setStatus("subagents", undefined);
    }

    // 2. Request UI render
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
