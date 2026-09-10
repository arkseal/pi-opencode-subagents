export interface ParsedEventPeek {
  peek?: string;
  transcriptLine?: string;
  finalAssistantText?: string;
}

export function parseSubagentJsonLine(line: string): ParsedEventPeek | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  try {
    const ev = JSON.parse(trimmed);

    // 1. Tool execution started
    if (ev.type === "tool_execution_start") {
      const name = ev.toolName || "tool";
      const args = ev.args || {};
      let peek = `running ${name}`;
      let detail = "";

      if (name === "bash" && args.command) {
        const cmd = args.command.length > 55 ? `${args.command.slice(0, 52)}...` : args.command;
        peek = `$ ${cmd}`;
        detail = args.command;
      } else if (name === "read" && args.path) {
        peek = `read ${args.path}`;
        detail = args.path;
      } else if (name === "write" && args.path) {
        peek = `write ${args.path}`;
        detail = args.path;
      } else if (name === "edit" && args.path) {
        peek = `edit ${args.path}`;
        detail = args.path;
      } else if (name === "web_search" && args.query) {
        peek = `search: "${args.query}"`;
        detail = `"${args.query}"`;
      } else if (name === "web_fetch" && args.url) {
        peek = `fetch: ${args.url}`;
        detail = args.url;
      } else if (name === "antigravity_search" && args.query) {
        peek = `google: "${args.query}"`;
        detail = `"${args.query}"`;
      } else if (name === "grep" && args.pattern) {
        peek = `grep /${args.pattern}/`;
        detail = `/${args.pattern}/`;
      } else if (name === "glob" && args.pattern) {
        peek = `glob ${args.pattern}`;
        detail = args.pattern;
      }

      return {
        peek,
        transcriptLine: `-> [tool] ${name} ${detail}`.trim(),
      };
    }

    // 2. Tool execution ended
    if (ev.type === "tool_execution_end") {
      const name = ev.toolName || "tool";
      const status = ev.isError ? "failed" : "ok";
      const content = ev.result?.content?.[0]?.text;
      let transcriptLine = `<- [tool] ${name} (${status})`;
      if (content && typeof content === "string") {
        const preview = content.trim().slice(0, 300);
        transcriptLine += `\n${preview}`;
      }
      return {
        peek: `completed ${name} (${status})`,
        transcriptLine,
      };
    }

    // 3. Thinking / Generation delta
    if (ev.type === "message_update") {
      const sub = ev.assistantMessageEvent;
      if (sub?.type === "thinking_delta" || sub?.type === "thinking_start") {
        return {
          peek: "thinking...",
        };
      }
      if (sub?.type === "text_delta" && sub.delta) {
        const text = sub.delta.trim();
        if (text.length > 5) {
          const preview = text.length > 55 ? `${text.slice(0, 52)}...` : text;
          return {
            peek: preview,
            transcriptLine: sub.delta,
          };
        }
      }
    }

    // 4. Agent ended (capture final text)
    if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
      const lastMsg = [...ev.messages].reverse().find((m: any) => m.role === "assistant" && Array.isArray(m.content));
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
