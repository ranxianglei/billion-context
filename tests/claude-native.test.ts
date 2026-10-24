// #964 claude native posture: managed settings block (pure merge/strip),
// port resolution, installer round-trip against a fake `claude` CLI in a
// sandboxed CLAUDE_CONFIG_DIR, and the SessionStart hook's pure planner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import {
    applyClaudeManagedBlock,
    CLAUDE_ACP_CACHE_COMMAND,
    claudeAcpCacheCommandFile,
    claudeNativeBaseUrl,
    claudeNativeVertexBaseUrl,
    claudeNativeOrigin,
    claudeNativeInstalled,
    claudeSettingsFile,
    claudeNativeBaseUrlForOrigin,
    unwrapBiliBaseUrl,
    claudeDesktopPresent,
    isBiliClaudeBaseUrl,
    pluginInstall,
    pluginRemove,
    repinClaudeManagedBaseUrl,
    resolveClaudeCli,
    stripClaudeManagedBlock,
} from "../src/plugin-install.ts";
import { ensureRootCA } from "../src/ca.ts";
import { ZONE_PORT_BASE, resolveClaudeNativePort, resolveNativeAttachExternal, resolveNativeAttachLanePriority, resolveNativeAttachPolicy, resolveNativeAttachUrl, resolveZonePortBase } from "../src/config.ts";
import { chooseWatchdogParentPid, claudeNativeRoutingCheck, isClaudeHostArgv, isTransientShArgv, planClaudeNativeBootstrap, procTableExecOptions, readPsProcInfo, recordClaudeRoutingWarning, readWinProcInfo, resolveClaudeHostPid, splitWindowsCommandLine } from "../src/claude-native-bootstrap.ts";
import { caDir, claudeRoutingWarningFile } from "../src/paths.ts";
import { rmrf } from "./tmp-rm.ts";

// #3182: under the CI zone-slot preload this file gets its own BILI_ZONE_PORT
// band. Helpers that resolve from process.env (claudeNativeBaseUrl(), the
// installer, planEnv spreads) follow the band; planClaudeNativeBootstrap({})
// — literally "no environment at all" — stays on the exported default.
// Every explicit child env below spreads ZONE_ENV so the hook, the manual
// daemons and the attach scan all stay inside the band — concurrent live
// files never see each other's zone (#3182/#3184/#3188).
const ZONE_BAND_BASE = resolveZonePortBase();
const ZONE_ENV = process.env.BILI_ZONE_PORT ? { BILI_ZONE_PORT: process.env.BILI_ZONE_PORT } : {};

// #1248: the live tests below spawn real proxies/processes and observe real
// /proc, ps output and network ports. On loaded shared machines (multi-agent
// sandboxes running several suites concurrently) they hang or fail
// non-deterministically — Run C's failing set {24,37-42} is exactly this set —
// while every pure test in this file stays green. So they are opt-in, like
// ACP_TEST_E2E for the codex suite: CI sets ACP_TEST_CLAUDE_NATIVE=1
// (ci.yml); a local `npm test` skips them by default to keep a fast,
// deterministic signal.
const LIVE_E2E = process.env.ACP_TEST_CLAUDE_NATIVE === "1";
const liveSkip = LIVE_E2E ? undefined : "set ACP_TEST_CLAUDE_NATIVE=1 (live proxy/process e2e; flaky under concurrent load, #1248)";

const HOOK_COMMAND = "/opt/bili/dist/claude-native-bootstrap.js";

function baseUrlForPort(port: number): string {
    return `http://127.0.0.1:${port}/bili/https://api.anthropic.com`;
}

// — pure merge/strip ————————————————————————————————————————————

test("applyClaudeManagedBlock: writes env + hook into empty settings", () => {
    const { data, notes } = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, baseUrlForPort(48787));
    assert.equal((data.env as Record<string, string>).DISABLE_AUTO_COMPACT, "1");
    const entries = (data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(entries.length, 1);
    assert.deepEqual((entries[0] as { hooks: Array<{ type: string; command: string }> }).hooks, [{ type: "command", command: HOOK_COMMAND }]);
    assert.equal(notes.length, 3);
});

test("applyClaudeManagedBlock: idempotent — a second apply changes nothing", () => {
    const first = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const second = applyClaudeManagedBlock(first.data, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.deepEqual(second.data, first.data);
    assert.equal(second.notes.length, 0);
});

test("applyClaudeManagedBlock: rewrites an older bili URL to the current port", () => {
    const settings = { env: { ANTHROPIC_BASE_URL: baseUrlForPort(40000) } };
    const { data, notes } = applyClaudeManagedBlock(settings, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, baseUrlForPort(48787));
    assert.ok(notes.some((n) => n.includes("ANTHROPIC_BASE_URL")));
});

test("applyClaudeManagedBlock: never clobbers foreign keys", () => {
    const settings = { env: { ANTHROPIC_BASE_URL: "https://relay.example", DISABLE_AUTO_COMPACT: "0" }, other: true };
    const { data, notes } = applyClaudeManagedBlock(settings, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, "https://relay.example");
    assert.equal((data.env as Record<string, string>).DISABLE_AUTO_COMPACT, "0");
    assert.equal((data.other as boolean), true);
    assert.ok(notes.some((n) => n.includes("foreign value") || n.includes("left untouched")));
});

test("applyClaudeManagedBlock: pins the Vertex variable too when one is resolved", () => {
    // Vertex port, phase 1 (decision 4): with CLAUDE_CODE_USE_VERTEX=1 the client
    // ignores the block's ANTHROPIC_BASE_URL, so a native install without this key
    // calls Google directly and never touches bili.
    const vertexUrl = "http://127.0.0.1:48787/bili/anthropic/https://aiplatform.googleapis.com/v1";
    const { data, notes } = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND, vertexBaseUrl: vertexUrl });
    const env = data.env as Record<string, string>;
    assert.equal(env.ANTHROPIC_BASE_URL, baseUrlForPort(48787));
    assert.equal(env.ANTHROPIC_VERTEX_BASE_URL, vertexUrl);
    assert.ok(notes.some((n) => n.includes("ANTHROPIC_VERTEX_BASE_URL")));
});

test("applyClaudeManagedBlock: rewrites an older bili Vertex URL to the current port", () => {
    const stale = "http://127.0.0.1:40000/bili/anthropic/https://aiplatform.googleapis.com/v1";
    const current = "http://127.0.0.1:48787/bili/anthropic/https://aiplatform.googleapis.com/v1";
    assert.equal(isBiliClaudeBaseUrl(stale), true, "the protocol segment is still a bili URL");
    const { data } = applyClaudeManagedBlock({ env: { ANTHROPIC_VERTEX_BASE_URL: stale } }, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND, vertexBaseUrl: current });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_VERTEX_BASE_URL, current);
});

test("applyClaudeManagedBlock: a foreign Vertex variable is never clobbered", () => {
    const settings = { env: { ANTHROPIC_VERTEX_BASE_URL: "https://vertex-gateway.example/v1" } };
    const { data, notes } = applyClaudeManagedBlock(settings, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND, vertexBaseUrl: "http://127.0.0.1:48787/bili/anthropic/https://aiplatform.googleapis.com/v1" });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_VERTEX_BASE_URL, "https://vertex-gateway.example/v1");
    assert.ok(notes.some((n) => n.includes("ANTHROPIC_VERTEX_BASE_URL") && n.includes("left untouched")));
});

test("applyClaudeManagedBlock: Vertex off (no resolved value) leaves the key alone entirely", () => {
    const { data, notes } = applyClaudeManagedBlock({ env: { ANTHROPIC_VERTEX_BASE_URL: "https://vertex-gateway.example/v1" } }, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_VERTEX_BASE_URL, "https://vertex-gateway.example/v1");
    assert.ok(!notes.some((n) => n.includes("ANTHROPIC_VERTEX_BASE_URL")));
    assert.equal((applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND }).data.env as Record<string, string>).ANTHROPIC_VERTEX_BASE_URL, undefined);
});

test("claudeNativeVertexBaseUrl: resolves the client's own config, settings block first", () => {
    // Same resolution order the client uses: a settings.json env block is where a
    // Vertex user configures this, with the shell only as fallback.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-vertex-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bili-vertex-cwd-"));
    try {
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
            env: { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global", ANTHROPIC_VERTEX_PROJECT_ID: "aolshev-playground" },
        }));
        assert.equal(
            claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd),
            "http://127.0.0.1:48787/bili/anthropic/https://aiplatform.googleapis.com/v1",
        );
        // Switch off in the same file: nothing to pin, the key must not appear.
        fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLOUD_ML_REGION: "global" } }));
        assert.equal(claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd), undefined);
        // Switch on without a region and without an explicit URL: not routable.
        fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }));
        assert.equal(claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd), undefined);
        // An explicit endpoint wins over the region and is handed over untouched.
        fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
            env: { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5", ANTHROPIC_VERTEX_BASE_URL: "https://gateway.example/vertex/v1/" },
        }));
        assert.equal(
            claudeNativeVertexBaseUrl("http://127.0.0.1:48787/", {}, home, cwd),
            "http://127.0.0.1:48787/bili/anthropic/https://gateway.example/vertex/v1",
        );
    } finally {
        rmrf(home);
        rmrf(cwd);
    }
});

test("claudeNativeVertexBaseUrl: an already-managed value is never wrapped twice", () => {
    // Install writes this key, then the SessionStart hook re-derives it from the
    // file it wrote. Treating our own wrapper as a user endpoint nested another
    // /bili/anthropic/ layer per repin, so the URL ended up targeting the proxy's
    // own port — which the tunnel guard denies (403 detail:"self").
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-vertex-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bili-vertex-cwd-"));
    try {
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        const file = path.join(home, ".claude", "settings.json");
        const managed = "http://127.0.0.1:48787/bili/anthropic/https://aiplatform.googleapis.com/v1";
        const write = (url: string) => fs.writeFileSync(file, JSON.stringify({
            env: { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global", ANTHROPIC_VERTEX_BASE_URL: url },
        }));
        write(managed);
        assert.equal(claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd), managed, "idempotent on its own output");
        const once = claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd)!;
        write(once);
        assert.equal(claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd), managed, "a repin does not nest a layer");
        // A relay the user baked in behind our wrapper is preserved: only our own
        // wrapper comes off, the inner endpoint is handed over untouched.
        const relay = "https://vertex-gateway.example/proxy/v1";
        write(`http://127.0.0.1:40000/bili/anthropic/${relay}`);
        assert.equal(claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd), `http://127.0.0.1:48787/bili/anthropic/${relay}`);
        // An explicit non-bili endpoint still wins over the region (unchanged rule).
        write("https://gateway.example/vertex/v1");
        assert.equal(claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd), "http://127.0.0.1:48787/bili/anthropic/https://gateway.example/vertex/v1");
        // The file bili 0.1.197 left behind holds TWO layers; the derivation must
        // collapse both rather than settle at two.
        write(`http://127.0.0.1:48787/bili/anthropic/${managed}`);
        assert.equal(claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd), managed, "a nested value collapses to the endpoint");
        // The install path is idempotent on what it wrote: apply twice, nothing moves
        // (before the fix the URL grew a layer per run).
        const derive = () => claudeNativeVertexBaseUrl("http://127.0.0.1:48787", {}, home, cwd)!;
        const first = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND, vertexBaseUrl: derive() });
        const second = applyClaudeManagedBlock(first.data, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND, vertexBaseUrl: derive() });
        assert.deepEqual(second.data, first.data, "a re-apply changes nothing");
        assert.equal((second.data.env as Record<string, string>).ANTHROPIC_VERTEX_BASE_URL, managed);
    } finally {
        rmrf(home);
        rmrf(cwd);
    }
});

test("applyClaudeManagedBlock: preserves user SessionStart entries, refreshes ours", () => {
    const userEntry = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
    const first = applyClaudeManagedBlock({ hooks: { SessionStart: [userEntry] } }, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const entries = (first.data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], userEntry);
    const again = applyClaudeManagedBlock(first.data, { baseUrl: baseUrlForPort(48787), hookCommand: "/moved/dist/claude-native-bootstrap.js" });
    const after = (again.data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(after.length, 2, "old-path entry still counts as ours — no duplicate appended");
    assert.deepEqual(after[0], userEntry, "user entry untouched");
    assert.deepEqual((after[1] as { hooks: Array<{ command: string }> }).hooks, [{ type: "command", command: "/moved/dist/claude-native-bootstrap.js" }]);
    assert.equal(again.notes.length, 1);
});

test("applyClaudeManagedBlock: rewrites a stale hook command in place (#1376)", () => {
    // 0.1.153 on Windows wrote a backslash path plus JSON.stringify quotes;
    // PowerShell mangles that, so the proxy never starts and every session
    // hangs with nothing in the log. Reinstalling after the fix has to repair
    // the settings file the old release left behind.
    const stale = { hooks: [{ type: "command", command: 'D:\\Dev\\node\\node.exe "D:\\bili\\dist\\claude-native-bootstrap.js"' }] };
    const current = "D:/Dev/node/node.exe D:/bili/dist/claude-native-bootstrap.js";
    const { data, notes } = applyClaudeManagedBlock({ hooks: { SessionStart: [stale] } }, { baseUrl: baseUrlForPort(48787), hookCommand: current });
    const entries = (data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(entries.length, 1);
    assert.deepEqual((entries[0] as { hooks: Array<{ command: string }> }).hooks, [{ type: "command", command: current }]);
    assert.ok(notes.some((n) => n.includes("refreshed")));
});

test("stripClaudeManagedBlock: round-trip removes ours, keeps user keys", () => {
    const userEnv = { CUSTOM: "x" };
    const userEntry = { hooks: [{ type: "command", command: "echo hi" }] };
    const applied = applyClaudeManagedBlock(
        { env: { ...userEnv }, hooks: { SessionStart: [userEntry], PreCompact: [userEntry] } },
        { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND, vertexBaseUrl: "http://127.0.0.1:48787/bili/anthropic/https://aiplatform.googleapis.com/v1" },
    );
    const { data, removed } = stripClaudeManagedBlock(applied.data);
    assert.deepEqual(removed.sort(), ["env.DISABLE_AUTO_COMPACT", "env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_VERTEX_BASE_URL", "hooks.SessionStart entry"].sort());
    assert.deepEqual(data.env, userEnv);
    assert.deepEqual((data.hooks as Record<string, unknown[]>).SessionStart, [userEntry]);
    assert.ok((data.hooks as Record<string, unknown>).PreCompact);
});

test("stripClaudeManagedBlock: empty containers are dropped, foreign values survive", () => {
    const applied = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const { data, removed } = stripClaudeManagedBlock(applied.data);
    assert.equal(removed.length, 3);
    assert.equal("env" in data, false);
    assert.equal("hooks" in data, false);
    const foreign = stripClaudeManagedBlock({ env: { ANTHROPIC_BASE_URL: "https://relay.example" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo" }] }] } });
    assert.equal(foreign.removed.length, 0);
    assert.deepEqual(foreign.data.env, { ANTHROPIC_BASE_URL: "https://relay.example" });
});

// — URL/port helpers ————————————————————————————————————————————

test("isBiliClaudeBaseUrl: only loopback /bili/ wraps match", () => {
    assert.equal(isBiliClaudeBaseUrl(baseUrlForPort(48787)), true);
    assert.equal(isBiliClaudeBaseUrl("http://127.0.0.1:8787/bili/https://relay.example"), true);
    assert.equal(isBiliClaudeBaseUrl("https://api.anthropic.com"), false);
    assert.equal(isBiliClaudeBaseUrl("http://127.0.0.1:8787/v1"), false);
    assert.equal(isBiliClaudeBaseUrl(undefined), false);
});

test("claudeNativeBaseUrl: default wraps api.anthropic.com; BILI_CLAUDE_UPSTREAM wraps the relay", () => {
    const prev = process.env.BILI_CLAUDE_UPSTREAM;
    const prevPort = process.env.BILI_CLAUDE_NATIVE_PORT;
    try {
        delete process.env.BILI_CLAUDE_UPSTREAM;
        delete process.env.BILI_CLAUDE_NATIVE_PORT;
        // #1660: no explicit override → the claude lane's zone preference
        // (sticky record > 18787 base) — readZonePort has no record in tests.
        assert.equal(claudeNativeBaseUrl().includes(`/bili/https://api.anthropic.com`), true);
        assert.equal(claudeNativeBaseUrl(), `http://127.0.0.1:${ZONE_BAND_BASE}/bili/https://api.anthropic.com`);
        process.env.BILI_CLAUDE_UPSTREAM = "https://relay.example/";
        assert.equal(claudeNativeBaseUrl(), `http://127.0.0.1:${ZONE_BAND_BASE}/bili/https://relay.example`);
    } finally {
        if (prev === undefined) delete process.env.BILI_CLAUDE_UPSTREAM;
        else process.env.BILI_CLAUDE_UPSTREAM = prev;
        if (prevPort === undefined) delete process.env.BILI_CLAUDE_NATIVE_PORT;
        else process.env.BILI_CLAUDE_NATIVE_PORT = prevPort;
    }
});

test("claudeNativeBaseUrlForOrigin: wraps an arbitrary origin; explicit upstream preserved (#1660)", () => {
    assert.equal(claudeNativeBaseUrlForOrigin("http://127.0.0.1:18788", undefined, {}), "http://127.0.0.1:18788/bili/https://api.anthropic.com");
    assert.equal(claudeNativeBaseUrlForOrigin("http://127.0.0.1:18788/", "https://relay.example/", {}), "http://127.0.0.1:18788/bili/https://relay.example");
    assert.equal(claudeNativeBaseUrlForOrigin("http://127.0.0.1:18788", "https://api.anthropic.com", { BILI_CLAUDE_UPSTREAM: "https://env.example" }), "http://127.0.0.1:18788/bili/https://api.anthropic.com");
    // already-wrapped input is not double-wrapped
    assert.equal(claudeNativeBaseUrlForOrigin("http://127.0.0.1:18788", "http://127.0.0.1:18788/bili/https://api.anthropic.com", {}), "http://127.0.0.1:18788/bili/https://api.anthropic.com");
});

test("unwrapBiliBaseUrl: strips any loopback-port wrapper; foreign values untouched (#1660)", () => {
    assert.equal(unwrapBiliBaseUrl("http://127.0.0.1:48787/bili/https://api.anthropic.com"), "https://api.anthropic.com");
    assert.equal(unwrapBiliBaseUrl("http://127.0.0.1:18788/bili/https://relay.example"), "https://relay.example");
    assert.equal(unwrapBiliBaseUrl("https://api.anthropic.com"), undefined);
    assert.equal(unwrapBiliBaseUrl("http://127.0.0.1:8787/v1"), undefined);
});

test("resolveClaudeNativePort: env only, undefined without an explicit override (#1660)", () => {
    assert.equal(resolveClaudeNativePort({}), undefined);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "49999" }), 49999);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "0" }), undefined);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "not-a-number" }), undefined);
});

// #1335: the attach-gate escape hatch — env BILI_NATIVE_ATTACH_EXTERNAL wins
// over the config file's native.attachExternal; the file value must be exactly
// true (garbage leaves the gate closed); default false.
test("resolveNativeAttachExternal: env parsing (1/true open, 0/false close, junk falls through)", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-attachext-"));
    process.env.XDG_CONFIG_HOME = dir;
    try {
        assert.equal(resolveNativeAttachExternal({}), false, "no env, no file → gate closed");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "" }), false, "blank env falls through to file");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "1" }), true);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "true" }), true);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: " TRUE " }), true, "case-insensitive and trimmed");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "0" }), false);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "false" }), false);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "yes" }), false, "junk env is not a truthy answer");
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        rmrf(dir);
    }
});

test("resolveNativeAttachExternal: file native.attachExternal requires exact true; env still wins", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-attachext-"));
    const cfgDir = path.join(dir, "billion-context");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "billion-context.json");
    process.env.XDG_CONFIG_HOME = dir;
    try {
        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachExternal: true } }));
        assert.equal(resolveNativeAttachExternal({}), true, "file opens the gate");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "0" }), false, "env 0 overrides a permissive file");

        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachExternal: "true" } }));
        assert.equal(resolveNativeAttachExternal({}), false, "string 'true' in the file is not a boolean true");

        fs.writeFileSync(cfgFile, "{ not json");
        assert.equal(resolveNativeAttachExternal({}), false, "malformed file degrades to gate-closed, never throws");

        fs.rmSync(cfgFile);
        assert.equal(resolveNativeAttachExternal({}), false, "absent file → default false");
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        rmrf(dir);
    }
});

test("resolveNativeAttachLanePriority: ordered unique list; garbage degrades to [] (#2905)", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-laneprio-"));
    const cfgDir = path.join(dir, "billion-context");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "billion-context.json");
    process.env.XDG_CONFIG_HOME = dir;
    try {
        assert.deepEqual(resolveNativeAttachLanePriority(), [], "absent file → no foreign lanes");
        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachLanePriority: [" dsh ", "opencode", "dsh", 7, null] } }));
        assert.deepEqual(resolveNativeAttachLanePriority(), ["dsh", "opencode"], "trimmed, order preserved, duplicates dropped, non-strings skipped");
        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachLanePriority: "dsh" } }));
        assert.deepEqual(resolveNativeAttachLanePriority(), [], "non-array degrades to [] — never a lone string");
        fs.writeFileSync(cfgFile, "{ not json");
        assert.deepEqual(resolveNativeAttachLanePriority(), [], "malformed file degrades to [], never throws");
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        rmrf(dir);
    }
});

// #2877: discovery policy + explicit target — env wins over the config file;
// default "own-lane" (a LANEd hook rides only its own lane, else spawns);
// attachUrl unset unless an explicit origin is pinned.
test("resolveNativeAttachPolicy: default own-lane; env/file select global-fallback", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-attachpol-"));
    const cfgDir = path.join(dir, "billion-context");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "billion-context.json");
    process.env.XDG_CONFIG_HOME = dir;
    try {
        assert.equal(resolveNativeAttachPolicy({}), "own-lane", "no env, no file → own-lane default");
        assert.equal(resolveNativeAttachPolicy({ BILI_NATIVE_ATTACH_POLICY: "global-fallback" }), "global-fallback");
        assert.equal(resolveNativeAttachPolicy({ BILI_NATIVE_ATTACH_POLICY: "GLOBAL-FALLBACK" }), "global-fallback", "case-insensitive + trimmed");
        assert.equal(resolveNativeAttachPolicy({ BILI_NATIVE_ATTACH_POLICY: "global" }), "global-fallback", "shorthand alias");
        assert.equal(resolveNativeAttachPolicy({ BILI_NATIVE_ATTACH_POLICY: "own-lane" }), "own-lane");
        assert.equal(resolveNativeAttachPolicy({ BILI_NATIVE_ATTACH_POLICY: "strict" }), "own-lane", "strict == own-lane");
        assert.equal(resolveNativeAttachPolicy({ BILI_NATIVE_ATTACH_POLICY: "bogus" }), "own-lane", "junk env falls back to default");

        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachPolicy: "global-fallback" } }));
        assert.equal(resolveNativeAttachPolicy({}), "global-fallback", "file selects global-fallback");
        assert.equal(resolveNativeAttachPolicy({ BILI_NATIVE_ATTACH_POLICY: "strict" }), "own-lane", "env wins over file");

        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachPolicy: "nonsense" } }));
        assert.equal(resolveNativeAttachPolicy({}), "own-lane", "junk file value → default own-lane");

        fs.rmSync(cfgFile);
        assert.equal(resolveNativeAttachPolicy({}), "own-lane", "absent file → default own-lane");
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        rmrf(dir);
    }
});

test("resolveNativeAttachUrl: env BILI_MCP_PROXY wins over file native.attachUrl; blank → unset", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-attachurl-"));
    const cfgDir = path.join(dir, "billion-context");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "billion-context.json");
    process.env.XDG_CONFIG_HOME = dir;
    try {
        assert.equal(resolveNativeAttachUrl({}), undefined, "no env, no file → unset (discover)");
        assert.equal(resolveNativeAttachUrl({ BILI_MCP_PROXY: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999", "env pin");
        assert.equal(resolveNativeAttachUrl({ BILI_MCP_PROXY: "   " }), undefined, "blank env → unset");

        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachUrl: "http://remote.example:8787" } }));
        assert.equal(resolveNativeAttachUrl({}), "http://remote.example:8787", "file value used when env absent");
        assert.equal(resolveNativeAttachUrl({ BILI_MCP_PROXY: "http://127.0.0.1:18788" }), "http://127.0.0.1:18788", "env wins over file");

        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachUrl: "   " } }));
        assert.equal(resolveNativeAttachUrl({}), undefined, "whitespace file value → unset");

        fs.rmSync(cfgFile);
        assert.equal(resolveNativeAttachUrl({}), undefined, "absent file → unset");
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        rmrf(dir);
    }
});

// — hook planner ————————————————————————————————————————————

test("planClaudeNativeBootstrap: launcher-owned / opt-out / start", () => {
    assert.deepEqual(planClaudeNativeBootstrap({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:39000" }).action, "exit");
    assert.deepEqual(planClaudeNativeBootstrap({ BILI_PROVIDER_REWRITES: "x" }).action, "exit");
    assert.deepEqual(planClaudeNativeBootstrap({ BILI_NATIVE_CLAUDE: "0" }).action, "passthrough");
    assert.deepEqual(planClaudeNativeBootstrap({ BILLION_CONTEXT_PLUGIN: "0" }).action, "passthrough");
    // #1660: no explicit override → zone preference, non-strict launch.
    const start = planClaudeNativeBootstrap({});
    assert.deepEqual(start, { action: "start", port: ZONE_PORT_BASE, strict: false });
    // explicit override → same port, strict-port (#964 preserved).
    assert.deepEqual(planClaudeNativeBootstrap({ BILI_CLAUDE_NATIVE_PORT: "49999" }), { action: "start", port: 49999, strict: true });
});

// — claude host pid resolution (parent-gone regression) —————————————————

// Live shape (claude 2.1.278, SessionStart): the hook's direct parent is a
// TRANSIENT `/bin/sh -c` wrapper; the claude session sits one level above it.
function procTable(table: Record<number, { argv?: string[]; ppid?: number }>): (pid: number) => { argv: string[] | null; ppid: number | null } | null {
    return (pid) => {
        const entry = table[pid];
        if (entry === undefined) return null;
        return { argv: entry.argv ?? null, ppid: entry.ppid ?? null };
    };
}

test("resolveClaudeHostPid: walks past the transient sh wrapper to claude", () => {
    const read = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 200 },
        200: { argv: ["/bin/sh", "-c", "node /pkg/dist/claude-native-bootstrap.js"], ppid: 300 },
        300: { argv: ["/usr/local/bin/claude", "-p", "hi"], ppid: 400 },
        400: { argv: ["/bin/bash"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read, startPid: 100 }), 300);
});

test("resolveClaudeHostPid: matches npm/node installs and skips zombie wrappers", () => {
    // node-form install: node .../@anthropic-ai/claude-code/cli.js
    const npmInstall = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 110 },
        110: { argv: ["/bin/sh", "-c", "node hook"], ppid: 120 },
        120: { argv: [process.execPath, "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read: npmInstall, startPid: 100 }), 120);

    // The wrapper may linger as a zombie (empty cmdline) — the walk must
    // continue through it instead of giving up.
    const zombieSh = procTable({
        100: { ppid: 110 },
        110: { argv: [], ppid: 120 },
        120: { argv: ["claude"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read: zombieSh, startPid: 100 }), 120);
});

test("resolveClaudeHostPid: no claude host in range → undefined (caller keeps legacy parent)", () => {
    // `timeout 40 claude ...` runs claude, but a bare timeout tree WITHOUT a
    // claude entry must not match, and neither must the wrapper chain itself.
    const noClaude = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 200 },
        200: { argv: ["/bin/sh", "-c", "node /pkg/dist/claude-native-bootstrap.js"], ppid: 300 },
        300: { argv: ["timeout", "40", "claude", "-p", "hi"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read: noClaude, startPid: 100 }), undefined);

    // Dead parent mid-walk, and a chain deeper than the walk budget.
    assert.equal(resolveClaudeHostPid({ read: procTable({ 100: { argv: ["node"], ppid: 200 } }), startPid: 100 }), undefined);
    const deep: Record<number, { argv: string[]; ppid: number }> = {};
    for (let i = 0; i < 30; i++) deep[100 + i] = { argv: ["proc", String(i)], ppid: 101 + i };
    deep[999] = { argv: ["claude"], ppid: 1 };
    assert.equal(resolveClaudeHostPid({ read: procTable(deep), startPid: 100 }), undefined);
});

test("resolveClaudeHostPid: the closer REAL claude beats a lookalike farther up", () => {
    // `node /opt/claude` is not claude-code, but the walk is bottom-up and
    // the real claude is always nearer the hook in a live session — a
    // lookalike above it must never hijack the watchdog.
    const read = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 200 },
        200: { argv: ["/bin/sh", "-c", "node hook"], ppid: 300 },
        300: { argv: ["/usr/local/bin/claude"], ppid: 400 },
        400: { argv: [process.execPath, "/opt/claude"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read, startPid: 100 }), 300);
});

// — watchdog parent choice (no-host fallback) ——————————————————————————

test("isTransientShArgv: sh-like one-shots only", () => {
    assert.equal(isTransientShArgv(["sh", "-c", "node hook"]), true);
    assert.equal(isTransientShArgv(["/bin/bash", "-lc", "cmd"]), true);
    assert.equal(isTransientShArgv(["zsh", "-i"]), false);
    assert.equal(isTransientShArgv(["node", "-c", "x"]), false);
    assert.equal(isTransientShArgv(["sh", "--check", "x"]), false);
    // Windows wrapper shapes (claude runs hooks via cmd /c there).
    assert.equal(isTransientShArgv(["C:\\Windows\\System32\\cmd.exe", "/c", "node hook"]), true);
    assert.equal(isTransientShArgv(["cmd.exe", "/C", "node hook"]), true);
    assert.equal(isTransientShArgv(["cmd.exe", "/k", "node hook"]), false); // /k stays open
    assert.equal(isTransientShArgv(["powershell.exe", "-NoProfile", "-Command", "node hook"]), true);
    assert.equal(isTransientShArgv(["pwsh", "-Command", "node hook"]), true);
    assert.equal(isTransientShArgv(["powershell.exe", "-NoProfile"]), false); // interactive
});

test("chooseWatchdogParentPid: host found → the host", () => {
    const read = procTable({
        [process.pid]: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 500 },
        500: { argv: ["/bin/sh", "-c", "node hook"], ppid: 700 },
        700: { argv: ["claude"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read, parentPid: 500 }), 700);
});

test("chooseWatchdogParentPid: no host + transient sh parent → the wrapper's parent (unrecognized claude)", () => {
    // Exotic install form the matcher missed: the grandparent IS claude —
    // watching it keeps the session alive with the correct lifetime, instead
    // of re-arming the 2s self-kill on the transient wrapper.
    const read = procTable({
        [process.pid]: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 500 },
        500: { argv: ["/bin/sh", "-c", "node hook"], ppid: 600 },
        600: { argv: ["/opt/weird-claude-launcher"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read, parentPid: 500 }), 600);
});

test("chooseWatchdogParentPid: no host + non-transient/unreadable parent → legacy direct parent", () => {
    // Interactive shell (manual run) — old behavior is the right behavior.
    const interactive = procTable({
        [process.pid]: { argv: ["node", "hook"], ppid: 500 },
        500: { argv: ["/bin/zsh", "-i"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read: interactive, parentPid: 500 }), 500);
    // Wrapper parent whose own parent is init (no grandparent to watch).
    const orphanSh = procTable({
        [process.pid]: { argv: ["node", "hook"], ppid: 500 },
        500: { argv: ["sh", "-c", "node hook"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read: orphanSh, parentPid: 500 }), 500);
    // Process table unreadable (hidepid / missing ps) — strictly no worse.
    const blind = procTable({ [process.pid]: { argv: ["node", "hook"], ppid: 800 } });
    assert.equal(chooseWatchdogParentPid({ read: blind, parentPid: 800 }), 800);
});

test("isClaudeHostArgv: exact matches only — never the hook itself or lookalikes", () => {
    assert.equal(isClaudeHostArgv(["claude"]), true);
    assert.equal(isClaudeHostArgv(["claude", "-p", "hi"]), true);
    assert.equal(isClaudeHostArgv(["claude.exe", "--resume"]), true);
    assert.equal(isClaudeHostArgv([process.execPath, "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]), true);
    assert.equal(isClaudeHostArgv([process.execPath, "--import", "tsx", "/src/claude"]), true);
    // The hook's own script must never match (basename differs from `claude`).
    assert.equal(isClaudeHostArgv([process.execPath, "/pkg/dist/claude-native-bootstrap.js"]), false);
    assert.equal(isClaudeHostArgv([process.execPath, "/pkg/src/claude-native-bootstrap.ts"]), false);
    // Wrappers and lookalikes: argv[0] is not claude.
    assert.equal(isClaudeHostArgv(["timeout", "40", "claude", "-p", "hi"]), false);
    assert.equal(isClaudeHostArgv(["/bin/sh", "-c", "claude"]), false);
    assert.equal(isClaudeHostArgv(["claude-doctor"]), false);
    assert.equal(isClaudeHostArgv(["claudeworkflow"]), false);
    // node with unrelated args must not match just because `claude` appears
    // inside a longer path/argument.
    assert.equal(isClaudeHostArgv([process.execPath, "/home/x/claude-notes/server.js"]), false);
});

// — ps / powershell process readers (non-linux fallback) ———————————————————

// #2441: both readers below go through defaultExec — pin the shared options so
// a future "simplification" cannot drop windowsHide (the PowerShell fallback is
// the closest analog of the #2439 console flash; ps on POSIX is a no-op).
test("procTableExecOptions: spawns hidden (GUI hosts flash a console otherwise)", () => {
    const opts = procTableExecOptions();
    assert.equal(opts.windowsHide, true, "an unhidden console child makes Windows allocate a console window");
    assert.equal(opts.encoding, "utf8");
    assert.equal(opts.timeout, 5000);
    // #2834: explicit stdio keeps a failed probe's stderr off the host terminal.
    assert.deepEqual([...opts.stdio], ["ignore", "pipe", "ignore"]);
});

// ps prints "<ppid> <joined args>"; whitespace-splitting can only LOSE a
// match (paths with spaces), never invent one.
test("readPsProcInfo: parses '<ppid> <args>' lines, degrades to null", () => {
    const fakePs = (table: Record<number, string | null>) => (cmd: string, args: string[]): string | null => {
        assert.equal(cmd, "ps");
        assert.deepEqual(args.slice(0, -1), ["-ww", "-o", "ppid=", "-o", "args=", "-p"]);
        return table[Number(args[args.length - 1])] ?? null;
    };
    const ps = fakePs({
        300: "  7654 /usr/local/bin/claude -p hi\n",
        310: "5678 \n",
        320: "",
    });
    assert.deepEqual(readPsProcInfo(300, ps), { argv: ["/usr/local/bin/claude", "-p", "hi"], ppid: 7654 });
    // No visible args (zombie/protected) — argv null, ppid chain still walks.
    assert.deepEqual(readPsProcInfo(310, ps), { argv: null, ppid: 5678 });
    // Empty output or a failed ps run both mean "pid gone".
    assert.equal(readPsProcInfo(320, ps), null);
    assert.equal(readPsProcInfo(999, ps), null);
    // A garbage ppid column must not crash the walk (ppid null, argv kept).
    assert.deepEqual(readPsProcInfo(330, fakePs({ 330: "NaN claude\n" })), { argv: ["claude"], ppid: null });
});

// PowerShell emits "<ppid>\t<CommandLine>" in one Get-CimInstance call
// (ps/wmic are deprecated or absent on windows).
test("readWinProcInfo: parses '<ppid>\\t<commandline>', degrades to null", () => {
    const fakePs1 = (out: string | null) => (_cmd: string, _args: string[]): string | null => out;
    assert.deepEqual(
        readWinProcInfo(300, fakePs1("300\tC:\\n.exe C:\\x\\claude.exe\r\n")),
        { argv: ["C:\\n.exe", "C:\\x\\claude.exe"], ppid: 300 },
    );
    // Protected process: empty CommandLine — argv null, ppid kept.
    assert.deepEqual(readWinProcInfo(300, fakePs1("300\t\n")), { argv: null, ppid: 300 });
    // Empty output, or error text without a tab, both degrade to null.
    assert.equal(readWinProcInfo(300, fakePs1("")), null);
    assert.equal(readWinProcInfo(300, fakePs1("Get-CimInstance : object not found\n")), null);
    assert.equal(readWinProcInfo(300, fakePs1(null)), null);
});

// #1388: Win32_Process quotes CommandLines whose paths contain spaces; a
// naive whitespace split shreds the host path and the watchdog match fails.
test("readWinProcInfo: quoted host path with spaces survives as one token (#1388)", () => {
    const fakePs1 = (out: string | null) => (_cmd: string, _args: string[]): string | null => out;
    // Reporter-verified shape: "C:\Program Files\...\opencode.exe" --flag hello world
    assert.deepEqual(
        readWinProcInfo(300, fakePs1('300\t"C:\\Program Files\\Apps\\opencode\\opencode.exe" --flag hello world\r\n')),
        { argv: ["C:\\Program Files\\Apps\\opencode\\opencode.exe", "--flag", "hello", "world"], ppid: 300 },
    );
    // Quotes around a space-free path (what #1381's stripQuotes handled at the
    // matching side) must parse identically.
    assert.deepEqual(
        readWinProcInfo(300, fakePs1('300\t"C:\\n.exe" C:\\x\\claude.exe\r\n')),
        { argv: ["C:\\n.exe", "C:\\x\\claude.exe"], ppid: 300 },
    );
});

// CommandLineToArgvW semantics: grouping quotes + the 2n/2n+1 backslash rule.
test("splitWindowsCommandLine: quotes group, backslashes escape (#1388)", () => {
    // Backslash rules: literal before a space/end-of-line; 2n-before-quote
    // collapses to n and the quote toggles grouping; 2n+1-before-quote
    // collapses to n plus a literal quote. String.raw keeps the counted
    // characters visible.
    assert.deepEqual(splitWindowsCommandLine(String.raw`a\\ b`), [String.raw`a\\`, "b"]);
    assert.deepEqual(splitWindowsCommandLine(String.raw`a\" b`), ['a"', "b"]);
    assert.deepEqual(splitWindowsCommandLine(String.raw`a\\\\`), [String.raw`a\\\\`]);
    // Empty quoted segment is a real token ("" arg).
    assert.deepEqual(splitWindowsCommandLine('"" x'), ["", "x"]);
    // Tokens are unquoted; inner spaces survive inside quotes.
    assert.deepEqual(splitWindowsCommandLine('"two words" x'), ["two words", "x"]);
    // Conservation: re-joining with quotes around space-bearing tokens
    // reproduces the original shell meaning (no token lost or invented).
    const line = '"C:\\Program Files\\o\\o.exe" --flag "two words"';
    const argv = splitWindowsCommandLine(line);
    assert.equal(argv.length, 3);
    assert.equal(argv[0], "C:\\Program Files\\o\\o.exe");
    assert.equal(argv[2], "two words");
});

test("resolveClaudeHostPid: full walk over a ps-backed table", () => {
    // Same tree as the /proc test, but reached through readPsProcInfo's
    // parsing instead of an injected ProcReader.
    const lines: Record<number, string | null> = {
        100: "200 node /pkg/dist/claude-native-bootstrap.js",
        200: "300 /bin/sh -c node /pkg/dist/claude-native-bootstrap.js",
        300: "400 /usr/local/bin/claude -p hi",
    };
    const psRead = (pid: number) => readPsProcInfo(pid, (_cmd, _args) => lines[pid] ?? null);
    assert.equal(resolveClaudeHostPid({ read: psRead, startPid: 100 }), 300);
});

// #2242: Node picks an extensionless entry's module system from the NEAREST
// package.json. When TMPDIR sits inside this repo's workspace tree that is
// the root manifest ("type":"module") and the CJS fake-claude fixtures below
// die with `require is not defined in ES module scope`. Pin CJS beside each
// fixture instead of renaming to .cjs — the resolver under test matches the
// exact basename `claude` (src/claude-native-bootstrap.ts:245), so the script
// name must not change.
function pinCommonJs(dir: string): void {
    fs.writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
}

// Live mechanism check for the fallback path: a real `ps` subprocess, real
// ppid chain, real match — everything except /proc itself.
test("resolveClaudeHostPid: live ps walk finds a spawned claude host", { timeout: 30_000, skip: LIVE_E2E ? process.platform === "win32" : liveSkip }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ps-live-"));
    const claudeBin = path.join(dir, "claude");
    const pidFile = path.join(dir, "child.pid");
    // Node-shebang fake claude (argv[0] is `node`, script basename `claude`)
    // spawning a leaf through the same sh -c wrapper shape as SessionStart.
    fs.writeFileSync(claudeBin, [
        "#!/usr/bin/env node",
        `const { spawn } = require("node:child_process");`,
        `const fs = require("node:fs");`,
        `const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        `setInterval(() => {}, 1 << 30);`,
        "",
    ].join("\n"));
    fs.chmodSync(claudeBin, 0o755);
    pinCommonJs(dir);
    let leafPid = 0;
    let claude: ReturnType<typeof spawn> | null = null;
    try {
        claude = spawn(claudeBin, [], { stdio: "ignore" });
        for (let waited = 0; !fs.existsSync(pidFile); waited += 100) {
            if (waited > 10_000) assert.fail("leaf pid file never appeared");
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        leafPid = Number(fs.readFileSync(pidFile, "utf8"));
        // One hop up from the leaf must reach the fake claude via REAL ps.
        assert.equal(resolveClaudeHostPid({ read: (pid) => readPsProcInfo(pid), startPid: leafPid }), claude.pid);
        // A pid that cannot exist must read as gone, not crash.
        assert.equal(readPsProcInfo(999_999_999), null);
    } finally {
        rmrf(dir);
        if (claude !== null && claude.pid !== undefined && claude.pid > 1) {
            try {
                process.kill(claude.pid, "SIGKILL");
            } catch {
                // already gone (e.g. OOM-killed mid-test on a loaded box)
            }
        }
        if (leafPid > 1) {
            try {
                process.kill(leafPid, "SIGKILL");
            } catch {
                // already gone
            }
        }
    }
});

// — installer round-trip (fake claude CLI + sandboxed config dir) ———————

function fakeClaude(dir: string): string {
    const isWin = process.platform === "win32";
    const script = path.join(dir, isWin ? "claude-fake.cmd" : "claude-fake");
    fs.writeFileSync(script, isWin ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (!isWin) fs.chmodSync(script, 0o755);
    return script;
}

function sandbox(): { dir: string; settings: string; mcpJson: string; biliConfig: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    // #1660: install no longer persists claude.nativePort, but the bili
    // config path is still sandboxed so tests never touch the real user
    // config (loadConfigFile reads it for other keys).
    const biliConfig = path.join(dir, "billion-context.json");
    process.env.BILI_CONFIG_FILE = biliConfig;
    return { dir, settings: path.join(dir, "settings.json"), mcpJson: path.join(dir, ".claude.json"), biliConfig };
}

function unsandbox(prev: string | undefined, prevCfg: string | undefined = process.env.BILI_CONFIG_FILE): void {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    if (prevCfg === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = prevCfg;
}

test("claudeSettingsFile: CLAUDE_CONFIG_DIR replaces the whole .claude dir", () => {
    assert.equal(claudeSettingsFile({ CLAUDE_CONFIG_DIR: "/tmp/cc" }), path.join("/tmp/cc", "settings.json"));
});

test("resolveClaudeCli: bare names resolve via where.exe on Windows, untouched elsewhere", () => {
    // Paths and names with extensions pass through untouched, every platform.
    assert.equal(resolveClaudeCli("/usr/local/bin/claude"), "/usr/local/bin/claude");
    assert.equal(resolveClaudeCli("C:\\x\\claude.cmd"), "C:\\x\\claude.cmd");
    if (process.platform !== "win32") {
        // Bare names pass through off-Windows (no PATHEXT problem there).
        assert.equal(resolveClaudeCli("claude"), "claude");
    }
    // #1445: drive the resolution against fixture resolver output instead of
    // spawning the real where.exe — a real spawn finishing inside the 5s
    // timeout is scheduler luck on loaded shared runners (flaked CI twice).
    const where = (stdout: string | null) => () => ({ stdout });
    assert.equal(
        resolveClaudeCli("claude", where("C:\\tools\\nodejs\\claude.cmd\r\nC:\\other\\claude.exe\n")),
        "C:\\tools\\nodejs\\claude.cmd",
    );
    // #1902: npm's global dir lists the extensionless POSIX shim FIRST — Node
    // cannot spawn it (ENOENT), so the .cmd must win over list position.
    assert.equal(
        resolveClaudeCli(
            "claude",
            where("C:\\Users\\u\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\u\\AppData\\Roaming\\npm\\claude.ps1\n"),
        ),
        "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd",
    );
    // Within one directory PATHEXT order decides: a real .exe outranks the shim.
    assert.equal(
        resolveClaudeCli("claude", where("C:\\bin\\claude\r\nC:\\bin\\claude.cmd\r\nC:\\bin\\claude.exe\n")),
        "C:\\bin\\claude.exe",
    );
    // PATH order still beats extension: an earlier dir's .cmd wins over a later dir's .exe.
    assert.equal(
        resolveClaudeCli("claude", where("C:\\first\\claude.cmd\r\nC:\\second\\claude.exe\n")),
        "C:\\first\\claude.cmd",
    );
    // Nothing carries a PATHEXT extension → old first-hit behavior stands.
    assert.equal(resolveClaudeCli("claude", where("C:\\x\\claude\r\nC:\\y\\claude.ps1\n")), "C:\\x\\claude");
    // Injectable PATHEXT for exotic environments/tests.
    assert.equal(resolveClaudeCli("claude", where("C:\\x\\claude\r\nC:\\x\\claude.ps1\n"), ".PS1;.CMD"), "C:\\x\\claude.ps1");
    assert.equal(resolveClaudeCli("claude", where("\r\n   \n")), "claude");
    assert.equal(resolveClaudeCli("claude", where(null)), "claude");
    assert.equal(resolveClaudeCli("claude", () => { throw new Error("where.exe ETIMEDOUT"); }), "claude");
});

test("installer round-trip: managed block + MCP face, then removal restores", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        assert.equal(claudeNativeInstalled(), false);

        const note = pluginInstall("claude");
        assert.ok(note.includes("managed block"), note);
        assert.ok(fs.existsSync(box.settings));
        const after = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string>; hooks?: unknown };
        // #1660: no explicit port → the zone base is baked.
        assert.equal(after.env?.ANTHROPIC_BASE_URL, baseUrlForPort(ZONE_BAND_BASE));
        assert.equal(after.env?.DISABLE_AUTO_COMPACT, "1");
        assert.equal(claudeNativeInstalled(), true);
        // #1902: the emitted hook must carry a bare `node` head — parseable by
        // whichever shell Claude Code runs hooks through (cmd on 2.1.284,
        // PowerShell on 2.1.282), never a spaced absolute node path.
        const hookEntries = (after.hooks as { SessionStart?: Array<{ hooks: Array<{ type: string; command: string }> }> })?.SessionStart ?? [];
        assert.equal(hookEntries.length, 1);
        const hookCmd = hookEntries[0].hooks[0].command;
        assert.ok(hookCmd.startsWith("node "), hookCmd);
        assert.ok(hookCmd.endsWith("claude-native-bootstrap.js"), hookCmd);
        // #1660: install no longer persists claude.nativePort — the hook
        // resolves the same zone preference, and its repin pass follows any
        // drift. The bili config may not even exist.
        assert.equal(fs.existsSync(box.biliConfig), false);

        const removeNote = pluginRemove("claude");
        assert.ok(removeNote.includes("managed block removed"), removeNote);
        const restored = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: unknown; hooks?: unknown };
        assert.equal(restored.env, undefined);
        assert.equal(restored.hooks, undefined);
        assert.equal(claudeNativeInstalled(), false);
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("claudeAcpCacheCommandFile: CLAUDE_CONFIG_DIR replaces the whole .claude dir (#1146)", () => {
    assert.equal(claudeAcpCacheCommandFile({ CLAUDE_CONFIG_DIR: "/tmp/cc" }), path.join("/tmp/cc", "commands", "acp-cache.md"));
});

test("installer writes and removes the model-mediated /acp-cache command file (#1146)", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        const note = pluginInstall("claude");
        const cmdFile = claudeAcpCacheCommandFile(process.env);
        assert.equal(cmdFile, path.join(box.dir, "commands", "acp-cache.md"));
        assert.ok(note.includes(`/acp-cache command -> ${cmdFile} (written)`), note);
        assert.equal(fs.readFileSync(cmdFile, "utf8"), CLAUDE_ACP_CACHE_COMMAND);

        const removeNote = pluginRemove("claude");
        assert.ok(removeNote.includes("/acp-cache command removed"), removeNote);
        assert.equal(fs.existsSync(cmdFile), false);
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer leaves a foreign acp-cache.md untouched on install and removal (#1146)", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        const cmdFile = claudeAcpCacheCommandFile(process.env);
        fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
        fs.writeFileSync(cmdFile, "foreign content");
        const note = pluginInstall("claude");
        assert.ok(note.includes("(left untouched (foreign content))"), note);
        assert.equal(fs.readFileSync(cmdFile, "utf8"), "foreign content");
        const removeNote = pluginRemove("claude");
        assert.ok(removeNote.includes("/acp-cache command left untouched"), removeNote);
        assert.equal(fs.readFileSync(cmdFile, "utf8"), "foreign content");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer preserves foreign settings.json keys end-to-end", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        fs.writeFileSync(box.settings, JSON.stringify({ permissions: { allow: ["Bash"] }, env: { THEME: "dark" } }, null, 2));
        pluginInstall("claude");
        assert.ok(fs.existsSync(`${box.settings}.bili-bak`), "pre-install snapshot of an existing settings file");
        const after = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { permissions?: unknown; env?: Record<string, string> };
        assert.deepEqual(after.permissions, { allow: ["Bash"] });
        assert.equal(after.env?.THEME, "dark");
        pluginRemove("claude");
        const restored = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { permissions?: unknown; env?: Record<string, string> };
        assert.deepEqual(restored.permissions, { allow: ["Bash"] });
        assert.deepEqual(restored.env, { THEME: "dark" });
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("install with an explicit port bakes it; without env the hook rides the zone (#1660)", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const prevPortEnv = process.env.BILI_CLAUDE_NATIVE_PORT;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        // Live failure shape (#964): install with an explicit port, then
        // claude later runs the hook WITHOUT that env (claude does not inject
        // its settings.env into hook children). #1660: there is no persisted
        // copy anymore — without the env the hook resolves the zone
        // preference (non-strict), and its SessionStart repin pass rewrites
        // the baked URL to the live origin so the two can never stay desynced.
        process.env.BILI_CLAUDE_NATIVE_PORT = "49999";
        pluginInstall("claude");
        const settings = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string> };
        assert.equal(settings.env?.ANTHROPIC_BASE_URL, baseUrlForPort(49999));
        assert.equal(fs.existsSync(box.biliConfig), false, "no claude.nativePort persisted anymore");
        delete process.env.BILI_CLAUDE_NATIVE_PORT;
        // plan on a SANITIZED env copy: the dev/CI harness may itself run under
        // a bili proxy (BILLION_CONTEXT_PROXY / BILI_PROVIDER_REWRITES force
        // "exit"), and a fresh XDG_STATE_HOME keeps the zone preference at the
        // base instead of following this machine's sticky record.
        const planEnv: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: path.join(box.dir, "state") };
        delete planEnv.BILLION_CONTEXT_PROXY;
        delete planEnv.BILI_PROVIDER_REWRITES;
        delete planEnv.BILI_NATIVE_CLAUDE;
        delete planEnv.BILLION_CONTEXT_PLUGIN;
        assert.deepEqual(planClaudeNativeBootstrap(planEnv), { action: "start", port: ZONE_BAND_BASE, strict: false }, "hook (no env) rides the zone, non-strict");
        pluginRemove("claude");
        assert.equal(claudeNativeInstalled(), false);
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
        if (prevPortEnv === undefined) delete process.env.BILI_CLAUDE_NATIVE_PORT;
        else process.env.BILI_CLAUDE_NATIVE_PORT = prevPortEnv;
    }
});

test("repinClaudeManagedBaseUrl: follows a drifted origin, preserves the relay, never touches a foreign URL (#1660)", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevUp = process.env.BILI_CLAUDE_UPSTREAM;
    const box = sandbox();
    try {
        delete process.env.BILI_CLAUDE_UPSTREAM;
        // A store left over from an install that baked 48787 + a custom relay.
        fs.writeFileSync(
            box.settings,
            JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:48787/bili/https://relay.example" } }),
            "utf8",
        );
        const notes = repinClaudeManagedBaseUrl("http://127.0.0.1:18788");
        const after = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string>; hooks?: { SessionStart?: unknown } };
        // The relay survives the repin; only the origin moves.
        assert.equal(after.env?.ANTHROPIC_BASE_URL, "http://127.0.0.1:18788/bili/https://relay.example");
        assert.ok(Array.isArray(after.hooks?.SessionStart), "the hook is upserted alongside");
        assert.ok(notes.length > 0);

        // Idempotent: a second repin to the same origin changes nothing and
        // returns no notes (no write either).
        const before = fs.readFileSync(box.settings, "utf8");
        const again = repinClaudeManagedBaseUrl("http://127.0.0.1:18788");
        assert.equal(again.length, 0);
        assert.equal(fs.readFileSync(box.settings, "utf8"), before);

        // A foreign base URL is never touched.
        fs.writeFileSync(box.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://corporate-gateway.example" } }), "utf8");
        repinClaudeManagedBaseUrl("http://127.0.0.1:18788");
        const foreign = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string> };
        assert.equal(foreign.env?.ANTHROPIC_BASE_URL, "https://corporate-gateway.example");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevUp === undefined) delete process.env.BILI_CLAUDE_UPSTREAM;
        else process.env.BILI_CLAUDE_UPSTREAM = prevUp;
    }
});

test("installer refuses under BILI_NATIVE_CLAUDE=0", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        process.env.BILI_NATIVE_CLAUDE = "0";
        assert.throws(() => pluginInstall("claude"), /refused/);
        assert.equal(fs.existsSync(box.settings), false);
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer refuses malformed settings.json instead of overwriting", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        fs.writeFileSync(box.settings, "{ not json");
        assert.throws(() => pluginInstall("claude"), /not valid JSON/);
        assert.equal(fs.readFileSync(box.settings, "utf8"), "{ not json", "file untouched");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

// — routing bypass detection (#2290) ————————————————————————————

test("claudeNativeRoutingCheck: claude-desktop entrypoint is a bypass; other entrypoints are not", () => {
    const hit = claudeNativeRoutingCheck({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
    assert.equal(hit.bypassed, true);
    assert.equal(hit.reasons.length, 1);
    assert.match(hit.reasons[0]!, /CLAUDE_CODE_ENTRYPOINT=claude-desktop/);
    // Case/whitespace tolerant.
    assert.equal(claudeNativeRoutingCheck({ CLAUDE_CODE_ENTRYPOINT: " Claude-Desktop " }).bypassed, true);
    // Evidence-based permitlist: known/other hosts must NOT fire.
    for (const v of ["cli", "vscode", "sdk-cli", "claude-code", ""]) {
        assert.equal(claudeNativeRoutingCheck({ CLAUDE_CODE_ENTRYPOINT: v }).bypassed, false, `entrypoint ${JSON.stringify(v)} must stay silent`);
    }
    assert.equal(claudeNativeRoutingCheck({}).bypassed, false);
});

test("claudeNativeRoutingCheck: non-bili ANTHROPIC_BASE_URL fires; bili URL and healthy sessions do not", () => {
    // The desktop shape: host-injected direct upstream wins over settings.json.
    const hit = claudeNativeRoutingCheck({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    assert.equal(hit.bypassed, true);
    assert.match(hit.reasons[0]!, /ANTHROPIC_BASE_URL=https:\/\/api\.anthropic\.com/);
    // A managed URL (any loopback port) is healthy routing.
    assert.equal(claudeNativeRoutingCheck({ ANTHROPIC_BASE_URL: baseUrlForPort(18787) }).bypassed, false);
    // Healthy terminal session: claude does not inject settings.env into hook
    // children, so the var is absent unless something external set it.
    assert.equal(claudeNativeRoutingCheck({}).bypassed, false);
    assert.equal(claudeNativeRoutingCheck({ ANTHROPIC_BASE_URL: "   " }).bypassed, false);
    // Both signals at once → both reasons.
    const both = claudeNativeRoutingCheck({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop", ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    assert.equal(both.bypassed, true);
    assert.equal(both.reasons.length, 2);
});

test("claudeNativeRoutingCheck: a Vertex session routes on ANTHROPIC_VERTEX_BASE_URL, so the managed ANTHROPIC_BASE_URL cannot be trusted alone (#3323)", () => {
    const biliBase = baseUrlForPort(18787);
    const biliVertex = baseUrlForPort(18787).replace(/\/bili\//, "/bili/anthropic/");
    // Vertex on, variable unset: claude derives the aiplatform host itself, so
    // the managed settings.json value routes nothing — the case the pre-Vertex
    // check reported as healthy.
    const unset = claudeNativeRoutingCheck({ CLAUDE_CODE_USE_VERTEX: "1" });
    assert.equal(unset.bypassed, true);
    assert.match(unset.reasons[0]!, /ANTHROPIC_VERTEX_BASE_URL is unset/);
    // Vertex on with a foreign Vertex base URL.
    const foreign = claudeNativeRoutingCheck({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.googleapis.com" });
    assert.equal(foreign.bypassed, true);
    assert.match(foreign.reasons[0]!, /ANTHROPIC_VERTEX_BASE_URL=https:\/\/aiplatform\.googleapis\.com/);
    // Vertex on with the launcher's own value — the healthy shape phase 1 emits.
    assert.equal(claudeNativeRoutingCheck({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_BASE_URL: biliVertex }).bypassed, false);
    // The switch is read the same way src/vertex.ts reads it: 0/false/no/off and
    // an absent value mean off, and then a plain bili ANTHROPIC_BASE_URL is healthy.
    for (const off of ["0", "false", "no", "off", ""]) {
        assert.equal(claudeNativeRoutingCheck({ CLAUDE_CODE_USE_VERTEX: off, ANTHROPIC_BASE_URL: biliBase }).bypassed, false, `CLAUDE_CODE_USE_VERTEX=${JSON.stringify(off)} must not fire`);
    }
    // Vertex on AND a foreign ANTHROPIC_BASE_URL still reports both signals —
    // the entrypoint-style reasons are additive, not exclusive.
    const both = claudeNativeRoutingCheck({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    assert.equal(both.bypassed, true);
    assert.equal(both.reasons.length, 2);
});

test("#2290 marker round-trip: recordClaudeRoutingWarning writes what doctor reads, latest wins, never throws", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bc-claude-route-mark-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
        recordClaudeRoutingWarning(["reason one"]);
        const rec = JSON.parse(fs.readFileSync(claudeRoutingWarningFile(), "utf8")) as { at: number; reasons: string[] };
        assert.deepEqual(rec.reasons, ["reason one"]);
        assert.ok(Number.isFinite(rec.at));
        recordClaudeRoutingWarning(["reason two", "reason three"]);
        const rec2 = JSON.parse(fs.readFileSync(claudeRoutingWarningFile(), "utf8")) as { reasons: string[] };
        assert.deepEqual(rec2.reasons, ["reason two", "reason three"]);
        // Unwritable location must not throw — the hook must never fail claude.
        const blocker = path.join(state, "blocker");
        fs.writeFileSync(blocker, "x");
        process.env.XDG_STATE_HOME = path.join(blocker, "sub");
        assert.doesNotThrow(() => recordClaudeRoutingWarning(["never thrown"]));
    } finally {
        if (prev === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev;
        rmrf(state);
    }
});

test("claudeDesktopPresent: per-platform install locations, injectable inputs", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bc-claude-desktop-"));
    try {
        const lad = path.join(base, "lad");
        fs.mkdirSync(path.join(lad, "Programs", "Claude"), { recursive: true });
        assert.equal(claudeDesktopPresent({ platform: "win32", localAppData: lad }), true);
        assert.equal(claudeDesktopPresent({ platform: "win32", localAppData: path.join(base, "empty") }), false);
        assert.equal(claudeDesktopPresent({ platform: "win32", localAppData: "" }), false);
        const appRoot = path.join(base, "apps");
        fs.mkdirSync(path.join(appRoot, "Claude.app"), { recursive: true });
        assert.equal(claudeDesktopPresent({ platform: "darwin", appRoots: [appRoot], home: path.join(base, "home") }), true);
        assert.equal(claudeDesktopPresent({ platform: "darwin", appRoots: [path.join(base, "none")], home: path.join(base, "home") }), false);
        fs.mkdirSync(path.join(base, "home", "Applications", "Claude.app"), { recursive: true });
        assert.equal(claudeDesktopPresent({ platform: "darwin", appRoots: [path.join(base, "none")], home: path.join(base, "home") }), true);
        assert.equal(claudeDesktopPresent({ platform: "linux", localAppData: lad }), false);
    } finally {
        rmrf(base);
    }
});

// — hook e2e (real dist script brings up a real proxy) ——————————————————

function freePort(exclude: readonly number[] = []): Promise<number> {
    // bind(0) can hand out the same port twice (measured ~1.3e-4/pair on
    // Linux) — re-roll when the pick collides with one we already rely on.
    const pick = (): Promise<number> =>
        new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, "127.0.0.1", () => {
                const port = (srv.address() as net.AddressInfo).port;
                srv.close(() => resolve(port));
            });
            srv.on("error", reject);
        });
    return (async () => {
        for (;;) {
            const port = await pick();
            if (!exclude.includes(port)) return port;
        }
    })();
}

test("freePort(exclude) never hands back an excluded port", async () => {
    const portA = await freePort();
    for (let i = 0; i < 25; i++) {
        assert.notEqual(await freePort([portA]), portA);
    }
});

function canConnect(port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host: "127.0.0.1" });
        const done = (ok: boolean) => {
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
    });
}

async function waitForPort(port: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await canConnect(port)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

// The proxy writes <state>/billion-context/proxy-origin synchronously inside
// its 'listening' callback — AFTER the kernel already accepts TCP connects on
// the port. A reader that just saw the port come up can hit a real window
// where the file is not on disk yet (#1031); poll briefly instead of one
// immediate read. Still absent past the deadline = hard failure.
async function waitForInstanceFile(file: string, ms: number): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
        try {
            return fs.readFileSync(file, "utf8");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            if (Date.now() >= deadline) throw new Error(`instance file did not appear within ${ms}ms: ${file}`);
            await new Promise((r) => setTimeout(r, 50));
        }
    }
}

// #1903: TCP accept alone is NOT readiness for the hook's attach machinery —
// the proxy publishes its identity record (proxy-origin file) inside its
// 'listening' callback, which lags kernel accept by an event-loop-dependent
// margin (waitForInstanceFile above documents the same window, #1031). Gate
// the squatter on BOTH the health endpoint and the published record so the
// hook's one-shot discovery can never race the daemon's publication (CI flake
// on PR #1896: the hook probed between accept and publication, took the SPAWN
// path, and its strict-port child died on EADDRINUSE).
async function waitForProxyVisible(port: number, instanceFile: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        let healthy = false;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(2_000) });
            if (res.ok) {
                const body = (await res.json()) as { ok?: boolean };
                healthy = body.ok === true;
            }
        } catch {}
        if (healthy) {
            try {
                JSON.parse(fs.readFileSync(instanceFile, "utf8"));
                return true;
            } catch {}
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

function runHook(distScript: string, port: number, xdg: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    // Hermetic tmp: the hook's spawned proxy logs to
    // <tmpdir>/bili-proxy-<port>.log. The minimal child env has no platform
    // tmp vars, so pin every one of them to the sandbox (Node reads TMPDIR on
    // POSIX, TMP/TEMP on Windows — with none set it falls back to an
    // unwritable root, e.g. C:\). Derived here from home so EVERY caller is
    // covered without each one remembering to pass a tmp dir.
    const tmp = path.join(xdg.home, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [distScript], {
            env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                ...ZONE_ENV,
                HOME: xdg.home,
                XDG_CONFIG_HOME: xdg.config,
                XDG_STATE_HOME: xdg.state,
                XDG_CACHE_HOME: xdg.cache,
                XDG_DATA_HOME: xdg.data,
                BILI_CLAUDE_NATIVE_PORT: String(port),
                NO_COLOR: "1",
                TMPDIR: tmp,
                TEMP: tmp,
                TMP: tmp,
            },
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (c: Buffer) => {
            stderr += c.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
    });
}

test("hook e2e: an occupied stable port fails loud — never port-hops", { timeout: 120_000, skip: liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = {
        home,
        config: path.join(home, "cfg"),
        state: path.join(home, "state"),
        cache: path.join(home, "cache"),
        data: path.join(home, "data"),
    };
    prewarmRootCA(xdg);
    // A foreign listener squats the stable port (a relay, another test
    // stub, anything non-bili). Without strict-port the spawned proxy
    // would EADDRINUSE-hop to port+1 and "succeed" — stranding every
    // claude model call on the dead original port (found live on the
    // host of issue #964: two test listeners on 48787/48788).
    const squatter = net.createServer();
    // #3182 family (w22-3 CI red): the hook's probe of the port holder gets
    // abruptly reset by this foreign listener; without a connection handler
    // the accepted socket's ECONNRESET was unhandled and crashed the test
    // process. Kill every connection eagerly — hostile squatter, and no
    // stray socket events.
    squatter.on("connection", (c) => c.destroy());
    squatter.listen(0, "127.0.0.1");
    await once(squatter, "listening");
    const port = (squatter.address() as net.AddressInfo).port;
    try {
        const r = await runHook(distScript, port, xdg);
        assert.equal(r.code, 0, "the hook never fails claude");
        assert.match(r.stderr, /bring-up failed/);
        assert.doesNotMatch(r.stderr, /started at/);
        await new Promise((r2) => setTimeout(r2, 500));
        assert.equal(await canConnect(port + 1), false, "no port-hop proxy on port+1");
    } finally {
        squatter.close();
        rmrf(home);
    }
});

test("hook e2e: a healthy proxy on ANOTHER port is never attached (static URL)", { timeout: 120_000, skip: liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    prewarmRootCA(xdg);
    const portA = await freePort();
    const portB = await freePort([portA]);
    const instFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let pidA = 0;
    let pidB = 0;
    try {
        // Bring up a healthy proxy on portA first — its instance file is
        // exactly what a probe would attach to (this mirrors the live host:
        // another bili proxy already running when claude's hook fires).
        const rA = await runHook(distScript, portA, xdg);
        assert.equal(rA.code, 0);
        assert.ok(await waitForPort(portA, 60_000), "proxy A up");
        pidA = (JSON.parse(await waitForInstanceFile(instFile, 30_000)) as { pid: number }).pid;

        // SAME state dir, DIFFERENT port: claude dials a STATIC url pinned to
        // portB — attaching to A's origin would strand every request. The
        // hook must spawn its own instance on portB instead.
        const rB = await runHook(distScript, portB, xdg);
        assert.equal(rB.code, 0);
        assert.match(rB.stderr, /started at/, "spawned — not attached to A");
        assert.ok(await waitForPort(portB, 60_000), "proxy B up on its own port");
        pidB = (JSON.parse(await waitForInstanceFile(instFile, 30_000)) as { pid: number }).pid;
        assert.notEqual(pidB, pidA, "separate instance, not an attach");
    } finally {
        if (pidA > 0) killPid(pidA);
        if (pidB > 0) killPid(pidB);
        await rmHome(home);
    }
});

function killPid(pid: number): void {
    try {
        process.kill(pid, "SIGTERM");
    } catch {}
}

// SIGTERM triggers the proxy's graceful session flush into <home>/state — a
// single rmSync races the dying writer (ENOTEMPTY mid-rimraf). Retry inside
// a bounded window instead of racing it.
async function rmHome(home: string): Promise<void> {
    for (let i = 0; ; i++) {
        try {
            rmrf(home);
            return;
        } catch {
            if (i >= 50) throw new Error(`cleanup: could not remove ${home} after 5s`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

// CI runs `npm test` BEFORE `npm run build` (ci.yml step order) — this test
// exercises the BUILT artifact (the hook command claude actually runs), so
// build on demand when dist/ is absent (tsup ~1s; dev checkouts usually
// already have dist/ from a prior build).
/** #3182 family: a STALE dist is worse than a missing one — the test then
 * exercises last week's product code and "fails" on fixes that exist (the
 * #3044 marked-replacement hang was exactly this). Rebuild when any src/
 * source is newer than the built entry. */
function distStale(entry: string): boolean {
    const root = path.resolve(import.meta.dirname, "..");
    let newest = 0;
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(ts|tsx)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
        }
    };
    walk(path.join(root, "src"));
    return fs.statSync(entry).mtimeMs < newest;
}
let distBuiltOnce = false;
function ensureDistBuilt(distScript: string): void {
    if (distBuiltOnce && fs.existsSync(distScript) && !distStale(distScript)) return;
    distBuiltOnce = true;
    if (!fs.existsSync(distScript) || distStale(distScript)) {
        const root = path.resolve(import.meta.dirname, "..");
        execFileSync(process.execPath, [path.join(root, "node_modules", "tsup", "dist", "cli-default.js")], { cwd: root, stdio: "pipe", timeout: 300_000 });
    }
    assert.ok(fs.existsSync(distScript), `build did not produce ${distScript}`);
}

// #1807: first-run CA init now merges the OS trust store — on Windows
// that is a synchronous PowerShell export (~8s on loaded runners) inside
// the hook's 20s bring-up budget. Pre-warm the CA here (outside the
// budget) so the spawned proxy hits the 24h freshness gate and skips the
// export; the export itself stays covered end-to-end by
// tests/ca-combined.test.ts on native hosts.
function prewarmRootCA(xdg: { home: string; data: string }): void {
    if (process.platform !== "win32") return;
    const prevHome = process.env.HOME;
    const prevData = process.env.XDG_DATA_HOME;
    process.env.HOME = xdg.home;
    process.env.XDG_DATA_HOME = xdg.data;
    try {
        // ensureRootCA caches the root CA at module level: only the FIRST
        // call in this process creates the ca dir (generate branch); later
        // calls take the cached branch and go straight to writeCombinedBundle,
        // which does not mkdir. Create the dir ourselves so every fresh-home
        // pre-warm works regardless of test order.
        fs.mkdirSync(caDir(), { recursive: true });
        ensureRootCA();
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevData;
    }
}

test("hook e2e: dist script spawns a proxy on the stable port, second run attaches", { timeout: 120_000, skip: liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = {
        home,
        config: path.join(home, "cfg"),
        state: path.join(home, "state"),
        cache: path.join(home, "cache"),
        data: path.join(home, "data"),
    };
    prewarmRootCA(xdg);
    const port = await freePort();
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let proxyPid = 0;
    try {
        const r1 = await runHook(distScript, port, xdg);
        assert.equal(r1.code, 0);
        assert.match(r1.stderr, /proxy started|proxy attached/);
        assert.ok(await waitForPort(port, 60_000), "proxy listening on the stable port");
        const inst = JSON.parse(await waitForInstanceFile(instanceFile, 30_000)) as { pid: number; origin: string };
        assert.equal(inst.origin, `http://127.0.0.1:${port}`);
        assert.equal(typeof inst.pid, "number");
        proxyPid = inst.pid;

        // Second hook run (claude restart): the healthy proxy is shared.
        const r2 = await runHook(distScript, port, xdg);
        assert.equal(r2.code, 0);
        assert.match(r2.stderr, /attached/);
        const inst2 = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
        assert.equal(inst2.pid, proxyPid, "same proxy instance, no double spawn");
    } finally {
        if (proxyPid > 0) killPid(proxyPid);
        // Belt and braces: sweep any leftover listener the attach assertions
        // lost track of (spawned detached, watchdog = test-runner pid).
        if (await canConnect(port)) {
            try {
                const inst = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
                if (typeof inst.pid === "number") killPid(inst.pid);
            } catch {}
        }
        await rmHome(home);
    }
});

// The live parent-gone incident (claude 2.1.278 + hook 0.1.139): claude runs
// SessionStart hooks as `/bin/sh -c <cmd>`, the hook exits right after proxy
// bring-up, the transient sh dies with it — and the proxy's watchdog, pointed
// at that sh, killed a healthy proxy ~2s into EVERY session while claude kept
// running. The fake claude below reproduces the exact tree; the assertions
// pin both sides of the intended lifetime. Linux-only: the resolver walks
// /proc and the fake claude needs /bin/sh + shebang exec (CI runs windows too).
test("hook e2e: watchdog tracks the claude host, not the transient sh wrapper", { timeout: 120_000, skip: LIVE_E2E ? process.platform !== "linux" : liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    const tmp = path.join(xdg.home, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const port = await freePort();
    // Fake claude binary reproducing the live SessionStart shape: it launches
    // the hook as a `/bin/sh -c` child (a transient sh sits between hook and
    // session), then OUTLIVES the hook like a real interactive session.
    const binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const claudeBin = path.join(binDir, "claude");
    // A shebang'ed SHELL script would show argv[0]=/bin/sh in /proc and never
    // match; a node shebang mirrors the npm install shape: argv becomes
    // [node, <path>/claude] — the exact form the resolver must accept.
    fs.writeFileSync(
        claudeBin,
        '#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\n' +
            'spawn("/bin/sh", ["-c", process.env.BILI_FAKE_HOOK_CMD], { stdio: "ignore" });\n' +
            "setInterval(() => {}, 60000);\n",
    );
    fs.chmodSync(claudeBin, 0o755);
    pinCommonJs(binDir);
    const claudeProc = spawn(claudeBin, [], {
        env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
                ...ZONE_ENV,
            HOME: xdg.home,
            XDG_CONFIG_HOME: xdg.config,
            XDG_STATE_HOME: xdg.state,
            XDG_CACHE_HOME: xdg.cache,
            XDG_DATA_HOME: xdg.data,
            BILI_CLAUDE_NATIVE_PORT: String(port),
            NO_COLOR: "1",
            TMPDIR: tmp,
            TEMP: tmp,
            TMP: tmp,
            BILI_FAKE_HOOK_CMD: `"${process.execPath}" '${distScript}'`,
        },
        stdio: "ignore",
        detached: true,
    });
    const claudePid = claudeProc.pid ?? 0;
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let proxyPid = 0;
    try {
        assert.ok(await waitForPort(port, 60_000), "proxy up behind the fake claude session");
        const inst = JSON.parse(await waitForInstanceFile(instanceFile, 30_000)) as { pid: number; origin: string };
        proxyPid = inst.pid;
        assert.equal(inst.origin, `http://127.0.0.1:${port}`);

        // The hook exits after bring-up and its transient sh parent dies with
        // it. Old code watched that sh: parent-gone killed the proxy within
        // one 2s watchdog tick. Several ticks later the proxy must STILL be
        // serving — the session is alive.
        await new Promise((r) => setTimeout(r, 6000));
        assert.ok(await canConnect(port), "proxy survives the transient sh wrapper's death");

        // Session end: claude dies, the proxy must follow within a few ticks.
        // #3890 widened owner-death→exit by up to ~6s (three consecutive failed
        // probes now confirm death instead of one) — deadline re-sized to match.
        if (claudePid > 1) killPid(claudePid);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && (await canConnect(port))) await new Promise((r) => setTimeout(r, 250));
        assert.equal(await canConnect(port), false, "proxy exits with the claude session");
    } finally {
        if (claudePid > 1) killPid(claudePid);
        if (proxyPid > 1) killPid(proxyPid);
        if (await canConnect(port)) {
            try {
                const leftover = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
                if (typeof leftover.pid === "number") killPid(leftover.pid);
            } catch {}
        }
        await rmHome(home);
    }
});

// #7: the stable-port proxy is shared across sessions, so the parent-gone
// watchdog had to become a WATCHER SET — POST /__bili/watcher lets an
// attached session register its claude host, and the proxy dies only when
// every owner is gone. This test pins the route contract against a real
// dist proxy, no fake claude needed (platform-neutral):
//   - armed proxies accept registrations (200) and reject garbage (400);
//   - daemon proxies (no BILI_PARENT_PID) NEVER take watchers (409) —
//     registering one must not arm a lifetime watchdog on a daemon;
//   - an armed proxy exits when its registered keeper dies.
test("watcher route: shared proxies take watcher registrations, daemons refuse (#7)", { timeout: 120_000, skip: liveSkip }, async () => {
    const distCli = path.resolve(import.meta.dirname, "..", "dist", "index.js");
    ensureDistBuilt(distCli);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watcher-route-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    prewarmRootCA(xdg);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${origin}/__bili/watcher`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    // Keeper: a live pid the armed proxy watches. Its death must take the
    // proxy down (the sweep side of the set watchdog). A second keeper pins
    // the idle GRACE: registering within WATCHER_IDLE_GRACE_MS of the last
    // death cancels the pending shutdown.
    const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
    const keeperPid = keeper.pid ?? 0;
    const keeper2 = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
    const keeper2Pid = keeper2.pid ?? 0;
    const baseEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: xdg.home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_STATE_HOME: xdg.state,
        XDG_CACHE_HOME: xdg.cache,
        XDG_DATA_HOME: xdg.data,
        NO_COLOR: "1",
        ...ZONE_ENV,
    };
    let armed = 0;
    let daemon = 0;
    try {
        armed = spawnProxy(distCli, port, { ...baseEnv, BILI_PARENT_PID: String(keeperPid) });
        assert.ok(await waitForPort(port, 60_000), "armed proxy up");
        // The watcher route MUST sit inside the /__bili/ admin family: a URL
        // outside isAdminPath (e.g. a /__bili__/ spelling) silently skips the
        // tunnel-header, loopback and trusted-origin gates. Both probes below
        // must be rejected by the GATE (403), never reach the route.
        assert.equal((await post({ pid: keeperPid }, { "x-bili-tunnel": "1" })).status, 403, "watcher route is behind the tunnel-header gate");
        assert.equal((await post({ pid: keeperPid }, { origin: "https://evil.example" })).status, 403, "watcher route is behind the trusted-origin gate");
        assert.equal((await post({})).status, 400, "empty body rejected");
        assert.equal((await post({ pid: 0 })).status, 400, "pid 0 rejected");
        assert.equal((await post({ pid: "12" })).status, 400, "string pid rejected");
        assert.equal((await post({ pid: armed })).status, 400, "self-registration rejected");
        const ok = await post({ pid: keeperPid });
        assert.equal(ok.status, 200, "live pid accepted");
        assert.match(JSON.stringify(await ok.json()), /"ok":true/, "ok:true body");
        // #1322: health must expose the lifecycle state so callers can tell a
        // session-owned proxy from a daemon before they commit to it.
        const armedHealth = (await (await fetch(`${origin}/__bili/health`)).json()) as { watchdog?: { armed?: boolean; parentPid?: number; watchers?: number[] } };
        assert.equal(armedHealth.watchdog?.armed, true, "armed proxy reports armed");
        assert.equal(armedHealth.watchdog?.parentPid, keeperPid, "spawning owner reported");
        assert.deepEqual(armedHealth.watchdog?.watchers, [keeperPid], "owner seeded the set");

        // Grace: keeper1 dies, and BEFORE the idle grace expires a new owner
        // registers (the live race: spawner exits right after a second session
        // starts). The pending shutdown must be cancelled — the proxy stays up
        // well past the grace window. #3890: keeper1's removal now takes ~6s
        // (three consecutive failed probes confirm death), so the late
        // registration lands AFTER removal but INSIDE the 5s idle grace that
        // follows it — still exercising the cancellation of an armed pending
        // shutdown (which would otherwise fire ~11s after the death).
        if (keeperPid > 1) killPid(keeperPid);
        await new Promise((r) => setTimeout(r, 8000));
        const late = await post({ pid: keeper2Pid });
        assert.equal(late.status, 200, "late registration within the grace window accepted");
        await new Promise((r) => setTimeout(r, 8000));
        assert.ok(await canConnect(port), "grace registration cancelled the pending shutdown");

        // LAST owner dies → armed proxy must follow (≤ a few ticks + grace).
        // #3890 widened owner-death→exit by up to ~6s (confirmation ticks).
        if (keeper2Pid > 1) killPid(keeper2Pid);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && (await canConnect(port))) await new Promise((r) => setTimeout(r, 250));
        assert.equal(await canConnect(port), false, "armed proxy exits when its watcher dies");

        // Daemon mode: no BILI_PARENT_PID → registrations refused, and a
        // refused registration must not arm a watchdog that kills it later.
        daemon = spawnProxy(distCli, port, baseEnv);
        assert.ok(await waitForPort(port, 60_000), "daemon proxy up on the same port");
        assert.equal((await post({ pid: process.pid })).status, 409, "daemon refuses watchers");
        await new Promise((r) => setTimeout(r, 5000));
        assert.ok(await canConnect(port), "daemon stays up — no watchdog got armed");
        // #1322: the refusal must be visible through health — this is the field
        // that lets an attaching session notice the lifecycle contract is void.
        const daemonHealth = (await (await fetch(`${origin}/__bili/health`)).json()) as { watchdog?: { armed?: boolean; parentPid?: number; watchers?: number[] } };
        assert.equal(daemonHealth.watchdog?.armed, false, "unarmed proxy reports unarmed");
        assert.equal(daemonHealth.watchdog?.parentPid, undefined, "no owner pid");
        assert.deepEqual(daemonHealth.watchdog?.watchers, [], "refused registration joined nothing");
    } finally {
        if (keeperPid > 1) killPid(keeperPid);
        if (keeper2Pid > 1) killPid(keeper2Pid);
        if (armed > 1) killPid(armed);
        if (daemon > 1) killPid(daemon);
        await rmHome(home);
    }
});

// #1322/#1335/#1660 end-to-end: a MANUALLY started `bili start` daemon
// squats on the pinned port BEFORE any session begins. Old world: the hook
// refused it (unarmed) and the strict pinned port then failed fast — the
// operator had to kill their own daemon. #1660 user-zone semantics: a manual
// start is BY DEFINITION user-maintained, so the hook attaches and rides it;
// the daemon's fate stays the operator's. The strict fail-fast still exists
// for lifecycle-less LANE'd squatters (unit-tested in launcher.test.ts) and
// for non-bili listeners (spawn EADDRINUSE). Linux-only like the other hook
// e2es (fake claude walks /proc).
test("hook e2e: manual `bili start` on the pinned port is refused loudly with guidance, never silently attached (#1322/#1335/#1660/#2877)", { timeout: 180_000, skip: LIVE_E2E ? process.platform !== "linux" : liveSkip }, async () => {
    const distCli = path.resolve(import.meta.dirname, "..", "dist", "index.js");
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distCli);
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-squatter-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    const baseEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: xdg.home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_STATE_HOME: xdg.state,
        XDG_CACHE_HOME: xdg.cache,
        XDG_DATA_HOME: xdg.data,
        NO_COLOR: "1",
        ...ZONE_ENV,
    };
    // #3182: freePort() is bind-0-close — another process on the shared CI
    // runner can steal the pick between probe and our bind (TOCTOU). A dead
    // squatter is infra, not product: re-pick and retry the whole setup a
    // bounded number of times before failing.
    let port = 0;
    let squatter = 0;
    for (let attempt = 0; ; attempt++) {
        port = await freePort();
        squatter = spawnProxy(distCli, port, baseEnv);
        if (await waitForPort(port, 60_000)) break;
        killPid(squatter);
        squatter = 0;
        assert.ok(attempt < 2, `squatter daemon up on the stable port (port stolen ${attempt + 1}x, #3182 TOCTOU)`);
    }
    let claudePid = 0;
    try {
        assert.ok(
            await waitForProxyVisible(port, instanceFile, 60_000),
            "squatter fully visible to the attach machinery (health + identity record, #1903)",
        );
        // Fake claude reproducing the live SessionStart shape: node-shebang
        // binary (npm install form: argv [node, <path>/claude]), launches the
        // hook through /bin/sh -c, captures hook stderr to a file, then
        // OUTLIVES the hook like a real interactive session. Dynamic import
        // (not require/import statements): an extensionless file's module
        // system follows the NEAREST package.json, which differs per machine
        // (real /tmp → CJS; sandboxed tmpdirs inside a checkout → ESM).
        const binDir = path.join(home, "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const claudeBin = path.join(binDir, "claude");
        const errFile = path.join(home, "hook-stderr.txt");
        const doneFile = path.join(home, "hook-done");
        fs.writeFileSync(
            claudeBin,
            '#!/usr/bin/env node\n' +
                'import("node:child_process").then(async ({ spawn }) => {\n' +
                '  const fs = await import("node:fs");\n' +
                '  const sh = spawn("/bin/sh", ["-c", process.env.HOOK_CMD], {\n' +
                '    env: process.env,\n' +
                '    stdio: ["ignore", fs.openSync(process.env.HOOK_ERRFILE, "w"), fs.openSync(process.env.HOOK_ERRFILE, "a")]\n' +
                '  });\n' +
                '  sh.on("exit", () => { try { fs.writeFileSync(process.env.HOOK_DONE, String(Date.now())); } catch {} });\n' +
                '});\n' +
                'setInterval(() => {}, 60000);\n',
            { mode: 0o755 },
        );
        claudePid = spawn(claudeBin, [], {
            env: { ...baseEnv, BILI_CLAUDE_NATIVE_PORT: String(port), HOOK_CMD: `"${process.execPath}" "${distScript}"`, HOOK_ERRFILE: errFile, HOOK_DONE: doneFile },
            detached: true,
            stdio: "ignore",
        }).pid ?? 0;
        assert.ok(claudePid > 1, "fake claude spawned");
        const t0 = Date.now();
        while (!fs.existsSync(doneFile) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 250));
        assert.ok(fs.existsSync(doneFile), "hook completed");
        const stderr = fs.readFileSync(errFile, "utf8");
        // #2877 contract (supersedes the #1660 default for LANEd hooks): a
        // claude-lane hook never rides a lane-less, unarmed daemon — every
        // agent converging on one manual `bili start` was the disease. With
        // the port strictly pinned the attach is refused LOUDLY and with
        // guidance (kill the holder or opt in via attachExternal); nothing is
        // killed, nothing re-bound — the user stays sovereign over their own
        // daemon. The armed-shared exception is covered separately by the #7
        // shared-proxy test below.
        assert.match(stderr, /the #1335 attach gate refuses it by default/, "the refusal names the #1335 gate (#2877 own-lane default)");
        assert.match(stderr, new RegExp(`port ${port} is held by a lifecycle-less bili proxy`), "the refusal names the user's daemon and port");
        assert.match(stderr, /Kill that process \(kill \d+\) or set native\.attachExternal=true/, "actionable guidance: kill or attachExternal");
        assert.match(stderr, /bring-up failed/, "fail-fast — no silent fallback onto another port");
        // User sovereignty: the refusal is non-destructive.
        killPid(claudePid);
        claudePid = 0;
        await new Promise((r) => setTimeout(r, 5_000));
        assert.ok(await canConnect(port), "the user's daemon survives untouched — operator decides its fate");
    } finally {
        if (claudePid > 1) killPid(claudePid);
        if (squatter > 1) killPid(squatter);
        await rmHome(home);
    }
});

function spawnProxy(distCli: string, port: number, env: NodeJS.ProcessEnv): number {
    const child = spawn(process.execPath, [distCli, "start", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: "ignore" });
    return child.pid ?? 0;
}

// #7 end-to-end: two concurrent claude sessions share ONE stable-port proxy.
// The first session's hook SPAWNS it (watchdog seeded with session A's host);
// the second ATTACHES and must register its own host via POST /__bili/watcher.
// Old code: A's exit killed the shared proxy and session B went down with it
// (Connection refused mid-session). Fixed: the proxy survives A's death while
// B lives, and dies only after the LAST session exits. Linux-only like the
// watchdog e2e above (fake claude walks /proc, /bin/sh shebang exec).
test("hook e2e: shared proxy survives the first session's exit, dies after the last (#7)", { timeout: 180_000, skip: LIVE_E2E ? process.platform !== "linux" : liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-share-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    const tmp = path.join(xdg.home, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const port = await freePort();
    const binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const claudeBin = path.join(binDir, "claude");
    fs.writeFileSync(
        claudeBin,
        '#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\n' +
            'spawn("/bin/sh", ["-c", process.env.BILI_FAKE_HOOK_CMD], { stdio: "ignore" });\n' +
            "setInterval(() => {}, 60000);\n",
    );
    fs.chmodSync(claudeBin, 0o755);
    pinCommonJs(binDir);
    const sessionEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: xdg.home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_STATE_HOME: xdg.state,
        XDG_CACHE_HOME: xdg.cache,
        XDG_DATA_HOME: xdg.data,
        BILI_CLAUDE_NATIVE_PORT: String(port),
        NO_COLOR: "1",
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        BILI_FAKE_HOOK_CMD: `"${process.execPath}" '${distScript}'`,
    };
    const spawnClaude = (): number => {
        const proc = spawn(claudeBin, [], { env: sessionEnv, stdio: "ignore", detached: true });
        return proc.pid ?? 0;
    };
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    const claudeA = spawnClaude();
    let proxyPid = 0;
    let claudeB = 0;
    try {
        // A is guaranteed the SPAWNER: its proxy is up before B is even born.
        assert.ok(await waitForPort(port, 60_000), "proxy up behind session A");
        const inst = JSON.parse(await waitForInstanceFile(instanceFile, 30_000)) as { pid: number; origin: string };
        proxyPid = inst.pid;
        assert.equal(inst.origin, `http://127.0.0.1:${port}`);

        // Session B starts: its hook attaches to the healthy proxy and
        // registers B's host pid. Generous margin so CI jitter can't flake it.
        claudeB = spawnClaude();
        await new Promise((r) => setTimeout(r, 8000));

        // A exits mid-B-session. Old watchdog: parent-gone killed the shared
        // proxy within one 2s tick. Now: B is still registered → alive.
        if (claudeA > 1) killPid(claudeA);
        await new Promise((r) => setTimeout(r, 6000));
        assert.ok(await canConnect(port), "proxy survives the FIRST session's exit while the second lives");
        const instMid = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
        assert.equal(instMid.pid, proxyPid, "same proxy instance throughout — no respawn");

        // Last session exits → the proxy must follow within a few ticks.
        // #3890 widened owner-death→exit by up to ~6s (confirmation ticks).
        if (claudeB > 1) killPid(claudeB);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && (await canConnect(port))) await new Promise((r) => setTimeout(r, 250));
        assert.equal(await canConnect(port), false, "proxy exits after the LAST session");
    } finally {
        if (claudeA > 1) killPid(claudeA);
        if (claudeB > 1) killPid(claudeB);
        if (proxyPid > 1) killPid(proxyPid);
        if (await canConnect(port)) {
            try {
                const leftover = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
                if (typeof leftover.pid === "number") killPid(leftover.pid);
            } catch {}
        }
        await rmHome(home);
    }
});
