import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { clearScanCache, conflictScanEnabled, isAntigravityClient, isDesignBenign, isDisplayOnlyConflictDetail, isKnownDisplayOnlyPlugin, isOpencodeAcpEntry, isSiblingConflictDetail, parsePluginConflictDetail, scanClientPlugins, sniffScanClient, type ThirdPartyFinding } from "../src/thirdparty-scan.js";
import { CONFLICT_LEDGER_MAX, conflictEventsOf, formatConflictSection, recordConflict, summarizeConflicts } from "../src/conflict-watch.js";
import { resolveHermesHome, resolveKimiHome, resolveOmpHome, resolvePiHome } from "../src/client-config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";

// #1206: third-party compression plugin detection — scanner fixtures, cache,
// header sniffing, and the session conflict ledger.

_setStoreForTest(new SessionStore({ enabled: false }));

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function writeFile(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

// Hermetic env: pins HOME + XDG_CONFIG_HOME under root. (#2038) This alone does
// NOT pin pi/omp — those resolvers fall back to os.homedir() (the REAL process
// home) when PI_HOME / PI_CODING_AGENT_DIR are unset, so their tests supply the
// var explicitly and assertTestOwned below guards every fixture write.
function hermeticEnv(root: string): NodeJS.ProcessEnv {
    return { HOME: root, XDG_CONFIG_HOME: path.join(root, ".config") };
}

// #2038: refuse any fixture write escaping its temp root — an unresolved
// client home would otherwise target the developer's real ~/.pi / ~/.omp config.
function assertTestOwned(file: string, root: string): void {
    const rel = path.relative(root, file);
    assert.ok(!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`),
        `refusing to write outside test-owned root ${root}: ${file}`);
}

test("conflictScanEnabled defaults on, honors 0/false", () => {
    assert.equal(conflictScanEnabled({}), true);
    assert.equal(conflictScanEnabled({ BILI_CONFLICT_SCAN: "1" }), true);
    assert.equal(conflictScanEnabled({ BILI_CONFLICT_SCAN: "0" }), false);
    assert.equal(conflictScanEnabled({ BILI_CONFLICT_SCAN: "false" }), false);
});

test("sniffScanClient identifies clients from wire headers", () => {
    assert.equal(sniffScanClient({ "x-claude-code-session-id": "abc" }), "claude");
    assert.equal(sniffScanClient({ "user-agent": "codex_cli_rs/0.50.0" }), undefined);
    assert.equal(sniffScanClient({ "user-agent": "codex desktop/1.0" }), undefined);
    // antigravity: recognized but no scannable registry — same contract as codex (#4688)
    assert.equal(sniffScanClient({ "user-agent": "antigravity/hub/2.26.0 (aidev_client; os_type=windows)" }), undefined);
    assert.equal(sniffScanClient({ "x-opencode-session": "ses_123" }), "opencode");
    assert.equal(sniffScanClient({ "x-session-affinity": "ses_abc" }), "opencode");
    assert.equal(sniffScanClient({ "x-session-affinity": "not-a-session" }), undefined);
    assert.equal(sniffScanClient({}), undefined);
});

test("isAntigravityClient matches the antigravity/hub/ UA prefix only (#4688)", () => {
    assert.equal(isAntigravityClient({ "user-agent": "antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104)" }), true);
    assert.equal(isAntigravityClient({ "user-agent": "Antigravity/hub/1.0" }), true);
    assert.equal(isAntigravityClient({ "user-agent": "my-antigravity-tool/2.0" }), false);
    assert.equal(isAntigravityClient({}), false);
    assert.equal(isAntigravityClient({ "user-agent": [] }), false);
});

test("opencode scan: known conflict + keyword entries, self/context7 skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-oc-");
    const cwd = tmp("bili-1206-oc-cwd-");
    assertTestOwned(path.join(root, ".config", "opencode", "opencode.json"), root);
    writeFile(path.join(root, ".config", "opencode", "opencode.json"), JSON.stringify({
        plugin: ["opencode-acp@stable", "@scope/context-compressor", "billion-context", "context7", "context-dashboard", { name: "memory-compactor" }],
    }));
    assertTestOwned(path.join(cwd, ".opencode", "opencode.json"), cwd);
    writeFile(path.join(cwd, ".opencode", "opencode.json"), JSON.stringify({ plugin: ["compact-helper"] }));
    const res = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd });
    const names = res.findings.map((f) => f.entry);
    assert.ok(names.includes("opencode-acp@stable"), `expected opencode-acp@stable in ${names}`);
    assert.ok(names.includes("@scope/context-compressor"));
    assert.ok(names.includes("memory-compactor"));
    assert.ok(names.includes("compact-helper"), "project-layer entry must be scanned");
    assert.ok(!names.includes("billion-context"), "bili itself must be skipped");
    assert.ok(!names.some((n) => n === "context7"), "context7 must NOT be keyword-matched");
    assert.ok(!names.some((n) => n === "context-dashboard"), "bare-'context' read-only tool must NOT be flagged (#1736)");
    const known = res.findings.find((f) => f.entry === "opencode-acp@stable");
    assert.equal(known?.match, "known");
    assert.equal(known?.knownId, "opencode-acp");
    assert.ok(res.sourcesScanned >= 2);
});

test("opencode scan: no config at all yields empty result without throwing", () => {
    clearScanCache();
    const root = tmp("bili-1206-oc-empty-");
    const res = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd: root });
    assert.deepEqual(res.findings, []);
});

test("opencode scan: project walk never climbs past the git root", () => {
    const base = tmp("bili-1206-oc-repo-");
    assertTestOwned(path.join(base, "opencode.json"), base);
    writeFile(path.join(base, "opencode.json"), JSON.stringify({ plugin: ["acp-decoy"] }));
    const repo = path.join(base, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    assertTestOwned(path.join(repo, "opencode.json"), base);
    writeFile(path.join(repo, "opencode.json"), JSON.stringify({ plugin: ["acp-inner"] }));
    const deep = path.join(repo, "src", "nested");
    fs.mkdirSync(deep, { recursive: true });
    clearScanCache();
    const res = scanClientPlugins("opencode", { env: hermeticEnv(base), cwd: deep });
    const names = res.findings.map((f) => f.entry);
    assert.ok(names.includes("acp-inner"), "ancestor config up to the .git root is scanned");
    assert.ok(!names.includes("acp-decoy"), "config ABOVE the .git root must stay out of reach");
});

test("opencode scan: without a .git anchor the walk stops at cwd", () => {
    const tree = tmp("bili-1206-oc-nogit-");
    assertTestOwned(path.join(tree, "opencode.json"), tree);
    writeFile(path.join(tree, "opencode.json"), JSON.stringify({ plugin: ["acp-parent"] }));
    const child = path.join(tree, "child");
    fs.mkdirSync(child, { recursive: true });
    // $TMPDIR itself may sit inside a git worktree (workspace-embedded tmp):
    // then the anchor is that outer root, not "none". Resolve it explicitly so
    // the assertion holds in both environments.
    let gitAncestor: string | undefined;
    {
        let cur = tree;
        for (;;) {
            if (fs.existsSync(path.join(cur, ".git"))) { gitAncestor = cur; break; }
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
    }
    clearScanCache();
    const res = scanClientPlugins("opencode", { env: hermeticEnv(tree), cwd: child });
    if (gitAncestor === undefined) {
        assert.deepEqual(res.findings, [], "no .git anywhere: only cwd is scanned");
    } else {
        for (const f of res.findings) {
            assert.ok(f.source.startsWith(gitAncestor + path.sep), `source stays below the outer git root: ${f.source}`);
        }
    }
});

test("#2038: assertTestOwned allows writes under root, rejects escaping it (incl. real home)", () => {
    const root = tmp("bili-1206-2038-guard-");
    assert.doesNotThrow(() => assertTestOwned(path.join(root, ".pi", "agent", "settings.json"), root));
    // The original defect: an unresolved client home resolved to the REAL process
    // home and the fixture write clobbered the user's actual ~/.pi / ~/.omp config.
    assert.throws(() => assertTestOwned(path.join(os.homedir(), ".pi", "agent", "settings.json"), root));
    assert.throws(() => assertTestOwned("/etc/passwd", root));
});

test("pi scan: legacy bcp entry is known-conflict, keyword entries flagged, bili-self skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-pi-");
    const cwd = tmp("bili-1206-pi-cwd-");
    // #2038: pin pi's home under root via PI_HOME (a bare hermetic env would let
    // resolvePiHome fall back to os.homedir() and target the real ~/.pi).
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), PI_HOME: path.join(root, ".pi", "agent") };
    const home = resolvePiHome(env);
    assertTestOwned(path.join(home, "settings.json"), root);
    writeFile(path.join(home, "settings.json"), JSON.stringify({
        packages: ["npm:billion-context-pi", "npm:context-compactor", "npm:context-forge", "/u/node_modules/billion-context/dist/agent/pi.js"],
    }));
    const res = scanClientPlugins("pi", { env, cwd });
    const bcp = res.findings.find((f) => f.entry === "npm:billion-context-pi");
    assert.equal(bcp?.match, "known");
    assert.equal(bcp?.knownId, "billion-context-pi");
    assert.ok(res.findings.some((f) => f.entry === "npm:context-compactor" && f.match === "keyword"), "action-token name still flagged");
    assert.ok(!res.findings.some((f) => f.entry === "npm:context-forge"), "bare-'context' tool must NOT be flagged (#1736)");
    assert.ok(!res.findings.some((f) => f.entry.includes("dist/agent/pi.js")), "bili's own extension path must be skipped");
});

test("pi scan: verified display-only plugin excluded by resolved package name, real compressors still flagged (#2324)", () => {
    clearScanCache();
    const root = tmp("bili-2324-pi-");
    const cwd = tmp("bili-2324-pi-cwd-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), PI_HOME: path.join(root, ".pi", "agent") };
    const home = resolvePiHome(env);
    assertTestOwned(path.join(home, "settings.json"), root);
    // bare + versioned npm spec of the same display-only plugin, plus a REAL compressor
    // that shares no name with the allowlist entry — must stay flagged.
    writeFile(path.join(home, "settings.json"), JSON.stringify({
        packages: ["npm:billion-context", "npm:pi-compact-transcript", "npm:pi-compact-transcript@0.10.1", "npm:context-compactor"],
    }));
    const res = scanClientPlugins("pi", { env, cwd });
    assert.ok(!res.findings.some((f) => f.entry.includes("pi-compact-transcript")), "display-only plugin never flagged, any spec form");
    assert.ok(res.findings.some((f) => f.entry === "npm:context-compactor" && f.match === "keyword"), "real compressor still flagged");
});

test("opencode scan: display-only plugin excluded by exact name, lookalike compressor NOT excluded (#2324)", () => {
    clearScanCache();
    const root = tmp("bili-2324-oc-");
    const file = path.join(root, ".config", "opencode", "opencode.json");
    assertTestOwned(file, root);
    writeFile(file, JSON.stringify({ plugin: ["npm:pi-compact-transcript", "npm:my-pi-compact-transcript-fork"] }));
    const res = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd: root });
    assert.ok(!res.findings.some((f) => f.entry === "npm:pi-compact-transcript"), "exact display-only name excluded");
    assert.ok(res.findings.some((f) => f.entry === "npm:my-pi-compact-transcript-fork" && f.match === "keyword"), "lookalike is NOT on the allowlist -> still flagged");
});

test("omp scan: extensions block parsed, bili entry skipped, keyword flagged", () => {
    clearScanCache();
    const root = tmp("bili-1206-omp-");
    // #2038: pin omp's home under root via PI_CODING_AGENT_DIR (the only var
    // resolveOmpHome honors besides its ~/.omp/agent default = real process home).
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent") };
    const home = resolveOmpHome(env);
    assertTestOwned(path.join(home, "config.yml"), root);
    writeFile(path.join(home, "config.yml"), [
        "model: m",
        "extensions:",
        "  - /u/node_modules/billion-context/dist/agent/omp-native.js",
        "  - npm:context-compactor",
        "  - npm:context-forger",
        "providers:",
        "  default: openai",
    ].join("\n"));
    const res = scanClientPlugins("omp", { env, cwd: root });
    assert.equal(res.findings.length, 1, "action-token kept, bare-'context' dropped (#1736)");
    assert.equal(res.findings[0]?.entry, "npm:context-compactor");
    assert.equal(res.findings[0]?.match, "keyword");
});

test("kimi scan: installed.json ids scanned, billion-context skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-kimi-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), KIMI_CODE_HOME: path.join(root, "kimi") };
    const pluginsDir = path.join(resolveKimiHome(env), "plugins");
    assertTestOwned(path.join(pluginsDir, "installed.json"), root);
    writeFile(path.join(pluginsDir, "installed.json"), JSON.stringify({
        version: 1,
        plugins: [
            { id: "billion-context", root: "./managed/billion-context", source: "local-path", enabled: true },
            { id: "context-compactor", root: "./managed/context-compactor", source: "local-path", enabled: true },
            { id: "context-keeper", root: "./managed/context-keeper", source: "local-path", enabled: true },
        ],
    }));
    const res = scanClientPlugins("kimi", { env, cwd: root });
    assert.equal(res.findings.length, 1, "action-token kept, bare-'context' dropped (#1736)");
    assert.equal(res.findings[0]?.entry, "context-compactor");
});

test("hermes scan: plugin dirs matched by dir name only, bili skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-hermes-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), HERMES_HOME: path.join(root, "hermes") };
    const pluginsDir = path.join(resolveHermesHome(env), "plugins");
    fs.mkdirSync(path.join(pluginsDir, "billion-context"), { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, "weather"), { recursive: true });
    const compactorManifest = path.join(pluginsDir, "context-compactor", "plugin.yaml");
    const forecastManifest = path.join(pluginsDir, "forecast-tools", "plugin.yaml");
    assertTestOwned(compactorManifest, root);
    assertTestOwned(forecastManifest, root);
    // bare-'context' read-only tool: dropped by the tightened keyword set (#1736)
    fs.mkdirSync(path.join(pluginsDir, "context-viewer"), { recursive: true });
    // A keyword-rich manifest that must NOT match — hermes matches dir names only.
    writeFile(compactorManifest, "name: context-compactor\n");
    writeFile(forecastManifest, "description: summarizes context for weather forecasts\n");
    const res = scanClientPlugins("hermes", { env, cwd: root });
    assert.deepEqual(res.findings.map((f) => f.entry), ["context-compactor"]);
});

test("#920/#2045: bili's own sibling compressors are design-benign only under that client's own mode", () => {
    const ocKnown: ThirdPartyFinding = { client: "opencode", entry: "opencode-acp", source: "global", match: "known", knownId: "opencode-acp" };
    assert.equal(isDesignBenign(ocKnown, "opencode"), true);
    assert.equal(isDesignBenign(ocKnown, undefined), false, "wire mode: still a conflict");
    assert.equal(isDesignBenign(ocKnown, "pi"), false);
    const piKnown: ThirdPartyFinding = { client: "pi", entry: "npm:billion-context-pi", source: "/h/.pi/agent/settings.json", match: "known", knownId: "billion-context-pi" };
    assert.equal(isDesignBenign(piKnown, "pi"), true, "#2045: stands down via BILLION_CONTEXT_NATIVE/PROXY — no web popup");
    assert.equal(isDesignBenign(piKnown, undefined), false, "wire/plain-proxy mode: still a conflict");
    assert.equal(isDesignBenign(piKnown, "opencode"), false);
    const suspected: ThirdPartyFinding = { client: "opencode", entry: "acp-helper", source: "global", match: "keyword" };
    assert.equal(isDesignBenign(suspected, "opencode"), false, "keyword tier is never benign");
});

test("dsh scan: profile deps scanned; bare-'context' dashboard dropped, action-token compressors kept (#1736)", () => {
    clearScanCache();
    const root = tmp("bili-1206-dsh-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), DSH_HOME: path.join(root, "dsh") };
    assertTestOwned(path.join(root, "dsh", "profiles", "main", "package.json"), root);
    writeFile(path.join(root, "dsh", "profiles", "main", "package.json"), JSON.stringify({
        dependencies: {
            "billion-context": "^0.1.0",
            "dsh-context": "^0.2.0",
            "@deepseek-ai/dsh-compaction-basic": "0.2.0-rc.2",
            "dsh-context-compressor": "^1.0.0",
        },
    }));
    const res = scanClientPlugins("dsh", { env, cwd: root });
    const names = res.findings.map((f) => f.entry);
    assert.ok(!names.includes("dsh-context"), "read-only Context Dashboard must NOT be flagged (#1736)");
    assert.ok(!names.includes("billion-context"), "bili itself must be skipped");
    assert.ok(names.includes("@deepseek-ai/dsh-compaction-basic"), "'compaction' carries the compact action token");
    assert.ok(names.includes("dsh-context-compressor"), "'compressor' carries the compress action token");
});

test("dsh scan: missing profiles root yields empty result without throwing", () => {
    clearScanCache();
    const root = tmp("bili-1206-dsh-empty-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), DSH_HOME: path.join(root, "dsh") };
    const res = scanClientPlugins("dsh", { env, cwd: root });
    assert.deepEqual(res.findings, []);
});

test("claude scan: enabledPlugins keys + plugins dir scanned", () => {
    clearScanCache();
    const root = tmp("bili-1206-claude-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), CLAUDE_CONFIG_DIR: path.join(root, "claude") };
    assertTestOwned(path.join(root, "claude", "settings.json"), root);
    writeFile(path.join(root, "claude", "settings.json"), JSON.stringify({
        enabledPlugins: { "context-compressor": true, "theme-dark": true },
    }));
    fs.mkdirSync(path.join(root, "claude", "plugins", "summarizer-pro"), { recursive: true });
    const res = scanClientPlugins("claude", { env, cwd: root });
    const names = res.findings.map((f) => f.entry).sort();
    assert.deepEqual(names, ["context-compressor", "summarizer-pro"]);
});

test("unknown client yields empty result", () => {
    clearScanCache();
    const res = scanClientPlugins("codex", { env: {}, cwd: tmp("bili-1206-unknown-") });
    assert.deepEqual(res.findings, []);
    assert.equal(res.client, "codex");
});

test("scan results are cached within TTL and invalidated by clearScanCache", () => {
    clearScanCache();
    const root = tmp("bili-1206-cache-");
    const cwd = tmp("bili-1206-cache-cwd-");
    const cfgFile = path.join(root, ".config", "opencode", "opencode.json");
    assertTestOwned(cfgFile, root);
    writeFile(cfgFile, JSON.stringify({ plugin: ["opencode-acp"] }));
    const first = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd });
    assert.equal(first.findings.length, 1);
    writeFile(cfgFile, JSON.stringify({ plugin: [] }));
    const cached = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd });
    assert.equal(cached.findings.length, 1, "second scan within TTL must return the cached result");
    clearScanCache();
    const fresh = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd });
    assert.equal(fresh.findings.length, 0, "after clearScanCache the re-scan sees the updated config");
});

test("recordConflict appends to the session ledger and caps at CONFLICT_LEDGER_MAX", () => {
    const session = makeSession();
    for (let i = 0; i < CONFLICT_LEDGER_MAX + 5; i++) {
        recordConflict(session, "third-party-plugin", `event ${i}`);
    }
    const events = conflictEventsOf(session);
    assert.equal(events.length, CONFLICT_LEDGER_MAX);
    assert.equal(events[0]?.detail, "event 5", "oldest events must be dropped first");
    assert.equal(events[events.length - 1]?.detail, `event ${CONFLICT_LEDGER_MAX + 4}`);
});

test("formatConflictSection lists last 10 events with guidance", () => {
    const session = makeSession();
    for (let i = 0; i < 12; i++) recordConflict(session, "orphan-reap", `reaped ${i}`);
    const lines = formatConflictSection(conflictEventsOf(session));
    assert.ok(lines[0]?.startsWith("COMPRESSION CONFLICTS — 12 event(s)"));
    assert.ok(lines.some((l) => l.includes("reaped 11")));
    assert.ok(lines.some((l) => l.includes("reaped 2")));
    assert.ok(!lines.some((l) => l.includes("reaped 0 ")), "only the last 10 events are listed");
    assert.ok(lines.some((l) => l.includes("/__bili/stats")), "overflow pointer present");
    // #2545: orphan reaps are UNCONFIRMED signals (observed change, cause not
    // identified) — guidance exists but must not read as a confirmed conflict.
    assert.ok(lines.some((l) => l.includes("UNCONFIRMED signal")), "soft unconfirmed-signal guidance present");
    assert.ok(!lines.some((l) => l.toLowerCase().includes("keep exactly one compressor")), "no imperative for unconfirmed signals");
});

test("formatConflictSection marks [suspected] as name-only and softens the footer when nothing confirmed (#1736)", () => {
    const s = makeSession();
    recordConflict(s, "third-party-plugin", "dsh: dsh-context (profile/package.json) [suspected]");
    const lines = formatConflictSection(conflictEventsOf(s));
    assert.ok(lines.some((l) => l.includes("[suspected] = name-only")), "explains the suspected marker");
    assert.ok(lines.some((l) => l.includes("do not drop a read-only tool")), "all-suspected footer warns against blind removal");
    assert.ok(!lines.some((l) => l.toLowerCase().includes("one compressor")), "no confirmed events -> no hard remove/disable command");

    const s2 = makeSession();
    // #2545: a sibling standing down next to an orphan reap is NOT confirmed foreign
    // evidence — the strong footer requires a real non-suspected plugin finding.
    recordConflict(s2, "third-party-plugin", "pi: npm:real-compressor-x (/u/.pi/settings.json)");
    recordConflict(s2, "orphan-reap", "1 block(s) deactivated: b1");
    const lines2 = formatConflictSection(conflictEventsOf(s2));
    assert.ok(lines2.some((l) => l.toLowerCase().includes("one compressor")), "confirmed events keep the strong footer");
    assert.ok(!lines2.some((l) => l.includes("[suspected] = name-only")), "no note when nothing is suspected");

    const s3 = makeSession();
    recordConflict(s3, "third-party-plugin", "opencode: opencode-acp (global config)");
    recordConflict(s3, "orphan-reap", "1 block(s) deactivated: b1");
    const lines3 = formatConflictSection(conflictEventsOf(s3));
    assert.ok(!lines3.some((l) => l.toLowerCase().includes("keep exactly one compressor")), "sibling + unconfirmed signal stays in the soft tier (#2261/#2545)");
});

test("summarizeConflicts aggregates across sessions", () => {
    const a = makeSession();
    const b = makeSession();
    recordConflict(a, "third-party-plugin", "opencode: opencode-acp (global config)");
    recordConflict(a, "orphan-reap", "1 block(s) deactivated: b1");
    // b stays clean
    const summary = summarizeConflicts([a, b]);
    assert.equal(summary.sessions, 1);
    assert.equal(summary.events, 2);
    assert.equal(summary.kinds["third-party-plugin"], 1);
    assert.equal(summary.kinds["orphan-reap"], 1);
    assert.equal(summary.latest.length, 1);
    assert.equal(summary.latest[0]?.sessionId, a.id);
    assert.equal(summarizeConflicts([b]).events, 0);
});

// #2261: display-time sibling classification — first-party siblings must never
// be labeled "third-party" or commanded removed on any surface.

test("isOpencodeAcpEntry recognizes every spec form, rejects lookalikes (#2261)", () => {
    assert.ok(isOpencodeAcpEntry("opencode-acp"));
    assert.ok(isOpencodeAcpEntry("npm:opencode-acp"));
    assert.ok(isOpencodeAcpEntry("opencode-acp@stable"));
    assert.ok(isOpencodeAcpEntry("/home/u/node_modules/opencode-acp/index.js"));
    assert.ok(!isOpencodeAcpEntry("my-opencode-acp-fork"));
    assert.ok(!isOpencodeAcpEntry("context-forge"));
});

test("isKnownDisplayOnlyPlugin resolves bare/npm-versioned/path forms, rejects lookalikes (#2324)", () => {
    assert.ok(isKnownDisplayOnlyPlugin("pi-compact-transcript"));
    assert.ok(isKnownDisplayOnlyPlugin("npm:pi-compact-transcript"));
    assert.ok(isKnownDisplayOnlyPlugin("npm:pi-compact-transcript@0.10.1"));
    assert.ok(isKnownDisplayOnlyPlugin("/u/node_modules/pi-compact-transcript/index.js"));
    assert.ok(!isKnownDisplayOnlyPlugin("my-pi-compact-transcript-fork"), "substring lookalike NOT excluded");
    assert.ok(!isKnownDisplayOnlyPlugin("context-compactor"), "real compressor not excluded");
    assert.ok(!isKnownDisplayOnlyPlugin("pi-context"), "unrelated name not excluded");
});

test("isKnownDisplayOnlyPlugin exempts verified read-only context viewer in every spec form (#2545)", () => {
    assert.ok(isKnownDisplayOnlyPlugin("pi-context-inspector"));
    assert.ok(isKnownDisplayOnlyPlugin("npm:pi-context-inspector"));
    assert.ok(isKnownDisplayOnlyPlugin("npm:pi-context-inspector@1.3.0"));
    assert.ok(isKnownDisplayOnlyPlugin("/u/.pi/agent/npm/node_modules/pi-context-inspector/index.js"));
    assert.ok(isKnownDisplayOnlyPlugin("C:\\Users\\Administrator\\.pi\\agent\\npm\\node_modules\\pi-context-inspector\\index.js"), "windows path form");
    assert.ok(!isKnownDisplayOnlyPlugin("my-pi-context-inspector-fork"), "lookalike NOT excluded");
    assert.ok(!isKnownDisplayOnlyPlugin("pi-context-compressor"), "a real compressor sharing the prefix stays flagged");
});

test("pi scan: pi-context-inspector never flagged in any spec form, real compressors still flagged (#2545)", () => {
    clearScanCache();
    const root = tmp("bili-2545-pi-");
    const cwd = tmp("bili-2545-pi-cwd-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), PI_HOME: path.join(root, ".pi", "agent") };
    const home = resolvePiHome(env);
    assertTestOwned(path.join(home, "settings.json"), root);
    // the issue's exact install shape (npm spec as pi-managed) plus a bare name and a
    // REAL compressor that must stay flagged.
    writeFile(path.join(home, "settings.json"), JSON.stringify({
        packages: ["npm:billion-context", "npm:pi-context-inspector", "npm:pi-context-inspector@1.3.0", "npm:context-compactor"],
    }));
    const res = scanClientPlugins("pi", { env, cwd });
    assert.ok(!res.findings.some((f) => f.entry.includes("pi-context-inspector")), "read-only viewer never flagged, any spec form");
    assert.ok(res.findings.some((f) => f.entry === "npm:context-compactor" && f.match === "keyword"), "real compressor still flagged");
});

test("isSiblingConflictDetail maps recorded details back to sibling entries (#2261)", () => {
    assert.ok(isSiblingConflictDetail("pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)"));
    assert.ok(isSiblingConflictDetail("pi: billion-context-pi@0.1.75 (~/.pi/settings.json)"));
    assert.ok(isSiblingConflictDetail("opencode: opencode-acp (global config)"));
    assert.ok(isSiblingConflictDetail("opencode: npm:opencode-acp@1.2.3 (/u/.config/opencode/opencode.json)"));
    assert.ok(!isSiblingConflictDetail("pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]"));
    assert.ok(!isSiblingConflictDetail("dsh: dsh-context (profile/package.json) [suspected]"));
    assert.ok(!isSiblingConflictDetail("event 5"), "non-plugin detail shapes never classify");
});

test("opencode scan: npm:-prefixed opencode-acp spec classifies as known sibling, not suspected keyword (#2261)", () => {
    clearScanCache();
    const root = tmp("bili-2261-oc-npm-");
    const file = path.join(root, ".config", "opencode", "opencode.json");
    assertTestOwned(file, root);
    writeFile(file, JSON.stringify({ plugin: ["npm:opencode-acp"] }));
    const res = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd: root });
    const f = res.findings.find((x) => x.entry === "npm:opencode-acp");
    assert.ok(f, "npm:-prefixed spec must be found");
    assert.equal(f?.match, "known");
    assert.equal(f?.knownId, "opencode-acp");
});

test("summarizeConflicts counts sibling-tagged plugin events additively (#2261)", () => {
    const a = makeSession();
    recordConflict(a, "third-party-plugin", "pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)");
    recordConflict(a, "third-party-plugin", "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]");
    recordConflict(a, "orphan-reap", "1 block(s) deactivated: b1");
    const s = summarizeConflicts([a]);
    assert.equal(s.events, 3);
    assert.equal(s.kinds["third-party-plugin"], 2);
    assert.equal(s.sibling, 1, "only the bcp event classifies as sibling");
});

test("summarizeConflicts counts [suspected] plugin events additively, disjoint from sibling (#2324)", () => {
    const a = makeSession();
    recordConflict(a, "third-party-plugin", "pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)");
    recordConflict(a, "third-party-plugin", "omp: npm:context-compactor (/home/dog/.omp/agent/config.yml) [suspected]");
    recordConflict(a, "third-party-plugin", "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]");
    recordConflict(a, "orphan-reap", "1 block(s) deactivated: b1");
    const s = summarizeConflicts([a]);
    assert.equal(s.events, 4);
    assert.equal(s.kinds["third-party-plugin"], 3);
    assert.equal(s.sibling, 1, "the bcp event classifies as sibling");
    assert.equal(s.suspected, 2, "both [suspected] events counted; additive within kinds[third-party-plugin], disjoint from sibling");
});

test("formatConflictSection: sibling-only ledgers drop the one-compressor command (#2261)", () => {
    const s = makeSession();
    recordConflict(s, "third-party-plugin", "pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)");
    recordConflict(s, "third-party-plugin", "opencode: opencode-acp (global config)");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    assert.ok(text.includes("OWN sibling extension"), "names them as bili's own siblings");
    assert.ok(!text.toLowerCase().includes("keep exactly one compressor"), "no hard removal command for siblings");
    assert.ok(text.includes("/__bili/conflicts/clear"), "points at the clear path");

    const mixed = makeSession();
    recordConflict(mixed, "third-party-plugin", "pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)");
    recordConflict(mixed, "third-party-plugin", "pi: npm:real-compressor-x (/home/dog/.pi/agent/settings.json)");
    const mixedText = formatConflictSection(conflictEventsOf(mixed)).join("\n");
    assert.ok(mixedText.toLowerCase().includes("keep exactly one compressor"), "any non-sibling event keeps the strong footer");
});

// #2545: evidence tiers — verified read-only viewers are neutralized at display
// time (stock ledgers written by pre-#1736 keyword rules carry them as
// [suspected]), and unconfirmed signals never escalate into a confirmed
// double-compression verdict.

test("parsePluginConflictDetail splits client/entry/source/suspected; non-plugin shapes stay undefined (#2545)", () => {
    assert.deepEqual(
        parsePluginConflictDetail("pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]"),
        { client: "pi", entry: "npm:context-forge", source: "/home/dog/.pi/agent/settings.json", suspected: true });
    assert.deepEqual(
        parsePluginConflictDetail("opencode: opencode-acp (global config)"),
        { client: "opencode", entry: "opencode-acp", source: "global config", suspected: false });
    // the issue's own stock record shape — Windows path inside the parens must parse.
    const w = parsePluginConflictDetail("pi: npm:pi-context-inspector (C:\\Users\\Administrator\\.pi\\agent\\settings.json) [suspected]");
    assert.equal(w?.entry, "npm:pi-context-inspector");
    assert.equal(w?.suspected, true);
    assert.equal(parsePluginConflictDetail("event 5"), undefined);
    assert.equal(parsePluginConflictDetail("47/247 incoming message(s) carry pre-turn refs of 290 known"), undefined);
});

test("isDisplayOnlyConflictDetail neutralizes stock records of verified read-only viewers (#2545)", () => {
    assert.ok(isDisplayOnlyConflictDetail("pi: npm:pi-context-inspector (C:\\Users\\Administrator\\.pi\\agent\\settings.json) [suspected]"), "the issue's exact stock detail");
    assert.ok(isDisplayOnlyConflictDetail("pi: pi-compact-transcript (/u/.pi/settings.json)"));
    assert.ok(!isDisplayOnlyConflictDetail("pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]"));
    assert.ok(!isDisplayOnlyConflictDetail("dsh: dsh-context (profile/package.json) [suspected]"));
    assert.ok(!isDisplayOnlyConflictDetail("event 5"), "non-plugin shapes never classify");
});

test("summarizeConflicts counts displayOnly and activeConfirmed tiers (#2545/#2912)", () => {
    const a = makeSession();
    recordConflict(a, "third-party-plugin", "pi: npm:pi-context-inspector (C:\\Users\\Administrator\\.pi\\agent\\settings.json) [suspected]");
    recordConflict(a, "third-party-plugin", "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]");
    const b = makeSession();
    // #2912: only an INFERRED landing is confirmed-tier now — a marker-detected one was already rebased onto.
    recordConflict(b, "native-compaction-inferred", "codex: compaction framing absent on replay; bili refused 3 client-native call(s) (#2709)");
    const s = summarizeConflicts([a, b]);
    assert.equal(s.events, 3);
    assert.equal(s.suspected, 2);
    assert.equal(s.displayOnly, 1, "the inspector record classifies as display-only (overlaps suspected)");
    assert.equal(s.activeConfirmed, 1, "only the INFERRED native-compaction landing is confirmed-tier");
    assert.equal(s.active, 3);
});

test("#2912: a pure recovered (marker-detected) native-compaction ledger is NOT confirmed-tier", () => {
    const r = makeSession();
    recordConflict(r, "native-compaction", "dsh native compaction: 12/14 covered id(s) replaced; ACP state rebased (#2432)");
    const s = summarizeConflicts([r]);
    assert.equal(s.events, 1);
    assert.equal(s.activeConfirmed, 0, "recovered landing already rebased onto (#2372/#2432) — handled stock, not confirmed evidence");
});

test("formatConflictSection: display-only-only ledger stands down neutrally (#2545)", () => {
    const s = makeSession();
    recordConflict(s, "third-party-plugin", "pi: npm:pi-context-inspector (C:\\Users\\Administrator\\.pi\\agent\\settings.json) [suspected]");
    recordConflict(s, "third-party-plugin", "pi: npm:pi-context-inspector@1.3.0 (C:\\Users\\Administrator\\.pi\\agent\\settings.json) [suspected]");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    assert.ok(text.includes("verified non-compressing plugin"), "names the verified non-compressing tier");
    assert.ok(!text.includes("Two compressors on one conversation"), "header claim requires confirmed/native evidence");
    assert.ok(!text.toLowerCase().includes("keep exactly one compressor"), "no removal command for non-compressors");
    assert.ok(text.includes("/__bili/conflicts/clear"), "points at the clear path");
});

test("formatConflictSection: rewrite signal + display-only stock stays an UNCONFIRMED diagnosis (#2545)", () => {
    const s = makeSession();
    recordConflict(s, "unannounced-rewrite", "47/247 incoming message(s) carry pre-turn refs of 290 known");
    recordConflict(s, "third-party-plugin", "pi: npm:pi-context-inspector (C:\\Users\\Administrator\\.pi\\agent\\settings.json) [suspected]");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    assert.ok(text.includes("UNCONFIRMED signal"), "tiered as unconfirmed");
    assert.ok(text.includes("cause is not confirmed"), "cause explicitly unidentified");
    assert.ok(!text.includes("Two compressors on one conversation"), "header claim requires confirmed/native evidence");
    assert.ok(!text.toLowerCase().includes("keep exactly one compressor"), "no imperative without confirmed evidence");
});

test("formatConflictSection: stale confirmed stock next to a fresh signal -> verify-then-clear, not live alarm (#2545)", () => {
    const s = makeSession();
    s.metadata.conflictEvents = [
        { at: Date.now() - 30 * 86_400_000, kind: "third-party-plugin", detail: "pi: npm:real-compressor-x (/home/dog/.pi/agent/settings.json)" },
        { at: Date.now(), kind: "unannounced-rewrite", detail: "47/247 incoming message(s) carry pre-turn refs of 290 known" },
    ];
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    assert.ok(text.includes("older than 7 days (historical stock)"), "confirmed ledger graded by its own age");
    assert.ok(text.includes("Two compressors on one conversation"), "header claim holds while confirmed evidence exists");
    assert.ok(!text.toLowerCase().includes("keep exactly one compressor"), "stock confirmed events get verify-then-clear, not the live command");
});

// #2969: @openma/deepseek-harness-acp — the "-acp" suffix names the Agent Client
// Protocol, not the acp-kernel ecosystem marker. The adapter is verified NOT to
// compress (its shipped cordis.patch.yml disables dsh native compaction features),
// so it must be exempted by exact name AND its stock [suspected] records neutralized
// at display time — while real compressors and runtime evidence stay fully visible.

test("isKnownDisplayOnlyPlugin exempts the dsh ACP protocol adapter in every spec form, rejects lookalikes (#2969)", () => {
    assert.ok(isKnownDisplayOnlyPlugin("@openma/deepseek-harness-acp"));
    assert.ok(isKnownDisplayOnlyPlugin("npm:@openma/deepseek-harness-acp"));
    assert.ok(isKnownDisplayOnlyPlugin("npm:@openma/deepseek-harness-acp@0.4.37"));
    assert.ok(isKnownDisplayOnlyPlugin("/u/dsh/profiles/desktop/node_modules/@openma/deepseek-harness-acp/index.js"));
    assert.ok(isKnownDisplayOnlyPlugin("C:\\Users\\Administrator\\dsh\\profiles\\desktop\\node_modules\\@openma\\deepseek-harness-acp\\index.js"), "windows path form");
    assert.ok(!isKnownDisplayOnlyPlugin("@openma/deepseek-harness-acp-fork"), "scoped lookalike NOT excluded");
    assert.ok(!isKnownDisplayOnlyPlugin("deepseek-harness-acp"), "unscoped lookalike NOT excluded");
    assert.ok(!isKnownDisplayOnlyPlugin("@other/deepseek-harness-acp"), "other scope NOT excluded");
});

test("dsh scan: ACP protocol adapter alone yields NO finding; real compressors still flagged (#2969)", () => {
    clearScanCache();
    const root = tmp("bili-2969-dsh-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), DSH_HOME: path.join(root, "dsh") };
    const pkg = path.join(root, "dsh", "profiles", "desktop", "package.json");
    assertTestOwned(pkg, root);
    writeFile(pkg, JSON.stringify({
        dependencies: {
            "billion-context": "^0.1.0",
            "@openma/deepseek-harness-acp": "^0.4.0",
            "@deepseek-ai/dsh-compaction-basic": "0.2.0-rc.2",
        },
    }));
    const res = scanClientPlugins("dsh", { env, cwd: root });
    const names = res.findings.map((f) => f.entry);
    assert.ok(!names.some((n) => n.includes("@openma/deepseek-harness-acp")), "protocol adapter never flagged in any spec form");
    assert.ok(names.includes("@deepseek-ai/dsh-compaction-basic"), "real compressor still flagged");
});

test("isDisplayOnlyConflictDetail neutralizes stock records of the dsh ACP adapter (#2969)", () => {
    assert.ok(isDisplayOnlyConflictDetail("dsh: @openma/deepseek-harness-acp (/home/u/.dsh/profiles/desktop/package.json) [suspected]"), "the issue's exact stock detail shape");
    assert.ok(isDisplayOnlyConflictDetail("dsh: npm:@openma/deepseek-harness-acp@0.4.37 (/u/dsh/profiles/desktop/package.json) [suspected]"));
    assert.ok(!isDisplayOnlyConflictDetail("dsh: @openma/deepseek-harness-acp-fork (/u/dsh/profiles/desktop/package.json) [suspected]"), "lookalike stays suspected");
    assert.ok(!isDisplayOnlyConflictDetail("event 5"), "non-plugin shapes never classify");
});

test("summarizeConflicts counts the ACP adapter record as displayOnly, overlapping suspected (#2969)", () => {
    const a = makeSession();
    recordConflict(a, "third-party-plugin", "dsh: @openma/deepseek-harness-acp (/u/dsh/profiles/desktop/package.json) [suspected]");
    recordConflict(a, "third-party-plugin", "dsh: dsh-context-compressor (/u/dsh/profiles/desktop/package.json) [suspected]");
    const s = summarizeConflicts([a]);
    assert.equal(s.events, 2);
    assert.equal(s.suspected, 2, "both records are name-only matches on the raw counter");
    assert.equal(s.displayOnly, 1, "only the adapter record classifies as non-compressing");
    assert.equal(s.activeConfirmed, 0, "no confirmed-tier evidence from names alone");
});

test("formatConflictSection: ACP-adapter-only ledger stands down neutrally, no fix footer (#2969)", () => {
    const s = makeSession();
    recordConflict(s, "third-party-plugin", "dsh: @openma/deepseek-harness-acp (/u/dsh/profiles/desktop/package.json) [suspected]");
    recordConflict(s, "third-party-plugin", "dsh: @openma/deepseek-harness-acp (/u/dsh/profiles/desktop/package.json) [suspected]");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    assert.ok(text.includes("verified non-compressing plugin"), "names the verified non-compressing tier");
    assert.ok(!text.includes("Two compressors on one conversation"), "header claim requires confirmed/native evidence");
    assert.ok(!text.toLowerCase().includes("keep exactly one compressor"), "no removal command for non-compressors");
    assert.ok(!text.includes("\n\nFix"), "no per-client fix footer for a neutral ledger");
    assert.ok(text.includes("/__bili/conflicts/clear"), "points at the clear path");
});

test("formatConflictSection: pure-[suspected] ledger drops the imperative fix footer (#2969)", () => {
    const s = makeSession();
    recordConflict(s, "third-party-plugin", "dsh: dsh-context-compressor (/u/dsh/profiles/desktop/package.json) [suspected]");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    assert.ok(text.includes("[suspected] = name-only"), "explains the suspected marker");
    assert.ok(text.includes("do not drop a read-only tool"), "verify-first advice present");
    assert.ok(!text.includes("\n\nFix"), "no imperative per-client fix footer when nothing is confirmed");
    assert.ok(!text.includes("disable the client's own auto-compaction"), "no disable/restart command for name-only guesses");
    assert.ok(!text.includes("Detecting other compression plugins"), "docs pointer rides with the footer");

    const s2 = makeSession();
    recordConflict(s2, "third-party-plugin", "dsh: dsh-context-compressor (/u/dsh/profiles/desktop/package.json) [suspected]");
    recordConflict(s2, "unannounced-rewrite", "47/247 incoming message(s) carry pre-turn refs of 290 known");
    const text2 = formatConflictSection(conflictEventsOf(s2)).join("\n");
    assert.ok(text2.includes("\n\nFix"), "unconfirmed-signal tier keeps the remediation footer");
    assert.ok(text2.includes("UNCONFIRMED signal"), "signal framing intact");
});

test("formatConflictSection: ACP adapter record next to a HANDLED native landing drops to the suspected tier (#2969/#2912)", () => {
    const s = makeSession();
    recordConflict(s, "third-party-plugin", "dsh: @openma/deepseek-harness-acp (/u/dsh/profiles/desktop/package.json) [suspected]");
    recordConflict(s, "native-compaction", "codex: compaction_trigger item");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    // #2912: the marker-detected native landing is already rebased onto (handled stock), so it
    // no longer arms the confirmed double-compression header — only the name-only-suspected
    // plugin remains, governing the verify-first tier (supersedes #2969's pre-#2912 premise).
    assert.ok(!text.includes("Two compressors on one conversation"), "handled native landing must not re-arm the double-compression header");
    assert.ok(!text.includes("client's OWN native compaction landing"), "no confirmed-native rebuild advice for a handled landing");
    assert.ok(text.includes("ALREADY rebased onto"), "the handled-native calm framing is present");
    assert.ok(text.includes("name-only keyword match"), "the suspected plugin is still flagged for verification");
});
