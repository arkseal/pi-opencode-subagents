import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type SubagentDisplayMode = "input" | "sidebar" | "both";

export interface SubagentSettings {
  displayMode: SubagentDisplayMode;
  sidebarEnabled: boolean;
  widgetEnabled: boolean;
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  displayMode: "both",
  sidebarEnabled: true,
  widgetEnabled: true,
};

function getSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "subagents.json");
}

export function loadSubagentSettings(): SubagentSettings {
  const filePath = getSettingsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_SUBAGENT_SETTINGS };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    let displayMode: SubagentDisplayMode = "both";
    if (parsed.displayMode === "input" || parsed.displayMode === "sidebar" || parsed.displayMode === "both") {
      displayMode = parsed.displayMode;
    } else if (parsed.sidebarEnabled === false && parsed.widgetEnabled !== false) {
      displayMode = "input";
    } else if (parsed.widgetEnabled === false && parsed.sidebarEnabled !== false) {
      displayMode = "sidebar";
    }

    const sidebarEnabled = displayMode === "sidebar" || displayMode === "both";
    const widgetEnabled = displayMode === "input" || displayMode === "both";

    return {
      displayMode,
      sidebarEnabled,
      widgetEnabled,
    };
  } catch {
    return { ...DEFAULT_SUBAGENT_SETTINGS };
  }
}

export function saveSubagentSettings(settings: Partial<SubagentSettings>): void {
  const current = loadSubagentSettings();
  const updated: SubagentSettings = { ...current, ...settings };
  if (settings.displayMode) {
    updated.displayMode = settings.displayMode;
    updated.sidebarEnabled = settings.displayMode === "sidebar" || settings.displayMode === "both";
    updated.widgetEnabled = settings.displayMode === "input" || settings.displayMode === "both";
  }
  const filePath = getSettingsPath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf-8");
  } catch {}
}
