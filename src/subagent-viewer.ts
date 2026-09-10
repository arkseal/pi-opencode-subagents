import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";

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
  private lines: string[] = [];
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
        this.lines = content.split("\n");
        if (this.autoTail) {
          const maxVisible = 16;
          this.scrollOffset = Math.max(0, this.lines.length - maxVisible);
        }
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

    if (matchesKey(data, "up")) {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down")) {
      this.scrollOffset = Math.min(Math.max(0, this.lines.length - 5), this.scrollOffset + 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "pageup")) {
      this.autoTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.tui.requestRender();
    } else if (matchesKey(data, "pagedown")) {
      this.scrollOffset = Math.min(Math.max(0, this.lines.length - 5), this.scrollOffset + 10);
      this.tui.requestRender();
    }
  }

  invalidate() {}

  render(width: number): string[] {
    const output: string[] = [];
    const maxVisibleRows = 18;

    // Header bar
    const title = this.task.length > 50 ? `${this.task.slice(0, 47)}...` : this.task;
    const headerTitle = ` Subagent: [${this.id}] "${title}" `;
    output.push(
      this.theme.fg(
        "toolTitle",
        `╭─${this.theme.bold(headerTitle)}${"─".repeat(Math.max(0, width - headerTitle.length - 3))}╮`
      )
    );

    // Status bar
    const statusLine = ` Status: ${this.status} ${this.duration ? `(${this.duration})` : ""} · Log: ${this.logPath} `;
    output.push(
      `${this.theme.fg("toolTitle", "│")} ${this.theme.fg("dim", truncateToWidth(statusLine, width - 4))} ${this.theme.fg("toolTitle", "│")}`
    );
    output.push(this.theme.fg("toolTitle", `├${"─".repeat(Math.max(0, width - 2))}┤`));

    // Content lines
    const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + maxVisibleRows);
    if (visibleLines.length === 0) {
      output.push(
        `${this.theme.fg("toolTitle", "│")} ${this.theme.fg("dim", "(No output recorded yet)")} ${this.theme.fg("toolTitle", "│")}`
      );
    } else {
      for (const line of visibleLines) {
        const sanitized = line.replace(/\r/g, "");
        const formatted = this.theme.fg("toolOutput", truncateToWidth(sanitized, width - 4));
        output.push(`${this.theme.fg("toolTitle", "│")} ${formatted} ${this.theme.fg("toolTitle", "│")}`);
      }
    }

    // Pad if fewer lines
    while (output.length < maxVisibleRows + 3) {
      output.push(`${this.theme.fg("toolTitle", "│")}${" ".repeat(Math.max(0, width - 2))}${this.theme.fg("toolTitle", "│")}`);
    }

    // Footer bar with keybinding hints
    output.push(this.theme.fg("toolTitle", `├${"─".repeat(Math.max(0, width - 2))}┤`));
    const footerText = ` Esc/q: Close · ↑/↓: Scroll · Lines ${this.scrollOffset + 1}-${Math.min(this.lines.length, this.scrollOffset + maxVisibleRows)} of ${this.lines.length} `;
    output.push(
      `${this.theme.fg("toolTitle", "│")} ${this.theme.fg("dim", footerText)}${" ".repeat(Math.max(0, width - footerText.length - 3))}${this.theme.fg("toolTitle", "│")}`
    );
    output.push(this.theme.fg("toolTitle", `╰${"─".repeat(Math.max(0, width - 2))}╯`));

    return output;
  }
}
