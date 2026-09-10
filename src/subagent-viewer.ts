import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import { formatTranscriptLines } from "./transcript-formatter.js";
import type { SubagentTracker, TrackedSubagent } from "./tracker.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SubagentViewerOptions {
  id: string;
  task: string;
  logPath: string;
  theme: any;
  tui: any;
  tracker: SubagentTracker;
  done: () => void;
}

export class SubagentViewer implements Component {
  private id: string;
  private task: string;
  private logPath: string;
  private theme: any;
  private tui: any;
  private tracker: SubagentTracker;
  private done: () => void;
  private rawLines: string[] = [];
  private scrollOffset = 0;
  private autoTail = true;
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isDisposed = false;

  constructor(opts: SubagentViewerOptions) {
    this.id = opts.id;
    this.task = opts.task;
    this.logPath = opts.logPath;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.tracker = opts.tracker;
    this.done = opts.done;

    // Enter alternate screen buffer and enable SGR mouse tracking.
    // In alternate screen buffer, the terminal emulator completely disables window scrollback,
    // protecting the background chat and routing all mouse wheel events directly to handleInput!
    try {
      process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H");
    } catch {}

    this.reloadLines();

    // Live update ticker: animates spinner, ticks timer, and streams new transcript lines
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.reloadLines();

      const sub = this.getSubagentInfo();
      if (sub && sub.status !== "running" && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      this.tui.requestRender();
    }, 100);
  }

  private getSubagentInfo(): TrackedSubagent | undefined {
    return (
      this.tracker.getActiveList().find((s) => s.id === this.id) ??
      this.tracker.getRecentList().find((s) => s.id === this.id)
    );
  }

  private reloadLines() {
    try {
      if (fs.existsSync(this.logPath)) {
        const content = fs.readFileSync(this.logPath, "utf-8");
        this.rawLines = content.split("\n");
      }
    } catch {}
  }

  private cleanup() {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Disable mouse tracking and return terminal from alternate screen to main chat
    try {
      process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
    } catch {}
  }

  dispose() {
    this.cleanup();
  }

  handleInput(data: string) {
    // 1. Mouse wheel scrolling
    // SGR 1006: \x1b[<64;...M (wheel up), \x1b[<65;...M (wheel down)
    // Legacy X11: \x1b[M`... (wheel up), \x1b[Ma... (wheel down)
    if (data.includes("\x1b[<64;") || data.includes("\x1b[M`")) {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
      this.tui.requestRender();
      return;
    }

    if (data.includes("\x1b[<65;") || data.includes("\x1b[Ma")) {
      this.scrollOffset += 3;
      this.tui.requestRender();
      return;
    }

    // Ignore other mouse events (clicks, mouse move) so they don't trigger keys
    if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) {
      return;
    }

    // 2. Close modal
    if (
      matchesKey(data, "escape") ||
      data === "q" ||
      data === "Q" ||
      matchesKey(data, "return") ||
      matchesKey(data, "ctrl+c")
    ) {
      this.cleanup();
      this.done();
      return;
    }

    // 3. Keyboard navigation
    if (matchesKey(data, "up") || data === "k") {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset++;
      this.tui.requestRender();
    } else if (matchesKey(data, "pageup")) {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.tui.requestRender();
    } else if (matchesKey(data, "pagedown") || data === " ") {
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

  invalidate() {}

  render(width: number): string[] {
    const sub = this.getSubagentInfo();
    const status = sub?.status ?? "completed";
    const startTime = sub?.startTime ?? Date.now();
    const endTime = sub?.endTime;
    const elapsedSec = (((endTime ?? Date.now()) - startTime) / 1000).toFixed(1) + "s";
    const currentAction = sub?.currentLine;

    const output: string[] = [];
    const termRows = typeof this.tui?.terminal?.rows === "number" ? this.tui.terminal.rows : 30;
    const maxVisibleRows = Math.max(10, termRows - 6);
    const innerWidth = Math.max(30, width - 2);

    // Format all lines through the transcript engine
    const formattedLines = formatTranscriptLines(this.rawLines, this.theme, innerWidth - 4);
    const totalLines = formattedLines.length;

    // Handle auto-tailing when at the bottom or running
    if (this.autoTail) {
      this.scrollOffset = Math.max(0, totalLines - maxVisibleRows);
    } else {
      this.scrollOffset = Math.min(Math.max(0, totalLines - maxVisibleRows), this.scrollOffset);
    }

    // 1. Header bar
    const maxTitleLen = Math.max(16, innerWidth - visibleWidth(` Subagent Transcript: [${this.id}] `) - 8);
    const title = this.task.length > maxTitleLen ? `${this.task.slice(0, maxTitleLen - 3)}...` : this.task;
    const headerTitle = ` Subagent Transcript: [${this.id}] "${title}" `;
    const headerDashes = Math.max(0, innerWidth - visibleWidth(headerTitle) - 1);
    output.push(
      this.theme.fg(
        "toolTitle",
        `╭─${this.theme.bold(headerTitle)}${"─".repeat(headerDashes)}╮`
      )
    );

    // 2. Sub-header with live animated spinner, real-time timer, status & log path
    const spinner = this.theme.fg("accent", SPINNER_FRAMES[this.frameIndex]);
    const statusIcon =
      status === "completed"
        ? this.theme.fg("success", "●")
        : status === "running"
        ? spinner
        : this.theme.fg("error", "▲");

    const statusText = ` ${statusIcon} Status: ${status} (${elapsedSec}) · Log: ${this.logPath} `;
    const padStatus = Math.max(0, innerWidth - visibleWidth(statusText));
    output.push(
      `${this.theme.fg("toolTitle", "│")}${this.theme.fg("dim", statusText)}${" ".repeat(padStatus)}${this.theme.fg("toolTitle", "│")}`
    );

    // 3. If running and an active tool/step peek is present, display it live
    if (status === "running" && currentAction) {
      const cleanAction = truncateToWidth(currentAction, innerWidth - 8);
      const actionText = `   ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", cleanAction)} `;
      const padAction = Math.max(0, innerWidth - visibleWidth(actionText));
      output.push(
        `${this.theme.fg("toolTitle", "│")}${actionText}${" ".repeat(padAction)}${this.theme.fg("toolTitle", "│")}`
      );
    }

    output.push(this.theme.fg("toolTitle", `├${"─".repeat(innerWidth)}┤`));

    // 4. Calculate scrollbar thumb position
    const scrollMax = Math.max(1, totalLines - maxVisibleRows);
    const scrollRatio = Math.min(1, Math.max(0, this.scrollOffset / scrollMax));
    const thumbRow = Math.min(maxVisibleRows - 1, Math.floor(scrollRatio * maxVisibleRows));

    // 5. Content rows with scrollbar track
    const visibleLines = formattedLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleRows);

    for (let r = 0; r < maxVisibleRows; r++) {
      const line = r < visibleLines.length ? visibleLines[r] : "";
      const scrollGlyph =
        totalLines > maxVisibleRows
          ? r === thumbRow
            ? this.theme.fg("accent", "█")
            : this.theme.fg("dim", "│")
          : " ";

      const contentWidth = visibleWidth(line);
      const paddingSpaces = Math.max(0, innerWidth - contentWidth - 3);

      output.push(
        `${this.theme.fg("toolTitle", "│")} ${line}${" ".repeat(paddingSpaces)} ${scrollGlyph}${this.theme.fg("toolTitle", "│")}`
      );
    }

    // 6. Footer divider
    output.push(this.theme.fg("toolTitle", `├${"─".repeat(innerWidth)}┤`));

    // 7. Navigation & location footer
    const pct = totalLines <= maxVisibleRows ? 100 : Math.round(scrollRatio * 100);
    const navHints = ` Esc/q: Close · Scroll/PgUp/PgDn: Navigate · Line ${this.scrollOffset + 1}-${Math.min(totalLines, this.scrollOffset + maxVisibleRows)} of ${totalLines} (${pct}%) `;
    const padFooter = Math.max(0, innerWidth - visibleWidth(navHints));

    output.push(
      `${this.theme.fg("toolTitle", "│")}${this.theme.fg("dim", navHints)}${" ".repeat(padFooter)}${this.theme.fg("toolTitle", "│")}`
    );
    output.push(this.theme.fg("toolTitle", `╰${"─".repeat(innerWidth)}╯`));

    return output;
  }
}
