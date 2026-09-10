import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import { formatTranscriptLines } from "./transcript-formatter.js";

export interface SubagentViewerOptions {
  id: string;
  task: string;
  logPath: string;
  isRunning: boolean;
  status: string;
  duration?: string;
  theme: any;
  tui: any;
  done: () => void;
}

export class SubagentViewer implements Component {
  private id: string;
  private task: string;
  private logPath: string;
  private isRunning: boolean;
  private status: string;
  private duration?: string;
  private theme: any;
  private tui: any;
  private done: () => void;
  private rawLines: string[] = [];
  private scrollOffset = 0;
  private autoTail = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SubagentViewerOptions) {
    this.id = opts.id;
    this.task = opts.task;
    this.logPath = opts.logPath;
    this.isRunning = opts.isRunning;
    this.status = opts.status;
    this.duration = opts.duration;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.done = opts.done;

    this.reloadLines();

    if (this.isRunning) {
      this.timer = setInterval(() => {
        this.reloadLines();
        this.tui.requestRender();
      }, 200);
    }
  }

  private reloadLines() {
    try {
      if (fs.existsSync(this.logPath)) {
        const content = fs.readFileSync(this.logPath, "utf-8");
        this.rawLines = content.split("\n");
      }
    } catch {}
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || data === "q" || data === "Q" || matchesKey(data, "return")) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.done();
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset++;
      this.tui.requestRender();
    } else if (matchesKey(data, "pageup")) {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 12);
      this.tui.requestRender();
    } else if (matchesKey(data, "pagedown") || data === " ") {
      this.scrollOffset += 12;
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
    const output: string[] = [];
    const maxVisibleRows = 20;
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

    // Header bar (breadcrumb styled like main agent TUI)
    const title = this.task.length > 45 ? `${this.task.slice(0, 42)}...` : this.task;
    const headerTitle = ` Subagent Transcript: [${this.id}] "${title}" `;
    const headerDashes = Math.max(0, innerWidth - visibleWidth(headerTitle) - 1);
    output.push(
      this.theme.fg(
        "toolTitle",
        `╭─${this.theme.bold(headerTitle)}${"─".repeat(headerDashes)}╮`
      )
    );

    // Sub-header with status & log path
    const statusIcon = this.status === "completed" ? this.theme.fg("success", "●") : this.status === "running" ? this.theme.fg("accent", "⠋") : this.theme.fg("error", "▲");
    const statusText = ` ${statusIcon} Status: ${this.status} ${this.duration ? `(${this.duration})` : ""} · Log: ${this.logPath} `;
    const padStatus = Math.max(0, innerWidth - visibleWidth(statusText));
    output.push(
      `${this.theme.fg("toolTitle", "│")}${this.theme.fg("dim", statusText)}${" ".repeat(padStatus)}${this.theme.fg("toolTitle", "│")}`
    );
    output.push(this.theme.fg("toolTitle", `├${"─".repeat(innerWidth)}┤`));

    // Calculate scrollbar thumb position
    const scrollMax = Math.max(1, totalLines - maxVisibleRows);
    const scrollRatio = Math.min(1, Math.max(0, this.scrollOffset / scrollMax));
    const thumbRow = Math.min(maxVisibleRows - 1, Math.floor(scrollRatio * maxVisibleRows));

    // Content rows with scrollbar track
    const visibleLines = formattedLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleRows);

    for (let r = 0; r < maxVisibleRows; r++) {
      const line = r < visibleLines.length ? visibleLines[r] : "";
      const scrollGlyph = totalLines > maxVisibleRows
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

    // Footer divider
    output.push(this.theme.fg("toolTitle", `├${"─".repeat(innerWidth)}┤`));

    // Navigation & location footer
    const pct = totalLines <= maxVisibleRows ? 100 : Math.round(scrollRatio * 100);
    const navHints = ` Esc/q: Close · ↑/↓/PgUp/PgDn: Scroll · Line ${this.scrollOffset + 1}-${Math.min(totalLines, this.scrollOffset + maxVisibleRows)} of ${totalLines} (${pct}%) `;
    const padFooter = Math.max(0, innerWidth - visibleWidth(navHints));

    output.push(
      `${this.theme.fg("toolTitle", "│")}${this.theme.fg("dim", navHints)}${" ".repeat(padFooter)}${this.theme.fg("toolTitle", "│")}`
    );
    output.push(this.theme.fg("toolTitle", `╰${"─".repeat(innerWidth)}╯`));

    return output;
  }
}
