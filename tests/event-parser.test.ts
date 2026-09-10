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
});
