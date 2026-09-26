// #1206: third-party compression plugin detection.
//
// Two compressors on one conversation double-compress: message refs get
// re-anchored against rewritten history, summaries cite deleted content, and
// the client's view silently scrambles. The installer swaps out bili's own
// sibling extensions (opencode-acp / billion-context-pi), but a user can
// always install OTHER third-party context-compression plugins alongside
// bili — nothing detects that today. This module scans the client's plugin
// registry (best-effort, read-only, cached) for:
//   1. known conflicting entries (bili's siblings, when not absorbed by design);
//   2. suspected compression plugins by name keyword (compress*/compact*/acp/
//      summar*/context) — flagged for user confirmation, never auto-fixed.
// Callers: launcher pre-launch warning, proxy first-request-per-session
// (recorded into the session conflict ledger), acp_status / web UI surfacing.
// Every fs access is individually guarded — a scan must NEVER fail a request
// or a launch.

import fs from "node:fs";
import path from "node:path";
import {
    OPENCODE_CONFIG_FILES,
    parseConfigText,
    readOpencodeConfigRoot,
    resolveHermesHome,
    resolveKimiHome,
    resolveOmpHome,
    resolvePiHome,
} from "./client-config.js";
import { isLegacyBcpEntry } from "./agent/native-bootstrap.js";
import { isCodexClient } from "./codex-compact.js";
import { dshProfileDirs } from "./dsh-channel.js";

export type ScanClient = "opencode" | "pi" | "omp" | "kimi" | "hermes" | "dsh" | "claude";

export interface ThirdPartyFinding {
    client: ScanClient;
    entry: string;
    source: string;
    match: "known" | "keyword";
    knownId?: string;
}

export interface ScanResult {
    client: string;
    findings: ThirdPartyFinding[];
    sourcesScanned: number;
}

/** #920: opencode-acp co-resident with bili's OWN opencode native/launcher
 *  mode is absorbed by design (legacy sessions keep their compression
 *  carrier) — it is NOT a conflict there. Everywhere else (wire mode, other
 *  clients) the same entry warns like any known conflict. */
export function isDesignAbsorbed(finding: ThirdPartyFinding, pluginAgent: string | undefined): boolean {
    return finding.client === "opencode" && finding.knownId === "opencode-acp" && pluginAgent === "opencode";
}

export const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

// Full-word tokens only: \bcontext\b deliberately does NOT match "context7"
// (a docs plugin), while hyphenated names ("context-compressor") do match.
const KEYWORD_RE = /\b(compress\w*|compact\w*|acp|summar\w*|context)\b/i;

const cache = new Map<string, { at: number; result: ScanResult }>();

export function clearScanCache(): void {
    cache.clear();
}

export function conflictScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env.BILI_CONFLICT_SCAN?.trim().toLowerCase();
    return !(v === "0" || v === "false");
}

/** Identify the requesting client from wire headers so a standalone proxy
 *  (no x-bili-plugin header) can still scan the right registry. Codex is
 *  recognized but returns undefined — it has no scannable plugin registry
 *  here, and its compaction paths are already intercepted/budget-aligned. */
export function sniffScanClient(headers: Record<string, string | string[] | undefined>): ScanClient | undefined {
    const h = (name: string): string | undefined => {
        const v = headers[name];
        return Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined;
    };
    if (h("x-claude-code-session-id")) return "claude";
    const ua = h("user-agent");
    if (ua && isCodexClient({ "user-agent": ua })) return undefined;
    if (h("x-opencode-session")) return "opencode";
    const affinity = h("x-session-affinity");
    if (affinity?.startsWith("ses_")) return "opencode";
    return undefined;
}

function empty(client: string): ScanResult {
    return { client, findings: [], sourcesScanned: 0 };
}

interface Collector {
    findings: ThirdPartyFinding[];
    sources: number;
    seen: Set<string>;
}

function add(c: Collector, f: ThirdPartyFinding): void {
    const key = `${f.entry}\u0000${f.source}`;
    if (c.seen.has(key)) return;
    c.seen.add(key);
    c.findings.push(f);
}

/** The name part of an npm specifier or file path, version stripped. */
function entryName(entry: string): string {
    let s = entry.trim();
    s = s.replace(/^npm:/, "");
    if (s.startsWith("@")) {
        const at = s.indexOf("@", 1);
        if (at !== -1) s = s.slice(0, at);
    } else {
        const at = s.indexOf("@");
        if (at !== -1) s = s.slice(0, at);
    }
    const base = s.split(/[\\/]/).pop() ?? s;
    return base.replace(/\.(js|ts|mjs|cjs|json)$/i, "");
}

function isBiliSelf(entry: string): boolean {
    const name = entryName(entry);
    if (name === "billion-context") return true;
    return /[/\\]billion-context([/\\]|$)/.test(entry.trim());
}

function classifyOpencodeEntry(c: Collector, entry: string, source: string): void {
    if (isBiliSelf(entry)) return;
    const trimmed = entry.trim();
    if (/^opencode-acp(@|$)/.test(trimmed) || /[/\\]opencode-acp([/\\]|$)/.test(trimmed)) {
        add(c, { client: "opencode", entry, source, match: "known", knownId: "opencode-acp" });
        return;
    }
    if (KEYWORD_RE.test(entryName(entry))) {
        add(c, { client: "opencode", entry, source, match: "keyword" });
    }
}

function opencodePluginEntries(root: Record<string, unknown> | undefined, source: string, c: Collector): void {
    const arr = root?.plugin;
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
        if (typeof item === "string" && item !== "") classifyOpencodeEntry(c, item, source);
        else if (item && typeof item === "object") {
            const name = (item as { name?: unknown }).name;
            if (typeof name === "string" && name !== "") classifyOpencodeEntry(c, name, source);
        }
    }
}

function scanOpencode(env: NodeJS.ProcessEnv, cwd: string): ScanResult {
    const c: Collector = { findings: [], sources: 0, seen: new Set() };
    try {
        const root = readOpencodeConfigRoot(env);
        if (root) {
            opencodePluginEntries(root, "global config", c);
            c.sources += 1;
        }
    } catch { /* unreadable global config: skip */ }
    try {
        const start = path.resolve(cwd);
        let gitRoot: string | undefined;
        let cur = start;
        for (;;) {
            if (fs.existsSync(path.join(cur, ".git"))) { gitRoot = cur; break; }
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
        // Ancestor configs are only meaningful inside a repo: without a .git
        // anchor scanning would climb to the fs root and read unrelated trees.
        const dirs: string[] = [];
        cur = start;
        for (;;) {
            dirs.push(cur);
            if (gitRoot === undefined || cur === gitRoot) break;
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
        for (const dir of dirs) {
            for (const file of [...OPENCODE_CONFIG_FILES, ...OPENCODE_CONFIG_FILES.map((f) => `.opencode/${f}`)]) {
                const full = path.join(dir, file);
                let text: string;
                try {
                    text = fs.readFileSync(full, "utf8");
                } catch { continue; }
                const parsed = parseConfigText(text);
                if (!parsed) continue;
                opencodePluginEntries(parsed, full, c);
                c.sources += 1;
            }
        }
    } catch { /* project walk failure: skip */ }
    return { client: "opencode", findings: c.findings, sourcesScanned: c.sources };
}

function scanPi(env: NodeJS.ProcessEnv, cwd: string): ScanResult {
    const c: Collector = { findings: [], sources: 0, seen: new Set() };
    const files = [path.join(resolvePiHome(env), "settings.json"), path.join(path.resolve(cwd), ".pi", "settings.json")];
    for (const file of files) {
        let obj: Record<string, unknown> | null;
        try {
            obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        } catch { continue; }
        if (!obj || typeof obj !== "object") continue;
        const packages = obj.packages;
        if (!Array.isArray(packages)) continue;
        c.sources += 1;
        for (const p of packages) {
            if (typeof p !== "string" || p === "") continue;
            if (isBiliSelf(p)) continue;
            if (isLegacyBcpEntry(p)) {
                add(c, { client: "pi", entry: p, source: file, match: "known", knownId: "billion-context-pi" });
                continue;
            }
            if (KEYWORD_RE.test(entryName(p))) add(c, { client: "pi", entry: p, source: file, match: "keyword" });
        }
    }
    return { client: "pi", findings: c.findings, sourcesScanned: c.sources };
}

function scanOmp(env: NodeJS.ProcessEnv): ScanResult {
    const c: Collector = { findings: [], sources: 0, seen: new Set() };
    const file = path.join(resolveOmpHome(env), "config.yml");
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return { client: "omp", findings: [], sourcesScanned: 0 };
    }
    c.sources += 1;
    // Block-style items only: an inline flow-style `extensions: [a, b]` line
    // is not parsed (best-effort by design — the writer emits block style).
    const lines = text.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
        if (/^extensions:(\s+(#.*)?)?$/.test(line)) { inBlock = true; continue; }
        if (inBlock) {
            const item = /^\s+-\s+(.*)$/.exec(line);
            if (item) {
                const entry = item[1]!.trim().replace(/^["']|["']$/g, "");
                if (!entry || isBiliSelf(entry)) continue;
                if (KEYWORD_RE.test(entryName(entry))) add(c, { client: "omp", entry, source: file, match: "keyword" });
                continue;
            }
            if (/^\S/.test(line)) inBlock = false;
        }
    }
    return { client: "omp", findings: c.findings, sourcesScanned: c.sources };
}

function scanKimi(env: NodeJS.ProcessEnv): ScanResult {
    const c: Collector = { findings: [], sources: 0, seen: new Set() };
    const pluginsDir = path.join(resolveKimiHome(env), "plugins");
    const registry = path.join(pluginsDir, "installed.json");
    let ids: string[] = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(registry, "utf8")) as { plugins?: Array<{ id?: unknown }> };
        if (Array.isArray(parsed.plugins)) {
            ids = parsed.plugins.map((p) => (typeof p.id === "string" ? p.id : "")).filter((s) => s !== "");
            c.sources += 1;
        }
    } catch { /* no registry: fall back to dir listing below */ }
    if (ids.length === 0) {
        try {
            ids = fs.readdirSync(pluginsDir, { withFileTypes: true })
                .filter((e) => e.isDirectory() && e.name !== "managed" && e.name !== "node_modules")
                .map((e) => e.name);
            c.sources += 1;
        } catch { /* no plugins dir at all */ }
    }
    for (const id of ids) {
        if (id === "billion-context") continue;
        if (KEYWORD_RE.test(id)) add(c, { client: "kimi", entry: id, source: registry, match: "keyword" });
    }
    return { client: "kimi", findings: c.findings, sourcesScanned: c.sources };
}

function scanHermes(env: NodeJS.ProcessEnv): ScanResult {
    const c: Collector = { findings: [], sources: 0, seen: new Set() };
    const pluginsDir = path.join(resolveHermesHome(env), "plugins");
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
        return { client: "hermes", findings: [], sourcesScanned: 0 };
    }
    c.sources += 1;
    // Dir name only: matching plugin.yaml full text false-positives on any
    // description mentioning "context"/"summarize".
    for (const e of entries) {
        if (!e.isDirectory() || e.name === "billion-context") continue;
        if (KEYWORD_RE.test(e.name)) add(c, { client: "hermes", entry: e.name, source: path.join(pluginsDir, e.name), match: "keyword" });
    }
    return { client: "hermes", findings: c.findings, sourcesScanned: c.sources };
}

function scanDsh(env: NodeJS.ProcessEnv): ScanResult {
    const c: Collector = { findings: [], sources: 0, seen: new Set() };
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return { client: "dsh", findings: [], sourcesScanned: 0 };
    }
    for (const dir of dirs) {
        const file = path.join(dir, "package.json");
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        } catch { continue; }
        c.sources += 1;
        for (const key of ["dependencies", "devDependencies"]) {
            const deps = obj[key];
            if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
            for (const dep of Object.keys(deps as Record<string, unknown>)) {
                if (dep === "billion-context") continue;
                if (KEYWORD_RE.test(dep)) add(c, { client: "dsh", entry: dep, source: file, match: "keyword" });
            }
        }
    }
    return { client: "dsh", findings: c.findings, sourcesScanned: c.sources };
}

function claudeSettingsFiles(env: NodeJS.ProcessEnv, cwd: string): string[] {
    const home = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? env.USERPROFILE ?? ".", ".claude");
    return [path.join(home, "settings.json"), path.join(path.resolve(cwd), ".claude", "settings.json")];
}

function scanClaude(env: NodeJS.ProcessEnv, cwd: string): ScanResult {
    const c: Collector = { findings: [], sources: 0, seen: new Set() };
    for (const file of claudeSettingsFiles(env, cwd)) {
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        } catch { continue; }
        if (!obj || typeof obj !== "object") continue;
        c.sources += 1;
        const enabled = obj.enabledPlugins;
        if (enabled && typeof enabled === "object" && !Array.isArray(enabled)) {
            for (const name of Object.keys(enabled as Record<string, unknown>)) {
                if (KEYWORD_RE.test(name)) add(c, { client: "claude", entry: name, source: file, match: "keyword" });
            }
        }
        const plugins = obj.plugins;
        if (Array.isArray(plugins)) {
            for (const p of plugins) {
                if (typeof p === "string" && p !== "" && KEYWORD_RE.test(p)) add(c, { client: "claude", entry: p, source: file, match: "keyword" });
            }
        }
    }
    try {
        const dir = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? env.USERPROFILE ?? ".", ".claude"), "plugins");
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (KEYWORD_RE.test(e.name)) add(c, { client: "claude", entry: e.name, source: path.join(dir, e.name), match: "keyword" });
        }
    } catch { /* no plugins dir */ }
    return { client: "claude", findings: c.findings, sourcesScanned: c.sources };
}

/** Best-effort scan of one client's plugin registry. Never throws; unknown
 *  clients yield an empty result. Results are cached per client+cwd for
 *  SCAN_CACHE_TTL_MS (configs rarely change mid-run; re-scans stay cheap). */
export function scanClientPlugins(client: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ScanResult {
    const env = opts.env ?? process.env;
    const cwd = opts.cwd ?? process.cwd();
    const key = `${client}\u0000${cwd}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < SCAN_CACHE_TTL_MS) return hit.result;
    let result: ScanResult;
    switch (client) {
        case "opencode": result = scanOpencode(env, cwd); break;
        case "pi": result = scanPi(env, cwd); break;
        case "omp": result = scanOmp(env); break;
        case "kimi": result = scanKimi(env); break;
        case "hermes": result = scanHermes(env); break;
        case "dsh": result = scanDsh(env); break;
        case "claude": result = scanClaude(env, cwd); break;
        default: result = empty(client); break;
    }
    cache.set(key, { at: Date.now(), result });
    return result;
}
