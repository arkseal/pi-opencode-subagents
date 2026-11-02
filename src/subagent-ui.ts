import { Box, Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import { formatTranscriptLines } from "./transcript-formatter.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatSubagentStats(stats: any, theme: any): string {
  if (!stats) return "";
  const parts: string[] = [];

  if (stats.tokensIn > 0 || stats.tokensOut > 0 || stats.cacheRead > 0) {
    const tokenParts: string[] = [
      `${theme.fg("accent", formatTokens(stats.tokensIn))} ${theme.fg("dim", "in")}`,
      `${theme.fg("accent", formatTokens(stats.tokensOut))} ${theme.fg("dim", "out")}`,
    ];
    if (stats.cacheRead > 0) {
      tokenParts.push(`${theme.fg("accent", formatTokens(stats.cacheRead))} ${theme.fg("dim", "cache")}`);
    }
    parts.push(tokenParts.join(theme.fg("dim", " · ")));
  }

  if (stats.toolCalls > 0) {
    parts.push(`${theme.fg("accent", String(stats.toolCalls))} ${theme.fg("dim", stats.toolCalls === 1 ? "tool" : "tools")}`);
  }

  if (stats.turns > 1) {
    parts.push(`${theme.fg("accent", String(stats.turns))} ${theme.fg("dim", "turns")}`);
  }

  if (typeof stats.cost === "number" && stats.cost > 0) {
    const costStr = stats.cost >= 0.01 ? `$${stats.cost.toFixed(2)}` : `$${stats.cost.toFixed(3)}`;
    parts.push(theme.fg("dim", costStr));
  }

  if (parts.length === 0) return "";
  return parts.join(theme.fg("dim", " · "));
}

/**
 * Strips raw XML wrapper envelopes (<task-result ...> and </task-result>)
 * and redundant footer lines so only the clean content is presented in the TUI.
 */
export function cleanSubagentOutput(raw: string): string {
  if (!raw) return "";
  let text = raw;

  // Strip <task-result...> and <subagent...> opening tags
  text = text.replace(/<(?:task-result|subagent)[^>]*>\s*/gi, "");

  // Strip </task-result> and </subagent> closing tags
  text = text.replace(/\s*<\/(?:task-result|subagent)>/gi, "");

  // Strip "Full transcript: ..." trailing line if present
  text = text.replace(/Full transcript:\s*\/[^\n]+/gi, "");

  return text.trim();
}

/**
 * Formats the tool call header (what is shown when the subagent is invoked).
 */
export function renderSubagentCall(args: any, theme: any, context: any) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

  let content = theme.fg("toolTitle", theme.bold("Subagent "));

  if (args?.agent && args.agent !== "general") {
    content += theme.fg("accent", `[${args.agent}] `);
  }

  const title = args?.description || (args?.task ? extractShortTitle(args.task) : args?.prompt ? extractShortTitle(args.prompt) : "Task");
  content += theme.fg("accent", `"${title}"`);

  if (args?.isolated === false) {
    content += " " + theme.fg("warning", "[shared]");
  } else {
    content += " " + theme.fg("dim", "[isolated]");
  }

  if (args?.model) {
    const reasoningSuffix = (args?.reasoning || args?.thinking) && !args.model.includes(":")
      ? `:${args.reasoning ?? args.thinking}`
      : "";
    content += " " + theme.fg("dim", `[${args.model}${reasoningSuffix}]`);
  } else if (args?.reasoning || args?.thinking) {
    content += " " + theme.fg("dim", `[reasoning:${args.reasoning ?? args.thinking}]`);
  }

  if (args?.background === false) {
    content += " " + theme.fg("dim", "· blocking");
  } else {
    content += " " + theme.fg("dim", "· background");
  }

  if (context.isPartial) {
    const elapsed = context.state?.elapsedMs
      ? ` (${(context.state.elapsedMs / 1000).toFixed(1)}s)`
      : "";
    content += " " + theme.fg("dim", `· running${elapsed}`);
  }

  text.setText(content);
  return text;
}

/**
 * Strips or neutralizes ANSI resets (\x1b[0m or \x1b[m) that clear terminal background colors
 * inside shaded TUI boxes, replacing them with attribute-only resets (\x1b[39;22;23;24m)
 * and stripping explicit background resets (\x1b[49m).
 */
export function preserveBg(text: string): string {
  return text.replace(/\x1b\[0?m/g, "\x1b[39;22;23;24m").replace(/\x1b\[49m/g, "");
}

/**
 * Live, self-updating component for subagent tool execution results.
 * Continuously animates the braille spinner while background subagents run,
 * and dynamically transitions to completed/failed status when finished.
 */
export class SubagentResultLiveComponent implements Component {
  constructor(
    public result: any,
    public options: { expanded: boolean; isPartial?: boolean },
    public theme: any,
    public context: any
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const details = this.result?.details ?? {};

    // Check live status from globalSubagentTracker to reflect background execution state
    let currentStatus = details.status;
    let liveDurationMs = details.durationMs;
    let liveSummary = details.summary;
    let liveStats = details.stats;
    let liveLogFile = details.logFile;
    let liveExitCode = details.exitCode;

    const g = globalThis as any;
    if (details.id && g.__PI_SUBAGENTS_TRACKER__) {
      const tracker = g.__PI_SUBAGENTS_TRACKER__;
      const active = tracker.getActiveList?.()?.find((s: any) => s.id === details.id);
      const recent = tracker.getRecentList?.()?.find((s: any) => s.id === details.id);
      const item = active || recent;
      if (item) {
        currentStatus = item.status;
        liveDurationMs = item.durationMs ?? (item.endTime ? item.endTime - item.startTime : undefined);
        liveStats = item.stats || liveStats;
        liveLogFile = item.logFile || liveLogFile;
        liveExitCode = item.exitCode ?? liveExitCode;
      }
    } else if (details.background && !details.durationMs && details.status !== "failed" && details.status !== "aborted") {
      currentStatus = "running";
    }

    // 1. In-progress state (streaming or running in background)
    if (this.options.isPartial || currentStatus === "running") {
      const frameIndex = Math.floor((Date.now() / 90) % SPINNER_FRAMES.length);
      const spinner = this.theme.fg("accent", SPINNER_FRAMES[frameIndex]);
      const startTime = details.startTime || Date.now();
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

      const isBg = details.background || currentStatus === "running";
      const label = isBg ? "Running subagent in background" : "Running subagent";
      let progressText = `${spinner} ${this.theme.bold(this.theme.fg("accent", label))} ${this.theme.fg("dim", `(${elapsedSec}s)`)}`;
      if (details.id) {
        progressText += ` ${this.theme.fg("dim", `[${details.id}]`)}`;
      }
      if (liveStats && liveStats.totalTokens > 0) {
        progressText += ` ${this.theme.fg("dim", `· ${formatTokens(liveStats.totalTokens)} tkns`)}`;
      }

      if (details.currentLine) {
        const clean = stripTerminalSequences(details.currentLine.replace(/[\r\n\t]+/g, " ").trim());
        const line = truncateToWidth(clean, Math.max(10, width - 6));
        progressText += `\n  ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", line)}`;
      } else if (isBg) {
        progressText += `\n  ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", "Working in background · live progress in /subagents")}`;
      } else {
        progressText += `\n  ${this.theme.fg("muted", "↳")} ${this.theme.fg("dim", "Executing tasks...")}`;
      }

      return preserveBg(progressText).split("\n");
    }

    // 2. Completed / Succeeded / Failed state
    const isError = this.result.isError || currentStatus === "failed" || currentStatus === "aborted" || (liveExitCode !== undefined && liveExitCode !== 0);
    const durationSec = liveDurationMs ? (liveDurationMs / 1000).toFixed(1) : undefined;
    const statusIcon = isError ? this.theme.fg("error", "▲") : this.theme.fg("success", "●");
    const statusLabel = isError
      ? this.theme.fg("error", this.theme.bold(`Subagent failed${liveExitCode ? ` (exit ${liveExitCode})` : ""}`))
      : this.theme.fg("toolTitle", this.theme.bold("Subagent completed"));

    let outputText = `${statusIcon} ${statusLabel}`;
    if (durationSec) {
      outputText += " " + this.theme.fg("dim", `in ${durationSec}s`);
    }
    if (details.id) {
      outputText += " " + this.theme.fg("dim", `[${details.id}]`);
    }

    const statsBadge = formatSubagentStats(liveStats, this.theme);
    const cum = details.cumulativeStats;
    let cumSuffix = "";
    if (cum && cum.subagentCount > 1 && cum.totalTokens > 0) {
      cumSuffix = ` ${this.theme.fg("dim", `· aggregate: ${formatTokens(cum.totalTokens)} (${cum.subagentCount} agents)`)}`;
    }
    if (statsBadge) {
      outputText += `\n  ${this.theme.fg("muted", "↳")} ${statsBadge}${cumSuffix}`;
    }

    // Extract human summary
    const rawContent = this.result.content?.[0]?.type === "text" ? this.result.content[0].text : "";
    const cleaned = cleanSubagentOutput(liveSummary || rawContent);

    // Collapsed View (compact preview)
    if (!this.options.expanded) {
      if (cleaned) {
        const previewLines = cleaned.split("\n").filter((l: string) => l.trim().length > 0).slice(0, 4);
        for (const line of previewLines) {
          outputText += `\n  ${this.theme.fg("muted", "│")} ${this.theme.fg("toolOutput", line)}`;
        }
        const totalLines = cleaned.split("\n").length;
        if (totalLines > 4) {
          outputText += `\n  ${this.theme.fg("muted", "│")} ${this.theme.fg("dim", `... (${totalLines - 4} more lines · ctrl+o to expand)`)}`;
        } else {
          outputText += `\n  ${this.theme.fg("dim", "(ctrl+o to expand)")}`;
        }
      }
    } else {
      // Expanded View (full transcript and worktree details)
      outputText += "\n" + this.theme.fg("dim", "─".repeat(Math.min(50, width)));

      const effectiveModel = details.model || liveStats?.model;
      const effectiveReasoning = details.reasoning || liveStats?.thinkingLevel;
      if (effectiveModel) {
        const reasoningSuffix = effectiveReasoning ? ` (${effectiveReasoning} reasoning)` : "";
        outputText += `\n${this.theme.fg("muted", "Model:")} ${this.theme.fg("accent", effectiveModel)}${this.theme.fg("dim", reasoningSuffix)}`;
      } else if (effectiveReasoning) {
        outputText += `\n${this.theme.fg("muted", "Reasoning:")} ${this.theme.fg("dim", effectiveReasoning)}`;
      }

      if (liveStats && (liveStats.totalTokens > 0 || liveStats.toolCalls > 0)) {
        const s = liveStats;
        const formattedParts = [
          `${s.tokensIn.toLocaleString()} in`,
          `${s.tokensOut.toLocaleString()} out`,
        ];
        if (s.cacheRead > 0) formattedParts.push(`${s.cacheRead.toLocaleString()} cache read`);
        outputText += `\n${this.theme.fg("muted", "Tokens:")} ${this.theme.fg("dim", formattedParts.join(" · "))} ${this.theme.fg("dim", `(${s.totalTokens.toLocaleString()} total)`)}`;
        outputText += `\n${this.theme.fg("muted", "Operations:")} ${this.theme.fg("dim", `${s.toolCalls} tool calls · ${s.turns} turns`)}${s.cost ? ` · ${this.theme.fg("dim", `$${s.cost.toFixed(4)}`)}` : ""}`;
      }

      if (details.worktree) {
        const wt = details.worktree;
        outputText += `\n${this.theme.fg("muted", "Worktree:")} ${this.theme.fg("dim", wt.path || "isolated")}`;
        if (wt.branch) {
          outputText += ` (${this.theme.fg("accent", wt.branch)})`;
        }
      }

      if (liveLogFile) {
        outputText += `\n${this.theme.fg("muted", "Log File:")} ${this.theme.fg("accent", liveLogFile)}`;
      }

      outputText += "\n" + this.theme.fg("dim", "─".repeat(Math.min(50, width)));

      let sourceLines: string[] = [];
      if (liveLogFile && fs.existsSync(liveLogFile)) {
        try {
          sourceLines = fs.readFileSync(liveLogFile, "utf-8").split("\n");
        } catch {
          sourceLines = cleaned.split("\n");
        }
      } else {
        sourceLines = cleaned.split("\n");
      }

      const formattedTranscript = formatTranscriptLines(sourceLines, this.theme, Math.max(20, width - 6));
      for (const line of formattedTranscript) {
        outputText += `\n${line}`;
      }
    }

    return preserveBg(outputText).split("\n");
  }
}

/**
 * Formats the tool execution result with OpenCode-style card layout.
 */
export function renderSubagentResult(
  result: any,
  options: { expanded: boolean; isPartial?: boolean },
  theme: any,
  context: any
): Component {
  let comp = context?.lastComponent as SubagentResultLiveComponent | undefined;
  if (!comp || !(comp instanceof SubagentResultLiveComponent)) {
    comp = new SubagentResultLiveComponent(result, options, theme, context);
  } else {
    comp.result = result;
    comp.options = options;
    comp.theme = theme;
    comp.context = context;
  }
  return comp;
}

function extractShortTitle(task: string): string {
  const firstLine = task.trim().split("\n")[0].trim();
  if (firstLine.length <= 48) return firstLine;
  return `${firstLine.slice(0, 45)}...`;
}

export function buildSubagentStatsSummary(items: any[]): { text: string; details: any } {
  if (items.length === 0) {
    return { text: "No subagents have been executed yet.", details: null };
  }
  let totalIn = 0;
  let totalOut = 0;
  let totalCache = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let totalToolCalls = 0;
  let totalTurns = 0;
  let totalDurationMs = 0;

  const lines: string[] = ["Subagent Stats Summary\n"];

  for (const s of items) {
    const durSec = ((s.durationMs ?? (Date.now() - s.startTime)) / 1000).toFixed(1);
    const title = s.description || (s.task.length > 36 ? `${s.task.slice(0, 33)}...` : s.task);
    const st = s.stats;
    totalDurationMs += s.durationMs ?? 0;
    if (st) {
      totalIn += st.tokensIn;
      totalOut += st.tokensOut;
      totalCache += st.cacheRead;
      totalTokens += st.totalTokens;
      totalCost += st.cost ?? 0;
      totalToolCalls += st.toolCalls;
      totalTurns += st.turns;
      const tokStr = `${formatTokens(st.tokensIn)} in · ${formatTokens(st.tokensOut)} out${st.cacheRead > 0 ? ` · ${formatTokens(st.cacheRead)} cache` : ""}`;
      const toolStr = st.toolCalls > 0 ? ` · ${st.toolCalls} ${st.toolCalls === 1 ? "tool" : "tools"}` : "";
      const costStr = st.cost && st.cost > 0 ? ` · $${st.cost.toFixed(3)}` : "";
      lines.push(`• [${s.id}] "${title}" (${s.status}, ${durSec}s)${s.model ? ` [${s.model}]` : ""}`);
      lines.push(`  ↳ ${tokStr}${toolStr}${costStr}`);
    } else {
      lines.push(`• [${s.id}] "${title}" (${s.status}, ${durSec}s)${s.model ? ` [${s.model}]` : ""}`);
    }
  }

  lines.push("\n────────────────────────────────────────────");
  const costSummary = totalCost > 0 ? ` · $${totalCost.toFixed(3)}` : "";
  const cacheSummary = totalCache > 0 ? ` · ${formatTokens(totalCache)} cache` : "";
  lines.push(`Total: ${items.length} subagents · ${formatTokens(totalTokens)} tkns (${formatTokens(totalIn)} in · ${formatTokens(totalOut)} out${cacheSummary}) · ${totalToolCalls} tools${costSummary} · ${(totalDurationMs / 1000).toFixed(1)}s`);

  return {
    text: lines.join("\n"),
    details: {
      subagentCount: items.length,
      totalIn,
      totalOut,
      totalCache,
      totalTokens,
      totalCost,
      totalToolCalls,
      totalTurns,
      totalDurationMs,
    },
  };
}

export function renderSubagentStatsMessage(message: any, { outputPad }: any, theme: any) {
  const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
  const header = theme.bold(theme.fg("toolTitle", "◈ Subagent Resource Usage\n"));
  box.addChild(new Text(header + message.content, 0, 0));
  return box;
}

/**
 * Renders visually compacted subagent response messages in the main chat (matching tool call styling).
 * Supports expanding full transcript via ctrl+o / click.
 */
export function renderSubagentResponseMessage(
  message: any,
  options: { expanded?: boolean; outputPad?: number },
  theme: any
) {
  const isExpanded = Boolean(options?.expanded);
  const details = message?.details || {};
  const isError = details.status === "failed" || details.status === "aborted";
  const durationSec = details.durationMs ? (details.durationMs / 1000).toFixed(1) : undefined;
  const statusIcon = isError ? theme.fg("error", "▲") : theme.fg("success", "●");
  const agentLabel = details.agent ? ` · ${theme.fg("muted", details.agent)}` : "";

  let header = `${statusIcon} ${theme.bold(theme.fg("toolTitle", "Subagent completed"))} ${theme.fg("accent", `[${details.id || "subagent"}]`)}${agentLabel}`;
  if (durationSec) {
    header += ` ${theme.fg("dim", `in ${durationSec}s`)}`;
  }

  const rawText = typeof message?.content === "string" ? message.content : (message?.content?.[0]?.text || "");
  const summaryText = details.summary || cleanSubagentOutput(rawText);

  const lines: string[] = [header];

  // Stats badge
  const statsBadge = formatSubagentStats(details.stats, theme);
  if (statsBadge) {
    lines.push(`  ${theme.fg("muted", "↳")} ${statsBadge}`);
  }

  const textLines = summaryText
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0);

  if (!isExpanded) {
    // Compact preview: show up to 3 lines with gutter │
    const preview = textLines.slice(0, 3);
    for (const l of preview) {
      lines.push(`  ${theme.fg("muted", "│")} ${theme.fg("toolOutput", truncateToWidth(l, 80))}`);
    }
    if (textLines.length > 3) {
      lines.push(`  ${theme.fg("muted", "│")} ${theme.fg("dim", `... (${textLines.length - 3} more lines · ctrl+o to expand)`)}`);
    } else {
      lines.push(`  ${theme.fg("muted", "│")} ${theme.fg("dim", `(ctrl+o to expand full transcript)`)}`);
    }
  } else {
    // Expanded view: full response
    lines.push(theme.fg("dim", "─".repeat(50)));
    for (const l of textLines) {
      lines.push(`  ${theme.fg("toolOutput", l)}`);
    }
    if (details.logFile) {
      lines.push(theme.fg("dim", `Full transcript: ${details.logFile}`));
    }
  }

  const pad = options?.outputPad ?? 1;
  const box = new Box(pad, 0, (t) => theme.bg("toolSuccessBg", t));
  const sanitizedText = preserveBg(lines.join("\n"));
  box.addChild(new Text(sanitizedText, 0, 0));
  return box;
}
