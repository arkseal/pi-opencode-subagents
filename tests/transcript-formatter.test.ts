import { describe, expect, it } from "bun:test";
import { formatTranscriptLines } from "../src/transcript-formatter";

const mockTheme = {
  fg: (name: string, str: string) => str,
  bold: (str: string) => str,
};

describe("formatTranscriptLines", () => {
  it("formats tool execution lines with bullets and checkmarks", () => {
    const raw = [
      "-> [tool] bash sleep 3",
      "<- [tool] bash: done",
      "-> [tool] glob *.ts in src",
      "<- [tool] glob *.ts in src: 5 files found",
    ];

    const lines = formatTranscriptLines(raw, mockTheme, 80);
    const joined = lines.join("\n");

    expect(joined).toContain("$ sleep 3");
    expect(joined).toContain("✔ done");
    expect(joined).toContain("glob *.ts in src");
    expect(joined).toContain("✔ glob *.ts in src: 5 files found");
  });

  it("formats markdown headings and lists", () => {
    const raw = [
      "## Findings",
      "- Discovered 5 TypeScript files",
      "- All tests passed",
    ];

    const lines = formatTranscriptLines(raw, mockTheme, 80);
    const joined = lines.join("\n");

    expect(joined).toContain("Findings");
    expect(joined).toContain("• Discovered 5 TypeScript files");
    expect(joined).toContain("• All tests passed");
  });

  it("frames code blocks with box borders", () => {
    const raw = [
      "```typescript",
      "const answer = 42;",
      "console.log(answer);",
      "```",
    ];

    const lines = formatTranscriptLines(raw, mockTheme, 80);
    const joined = lines.join("\n");

    expect(joined).toContain("┌─ typescript");
    expect(joined).toContain("│ const answer = 42;");
    expect(joined).toContain("│ console.log(answer);");
    expect(joined).toContain("└");
  });

  it("wraps long lines without truncating or inserting ellipses", () => {
    const raw = [
      "This is a very long line of output from a command that contains detailed information which must be preserved completely instead of being cut off with an ellipsis.",
      "```bash",
      "npm install --save-dev @earendil-works/pi-coding-agent @earendil-works/pi-tui @sinclair/typebox",
      "```",
    ];

    const lines = formatTranscriptLines(raw, mockTheme, 40);
    const joined = lines.join("\n");

    // Must NOT contain ellipsis from truncation
    expect(joined).not.toContain("...");
    // Must contain parts from wrapped lines
    expect(joined).toContain("This is a very long");
    expect(joined).toContain("preserved completely");
    expect(joined).toContain("npm install");
    expect(joined).toContain("@sinclair/typebox");
  });
});
