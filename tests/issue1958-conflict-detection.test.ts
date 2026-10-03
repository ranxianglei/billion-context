// #1958 (direction change): "native plugin + hand-written /bili/ provider
// baseURL" is a CONFLICTING configuration — two mutually exclusive access
// paths claiming routing ownership of the same requests. It must be exposed,
// not silently absorbed:
//   - install: `bili plugin install opencode` refuses (exit 1 upstream in the
//     CLI) when the real effective config surface carries a /bili/ baseURL;
//   - runtime: the V2 native route warns once per (session, origin) with a
//     fix-it guide; an explicit pin of the SAME origin (BILLION_CONTEXT_PROXY
//     pointing at the proxy the URLs already ride) stays silent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Module-level guards read env while opencode-native EVALUATES; static imports
// hoist above any assignment, so set the marker first and import dynamically.
process.env.NODE_TEST_CONTEXT = "1";

import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2HttpRequestEvent, V2State } from "../src/agent/opencode-v2.ts";
import { findBiliPrefixedOpencodeBaseURLs, isBiliRoutedBaseUrl } from "../src/client-config.ts";
import { pluginInstall } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

const { createNativeRoute } = await import("../src/agent/opencode-native.ts");

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** A cwd that is its own git root, so the project-layer scan stays inside it. */
function gitCwd(prefix: string): string {
    const dir = tempDir(prefix);
    fs.mkdirSync(path.join(dir, ".git"));
    return dir;
}

// ---------------------------------------------------------------------------
// Install-time surface: the pure scanner
// ---------------------------------------------------------------------------

test("#1958: isBiliRoutedBaseUrl flags only http(s) paths starting with /bili/", () => {
    assert.equal(isBiliRoutedBaseUrl("http://127.0.0.1:8787/bili/https://api.openai.com/v1"), true);
    assert.equal(isBiliRoutedBaseUrl("https://proxy.example/bili/http://upstream/v1/chat/completions"), true);
    assert.equal(isBiliRoutedBaseUrl("https://api.openai.com/v1"), false);
    assert.equal(isBiliRoutedBaseUrl("http://127.0.0.1:8787/bilibili/videos"), false);
    assert.equal(isBiliRoutedBaseUrl("http://127.0.0.1:8787/bili"), false);
    assert.equal(isBiliRoutedBaseUrl("not a url"), false);
});

test("#1958: scanner reports effective hits only — overridden stale entries never fire", () => {
    const xdg = tempDir("bili-oc-scan-xdg-");
    const cwd = gitCwd("bili-oc-scan-cwd-");
    try {
        const cfg = path.join(xdg, "opencode", "config.json");
        const jsonc = path.join(xdg, "opencode", "opencode.jsonc");
        writeJson(cfg, {
            provider: {
                stale: { options: { baseURL: "http://127.0.0.1:8787/bili/https://stale.invalid/v1" } },
                live: { options: { baseURL: "http://127.0.0.1:8787/bili/https://live.invalid/v1" } },
            },
        });
        // opencode.jsonc merges over config.json and replaces "stale"'s base.
        writeJson(jsonc, { provider: { stale: { options: { baseURL: "https://stale.invalid/v1" } } } });
        const env = { XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv;
        assert.deepEqual(findBiliPrefixedOpencodeBaseURLs(env, cwd), [
            { file: cfg, provider: "live", baseURL: "http://127.0.0.1:8787/bili/https://live.invalid/v1" },
        ]);
    } finally {
        rmrf(xdg);
        rmrf(cwd);
    }
});

test("#1958: scanner honors OPENCODE_CONFIG and the project layer (nearest wins)", () => {
    const xdg = tempDir("bili-oc-scan-xdg2-");
    const cwd = gitCwd("bili-oc-scan-cwd2-");
    try {
        const overlay = path.join(xdg, "overlay.jsonc");
        writeJson(overlay, { provider: { ov: { options: { baseURL: "http://127.0.0.1:8787/bili/https://ov.invalid/v1" } } } });
        // Project file outranks globals per provider id.
        writeJson(path.join(cwd, "opencode.json"), { provider: { proj: { options: { baseURL: "http://127.0.0.1:8787/bili/https://proj.invalid/v1" } } } });
        const env = { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG: overlay } as NodeJS.ProcessEnv;
        const hits = findBiliPrefixedOpencodeBaseURLs(env, cwd);
        const byProvider: Record<string, unknown> = {};
        for (const h of hits) byProvider[h.provider] = h;
        assert.deepEqual(byProvider.ov, { file: overlay, provider: "ov", baseURL: "http://127.0.0.1:8787/bili/https://ov.invalid/v1" });
        assert.deepEqual(byProvider.proj, { file: path.join(cwd, "opencode.json"), provider: "proj", baseURL: "http://127.0.0.1:8787/bili/https://proj.invalid/v1" });
        // A project-level RAW base overrides the global prefixed one.
        writeJson(path.join(cwd, "opencode.json"), { provider: { proj: { options: { baseURL: "https://proj.invalid/v1" } } } });
        const hits2 = findBiliPrefixedOpencodeBaseURLs(env, cwd);
        assert.equal(hits2.length, 1);
        assert.equal(hits2[0].provider, "ov");
    } finally {
        rmrf(xdg);
        rmrf(cwd);
    }
});

// ---------------------------------------------------------------------------
// Install-time behavior: refusal + clean failure + no false positive
// ---------------------------------------------------------------------------

function withIsolatedHome(t: test.TestContext, opts: { configFile?: unknown }): { xdg: string; cwd: string; target: string } {
    const xdg = tempDir("bili-oc-install-xdg-");
    const cwd = gitCwd("bili-oc-install-cwd-");
    const target = path.join(xdg, "opencode", "opencode.json");
    if (opts.configFile !== undefined) writeJson(target, opts.configFile);
    const prev = {
        xdg: process.env.XDG_CONFIG_HOME,
        open: process.env.OPENCODE_CONFIG,
        bin: process.env.BILI_CLIENT_BIN,
    };
    delete process.env.OPENCODE_CONFIG;
    // Hermetic probe pin: unresolvable bin fails soft to major 1.
    process.env.BILI_CLIENT_BIN = "/nonexistent/bili-oc-probe-pin";
    process.env.XDG_CONFIG_HOME = xdg;
    const prevCwd = process.cwd();
    process.chdir(cwd);
    t.after(() => {
        process.chdir(prevCwd);
        if (prev.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev.xdg;
        if (prev.open === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prev.open;
        if (prev.bin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prev.bin;
        rmrf(xdg);
        rmrf(cwd);
    });
    return { xdg, cwd, target };
}

test("#1958: plugin install refuses over a pre-routed /bili/ baseURL and writes nothing", (t) => {
    const { target } = withIsolatedHome(t, {
        configFile: { provider: { openai: { options: { baseURL: "http://127.0.0.1:8787/bili/https://api.openai.com/v1" } } } },
    });
    const before = fs.readFileSync(target, "utf8");
    assert.throws(() => pluginInstall("opencode"), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /conflicting configuration/);
        assert.match(err.message, new RegExp(target));
        assert.match(err.message, /provider "openai"/);
        assert.match(err.message, /Nothing was written\./);
        return true;
    });
    assert.equal(fs.readFileSync(target, "utf8"), before, "the config is untouched");
});

test("#1958: plugin install proceeds when every baseURL is raw (no false positive)", (t) => {
    withIsolatedHome(t, {
        configFile: { provider: { openai: { options: { baseURL: "https://api.openai.com/v1" } } } },
    });
    const out = pluginInstall("opencode");
    assert.match(out, /installed ->/);
});

// ---------------------------------------------------------------------------
// Runtime exposure: warn once per (session, origin); benign pins stay silent
// ---------------------------------------------------------------------------

const BAKED = "http://127.0.0.1:9999";
const ROUTED_URL = `${BAKED}/bili/http://example.invalid/v1/chat/completions`;

function routedEvent(sessionID: string | undefined, url = ROUTED_URL): V2HttpRequestEvent {
    const e: V2HttpRequestEvent = { request: new Request(url, { method: "POST" }) };
    if (sessionID !== undefined) e.sessionID = sessionID;
    return e;
}

async function capturedErrors(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
        await fn();
    } finally {
        console.error = orig;
    }
    return lines.filter((l) => l.includes("conflicting configuration"));
}

function spawnState(): NativeInterceptState {
    return { origin: "http://127.0.0.1:7777", ready: Promise.resolve("http://127.0.0.1:7777") };
}

test("#1958: conflicting pre-routed URL warns once per (session, origin), then stays quiet", async () => {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PROXY;
    try {
        const route = createNativeRoute(spawnState());
        const s: V2State = {};
        const otherUrl = `${BAKED.replace(":9999", ":9998")}/bili/http://other.invalid/v1/chat/completions`;
        const run = async (): Promise<void> => {
            await route(routedEvent("ses_a"), s);
            assert.equal(s.proxyBase, BAKED, "stamping binds to the baked origin (#1959 fallback)");
            await route(routedEvent("ses_a"), s);
            await route(routedEvent("ses_b"), s);
            await route(routedEvent("ses_a", otherUrl), s);
        };
        const lines = await capturedErrors(run);
        assert.equal(lines.length, 3, "one per distinct (session, origin) pair");
        assert.match(lines[0], new RegExp(BAKED));
        assert.match(lines[0], /pick one/i);
        assert.equal(s.proxyBase, BAKED.replace(":9999", ":9998"), "the last request's origin is the current binding");
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
});

test("#1958: an explicit pin of the SAME origin is the supported attach posture — silent", async () => {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = BAKED;
    try {
        const state: NativeInterceptState = { origin: BAKED, ready: Promise.resolve(BAKED), attach: true };
        const s: V2State = {};
        const lines = await capturedErrors(async () => {
            await createNativeRoute(state)(routedEvent("ses_pin"), s);
            await createNativeRoute(state)(routedEvent("ses_pin"), s);
        });
        assert.equal(lines.length, 0, "benign explicit pin must not warn");
        assert.equal(s.proxyBase, BAKED);
        // Trailing slash / default-port spelling differences normalize away.
        process.env.BILLION_CONTEXT_PROXY = `${BAKED}/`;
        const s2: V2State = {};
        const lines2 = await capturedErrors(async () => {
            await createNativeRoute(state)(routedEvent("ses_pin"), s2);
        });
        assert.equal(lines2.length, 0);
        process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:80";
        const s3: V2State = {};
        const lines3 = await capturedErrors(async () => {
            await createNativeRoute({ origin: "http://127.0.0.1", ready: Promise.resolve("http://127.0.0.1") })(routedEvent("ses_pin", "http://127.0.0.1:80/bili/http://example.invalid/v1/chat/completions"), s3);
        });
        assert.equal(lines3.length, 0, "default ports fold in URL.origin comparison");
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
});

test("#1958: attach to a DIFFERENT origin than the baked URL warns (real conflict)", async () => {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:7777";
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:7777", ready: Promise.resolve("http://127.0.0.1:7777"), attach: true };
        const s: V2State = {};
        const lines = await capturedErrors(async () => {
            await createNativeRoute(state)(routedEvent("ses_mismatch"), s);
        });
        assert.equal(lines.length, 1);
        assert.equal(s.proxyBase, BAKED, "the pinned channel still wins over the declared origin (#1365)");
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
});
