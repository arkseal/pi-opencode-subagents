import { describe, expect, it } from "bun:test";
import { parseSubagentJsonLine } from "../src/event-parser";

describe("parseSubagentJsonLine", () => {
  it("extracts tool execution start for bash", () => {
    const json = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "sleep 3 && ls -la" },
    });
    const parsed = parseSubagentJsonLine(json);
    expect(parsed?.peek).toBe("$ sleep 3 && ls -la");
    expect(parsed?.transcriptLine).toContain("[tool] bash sleep 3 && ls -la");
  });

  it("extracts tool execution start for web_search", () => {
    const json = JSON.stringify({
      type: "tool_execution_start",
      toolName: "web_search",
      args: { query: "nodejs latest release" },
    });
    const parsed = parseSubagentJsonLine(json);
    expect(parsed?.peek).toBe('search: "nodejs latest release"');
  });

  it("extracts tool execution start for read", () => {
    const json = JSON.stringify({
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "package.json" },
    });
    const parsed = parseSubagentJsonLine(json);
    expect(parsed?.peek).toBe("read package.json");
  });

  it("extracts thinking delta", () => {
    const json = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start" },
    });
    const parsed = parseSubagentJsonLine(json);
    expect(parsed?.peek).toBe("thinking...");
  });

  it("extracts final text from agent_end", () => {
    const json = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Final summary here" }],
        },
      ],
    });
    const parsed = parseSubagentJsonLine(json);
    expect(parsed?.finalAssistantText).toBe("Final summary here");
  });
});
