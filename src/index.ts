import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeSubagent } from "./runner.js";
import { renderSubagentCall, renderSubagentResult, cleanSubagentOutput } from "./subagent-ui.js";
import { globalSubagentTracker } from "./tracker.js";
import { SubagentViewer } from "./subagent-viewer.js";

export { executeSubagent } from "./runner.js";
export { createWorktree, cleanupWorktree } from "./worktree.js";
export { formatTaskResultEnvelope } from "./envelope.js";
export { checkSubagentDepth, setMaxDepth } from "./depth-guard.js";
export { renderSubagentCall, renderSubagentResult, cleanSubagentOutput } from "./subagent-ui.js";
export { globalSubagentTracker, SubagentTracker } from "./tracker.js";
export { SubagentViewer } from "./subagent-viewer.js";

export default function opencodeSubagentsExtension(pi: ExtensionAPI) {
  // Capture UI context and restore subagents on session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    globalSubagentTracker.setUIContext(ctx);

    // Restore saved subagents from session JSONL history
    try {
      if (ctx.sessionManager && typeof ctx.sessionManager.getEntries === "function") {
        const entries = ctx.sessionManager.getEntries();
        const restored: any[] = [];
        for (const entry of entries) {
          if (entry.type === "custom" && (entry as any).customType === "subagent_record" && (entry as any).data) {
            restored.push((entry as any).data);
          }
        }
        if (restored.length > 0) {
          globalSubagentTracker.restoreRecent(restored);
        }
      }
    } catch {}
  });

  // Register /subagents inspection command
  pi.registerCommand("subagents", {
    description: "Peer into what subagents are currently working on or review past logs",
    handler: async (args, ctx) => {
      globalSubagentTracker.setUIContext(ctx);
      const active = globalSubagentTracker.getActiveList();
      const recent = globalSubagentTracker.getRecentList();
      const all = [...active, ...recent];

      if (all.length === 0) {
        ctx.ui.notify("No active or recent subagents found.", "info");
        return;
      }

      if (!ctx.hasUI || ctx.mode !== "tui") {
        const lines: string[] = all.map((s) => {
          const dur = s.durationMs
            ? `${(s.durationMs / 1000).toFixed(1)}s`
            : `${((Date.now() - s.startTime) / 1000).toFixed(1)}s`;
          return `[${s.id}] "${s.task.slice(0, 40)}" (${s.status}, ${dur}) - Log: ${s.logFile}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Determine target subagent
      let target: typeof all[0] | undefined;

      const trimmedArg = args?.trim();
      if (trimmedArg) {
        target = all.find((s) => s.id === trimmedArg || s.id.includes(trimmedArg));
      }

      if (!target) {
        if (all.length === 1) {
          target = all[0];
        } else {
          const options = all.map((s) => {
            const icon = s.status === "running" ? "⠋" : s.status === "completed" ? "●" : "▲";
            const dur = s.durationMs
              ? `${(s.durationMs / 1000).toFixed(1)}s`
              : `${((Date.now() - s.startTime) / 1000).toFixed(1)}s`;
            const title = s.description || (s.task.length > 40 ? `${s.task.slice(0, 37)}...` : s.task);
            return `${icon} [${s.id}] "${title}" (${s.status}, ${dur})`;
          });

          const selected = await ctx.ui.select("Select a subagent to peer into:", options);
          if (selected === undefined) return;
          const idx = options.indexOf(selected);
          target = all[idx];
        }
      }

      if (!target) return;

      await ctx.ui.custom((tui, theme, _kb, done) => {
        return new SubagentViewer({
          id: target.id,
          task: target.task,
          logPath: target.logFile,
          theme,
          tui,
          tracker: globalSubagentTracker,
          done,
        });
      });
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

      // Persist subagent metadata to session JSONL so it survives session exit and rejoin
      try {
        if (ctx.sessionManager && typeof ctx.sessionManager.appendCustomEntry === "function") {
          ctx.sessionManager.appendCustomEntry("subagent_record", {
            id: result.details.id,
            task: result.details.task,
            description: result.details.description,
            startTime: Date.now() - (result.details.durationMs ?? 0),
            endTime: Date.now(),
            durationMs: result.details.durationMs,
            status: result.details.status,
            isolated: result.details.isolated,
            logFile: result.details.logFile,
            exitCode: result.details.exitCode,
            currentLine: "Done",
          });
        }
      } catch {}

      return {
        content: [{ type: "text", text: result.output }],
        details: result.details,
      };
    },
  });
}
