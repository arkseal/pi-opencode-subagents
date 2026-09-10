import { Text } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
    const frameIndex = Math.floor((Date.now() / 80) % SPINNER_FRAMES.length);
    const spinner = theme.fg("accent", SPINNER_FRAMES[frameIndex]);
    const elapsedSec = details.elapsedMs
      ? (details.elapsedMs / 1000).toFixed(1)
      : ((Date.now() - (context.executionStarted || Date.now())) / 1000).toFixed(1);

    let progressText = `${spinner} ${theme.bold("Running subagent")} ${theme.fg("dim", `(${elapsedSec}s)`)}`;

    if (details.currentLine) {
      const line = details.currentLine.length > 75
        ? `${details.currentLine.slice(0, 72)}...`
        : details.currentLine;
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

    const fullLines = cleaned.split("\n");
    for (const line of fullLines) {
      outputText += `\n  ${theme.fg("toolOutput", line)}`;
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
