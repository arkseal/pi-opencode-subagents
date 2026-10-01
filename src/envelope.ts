import type { SubagentStats } from "./event-parser.js";

export interface TaskResultOptions {
  id: string;
  status: "completed" | "failed" | "aborted";
  durationMs: number;
  summary: string;
  logFilePath?: string;
  stats?: SubagentStats;
}

export function truncateToBudget(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [Output truncated to fit context budget]`;
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatTaskResultEnvelope(opts: TaskResultOptions): string {
  const durationSec = (opts.durationMs / 1000).toFixed(1);
  const boundedSummary = truncateToBudget(opts.summary, 2000);

  let statsAttr = "";
  if (opts.stats && (opts.stats.totalTokens > 0 || opts.stats.toolCalls > 0)) {
    statsAttr = ` tokens_in="${opts.stats.tokensIn}" tokens_out="${opts.stats.tokensOut}" cache_read="${opts.stats.cacheRead}"`;
    if (opts.stats.toolCalls > 0) statsAttr += ` tool_calls="${opts.stats.toolCalls}"`;
    if (opts.stats.cost && opts.stats.cost > 0) statsAttr += ` cost="$${opts.stats.cost.toFixed(4)}"`;
  }

  const lines = [
    `<task-result id="${opts.id}" status="${opts.status}" duration="${durationSec}s"${statsAttr}>`,
    boundedSummary,
  ];

  if (opts.stats && (opts.stats.totalTokens > 0 || opts.stats.toolCalls > 0)) {
    const s = opts.stats;
    const parts = [
      `${formatTokensShort(s.tokensIn)} in`,
      `${formatTokensShort(s.tokensOut)} out`,
    ];
    if (s.cacheRead > 0) parts.push(`${formatTokensShort(s.cacheRead)} cache`);
    if (s.toolCalls > 0) parts.push(`${s.toolCalls} ${s.toolCalls === 1 ? "tool" : "tools"}`);
    if (s.cost && s.cost > 0) parts.push(`$${s.cost.toFixed(3)}`);
    lines.push(`Stats: ${parts.join(" · ")}`);
  }

  if (opts.logFilePath) {
    lines.push(`Full transcript: ${opts.logFilePath}`);
  }

  lines.push("</task-result>");
  return lines.join("\n");
}
