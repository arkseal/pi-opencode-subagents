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
});
