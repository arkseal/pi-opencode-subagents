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

  // Strip <task-result...> opening tag
  text = text.replace(/<task-result[^>]*>\s*/gi, "");

  // Strip </task-result> closing tag
  text = text.replace(/\s*<\/task-result>/gi, "");

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

  const title = args?.description || (args?.task ? extractShortTitle(args.task) : "Task");
  content += theme.fg("accent", `"${title}"`);

  if (args?.isolated === false) {
    content += " " + theme.fg("warning", "[shared]");
  } else {
    content += " " + theme.fg("dim", "[isolated]");
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
 * Formats the tool execution result with OpenCode-style card layout.
 */
export function renderSubagentResult(
  result: any,
  options: { expanded: boolean; isPartial?: boolean },
  theme: any,
  context: any
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const details = result?.details ?? {};

  // 1. In-progress state (streaming while subagent runs)
  if (options.isPartial) {
    const frameIndex = Math.floor((Date.now() / 90) % SPINNER_FRAMES.length);
    const spinner = theme.fg("accent", SPINNER_FRAMES[frameIndex]);
    const elapsedSec = details.elapsedMs
      ? (details.elapsedMs / 1000).toFixed(1)
      : ((Date.now() - (context.executionStarted || Date.now())) / 1000).toFixed(1);

    let progressText = `${spinner} ${theme.bold("Running subagent")} ${theme.fg("dim", `(${elapsedSec}s)`)}`;
    if (details.stats && details.stats.totalTokens > 0) {
      progressText += ` ${theme.fg("dim", `· ${formatTokens(details.stats.totalTokens)} tkns`)}`;
    }

    if (details.currentLine) {
      const clean = stripTerminalSequences(details.currentLine.replace(/[\r\n\t]+/g, " ").trim());
      const line = truncateToWidth(clean, 70);
      progressText += `\n  ${theme.fg("muted", "↳")} ${theme.fg("dim", line)}`;
    } else {
      progressText += `\n  ${theme.fg("muted", "↳")} ${theme.fg("dim", "Executing tasks...")}`;
    }

    text.setText(progressText);
    return text;
  }

  // 2. Completed / Succeeded / Failed state
  const isError = result.isError || details.status === "failed" || (details.exitCode !== undefined && details.exitCode !== 0);
  const durationSec = details.durationMs ? (details.durationMs / 1000).toFixed(1) : undefined;
  const statusIcon = isError ? theme.fg("error", "▲") : theme.fg("success", "●");
  const statusLabel = isError
    ? theme.fg("error", theme.bold(`Subagent failed${details.exitCode ? ` (exit ${details.exitCode})` : ""}`))
    : theme.fg("toolTitle", theme.bold("Subagent completed"));

  let outputText = `${statusIcon} ${statusLabel}`;
  if (durationSec) {
    outputText += " " + theme.fg("dim", `in ${durationSec}s`);
  }
  if (details.id) {
    outputText += " " + theme.fg("dim", `[${details.id}]`);
  }

  const statsBadge = formatSubagentStats(details.stats, theme);
  const cum = details.cumulativeStats;
  let cumSuffix = "";
  if (cum && cum.subagentCount > 1 && cum.totalTokens > 0) {
    cumSuffix = ` ${theme.fg("dim", `· aggregate: ${formatTokens(cum.totalTokens)} (${cum.subagentCount} agents)`)}`;
  }
  if (statsBadge) {
    outputText += `\n  ${theme.fg("muted", "↳")} ${statsBadge}${cumSuffix}`;
  }

  // Extract human summary
  const rawContent = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  const cleaned = cleanSubagentOutput(details.summary || rawContent);

  // Collapsed View (compact preview)
  if (!options.expanded) {
    if (cleaned) {
      const previewLines = cleaned.split("\n").filter((l: string) => l.trim().length > 0).slice(0, 4);
      for (const line of previewLines) {
        outputText += `\n  ${theme.fg("muted", "│")} ${theme.fg("toolOutput", line)}`;
      }
      const totalLines = cleaned.split("\n").length;
      if (totalLines > 4) {
        outputText += `\n  ${theme.fg("muted", "│")} ${theme.fg("dim", `... (${totalLines - 4} more lines · click or ctrl+e to expand)`)}`;
      } else {
        outputText += `\n  ${theme.fg("dim", "(click or ctrl+e to view full transcript)")}`;
      }
    }
  } else {
    // Expanded View (full transcript and worktree details)
    outputText += "\n" + theme.fg("dim", "─".repeat(50));

    if (details.stats && (details.stats.totalTokens > 0 || details.stats.toolCalls > 0)) {
      const s = details.stats;
      const formattedParts = [
        `${s.tokensIn.toLocaleString()} in`,
        `${s.tokensOut.toLocaleString()} out`,
      ];
      if (s.cacheRead > 0) formattedParts.push(`${s.cacheRead.toLocaleString()} cache read`);
      outputText += `\n${theme.fg("muted", "Tokens:")} ${theme.fg("dim", formattedParts.join(" · "))} ${theme.fg("dim", `(${s.totalTokens.toLocaleString()} total)`)}`;
      outputText += `\n${theme.fg("muted", "Operations:")} ${theme.fg("dim", `${s.toolCalls} tool calls · ${s.turns} turns`)}${s.cost ? ` · ${theme.fg("dim", `$${s.cost.toFixed(4)}`)}` : ""}`;
      if (details.cumulativeStats && details.cumulativeStats.subagentCount > 1) {
        const c = details.cumulativeStats;
        outputText += `\n${theme.fg("muted", "Aggregate:")} ${theme.fg("dim", `${c.tokensIn.toLocaleString()} in · ${c.tokensOut.toLocaleString()} out · ${c.totalTokens.toLocaleString()} total across ${c.subagentCount} subagents`)}`;
      }
    }

    if (details.worktree) {
      outputText += `\n${theme.fg("muted", "Worktree:")} ${theme.fg("dim", details.worktree.path || "isolated")}`;
      if (details.worktree.branch) {
        outputText += ` (${theme.fg("accent", details.worktree.branch)})`;
      }
    }

    if (details.logFile) {
      outputText += `\n${theme.fg("muted", "Log File:")} ${theme.fg("accent", details.logFile)}`;
    }

    outputText += "\n" + theme.fg("dim", "─".repeat(50));

    let sourceLines: string[] = [];
    if (details.logFile && fs.existsSync(details.logFile)) {
      try {
        sourceLines = fs.readFileSync(details.logFile, "utf-8").split("\n");
      } catch {
        sourceLines = cleaned.split("\n");
      }
    } else {
      sourceLines = cleaned.split("\n");
    }

    const formattedTranscript = formatTranscriptLines(sourceLines, theme, 74);
    for (const line of formattedTranscript) {
      outputText += `\n${line}`;
    }
  }

  text.setText(outputText);
  return text;
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
      lines.push(`• [${s.id}] "${title}" (${s.status}, ${durSec}s)`);
      lines.push(`  ↳ ${tokStr}${toolStr}${costStr}`);
    } else {
      lines.push(`• [${s.id}] "${title}" (${s.status}, ${durSec}s)`);
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
  const header = theme.bold(theme.fg("toolTitle", "📊 Subagent Resource Usage\n"));
  box.addChild(new Text(header + message.content, 0, 0));
  return box;
}
