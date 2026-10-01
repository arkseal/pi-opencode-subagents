import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeSubagent } from "./runner.js";
import { renderSubagentCall, renderSubagentResult, cleanSubagentOutput, buildSubagentStatsSummary, renderSubagentStatsMessage } from "./subagent-ui.js";
import { globalSubagentTracker } from "./tracker.js";
import { SubagentViewer } from "./subagent-viewer.js";
import { loadSubagentSettings, saveSubagentSettings, type SubagentSettings, type SubagentDisplayMode } from "./config.js";

export { executeSubagent } from "./runner.js";
export { createWorktree, cleanupWorktree } from "./worktree.js";
export { formatTaskResultEnvelope } from "./envelope.js";
export { checkSubagentDepth, setMaxDepth } from "./depth-guard.js";
export { renderSubagentCall, renderSubagentResult, cleanSubagentOutput, buildSubagentStatsSummary, renderSubagentStatsMessage } from "./subagent-ui.js";
export { globalSubagentTracker, SubagentTracker } from "./tracker.js";
export { SubagentViewer } from "./subagent-viewer.js";
export { loadSubagentSettings, saveSubagentSettings, type SubagentSettings, type SubagentDisplayMode } from "./config.js";

export default function opencodeSubagentsExtension(pi: ExtensionAPI) {
  // Register custom message renderer for subagent stats in main chat
  if (typeof (pi as any).registerMessageRenderer === "function") {
    (pi as any).registerMessageRenderer("subagent-stats", renderSubagentStatsMessage);
  }

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

  function formatDisplayModeNotification(mode: SubagentDisplayMode): string {
    switch (mode) {
      case "input":
        return "Subagent display: 1. only above text input";
      case "sidebar":
        return "Subagent display: 2. only sidebar";
      case "both":
        return "Subagent display: 3. both (above text input & sidebar)";
    }
  }

  function handleDisplayToggle(args: string | undefined, ctx: any) {
    const arg = args?.trim().toLowerCase();
    let mode: SubagentDisplayMode;
    if (arg === "input" || arg === "1") mode = "input";
    else if (arg === "sidebar" || arg === "2") mode = "sidebar";
    else if (arg === "both" || arg === "3") mode = "both";
    else {
      mode = globalSubagentTracker.cycleDisplayMode();
      ctx.ui.notify(formatDisplayModeNotification(mode), "info");
      return;
    }
    globalSubagentTracker.setDisplayMode(mode);
    ctx.ui.notify(formatDisplayModeNotification(mode), "info");
  }

  // Register /subagents inspection and toggle command
  pi.registerCommand("subagents", {
    description: "Peer into subagents or toggle UI display: /subagents [id] | toggle [input|sidebar|both]",
    handler: async (args, ctx) => {
      globalSubagentTracker.setUIContext(ctx);
      const trimmedArg = args?.trim();

      // Subcommand: 3-way display toggle (1. only above input | 2. only sidebar | 3. both)
      if (trimmedArg && (
        trimmedArg === "toggle" ||
        trimmedArg.startsWith("toggle ") ||
        trimmedArg === "sidebar" ||
        trimmedArg.startsWith("sidebar ") ||
        trimmedArg === "display" ||
        trimmedArg.startsWith("display ")
      )) {
        const parts = trimmedArg.split(/\s+/);
        handleDisplayToggle(parts.slice(1).join(" "), ctx);
        return;
      }

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

  // 3-way toggle command for subagent display: 1. only above input | 2. only sidebar | 3. both
  pi.registerCommand("subagents-toggle", {
    description: "3-way toggle subagent display: 1. only above text input | 2. only sidebar | 3. both",
    handler: async (args, ctx) => handleDisplayToggle(args, ctx),
  });

  pi.registerCommand("subagents-sidebar", {
    description: "3-way toggle subagent display: 1. only above text input | 2. only sidebar | 3. both",
    handler: async (args, ctx) => handleDisplayToggle(args, ctx),
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to autonomous child agents in isolated Git worktrees. Call multiple subagents in parallel in a single turn for independent tasks.",
    promptSnippet: "Delegate tasks to isolated subagents (supports parallel calls)",
    promptGuidelines: [
      "Dispatch multiple subagent calls in parallel within a single turn for independent tasks.",
    ],
    parameters: Type.Object(
      {
        task: Type.String({
          description: "Task description for the subagent to perform autonomously",
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

      const cumulative = globalSubagentTracker.getCumulativeStats();
      result.details.cumulativeStats = cumulative;

      if (pi.events && result.details?.stats) {
        pi.events.emit("subagent:stats", {
          id: result.details.id,
          stats: result.details.stats,
          cumulative,
        });
      }

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
            stats: result.details.stats,
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
