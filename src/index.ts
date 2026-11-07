import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeSubagent,
  getSubagentDir,
  getSubagentSessionsDir,
  stopSubagent,
  stopAllSubagents,
  shutdownSubagent,
  shutdownAllSubagents,
  buildPiArgs,
  type SubagentModelOption,
} from "./runner.js";
import {
  renderSubagentCall,
  renderSubagentResult,
  cleanSubagentOutput,
  buildSubagentStatsSummary,
  renderSubagentStatsMessage,
  renderSubagentResponseMessage,
} from "./subagent-ui.js";
import { globalSubagentTracker, SubagentTracker } from "./tracker.js";
import { SubagentViewer } from "./subagent-viewer.js";
import {
  loadSubagentSettings,
  saveSubagentSettings,
  type SubagentSettings,
  type SubagentDisplayMode,
} from "./config.js";
import { formatSubagentEnvelope } from "./envelope.js";
import {
  discoverAgents,
  resolveAgent,
  formatAvailableAgentsDescription,
  BUILTIN_AGENTS,
  type AgentProfile,
} from "./agents.js";

export {
  executeSubagent,
  getSubagentDir,
  getSubagentSessionsDir,
  stopSubagent,
  stopAllSubagents,
  shutdownSubagent,
  shutdownAllSubagents,
  buildPiArgs,
  type SubagentModelOption,
} from "./runner.js";
export { createWorktree, cleanupWorktree } from "./worktree.js";
export { formatTaskResultEnvelope, formatSubagentEnvelope } from "./envelope.js";
export { checkSubagentDepth, setMaxDepth } from "./depth-guard.js";
export {
  renderSubagentCall,
  renderSubagentResult,
  cleanSubagentOutput,
  buildSubagentStatsSummary,
  renderSubagentStatsMessage,
} from "./subagent-ui.js";
export { globalSubagentTracker, SubagentTracker } from "./tracker.js";
export { SubagentViewer } from "./subagent-viewer.js";
export { loadSubagentSettings, saveSubagentSettings, type SubagentSettings, type SubagentDisplayMode } from "./config.js";
export {
  discoverAgents,
  resolveAgent,
  formatAvailableAgentsDescription,
  BUILTIN_AGENTS,
  type AgentProfile,
} from "./agents.js";

export default function opencodeSubagentsExtension(pi: ExtensionAPI) {
  // Register custom message renderers for subagent stats & responses in main chat
  if (typeof (pi as any).registerMessageRenderer === "function") {
    (pi as any).registerMessageRenderer("subagent-stats", renderSubagentStatsMessage);
    (pi as any).registerMessageRenderer("subagent-response", renderSubagentResponseMessage);
  }

  let discoveredAgents: AgentProfile[] = [...BUILTIN_AGENTS];
  let isAgentActive = false;

  pi.on("agent_start", () => {
    isAgentActive = true;
  });

  pi.on("agent_end", () => {
    isAgentActive = false;
  });

  pi.on("agent_settled", () => {
    isAgentActive = false;
  });

  pi.on("session_shutdown", async () => {
    await shutdownAllSubagents();
  });

  // Capture UI context and restore subagents on session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    globalSubagentTracker.setUIContext(ctx);

    try {
      discoveredAgents = await discoverAgents(ctx.cwd);
    } catch {}

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

      // Subcommand: stop / cancel all running subagents
      if (trimmedArg === "stop" || trimmedArg === "cancel" || trimmedArg === "kill") {
        const stopped = await shutdownAllSubagents();
        ctx.ui.notify(stopped > 0 ? `Stopped ${stopped} running subagent(s).` : "No running subagents to stop.", "info");
        return;
      }

      // Subcommand: 3-way display toggle (1. only above input | 2. only sidebar | 3. both)
      if (trimmedArg === "more" || trimmedArg === "expand") {
        const showAll = globalSubagentTracker.toggleSidebarShowAll();
        const msg = showAll
          ? "Sidebar subagents: showing all subagents"
          : "Sidebar subagents: showing last 5 subagents";
        ctx.ui.notify(msg, "info");
        return;
      }

      if (
        trimmedArg &&
        (trimmedArg === "toggle" ||
          trimmedArg.startsWith("toggle ") ||
          trimmedArg === "sidebar" ||
          trimmedArg.startsWith("sidebar ") ||
          trimmedArg === "display" ||
          trimmedArg.startsWith("display "))
      ) {
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

      let target: (typeof all)[0] | undefined;
      if (trimmedArg) {
        target = all.find((s) => s.id === trimmedArg || s.id.includes(trimmedArg));
      }

      // Open native Pi-style SubagentViewer (matching Pi's fork / tree UX) as fullscreen overlay
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          return new SubagentViewer({
            initialMode: target ? "transcript" : "list",
            id: target?.id,
            task: target ? target.description || target.task : undefined,
            logPath: target?.logFile,
            theme,
            tui,
            tracker: globalSubagentTracker,
            done,
            canGoBackToList: target ? false : true,
          });
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            row: 0,
            col: 0,
            width: "100%",
            maxHeight: "100%",
          },
        }
      );
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

  pi.registerCommand("subagents-more", {
    description: "Toggle displaying all subagents vs last 5 in the sidebar panel",
    handler: async (_args, ctx) => {
      const showAll = globalSubagentTracker.toggleSidebarShowAll();
      const msg = showAll
        ? "Sidebar subagents: showing all subagents"
        : "Sidebar subagents: showing last 5 subagents";
      ctx.ui.notify(msg, "info");
    },
  });

  const toolDescription = [
    "Spawns an agent in a child session to work on the specified task.",
    "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
    "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
    "Non-blocking background mode (default) launches the subagent asynchronously and returns immediately so the main chat is never held; you are notified when it finishes.",
    "Foreground mode (background=false) blocks until the subagent completes.",
    "",
    "Available subagents:",
    "- general: General-purpose agent for researching complex questions and executing multi-step tasks.",
    "- explore: Fast agent specialized for exploring codebases (read-only searcher).",
  ].join("\n");

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: toolDescription,
    promptSnippet: "Delegate tasks to specialized subagents (non-blocking by default; supports parallel calls, continuation, and background)",
    promptGuidelines: [
      "Subagents run asynchronously in the background by default without blocking the main chat. Set background=false only if you must synchronously wait for the result before continuing.",
      "Dispatch multiple subagent calls in parallel within a single turn for independent tasks.",
      "Use agent='explore' for read-only codebase exploration, keyword search, or file inspection.",
      "Pass sessionID to continue an existing child conversation instead of starting from scratch.",
      "Optionally configure a specific model or reasoning effort for subagents depending on task complexity.",
    ],
    parameters: Type.Object(
      {
        task: Type.Optional(
          Type.String({
            description: "Task description for the subagent to perform autonomously",
          })
        ),
        prompt: Type.Optional(
          Type.String({
            description: "Alias for task. The task for the subagent to perform.",
          })
        ),
        agent: Type.Optional(
          Type.String({
            description:
              "The type of specialized agent to use ('general', 'explore', or custom agent name). Defaults to 'general'.",
          })
        ),
        description: Type.Optional(
          Type.String({
            description: "A short 3-5 word summary/title of the task for the UI header",
          })
        ),
        sessionID: Type.Optional(
          Type.String({
            description:
              "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
          })
        ),
        background: Type.Optional(
          Type.Boolean({
            description:
              "Run the subagent in the background without blocking the main chat (default true). Set to false to block until complete.",
          })
        ),
        isolated: Type.Optional(
          Type.Boolean({
            description:
              "Run in an isolated Git worktree (default true). Keeps working tree clean from experimental edits.",
          })
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Optional model to use for the subagent (e.g. 'openai/gpt-4o', 'claude-sonnet', or 'claude-sonnet:high'). Supports ':thinking' suffix to set reasoning.",
          })
        ),
        reasoning: Type.Optional(
          Type.String({
            description:
              "Optional reasoning effort or thinking level for the subagent (e.g. 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max').",
          })
        ),
        thinking: Type.Optional(
          Type.String({
            description:
              "Alias for reasoning. Set thinking level for the subagent (e.g. 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max').",
          })
        ),
      },
      { additionalProperties: false }
    ),
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      globalSubagentTracker.setUIContext(ctx);
      const rawDepth = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
      const depth = Number.isFinite(rawDepth) ? rawDepth : 0;
      const task = (params.task || params.prompt || "").trim();
      if (!task) {
        throw new Error("A task or prompt must be specified for the subagent.");
      }
      const isBackground = params.background !== false;

      const result = await executeSubagent({
        task,
        prompt: task,
        agent: params.agent,
        description: params.description,
        sessionID: params.sessionID,
        background: isBackground,
        cwd: ctx.cwd,
        isolated: params.isolated ?? true,
        model: params.model,
        reasoning: params.reasoning ?? params.thinking,
        thinking: params.thinking,
        currentDepth: depth,
        signal,
        onUpdate,
        uiContext: ctx,
        onBackgroundComplete: (bgResult) => {
          // Deliver completion record to session JSONL
          try {
            const record = {
              id: bgResult.id,
              sessionID: bgResult.sessionID,
              agent: params.agent,
              task,
              description: params.description,
              model: (bgResult as any).model ?? params.model,
              reasoning: (bgResult as any).reasoning ?? (params.reasoning ?? params.thinking),
              startTime: Date.now() - (bgResult.durationMs ?? 0),
              endTime: Date.now(),
              durationMs: bgResult.durationMs,
              status: bgResult.status,
              isolated: (bgResult as any).isolated ?? params.isolated ?? true,
              logFile: (bgResult as any).logFile,
              currentLine: "Done",
              stats: bgResult.stats,
            };
            if (typeof (pi as any).appendEntry === "function") {
              (pi as any).appendEntry("subagent_record", record);
            } else if (ctx.sessionManager && typeof (ctx.sessionManager as any).appendCustomEntry === "function") {
              (ctx.sessionManager as any).appendCustomEntry("subagent_record", record);
            }
          } catch {}

          // Automatically deliver subagent response into main chat
          const settings = loadSubagentSettings();
          if (settings.autoDeliver !== false) {
            try {
              const envelope = formatSubagentEnvelope({
                id: bgResult.id,
                sessionID: bgResult.sessionID,
                status: bgResult.status as any,
                durationMs: bgResult.durationMs,
                summary: bgResult.summary,
                model: (bgResult as any).model ?? params.model,
                reasoning: (bgResult as any).reasoning ?? (params.reasoning ?? params.thinking),
                stats: bgResult.stats,
                logFilePath: (bgResult as any).logFile,
              });

              // Deliver visually compacted response using sendMessage if supported, else sendUserMessage
              if (typeof (pi as any).sendMessage === "function") {
                (pi as any).sendMessage(
                  {
                    customType: "subagent-response",
                    content: envelope,
                    display: true,
                    details: {
                      id: bgResult.id,
                      sessionID: bgResult.sessionID,
                      status: bgResult.status,
                      durationMs: bgResult.durationMs,
                      summary: bgResult.summary,
                      stats: bgResult.stats,
                      model: (bgResult as any).model ?? params.model,
                      reasoning: (bgResult as any).reasoning ?? (params.reasoning ?? params.thinking),
                      logFile: (bgResult as any).logFile,
                      task,
                      description: params.description,
                      agent: params.agent,
                    },
                  },
                  {
                    triggerTurn: true,
                    deliverAs: isAgentActive ? "steer" : undefined,
                  }
                );
              } else if (typeof (pi as any).sendUserMessage === "function") {
                if (isAgentActive) {
                  // If main chat is working, queue with deliverAs: "steer"
                  // Pi prioritizes steering messages ahead of queued user follow-ups!
                  (pi as any).sendUserMessage(envelope, { deliverAs: "steer" });
                } else {
                  // If main chat is idle, restart main chat so it responds immediately
                  (pi as any).sendUserMessage(envelope);
                }
              }
            } catch (err) {
              console.error("Failed to deliver subagent response to main chat:", err);
            }
          }
        },
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

      // Persist completed subagent metadata to session JSONL so it survives session exit and rejoin
      if (!isBackground) {
        try {
          const record = {
            id: result.details.id,
            sessionID: result.details.sessionID,
            agent: result.details.agent,
            task: result.details.task,
            description: result.details.description,
            model: result.details.model,
            reasoning: result.details.reasoning,
            startTime: Date.now() - (result.details.durationMs ?? 0),
            endTime: Date.now(),
            durationMs: result.details.durationMs,
            status: result.details.status,
            isolated: result.details.isolated,
            logFile: result.details.logFile,
            exitCode: result.details.exitCode,
            currentLine: "Done",
            stats: result.details.stats,
          };
          if (typeof (pi as any).appendEntry === "function") {
            (pi as any).appendEntry("subagent_record", record);
          } else if (ctx.sessionManager && typeof (ctx.sessionManager as any).appendCustomEntry === "function") {
            (ctx.sessionManager as any).appendCustomEntry("subagent_record", record);
          }
        } catch {}
      }

      const isFailed = result.details.status === "failed" || result.details.status === "aborted";
      return {
        content: [{ type: "text", text: result.output }],
        details: result.details,
        isError: isFailed,
      };
    },
  });
}
