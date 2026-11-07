import {
  type Component,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { formatTranscriptLines } from "./transcript-formatter.js";
import { type SubagentTracker, type TrackedSubagent, checkSubagentCompletionOnDisk } from "./tracker.js";
import { getSubagentDir, getSubagentSessionsDir, activeSubagentProcesses } from "./runner.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Animated moving progress bar that slides back and forth smoothly across columns.
 */
export function getAnimatedProgressBar(frame: number, width = 8): string {
  const cycle = (width - 1) * 2;
  const step = cycle > 0 ? frame % cycle : 0;
  const pos = step < width ? step : cycle - step;
  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i === pos) bar += "█";
    else if (Math.abs(i - pos) === 1) bar += "▒";
    else bar += "░";
  }
  return `[${bar}]`;
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function parseModelAndReasoning(modelStr?: string): { provider: string; model: string; reasoning?: string } {
  if (!modelStr) return { provider: "subagent", model: "default" };
  let provider = "subagent";
  let model = modelStr;
  let reasoning: string | undefined;

  if (model.includes("/")) {
    const parts = model.split("/");
    provider = parts[0];
    model = parts.slice(1).join("/");
  }

  if (model.includes(":")) {
    const parts = model.split(":");
    model = parts[0];
    reasoning = parts[1];
  } else if (model.includes("#")) {
    const parts = model.split("#");
    model = parts[0];
    reasoning = parts[1];
  }

  return { provider, model, reasoning };
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface SubagentViewerOptions {
  id?: string;
  task?: string;
  logPath?: string;
  theme: any;
  tui: any;
  tracker: SubagentTracker;
  done: () => void;
  initialMode?: "list" | "transcript";
  canGoBackToList?: boolean;
}

/**
 * Native Pi-style Subagent Viewer component.
 *
 * Implements:
 * 1. An interactive selector list for all active & recent subagents with live
 *    animated progress bars, spinning status indicators, and real-time elapsed timers.
 * 2. An exact replica of Pi's normal main chat layout:
 *    - Full word-wrapped text flow (no clipping or cut-offs on the right)
 *    - Native shaded tool execution boxes (bash commands with Took timings,
 *      tool calls with gutter bars `│` and cyan headers)
 *    - Padded userMessageBg boxes
 *    - Fixed bottom dock with input bar margin, footer session description,
 *      token metrics, and active model/reasoning indicator.
 */
export class SubagentViewer implements Component {
  private mode: "list" | "transcript";
  private canGoBackToList: boolean;
  private activeId: string;
  private activeTask: string;
  private activeLogPath: string;
  private theme: any;
  private tui: any;
  private tracker: SubagentTracker;
  private done: () => void;

  // Selector state
  private selectedListIndex = 0;
  private maxVisibleListItems = 8;

  // Transcript / Chat state
  private parsedEntries: any[] | null = null;
  private rawLogContent: string | null = null;
  private sessionModelInfo?: { provider: string; model: string; reasoning?: string };
  private cachedWidth?: number;
  private cachedChatLines?: string[];

  private scrollOffset = 0;
  private autoTail = true;
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isDisposed = false;

  constructor(opts: SubagentViewerOptions) {
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.tracker = opts.tracker;
    this.done = opts.done;

    const allSubagents = this.getAllSubagents();

    if (opts.initialMode === "list") {
      this.mode = "list";
      this.canGoBackToList = opts.canGoBackToList ?? (allSubagents.length > 1);
      this.activeId = allSubagents[0]?.id ?? "";
      this.activeTask = allSubagents[0]?.task ?? "";
      this.activeLogPath = allSubagents[0]?.logFile ?? "";
    } else if (opts.id) {
      this.activeId = opts.id;
      this.activeTask = opts.task ?? "";
      this.activeLogPath = opts.logPath ?? "";
      this.mode = "transcript";
      this.canGoBackToList = opts.canGoBackToList ?? false;
    } else if (allSubagents.length === 1) {
      const s = allSubagents[0];
      this.activeId = s.id;
      this.activeTask = s.task;
      this.activeLogPath = s.logFile;
      this.mode = "transcript";
      this.canGoBackToList = opts.canGoBackToList ?? false;
    } else {
      this.mode = "list";
      this.canGoBackToList = opts.canGoBackToList ?? true;
      this.activeId = allSubagents[0]?.id ?? "";
      this.activeTask = allSubagents[0]?.task ?? "";
      this.activeLogPath = allSubagents[0]?.logFile ?? "";
    }

    if (this.mode === "transcript") {
      this.reloadChat();
    }

    // Always start ticker if any subagent is running or in transcript mode
    this.startTimerIfNeeded();
  }

  private getAllSubagents(): TrackedSubagent[] {
    const active = this.tracker.getActiveList();
    const recent = this.tracker.getRecentList();
    const map = new Map<string, TrackedSubagent>();
    for (const item of active) map.set(item.id, item);
    for (const item of recent) {
      const existing = map.get(item.id);
      if (!existing) {
        map.set(item.id, item);
      } else if (existing.status === "running" && item.status !== "running") {
        existing.status = item.status;
        existing.endTime = item.endTime;
        existing.durationMs = item.durationMs;
        existing.stats = item.stats || existing.stats;
      }
    }

    // Check disk for any subagent still marked running whose process is no longer active
    for (const item of map.values()) {
      if (item.status === "running" && !activeSubagentProcesses.has(item.id)) {
        const disk = checkSubagentCompletionOnDisk(item.id, item.logFile);
        if (disk.status !== "running" && disk.status !== "aborted") {
          item.status = disk.status;
          item.currentLine = disk.status === "completed" ? "Done" : "Aborted";
          if (disk.durationMs && !item.durationMs) item.durationMs = disk.durationMs;
          if (disk.stats && !item.stats) item.stats = disk.stats;
        }
      }
    }

    return Array.from(map.values());
  }

  private getSubagentInfo(): TrackedSubagent | undefined {
    return this.getAllSubagents().find((s) => s.id === this.activeId);
  }

  private findSessionJsonl(): string | undefined {
    try {
      const sessionsDir = getSubagentSessionsDir();
      if (!fs.existsSync(sessionsDir)) return undefined;
      const files = fs.readdirSync(sessionsDir);
      const found = files.find((f) => f.includes(this.activeId) && f.endsWith(".jsonl"));
      return found ? path.join(sessionsDir, found) : undefined;
    } catch {
      return undefined;
    }
  }

  private reloadChat() {
    this.cachedChatLines = undefined;
    this.cachedWidth = undefined;

    const jsonlPath = this.findSessionJsonl();
    if (jsonlPath && fs.existsSync(jsonlPath)) {
      try {
        const fileContent = fs.readFileSync(jsonlPath, "utf-8");
        const lines = fileContent.split("\n").filter(Boolean);
        this.parsedEntries = lines.map((l) => JSON.parse(l));
        this.rawLogContent = null;
        return;
      } catch {}
    }

    // Fallback to raw log file or plain text
    try {
      const logPath =
        this.activeLogPath && fs.existsSync(this.activeLogPath)
          ? this.activeLogPath
          : path.join(getSubagentDir(), `${this.activeId}.log`);

      if (fs.existsSync(logPath)) {
        this.rawLogContent = fs.readFileSync(logPath, "utf-8");
        this.parsedEntries = null;
        return;
      }
    } catch {}

    this.parsedEntries = null;
    this.rawLogContent = null;
  }

  private getFormattedChatLines(width: number): string[] {
    if (this.cachedChatLines && this.cachedWidth === width) {
      return this.cachedChatLines;
    }
    this.cachedWidth = width;

    if (this.parsedEntries) {
      this.cachedChatLines = this.buildChatFromEntries(this.parsedEntries, width);
    } else if (this.rawLogContent) {
      this.cachedChatLines = this.buildChatFromRawLog(this.rawLogContent, width);
    } else {
      this.cachedChatLines = [];
    }

    return this.cachedChatLines;
  }

  private buildChatFromEntries(entries: any[], width: number): string[] {
    const formatted: string[] = [];
    const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
    const sub = this.getSubagentInfo();

    // Extract model and reasoning from session entries if available
    for (const e of entries) {
      if (e.type === "model_change") {
        this.sessionModelInfo = {
          provider: e.provider || "subagent",
          model: e.modelId || "model",
          reasoning: this.sessionModelInfo?.reasoning,
        };
      }
      if (e.type === "thinking_level_change" && e.thinkingLevel) {
        this.sessionModelInfo = {
          provider: this.sessionModelInfo?.provider || "subagent",
          model: this.sessionModelInfo?.model || "model",
          reasoning: e.thinkingLevel,
        };
      }
    }

    // Index tool results and durations by toolCallId
    const toolResults = new Map<string, { text: string; durationMs?: number; isError: boolean }>();
    for (const m of messages) {
      if (m.role === "toolResult" && m.toolCallId) {
        const text = m.content?.map((c: any) => c.text).filter(Boolean).join("\n") || "";
        const durationMs = m.durationMs ?? m.details?.durationMs;
        const isError = Boolean(m.isError || (m.details?.exitCode !== undefined && m.details.exitCode !== 0));
        toolResults.set(m.toolCallId, { text, durationMs, isError });
      }
    }

    const taskTitle =
      sub?.description || (sub?.task ? truncateToWidth(sub.task.replace(/[\r\n]+/g, " "), 50) : "Subagent");
    const status = sub?.status ?? "completed";
    const agent = sub?.agent || "general";
    const statusIcon =
      status === "completed"
        ? this.theme.fg("success", "●")
        : status === "running"
          ? this.theme.fg("accent", SPINNER_FRAMES[this.frameIndex])
          : this.theme.fg("error", "▲");

    for (const m of messages) {
      if (m.role === "user") {
        let text = m.content?.[0]?.text || "";
        text = text.replace(/^You are a subagent spawned by another session\.\s*/i, "").trim();

        // Render User Message in Pi's exact shaded userMessageBg box
        const userBox = this.renderUserMessageBox(text, width);
        for (const line of userBox) {
          formatted.push(line);
        }
      } else if (m.role === "assistant") {
        for (const part of m.content || []) {
          // Thinking block (rendered in dim italics)
          if (part.type === "thinking" && part.thinking?.trim()) {
            formatted.push("");
            for (const line of this.renderThinkingBlock(part.thinking.trim(), width)) {
              formatted.push(line);
            }
            formatted.push("");
          }

          // Tool call execution box
          if (part.type === "toolCall") {
            const isBash = part.name === "bash" || part.name === "$";
            const res = toolResults.get(part.id);

            formatted.push("");
            if (isBash) {
              const command = part.arguments?.command || "";
              const bashBox = this.renderBashToolBox(
                command,
                res?.text || "",
                res?.durationMs,
                res?.isError ?? false,
                width
              );
              for (const line of bashBox) {
                formatted.push(line);
              }
            } else {
              const argsSummary = Object.entries(part.arguments || {})
                .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
                .join(" ");

              let callHeader = `${part.name} ${argsSummary}`.trim();
              if (part.name === "subagent") {
                const subDesc = part.arguments?.description || part.arguments?.task || "";
                const subAgent = part.arguments?.agent ? ` [${part.arguments.agent}]` : "";
                callHeader = `Subagent${subAgent} "${subDesc}"`;
                if (part.arguments?.isolated === false) callHeader += " [shared]";
                if (part.arguments?.background === false) callHeader += " · blocking";
                else callHeader += " · background";
              }

              const resultTitle =
                part.name === "subagent"
                  ? `Subagent completed [${part.id || ""}]`
                  : `${part.name} completed`;

              const toolBox = this.renderGenericToolBox(
                callHeader,
                resultTitle,
                res?.text || "",
                res?.isError ?? false,
                false,
                width
              );
              for (const line of toolBox) {
                formatted.push(line);
              }
            }
            formatted.push("");
          }

          // Assistant markdown text response
          if (part.type === "text" && part.text?.trim()) {
            formatted.push("");
            const mdLines = this.renderAssistantMarkdown(part.text.trim(), width);
            for (const line of mdLines) {
              formatted.push(line);
            }
            formatted.push("");
          }
        }
      }
    }

    return formatted;
  }

  private renderShadedBox(
    lines: string[],
    width: number,
    bgToken: "toolSuccessBg" | "toolPendingBg" | "toolErrorBg" | "userMessageBg",
    paddingY = true
  ): string[] {
    const result: string[] = [];
    const safeWidth = Math.max(20, width);

    const fillBg = (content: string) => {
      const vWidth = visibleWidth(content);
      const padLen = Math.max(0, safeWidth - vWidth);
      const fullLine = content + " ".repeat(padLen);
      try {
        const styled = this.theme.bg(bgToken, fullLine);
        return styled || fullLine;
      } catch {
        return fullLine;
      }
    };

    if (paddingY) {
      result.push(fillBg(""));
    }

    for (const line of lines) {
      result.push(fillBg(` ${line}`));
    }

    if (paddingY) {
      result.push(fillBg(""));
    }

    return result;
  }

  private renderBashToolBox(
    command: string,
    output: string,
    durationMs: number | undefined,
    isError: boolean,
    width: number
  ): string[] {
    const innerWidth = Math.max(10, width - 4);
    const boxContent: string[] = [];

    // 1. Command line: cyan $ and command
    const cmdLine = `${this.theme.fg("accent", "$")} ${this.theme.fg("accent", command)}`;
    for (const w of wrapTextWithAnsi(cmdLine, innerWidth)) {
      boxContent.push(w);
    }

    // 2. Output
    const cleanOutput = output.trim();
    if (cleanOutput) {
      boxContent.push("");
      const outLines = cleanOutput.split("\n");
      const previewLines = outLines.slice(0, 15);
      for (const line of previewLines) {
        for (const w of wrapTextWithAnsi(line, innerWidth)) {
          boxContent.push(this.theme.fg("toolOutput", w));
        }
      }
      if (outLines.length > 15) {
        boxContent.push(this.theme.fg("dim", `... (${outLines.length - 15} more lines)`));
      }
    }

    // 3. Duration footer: Took 0.2s
    if (durationMs !== undefined && durationMs > 0) {
      boxContent.push("");
      boxContent.push(this.theme.fg("dim", `Took ${formatDuration(durationMs)}`));
    }

    const bgToken = isError ? "toolErrorBg" : "toolSuccessBg";
    return this.renderShadedBox(boxContent, width, bgToken, true);
  }

  private renderGenericToolBox(
    callHeader: string,
    resultHeader: string,
    resultBody: string,
    isError: boolean,
    isRunning: boolean,
    width: number
  ): string[] {
    const innerWidth = Math.max(10, width - 6);
    const boxContent: string[] = [];

    // 1. Tool Call Header line (cyan)
    for (const w of wrapTextWithAnsi(callHeader, innerWidth)) {
      boxContent.push(this.theme.fg("accent", w));
    }

    // 2. Result header line: green ● (or error ▲), cyan title, dim extra
    const icon = isError ? this.theme.fg("error", "▲") : this.theme.fg("success", "●");
    boxContent.push(`${icon} ${this.theme.bold(this.theme.fg("toolTitle", resultHeader))}`);

    // 3. Result body with vertical gutter: `  │ <line>`
    const cleanBody = resultBody.trim();
    if (cleanBody) {
      const rawLines = cleanBody.split("\n");
      const previewLines = rawLines.slice(0, 8);
      const gutter = this.theme.fg("dim", "  │ ");
      const availWidth = Math.max(10, innerWidth - 4);

      for (const rawLine of previewLines) {
        const wrapped = wrapTextWithAnsi(rawLine, availWidth);
        for (const w of wrapped) {
          boxContent.push(`${gutter}${this.theme.fg("toolOutput", w)}`);
        }
      }

      if (rawLines.length > 8) {
        boxContent.push(this.theme.fg("dim", `  (click or ctrl+e to view full transcript)`));
      }
    }

    const bgToken = isError ? "toolErrorBg" : isRunning ? "toolPendingBg" : "toolSuccessBg";
    return this.renderShadedBox(boxContent, width, bgToken, true);
  }

  private renderThinkingBlock(text: string, width: number): string[] {
    const innerWidth = Math.max(10, width - 4);
    const wrapped = wrapTextWithAnsi(text, innerWidth);
    return wrapped.map((w) => `\x1b[3m${this.theme.fg("dim", w)}\x1b[23m`);
  }

  private renderUserMessageBox(text: string, width: number): string[] {
    const innerWidth = Math.max(10, width - 4);
    const wrapped = wrapTextWithAnsi(text, innerWidth);

    const lines: string[] = [];
    for (const line of wrapped) {
      lines.push(this.theme.fg("userMessageText", line));
    }

    return this.renderShadedBox(lines, width, "userMessageBg", true);
  }

  private renderAssistantMarkdown(text: string, width: number): string[] {
    const result: string[] = [];
    const rawLines = text.split("\n");
    const maxTextWidth = Math.max(10, width - 2);

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();

      // Horizontal rule
      if (/^[-*_]{3,}$/.test(trimmed)) {
        result.push(this.theme.fg("dim", "─".repeat(Math.max(1, width))));
        continue;
      }

      // Headings (yellow/accent bold, matching Pi main chat)
      if (/^#{1,6}\s+/.test(trimmed)) {
        const styled = this.theme.bold(this.theme.fg("accent", rawLine));
        for (const w of wrapTextWithAnsi(styled, maxTextWidth)) {
          result.push(w);
        }
        continue;
      }

      // Numbered list item: cyan number, formatted body wrapped cleanly
      const numMatch = rawLine.match(/^(\s*)(\d+\.)\s+(.*)$/);
      if (numMatch) {
        const indent = numMatch[1];
        const num = this.theme.fg("accent", numMatch[2]);
        const body = this.formatInlineMarkdown(numMatch[3]);
        const firstPrefix = `${indent}${num} `;
        const prefixWidth = visibleWidth(firstPrefix);
        const availWidth = Math.max(10, maxTextWidth - prefixWidth);
        const wrapped = wrapTextWithAnsi(body, availWidth);
        if (wrapped.length === 0) {
          result.push(firstPrefix);
        } else {
          result.push(`${firstPrefix}${wrapped[0]}`);
          for (let i = 1; i < wrapped.length; i++) {
            result.push(`${" ".repeat(prefixWidth)}${wrapped[i]}`);
          }
        }
        continue;
      }

      // Bullet list item: cyan bullet, formatted body wrapped cleanly
      const bulletMatch = rawLine.match(/^(\s*)([-*])\s+(.*)$/);
      if (bulletMatch) {
        const indent = bulletMatch[1];
        const bullet = this.theme.fg("accent", bulletMatch[2]);
        const body = this.formatInlineMarkdown(bulletMatch[3]);
        const firstPrefix = `${indent}${bullet} `;
        const prefixWidth = visibleWidth(firstPrefix);
        const availWidth = Math.max(10, maxTextWidth - prefixWidth);
        const wrapped = wrapTextWithAnsi(body, availWidth);
        if (wrapped.length === 0) {
          result.push(firstPrefix);
        } else {
          result.push(`${firstPrefix}${wrapped[0]}`);
          for (let i = 1; i < wrapped.length; i++) {
            result.push(`${" ".repeat(prefixWidth)}${wrapped[i]}`);
          }
        }
        continue;
      }

      // Normal text lines (cleanly wrapped to prevent right-side clipping)
      if (!trimmed) {
        result.push("");
      } else {
        const styled = this.formatInlineMarkdown(rawLine);
        const wrapped = wrapTextWithAnsi(styled, maxTextWidth);
        for (const w of wrapped) {
          result.push(w);
        }
      }
    }

    return result;
  }

  private formatInlineMarkdown(text: string): string {
    // Highlight inline code: `code`
    let styled = text.replace(/`([^`]+)`/g, (_m, code) => this.theme.fg("accent", code));
    // Highlight bold: **text**
    styled = styled.replace(/\*\*([^*]+)\*\*/g, (_m, b) => this.theme.bold(b));
    return styled;
  }

  private buildChatFromRawLog(rawLog: string, width: number): string[] {
    const rawLines = rawLog.split("\n");
    const formatted = formatTranscriptLines(rawLines, this.theme, width);
    const sub = this.getSubagentInfo();
    const taskTitle =
      sub?.description || (sub?.task ? truncateToWidth(sub.task.replace(/[\r\n]+/g, " "), 50) : "Subagent");
    const status = sub?.status ?? "completed";
    const agent = sub?.agent || "general";
    const statusIcon =
      status === "completed"
        ? this.theme.fg("success", "●")
        : status === "running"
          ? this.theme.fg("accent", SPINNER_FRAMES[this.frameIndex])
          : this.theme.fg("error", "▲");

    return formatted;
  }

  private startTimerIfNeeded() {
    if (this.timer) return;

    const hasRunning = this.getAllSubagents().some((s) => s.status === "running");
    if (!hasRunning && this.mode !== "transcript") return;

    if (this.mode === "transcript") {
      const currentSub = this.getSubagentInfo();
      if (currentSub && currentSub.status !== "running" && !hasRunning) return;
    }

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;

      if (this.mode === "transcript") {
        this.reloadChat();
      }

      const stillHasRunning = this.getAllSubagents().some((s) => s.status === "running");
      if (!stillHasRunning && this.mode === "list" && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      this.tui.requestRender();
    }, 90);
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private cleanup() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.stopTimer();
  }

  dispose() {
    this.cleanup();
  }

  invalidate() {}

  handleMouse(event: any): { handled?: boolean } | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.autoTail = false;
      const delta = event.wheelDelta < 0 ? -3 : 3;
      if (this.mode === "transcript") {
        this.scrollOffset = Math.max(0, this.scrollOffset + delta);
      } else {
        const items = this.getAllSubagents();
        if (items.length > 0) {
          const listDelta = delta < 0 ? -1 : 1;
          this.selectedListIndex = (this.selectedListIndex + listDelta + items.length) % items.length;
        }
      }
      this.tui.requestRender();
      return { handled: true };
    }
    return { handled: true };
  }

  handleInput(data: string): void {
    // 1. Mouse wheel scrolling (SGR 1006 and X11)
    if (data.includes("\x1b[<64;") || data.includes("\x1b[M`")) {
      if (this.mode === "transcript") {
        this.autoTail = false;
        this.scrollOffset = Math.max(0, this.scrollOffset - 3);
        this.tui.requestRender();
      } else {
        const items = this.getAllSubagents();
        if (items.length > 0) {
          this.selectedListIndex = (this.selectedListIndex - 1 + items.length) % items.length;
          this.tui.requestRender();
        }
      }
      return;
    }

    if (data.includes("\x1b[<65;") || data.includes("\x1b[Ma")) {
      if (this.mode === "transcript") {
        this.scrollOffset += 3;
        this.tui.requestRender();
      } else {
        const items = this.getAllSubagents();
        if (items.length > 0) {
          this.selectedListIndex = (this.selectedListIndex + 1) % items.length;
          this.tui.requestRender();
        }
      }
      return;
    }

    if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) {
      return;
    }

    if (this.mode === "list") {
      this.handleListInput(data);
    } else {
      this.handleTranscriptInput(data);
    }
  }

  private handleListInput(data: string): void {
    const items = this.getAllSubagents();
    if (items.length === 0) {
      if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "return")) {
        this.cleanup();
        this.done();
      }
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.selectedListIndex = this.selectedListIndex === 0 ? items.length - 1 : this.selectedListIndex - 1;
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selectedListIndex = this.selectedListIndex === items.length - 1 ? 0 : this.selectedListIndex + 1;
      this.tui.requestRender();
    } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const selected = items[this.selectedListIndex];
      if (selected) {
        this.activeId = selected.id;
        this.activeTask = selected.description || selected.task;
        this.activeLogPath = selected.logFile;
        this.mode = "transcript";
        this.canGoBackToList = items.length > 1;
        this.scrollOffset = 0;
        this.autoTail = true;
        this.reloadChat();
        this.startTimerIfNeeded();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, "escape") || data === "q" || data === "Q" || matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done();
    }
  }

  private handleTranscriptInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q" || matchesKey(data, "ctrl+c")) {
      if (this.canGoBackToList) {
        this.mode = "list";
        this.startTimerIfNeeded();
        this.tui.requestRender();
      } else {
        this.cleanup();
        this.done();
      }
      return;
    }

    if (matchesKey(data, "return")) {
      if (this.canGoBackToList) {
        this.mode = "list";
        this.startTimerIfNeeded();
        this.tui.requestRender();
      } else {
        this.cleanup();
        this.done();
      }
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset++;
      this.tui.requestRender();
    } else if (matchesKey(data, "pageUp")) {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.tui.requestRender();
    } else if (matchesKey(data, "pageDown") || data === " ") {
      this.scrollOffset += 10;
      this.tui.requestRender();
    } else if (matchesKey(data, "home") || data === "g") {
      this.autoTail = false;
      this.scrollOffset = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, "end") || data === "G") {
      this.autoTail = true;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const rawLines = this.mode === "list" ? this.renderList(width) : this.renderTranscript(width);
    // Pad every line to full width columns so no background character from the main chat leaks through
    return rawLines.map((line) => {
      const vWidth = visibleWidth(line);
      if (vWidth >= width) return line;
      return line + " ".repeat(width - vWidth);
    });
  }

  /**
   * Renders the native Pi selector list with live moving progress bars and spinning status icons.
   */
  private renderList(width: number): string[] {
    const lines: string[] = [];
    const items = this.getAllSubagents();

    // 1. Header (Spacer + Title + Subtitle + Spacer + DynamicBorder + Spacer)
    lines.push("");
    lines.push(this.theme.bold("  Subagents"));
    lines.push(
      this.theme.fg("muted", "  Select a subagent to view live transcript, status, and details")
    );
    lines.push("");
    lines.push(this.theme.fg("dim", "─".repeat(Math.max(1, width))));
    lines.push("");

    if (items.length === 0) {
      lines.push(this.theme.fg("muted", "  No subagents found"));
      lines.push("");
      lines.push(this.theme.fg("dim", "─".repeat(Math.max(1, width))));
      lines.push("  " + this.theme.fg("dim", "esc") + this.theme.fg("muted", " close"));
      return lines;
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedListIndex - Math.floor(this.maxVisibleListItems / 2),
        items.length - this.maxVisibleListItems
      )
    );
    const endIndex = Math.min(startIndex + this.maxVisibleListItems, items.length);

    // 2. Render visible subagents (title line + metadata line with moving progress bar + blank line)
    for (let i = startIndex; i < endIndex; i++) {
      const s = items[i];
      const isSelected = i === this.selectedListIndex;

      // First line: cursor + title
      const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
      const normalizedTitle = (s.description || s.task).replace(/[\r\n\t]+/g, " ").trim();
      const maxMsgWidth = Math.max(10, width - 4);
      const truncatedTitle = truncateToWidth(normalizedTitle, maxMsgWidth);
      const titleLine = cursor + (isSelected ? this.theme.bold(truncatedTitle) : truncatedTitle);
      lines.push(titleLine);

      // Second line: metadata + live moving progress bar for running subagents
      const elapsedSec = (((s.endTime ?? Date.now()) - s.startTime) / 1000).toFixed(1) + "s";

      let statusIcon: string;
      let progressBar = "";

      if (s.status === "completed") {
        statusIcon = this.theme.fg("success", "●");
      } else if (s.status === "running") {
        statusIcon = this.theme.fg("accent", SPINNER_FRAMES[this.frameIndex]);
        progressBar = this.theme.fg("accent", `${getAnimatedProgressBar(this.frameIndex, 8)} `);
      } else {
        statusIcon = this.theme.fg("error", "▲");
      }

      let metaParts = [
        `[${s.id}]`,
        s.agent && s.agent !== "general" ? s.agent : undefined,
        s.status,
        elapsedSec,
        s.isolated ? "isolated" : "shared",
      ].filter(Boolean);

      if (s.stats && s.stats.totalTokens > 0) {
        metaParts.push(`${(s.stats.totalTokens / 1000).toFixed(1)}k tkns`);
      }

      const metaText = `  ${statusIcon} ${progressBar}${metaParts.join(" · ")}`;
      lines.push(this.theme.fg("muted", truncateToWidth(metaText, width - 4)));

      // If running and has an active action line, render live activity peek
      if (s.status === "running" && s.currentLine) {
        const cleanAction = stripTerminalSequences(s.currentLine.replace(/[\r\n\t]+/g, " ").trim());
        if (cleanAction) {
          lines.push(this.theme.fg("muted", `    ↳ ${this.theme.fg("dim", truncateToWidth(cleanAction, width - 8))}`));
        }
      }

      lines.push(""); // Blank line between items (Pi style)
    }

    if (startIndex > 0 || endIndex < items.length) {
      lines.push(this.theme.fg("muted", `  (${this.selectedListIndex + 1}/${items.length})`));
    }

    // 3. Bottom border & keybinding hints
    lines.push(this.theme.fg("dim", "─".repeat(Math.max(1, width))));
    lines.push(
      "  " +
        this.theme.fg("dim", "↑/↓") +
        this.theme.fg("muted", " navigate") +
        " · " +
        this.theme.fg("dim", "enter") +
        this.theme.fg("muted", " view transcript") +
        " · " +
        this.theme.fg("dim", "esc") +
        this.theme.fg("muted", " close")
    );

    const termRows = typeof this.tui?.terminal?.rows === "number" ? this.tui.terminal.rows : 28;
    const padNeeded = Math.max(0, termRows - lines.length);
    if (padNeeded > 0) {
      lines.splice(lines.length - 2, 0, ...Array(padNeeded).fill(""));
    }

    return lines;
  }

  /**
   * Replicates Pi's exact normal main chat screen:
   * - No artificial top banner: chat messages fill naturally from the top.
   * - Full word wrapping on all lines (no right-side truncation).
   * - User prompts rendered in shaded userMessageBg boxes.
   * - Tool executions rendered in shaded toolSuccessBg boxes (bash commands with Took timings,
   *   generic tools with gutter bars `│`).
   * - Assistant text rendered with full Pi markdown styling (yellow headings, cyan bullets/code).
   * - Fixed bottom dock replicating the input bar margin, footer session description,
   *   live token metrics, and active model/reasoning indicator.
   */
  private renderTranscript(width: number): string[] {
    const sub = this.getSubagentInfo();
    const status = sub?.status ?? "completed";
    const agent = sub?.agent || "general";
    const taskTitle =
      sub?.description || (sub?.task ? truncateToWidth(sub.task.replace(/[\r\n]+/g, " "), 50) : "Subagent");

    const termRows = typeof this.tui?.terminal?.rows === "number" ? this.tui.terminal.rows : 28;
    // Bottom dock takes 5 lines:
    // 1 (top divider) + 1 (input bar margin) + 1 (bottom divider) + 2 (footer lines)
    const dockHeight = 5;
    // Pinned Title Header at the top takes 2 lines:
    // 1 (title & metadata line) + 1 (top divider line)
    const headerHeight = 2;
    const maxVisibleRows = Math.max(3, termRows - dockHeight - headerHeight);

    const chatLines = this.getFormattedChatLines(width);
    const totalLines = chatLines.length;

    if (this.autoTail) {
      this.scrollOffset = Math.max(0, totalLines - maxVisibleRows);
    } else {
      this.scrollOffset = Math.min(Math.max(0, totalLines - maxVisibleRows), this.scrollOffset);
    }

    // Pinned Top Header (permanently visible at rows 0-1)
    let statusIcon: string;
    if (status === "completed") {
      statusIcon = this.theme.fg("success", "●");
    } else if (status === "running") {
      statusIcon = this.theme.fg("accent", SPINNER_FRAMES[this.frameIndex]);
    } else {
      statusIcon = this.theme.fg("error", "▲");
    }

    const elapsed = sub ? (((sub.endTime ?? Date.now()) - sub.startTime) / 1000).toFixed(1) + "s" : "";
    const elapsedBadge = elapsed ? ` (${elapsed})` : "";
    const titleLeft = `  ${statusIcon} ${this.theme.bold("Subagent Transcript: ")}${this.theme.fg("accent", `[${this.activeId}]`)} · ${this.theme.bold(this.theme.fg("toolTitle", `"${taskTitle}"`))}`;
    const metaRight = `${this.theme.fg("muted", agent)} · ${status === "completed" ? this.theme.fg("success", "completed") : status === "running" ? this.theme.fg("accent", "running") : this.theme.fg("error", "failed")}${this.theme.fg("dim", elapsedBadge)} `;

    const leftW = visibleWidth(titleLeft);
    const rightW = visibleWidth(metaRight);
    let topTitleLine: string;
    if (leftW + rightW + 2 <= width) {
      topTitleLine = titleLeft + " ".repeat(width - leftW - rightW) + metaRight;
    } else {
      topTitleLine = truncateToWidth(`${titleLeft} · ${metaRight}`, width);
    }
    const topDivider = this.theme.fg("dim", "─".repeat(Math.max(1, width)));

    const lines: string[] = [topTitleLine, topDivider];

    // 1. Natural Pi Chat Messages (scrollable area between pinned header and dock)
    const visibleLines = chatLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleRows);
    for (const line of visibleLines) {
      lines.push(line);
    }

    // Fill gap above dock so dock stays pinned to bottom, exactly like Pi
    const padNeeded = Math.max(0, maxVisibleRows - visibleLines.length);
    for (let i = 0; i < padNeeded; i++) {
      lines.push("");
    }

    // 2. Pi's Exact Dock (Divider -> Input Margin -> Divider -> Footer)
    const isRunning = status === "running";
    const spinner = SPINNER_FRAMES[this.frameIndex];

    // Divider above input margin (magenta/accent when working, dim otherwise)
    if (isRunning) {
      const workingHeader = `── ${spinner} Working `;
      const fillLen = Math.max(0, width - visibleWidth(workingHeader));
      lines.push(this.theme.fg("thinkingHigh", `${workingHeader}${"─".repeat(fillLen)}`));
    } else {
      lines.push(this.theme.fg("dim", "─".repeat(Math.max(1, width))));
    }

    // Input bar margin (maintaining the exact margin from Pi's input bar)
    const backHint = this.canGoBackToList ? "Back to list" : "Close";
    const marginHint = this.theme.fg("dim", `  [read-only] Esc/q: ${backHint}`);
    lines.push(marginHint);

    // Divider below input margin
    lines.push(this.theme.fg("dim", "─".repeat(Math.max(1, width))));

    // Footer Line 1: cwd • subagent description/title (Updated to subagent's!)
    const cwd = process.cwd();
    const home = os.homedir();
    const shortenedCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
    const pwdLine = truncateToWidth(
      `${this.theme.fg("dim", shortenedCwd)} ${this.theme.fg("dim", "•")} ${this.theme.fg("dim", taskTitle)}`,
      width
    );
    lines.push(pwdLine);

    // Footer Line 2: Stats on left, (provider) model • reasoning on right (Pi style)
    const stats = sub?.stats;
    const statsParts = [];
    if (stats?.tokensIn) statsParts.push(`↑${formatTokensShort(stats.tokensIn)}`);
    if (stats?.tokensOut) statsParts.push(`↓${formatTokensShort(stats.tokensOut)}`);
    if (stats?.cacheRead) statsParts.push(`R${formatTokensShort(stats.cacheRead)}`);
    if (stats?.cost) statsParts.push(`$${stats.cost.toFixed(3)}`);
    statsParts.push(`Agent: ${agent}`);
    const statsLeft = this.theme.fg("dim", statsParts.join(" "));

    const effectiveModel = sub?.model || sub?.stats?.model;
    const effectiveReasoning = sub?.reasoning || sub?.stats?.thinkingLevel;
    const modelInfo =
      this.sessionModelInfo || parseModelAndReasoning(effectiveModel || "antigravity/gemini-3.8-flash:low");
    const reasoningStr = (effectiveReasoning || modelInfo.reasoning)
      ? ` • ${effectiveReasoning || modelInfo.reasoning}`
      : "";
    const rightSide = this.theme.fg("dim", `(${modelInfo.provider}) ${modelInfo.model}${reasoningStr}`);

    const statsLeftWidth = visibleWidth(statsLeft);
    const rightSideWidth = visibleWidth(rightSide);
    const minPad = 2;

    if (statsLeftWidth + minPad + rightSideWidth <= width) {
      const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
      lines.push(statsLeft + padding + rightSide);
    } else {
      lines.push(truncateToWidth(statsLeft, width));
    }

    return lines;
  }
}
