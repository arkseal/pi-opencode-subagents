import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeSubagent } from "./runner.js";

export { executeSubagent } from "./runner.js";
export { createWorktree, cleanupWorktree } from "./worktree.js";
export { formatTaskResultEnvelope } from "./envelope.js";
export { checkSubagentDepth, setMaxDepth } from "./depth-guard.js";

export default function opencodeSubagentsExtension(pi: ExtensionAPI) {
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
        isolated: Type.Optional(
          Type.Boolean({
            description:
              "Run in an isolated Git worktree (default true). Keeps working tree clean from experimental edits.",
          })
        ),
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const depth = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
      const result = await executeSubagent({
        task: params.task,
        cwd: ctx.cwd,
        isolated: params.isolated ?? true,
        currentDepth: depth,
      });

      return {
        content: [{ type: "text", text: result.output }],
        details: result.details,
      };
    },
  });
}
