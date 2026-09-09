let currentMaxDepth = 1;

export function getMaxDepth(): number {
  return currentMaxDepth;
}

export function setMaxDepth(depth: number): void {
  currentMaxDepth = Math.max(0, depth);
}

export function checkSubagentDepth(currentDepth: number): void {
  if (currentDepth >= currentMaxDepth) {
    throw new Error(
      `Recursion depth limit reached (current: ${currentDepth}, max: ${currentMaxDepth}). Subagents are not permitted to spawn nested subagents.`
    );
  }
}
