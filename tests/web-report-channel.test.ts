// #3299 permanent feedback channel: problems that never raised a warning banner
// had no web-side report path — users had to find a human. These tests pin the
// completed #3040 facility:
//   1. topic=general serves env facts + session count + the recent [error] log
//      tail; ?desc= carries the user's own description into the blob AND the
//      prefilled issues/new URL body (body decodes back to the exact blob).
//   2. ?errors=0 opts out of the log tail (honest "(no recent …)" line);
//      unknown topics still degrade to the base blob.
//   3. the page ships the always-on entry (#report-open) + modal skeleton with
//      localized copy; the client wires both actions to the endpoint and the
//      session-detail row offers a prefilled "report this session" path.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { defaultLogFile } from "../src/paths.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { VERSION } from "../src/version.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;
type EnvSnap = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function saveEnv(): EnvSnap {
    const snap: EnvSnap = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    return snap;
}

function restoreEnv(snap: EnvSnap): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

function isolate(base: string): void {
    mkdirSync(path.join(base, "sessions"), { recursive: true });
    process.env.BILI_SESSIONS_DIR = path.join(base, "sessions");
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
}

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

interface DiagnosticsWire {
    blob: string;
    title: string;
    url: string;
}

async function fetchJson<T>(port: number, p: string): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    assert.equal(res.status, 200, `${p} answers 200`);
    return (await res.json()) as T;
}

function makeOpts(upstreamPort: number): ProxyOptions {
    return {
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
}

test("#3299 topic=general: user description + [error] tail in blob and prefilled issue url", async () => {
    const snap = saveEnv();
    const base = mkdtempSync(path.join(tmpdir(), "bili-report-channel-"));
    let store: SessionStore | null = null;
    try {
        isolate(base);
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_ENCRYPTION_KEY;
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        // The harness never configures the logger (log:false), so the tail reader
        // falls back to defaultLogFile() under the sandboxed state dir.
        const logFile = defaultLogFile();
        mkdirSync(path.dirname(logFile), { recursive: true });
        writeFileSync(logFile, [
            "2026-10-15T00:00:00.000Z [info] [v=test] startup ok",
            "2026-10-15T00:00:01.000Z [error] [v=test] upstream reset by peer (session abc123def456)",
            "2026-10-15T00:00:02.000Z [warn] [v=test] slow response 5000ms",
        ].join("\n") + "\n");
        const upstreamPort = await freePort();
        const proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        try {
            const d = await fetchJson<DiagnosticsWire>(port, "/__bili/diagnostics?topic=general&desc=" + encodeURIComponent("压缩之后上下文丢失了，复现步骤：…"));
            assert.ok(d.blob.includes("--- user description ---"), "blob carries the user description section");
            assert.ok(d.blob.includes("压缩之后上下文丢失了"), "description text survives the round-trip");
            assert.ok(d.blob.includes("--- reported problem ---"), "blob carries the general section");
            assert.ok(d.blob.includes("sessions on disk:"), "blob carries the session count");
            assert.ok(d.blob.includes("upstream reset by peer"), "blob carries the [error] log line");
            assert.ok(!d.blob.includes("startup ok"), "[info] lines are excluded");
            assert.ok(!d.blob.includes("slow response"), "[warn] lines are excluded");
            assert.ok(d.title.startsWith("User report via web UI"), "title names the channel");
            assert.ok(d.url.startsWith("https://github.com/ranxianglei/billion-context/issues/new?title="), "url targets issues/new");
            const u = new URL(d.url);
            assert.equal(u.searchParams.get("body"), d.blob, "issue body decodes back to the exact blob");

            const d2 = await fetchJson<DiagnosticsWire>(port, "/__bili/diagnostics?topic=general&errors=0");
            assert.ok(d2.blob.includes("(no recent [error] log lines)"), "errors=0 drops the tail and says so honestly");
            assert.ok(!d2.blob.includes("upstream reset by peer"), "errors=0 omits the log lines");

            const d3 = await fetchJson<DiagnosticsWire>(port, "/__bili/diagnostics?topic=some-future-topic");
            assert.ok(d3.blob.includes("some-future-topic (no topic-specific section registered)"), "unknown topics still degrade to the base blob");

            const html = renderPage(`http://127.0.0.1:${port}`, VERSION);
            assert.ok(html.includes('id="report-open"'), "page carries the always-on feedback button");
            assert.ok(html.includes('data-i18n="nav.report"'), "button label is localized");
            assert.ok(html.includes('id="report-modal"'), "page carries the modal skeleton");
            for (const id of ["report-desc", "report-incl-errors", "report-copy", "report-github", "report-cancel", "report-close"]) {
                assert.ok(html.includes(`id="${id}"`), `modal carries #${id}`);
            }
            assert.ok(html.includes('data-i18n-ph="rpt.desc_ph"'), "placeholder is localized");
            assert.ok(WEB_CLIENT.includes('p.set("topic", "general")'), "client targets the general topic");
            assert.ok(WEB_CLIENT.includes('p.set("errors", "0")'), "client can opt out of the error tail");
            assert.ok(WEB_CLIENT.includes("openReportModal()"), "topbar button opens the modal");
            assert.ok(WEB_CLIENT.includes('id="sessrpt-issue"'), "session detail offers report-this-session");
            assert.ok(WEB_CLIENT.includes('t("rpt.session_prefill"'), "prefill uses the localized fingerprint template");
            assert.ok(WEB_CLIENT.includes('t("det.report_issue_session")'), "session button label is localized");
        } finally {
            await close(proxy);
        }
    } finally {
        store?.closeQuietly();
        rmrf(base);
        restoreEnv(snap);
    }
});
