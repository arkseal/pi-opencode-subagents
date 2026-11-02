import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  mode: "subagent" | "primary" | "all";
  system?: string;
  model?: string;
  tools?: string[];
  excludeTools?: string[];
}

export const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- You MUST NOT create, modify, delete, move, or copy files, including temporary files and reports
- Shell commands MUST be read-only. NEVER run commands that write files or change system state

Complete the user's search request efficiently and report your findings clearly.`;

export const BUILTIN_AGENTS: AgentProfile[] = [
  {
    id: "general",
    name: "General",
    description:
      "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
    mode: "subagent",
    excludeTools: ["subagent"],
  },
  {
    id: "explore",
    name: "Explore",
    description:
      'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). Specify desired thoroughness: "quick", "medium", or "very thorough".',
    mode: "subagent",
    system: PROMPT_EXPLORE,
    tools: ["read", "glob", "grep", "web_fetch", "websearch", "bash"],
    excludeTools: ["edit", "write", "subagent"],
  },
];

/**
 * Minimal YAML-like frontmatter parser for markdown agent definitions.
 * Parses frontmatter between leading --- delimiters without heavy dependencies.
 */
export function parseAgentMarkdown(content: string, defaultId: string): AgentProfile | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return {
      id: defaultId,
      name: defaultId.charAt(0).toUpperCase() + defaultId.slice(1),
      description: "Custom agent",
      mode: "subagent",
      system: trimmed,
    };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return null;
  }

  const frontmatterStr = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).trim();

  const data: Record<string, any> = {};
  const lines = frontmatterStr.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // List item under active key
    if (line.startsWith("- ") && currentKey) {
      if (!currentList) {
        currentList = [];
        data[currentKey] = currentList;
      }
      currentList.push(line.slice(2).trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex !== -1) {
      currentKey = line.slice(0, colonIndex).trim();
      currentList = null;
      const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
      if (value) {
        data[currentKey] = value;
      }
    }
  }

  const mode = data.mode?.toLowerCase();
  if (mode === "primary") {
    // Primary-only agents cannot be used as subagents
    return null;
  }

  const id = (data.id || defaultId).toLowerCase();
  const name = data.name || id.charAt(0).toUpperCase() + id.slice(1);
  const description = data.description || "Custom agent";

  const tools = Array.isArray(data.tools)
    ? data.tools
    : typeof data.tools === "string"
      ? data.tools.split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined;

  const excludeTools = Array.isArray(data.excludeTools || data.exclude_tools)
    ? data.excludeTools || data.exclude_tools
    : typeof (data.excludeTools || data.exclude_tools) === "string"
      ? (data.excludeTools || data.exclude_tools).split(",").map((s: string) => s.trim()).filter(Boolean)
      : ["subagent"];

  return {
    id,
    name,
    description,
    mode: mode === "all" ? "all" : "subagent",
    system: body || data.system || undefined,
    model: data.model || undefined,
    tools,
    excludeTools,
  };
}

/**
 * Discovers custom agents from standard directories:
 * - <cwd>/.opencode/agents/
 * - ~/.config/opencode/agents/
 * - <cwd>/.pi/agents/
 * - ~/.pi/agent/agents/
 */
export async function discoverAgents(cwd: string): Promise<AgentProfile[]> {
  const agentsMap = new Map<string, AgentProfile>();

  // Add builtins first
  for (const b of BUILTIN_AGENTS) {
    agentsMap.set(b.id, b);
  }

  const candidateDirs = [
    path.join(os.homedir(), ".config", "opencode", "agents"),
    path.join(os.homedir(), ".pi", "agent", "agents"),
    path.join(cwd, ".opencode", "agents"),
    path.join(cwd, ".pi", "agents"),
  ];

  for (const dir of candidateDirs) {
    try {
      if (!fsSync.existsSync(dir)) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const filePath = path.join(dir, entry.name);
          const defaultId = entry.name.replace(/\.md$/, "").toLowerCase();
          try {
            const content = await fs.readFile(filePath, "utf-8");
            const agent = parseAgentMarkdown(content, defaultId);
            if (agent) {
              agentsMap.set(agent.id, agent);
            }
          } catch {}
        }
      }
    } catch {}
  }

  return Array.from(agentsMap.values());
}

/**
 * Resolves an agent by name or id, falling back to "general".
 */
export async function resolveAgent(nameOrId: string | undefined, cwd: string): Promise<AgentProfile> {
  if (!nameOrId) {
    return BUILTIN_AGENTS[0]; // general
  }

  const normalized = nameOrId.trim().toLowerCase();
  const allAgents = await discoverAgents(cwd);
  const matched = allAgents.find(
    (a) => a.id.toLowerCase() === normalized || a.name.toLowerCase() === normalized
  );

  return matched ?? BUILTIN_AGENTS[0];
}

/**
 * Formats available subagents into a clean markdown description for LLM tools.
 */
export function formatAvailableAgentsDescription(agents: AgentProfile[]): string {
  if (agents.length === 0) return "";
  const lines = [
    "Available subagents:",
    ...agents.map((a) => `- ${a.id}: ${a.description}`),
  ];
  return lines.join("\n");
}
