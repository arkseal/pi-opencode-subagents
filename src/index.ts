import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeSubagent } from "./runner.js";
import { renderSubagentCall, renderSubagentResult, cleanSubagentOutput } from "./subagent-ui.js";
import { globalSubagentTracker } from "./tracker.js";

export { executeSubagent } from "./runner.js";
export { createWorktree, cleanupWorktree } from "./worktree.js";
export { formatTaskResultEnvelope } from "./envelope.js";
export { checkSubagentDepth, setMaxDepth } from "./depth-guard.js";
export { renderSubagentCall, renderSubagentResult, cleanSubagentOutput } from "./subagent-ui.js";
export { globalSubagentTracker, SubagentTracker } from "./tracker.js";

export default function opencodeSubagentsExtension(pi: ExtensionAPI) {
  // Capture UI context on session lifecycle
  pi.on("session_start", (_event, ctx) => {
    globalSubagentTracker.setUIContext(ctx);
  });

  // Register /subagents inspection command
  pi.registerCommand("subagents", {
    description: "Inspect active and recent subagents and their progress",
    handler: async (args, ctx) => {
      globalSubagentTracker.setUIContext(ctx);
      const active = globalSubagentTracker.getActiveList();
      const recent = globalSubagentTracker.getRecentList();

      if (active.length === 0 && recent.length === 0) {
        ctx.ui.notify("No active or recent subagents found.", "info");
        return;
      }

      const lines: string[] = [];
      if (active.length > 0) {
        lines.push(`Active Subagents (${active.length}):`);
        for (const a of active) {
          const elapsed = ((Date.now() - a.startTime) / 1000).toFixed(1);
          lines.push(`  • [${a.id}] "${a.task.slice(0, 50)}" · ${elapsed}s (${a.status})`);
          if (a.currentLine) lines.push(`    ↳ ${a.currentLine}`);
          lines.push(`    Log: ${a.logFile}`);
        }
      }

      if (recent.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(`Recent Subagents (${recent.length}):`);
        for (const r of recent.slice(0, 5)) {
          const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "n/a";
          lines.push(`  • [${r.id}] "${r.task.slice(0, 50)}" · ${dur} (${r.status})`);
          lines.push(`    Log: ${r.logFile}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a multi-step task to an autonomous child agent in an isolated context. Runs in a temporary Git worktree to protect the workspace, and returns only a concise <task-result> summary to keep parent context clean.",
    promptSnippet: "Delegate autonomous research or coding tasks to an isolated subagent",
    parameters: Type.Object(
      {
        task: Type.String({
          description: "Detailed description of the task for the subagent to perform autonomously",
        }),
        description: Type.Optional(
          Type.String({
            description: "A short 3-5 word summary/title of the task for the UI header",
          })
        ),
        isolated: Type.Optional(
          Type.Boolean({
            description:
              "Run in an isolated Git worktree (default true). Keeps working tree clean from experimental edits.",
          })
        ),
      },
      { additionalProperties: false }
    ),
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      globalSubagentTracker.setUIContext(ctx);
      const depth = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
      const result = await executeSubagent({
        task: params.task,
        description: params.description,
        cwd: ctx.cwd,
        isolated: params.isolated ?? true,
        currentDepth: depth,
        signal,
        onUpdate,
      });

      return {
        content: [{ type: "text", text: result.output }],
        details: result.details,
      };
    },
  });
}
