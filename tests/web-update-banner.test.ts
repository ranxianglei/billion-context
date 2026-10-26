// #1870 web surface: the critical-update notice reached the /acp panel and
// acp_status, but the web UI had NO update banner at all — the browser only
// had the disk-vs-running stale banner, so a remote user on an old install
// never learned a critical release existed (the exact gap the notes-package
// staleout of 0.1.191-0.1.193 made visible). The fix shares one
// updateReadyPayload() between /__bili/status and /__bili/overview; these
// tests pin the wire contract both banners/panels read:
//   1. PARITY (#2152 lesson): status and overview report byte-identical
//      updateReady — null when invisible, a STRUCTURED payload when a
//      critical span is pending. Structured, not a sentence: the client
//      composes zh/en separately ("v{version} 或更新版本 / v{version} or
//      newer"), and "available" carries the MINIMUM fixed version.
//   2. #1977 silence: routine/recommended-only spans stay null on the wire
//      (the web banner must NOT become a routine-update nag).
//   3. the page actually ships the banner element and the client references
//      it + composes the localized line and escapes it (registry text →
//      innerHTML).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetReleaseNotesWatcherForTest, _setReleaseNotesStateForTest, type ReleaseNoteEntry } from "../src/update-notes.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

type Wire = { updateReady: { kind: "available" | "ready"; version: string; summary: string } | null };

async function fetchWire(port: number, path: string): Promise<Wire> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200, `${path} answers 200`);
    return (await res.json()) as Wire;
}

function entry(version: string, tier: "routine" | "recommended" | "critical", summary: string): ReleaseNoteEntry {
    return { version, tier, summary, date: "2026-10-12" };
}

test("#1870 web surface: /__bili/overview and /__bili/status share one updateReady line (banner data source)", async () => {
    // Hermetic sessions dir: /__bili/overview walks the disk store, and a missing
    // dir rejects loudly by design (#1937) — pin an existing temp dir.
    const prevSessionsDir = process.env.BILI_SESSIONS_DIR;
    const prevStorageMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    const sessionsDir = mkdtempSync(path.join(tmpdir(), "bili-update-banner-"));
    process.env.BILI_SESSIONS_DIR = sessionsDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstreamPort = await freePort(); // never contacted — management endpoints only
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        // 1) empty watcher state (fresh boot, check never ran) → null on BOTH
        //    surfaces — the banner stays hidden, not crashy.
        _resetReleaseNotesWatcherForTest();
        let s = await fetchWire(port, "/__bili/status");
        let o = await fetchWire(port, "/__bili/overview");
        assert.equal(o.updateReady, null, "overview reports null updateReady with empty state");
        assert.deepEqual(o.updateReady, s.updateReady, "overview/status updateReady parity (empty state)");

        // 2) routine/recommended-only span → STILL null (#1977: the web banner
        //    must not become a routine-update nag).
        _setReleaseNotesStateForTest({ entries: [entry("99.0.1", "recommended", "polish"), entry("99.0.0", "routine", "chores")] });
        s = await fetchWire(port, "/__bili/status");
        o = await fetchWire(port, "/__bili/overview");
        assert.equal(o.updateReady, null, "recommended/routine span stays invisible on the wire");
        assert.deepEqual(o.updateReady, s.updateReady, "overview/status updateReady parity (invisible span)");

        // 3) critical span → the structured payload on BOTH surfaces,
        //    byte-identical, carrying the MINIMUM fixed version + summary;
        //    version selection is pinned so the locales can say "or newer".
        _setReleaseNotesStateForTest({ entries: [entry("99.0.2", "critical", "fixes cache corruption"), entry("99.0.1", "critical", "earlier fix")] });
        s = await fetchWire(port, "/__bili/status");
        o = await fetchWire(port, "/__bili/overview");
        assert.deepEqual(o.updateReady, { kind: "available", version: "99.0.1", summary: "earlier fix" }, "available payload: MINIMUM critical version, not the span tail");
        assert.deepEqual(o.updateReady, s.updateReady, "overview/status updateReady parity (critical span)");
        assert.ok(!JSON.stringify(o.updateReady).includes("npm install"), "no npm install prescription (hosts differ: npm -g / opencode / dsh / pi)");

        // 4) pending restart with a critical in span → the ready/restart branch
        //    names the DISK version (what a restart delivers).
        _setReleaseNotesStateForTest({ entries: [entry("99.0.3", "critical", "fixes cache corruption")], diskVersion: "99.0.3" });
        s = await fetchWire(port, "/__bili/status");
        o = await fetchWire(port, "/__bili/overview");
        assert.deepEqual(o.updateReady, { kind: "ready", version: "99.0.3", summary: "fixes cache corruption" }, "ready payload: names the disk version");
        assert.deepEqual(o.updateReady, s.updateReady, "overview/status updateReady parity (pending restart)");

        const entries = [entry("99.0.4", "routine", "future routine"), entry("99.0.3", "critical", "second fix"), entry("99.0.2", "critical", "first fix")];
        for (const diskVersion of ["99.0.1", "99.0.2", "99.0.3"]) {
            _setReleaseNotesStateForTest({ entries, diskVersion });
            s = await fetchWire(port, "/__bili/status");
            o = await fetchWire(port, "/__bili/overview");
            assert.deepEqual(o.updateReady, {
                kind: diskVersion === "99.0.3" ? "ready" : "available",
                version: diskVersion === "99.0.1" ? "99.0.2" : "99.0.3",
                summary: diskVersion === "99.0.1" ? "first fix" : "second fix",
            }, diskVersion);
            assert.deepEqual(o.updateReady, s.updateReady, "partial-install endpoint parity");
        }
    } finally {
        _resetReleaseNotesWatcherForTest();
        await close(proxy);
        await rmrf(sessionsDir);
        if (prevSessionsDir === undefined) delete process.env.BILI_SESSIONS_DIR;
        else process.env.BILI_SESSIONS_DIR = prevSessionsDir;
        if (prevStorageMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevStorageMode;
    }
});

test("#1870 web surface: the page ships the banner element and the client renders it escaped", () => {
    const html = renderPage("http://127.0.0.1:19999", "0.0.0-test");
    assert.ok(html.includes('id="update-banner"'), "page carries the update-banner div");
    // the stale banner (the original surface) stays untouched alongside it
    assert.ok(html.includes('id="stale-banner"'), "stale-banner kept");

    assert.ok(WEB_CLIENT.includes('"update-banner"'), "client targets the update-banner element");
    assert.ok(WEB_CLIENT.includes("d.updateReady"), "client reads the wire field");
    assert.ok(WEB_CLIENT.includes('t("sys.update")'), "client uses the localized label");
    // zh/en compose SEPARATELY from kind/version/summary (no server-baked sentence)
    assert.ok(WEB_CLIENT.includes('t("sys.update_available"'), "client composes the available line per locale");
    assert.ok(WEB_CLIENT.includes('t("sys.update_ready"'), "client composes the ready line per locale");
    // remote-doc text (registry summary) flows through innerHTML → must be escaped
    const m = /innerHTML = "<strong>" \+ t\("sys\.update"\) \+ "<\/strong> " \+ escapeHtml\(line\)/;
    assert.ok(m.test(WEB_CLIENT), "the update line is HTML-escaped before innerHTML");
    // #3719 item3: the available-kind banner carries a one-click upgrade
    // button; ready-kind does NOT (only a restart is left to do).
    assert.ok(WEB_CLIENT.includes("banner-upgrade-now"), "banner upgrade button present (#3719 item3)");
    assert.ok(WEB_CLIENT.includes('t("sys.update_now"'), "button label localized");
    assert.ok(WEB_CLIENT.includes('t("sys.updating"'), "busy label localized");
    assert.ok(WEB_CLIENT.includes('t("sys.update_done"'), "done label localized");
    assert.ok(WEB_CLIENT.includes('u.kind === "available"'), "button gated to the available kind — ready never shows it");
    // #3719 item4: zh locale picks summaryZh; banner + notices share the pick
    assert.ok(WEB_CLIENT.includes("summaryZh"), "banner/notices read summaryZh (#3719 item4)");
});
