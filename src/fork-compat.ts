import { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { cleanSubagentOutput } from "./subagent-ui.js";

const FORK_SUPPORT_INSTALLED = Symbol.for("pi.subagents.fork_support_installed");

function extractAssistantReplyText(entry: any): string {
  if (!entry || entry.type !== "message" || entry.message?.role !== "assistant") {
    return "";
  }
  const content = entry.message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part: any) => part.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text);
    return textParts.join("\n").trim();
  }
  return "";
}

function extractUserMessageText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
  }
  return "";
}

/**
 * Walks forward from a `subagent-response` custom_message entry along its descendant chain
 * to locate the final entry of that turn (typically the assistant's reply message, or tool calls/compaction).
 */
export function findSubagentTurnEndEntryId(
  entries: any[],
  cmEntryId: string,
  branchEntries?: any[]
): string {
  const cmEntry = entries.find(
    (e) => e.id === cmEntryId && e.type === "custom_message" && e.customType === "subagent-response"
  );
  if (!cmEntry) {
    return cmEntryId;
  }

  // 1. If branchEntries is provided and contains cmEntryId, walk directly down the branch slice
  if (Array.isArray(branchEntries) && branchEntries.length > 0) {
    const idx = branchEntries.findIndex((e) => e.id === cmEntryId);
    if (idx !== -1) {
      let lastTurnEntryId = cmEntryId;
      let seenAssistantReply = false;
      for (let i = idx + 1; i < branchEntries.length; i++) {
        const entry = branchEntries[i];
        if (entry.type === "message" && entry.message?.role === "user") {
          break;
        }
        if (entry.type === "custom_message" && seenAssistantReply) {
          break;
        }
        if (entry.type === "message" && entry.message?.role === "assistant") {
          seenAssistantReply = true;
          lastTurnEntryId = entry.id;
        } else if (
          (entry.type === "message" && entry.message?.role === "toolResult") ||
          entry.type === "compaction" ||
          (entry.type === "custom_message" && !seenAssistantReply)
        ) {
          lastTurnEntryId = entry.id;
        }
      }
      return lastTurnEntryId;
    }
  }

  // 2. Fallback: walk along parentId links across entries
  const childrenMap = new Map<string, any[]>();
  for (const entry of entries) {
    if (entry.parentId) {
      const list = childrenMap.get(entry.parentId) || [];
      list.push(entry);
      childrenMap.set(entry.parentId, list);
    }
  }

  const branchSet = branchEntries ? new Set(branchEntries.map((e: any) => e.id)) : undefined;

  let currentId = cmEntryId;
  let lastTurnEntryId = cmEntryId;
  let seenAssistantReply = false;

  while (true) {
    const children = childrenMap.get(currentId);
    if (!children || children.length === 0) {
      break;
    }

    // Prefer active branch child if available, else latest child
    let nextChild = children[0];
    if (branchSet) {
      const branchChild = children.find((c) => branchSet.has(c.id));
      if (branchChild) {
        nextChild = branchChild;
      }
    } else if (children.length > 1) {
      nextChild = children[children.length - 1];
    }

    if (nextChild.type === "message" && nextChild.message?.role === "user") {
      break;
    }
    if (nextChild.type === "custom_message" && seenAssistantReply) {
      break;
    }
    if (nextChild.type === "message" && nextChild.message?.role === "assistant") {
      seenAssistantReply = true;
      lastTurnEntryId = nextChild.id;
    } else if (
      (nextChild.type === "message" && nextChild.message?.role === "toolResult") ||
      nextChild.type === "compaction" ||
      (nextChild.type === "custom_message" && !seenAssistantReply)
    ) {
      lastTurnEntryId = nextChild.id;
    }

    currentId = nextChild.id;
  }

  return lastTurnEntryId;
}

/**
 * Formats a clean, readable one-line label for a subagent turn in the /fork message selector.
 */
export function formatSubagentForkLabel(cmEntry: any, endEntry?: any): string {
  const details = cmEntry?.details || {};
  const subagentId = details.id || "subagent";
  const desc = details.description || (details.task ? details.task.split("\n")[0].trim() : "");
  const header = `[Subagent ${subagentId}${desc ? `: ${desc}` : ""}]`;

  const replyText = extractAssistantReplyText(endEntry);
  if (replyText) {
    const cleanReply = replyText.replace(/[\r\n\t]+/g, " ").trim();
    return `${header} → ${cleanReply}`;
  }

  const rawSummary =
    details.summary ||
    (typeof cmEntry?.content === "string" ? cmEntry.content : cmEntry?.content?.[0]?.text || "");
  const cleaned = cleanSubagentOutput(rawSummary);
  if (cleaned) {
    const cleanSummary = cleaned.replace(/[\r\n\t]+/g, " ").trim();
    return `${header} - ${cleanSummary}`;
  }

  return header;
}

/**
 * Installs monkey-patches on AgentSession and AgentSessionRuntime prototypes
 * to natively support /fork from background subagent turns.
 * Idempotent.
 */
export function installSubagentForkSupport(): void {
  if (typeof AgentSession === "undefined" || !AgentSession?.prototype) {
    return;
  }

  if ((AgentSession.prototype as any)[FORK_SUPPORT_INSTALLED]) {
    return;
  }

  // 1. Patch AgentSession.prototype.getUserMessagesForForking
  const originalGetUserMessagesForForking = AgentSession.prototype.getUserMessagesForForking;

  AgentSession.prototype.getUserMessagesForForking = function (this: any): Array<{ entryId: string; text: string }> {
    if (!this.sessionManager || typeof this.sessionManager.getEntries !== "function") {
      return originalGetUserMessagesForForking ? originalGetUserMessagesForForking.call(this) : [];
    }

    const branch = typeof this.sessionManager.getBranch === "function" ? this.sessionManager.getBranch() : undefined;
    const entries = this.sessionManager.getEntries();
    const sourceEntries = Array.isArray(branch) && branch.length > 0 ? branch : entries;

    const result: Array<{ entryId: string; text: string }> = [];

    for (const entry of sourceEntries) {
      if (entry.type === "message" && entry.message?.role === "user") {
        const text = extractUserMessageText(entry.message.content);
        if (text) {
          result.push({ entryId: entry.id, text });
        }
      } else if (entry.type === "custom_message" && entry.customType === "subagent-response") {
        const endId = findSubagentTurnEndEntryId(entries, entry.id, branch);
        const endEntry = this.sessionManager.getEntry?.(endId) ?? entries.find((e: any) => e.id === endId);
        const label = formatSubagentForkLabel(entry, endEntry);
        result.push({ entryId: entry.id, text: label });
      }
    }

    return result;
  };

  (AgentSession.prototype as any)[FORK_SUPPORT_INSTALLED] = true;

  // 2. Patch AgentSessionRuntime.prototype.fork
  if (typeof AgentSessionRuntime !== "undefined" && AgentSessionRuntime?.prototype) {
    const originalFork = AgentSessionRuntime.prototype.fork;

    AgentSessionRuntime.prototype.fork = async function (this: any, entryId: string, options?: any) {
      const position = options?.position ?? "before";

      if (position === "before") {
        const selectedEntry = this.session?.sessionManager?.getEntry?.(entryId);
        if (selectedEntry?.type === "custom_message" && selectedEntry?.customType === "subagent-response") {
          const entries = this.session.sessionManager.getEntries();
          const branch =
            typeof this.session.sessionManager.getBranch === "function"
              ? this.session.sessionManager.getBranch()
              : undefined;
          const targetEndId = findSubagentTurnEndEntryId(entries, entryId, branch);
          return originalFork.call(this, targetEndId, { ...options, position: "at" });
        }
      }

      return originalFork.call(this, entryId, options);
    };

    (AgentSessionRuntime.prototype as any)[FORK_SUPPORT_INSTALLED] = true;
  }
}
