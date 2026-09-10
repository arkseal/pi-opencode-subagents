export interface ParsedEventPeek {
  peek?: string;
  priority?: "low" | "normal" | "high";
  lingerMs?: number;
  transcriptLine?: string;
  finalAssistantText?: string;
}

export interface PendingToolCall {
  toolName: string;
  args: any;
}

export class SubagentEventParser {
  private pendingCalls = new Map<string, PendingToolCall>();

  parseLine(line: string): ParsedEventPeek | undefined {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return undefined;

    try {
      const ev = JSON.parse(trimmed);

      // 1. Tool execution started
      if (ev.type === "tool_execution_start") {
        const id = ev.toolCallId || "";
        const name = ev.toolName || "tool";
        const args = ev.args || {};

        if (id) {
          this.pendingCalls.set(id, { toolName: name, args });
        }

        return this.formatToolStart(name, args);
      }

      // 2. Tool execution ended
      if (ev.type === "tool_execution_end") {
        const id = ev.toolCallId || "";
        const pending = id ? this.pendingCalls.get(id) : undefined;
        if (id) {
          this.pendingCalls.delete(id);
        }

        const name = pending?.toolName || ev.toolName || "tool";
        const args = pending?.args || {};
        const isError = ev.isError === true;
        const content = ev.result?.content?.[0]?.text;
        const details = ev.result?.details || {};

        return this.formatToolEnd(name, args, content, details, isError);
      }

      // 3. Thinking / Generation delta
      if (ev.type === "message_update") {
        const sub = ev.assistantMessageEvent;
        if (sub?.type === "thinking_delta" || sub?.type === "thinking_start") {
          return {
            peek: "thinking...",
            priority: "low",
          };
        }
        if (sub?.type === "text_delta" && sub.delta) {
          const delta = sub.delta;
          // Check if outputting code or markdown code block
          const isCode =
            delta.includes("```") ||
            /^(?:import|export|const|let|var|function|class|def|return|if|for|while)\b/m.test(delta.trim());
          const peek = isCode ? "generating code..." : "drafting response...";
          return {
            peek,
            priority: "low",
            transcriptLine: delta,
          };
        }
      }

      // 4. Agent ended (capture final assistant response)
      if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
        const lastMsg = [...ev.messages]
          .reverse()
          .find((m: any) => m.role === "assistant" && Array.isArray(m.content));

        if (lastMsg) {
          const textParts = lastMsg.content
            .filter((c: any) => c.type === "text" && c.text)
            .map((c: any) => c.text);
          const fullText = textParts.join("\n").trim();
          return {
            finalAssistantText: fullText,
            transcriptLine: fullText,
          };
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private formatToolStart(name: string, args: any): ParsedEventPeek {
    let peek = `running ${name}...`;
    let transcriptDetail = "";

    if (name === "glob") {
      const pattern = args.pattern || "*";
      const pathSuffix = args.path ? ` in ${args.path}` : "";
      peek = `globbing "${pattern}"${pathSuffix}...`;
      transcriptDetail = `"${pattern}"${pathSuffix}`;
    } else if (name === "grep") {
      const pattern = args.pattern || "";
      const pathSuffix = args.path ? ` in ${args.path}` : "";
      const incSuffix = args.include ? ` (${args.include})` : "";
      peek = `searching /${pattern}/${pathSuffix}${incSuffix}...`;
      transcriptDetail = `/${pattern}/${pathSuffix}${incSuffix}`;
    } else if (name === "read") {
      const path = args.path || "file";
      peek = `reading ${path}...`;
      transcriptDetail = path;
    } else if (name === "write") {
      const path = args.path || "file";
      const lines = (args.content || "").split("\n").length;
      peek = `writing ${path} (${lines} lines)...`;
      transcriptDetail = `${path} (${lines} lines)`;
    } else if (name === "edit") {
      const path = args.path || "file";
      const count = args.edits?.length || 1;
      peek = `editing ${path} (${count} changes)...`;
      transcriptDetail = `${path} (${count} changes)`;
    } else if (name === "bash") {
      const cmd = args.command || "";
      const preview = cmd.length > 55 ? `${cmd.slice(0, 52)}...` : cmd;
      peek = `$ ${preview}`;
      transcriptDetail = cmd;
    } else if (name === "web_search") {
      const q = args.query || "";
      const preview = q.length > 50 ? `${q.slice(0, 47)}...` : q;
      peek = `searching web: "${preview}"...`;
      transcriptDetail = `"${q}"`;
    } else if (name === "web_fetch") {
      const url = args.url || "";
      peek = `fetching ${url}...`;
      transcriptDetail = url;
    } else if (name === "antigravity_search") {
      const q = args.query || "";
      const preview = q.length > 50 ? `${q.slice(0, 47)}...` : q;
      peek = `google search: "${preview}"...`;
      transcriptDetail = `"${q}"`;
    } else {
      transcriptDetail = name;
    }

    return {
      peek,
      priority: "normal",
      lingerMs: 1200,
      transcriptLine: `-> [tool] ${name} ${transcriptDetail}`.trim(),
    };
  }

  private formatToolEnd(
    name: string,
    args: any,
    content?: string,
    details: any = {},
    isError = false
  ): ParsedEventPeek {
    if (isError) {
      const errFirstLine = content?.split("\n")[0] || "failed";
      const errSnippet = errFirstLine.length > 45 ? `${errFirstLine.slice(0, 42)}...` : errFirstLine;
      return {
        peek: `${name} failed: ${errSnippet}`,
        priority: "high",
        lingerMs: 2500,
        transcriptLine: `<- [tool] ${name} (error: ${errFirstLine})`,
      };
    }

    let peek = `completed ${name}`;
    let transcriptSummary = `<- [tool] ${name} (ok)`;

    if (name === "glob") {
      const pattern = args.pattern || "*";
      const pathSuffix = args.path ? ` in ${args.path}` : "";
      const count = details.count ?? countOutputLines(content);
      const fileWord = count === 1 ? "file" : "files";
      peek = `globbed "${pattern}"${pathSuffix} (${count} ${fileWord} found)`;
      transcriptSummary = `<- [tool] glob "${pattern}"${pathSuffix}: ${count} ${fileWord} found`;
    } else if (name === "grep") {
      const pattern = args.pattern || "";
      const matches = details.matches ?? countGrepMatches(content);
      const matchWord = matches === 1 ? "match" : "matches";
      peek = `searched /${pattern}/ (${matches} ${matchWord})`;
      transcriptSummary = `<- [tool] grep /${pattern}/: ${matches} ${matchWord}`;
    } else if (name === "read") {
      const path = args.path || "file";
      const lineCount = content ? content.split("\n").length : 0;
      peek = `read ${path} (${lineCount} lines)`;
      transcriptSummary = `<- [tool] read ${path} (${lineCount} lines)`;
    } else if (name === "write") {
      const path = args.path || "file";
      const lineCount = (args.content || "").split("\n").length;
      peek = `wrote ${path} (${lineCount} lines)`;
      transcriptSummary = `<- [tool] wrote ${path} (${lineCount} lines)`;
    } else if (name === "edit") {
      const path = args.path || "file";
      const count = args.edits?.length || 1;
      peek = `edited ${path} (${count} changes)`;
      transcriptSummary = `<- [tool] edited ${path} (${count} changes)`;
    } else if (name === "bash") {
      const cmd = args.command || "";
      const preview = cmd.length > 35 ? `${cmd.slice(0, 32)}...` : cmd;
      const exitCode = details.exitCode ?? 0;
      const trimmedOutput = content ? content.trim() : "";
      let outcome = "done";
      if (exitCode !== 0) {
        outcome = `exit ${exitCode}`;
      } else if (trimmedOutput && !trimmedOutput.includes("\n") && trimmedOutput.length <= 25) {
        outcome = trimmedOutput;
      }
      peek = `$ ${preview} (${outcome})`;
      transcriptSummary = `<- [tool] bash: ${outcome}`;
    } else if (name === "web_search") {
      const q = args.query || "";
      const preview = q.length > 35 ? `${q.slice(0, 32)}...` : q;
      const count = countSearchResults(content);
      peek = `searched "${preview}" (${count} results)`;
      transcriptSummary = `<- [tool] web_search "${q}" (${count} results)`;
    } else if (name === "web_fetch") {
      const url = args.url || "";
      const kb = content ? (content.length / 1024).toFixed(1) : "0";
      peek = `fetched ${url} (${kb} KB)`;
      transcriptSummary = `<- [tool] web_fetch ${url} (${kb} KB)`;
    } else if (name === "antigravity_search") {
      const q = args.query || "";
      const preview = q.length > 35 ? `${q.slice(0, 32)}...` : q;
      peek = `google "${preview}" (done)`;
      transcriptSummary = `<- [tool] antigravity_search "${q}" (done)`;
    }

    let transcriptLine = transcriptSummary;
    if (content && typeof content === "string") {
      const preview = content.trim().slice(0, 300);
      if (preview.length > 0) {
        transcriptLine += `\n${preview}`;
      }
    }

    return {
      peek,
      priority: "high",
      lingerMs: 2500,
      transcriptLine,
    };
  }
}

function countOutputLines(text?: string): number {
  if (!text) return 0;
  return text.trim().split("\n").filter((l) => l.trim().length > 0).length;
}

function countGrepMatches(text?: string): number {
  if (!text) return 0;
  const match = text.match(/Found (\d+) match/i);
  if (match) return parseInt(match[1], 10);
  const lineMatches = text.match(/^\s*Line \d+:/gm);
  return lineMatches ? lineMatches.length : countOutputLines(text);
}

function countSearchResults(text?: string): number {
  if (!text) return 0;
  const titles = text.match(/^(?:###|Title:)\s+/gm);
  if (titles && titles.length > 0) return titles.length;
  return 1;
}

export const defaultSubagentEventParser = new SubagentEventParser();

export function parseSubagentJsonLine(line: string): ParsedEventPeek | undefined {
  return defaultSubagentEventParser.parseLine(line);
}
