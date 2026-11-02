import type { SubagentStats } from "./event-parser.js";

export interface TaskResultOptions {
  id: string;
  sessionID?: string;
  status: "completed" | "failed" | "aborted" | "running";
  durationMs: number;
  summary: string;
  logFilePath?: string;
  model?: string;
  reasoning?: string;
  stats?: SubagentStats;
  tag?: "task-result" | "subagent";
}

export function truncateToBudget(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [Output truncated to fit context budget]`;
}

export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatTaskResultEnvelope(opts: TaskResultOptions): string {
  const durationSec = (opts.durationMs / 1000).toFixed(1);
  const boundedSummary = truncateToBudget(opts.summary, 2000);
  const tag = opts.tag ?? "task-result";

  let modelAttr = "";
  const effectiveModel = opts.model || opts.stats?.model;
  if (effectiveModel) {
    modelAttr += ` model="${effectiveModel}"`;
  }
  const effectiveReasoning = opts.reasoning || opts.stats?.thinkingLevel;
  if (effectiveReasoning) {
    modelAttr += ` reasoning="${effectiveReasoning}"`;
  }

  let statsAttr = "";
  if (opts.stats && (opts.stats.totalTokens > 0 || opts.stats.toolCalls > 0)) {
    statsAttr = ` tokens_in="${opts.stats.tokensIn}" tokens_out="${opts.stats.tokensOut}" cache_read="${opts.stats.cacheRead}"`;
    if (opts.stats.toolCalls > 0) statsAttr += ` tool_calls="${opts.stats.toolCalls}"`;
    if (opts.stats.cost && opts.stats.cost > 0) statsAttr += ` cost="$${opts.stats.cost.toFixed(4)}"`;
  }

  const idAttr = tag === "subagent" ? `sessionID="${opts.sessionID || opts.id}"` : `id="${opts.id}"`;
  const stateAttr = tag === "subagent" ? `state="${opts.status}"` : `status="${opts.status}"`;

  const lines = [
    `<${tag} ${idAttr} ${stateAttr} duration="${durationSec}s"${modelAttr}${statsAttr}>`,
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

  lines.push(`</${tag}>`);
  return lines.join("\n");
}

export function formatSubagentEnvelope(opts: TaskResultOptions): string {
  return formatTaskResultEnvelope({ ...opts, tag: "subagent" });
}
