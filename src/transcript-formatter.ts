import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
  const maxContentWidth = Math.max(20, width);

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i].replace(/\r/g, "");
    const trimmed = rawLine.trim();

    // 1. Fenced Code Block Toggle
    if (trimmed.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim() || "code";
        const ruleLen = Math.max(4, maxContentWidth - codeBlockLang.length - 8);
        formatted.push(
          `  ${theme.fg("dim", "┌─ ")}${theme.fg("accent", codeBlockLang)} ${theme.fg("dim", "─".repeat(ruleLen) + "┐")}`
        );
      } else {
        inCodeBlock = false;
        const ruleLen = Math.max(4, maxContentWidth - 4);
        formatted.push(
          `  ${theme.fg("dim", "└" + "─".repeat(ruleLen) + "┘")}`
        );
      }
      continue;
    }

    // Inside Code Block: wrap code lines cleanly without truncation
    if (inCodeBlock) {
      const codeAvailWidth = Math.max(10, maxContentWidth - 6);
      const wrapped = wrapTextWithAnsi(rawLine, codeAvailWidth);
      if (wrapped.length === 0) {
        formatted.push(`  ${theme.fg("dim", "│")}`);
      } else {
        for (const line of wrapped) {
          formatted.push(`  ${theme.fg("dim", "│")} ${theme.fg("toolOutput", line)}`);
        }
      }
      continue;
    }

    // 2. Empty line
    if (!trimmed) {
      if (formatted.length > 0 && formatted[formatted.length - 1] !== "") {
        formatted.push("");
      }
      continue;
    }

    // 3. Tool Invocation Start (-> [tool] bash sleep 3 or ● read package.json)
    const toolStartMatch = parseToolStart(trimmed);
    if (toolStartMatch) {
      if (formatted.length > 0 && formatted[formatted.length - 1] !== "") {
        formatted.push("");
      }
      const { toolName, toolArgs } = toolStartMatch;
      const isBash = toolName === "bash" || toolName === "$";
      const titlePrefix = isBash ? "$ " : `${toolName} `;
      const titleStr = theme.fg("toolTitle", theme.bold(titlePrefix));
      const firstLinePrefix = `  ${titleStr}`;
      const prefixWidth = visibleWidth(`  ${titlePrefix}`);
      const availWidth = Math.max(10, maxContentWidth - prefixWidth);

      if (!toolArgs) {
        formatted.push(firstLinePrefix);
      } else {
        const wrappedArgs = wrapTextWithAnsi(toolArgs, availWidth);
        formatted.push(`${firstLinePrefix}${theme.fg("accent", wrappedArgs[0] || "")}`);
        for (let w = 1; w < wrappedArgs.length; w++) {
          formatted.push(`    ${theme.fg("accent", wrappedArgs[w])}`);
        }
      }
      continue;
    }

    // 4. Tool Invocation Result (<- [tool] bash: done or ✔ 5 files found)
    const toolEndMatch = parseToolEnd(trimmed);
    if (toolEndMatch) {
      const { isError, resultText } = toolEndMatch;
      const icon = isError ? theme.fg("error", "▲") : theme.fg("success", "✔");
      const iconPrefix = `    ${icon} `;
      const availWidth = Math.max(10, maxContentWidth - 8);
      const wrappedResult = wrapTextWithAnsi(resultText, availWidth);

      if (wrappedResult.length === 0) {
        formatted.push(`    ${icon}`);
      } else {
        formatted.push(`${iconPrefix}${theme.fg("dim", wrappedResult[0])}`);
        for (let w = 1; w < wrappedResult.length; w++) {
          formatted.push(`      ${theme.fg("dim", wrappedResult[w])}`);
        }
      }
      continue;
    }

    // 5. Tool Output Body (e.g. lists of files, json, stdout directly following a tool)
    if (
      rawLine.startsWith("   ") ||
      rawLine.startsWith("    ") ||
      (rawLine.startsWith("  ") && !rawLine.startsWith("  -") && !rawLine.startsWith("  *"))
    ) {
      const availWidth = Math.max(10, maxContentWidth - 6);
      const wrappedBody = wrapTextWithAnsi(trimmed, availWidth);
      for (const line of wrappedBody) {
        formatted.push(`    ${theme.fg("dim", line)}`);
      }
      continue;
    }

    // 6. Markdown Headings
    if (trimmed.startsWith("### ")) {
      formatted.push("");
      const heading = trimmed.slice(4);
      const wrapped = wrapTextWithAnsi(heading, Math.max(10, maxContentWidth - 4));
      for (const line of wrapped) {
        formatted.push(`  ${theme.bold(theme.fg("toolTitle", line))}`);
      }
      continue;
    }
    if (trimmed.startsWith("## ")) {
      formatted.push("");
      const heading = trimmed.slice(3);
      const wrapped = wrapTextWithAnsi(heading, Math.max(10, maxContentWidth - 4));
      for (const line of wrapped) {
        formatted.push(`  ${theme.bold(theme.fg("accent", line))}`);
      }
      formatted.push(`  ${theme.fg("dim", "─".repeat(Math.min(heading.length + 4, maxContentWidth - 4)))}`);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      formatted.push("");
      const heading = trimmed.slice(2);
      const wrapped = wrapTextWithAnsi(heading, Math.max(10, maxContentWidth - 4));
      for (const line of wrapped) {
        formatted.push(`  ${theme.bold(theme.fg("accent", line))}`);
      }
      formatted.push(`  ${theme.fg("dim", "═".repeat(Math.min(heading.length + 4, maxContentWidth - 4)))}`);
      continue;
    }

    // 7. Key-Value bullet points (- **Key:** Value)
    const kvMatch = trimmed.match(/^[-*]\s+\*\*([^*]+)\*\*:\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2];
      const keyPrefix = `  ${theme.fg("accent", "•")} ${theme.bold(theme.fg("toolTitle", key + ":"))} `;
      const keyWidth = visibleWidth(`  • ${key}: `);
      const availVal = Math.max(10, maxContentWidth - keyWidth);
      const wrappedVal = wrapTextWithAnsi(val, availVal);

      if (wrappedVal.length === 0) {
        formatted.push(keyPrefix);
      } else {
        formatted.push(`${keyPrefix}${theme.fg("toolOutput", wrappedVal[0])}`);
        for (let w = 1; w < wrappedVal.length; w++) {
          formatted.push(`    ${theme.fg("toolOutput", wrappedVal[w])}`);
        }
      }
      continue;
    }

    // 8. Standard Bullet list items (- item or * item)
    if (/^[-*]\s+/.test(trimmed)) {
      const bulletContent = trimmed.replace(/^[-*]\s+/, "");
      const bulletPrefix = `  ${theme.fg("accent", "•")} `;
      const availWidth = Math.max(10, maxContentWidth - 6);
      const wrappedBullet = wrapTextWithAnsi(bulletContent, availWidth);

      if (wrappedBullet.length === 0) {
        formatted.push(bulletPrefix);
      } else {
        formatted.push(`${bulletPrefix}${theme.fg("toolOutput", wrappedBullet[0])}`);
        for (let w = 1; w < wrappedBullet.length; w++) {
          formatted.push(`    ${theme.fg("toolOutput", wrappedBullet[w])}`);
        }
      }
      continue;
    }

    // 9. Numbered list items (1. item)
    const numMatch = trimmed.match(/^(\d+\.)\s+(.+)$/);
    if (numMatch) {
      const numPrefix = `  ${theme.fg("accent", numMatch[1])} `;
      const numWidth = visibleWidth(`  ${numMatch[1]} `);
      const availWidth = Math.max(10, maxContentWidth - numWidth);
      const wrappedNum = wrapTextWithAnsi(numMatch[2], availWidth);

      if (wrappedNum.length === 0) {
        formatted.push(numPrefix);
      } else {
        formatted.push(`${numPrefix}${theme.fg("toolOutput", wrappedNum[0])}`);
        for (let w = 1; w < wrappedNum.length; w++) {
          formatted.push(`    ${theme.fg("toolOutput", wrappedNum[w])}`);
        }
      }
      continue;
    }

    // 10. Horizontal rule dividers
    if (trimmed === "---" || trimmed === "___" || trimmed === "***") {
      formatted.push(`  ${theme.fg("dim", "─".repeat(Math.min(50, maxContentWidth - 4)))}`);
      continue;
    }

    // 11. Regular text / paragraphs: wrap completely without truncation
    const wrappedText = wrapTextWithAnsi(rawLine, Math.max(10, maxContentWidth - 4));
    for (const line of wrappedText) {
      formatted.push(`  ${theme.fg("toolOutput", line)}`);
    }
  }

  return formatted;
}

function parseToolStart(trimmed: string): { toolName: string; toolArgs: string } | null {
  if (trimmed.startsWith("-> [tool]")) {
    const rest = trimmed.slice(9).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx > 0) {
      return { toolName: rest.slice(0, spaceIdx), toolArgs: rest.slice(spaceIdx + 1).trim() };
    }
    return { toolName: rest, toolArgs: "" };
  }

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

  if (trimmed.startsWith("$ ")) {
    return { toolName: "$", toolArgs: trimmed.slice(2).trim() };
  }

  const firstWordMatch = trimmed.match(/^([a-z_]+)\s+(.+)$/);
  if (firstWordMatch && KNOWN_TOOLS.has(firstWordMatch[1])) {
    return { toolName: firstWordMatch[1], toolArgs: firstWordMatch[2].trim() };
  }

  return null;
}

function parseToolEnd(trimmed: string): { isError: boolean; resultText: string } | null {
  if (trimmed.startsWith("<- [tool]")) {
    const rest = trimmed.slice(9).trim();
    const isError = rest.includes("(error") || rest.includes("(failed") || rest.includes("error:");
    let clean = rest;
    const colonIdx = clean.indexOf(":");
    if (colonIdx > 0 && colonIdx < 15) {
      clean = clean.slice(colonIdx + 1).trim();
    }
    return { isError, resultText: clean };
  }

  if (trimmed.startsWith("✔ ") || trimmed.startsWith("✓ ")) {
    return { isError: false, resultText: trimmed.slice(2).trim() };
  }

  if (trimmed.startsWith("▲ ") || trimmed.startsWith("✗ ")) {
    return { isError: true, resultText: trimmed.slice(2).trim() };
  }

  return null;
}
