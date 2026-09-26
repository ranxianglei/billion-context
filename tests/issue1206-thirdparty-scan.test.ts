import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { clearScanCache, conflictScanEnabled, isDesignAbsorbed, scanClientPlugins, sniffScanClient, type ThirdPartyFinding } from "../src/thirdparty-scan.js";
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
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
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

// Hermetic env: every client home resolves under root, nothing leaks to the
// developer's real home directories.
function hermeticEnv(root: string): NodeJS.ProcessEnv {
    return { HOME: root, XDG_CONFIG_HOME: path.join(root, ".config") };
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
    assert.equal(sniffScanClient({ "x-opencode-session": "ses_123" }), "opencode");
    assert.equal(sniffScanClient({ "x-session-affinity": "ses_abc" }), "opencode");
    assert.equal(sniffScanClient({ "x-session-affinity": "not-a-session" }), undefined);
    assert.equal(sniffScanClient({}), undefined);
});

test("opencode scan: known conflict + keyword entries, self/context7 skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-oc-");
    const cwd = tmp("bili-1206-oc-cwd-");
    writeFile(path.join(root, ".config", "opencode", "opencode.json"), JSON.stringify({
        plugin: ["opencode-acp@stable", "@scope/context-compressor", "billion-context", "context7", { name: "memory-compactor" }],
    }));
    writeFile(path.join(cwd, ".opencode", "opencode.json"), JSON.stringify({ plugin: ["compact-helper"] }));
    const res = scanClientPlugins("opencode", { env: hermeticEnv(root), cwd });
    const names = res.findings.map((f) => f.entry);
    assert.ok(names.includes("opencode-acp@stable"), `expected opencode-acp@stable in ${names}`);
    assert.ok(names.includes("@scope/context-compressor"));
    assert.ok(names.includes("memory-compactor"));
    assert.ok(names.includes("compact-helper"), "project-layer entry must be scanned");
    assert.ok(!names.includes("billion-context"), "bili itself must be skipped");
    assert.ok(!names.some((n) => n === "context7"), "context7 must NOT be keyword-matched");
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
    writeFile(path.join(base, "opencode.json"), JSON.stringify({ plugin: ["acp-decoy"] }));
    const repo = path.join(base, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
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

test("pi scan: legacy bcp entry is known-conflict, keyword entries flagged, bili-self skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-pi-");
    const cwd = tmp("bili-1206-pi-cwd-");
    const home = resolvePiHome(hermeticEnv(root));
    writeFile(path.join(home, "settings.json"), JSON.stringify({
        packages: ["npm:billion-context-pi", "npm:context-forge", "/u/node_modules/billion-context/dist/agent/pi.js"],
    }));
    const res = scanClientPlugins("pi", { env: hermeticEnv(root), cwd });
    const bcp = res.findings.find((f) => f.entry === "npm:billion-context-pi");
    assert.equal(bcp?.match, "known");
    assert.equal(bcp?.knownId, "billion-context-pi");
    assert.ok(res.findings.some((f) => f.entry === "npm:context-forge" && f.match === "keyword"));
    assert.ok(!res.findings.some((f) => f.entry.includes("dist/agent/pi.js")), "bili's own extension path must be skipped");
});

test("omp scan: extensions block parsed, bili entry skipped, keyword flagged", () => {
    clearScanCache();
    const root = tmp("bili-1206-omp-");
    const home = resolveOmpHome(hermeticEnv(root));
    writeFile(path.join(home, "config.yml"), [
        "model: m",
        "extensions:",
        "  - /u/node_modules/billion-context/dist/agent/omp-native.js",
        "  - npm:context-forger",
        "providers:",
        "  p1: {}",
        "",
    ].join("\n"));
    const res = scanClientPlugins("omp", { env: hermeticEnv(root), cwd: root });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]?.entry, "npm:context-forger");
    assert.equal(res.findings[0]?.match, "keyword");
});

test("kimi scan: installed.json ids scanned, billion-context skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-kimi-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), KIMI_CODE_HOME: path.join(root, "kimi") };
    const pluginsDir = path.join(resolveKimiHome(env), "plugins");
    writeFile(path.join(pluginsDir, "installed.json"), JSON.stringify({
        version: 1,
        plugins: [
            { id: "billion-context", root: "./managed/billion-context", source: "local-path", enabled: true },
            { id: "context-keeper", root: "./managed/context-keeper", source: "local-path", enabled: true },
        ],
    }));
    const res = scanClientPlugins("kimi", { env, cwd: root });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]?.entry, "context-keeper");
});

test("hermes scan: plugin dirs matched by dir name only, bili skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-hermes-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), HERMES_HOME: path.join(root, "hermes") };
    const pluginsDir = path.join(resolveHermesHome(env), "plugins");
    fs.mkdirSync(path.join(pluginsDir, "billion-context"), { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, "weather"), { recursive: true });
    writeFile(path.join(pluginsDir, "context-keeper", "plugin.yaml"), "name: context-keeper\n");
    // Keyword-rich manifest under a NON-matching dir name must not trigger —
    // full-text matching false-positives on plain descriptions.
    writeFile(path.join(pluginsDir, "forecast-tools", "plugin.yaml"), "description: summarizes context for weather forecasts\n");
    const res = scanClientPlugins("hermes", { env, cwd: root });
    assert.deepEqual(res.findings.map((f) => f.entry), ["context-keeper"]);
});

test("#920: opencode-acp is design-absorbed only under bili's own opencode mode", () => {
    const known: ThirdPartyFinding = { client: "opencode", entry: "opencode-acp", source: "global", match: "known", knownId: "opencode-acp" };
    assert.equal(isDesignAbsorbed(known, "opencode"), true);
    assert.equal(isDesignAbsorbed(known, undefined), false, "wire mode: still a conflict");
    assert.equal(isDesignAbsorbed(known, "pi"), false);
    const suspected: ThirdPartyFinding = { client: "opencode", entry: "acp-helper", source: "global", match: "keyword" };
    assert.equal(isDesignAbsorbed(suspected, "opencode"), false, "keyword tier is never absorbed");
});

test("dsh scan: profile package.json deps scanned, billion-context skipped", () => {
    clearScanCache();
    const root = tmp("bili-1206-dsh-");
    const env: NodeJS.ProcessEnv = { ...hermeticEnv(root), DSH_HOME: path.join(root, "dsh") };
    writeFile(path.join(root, "dsh", "profiles", "main", "package.json"), JSON.stringify({
        dependencies: { "billion-context": "^0.1.0", "context-keeper": "^1.0.0" },
    }));
    const res = scanClientPlugins("dsh", { env, cwd: root });
    assert.deepEqual(res.findings.map((f) => f.entry), ["context-keeper"]);
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
    assert.ok(lines.some((l) => l.toLowerCase().includes("one compressor")), "guidance footer present");
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
