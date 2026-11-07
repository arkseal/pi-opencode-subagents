import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentStats } from "./event-parser.js";
import { loadSubagentSettings, saveSubagentSettings, type SubagentSettings, type SubagentDisplayMode } from "./config.js";
import { activeSubagentProcesses, getSubagentDir, getSubagentSessionsDir } from "./runner.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GRACE_PERIOD_MS = 1200;

/**
 * Reconciles subagent status on disk when process is no longer alive.
 * Checks whether the subagent's session JSONL or log file contains a completed response.
 */
export function checkSubagentCompletionOnDisk(
  id: string,
  logFilePath?: string
): {
  status: "completed" | "failed" | "aborted" | "running";
  errorMessage?: string;
  stats?: SubagentStats;
  durationMs?: number;
} {
  try {
    const sessionsDir = getSubagentSessionsDir();
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir);
      const match = files.find(
        (f) => (f === `${id}.jsonl` || f.endsWith(`_${id}.jsonl`) || f.includes(id)) && f.endsWith(".jsonl")
      );
      if (match) {
        const fullPath = path.join(sessionsDir, match);
        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const entries = lines
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        const assistantEntries = entries.filter(
          (e) => e.type === "message" && e.message?.role === "assistant"
        );

        if (assistantEntries.length > 0) {
          const lastEntry = assistantEntries[assistantEntries.length - 1];
          const lastMsg = lastEntry.message;
          if (lastMsg?.stopReason === "error") {
            return {
              status: "failed",
              errorMessage: lastMsg.errorMessage || "Subagent assistant error",
            };
          }
          if (lastMsg?.stopReason === "aborted") {
            return { status: "aborted" };
          }
          const hasCompletedContent =
            lastMsg?.content?.some(
              (c: any) => (c.type === "text" && c.text) || c.type === "toolCall"
            ) ||
            lastMsg?.stopReason === "stop" ||
            lastMsg?.stopReason === "toolUse";
          if (hasCompletedContent) {
            return { status: "completed" };
          }
        }

        return { status: "failed" };
      }
    }
  } catch {}

  return { status: "running" };
}

export interface TrackedSubagent {
  id: string;
  sessionID?: string;
  task: string;
  description?: string;
  agent?: string;
  background?: boolean;
  model?: string;
  reasoning?: string;
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
  errorMessage?: string;
  summary?: string;
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
    const completedCount = items.filter((s) => s.status === "completed").length;
    const failedCount = items.filter((s) => s.status === "failed" || s.status === "aborted").length;
    const spinner = this.theme.fg("accent", SPINNER_FRAMES[this.tracker.getFrameIndex()]);

    const lines: string[] = [];
    const boxWidth = Math.max(25, width - 2);

    // 1. Clean Top Divider
    const title = "Subagents";
    const countParts: string[] = [`${runningCount} running`];
    if (completedCount > 0) countParts.push(`${completedCount} done`);
    if (failedCount > 0) countParts.push(`${failedCount} failed`);
    const countStr = `(${countParts.join(" · ")})`;
    const header = `${this.theme.bold(this.theme.fg("accent", title))} ${this.theme.fg("muted", countStr)}`;
    const lineLen = Math.max(2, boxWidth - visibleWidth(header) - 3);
    lines.push(`${this.theme.fg("dim", "──")} ${header} ${this.theme.fg("dim", "─".repeat(lineLen))}`);

    // 2. Active / Completed Items
    for (const s of items) {
      const elapsedSec = (
        ((s.endTime ?? Date.now()) - s.startTime) /
        1000
      ).toFixed(1);

      const maxTitleLen = Math.max(12, Math.floor(boxWidth * 0.45));
      const title = s.description || (s.task.length > maxTitleLen ? `${s.task.slice(0, maxTitleLen - 3)}...` : s.task);
      const agentTag = s.agent && s.agent !== "general" ? ` ${this.theme.fg("accent", `[${s.agent}]`)}` : "";

      if (s.status === "running") {
        const icon = spinner;
        const mode = s.isolated ? this.theme.fg("dim", "[isolated]") : this.theme.fg("warning", "[shared]");
        const bgTag = s.background ? ` ${this.theme.fg("dim", "[bg]")}` : "";
        const modelBadge = s.model ? ` ${this.theme.fg("dim", `[${s.model}]`)}` : (s.reasoning ? ` ${this.theme.fg("dim", `[reasoning:${s.reasoning}]`)}` : "");
        const mainLine = `  ${icon} ${this.theme.fg("accent", `[${s.id}]`)}${agentTag} ${this.theme.bold(`"${title}"`)} · ${this.theme.fg("dim", `${elapsedSec}s`)} ${mode}${bgTag}${modelBadge}`;
        lines.push(truncateToWidth(mainLine, boxWidth));

        if (s.currentLine) {
          const clean = stripTerminalSequences(s.currentLine.replace(/[\r\n\t]+/g, " ").trim());
          const peekText = `    ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", clean)}`;
          lines.push(truncateToWidth(peekText, boxWidth));
        }
      } else if (s.status === "completed") {
        const doneLine = `  ${this.theme.fg("success", "●")} ${this.theme.fg("dim", `[${s.id}]`)}${agentTag} ${this.theme.fg("toolTitle", `"${title}"`)} · ${this.theme.fg("success", `done in ${elapsedSec}s`)}`;
        lines.push(truncateToWidth(doneLine, boxWidth));
      } else {
        const failLine = `  ${this.theme.fg("error", "▲")} ${this.theme.fg("dim", `[${s.id}]`)}${agentTag} ${this.theme.fg("error", `"${title}"`)} · ${this.theme.fg("error", `failed (exit ${s.exitCode ?? 1})`)}`;
        lines.push(truncateToWidth(failLine, boxWidth));
      }
    }

    // 3. Clean Bottom Divider
    lines.push(this.theme.fg("dim", "─".repeat(Math.max(2, boxWidth))));
    return lines;
  }
}

export class SubagentTracker {
  private active = new Map<string, TrackedSubagent>();
  private recent: TrackedSubagent[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private frameIndex = 0;
  private uiContext: ExtensionContext | null = null;
  private requestTuiRender: (() => void) | undefined;
  private isWidgetMounted = false;
  private sidebarRegistered = false;
  private theme: any = null;
  private settings: SubagentSettings = loadSubagentSettings();
  private sidebarRowToSubagentMap = new Map<number, string>();

  constructor() {
    (globalThis as any).__PI_SUBAGENTS_TRACKER__ = this;
  }

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

  toggleSidebarShowAll(): boolean {
    this.settings.sidebarShowAll = !this.settings.sidebarShowAll;
    saveSubagentSettings({ sidebarShowAll: this.settings.sidebarShowAll });
    this.notifyRender();
    return this.settings.sidebarShowAll;
  }

  isSidebarShowAll(): boolean {
    return this.settings.sidebarShowAll;
  }

  async openViewer(subagentId?: string) {
    if (!this.uiContext?.hasUI || typeof this.uiContext.ui?.custom !== "function") return;
    const all = [...this.active.values(), ...this.recent];
    const target = subagentId ? all.find((s) => s.id === subagentId || s.id.includes(subagentId)) : undefined;

    try {
      const { SubagentViewer } = await import("./subagent-viewer.js");
      await this.uiContext.ui.custom<void>(
        (tui, theme, _kb, done) => {
          return new SubagentViewer({
            initialMode: target ? "transcript" : "list",
            id: target?.id,
            task: target ? target.description || target.task : undefined,
            logPath: target?.logFile,
            theme,
            tui,
            tracker: this,
            done,
            canGoBackToList: target ? false : true,
          });
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            row: 0,
            col: 0,
            width: "100%",
            maxHeight: "100%",
          },
        }
      );
    } catch (err) {
      console.error("Failed to open SubagentViewer:", err);
    }
  }

  setUIContext(ctx: ExtensionContext) {
    this.uiContext = ctx;
    this.ensureSidebarPanel();
    const hasRunning = Array.from(this.active.values()).some((s) => s.status === "running");
    if (hasRunning) {
      this.ensureTicker();
    }
  }

  getFrameIndex(): number {
    return Math.floor(Date.now() / 90) % SPINNER_FRAMES.length;
  }

  registerStart(subagent: {
    id: string;
    sessionID?: string;
    task: string;
    description?: string;
    agent?: string;
    background?: boolean;
    model?: string;
    reasoning?: string;
    isolated: boolean;
    logFile: string;
  }) {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }

    const tracked: TrackedSubagent = {
      id: subagent.id,
      sessionID: subagent.sessionID ?? subagent.id,
      task: subagent.task,
      description: subagent.description,
      agent: subagent.agent,
      background: subagent.background,
      model: subagent.model,
      reasoning: subagent.reasoning,
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

  registerFinish(
    id: string,
    result: {
      status: "completed" | "failed" | "aborted";
      exitCode?: number;
      durationMs?: number;
      stats?: SubagentStats;
      errorMessage?: string;
      summary?: string;
    }
  ) {
    const formatFinishLine = (status: string, exitCode?: number, errorMessage?: string) => {
      if (status === "completed") return "Done";
      if (status === "aborted") return "Aborted";
      if (errorMessage) {
        const firstLine = errorMessage.split("\n")[0].trim();
        return firstLine.startsWith("Error:") ? firstLine : `Error: ${firstLine}`;
      }
      return `Exited with code ${exitCode ?? 1}`;
    };

    const item = this.active.get(id);
    if (item) {
      item.status = result.status;
      item.exitCode = result.exitCode;
      item.endTime = Date.now();
      item.durationMs = result.durationMs ?? (item.endTime - item.startTime);
      if (result.errorMessage) item.errorMessage = result.errorMessage;
      if (result.summary) item.summary = result.summary;
      item.currentLine = formatFinishLine(result.status, result.exitCode, result.errorMessage);
      if (result.stats) {
        item.stats = result.stats;
      }
      this.recent = [item, ...this.recent.filter((r) => r.id !== id)].slice(0, 50);
      this.active.delete(id);
    } else {
      const existing = this.recent.find((r) => r.id === id);
      if (existing) {
        existing.status = result.status;
        existing.exitCode = result.exitCode;
        existing.endTime = Date.now();
        existing.durationMs = result.durationMs ?? (existing.endTime - existing.startTime);
        if (result.errorMessage) existing.errorMessage = result.errorMessage;
        if (result.summary) existing.summary = result.summary;
        existing.currentLine = formatFinishLine(result.status, result.exitCode, result.errorMessage);
        if (result.stats) existing.stats = result.stats;
      }
    }

    const hasRunning = Array.from(this.active.values()).some((s) => s.status === "running");
    if (!hasRunning) {
      this.stopTicker();
      this.notifyRender();

      // Grace period to show completion in the box before unmounting
      if (this.clearTimer) clearTimeout(this.clearTimer);
      this.clearTimer = setTimeout(() => {
        this.unmountWidget();
        this.notifyRender();
      }, GRACE_PERIOD_MS);
    } else {
      this.notifyRender();
    }
  }

  stopAll() {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
    for (const [id, item] of this.active.entries()) {
      if (item.status === "running") {
        item.status = "aborted";
        item.endTime = Date.now();
        item.durationMs = item.endTime - item.startTime;
        item.currentLine = "Aborted";
        this.recent = [item, ...this.recent.filter((r) => r.id !== id)].slice(0, 15);
      }
    }
    this.active.clear();
    this.stopTicker();
    this.unmountWidget();
    this.notifyRender();
  }

  getActiveList(): TrackedSubagent[] {
    return Array.from(this.active.values());
  }

  getRecentList(): TrackedSubagent[] {
    return this.recent;
  }

  restoreRecent(items: TrackedSubagent[]) {
    const byId = new Map<string, TrackedSubagent>();

    // Seed with existing recent
    for (const r of this.recent) {
      byId.set(r.id, r);
    }

    // Merge restored items in order (latest entry for each ID takes precedence)
    for (const item of items) {
      const existing = byId.get(item.id);
      if (!existing) {
        byId.set(item.id, { ...item });
      } else {
        // A terminal status (completed, failed, aborted) always overrides "running"
        if (item.status !== "running" || existing.status === "running") {
          byId.set(item.id, { ...existing, ...item });
        }
      }
    }

    // Reconcile any items still marked "running": check if they finished on disk
    for (const [id, item] of byId.entries()) {
      if (item.status === "running" && !activeSubagentProcesses.has(id)) {
        const diskCheck = checkSubagentCompletionOnDisk(id, item.logFile);
        if (diskCheck.status !== "running") {
          item.status = diskCheck.status;
          if (diskCheck.status === "completed") {
            item.currentLine = "Done";
          } else if (diskCheck.status === "aborted") {
            item.currentLine = "Aborted";
          } else {
            item.currentLine = diskCheck.errorMessage ? `Error: ${diskCheck.errorMessage}` : "Failed";
          }
          if (diskCheck.errorMessage) item.errorMessage = diskCheck.errorMessage;
          if (diskCheck.durationMs && !item.durationMs) item.durationMs = diskCheck.durationMs;
          if (diskCheck.stats && !item.stats) item.stats = diskCheck.stats;
        }
      }
    }

    this.recent = Array.from(byId.values()).slice(0, 50);
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
        (tui, theme) => {
          this.requestTuiRender = () => tui.requestRender();
          return new PinnedSubagentsWidget(this, theme);
        },
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
      this.requestTuiRender?.();
    } catch {}
    this.isWidgetMounted = false;
  }

  private notifyRender() {
    const runningCount = Array.from(this.active.values()).filter((s) => s.status === "running").length;

    // 1. Update native footer status line
    if (this.uiContext?.hasUI) {
      if (runningCount > 0) {
        const spinner = SPINNER_FRAMES[this.getFrameIndex()];
        this.uiContext.ui.setStatus(
          "subagents",
          `${spinner} ${runningCount} subagent${runningCount > 1 ? "s" : ""} active`
        );
      } else {
        this.uiContext.ui.setStatus("subagents", undefined);
      }

      // 2. Request UI render through the TUI instance captured by the widget factory
      try {
        this.requestTuiRender?.();
      } catch {}
    }

    // 3. Notify sidebar if available
    try {
      const g = globalThis as any;
      if (typeof g.__PI_SIDEBAR_TUI__?.requestRender === "function") {
        g.__PI_SIDEBAR_TUI__.requestRender();
      }
      if (typeof g.__PI_SIDEBAR_REQUEST_RENDER__ === "function") {
        g.__PI_SIDEBAR_REQUEST_RENDER__();
      }
    } catch {}
  }

  private ensureSidebarPanel() {
    if (!this.settings.sidebarEnabled) return;
    const g = globalThis as any;
    if (!g.__PI_SIDEBAR_PANELS__) {
      g.__PI_SIDEBAR_PANELS__ = new Map();
    }

    const panel = {
      id: "subagents",
      order: 15,
      onClick: (lineText: string, lineIndex: number) => {
        if (
          lineText.includes("more subagents") ||
          lineText.includes("Show less") ||
          lineText.includes("show less")
        ) {
          this.toggleSidebarShowAll();
          return;
        }

        const subId = this.sidebarRowToSubagentMap.get(lineIndex);
        if (subId && subId !== "toggle") {
          void this.openViewer(subId);
          return;
        }

        // Fallback: match by task title or ID from text
        const all = [...this.active.values(), ...this.recent];
        const match = all.find((s) => {
          const t = s.description || s.task;
          return lineText.includes(s.id) || (t && lineText.includes(t.slice(0, 15)));
        });
        if (match) {
          void this.openViewer(match.id);
        }
      },
      render: (_ctx: any, width: number) => {
        if (!this.settings.sidebarEnabled) return [];

        // Collect all unique tracked subagents (both active and recent)
        const allItemsMap = new Map<string, TrackedSubagent>();
        for (const s of this.recent) allItemsMap.set(s.id, s);
        for (const s of this.active.values()) allItemsMap.set(s.id, s);
        const allItems = Array.from(allItemsMap.values());
        if (allItems.length === 0) return [];

        // Accurate counts across ALL subagents that have run
        const totalRunning = allItems.filter((s) => s.status === "running").length;
        const totalCompleted = allItems.filter((s) => s.status === "completed").length;
        const totalFailed = allItems.filter((s) => s.status === "failed" || s.status === "aborted").length;
        const lines: string[] = [];
        const rowMap = new Map<number, string>();

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

        // Compute animated braille spinner frame directly from real-time clock
        const currentFrameIndex = this.getFrameIndex();
        const currentSpinner = SPINNER_FRAMES[currentFrameIndex];

        // Header line with accurate total counts
        let countLabel = "";
        if (totalRunning > 0) {
          const parts = [`${totalRunning} active`];
          if (totalCompleted > 0) parts.push(`${totalCompleted} done`);
          if (totalFailed > 0) parts.push(`${totalFailed} failed`);
          countLabel = dim(` (${parts.join(", ")})`);
        } else if (totalCompleted > 0 || totalFailed > 0) {
          if (totalCompleted > 0 && totalFailed === 0) {
            countLabel = fg("success", ` (${totalCompleted} done)`);
          } else if (totalFailed > 0 && totalCompleted === 0) {
            countLabel = fg("error", ` (${totalFailed} failed)`);
          } else {
            countLabel = dim(" (") + fg("success", `${totalCompleted} done`) + dim(", ") + fg("error", `${totalFailed} failed`) + dim(")");
          }
        }
        lines.push(bold(" Subagents") + countLabel);
        lines.push(dim("─".repeat(Math.max(0, safeW))));

        // Display items:
        // Always show all running items.
        // For completed items: show latest 5 by default, or all if sidebarShowAll is true.
        const activeItems = allItems.filter((s) => s.status === "running");
        const finishedItems = allItems.filter((s) => s.status !== "running");

        const maxFinishedToShow = this.settings.sidebarShowAll ? finishedItems.length : 5;
        const visibleFinished = finishedItems.slice(0, maxFinishedToShow);
        const itemsToDisplay = [...activeItems, ...visibleFinished];

        for (const s of itemsToDisplay) {
          const elapsed = (((s.endTime ?? Date.now()) - s.startTime) / 1000).toFixed(1);
          const title = s.description || (s.task.length > 24 ? `${s.task.slice(0, 21)}...` : s.task);

          rowMap.set(lines.length, s.id);
          if (s.status === "running") {
            const icon = fg("accent", currentSpinner);
            lines.push(truncateToWidth(`  ${icon} ${bold(`"${title}"`)} ${dim(`(${elapsed}s)`)}`, safeW));
            if (s.currentLine) {
              rowMap.set(lines.length, s.id);
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

        // Show clickable button if there are more than 5 finished items
        if (finishedItems.length > 5) {
          rowMap.set(lines.length, "toggle");
          if (!this.settings.sidebarShowAll) {
            const hiddenCount = finishedItems.length - 5;
            lines.push(
              truncateToWidth(
                `  ${fg("accent", "▶")} ${bold(`[View ${hiddenCount} more subagents]`)}`,
                safeW
              )
            );
          } else {
            lines.push(
              truncateToWidth(
                `  ${fg("accent", "▲")} ${bold("[Show less]")}`,
                safeW
              )
            );
          }
        }

        this.sidebarRowToSubagentMap = rowMap;
        return lines;
      },
    };

    g.__PI_SIDEBAR_PANELS__.set("subagents", panel);

    if (typeof g.__PI_SIDEBAR_TUI__?.registerPanel === "function") {
      try {
        g.__PI_SIDEBAR_TUI__.registerPanel(panel);
        this.sidebarRegistered = true;
      } catch {}
    } else {
      this.sidebarRegistered = true;
    }
  }
}

export const globalSubagentTracker = new SubagentTracker();
