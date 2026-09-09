export interface TaskResultOptions {
  id: string;
  status: "completed" | "failed" | "aborted";
  durationMs: number;
  summary: string;
  logFilePath?: string;
}

export function truncateToBudget(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [Output truncated to fit context budget]`;
}

export function formatTaskResultEnvelope(opts: TaskResultOptions): string {
  const durationSec = (opts.durationMs / 1000).toFixed(1);
  const boundedSummary = truncateToBudget(opts.summary, 2000);

  const lines = [
    `<task-result id="${opts.id}" status="${opts.status}" duration="${durationSec}s">`,
    boundedSummary,
  ];

  if (opts.logFilePath) {
    lines.push(`Full transcript: ${opts.logFilePath}`);
  }

  lines.push("</task-result>");
  return lines.join("\n");
}
