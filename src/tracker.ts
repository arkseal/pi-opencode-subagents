import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentStats } from "./event-parser.js";
import { loadSubagentSettings, saveSubagentSettings, type SubagentSettings, type SubagentDisplayMode } from "./config.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GRACE_PERIOD_MS = 1200;

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
  stats?: SubagentStats;
}

class PinnedSubagentsWidget implements Component {
  constructor(private tracker: SubagentTracker, private theme: any) {
    tracker.setTheme(theme);
  }

  invalidate() {}

  render(width: number): string[] {
    const items = this.tracker.getActiveList();
    if (items.length === 0) return [];

    const runningCount = items.filter((s) => s.status === "running").length;
    const completedCount = items.length - runningCount;
    const spinner = this.theme.fg("accent", SPINNER_FRAMES[this.tracker.getFrameIndex()]);

    const lines: string[] = [];
    // Keep a 2-column safety margin from the sidebar divider so the right border is 100% visible and never wraps
    const boxWidth = Math.max(25, width - 2);
    const innerContentWidth = boxWidth - 4;

    // 1. Top Border
    const titlePrefix = " Subagents ";
    const countStr = `(${runningCount} running${completedCount > 0 ? ` · ${completedCount} done` : ""}) `;
    const headerPrefix = `${this.theme.fg("dim", "╭─")}${this.theme.bold(this.theme.fg("toolTitle", titlePrefix))}${this.theme.fg("accent", countStr)}`;
    const headerLen = visibleWidth(titlePrefix) + visibleWidth(countStr);
    const ruleLen = Math.max(2, boxWidth - headerLen - 3);
    lines.push(`${headerPrefix}${this.theme.fg("dim", "─".repeat(ruleLen) + "╮")}`);

    // 2. Active / Completed Items
    for (const s of items) {
      const elapsedSec = (
        ((s.endTime ?? Date.now()) - s.startTime) /
        1000
      ).toFixed(1);

      const maxTitleLen = Math.max(12, Math.floor(innerContentWidth * 0.42));
      const title = s.description || (s.task.length > maxTitleLen ? `${s.task.slice(0, maxTitleLen - 3)}...` : s.task);

      if (s.status === "running") {
        const icon = spinner;
        const mode = s.isolated ? this.theme.fg("dim", "[isolated]") : this.theme.fg("warning", "[shared]");
        const mainLine = `  ${icon} ${this.theme.fg("accent", `[${s.id}]`)} ${this.theme.bold(`"${title}"`)} · ${this.theme.fg("dim", `${elapsedSec}s`)} ${mode}`;
        
        const truncated = truncateToWidth(mainLine, innerContentWidth);
        const padSpaces = Math.max(0, innerContentWidth - visibleWidth(truncated));
        lines.push(`${this.theme.fg("dim", "│")} ${truncated}${" ".repeat(padSpaces)} ${this.theme.fg("dim", "│")}`);

        if (s.currentLine) {
          const clean = stripTerminalSequences(s.currentLine.replace(/[\r\n\t]+/g, " ").trim());
          const peekText = `    ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", clean)}`;
          const truncatedPeek = truncateToWidth(peekText, innerContentWidth);
          const padPeek = Math.max(0, innerContentWidth - visibleWidth(truncatedPeek));
          lines.push(`${this.theme.fg("dim", "│")} ${truncatedPeek}${" ".repeat(padPeek)} ${this.theme.fg("dim", "│")}`);
        }
      } else if (s.status === "completed") {
        const doneLine = `  ${this.theme.fg("success", "●")} ${this.theme.fg("dim", `[${s.id}]`)} ${this.theme.fg("toolTitle", `"${title}"`)} · ${this.theme.fg("success", `done in ${elapsedSec}s`)}`;
        const truncated = truncateToWidth(doneLine, innerContentWidth);
        const padSpaces = Math.max(0, innerContentWidth - visibleWidth(truncated));
        lines.push(`${this.theme.fg("dim", "│")} ${truncated}${" ".repeat(padSpaces)} ${this.theme.fg("dim", "│")}`);
      } else {
        const failLine = `  ${this.theme.fg("error", "▲")} ${this.theme.fg("dim", `[${s.id}]`)} ${this.theme.fg("error", `"${title}"`)} · ${this.theme.fg("error", `failed (exit ${s.exitCode ?? 1})`)}`;
        const truncated = truncateToWidth(failLine, innerContentWidth);
        const padSpaces = Math.max(0, innerContentWidth - visibleWidth(truncated));
        lines.push(`${this.theme.fg("dim", "│")} ${truncated}${" ".repeat(padSpaces)} ${this.theme.fg("dim", "│")}`);
      }
    }

    // 3. Bottom Border (completely closed on both ends)
    lines.push(this.theme.fg("dim", "╰" + "─".repeat(Math.max(2, boxWidth - 2)) + "╯"));
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
  private theme: any = null;
  private settings: SubagentSettings = loadSubagentSettings();

  setTheme(theme: any) {
    this.theme = theme;
  }

  getDisplayMode(): SubagentDisplayMode {
    return this.settings.displayMode;
  }

  setDisplayMode(mode: SubagentDisplayMode) {
    this.settings.displayMode = mode;
    this.settings.sidebarEnabled = mode === "sidebar" || mode === "both";
    this.settings.widgetEnabled = mode === "input" || mode === "both";
    saveSubagentSettings(this.settings);

    // Update sidebar panel
    if (!this.settings.sidebarEnabled) {
      try {
        const g = globalThis as any;
        g.__PI_SIDEBAR_TUI__?.unregisterPanel?.("subagents");
        this.sidebarRegistered = false;
      } catch {}
    } else {
      this.ensureSidebarPanel();
    }

    // Update pinned widget above text input
    if (!this.settings.widgetEnabled) {
      this.unmountWidget();
    } else if (this.active.size > 0) {
      this.ensureWidgetMounted();
    }

    this.notifyRender();
  }

  cycleDisplayMode(): SubagentDisplayMode {
    const current = this.getDisplayMode();
    const nextMode: SubagentDisplayMode =
      current === "input" ? "sidebar" :
      current === "sidebar" ? "both" : "input";
    this.setDisplayMode(nextMode);
    return nextMode;
  }

  isSidebarEnabled(): boolean {
    return this.settings.sidebarEnabled;
  }

  setSidebarEnabled(enabled: boolean) {
    if (enabled) {
      this.setDisplayMode(this.settings.displayMode === "input" ? "both" : this.settings.displayMode);
    } else {
      this.setDisplayMode("input");
    }
  }

  isWidgetEnabled(): boolean {
    return this.settings.widgetEnabled;
  }

  setWidgetEnabled(enabled: boolean) {
    if (enabled) {
      this.setDisplayMode(this.settings.displayMode === "sidebar" ? "both" : this.settings.displayMode);
    } else {
      this.setDisplayMode("sidebar");
    }
  }

  setUIContext(ctx: any) {
    this.uiContext = ctx;
    this.ensureSidebarPanel();
  }

  getFrameIndex(): number {
    return Math.floor(Date.now() / 90) % SPINNER_FRAMES.length;
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

  registerFinish(id: string, result: { status: "completed" | "failed" | "aborted"; exitCode?: number; durationMs?: number; stats?: SubagentStats }) {
    const item = this.active.get(id);
    if (item) {
      item.status = result.status;
      item.exitCode = result.exitCode;
      item.endTime = Date.now();
      item.durationMs = result.durationMs ?? (item.endTime - item.startTime);
      item.currentLine = result.status === "completed" ? "Done" : `Exited with code ${result.exitCode ?? 1}`;
      if (result.stats) {
        item.stats = result.stats;
      }
      this.recent = [item, ...this.recent.filter((r) => r.id !== id)].slice(0, 15);
    }

    const hasRunning = Array.from(this.active.values()).some((s) => s.status === "running");
    if (!hasRunning) {
      this.stopTicker();
      this.notifyRender();

      // Grace period to show completion in the box before unmounting
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

  restoreRecent(items: TrackedSubagent[]) {
    const existingIds = new Set(this.recent.map((r) => r.id));
    const toAdd = items.filter((item) => !existingIds.has(item.id));
    this.recent = [...toAdd, ...this.recent].slice(0, 50);
  }

  getCumulativeStats(): {
    subagentCount: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
    toolCalls: number;
    turns: number;
  } {
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let toolCalls = 0;
    let turns = 0;
    let count = 0;

    const all = [...this.active.values(), ...this.recent];
    const seen = new Set<string>();
    for (const s of all) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      count++;
      if (s.stats) {
        tokensIn += s.stats.tokensIn;
        tokensOut += s.stats.tokensOut;
        cacheRead += s.stats.cacheRead;
        cacheWrite += s.stats.cacheWrite;
        cost += s.stats.cost ?? 0;
        toolCalls += s.stats.toolCalls;
        turns += s.stats.turns;
      }
    }

    return {
      subagentCount: count,
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
      totalTokens: tokensIn + tokensOut + cacheRead + cacheWrite,
      cost,
      toolCalls,
      turns,
    };
  }

  private ensureTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.frameIndex = Math.floor(Date.now() / 90) % SPINNER_FRAMES.length;
      this.notifyRender();
    }, 90);
  }

  private stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private ensureWidgetMounted() {
    if (!this.settings.widgetEnabled || this.isWidgetMounted || !this.uiContext?.hasUI) return;
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
    if (!this.settings.sidebarEnabled) return;
    if (this.sidebarRegistered) return;
    const g = globalThis as any;
    if (typeof g.__PI_SIDEBAR_TUI__?.registerPanel === "function") {
      try {
        g.__PI_SIDEBAR_TUI__.registerPanel({
          id: "subagents",
          order: 15,
          render: (_ctx: any, width: number) => {
            if (!this.settings.sidebarEnabled) return [];
            const items = Array.from(this.active.values());
            if (items.length === 0) return [];

            const running = items.filter((s) => s.status === "running").length;
            const completed = items.length - running;
            const lines: string[] = [];

            const safeW = Math.max(10, width - 2);

            // Styling helpers: prefer sidebar TUI api, then live pi theme, then ansi codes
            const sidebarAPI = g.__PI_SIDEBAR_TUI__;
            const fg = (color: string, str: string) => {
              if (typeof sidebarAPI?.fg === "function") return sidebarAPI.fg(color, str);
              if (typeof this.theme?.fg === "function") return this.theme.fg(color, str);
              if (color === "success") return `\x1b[32m${str}\x1b[39m`;
              if (color === "error") return `\x1b[31m${str}\x1b[39m`;
              if (color === "accent") return `\x1b[33m${str}\x1b[39m`;
              if (color === "dim") return `\x1b[2m${str}\x1b[22m`;
              return str;
            };
            const dim = (str: string) => fg("dim", str);
            const bold = (str: string) => {
              if (typeof sidebarAPI?.bold === "function") return sidebarAPI.bold(str);
              if (typeof this.theme?.bold === "function") return this.theme.bold(str);
              return `\x1b[1m${str}\x1b[22m`;
            };

            // Synchronize spinner frame with sidebar context if available, otherwise match 90ms clock
            const currentFrameIndex = _ctx?.spinnerFrame !== undefined
              ? ((_ctx.spinnerFrame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
              : this.getFrameIndex();
            const currentSpinner = SPINNER_FRAMES[currentFrameIndex];

            // Header line
            const countLabel = running > 0
              ? dim(` (${running} active${completed > 0 ? `, ${completed} done` : ""})`)
              : completed > 0
                ? fg("success", ` (${completed} done)`)
                : "";
            lines.push(bold(" Subagents") + countLabel);
            lines.push(dim("─".repeat(Math.max(0, safeW))));

            for (const s of items) {
              const elapsed = (((s.endTime ?? Date.now()) - s.startTime) / 1000).toFixed(1);
              const title = s.description || (s.task.length > 24 ? `${s.task.slice(0, 21)}...` : s.task);

              if (s.status === "running") {
                const icon = fg("accent", currentSpinner);
                lines.push(truncateToWidth(`  ${icon} ${bold(`"${title}"`)} ${dim(`(${elapsed}s)`)}`, safeW));
                if (s.currentLine) {
                  const clean = s.currentLine.replace(/[\r\n\t]+/g, " ").trim();
                  lines.push(truncateToWidth(`    ↳ ${dim(clean)}`, safeW));
                }
              } else if (s.status === "completed") {
                const icon = fg("success", "●");
                lines.push(truncateToWidth(`  ${icon} "${title}" · ${fg("success", `done in ${elapsed}s`)}`, safeW));
              } else {
                const icon = fg("error", "▲");
                lines.push(truncateToWidth(`  ${icon} ${fg("error", `"${title}"`)} · ${fg("error", `failed`)}`, safeW));
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
