export interface SubagentStats {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: number;
  turns: number;
  toolCalls: number;
  model?: string;
  thinkingLevel?: string;
}

export interface LiveToolCall {
  toolCallId: string;
  toolName: string;
  args: any;
  status: "running" | "completed" | "error";
  partialResult?: any;
  result?: any;
  isError?: boolean;
  durationMs?: number;
}

export interface LiveSnapshot {
  streamingMessage?: any;
  activeTools: LiveToolCall[];
  recentTools: LiveToolCall[];
  lastAssistantText?: string;
  stopReason?: string;
  errorMessage?: string;
  stats: SubagentStats;
}

export interface ParsedEventPeek {
  peek?: string;
  priority?: "low" | "normal" | "high";
  lingerMs?: number;
  transcriptLine?: string;
  finalAssistantText?: string;
  stopReason?: string;
  errorMessage?: string;
  stats?: SubagentStats;
}

export interface PendingToolCall {
  toolName: string;
  args: any;
}

export class SubagentEventParser {
  private pendingCalls = new Map<string, PendingToolCall>();
  private liveToolCalls = new Map<string, LiveToolCall>();
  private liveMessages: any[] = [];
  private streamingMessage?: any;
  private lastStopReason?: string;
  private lastErrorMessage?: string;
  private lastAssistantText?: string;
  private stats: SubagentStats = {
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
  };
  private currentTurnUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };

  reset(): void {
    this.pendingCalls.clear();
    this.liveToolCalls.clear();
    this.liveMessages = [];
    this.streamingMessage = undefined;
    this.currentTurnUsage = undefined;
    this.lastStopReason = undefined;
    this.lastErrorMessage = undefined;
    this.lastAssistantText = undefined;
    this.stats = {
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      turns: 0,
      toolCalls: 0,
    };
  }

  getStopReason(): string | undefined {
    return this.lastStopReason;
  }

  getErrorMessage(): string | undefined {
    return this.lastErrorMessage;
  }

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  getLiveSnapshot(): LiveSnapshot {
    const activeTools: LiveToolCall[] = [];
    const recentTools: LiveToolCall[] = [];

    for (const call of this.liveToolCalls.values()) {
      if (call.status === "running") {
        activeTools.push({ ...call });
      } else {
        recentTools.push({ ...call });
      }
    }

    let lastAssistantText = this.lastAssistantText;
    if (this.streamingMessage && Array.isArray(this.streamingMessage.content)) {
      const textParts = this.streamingMessage.content
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text);
      const joined = textParts.join("\n").trim();
      if (joined) lastAssistantText = joined;
    }

    return {
      streamingMessage: this.streamingMessage ? JSON.parse(JSON.stringify(this.streamingMessage)) : undefined,
      activeTools,
      recentTools: recentTools.slice(-15),
      lastAssistantText,
      stopReason: this.lastStopReason,
      errorMessage: this.lastErrorMessage,
      stats: this.getStats(),
    };
  }

  parseLine(line: string): ParsedEventPeek | undefined {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return undefined;

    try {
      const ev = JSON.parse(trimmed);

      // 0. Auto retry events
      if (ev.type === "auto_retry_start") {
        this.lastStopReason = undefined;
        this.lastErrorMessage = undefined;
        const attempt = ev.attempt ?? 1;
        const max = ev.maxAttempts ? `/${ev.maxAttempts}` : "";
        return {
          peek: `retrying (attempt ${attempt}${max})...`,
          priority: "normal",
          lingerMs: 2000,
        };
      }

      if (ev.type === "auto_retry_end") {
        if (ev.success === false && ev.finalError) {
          this.lastStopReason = "error";
          this.lastErrorMessage = ev.finalError;
        } else if (ev.success === true) {
          this.lastStopReason = undefined;
          this.lastErrorMessage = undefined;
        }
      }

      // 1. Tool execution started
      if (ev.type === "tool_execution_start") {
        this.stats.toolCalls++;
        const id = ev.toolCallId || "";
        const name = ev.toolName || "tool";
        const args = ev.args || {};

        if (id) {
          this.pendingCalls.set(id, { toolName: name, args });
          this.liveToolCalls.set(id, {
            toolCallId: id,
            toolName: name,
            args,
            status: "running",
          });
        }

        return this.formatToolStart(name, args);
      }

      // 1b. Tool execution update (partial result streaming)
      if (ev.type === "tool_execution_update") {
        const id = ev.toolCallId || "";
        if (id && this.liveToolCalls.has(id)) {
          const live = this.liveToolCalls.get(id)!;
          live.partialResult = ev.partialResult;
        }
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

        if (id) {
          const live = this.liveToolCalls.get(id);
          if (live) {
            live.status = isError ? "error" : "completed";
            live.result = ev.result;
            live.isError = isError;
            if (typeof ev.durationMs === "number") {
              live.durationMs = ev.durationMs;
            }
          } else {
            this.liveToolCalls.set(id, {
              toolCallId: id,
              toolName: name,
              args,
              status: isError ? "error" : "completed",
              result: ev.result,
              isError,
              durationMs: ev.durationMs,
            });
          }
        }

        return this.formatToolEnd(name, args, content, details, isError);
      }

      // 3. Thinking / Generation delta
      if (ev.type === "message_update") {
        if (ev.usage) {
          this.currentTurnUsage = ev.usage;
        }
        const sub = ev.assistantMessageEvent;
        if (sub) {
          if (!this.streamingMessage) {
            this.streamingMessage = {
              role: "assistant",
              content: [],
              model: this.stats.model,
              thinkingLevel: this.stats.thinkingLevel,
            };
          }

          if (sub.type === "thinking_start") {
            const index = sub.contentIndex ?? this.streamingMessage.content.length;
            while (this.streamingMessage.content.length <= index) {
              this.streamingMessage.content.push({ type: "thinking", thinking: "" });
            }
          } else if (sub.type === "thinking_delta" && typeof sub.delta === "string") {
            if (typeof sub.contentIndex === "number") {
              while (this.streamingMessage.content.length <= sub.contentIndex) {
                this.streamingMessage.content.push({ type: "thinking", thinking: "" });
              }
              const block = this.streamingMessage.content[sub.contentIndex];
              if (block && block.type === "thinking") {
                block.thinking = (block.thinking || "") + sub.delta;
              }
            } else {
              let block = this.streamingMessage.content[this.streamingMessage.content.length - 1];
              if (!block || block.type !== "thinking") {
                block = { type: "thinking", thinking: "" };
                this.streamingMessage.content.push(block);
              }
              block.thinking += sub.delta;
            }
          }

          if (sub.type === "text_start") {
            const index = sub.contentIndex ?? this.streamingMessage.content.length;
            while (this.streamingMessage.content.length <= index) {
              this.streamingMessage.content.push({ type: "text", text: "" });
            }
          } else if (sub.type === "text_delta" && typeof sub.delta === "string") {
            if (typeof sub.contentIndex === "number") {
              while (this.streamingMessage.content.length <= sub.contentIndex) {
                this.streamingMessage.content.push({ type: "text", text: "" });
              }
              const block = this.streamingMessage.content[sub.contentIndex];
              if (block && block.type === "text") {
                block.text = (block.text || "") + sub.delta;
              }
            } else {
              let block = this.streamingMessage.content[this.streamingMessage.content.length - 1];
              if (!block || block.type !== "text") {
                block = { type: "text", text: "" };
                this.streamingMessage.content.push(block);
              }
              block.text += sub.delta;
            }
          }

          if (sub.type === "toolcall_start" || sub.type === "tool_call_start") {
            this.streamingMessage.content.push({
              type: "toolCall",
              id: sub.id || sub.toolCallId,
              name: sub.name || sub.toolName,
              arguments: sub.arguments || sub.args || {},
            });
          } else if (sub.type === "toolcall_delta" || sub.type === "tool_call_delta") {
            const id = sub.id || sub.toolCallId;
            const block = this.streamingMessage.content.find(
              (c: any) => c.type === "toolCall" && (c.id === id || !id)
            );
            if (block && sub.arguments) {
              block.arguments = { ...block.arguments, ...sub.arguments };
            }
          }
        }

        if (sub?.type === "thinking_delta" || sub?.type === "thinking_start") {
          return {
            peek: "thinking...",
            priority: "low",
            stats: this.getStats(),
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
            stats: this.getStats(),
          };
        }
      }

      // 4. Message lifecycle tracking for tokens / stats
      if (ev.type === "message_start") {
        if (ev.message?.role === "assistant") {
          this.currentTurnUsage = undefined;
          this.lastStopReason = undefined;
          this.lastErrorMessage = undefined;
          this.streamingMessage = {
            role: "assistant",
            content: Array.isArray(ev.message.content) ? [...ev.message.content] : [],
            model: ev.message.model,
            thinkingLevel: ev.message.thinkingLevel,
          };
          if (ev.message?.model) this.stats.model = ev.message.model;
          if (ev.message?.thinkingLevel) this.stats.thinkingLevel = ev.message.thinkingLevel;
        } else if (ev.message) {
          this.liveMessages.push(ev.message);
        }
      }

      if (ev.type === "message_end") {
        if (ev.message?.role === "assistant") {
          this.liveMessages.push(ev.message);
          this.streamingMessage = undefined;
          if (ev.message?.model) this.stats.model = ev.message.model;
          if (ev.message?.thinkingLevel) this.stats.thinkingLevel = ev.message.thinkingLevel;
          if (ev.message?.stopReason === "error" || ev.message?.stopReason === "aborted") {
            this.lastStopReason = ev.message.stopReason;
            if (typeof ev.message?.errorMessage === "string") {
              this.lastErrorMessage = ev.message.errorMessage;
            }
          } else if (ev.message?.stopReason) {
            this.lastStopReason = ev.message.stopReason;
            this.lastErrorMessage = undefined;
          }

          const usage = ev.message?.usage || this.currentTurnUsage;
          if (usage) {
            this.stats.tokensIn += usage.input ?? 0;
            this.stats.tokensOut += usage.output ?? 0;
            this.stats.cacheRead += usage.cacheRead ?? 0;
            this.stats.cacheWrite += usage.cacheWrite ?? 0;
            if (typeof usage.cost?.total === "number") {
              this.stats.cost = (this.stats.cost ?? 0) + usage.cost.total;
            }
            this.stats.totalTokens = this.stats.tokensIn + this.stats.tokensOut + this.stats.cacheRead + this.stats.cacheWrite;
            this.currentTurnUsage = undefined;
          }

          const messageText = Array.isArray(ev.message?.content)
            ? ev.message.content
                .filter((part: any) => part.type === "text" && typeof part.text === "string")
                .map((part: any) => part.text)
                .join("\n")
                .trim()
            : "";
          if (messageText) {
            this.lastAssistantText = messageText;
          }

          const failure = ev.message?.stopReason === "error" || ev.message?.stopReason === "aborted";
          if (failure || messageText) {
            return {
              finalAssistantText: messageText || this.lastAssistantText,
              stopReason: this.lastStopReason,
              errorMessage: this.lastErrorMessage,
              stats: this.getStats(),
            };
          }
        } else if (ev.message) {
          this.liveMessages.push(ev.message);
        }
      }

      // 5. Turn end
      if (ev.type === "turn_end") {
        this.stats.turns++;
      }

      // 6. Agent ended (capture final assistant response & fallback token counting)
      if (ev.type === "agent_end") {
        if (this.streamingMessage) {
          this.liveMessages.push(this.streamingMessage);
          this.streamingMessage = undefined;
        }
        if (ev.willRetry === true) {
          return undefined;
        }

        this.pendingCalls.clear();
        this.currentTurnUsage = undefined;
        if (Array.isArray(ev.messages)) {
          if (this.stats.totalTokens === 0) {
            for (const msg of ev.messages) {
              if (msg.role === "assistant" && msg.usage) {
                if (msg.model && !this.stats.model) this.stats.model = msg.model;
                if (msg.thinkingLevel && !this.stats.thinkingLevel) this.stats.thinkingLevel = msg.thinkingLevel;
                this.stats.tokensIn += msg.usage.input ?? 0;
                this.stats.tokensOut += msg.usage.output ?? 0;
                this.stats.cacheRead += msg.usage.cacheRead ?? 0;
                this.stats.cacheWrite += msg.usage.cacheWrite ?? 0;
                if (typeof msg.usage.cost?.total === "number") {
                  this.stats.cost = (this.stats.cost ?? 0) + msg.usage.cost.total;
                }
              }
            }
            this.stats.totalTokens = this.stats.tokensIn + this.stats.tokensOut + this.stats.cacheRead + this.stats.cacheWrite;
          }

          const assistantMessages = ev.messages.filter((m: any) => m.role === "assistant");
          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          if (lastAssistant) {
            if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
              this.lastStopReason = lastAssistant.stopReason;
              this.lastErrorMessage = lastAssistant.errorMessage;
            } else {
              if (lastAssistant.stopReason) {
                this.lastStopReason = lastAssistant.stopReason;
              }
              this.lastErrorMessage = undefined;
            }
          }

          const lastMsg = [...ev.messages]
            .reverse()
            .find((m: any) => m.role === "assistant" && Array.isArray(m.content));

          if (lastMsg) {
            const textParts = lastMsg.content
              .filter((c: any) => c.type === "text" && c.text)
              .map((c: any) => c.text);
            const fullText = textParts.join("\n").trim();
            if (fullText) this.lastAssistantText = fullText;
            return {
              finalAssistantText: fullText || this.lastAssistantText,
              transcriptLine: fullText,
              stopReason: this.lastStopReason,
              errorMessage: this.lastErrorMessage,
              stats: this.getStats(),
            };
          }
        }

        if (this.lastStopReason || this.lastErrorMessage) {
          return {
            stopReason: this.lastStopReason,
            errorMessage: this.lastErrorMessage,
            stats: this.getStats(),
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

  getStats(): SubagentStats {
    const inFlight = this.currentTurnUsage;
    const inTokens = this.stats.tokensIn + (inFlight?.input ?? 0);
    const outTokens = this.stats.tokensOut + (inFlight?.output ?? 0);
    const cacheR = this.stats.cacheRead + (inFlight?.cacheRead ?? 0);
    const cacheW = this.stats.cacheWrite + (inFlight?.cacheWrite ?? 0);
    const cost = (this.stats.cost ?? 0) + (inFlight?.cost?.total ?? 0);
    return {
      ...this.stats,
      tokensIn: inTokens,
      tokensOut: outTokens,
      cacheRead: cacheR,
      cacheWrite: cacheW,
      totalTokens: inTokens + outTokens + cacheR + cacheW,
      cost: cost > 0 ? cost : this.stats.cost,
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
