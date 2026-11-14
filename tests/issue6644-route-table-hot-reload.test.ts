import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import {
    applyRouteTables,
    currentConfigRawText,
    loadOptions,
    refreshRouteTablesIfFileChanged,
    _resetRouteRefreshTrackerForTest,
    type ProxyOptions,
} from "../src/config.ts";
import { _resetUpstreamProxyForTest, proxyDispatcher } from "../src/upstream-proxy.ts";

// #6644: per-route providers.* edits (incl. per-route proxy) were a startup
// snapshot — inert until an explicit POST /__bili/config/reload or web Apply,
// while GET /__bili/config already read the file, so "shown" and "applied"
// silently disagreed (egress went proxy=direct, the per-host circuit opened,
// and it read like a network fault). The fix re-applies the route/proxy tables
// in place when the config file's content changes, so providers.* take effect
// on the next request.
//
// Content-based (raw text), NOT mtime/size — same rationale as #2078's file
// cache: back-to-back rewrites can share a sub-ms mtime, so a stat-keyed check
// would serve stale routes right after an edit.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6644-"));
const savedConfigEnv = process.env.BILI_CONFIG_FILE;
const log: (level: string, msg: string) => void = () => undefined;

test.after(() => {
    _resetUpstreamProxyForTest();
    if (savedConfigEnv === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedConfigEnv;
    fs.rmSync(root, { recursive: true, force: true });
});

function pointAt(name: string): string {
    const f = path.join(root, name);
    process.env.BILI_CONFIG_FILE = f;
    return f;
}

function write(f: string, content: string): void {
    fs.writeFileSync(f, content);
}

function buildOpts(): ProxyOptions {
    return loadOptions({ ACP_PORT: "8787" });
}

test("#6644: unchanged file is a no-op (returns false, no re-apply)", () => {
    const f = pointAt("stable.json");
    write(f, JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:7890" } } }));
    const opts = buildOpts();
    assert.equal(opts.routes["https://relay.example"]?.proxy, "http://127.0.0.1:7890");
    assert.equal(refreshRouteTablesIfFileChanged(opts, log), false, "unchanged content must not re-apply");
    assert.equal(refreshRouteTablesIfFileChanged(opts, log), false);
});

test("#6644: a per-route proxy edit is picked up on the next refresh (no reload call)", () => {
    const f = pointAt("proxy-edit.json");
    write(f, JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:7890" } } }));
    const opts = buildOpts();
    assert.equal(opts.routes["https://relay.example"]?.proxy, "http://127.0.0.1:7890");
    // The user edits the file directly (no POST /__bili/config/reload).
    write(f, JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:9999" } } }));
    assert.equal(refreshRouteTablesIfFileChanged(opts, log), true, "a real edit must re-apply");
    assert.equal(opts.routes["https://relay.example"]?.proxy, "http://127.0.0.1:9999", "the new per-route proxy must be live");
    // Tracker is now in sync — a second refresh with no further edit is a no-op.
    assert.equal(refreshRouteTablesIfFileChanged(opts, log), false);
});

test("#6644: adding and removing a route both propagate", () => {
    const f = pointAt("add-remove.json");
    write(f, JSON.stringify({ providers: { "https://a.example": { proxy: "http://127.0.0.1:1" } } }));
    const opts = buildOpts();
    assert.equal(opts.routes["https://a.example"]?.proxy, "http://127.0.0.1:1");
    // Add a second route.
    write(f, JSON.stringify({
        providers: {
            "https://a.example": { proxy: "http://127.0.0.1:1" },
            "https://b.example": { proxy: "http://127.0.0.1:2" },
        },
    }));
    assert.equal(refreshRouteTablesIfFileChanged(opts, log), true);
    assert.equal(opts.routes["https://b.example"]?.proxy, "http://127.0.0.1:2", "new route must appear");
    assert.equal(opts.routes["https://a.example"]?.proxy, "http://127.0.0.1:1", "existing route must survive");
    // Remove the first route — the clear+refill must drop it, not leave it stale.
    write(f, JSON.stringify({ providers: { "https://b.example": { proxy: "http://127.0.0.1:2" } } }));
    assert.equal(refreshRouteTablesIfFileChanged(opts, log), true);
    assert.equal(opts.routes["https://a.example"], undefined, "removed route must disappear");
    assert.equal(opts.routes["https://b.example"]?.proxy, "http://127.0.0.1:2");
});

test("#6644: a changed proxy URL resets the dispatcher cache (stale agent is dropped)", () => {
    _resetUpstreamProxyForTest();
    const f = pointAt("cache-reset.json");
    write(f, JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:7890" } } }));
    const opts = buildOpts();
    // Seed the proxy dispatcher cache with an agent for the current proxy URL.
    const before = proxyDispatcher("http://127.0.0.1:7890");
    assert.ok(before, "a valid proxy URL must produce a dispatcher");
    // Edit the file — the refresh must reset the cache so the next request does
    // not keep a stale agent for the old proxy URL.
    write(f, JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:9999" } } }));
    assert.equal(refreshRouteTablesIfFileChanged(opts, log), true);
    const after = proxyDispatcher("http://127.0.0.1:7890");
    assert.notEqual(after, before, "the cache must have been reset — a fresh agent is created");
});

test("#6644: applyRouteTables logs the applied provider count", () => {
    const f = pointAt("log.json");
    write(f, JSON.stringify({ providers: { "https://a.example": {}, "https://b.example": {} } }));
    const opts = buildOpts();
    const seen: string[] = [];
    const capturingLog: (level: string, msg: string) => void = (_level, msg) => { if (msg.includes("route tables applied")) seen.push(msg); };
    _resetRouteRefreshTrackerForTest(); // force a re-apply on the next refresh
    assert.equal(refreshRouteTablesIfFileChanged(opts, capturingLog), true);
    assert.equal(seen.length, 1, "a re-apply must log exactly once");
    assert.ok(seen[0].includes("2 providers"), `log must carry the provider count (got: ${seen[0]})`);
});

test("#6644: currentConfigRawText is empty when the file is missing, and tracks edits", () => {
    const f = pointAt("raw.json");
    assert.equal(currentConfigRawText(), "", "missing file reads as empty string");
    write(f, '{"providers":{}}');
    assert.equal(currentConfigRawText(), '{"providers":{}}', "raw text must reflect the file verbatim");
});
