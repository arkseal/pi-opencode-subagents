import { describe, expect, it } from "bun:test";
import { checkSubagentDepth, getMaxDepth, setMaxDepth } from "../src/depth-guard";

describe("Subagent Depth Guard", () => {
  it("allows level 0 to spawn level 1", () => {
    expect(() => checkSubagentDepth(0)).not.toThrow();
  });

  it("blocks level 1 from recursively spawning level 2 when maxDepth is 1", () => {
    setMaxDepth(1);
    expect(() => checkSubagentDepth(1)).toThrow("Recursion depth limit reached");
  });
});
