// `bili plugin install|remove|list <agent>`: deploys the thin agent plugin
// (dist/agent/pi.js|omp.js) or the MCP shell (dist/mcp.js) into each host's
// native config, pointing at THIS billion-context install's absolute path —
// plugin and proxy always share one version. Every writer backs the target
// file up first and is idempotent. Config locations:
//   pi       ~/.pi/agent/settings.json   packages: [<abs package root>]
//   omp      ~/.omp/agent/config.yml     extensions: [<abs>/dist/agent/omp.js]
//   claude   `claude mcp add` (user scope; writes ~/.claude.json)
//   codex    ~/.codex/config.toml        [mcp_servers.bili]
//   opencode ~/.config/opencode/opencode.json  mcp.bili

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLUGIN_AGENTS = ["pi", "omp", "claude", "codex", "opencode"] as const;
export type PluginAgent = (typeof PLUGIN_AGENTS)[number];

export function selfPackageRoot(): string {
    // dist/plugin-install.js -> package root two levels up.
    const here = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(here), "..");
}

function homeFile(rel: string, envOverride?: string): string {
    const base = (envOverride && process.env[envOverride]) || os.homedir();
    return path.join(base, rel);
}

function backupOnce(file: string): void {
    if (fs.existsSync(file) && !fs.existsSync(`${file}.bili-bak`)) {
        fs.copyFileSync(file, `${file}.bili-bak`);
    }
}

function readJson(file: string): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// — pi ————————————————————————————————————————————————————————————————

function piSettingsFile(): string {
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (agentDir) return path.join(agentDir, "settings.json");
    return homeFile(".pi/agent/settings.json");
}

function isPiEntry(entry: string, root: string): boolean {
    return entry === root || entry === `npm:billion-context` || /^npm:billion-context@/.test(entry);
}

function piInstall(): string {
    const root = selfPackageRoot();
    const file = piSettingsFile();
    const settings = readJson(file);
    const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]).map(String) : [];
    if (packages.some((p) => isPiEntry(p, root))) return `pi: already installed (${file})`;
    packages.push(root);
    settings.packages = packages;
    writeJson(file, settings);
    return `pi: installed -> ${file} packages += ${root}`;
}

function piRemove(): string {
    const root = selfPackageRoot();
    const file = piSettingsFile();
    const settings = readJson(file);
    const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]).map(String) : [];
    const kept = packages.filter((p) => !isPiEntry(p, root));
    if (kept.length === packages.length) return `pi: not installed (${file})`;
    settings.packages = kept;
    writeJson(file, settings);
    return `pi: removed from ${file}`;
}

function piStatus(): string {
    const root = selfPackageRoot();
    const packages = readJson(piSettingsFile()).packages;
    const list = Array.isArray(packages) ? (packages as unknown[]).map(String) : [];
    return list.some((p) => isPiEntry(p, root)) ? "installed" : "not installed";
}

// — omp ———————————————————————————————————————————————————————————————

function ompConfigFile(): string {
    return homeFile(".omp/agent/config.yml", "OMP_CONFIG_HINT");
}

function ompExtensionPath(): string {
    return path.join(selfPackageRoot(), "dist", "agent", "omp.js");
}

function ompInstall(): string {
    const file = ompConfigFile();
    const entry = ompExtensionPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text.includes(entry)) return `omp: already installed (${file})`;
    let out: string;
    const extIdx = text.search(/^extensions:\s*$/m);
    if (extIdx >= 0) {
        const afterKey = text.indexOf("\n", extIdx);
        const rest = afterKey < 0 ? "" : text.slice(afterKey + 1);
        const firstNonList = rest.search(/^(?!\s*-\s)\S/m);
        let head: string;
        let tail: string;
        if (firstNonList >= 0) {
            head = text.slice(0, afterKey + 1 + firstNonList);
            tail = text.slice(afterKey + 1 + firstNonList);
        } else {
            head = text.length === 0 || text.endsWith("\n") ? text : text + "\n";
            tail = "";
        }
        out = `${head}  - ${entry}\n${tail}`;
    } else {
        out = text.endsWith("\n") || text.length === 0 ? text : text + "\n";
        out += `extensions:\n  - ${entry}\n`;
    }
    backupOnce(file);
    fs.writeFileSync(file, out);
    return `omp: installed -> ${file} extensions += ${entry}`;
}

function ompRemove(): string {
    const file = ompConfigFile();
    const entry = ompExtensionPath();
    if (!fs.existsSync(file)) return `omp: not installed (${file})`;
    const text = fs.readFileSync(file, "utf8");
    const cleaned = text
        .split("\n")
        .filter((line) => line.trim() !== `- ${entry}`)
        .join("\n");
    if (cleaned === text) return `omp: not installed (${file})`;
    backupOnce(file);
    fs.writeFileSync(file, cleaned);
    return `omp: removed from ${file}`;
}

function ompStatus(): string {
    const text = fs.existsSync(ompConfigFile()) ? fs.readFileSync(ompConfigFile(), "utf8") : "";
    return text.includes(ompExtensionPath()) ? "installed" : "not installed";
}

// — claude —————————————————————————————————————————————————————————————

function claudeMcpJson(): string {
    return homeFile(".claude.json", "CLAUDE_CONFIG_DIR_HINT");
}

function claudeInstall(): string {
    const root = selfPackageRoot();
    try {
        execFileSync("claude", ["mcp", "add", "bili", "--scope", "user", "--", process.execPath, path.join(root, "dist", "mcp.js")], { stdio: ["ignore", "pipe", "pipe"] });
        return `claude: installed via \`claude mcp add\` (user scope) -> ${claudeMcpJson()}`;
    } catch (err) {
        const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr?: Buffer | string }).stderr ?? "") : "";
        return `claude: FAILED (${stderr.trim() || (err instanceof Error ? err.message : String(err))}) — is the claude CLI on PATH?`;
    }
}

function claudeRemove(): string {
    try {
        execFileSync("claude", ["mcp", "remove", "bili", "--scope", "user"], { stdio: ["ignore", "pipe", "pipe"] });
        return "claude: removed";
    } catch (err) {
        return `claude: FAILED (${err instanceof Error ? err.message : String(err)})`;
    }
}

function claudeStatus(): string {
    const data = readJson(claudeMcpJson()) as { mcpServers?: Record<string, unknown> };
    return data.mcpServers && "bili" in data.mcpServers ? "installed" : "not installed";
}

// — codex ——————————————————————————————————————————————————————————————

function codexToml(): string {
    return homeFile(".codex/config.toml", "CODEX_HOME_HINT");
}

function codexBlock(): string {
    return `\n[mcp_servers.bili]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(selfPackageRoot(), "dist", "mcp.js"))}]\n`;
}

function codexInstall(): string {
    const file = codexToml();
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text.includes("[mcp_servers.bili]")) return `codex: already installed (${file})`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    fs.writeFileSync(file, text + (text.endsWith("\n") || text.length === 0 ? "" : "\n") + codexBlock());
    return `codex: installed -> ${file} [mcp_servers.bili]`;
}

function codexRemove(): string {
    const file = codexToml();
    if (!fs.existsSync(file)) return `codex: not installed (${file})`;
    const text = fs.readFileSync(file, "utf8");
    const idx = text.indexOf("\n[mcp_servers.bili]\n");
    if (idx < 0) return `codex: not installed (${file})`;
    const after = text.slice(idx + 1);
    const nextTable = after.slice(1).search(/^\[/m);
    const end = nextTable >= 0 ? idx + 1 + 1 + nextTable : text.length;
    const cleaned = text.slice(0, idx) + text.slice(end);
    backupOnce(file);
    fs.writeFileSync(file, cleaned);
    return `codex: removed from ${file}`;
}

function codexStatus(): string {
    const text = fs.existsSync(codexToml()) ? fs.readFileSync(codexToml(), "utf8") : "";
    return text.includes("[mcp_servers.bili]") ? "installed" : "not installed";
}

// — opencode ————————————————————————————————————————————————————————————

function opencodeJson(): string {
    return homeFile(".config/opencode/opencode.json", "OPENCODE_CONFIG_HINT");
}

function opencodeInstall(): string {
    const file = opencodeJson();
    const data = readJson(file);
    const mcp = (data.mcp as Record<string, unknown> | undefined) ?? {};
    if ("bili" in mcp) return `opencode: already installed (${file})`;
    mcp.bili = { type: "local", command: [process.execPath, path.join(selfPackageRoot(), "dist", "mcp.js")], enabled: true };
    data.mcp = mcp;
    writeJson(file, data);
    return `opencode: installed -> ${file} mcp.bili`;
}

function opencodeRemove(): string {
    const file = opencodeJson();
    const data = readJson(file);
    const mcp = data.mcp as Record<string, unknown> | undefined;
    if (!mcp || !("bili" in mcp)) return `opencode: not installed (${file})`;
    delete mcp.bili;
    if (Object.keys(mcp).length === 0) delete data.mcp;
    writeJson(file, data);
    return `opencode: removed from ${file}`;
}

function opencodeStatus(): string {
    const mcp = readJson(opencodeJson()).mcp as Record<string, unknown> | undefined;
    return mcp && "bili" in mcp ? "installed" : "not installed";
}

// — dispatch ————————————————————————————————————————————————————————————

export function isPluginAgent(value: string): value is PluginAgent {
    return (PLUGIN_AGENTS as readonly string[]).includes(value);
}

export function pluginInstall(agent: PluginAgent): string {
    return agent === "pi" ? piInstall() : agent === "omp" ? ompInstall() : agent === "claude" ? claudeInstall() : agent === "codex" ? codexInstall() : opencodeInstall();
}

export function pluginRemove(agent: PluginAgent): string {
    return agent === "pi" ? piRemove() : agent === "omp" ? ompRemove() : agent === "claude" ? claudeRemove() : agent === "codex" ? codexRemove() : opencodeRemove();
}

export function pluginStatusAll(): Array<{ agent: string; status: string }> {
    return [
        { agent: "pi", status: piStatus() },
        { agent: "omp", status: ompStatus() },
        { agent: "claude", status: claudeStatus() },
        { agent: "codex", status: codexStatus() },
        { agent: "opencode", status: opencodeStatus() },
    ];
}
