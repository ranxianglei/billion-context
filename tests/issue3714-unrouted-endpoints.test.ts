// #3714: custom-wire endpoints (TRAE llm_utils_chat / Qoder sash agent_chat_generation)
// go DIRECT at the host — never reaching the proxy — so the server-side
// unrecognizedPaths stat stays blind to them. This pins the visibility stopgap: the
// host reports the set via /__bili/plugin/unrouted (handlePluginUnrouted), storage
// keeps it per agent, and an acp_status/compress unknown-conversation 404 NAMES those
// endpoints instead of staying generic.
import * as vm from "node:vm";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

import { createCore, defaultConfig } from "acp-kernel";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginTool, handlePluginUnrouted } from "../src/plugin.ts";
import {
    _resetUnroutedStatusForTest,
    recordUnroutedReport,
    unroutedPathsUnion,
    unroutedStatusWire,
} from "../src/server/unrouted-status.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { VERSION } from "../src/version.ts";
import { rmrf } from "./tmp-rm.ts";

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

describe("#3714: direct-through-unrecognized-endpoint visibility", () => {
    beforeEach(() => {
        _resetUnroutedStatusForTest();
    });

    describe("storage", () => {
        it("latest report wins per agent; wire + union reflect it", () => {
            recordUnroutedReport("dsh", ["https://a/x", "https://b/y"]);
            recordUnroutedReport("pi", ["https://c/z"]);
            const wire = unroutedStatusWire();
            assert.deepEqual(wire.dsh, ["https://a/x", "https://b/y"]);
            assert.deepEqual(wire.pi, ["https://c/z"]);
            assert.deepEqual(unroutedPathsUnion(), ["https://a/x", "https://b/y", "https://c/z"]);
            recordUnroutedReport("dsh", ["https://only/d"]);
            assert.deepEqual(unroutedStatusWire().dsh, ["https://only/d"]);
            assert.deepEqual(unroutedPathsUnion(), ["https://c/z", "https://only/d"]);
        });

        it("empty until the first report arrives", () => {
            assert.deepEqual(unroutedStatusWire(), {});
            assert.deepEqual(unroutedPathsUnion(), []);
        });
    });

    describe("handlePluginUnrouted (ingest)", () => {
        it("records a valid report", () => {
            const out = mockRes();
            handlePluginUnrouted(JSON.stringify({ agent: "dsh", paths: ["https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat"] }), out.res);
            assert.equal(out.status(), 200);
            assert.match(out.body(), /"ok":true/);
            assert.deepEqual(unroutedStatusWire().dsh, ["https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat"]);
        });

        it("rejects missing agent or non-array paths with 400 (nothing recorded)", () => {
            let out = mockRes();
            handlePluginUnrouted(JSON.stringify({ paths: ["x"] }), out.res);
            assert.equal(out.status(), 400);
            out = mockRes();
            handlePluginUnrouted(JSON.stringify({ agent: "dsh", paths: "not-an-array" }), out.res);
            assert.equal(out.status(), 400);
            assert.deepEqual(unroutedStatusWire(), {});
        });

        it("rejects invalid JSON with 400", () => {
            const out = mockRes();
            handlePluginUnrouted("{nope", out.res);
            assert.equal(out.status(), 400);
        });

        it("bounds input: drops non-strings/oversize/empty, dedups, caps count", () => {
            const oversize = "https://x/" + "a".repeat(600);
            const many = Array.from({ length: 300 }, (_, i) => `https://x/${i}`);
            const out = mockRes();
            handlePluginUnrouted(JSON.stringify({ agent: "dsh", paths: [oversize, "", "   ", "https://ok/1", "https://ok/1", ...many] }), out.res);
            assert.equal(out.status(), 200);
            const stored = unroutedStatusWire().dsh ?? [];
            assert.ok(!stored.includes(oversize));
            assert.ok(!stored.includes(""));
            assert.equal(stored.filter((p) => p === "https://ok/1").length, 1, "dedup");
            assert.equal(stored.length, 256, "capped");
        });
    });

    describe("acp_status unknown-conversation 404 names the endpoints", () => {
        let deps: PluginToolDeps;
        beforeEach(() => {
            _resetPluginStateForTest();
            deps = { core: createCore(), config: defaultConfig(400_000), log: () => {} };
        });

        async function tool404(conversationId: string): Promise<{ status: number; json: Record<string, unknown> }> {
            const out = mockRes();
            await handlePluginTool(JSON.stringify({ conversationId, tool: "acp_status", args: {} }), out.res, deps);
            return { status: out.status(), json: JSON.parse(out.body()) as Record<string, unknown> };
        }

        it("no reported endpoints → original generic message (unchanged)", async () => {
            const r = await tool404(`ghost-${Math.random().toString(36).slice(2)}`);
            assert.equal(r.status, 404);
            assert.match(String(r.json.error), /unknown plugin conversation \(no model request has arrived/);
            assert.doesNotMatch(String(r.json.error), /going DIRECT \(uncompressed\)/);
        });

        it("reported endpoints → appends the specific DIRECT note naming them", async () => {
            recordUnroutedReport("dsh", [
                "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
                "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
            ]);
            const r = await tool404(`ghost-${Math.random().toString(36).slice(2)}`);
            assert.equal(r.status, 404);
            const err = String(r.json.error);
            assert.match(err, /unknown plugin conversation \(no model request has arrived/);
            assert.match(err, /going DIRECT \(uncompressed\) through unrecognized endpoint/);
            assert.match(err, /llm_utils_chat/);
            assert.match(err, /agent_chat_generation/);
            assert.match(err, /modelEndpointPatterns/);
        });
    });

    // --- Wire + web surface: real server + the REAL client IIFE ----------------
    // The unit tests above call handlePluginUnrouted directly; this pins what
    // actually ships over HTTP — the additive status/overview field (parity, the
    // #2152 lesson) and the banner rendered by the embedded browser client. The
    // client layer matters here because WEB_CLIENT is a template string tsc/tsup
    // never parse: its syntax pin lives in web-i18n (#1024), this behavior pin
    // executes the real IIFE against a live server (pattern: upstream-alerts).

    interface El {
        tagName: string;
        innerHTML: string;
        textContent: string;
        value: string;
        hidden: boolean;
        style: Record<string, unknown>;
        dataset: Record<string, unknown>;
        className: string;
        title: string;
        children: El[];
        classList: { add(): void; remove(): void; contains(): boolean; toggle(): void };
        listeners: Record<string, Array<(...args: unknown[]) => void>>;
        addEventListener(type: string, fn: (...args: unknown[]) => void): void;
        removeEventListener(): void;
        appendChild(child: El): El;
        remove(): void;
        focus(): void;
        blur(): void;
        select(): void;
        click(): void;
        getAttribute(name: string): unknown;
        setAttribute(name: string, v: unknown): void;
        querySelector(): null;
        querySelectorAll(): never[];
        closest(): null;
        getContext(): null;
    }

    function makeEl(tag: string): El {
        let html = "";
        const raw: Record<string, unknown> = {
            tagName: tag.toUpperCase(),
            textContent: "",
            value: "",
            hidden: false,
            style: {},
            dataset: {},
            className: "",
            title: "",
            children: [] as El[],
            classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
            listeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
            addEventListener(type: string, fn: (...args: unknown[]) => void) {
                (raw.listeners as Record<string, Array<(...args: unknown[]) => void>>)[type] ??= [];
                (raw.listeners as Record<string, Array<(...args: unknown[]) => void>>)[type].push(fn);
            },
            removeEventListener() { },
            appendChild(child: El) {
                (raw.children as El[]).push(child);
                const t = child.tagName.toLowerCase();
                html += `<${t}>${child.textContent || child.innerHTML}</${t}>`;
                return child;
            },
            remove() { }, focus() { }, blur() { }, select() { },
            click() { for (const fn of (raw.listeners as Record<string, Array<(...args: unknown[]) => void>>)["click"] ?? []) fn(); },
            getAttribute(name: string) { return raw[name] ?? null; },
            setAttribute(name: string, v: unknown) { raw[name] = String(v); },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            closest() { return null; },
            getContext() { return null; },
        };
        Object.defineProperty(raw, "innerHTML", {
            get: () => html,
            set: (v: string) => { html = v; if (v === "") (raw.children as El[]).length = 0; },
            enumerable: true,
        });
        return raw as unknown as El;
    }

    async function runWebClient(base: string, hash: string): Promise<{ els: Map<string, El> }> {
        const byId = new Map<string, El>();
        const idEl = (id: string): El => { let e = byId.get(id); if (!e) { e = makeEl("div"); byId.set(id, e); } return e; };
        const documentStub = {
            hidden: false,
            body: makeEl("body"),
            documentElement: makeEl("html"),
            getElementById: (id: string) => idEl(id),
            createElement: (t: string) => makeEl(t),
            querySelectorAll: () => [],
            querySelector: () => null,
            addEventListener() { },
            removeEventListener() { },
            execCommand() { return true; },
        };
        const sandbox: Record<string, unknown> = {
            console,
            setTimeout, clearTimeout, clearInterval,
            setInterval: () => 0,
            fetch: (url: string, opts?: unknown) => globalThis.fetch(new URL(url, base).toString(), opts as RequestInit | undefined),
            document: documentStub,
            window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
            location: { hash },
            navigator: { language: "en-US" },
            localStorage: { getItem: () => null, setItem() { } },
        };
        vm.createContext(sandbox);
        vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
        return { els: byId };
    }

    async function waitFor(cond: () => boolean, what: string): Promise<void> {
        const deadline = Date.now() + 5000;
        while (!cond()) {
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 20));
        }
    }

    const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
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

    async function freePort(): Promise<number> {
        const server = http.createServer();
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        return port;
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

    const P_TRAE = "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat";
    const P_QODER = "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation";

    describe("wire + web surface (real server, real client)", () => {
        it("status+overview carry the additive unrouted field with parity; invalid reports 400 over HTTP", async () => {
            const snap = saveEnv();
            const base = mkdtempSync(path.join(tmpdir(), "bili-unrouted-wire-"));
            mkdirSync(path.join(base, "sessions"), { recursive: true });
            process.env.BILI_SESSIONS_DIR = path.join(base, "sessions");
            process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
            process.env.XDG_CACHE_HOME = path.join(base, "cache");
            process.env.XDG_STATE_HOME = path.join(base, "state");
            const upstreamPort = await freePort();
            const proxy = await startServer(makeOpts(upstreamPort));
            await once(proxy, "listening");
            const port = (proxy.address() as { port: number }).port;
            try {
                const before = (await (await fetch(`http://127.0.0.1:${port}/__bili/status`)).json()) as { unrouted: Record<string, string[]> };
                const obefore = (await (await fetch(`http://127.0.0.1:${port}/__bili/overview`)).json()) as { unrouted: Record<string, string[]> };
                assert.deepEqual(before.unrouted, {}, "additive field present but empty before any report");
                assert.deepEqual(obefore.unrouted, {});

                const ok = await fetch(`http://127.0.0.1:${port}/__bili/plugin/unrouted`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ agent: "bili-native", paths: [P_TRAE, P_QODER] }),
                });
                assert.equal(ok.status, 200);
                assert.match(await ok.text(), /"ok":true/);

                const after = (await (await fetch(`http://127.0.0.1:${port}/__bili/status`)).json()) as { unrouted: Record<string, string[]> };
                const oafter = (await (await fetch(`http://127.0.0.1:${port}/__bili/overview`)).json()) as { unrouted: Record<string, string[]> };
                // per-agent lists are wire-stable sorted (unroutedStatusWire contract)
                assert.deepEqual(after.unrouted, { "bili-native": [P_QODER, P_TRAE] });
                assert.deepEqual(oafter.unrouted, after.unrouted, "status/overview parity (one shared wire helper)");

                const bad = await fetch(`http://127.0.0.1:${port}/__bili/plugin/unrouted`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{nope",
                });
                assert.equal(bad.status, 400, "route rejects malformed JSON");
                const noagent = await fetch(`http://127.0.0.1:${port}/__bili/plugin/unrouted`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ paths: ["x"] }),
                });
                assert.equal(noagent.status, 400, "route rejects missing agent");
            } finally {
                await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
                restoreEnv(snap);
                rmrf(base);
            }
        });

        it("real client renders the banner naming the endpoints; stays hidden when clean", async () => {
            const snap = saveEnv();
            const baseDir = mkdtempSync(path.join(tmpdir(), "bili-unrouted-ui-"));
            mkdirSync(path.join(baseDir, "sessions"), { recursive: true });
            process.env.BILI_SESSIONS_DIR = path.join(baseDir, "sessions");
            process.env.BILI_CONFIG_FILE = path.join(baseDir, "absent-config.json");
            process.env.XDG_CACHE_HOME = path.join(baseDir, "cache");
            process.env.XDG_STATE_HOME = path.join(baseDir, "state");
            const upstreamPort = await freePort();
            const proxy = await startServer(makeOpts(upstreamPort));
            await once(proxy, "listening");
            const port = (proxy.address() as { port: number }).port;
            const base = `http://127.0.0.1:${port}`;
            try {
                const html = renderPage(base, VERSION);
                assert.ok(html.includes('id="unrouted-banner"'), "page ships the banner element");
                assert.ok(WEB_CLIENT.includes('"unrouted-banner"'), "client targets the banner element");
                assert.ok(WEB_CLIENT.includes('t("sys.unrouted_direct"'), "client uses the localized copy key");

                await fetch(`${base}/__bili/plugin/unrouted`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ agent: "bili-native", paths: [P_TRAE, P_QODER] }),
                });
                const h1 = await runWebClient(base, "#/overview");
                await waitFor(() => {
                    const b = h1.els.get("unrouted-banner");
                    return !!b && b.hidden === false;
                }, "banner visible after report");
                const shown = h1.els.get("unrouted-banner")!;
                assert.match(shown.innerHTML, /<strong>/, "message is emphasized like sibling banners");
                assert.ok(shown.innerHTML.includes(P_TRAE), "names the TRAE endpoint");
                assert.ok(shown.innerHTML.includes(P_QODER), "names the Qoder endpoint");

                _resetUnroutedStatusForTest();
                const h2 = await runWebClient(base, "#/overview");
                await waitFor(() => h2.els.has("unrouted-banner"), "clean client overview round-trip");
                const clean = h2.els.get("unrouted-banner")!;
                assert.equal(clean.hidden, true, "no reports → banner stays hidden");
                assert.equal(clean.innerHTML, "");
            } finally {
                await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
                restoreEnv(snap);
                rmrf(baseDir);
            }
        });
    });
});
