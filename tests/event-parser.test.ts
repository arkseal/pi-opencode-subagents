import { describe, expect, it } from "bun:test";
import { SubagentEventParser } from "../src/event-parser";

describe("SubagentEventParser", () => {
  it("tracks globbing start and end with pattern and match count", () => {
    const parser = new SubagentEventParser();

    const startEv = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_glob_1",
      toolName: "glob",
      args: { pattern: "**/*.ts", path: "src" },
    });
    const startParsed = parser.parseLine(startEv);
    expect(startParsed?.peek).toBe('globbing "**/*.ts" in src...');
    expect(startParsed?.transcriptLine).toContain('-> [tool] glob "**/*.ts" in src');

    const endEv = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_glob_1",
      toolName: "glob",
      result: {
        content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\nsrc/c.ts" }],
        details: { count: 3 },
      },
    });
    const endParsed = parser.parseLine(endEv);
    expect(endParsed?.peek).toBe('globbed "**/*.ts" in src (3 files found)');
    expect(endParsed?.transcriptLine).toContain('<- [tool] glob "**/*.ts" in src: 3 files found');
  });

  it("tracks grep search start and end with matches count", () => {
    const parser = new SubagentEventParser();

    const startEv = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_grep_1",
      toolName: "grep",
      args: { pattern: "export function", path: "src" },
    });
    const startParsed = parser.parseLine(startEv);
    expect(startParsed?.peek).toBe("searching /export function/ in src...");

    const endEv = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_grep_1",
      toolName: "grep",
      result: {
        content: [{ type: "text", text: "Found 4 matches" }],
        details: { matches: 4 },
      },
    });
    const endParsed = parser.parseLine(endEv);
    expect(endParsed?.peek).toBe("searched /export function/ (4 matches)");
  });

  it("tracks read start and end with line count", () => {
    const parser = new SubagentEventParser();

    const startEv = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_read_1",
      toolName: "read",
      args: { path: "package.json" },
    });
    const startParsed = parser.parseLine(startEv);
    expect(startParsed?.peek).toBe("reading package.json...");

    const endEv = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_read_1",
      toolName: "read",
      result: {
        content: [{ type: "text", text: "{\n  \"name\": \"test\"\n}" }],
      },
    });
    const endParsed = parser.parseLine(endEv);
    expect(endParsed?.peek).toBe("read package.json (3 lines)");
  });

  it("tracks bash command start and completion outcome", () => {
    const parser = new SubagentEventParser();

    const startEv = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_bash_1",
      toolName: "bash",
      args: { command: "sleep 2" },
    });
    const startParsed = parser.parseLine(startEv);
    expect(startParsed?.peek).toBe("$ sleep 2");

    const endEv = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_bash_1",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "" }],
        details: { exitCode: 0 },
      },
    });
    const endParsed = parser.parseLine(endEv);
    expect(endParsed?.peek).toBe("$ sleep 2 (done)");
  });

  it("tracks web_search start and results count", () => {
    const parser = new SubagentEventParser();

    const startEv = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_search_1",
      toolName: "web_search",
      args: { query: "typescript 5.8 features" },
    });
    const startParsed = parser.parseLine(startEv);
    expect(startParsed?.peek).toBe('searching web: "typescript 5.8 features"...');

    const endEv = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_search_1",
      toolName: "web_search",
      result: {
        content: [{ type: "text", text: "Title: TS 5.8\n...\nTitle: Handbook\n..." }],
      },
    });
    const endParsed = parser.parseLine(endEv);
    expect(endParsed?.peek).toContain('searched "typescript 5.8 features"');
    expect(endParsed?.peek).toContain("results");
  });

  it("tracks web_fetch start and payload size", () => {
    const parser = new SubagentEventParser();

    const startEv = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_fetch_1",
      toolName: "web_fetch",
      args: { url: "https://example.com" },
    });
    const startParsed = parser.parseLine(startEv);
    expect(startParsed?.peek).toBe("fetching https://example.com...");

    const endEv = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_fetch_1",
      toolName: "web_fetch",
      result: {
        content: [{ type: "text", text: "A".repeat(3000) }],
      },
    });
    const endParsed = parser.parseLine(endEv);
    expect(endParsed?.peek).toContain("fetched https://example.com");
    expect(endParsed?.peek).toContain("KB");
  });

  it("reports clear error snippet when tool fails", () => {
    const parser = new SubagentEventParser();

    parser.parseLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "call_fail_1",
        toolName: "read",
        args: { path: "missing.txt" },
      })
    );

    const endEv = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_fail_1",
      toolName: "read",
      isError: true,
      result: {
        content: [{ type: "text", text: "ENOENT: no such file or directory" }],
      },
    });
    const endParsed = parser.parseLine(endEv);
    expect(endParsed?.peek).toBe("read failed: ENOENT: no such file or directory");
  });

  it("safely handles code output deltas without injecting multiline code into peek", () => {
    const parser = new SubagentEventParser();

    const codeEv = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "```typescript\nfunction solve(): number {\n  return 42;\n}\n```",
      },
    });

    const parsed = parser.parseLine(codeEv);
    expect(parsed?.peek).toBe("generating code...");
    expect(parsed?.priority).toBe("low");
    expect(parsed?.transcriptLine).toContain("function solve()");
  });

  it("accumulates tokens, tool calls, turns, and cost across subagent execution", () => {
    const parser = new SubagentEventParser();

    // 1. Tool execution start -> increments toolCalls
    parser.parseLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "package.json" },
      })
    );
    expect(parser.getStats().toolCalls).toBe(1);

    // 2. Assistant message end with usage -> accumulates tokens and cost
    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          usage: {
            input: 1200,
            output: 45,
            cacheRead: 5000,
            cacheWrite: 100,
            cost: { total: 0.0025 },
          },
        },
      })
    );

    // 3. Turn end -> increments turns
    parser.parseLine(JSON.stringify({ type: "turn_end" }));

    // 4. Second assistant message with usage
    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          usage: {
            input: 800,
            output: 250,
            cacheRead: 3000,
            cacheWrite: 0,
            cost: { total: 0.0015 },
          },
        },
      })
    );
    parser.parseLine(JSON.stringify({ type: "turn_end" }));

    const stats = parser.getStats();
    expect(stats.tokensIn).toBe(2000);
    expect(stats.tokensOut).toBe(295);
    expect(stats.cacheRead).toBe(8000);
    expect(stats.cacheWrite).toBe(100);
    expect(stats.totalTokens).toBe(10395);
    expect(stats.toolCalls).toBe(1);
    expect(stats.turns).toBe(2);
    expect(stats.cost).toBeCloseTo(0.004, 4);
    expect(stats.model).toBe("gemini-3.8-flash");
  });

  it("extracts usage from agent_end fallback if individual message_ends omitted", () => {
    const parser = new SubagentEventParser();

    parser.parseLine(
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            usage: { input: 300, output: 20, cacheRead: 1500, cacheWrite: 0, cost: { total: 0.001 } },
          },
        ],
      })
    );

    const stats = parser.getStats();
    expect(stats.tokensIn).toBe(300);
    expect(stats.tokensOut).toBe(20);
    expect(stats.cacheRead).toBe(1500);
    expect(stats.totalTokens).toBe(1820);
  });

  it("captures thinkingLevel from message_end and agent_end", () => {
    const parser = new SubagentEventParser();

    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          thinkingLevel: "high",
          usage: { input: 100, output: 50 },
        },
      })
    );

    expect(parser.getStats().model).toBe("gemini-3.8-flash");
    expect(parser.getStats().thinkingLevel).toBe("high");

    const fallbackParser = new SubagentEventParser();
    fallbackParser.parseLine(
      JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: "claude-sonnet-4",
            thinkingLevel: "medium",
            usage: { input: 200, output: 100 },
          },
        ],
      })
    );

    expect(fallbackParser.getStats().model).toBe("claude-sonnet-4");
    expect(fallbackParser.getStats().thinkingLevel).toBe("medium");
  });

  it("resets statistics and pending calls cleanly", () => {
    const parser = new SubagentEventParser();
    parser.parseLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "echo 1" },
      })
    );
    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50 },
        },
      })
    );

    expect(parser.getStats().toolCalls).toBe(1);
    expect(parser.getStats().totalTokens).toBe(150);

    parser.reset();
    expect(parser.getStats().toolCalls).toBe(0);
    expect(parser.getStats().totalTokens).toBe(0);
  });

  it("captures stopReason:error and errorMessage from assistant message_end and agent_end", () => {
    const parser = new SubagentEventParser();

    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "model_not_found: The model openai/gpt-5.4 does not exist",
        },
      })
    );

    expect(parser.getStopReason()).toBe("error");
    expect(parser.getErrorMessage()).toContain("model_not_found");

    const fallbackParser = new SubagentEventParser();
    fallbackParser.parseLine(
      JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "provider_overloaded",
          },
        ],
      })
    );

    expect(fallbackParser.getStopReason()).toBe("error");
    expect(fallbackParser.getErrorMessage()).toBe("provider_overloaded");
  });

  it("tracks live streaming messages, tool calls, and snapshot correctly", () => {
    const parser = new SubagentEventParser();

    // 1. message_start
    parser.parseLine(
      JSON.stringify({
        type: "message_start",
        message: { role: "assistant", model: "claude-3-7-sonnet", thinkingLevel: "high" },
      })
    );

    // 2. streaming thinking deltas
    parser.parseLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Analyzing code structure... " },
      })
    );
    parser.parseLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Plan looks good." },
      })
    );

    // 3. tool execution start
    parser.parseLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "call_glob_1",
        toolName: "glob",
        args: { pattern: "*.ts" },
      })
    );

    let snapshot = parser.getLiveSnapshot();
    expect(snapshot.activeTools.length).toBe(1);
    expect(snapshot.activeTools[0].toolName).toBe("glob");
    expect(snapshot.activeTools[0].status).toBe("running");
    expect(snapshot.streamingMessage?.content?.[0]?.thinking).toBe("Analyzing code structure... Plan looks good.");

    // 4. tool execution update
    parser.parseLine(
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "call_glob_1",
        partialResult: { count: 3 },
      })
    );
    snapshot = parser.getLiveSnapshot();
    expect(snapshot.activeTools[0].partialResult?.count).toBe(3);

    // 5. tool execution end
    parser.parseLine(
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "call_glob_1",
        toolName: "glob",
        durationMs: 45,
        result: { content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }] },
      })
    );

    snapshot = parser.getLiveSnapshot();
    expect(snapshot.activeTools.length).toBe(0);
    expect(snapshot.recentTools.length).toBe(1);
    expect(snapshot.recentTools[0].status).toBe("completed");
    expect(snapshot.recentTools[0].durationMs).toBe(45);

    // 6. streaming text response
    parser.parseLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "I found 3 files." },
      })
    );
    snapshot = parser.getLiveSnapshot();
    expect(snapshot.lastAssistantText).toBe("I found 3 files.");

    // 7. message_end
    parser.parseLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I found 3 files." }],
          usage: { input: 120, output: 40 },
        },
      })
    );

    snapshot = parser.getLiveSnapshot();
    expect(snapshot.streamingMessage).toBeUndefined();
    expect(snapshot.lastAssistantText).toBe("I found 3 files.");
    expect(snapshot.stats.totalTokens).toBe(160);
  });
});
