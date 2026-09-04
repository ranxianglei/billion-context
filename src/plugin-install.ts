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
// Installers throw on failure (bad/locked config, missing host CLI); the CLI
// layer catches, prints `bili plugin: <msg>` and exits 1.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePiHome } from "./client-config.js";
import { DEFAULT_PROXY_ORIGIN } from "./mcp.js";

export const PLUGIN_AGENTS = ["pi", "omp", "claude", "codex", "opencode"] as const;
export type PluginAgent = (typeof PLUGIN_AGENTS)[number];

export function selfPackageRoot(): string {
    // dist/plugin-install.js -> package root two levels up.
    const here = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(here), "..");
}

/** #405 fix #4: the origin baked into host configs must be STABLE — never the
 *  ephemeral port a launcher just spawned (one install, permanent mismatch).
 *  Explicit user intent still wins (BILI_MCP_PROXY env / `bili plugin --origin`);
 *  runtime discovery of custom-port instances happens inside the MCP shell via
 *  the pointer file, not at install time. */
export function bakedProxyOrigin(): string {
    const explicit = process.env.BILI_MCP_PROXY?.trim();
    return explicit && explicit.length > 0 ? explicit : DEFAULT_PROXY_ORIGIN;
}

function homeFile(rel: string, envOverride?: string): string {
    const raw = (envOverride !== undefined ? process.env[envOverride] : undefined)?.trim();
    const base = raw && raw.length > 0 ? raw : os.homedir();
    return path.join(base, rel);
}

function backupOnce(file: string): void {
    if (fs.existsSync(file) && !fs.existsSync(`${file}.bili-bak`)) {
        fs.copyFileSync(file, `${file}.bili-bak`);
    }
}

function readJson(file: string): Record<string, unknown> {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return {};
        throw err;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it or restore ${path.basename(file)}.bili-bak first; refusing to overwrite`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file}: expected a JSON object at top level, refusing to overwrite`);
    }
    return parsed as Record<string, unknown>;
}

function writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function requireDistFile(file: string): void {
    if (!fs.existsSync(file)) {
        process.stderr.write(`bili plugin: warning: ${file} does not exist yet (run \`npm run build\` in ${selfPackageRoot()}) — the entry will be dead until built\n`);
    }
}

// — pi ————————————————————————————————————————————————————————————————

function piSettingsFile(): string {
    return path.join(resolvePiHome(process.env), "settings.json");
}

// A packages entry is "ours" if it points at THIS install's package root,
// any other billion-context install (npm: form, node_modules path, or a
// dev checkout dir — separators in either style for Windows), or the legacy
// billion-context-pi package (0.1.x shipped as a separate package before the
// plugin moved into billion-context itself). install() replaces every match
// so exactly one bili plugin is live after `bili plugin install pi`.
export function isPiEntry(entry: string, root: string): boolean {
    return entry === root
        || /^npm:billion-context(-pi)?(@|$)/.test(entry)
        || /(^|[/\\])node_modules[/\\]billion-context(-pi)?([\/\\]|$)/.test(entry)
        || /(^|[/\\])billion-context(-pi)?$/.test(entry);
}

// Entries that load THIS package's pi plugin (billion-context proper).
// Legacy `billion-context-pi` entries are deliberately excluded: that is a
// separate older package — usually not installed, and it self-disables under
// BILLION_CONTEXT_PROXY — so treating it as "installed" wrongly suppressed
// the launcher's `-e` fallback and left pi with no plugin at all.
export function isBiliPiEntry(entry: string, root: string): boolean {
    return entry === root
        || /^npm:billion-context(@|$)/.test(entry)
        || /(^|[/\\])node_modules[/\\]billion-context([\/\\]|$)/.test(entry)
        || /(^|[/\\])billion-context$/.test(entry);
}

function piInstall(): string {
    const root = selfPackageRoot();
    const file = piSettingsFile();
    const settings = readJson(file);
    const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]).map(String) : [];
    if (packages.some((p) => p === root)) return `pi: already installed (${file})`;
    const kept = packages.filter((p) => !isPiEntry(p, root));
    kept.push(root);
    settings.packages = kept;
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
    return list.some((p) => p === root) ? "installed" : "not installed";
}

// — omp ———————————————————————————————————————————————————————————————

function ompConfigFile(): string {
    const raw = process.env.PI_CODING_AGENT_DIR?.trim();
    if (raw && raw.length > 0) return path.join(raw, "config.yml");
    return path.join(os.homedir(), ".omp", "agent", "config.yml");
}

function ompExtensionPath(): string {
    return path.join(selfPackageRoot(), "dist", "agent", "omp.js");
}

function ompEntryValue(line: string): string {
    return line.replace(/#.*$/, "").trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "").trim();
}

function ompRemove(): string {
    const file = ompConfigFile();
    const entry = ompExtensionPath();
    if (!fs.existsSync(file)) return `omp: not installed (${file})`;
    const text = fs.readFileSync(file, "utf8");
    const cleaned = text
        .split("\n")
        .filter((line) => ompEntryValue(line) !== entry)
        .join("\n");
    if (cleaned === text) return `omp: not installed (${file})`;
    backupOnce(file);
    fs.writeFileSync(file, cleaned);
    return `omp: removed from ${file}`;
}

function ompInstall(): string {
    const file = ompConfigFile();
    const entry = ompExtensionPath();
    requireDistFile(entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text.split("\n").some((line) => ompEntryValue(line) === entry)) return `omp: already installed (${file})`;
    const keyCount = (text.match(/^extensions:/gm) ?? []).length;
    if (keyCount > 1) throw new Error(`${file}: multiple \`extensions:\` keys — fix the file first, refusing to edit`);
    if (/^extensions:\s*\S/m.test(text) && !/^extensions:\s*$/m.test(text)) {
        throw new Error(`${file}: \`extensions:\` uses flow style or an inline value; convert it to a block list first, refusing to edit`);
    }
    let out: string;
    const extMatch = /^extensions:\s*$/m.exec(text);
    if (extMatch !== null) {
        const afterKey = text.indexOf("\n", extMatch.index);
        const rest = afterKey < 0 ? "" : text.slice(afterKey + 1);
        const firstNonList = rest.search(/^(?!\s*-\s)\S/m);
        const existingIndent = /^(\s*)-\s\S/m.exec(rest)?.[1] ?? "  ";
        let head: string;
        let tail: string;
        if (firstNonList >= 0) {
            head = text.slice(0, afterKey + 1 + firstNonList);
            tail = text.slice(afterKey + 1 + firstNonList);
        } else {
            head = text.length === 0 || text.endsWith("\n") ? text : text + "\n";
            tail = "";
        }
        out = `${head}${existingIndent}- ${entry}\n${tail}`;
    } else {
        out = text.endsWith("\n") || text.length === 0 ? text : text + "\n";
        out += `extensions:\n  - ${entry}\n`;
    }
    const occurrences = out.split("\n").filter((line) => ompEntryValue(line) === entry).length;
    if (occurrences !== 1) {
        throw new Error(`${file}: edit would leave ${occurrences} copies of the entry — aborting without writing`);
    }
    backupOnce(file);
    fs.writeFileSync(file, out);
    return `omp: installed -> ${file} extensions += ${entry}`;
}

function ompStatus(): string {
    const file = ompConfigFile();
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return text.split("\n").some((line) => ompEntryValue(line) === ompExtensionPath()) ? "installed" : "not installed";
}

/** True when the given omp home's config.yml carries a bili plugin entry
 *  whose target file still exists on disk. The launcher uses this to decide
 *  whether `-e dist/agent/omp.js` is needed (omp does NOT ship the plugin):
 *  a loadable entry means omp already loads it — adding `-e` too would
 *  double-register the same tools/commands. Entries pointing at stale
 *  install paths (file gone) don't count: omp fails to load those, so the
 *  launcher must supply the working plugin itself. */
export function ompPluginLoadedFrom(ompHome: string): boolean {
    try {
        const text = fs.readFileSync(path.join(ompHome, "config.yml"), "utf8");
        return text.split("\n").some((line) => {
            const v = ompEntryValue(line);
            return /[\\/]dist[\\/]agent[\\/]omp\.js$/.test(v) && fs.existsSync(v);
        });
    } catch {
        return false;
    }
}

// — claude —————————————————————————————————————————————————————————————

const CLAUDE_EXEC_TIMEOUT_MS = 15000;

function claudeMcpJson(): string {
    return homeFile(".claude.json", "CLAUDE_CONFIG_DIR");
}

// CLAUDE overrides the claude binary path (absolute path for sandboxed
// setups; a guaranteed-missing file in tests so the failure path stays
// deterministic even on machines that have the real CLI).
function claudeInstall(): string {
    const root = selfPackageRoot();
    const mcpJs = path.join(root, "dist", "mcp.js");
    requireDistFile(mcpJs);
    const claude = process.env.CLAUDE?.trim() || "claude";
    try {
        execFileSync(claude, ["mcp", "add", "bili", "--scope", "user", "-e", `BILI_MCP_PROXY=${bakedProxyOrigin()}`, "--", process.execPath, mcpJs], { stdio: ["ignore", "pipe", "pipe"], timeout: CLAUDE_EXEC_TIMEOUT_MS });
        return `claude: installed via \`claude mcp add\` (user scope) -> ${claudeMcpJson()}`;
    } catch (err) {
        const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr?: Buffer | string }).stderr ?? "") : "";
        throw new Error(`claude: install failed (${stderr.trim() || (err instanceof Error ? err.message : String(err))}) — is the claude CLI on PATH?`);
    }
}

function claudeRemove(): string {
    if (claudeStatus() === "not installed") return `claude: not installed (${claudeMcpJson()})`;
    const claude = process.env.CLAUDE?.trim() || "claude";
    try {
        execFileSync(claude, ["mcp", "remove", "bili", "--scope", "user"], { stdio: ["ignore", "pipe", "pipe"], timeout: CLAUDE_EXEC_TIMEOUT_MS });
        return "claude: removed";
    } catch (err) {
        throw new Error(`claude: remove failed (${err instanceof Error ? err.message : String(err)})`);
    }
}

function claudeStatus(): string {
    const data = readJson(claudeMcpJson()) as { mcpServers?: Record<string, unknown> };
    return data.mcpServers && "bili" in data.mcpServers ? "installed" : "not installed";
}

// — codex ——————————————————————————————————————————————————————————————

function codexToml(): string {
    const raw = process.env.CODEX_HOME?.trim();
    if (raw && raw.length > 0) return path.join(raw, "config.toml");
    return homeFile(".codex/config.toml");
}

function codexBlock(): string {
    return `\n[mcp_servers.bili]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(selfPackageRoot(), "dist", "mcp.js"))}]\nenv = { BILI_MCP_PROXY = ${JSON.stringify(bakedProxyOrigin())} }\n`;
}

function codexInstall(): string {
    const file = codexToml();
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const existing = /^[ \t]*\[mcp_servers\.bili\][ \t]*$/m.exec(text);
    if (existing !== null) {
        const block = text.slice(existing.index, text.indexOf("\n[", existing.index + 1) === -1 ? undefined : text.indexOf("\n[", existing.index + 1));
        if (block.includes(`BILI_MCP_PROXY = ${JSON.stringify(bakedProxyOrigin())}`)) return `codex: already installed (${file})`;
        const refreshed = text.slice(0, existing.index) + codexBlock().replace(/^\n/, "") + text.slice(existing.index + block.length);
        backupOnce(file);
        fs.writeFileSync(file, refreshed);
        return `codex: refreshed proxy origin -> ${file} [mcp_servers.bili]`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    fs.writeFileSync(file, text + (text.endsWith("\n") || text.length === 0 ? "" : "\n") + codexBlock());
    return `codex: installed -> ${file} [mcp_servers.bili]`;
}

function codexRemove(): string {
    const file = codexToml();
    if (!fs.existsSync(file)) return `codex: not installed (${file})`;
    const text = fs.readFileSync(file, "utf8");
    const start = (() => {
        const m = /^[ \t]*\[mcp_servers\.bili\][ \t]*$/m.exec(text);
        return m === null ? -1 : m.index;
    })();
    if (start < 0) return `codex: not installed (${file})`;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const after = text.slice(start);
    const firstNewline = after.indexOf("\n");
    const nextTable = firstNewline < 0 ? -1 : after.slice(firstNewline + 1).search(/^[ \t]*\[/m);
    const end = nextTable >= 0 ? start + firstNewline + 1 + nextTable : text.length;
    const cleaned = (text.slice(0, lineStart).replace(/\n+$/, "\n") + text.slice(end)).replace(/^\n+/, "");
    backupOnce(file);
    fs.writeFileSync(file, cleaned);
    return `codex: removed from ${file}`;
}

function codexStatus(): string {
    const text = fs.existsSync(codexToml()) ? fs.readFileSync(codexToml(), "utf8") : "";
    return /^\[mcp_servers\.bili\]\s*$/m.test(text) ? "installed" : "not installed";
}

// — opencode ————————————————————————————————————————————————————————————

function opencodeJson(): string {
    const raw = process.env.OPENCODE_CONFIG?.trim();
    if (raw && raw.length > 0) return raw;
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    if (xdg && xdg.length > 0) return path.join(xdg, "opencode/opencode.json");
    return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

function opencodeInstall(): string {
    const file = opencodeJson();
    const mcpJs = path.join(selfPackageRoot(), "dist", "mcp.js");
    requireDistFile(mcpJs);
    const data = readJson(file);
    const mcp = (data.mcp as Record<string, unknown> | undefined) ?? {};
    if ("bili" in mcp) return `opencode: already installed (${file})`;
    mcp.bili = { type: "local", command: [process.execPath, mcpJs], environment: { BILI_MCP_PROXY: bakedProxyOrigin() }, enabled: true };
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
    const checks: Array<[string, () => string]> = [
        ["pi", piStatus],
        ["omp", ompStatus],
        ["claude", claudeStatus],
        ["codex", codexStatus],
        ["opencode", opencodeStatus],
    ];
    return checks.map(([agent, check]) => {
        try {
            return { agent, status: check() };
        } catch (err) {
            return { agent, status: `error: ${err instanceof Error ? err.message : String(err)}` };
        }
    });
}
