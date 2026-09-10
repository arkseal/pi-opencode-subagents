import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const KNOWN_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "antigravity_search",
  "antigravity_quota",
  "task_logs",
  "subagent",
  "mcp_call",
  "mcp_list",
  "goal_complete",
  "goal_blocked",
  "goal_wait",
  "ast_edit",
  "hashline_edit",
]);

export function formatTranscriptLines(
  rawLines: string[],
  theme: any,
  width: number
): string[] {
  const formatted: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  const innerWidth = Math.max(25, width - 4);

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i].replace(/\r/g, "");
    const trimmed = rawLine.trim();

    // 1. Fenced Code Block Toggle
    if (trimmed.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim() || "code";
        const headerDashes = Math.max(2, innerWidth - codeBlockLang.length - 8);
        formatted.push(
          `  ${theme.fg("dim", "┌─ ")}${theme.fg("accent", codeBlockLang)} ${theme.fg("dim", "─".repeat(headerDashes) + "┐")}`
        );
      } else {
        inCodeBlock = false;
        formatted.push(
          `  ${theme.fg("dim", "└" + "─".repeat(Math.max(2, innerWidth - 4)) + "┘")}`
        );
      }
      continue;
    }

    // Inside Code Block: gutter style identical to chat code blocks
    if (inCodeBlock) {
      const paddedCode = truncateToWidth(rawLine, innerWidth - 6);
      formatted.push(`  ${theme.fg("dim", "│")} ${theme.fg("toolOutput", paddedCode)}`);
      continue;
    }

    // 2. Empty line
    if (!trimmed) {
      if (formatted.length > 0 && formatted[formatted.length - 1] !== "") {
        formatted.push("");
      }
      continue;
    }

    // 3. Tool Invocation Start (supports both -> [tool] and native formats like ● read ..., $ ...)
    const toolStartMatch = parseToolStart(trimmed);
    if (toolStartMatch) {
      if (formatted.length > 0 && formatted[formatted.length - 1] !== "") {
        formatted.push("");
      }
      const { toolName, toolArgs } = toolStartMatch;
      const isBash = toolName === "bash" || toolName === "$";
      const titlePrefix = isBash ? "$ " : `${toolName} `;
      const titleStr = theme.fg("toolTitle", theme.bold(titlePrefix));
      const argsStr = toolArgs ? theme.fg("accent", toolArgs) : "";
      formatted.push(`  ${titleStr}${argsStr}`);
      continue;
    }

    // 4. Tool Invocation Result (supports <- [tool] ..., ✔ ..., ▲ ...)
    const toolEndMatch = parseToolEnd(trimmed);
    if (toolEndMatch) {
      const { isError, resultText } = toolEndMatch;
      const icon = isError ? theme.fg("error", "▲") : theme.fg("success", "✔");
      formatted.push(`    ${icon} ${theme.fg("dim", resultText)}`);
      continue;
    }

    // 5. Tool Output Body (e.g. lists of files, json snippets, command stdout directly following a tool)
    if (rawLine.startsWith("   ") || rawLine.startsWith("    ") || (rawLine.startsWith("  ") && !rawLine.startsWith("  -"))) {
      formatted.push(`    ${theme.fg("dim", truncateToWidth(trimmed, innerWidth - 6))}`);
      continue;
    }

    // 6. Markdown Headings
    if (trimmed.startsWith("### ")) {
      formatted.push("");
      const heading = trimmed.slice(4);
      formatted.push(`  ${theme.bold(theme.fg("toolTitle", heading))}`);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      formatted.push("");
      const heading = trimmed.slice(3);
      formatted.push(`  ${theme.bold(theme.fg("accent", heading))}`);
      formatted.push(`  ${theme.fg("dim", "─".repeat(Math.min(heading.length + 4, innerWidth - 4)))}`);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      formatted.push("");
      const heading = trimmed.slice(2);
      formatted.push(`  ${theme.bold(theme.fg("accent", theme.bold(heading)))}`);
      formatted.push(`  ${theme.fg("dim", "═".repeat(Math.min(heading.length + 4, innerWidth - 4)))}`);
      continue;
    }

    // 7. Key-Value bullet points (e.g. - **Name:** value or - Name: value)
    const kvMatch = trimmed.match(/^[-*]\s+\*\*([^*]+)\*\*:\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2];
      formatted.push(`  ${theme.fg("accent", "•")} ${theme.bold(theme.fg("toolTitle", key + ":"))} ${theme.fg("toolOutput", val)}`);
      continue;
    }

    // 8. Standard Bullet list items
    if (/^[-*]\s+/.test(trimmed)) {
      const bulletContent = trimmed.replace(/^[-*]\s+/, "");
      formatted.push(`  ${theme.fg("accent", "•")} ${theme.fg("toolOutput", bulletContent)}`);
      continue;
    }

    // 9. Numbered list items
    const numMatch = trimmed.match(/^(\d+\.)\s+(.+)$/);
    if (numMatch) {
      formatted.push(`  ${theme.fg("accent", numMatch[1])} ${theme.fg("toolOutput", numMatch[2])}`);
      continue;
    }

    // 10. Horizontal rule dividers
    if (trimmed === "---" || trimmed === "___" || trimmed === "***") {
      formatted.push(`  ${theme.fg("dim", "─".repeat(Math.min(50, innerWidth - 4)))}`);
      continue;
    }

    // 11. Regular text / paragraphs
    formatted.push(`  ${theme.fg("toolOutput", truncateToWidth(rawLine, innerWidth - 4))}`);
  }

  return formatted;
}

function parseToolStart(trimmed: string): { toolName: string; toolArgs: string } | null {
  // Pattern 1: -> [tool] <name> <args>
  if (trimmed.startsWith("-> [tool]")) {
    const rest = trimmed.slice(9).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx > 0) {
      return { toolName: rest.slice(0, spaceIdx), toolArgs: rest.slice(spaceIdx + 1).trim() };
    }
    return { toolName: rest, toolArgs: "" };
  }

  // Pattern 2: ● <name> <args>
  if (trimmed.startsWith("● ")) {
    const rest = trimmed.slice(2).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx > 0) {
      const toolName = rest.slice(0, spaceIdx).replace(/:$/, "");
      if (KNOWN_TOOLS.has(toolName) || toolName === "$") {
        return { toolName, toolArgs: rest.slice(spaceIdx + 1).trim() };
      }
    }
  }

  // Pattern 3: $ <command>
  if (trimmed.startsWith("$ ")) {
    return { toolName: "$", toolArgs: trimmed.slice(2).trim() };
  }

  // Pattern 4: Direct tool calls (e.g. read path/to/file, glob **/*.ts)
  const firstWordMatch = trimmed.match(/^([a-z_]+)\s+(.+)$/);
  if (firstWordMatch && KNOWN_TOOLS.has(firstWordMatch[1])) {
    return { toolName: firstWordMatch[1], toolArgs: firstWordMatch[2].trim() };
  }

  return null;
}

function parseToolEnd(trimmed: string): { isError: boolean; resultText: string } | null {
  // Pattern 1: <- [tool] <result>
  if (trimmed.startsWith("<- [tool]")) {
    const rest = trimmed.slice(9).trim();
    const isError = rest.includes("(error") || rest.includes("(failed") || rest.includes("error:");
    let clean = rest;
    // Strip tool name prefix if present (e.g. "bash: done" -> "done")
    const colonIdx = clean.indexOf(":");
    if (colonIdx > 0 && colonIdx < 15) {
      clean = clean.slice(colonIdx + 1).trim();
    }
    return { isError, resultText: clean };
  }

  // Pattern 2: ✔ <result>
  if (trimmed.startsWith("✔ ") || trimmed.startsWith("✓ ")) {
    return { isError: false, resultText: trimmed.slice(2).trim() };
  }

  // Pattern 3: ▲ <error>
  if (trimmed.startsWith("▲ ") || trimmed.startsWith("✗ ")) {
    return { isError: true, resultText: trimmed.slice(2).trim() };
  }

  return null;
}
