let currentMaxDepth = 1;

export function getMaxDepth(): number {
  return currentMaxDepth;
}

export function setMaxDepth(depth: number): void {
  currentMaxDepth = Math.max(0, depth);
}

export function checkSubagentDepth(currentDepth: number): void {
  const depth = Number.isFinite(currentDepth) ? currentDepth : 0;
  if (depth >= currentMaxDepth) {
    throw new Error(
      `Recursion depth limit reached (current: ${depth}, max: ${currentMaxDepth}). Subagents are not permitted to spawn nested subagents.`
    );
  }
}
