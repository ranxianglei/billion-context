import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "./config-dir.js";

/** Printed/logged once per process when acp_delegate stands down because
 *  pi-subagents is installed (billion-context-pi #415). */
export const DELEGATE_STAND_DOWN_MESSAGE = [
  "[billion-context-pi-subagents] pi-subagents detected — acp_delegate has been automatically disabled to avoid two overlapping sub-agent systems.",
  "pi-subagents' agents do NOT get ACP context compression by default. Run /acp-subagents (billion-context-pi) to inject compress/decompress/search_context/acp_status into its agent overrides.",
  'To keep acp_delegate despite pi-subagents being installed, set "delegate": { "forceEnable": true } in acp.json.',
].join("\n");

/** Resolve the pi agent config directory (e.g. ~/.pi/agent), honoring the
 *  PI_CODING_AGENT_DIR environment variable (mirroring pi's own resolution). */
export function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return os.homedir();
    if (envDir.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
    return envDir;
  }
  return path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

function npmInstallAt(base: string): string | null {
  const dir = path.join(base, "npm", "node_modules", "pi-subagents");
  return fs.existsSync(path.join(dir, "package.json")) ? dir : null;
}

function extensionInstallUnder(root: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(root, entry.name, "package.json");
    try {
      if (JSON.parse(fs.readFileSync(pkgPath, "utf-8")).name === "pi-subagents") {
        return path.join(root, entry.name);
      }
    } catch {
      // Not a readable package — keep scanning.
    }
  }
  return null;
}

/** Scope-split detection result (#415): a user-scope install must not silently
 *  disable acp_delegate in every project — only project-scope hits trigger the
 *  auto stand-down; user-scope-only hits get a warning log instead. */
export interface PiSubagentsScopes {
  user: string[];
  project: string[];
}

/** Detect installed pi-subagents packages by scope. Checked in priority order:
 *  1. user npm install:      <agentDir>/npm/node_modules/pi-subagents
 *  2. project npm install:   <cwd>/.pi/npm/node_modules/pi-subagents
 *  3. user extension dir:    <agentDir>/extensions/<name> where name === "pi-subagents"
 *  4. project extension dir: <cwd>/.pi/extensions/<name>
 *  Git installs and the legacy global npm location are intentionally not
 *  checked: a miss there is a safe no-op. */
export function findPiSubagentsInstalls(agentDir: string, cwd: string): PiSubagentsScopes {
  const pick = (paths: Array<string | null>): string[] => paths.filter((p): p is string => p !== null);
  return {
    user: pick([npmInstallAt(agentDir), extensionInstallUnder(path.join(agentDir, "extensions"))]),
    project: pick([npmInstallAt(path.join(cwd, CONFIG_DIR_NAME)), extensionInstallUnder(path.join(cwd, CONFIG_DIR_NAME, "extensions"))]),
  };
}
