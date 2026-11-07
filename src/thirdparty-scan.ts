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
//      summar*) — flagged for user confirmation, never auto-fixed.
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

type ScanClient = "opencode" | "pi" | "omp" | "kimi" | "hermes" | "dsh" | "claude";

export interface ThirdPartyFinding {
    client: ScanClient;
    entry: string;
    source: string;
    match: "known" | "keyword";
    knownId?: string;
}

interface ScanResult {
    client: string;
    findings: ThirdPartyFinding[];
    sourcesScanned: number;
}

/** #920/#2045: a finding naming one of bili's OWN sibling compressors is
 *  benign by design when bili's own entry for THAT client drives the session —
 *  the sibling either is absorbed into bili's pipeline (opencode-acp, #920) or
 *  stands down because bili owns the process/traffic (billion-context-pi via
 *  BILLION_CONTEXT_NATIVE / BILLION_CONTEXT_PROXY). No double-compression can
 *  happen there, so no conflict alert (#2045: these auto-disable — no web
 *  popup needed). Everywhere else (wire/plain-proxy mode, other clients) the
 *  same entry IS a real conflict and still warns like any known finding. */
export function isDesignBenign(finding: ThirdPartyFinding, pluginAgent: string | undefined): boolean {
    if (finding.match !== "known") return false;
    if (finding.client === "opencode" && finding.knownId === "opencode-acp") return pluginAgent === "opencode";
    if (finding.client === "pi" && finding.knownId === "billion-context-pi") return pluginAgent === "pi";
    return false;
}

/** #2261/#2545: parse a recorded third-party-plugin conflict detail back into
 *  its identity parts so display surfaces can classify what the record actually
 *  names. Detail shape (single producer, server.ts scan site):
 *  "<client>: <entry> (<source>)[ [suspected]]". Classifying at display time
 *  (not record time) also covers stock ledgers written by older versions before
 *  any of these tags existed. Non-plugin detail shapes (unannounced-rewrite /
 *  orphan-reap / native-compaction) never match. */
interface ParsedPluginConflictDetail {
    client: string;
    entry: string;
    source: string;
    suspected: boolean;
}

export function parsePluginConflictDetail(detail: string): ParsedPluginConflictDetail | undefined {
    const m = /^(\S+): (.+) \((.+)\)( \[suspected\])?$/.exec(detail.trim());
    if (!m) return undefined;
    return { client: m[1]!, entry: m[2]!, source: m[3]!, suspected: m[4] !== undefined };
}

/** #2261: true when the recorded detail names bili's OWN sibling extension
 *  (billion-context-pi / opencode-acp) — first-party family that stands down
 *  while bili drives the session (#820/#920), never a foreign-compressor alarm. */
export function isSiblingConflictDetail(detail: string): boolean {
    const p = parsePluginConflictDetail(detail);
    if (!p) return false;
    return isLegacyBcpEntry(p.entry) || isOpencodeAcpEntry(p.entry);
}

/** #2545/#2969: true when the recorded detail names a VERIFIED non-compressing
 *  plugin from KNOWN_NON_COMPRESSORS. Such records were only ever written as
 *  [suspected] by the keyword rules (pre-#1736 matched bare "context"; the
 *  ecosystem-marker rule misfires on "acp" naming Agent Client Protocol), and
 *  must count for NO conflict severity on any display surface — the plugin
 *  does not compress. */
export function isDisplayOnlyConflictDetail(detail: string): boolean {
    const p = parsePluginConflictDetail(detail);
    if (!p) return false;
    return isKnownDisplayOnlyPlugin(p.entry);
}

const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

// Compression-ACTION tokens only. Bare "context" is deliberately EXCLUDED
// (#1736): it names the domain (context management), not the act of
// compressing — read-only tools like "dsh-context" (Context Dashboard) or
// "context-viewer"/"context-memory" share the domain without compressing and
// flooded the suspected tier with false positives. A real compressor carries
// an action token (compress*/compact*/summar*) or the ecosystem marker "acp".
// \b keeps embedded words ("context7", a docs plugin) from matching. Verified
// non-compressors whose names collide with these tokens are exempted below in
// KNOWN_NON_COMPRESSORS (#2324/#2545/#2969).
const KEYWORD_RE = /\b(compress\w*|compact\w*|acp|summar\w*)\b/i;

const cache = new Map<string, { at: number; result: ScanResult }>();

export function clearScanCache(): void {
    cache.clear();
}

export function conflictScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env.BILI_CONFLICT_SCAN?.trim().toLowerCase();
    return !(v === "0" || v === "false");
}

/** #4688: Google Antigravity IDE wire profile — UA shape observed in the wild
 *  (v2.26.0, Windows session through bili): "antigravity/hub/<ver> (aidev_client; …)".
 *  Prefix-anchored and case-insensitive, mirroring isCodexClient's prefix style;
 *  deliberately NOT a bare-token match — a UA merely mentioning antigravity
 *  elsewhere must not inherit this lane's identity. */
export function isAntigravityClient(headers: Record<string, string | string[] | undefined>): boolean {
    const ua = headers["user-agent"];
    if (!ua) return false;
    const s = Array.isArray(ua) ? ua[0] : ua;
    if (typeof s !== "string") return false;
    return /^antigravity\//i.test(s);
}

/** Identify the requesting client from wire headers so a standalone proxy
 *  (no x-bili-plugin header) can still scan the right registry. Codex and
 *  Antigravity are recognized but return undefined — closed binaries with no
 *  scannable plugin registry (#1043); their identity resolves on the conflict
 *  surfaces via conflictClientOf instead (#2219/#4688). */
export function sniffScanClient(headers: Record<string, string | string[] | undefined>): ScanClient | undefined {
    const h = (name: string): string | undefined => {
        const v = headers[name];
        return Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined;
    };
    if (h("x-claude-code-session-id")) return "claude";
    const ua = h("user-agent");
    if (ua && isCodexClient({ "user-agent": ua })) return undefined;
    if (ua && isAntigravityClient({ "user-agent": ua })) return undefined;
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

/** #2261: opencode-acp entry identity — bare name, npm spec (with or without
 *  version), or any path whose segments contain opencode-acp. Shared by the
 *  scanner and the conflict-display sibling classifier so the two can never
 *  drift apart. */
export function isOpencodeAcpEntry(entry: string): boolean {
    const trimmed = entry.trim();
    const bare = trimmed.replace(/^npm:/, "");
    return bare === "opencode-acp" || /^opencode-acp@/.test(bare) || /(^|[/\\])opencode-acp([/\\]|$)/.test(trimmed);
}

// #2324/#2545/#2969: third-party plugins VERIFIED to never compress the model
// context — so their names must not raise a compression-conflict alarm. Two
// evidence classes: read-only display/viewer plugins, and protocol adapters
// whose keyword hit is a pure name collision ("acp" = Agent Client Protocol,
// not the acp-kernel ecosystem marker). Matched as an EXACT token — bare name,
// npm spec (with or without version), or a bounded path segment — mirroring
// isOpencodeAcpEntry's discipline so the two can't drift. Deliberately NOT a
// substring rule: a real compressor ("context-compactor") or a lookalike
// ("my-pi-compact-transcript-fork") must still flag. Evidence-backed, one entry at a time.
const KNOWN_NON_COMPRESSORS = new Set<string>([
    // pi terminal extension: folds tool output / re-lays AssistantMessage rendering,
    // registers display toggles; README states "changes display only" — no context
    // replacement or compression handler (#2324).
    "pi-compact-transcript",
    // pi context viewer: read-only /context overlay showing tokens, system prompt,
    // tools and messages; its source registers only /context and reads context/tool
    // info — no compression or history-rewrite API (#2545). Pre-#1736 keyword rules
    // matched its name (bare "context") and wrote stock [suspected] ledger records;
    // isDisplayOnlyConflictDetail neutralizes those at display time.
    "pi-context-inspector",
    // dsh ACP protocol adapter: the "-acp" suffix names the Agent Client Protocol,
    // NOT the acp-kernel compression ecosystem — a pure keyword collision (#2969).
    // Its shipped cordis.patch.yml disables dsh native compaction features
    // (compaction-basic / command-compact / tool-result-pruner); no observed double
    // compression. Stock [suspected] records are neutralized at display time.
    "@openma/deepseek-harness-acp",
]);

export function isKnownDisplayOnlyPlugin(entry: string): boolean {
    const trimmed = entry.trim();
    const bare = trimmed.replace(/^npm:/, "");
    for (const name of KNOWN_NON_COMPRESSORS) {
        if (bare === name || bare.startsWith(name + "@")) return true;
        // Scoped names carry an inner "/" — widen it to EITHER separator so the
        // bounded path-segment match holds on Windows paths too (#2969); unscoped
        // names pass through split/join unchanged.
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split("/").join("[/\\\\]");
        if (new RegExp(`(^|[/\\\\])${esc}([/\\\\]|$)`).test(trimmed)) return true;
    }
    return false;
}

function classifyOpencodeEntry(c: Collector, entry: string, source: string): void {
    if (isBiliSelf(entry)) return;
    if (isKnownDisplayOnlyPlugin(entry)) return;
    if (isOpencodeAcpEntry(entry)) {
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
            if (isKnownDisplayOnlyPlugin(p)) continue;
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
                if (isKnownDisplayOnlyPlugin(entry)) continue;
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
        if (isKnownDisplayOnlyPlugin(id)) continue;
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
        if (isKnownDisplayOnlyPlugin(e.name)) continue;
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
                if (isKnownDisplayOnlyPlugin(dep)) continue;
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
                if (isKnownDisplayOnlyPlugin(name)) continue;
                if (KEYWORD_RE.test(name)) add(c, { client: "claude", entry: name, source: file, match: "keyword" });
            }
        }
        const plugins = obj.plugins;
        if (Array.isArray(plugins)) {
            for (const p of plugins) {
                if (typeof p !== "string" || p === "") continue;
                if (isKnownDisplayOnlyPlugin(p)) continue;
                if (KEYWORD_RE.test(p)) add(c, { client: "claude", entry: p, source: file, match: "keyword" });
            }
        }
    }
    try {
        const dir = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? env.USERPROFILE ?? ".", ".claude"), "plugins");
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (isKnownDisplayOnlyPlugin(e.name)) continue;
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
