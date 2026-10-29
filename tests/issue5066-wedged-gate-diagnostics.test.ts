/**
 * #5066: dsh doom-loop exit — diagnostics for the WEDGED gate episode
 * (host agent scope dead mid-session AND body provably over window → every
 * retry locally 422-refused until host restart). Option A of the decision
 * request: zero behavior change, the wedged state becomes VISIBLE and
 * self-serviceable:
 *   (1) bili.log gains one durable detail line per endpoint on first wedge —
 *       the thrown message + bounded stack frames (the #5026 fetch probe was
 *       waiting for exactly this to name the cordis DI error shape);
 *   (2) the #3581 attribution exposure chain carries a new optional `wedged`
 *       facet (host → /__bili/plugin/attribution → status/overview → web
 *       banner) so the panel names the wedge and its escape (restart host /
 *       export + new session).
 * Both directions are asserted (#3617): set when it should, cleared when the
 * scope recovers; strict-boolean validation on the wire.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
    apply,
    _attributionHealthForTest,
    _resetAttributionHealthForTest,
    _resetRegisterForTest,
    _setModelInfoForTest,
    _setThrewRetryForTest,
    _stateTakeoverGateForTest,
    type PluginContext,
} from "../src/agent/dsh-native.ts";
import { handlePluginAttribution } from "../src/plugin.ts";
import { attributionStatusWire, recordAttributionReport, _resetAttributionStatusForTest } from "../src/server/attribution-status.ts";
import { rmrf } from "./tmp-rm.ts";

type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

/** Poll until cond() holds (10ms ticks, 15s cap). */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    try {
        await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

type AttrCall = { agent?: string; state?: string; refusals?: number; since?: number; error?: string; endpoint?: string; wedged?: boolean };

function startMockProxy(attrCalls: AttrCall[]): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: [{ name: "compress", description: "Compress a range of messages", input_schema: { type: "object", properties: { summary: { type: "string" }, range: { type: "string" } }, required: ["summary"] } }] } }));
            return;
        }
        if (url.startsWith("/__bili/plugin/tool")) {
            req.on("data", () => undefined);
            req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: "compressed 42 tokens" })); });
            return;
        }
        if (url === "/__bili/plugin/turn") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ enabled: false }));
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ panel: "PANEL-OK" }));
            return;
        }
        if (url === "/__bili/plugin/session-name") {
            req.on("data", () => undefined);
            req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
            return;
        }
        if (url === "/__bili/plugin/attribution") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                try { attrCalls.push(JSON.parse(body) as AttrCall); } catch { /* probe bodies are not under test here */ }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

function mockCtx() {
    const tools: RegisteredTool[] = [];
    type CmdInvocation = { agent?: { session?: { id?: unknown } } };
    const commands: Array<{ name: string; handler: (invocation?: CmdInvocation) => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown; requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined } } | undefined = undefined;
    let llm: { resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> } | undefined = undefined;
    let agentDefaultModel: { currentSelection?: () => { provider?: string; model?: string } | undefined } | undefined = undefined;
    type HostCtx = Parameters<typeof apply>[0];
    type HostListener = Parameters<NonNullable<PluginContext["on"]>>[1];
    const listeners: Record<string, HostListener[]> = {};
    return {
        tools: { register: (t: RegisteredTool) => tools.push(t) },
        commands: { register: (c: { name: string; handler: (invocation?: { agent?: { session?: { id?: unknown } } }) => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown; requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        on: (event: string, listener: HostListener, _options?: { global?: boolean }) => { (listeners[event] ??= []).push(listener); },
        emit: (event: string, ...args: unknown[]) => { for (const l of listeners[event] ?? []) (l as (...a: unknown[]) => void)(...args); },
        get sessions(): PluginContext["sessions"] { return undefined; },
        get sessionTitle(): PluginContext["sessionTitle"] { return undefined; },
        inject: (deps: readonly string[], callback: (sub: HostCtx) => void) => {
            if (deps.includes("llm") && deps.includes("agentDefaultModel") && llm !== undefined && agentDefaultModel !== undefined) {
                callback({ llm, agentDefaultModel } as HostCtx);
            }
        },
        setModelServices: (l: typeof llm, a: typeof agentDefaultModel) => {
            llm = l;
            agentDefaultModel = a;
        },
    };
}

test("#5066: wedged gate episode — log detail + exposure chain, once per endpoint, cleared on recovery", async () => {
    const attrCalls: AttrCall[] = [];
    const proxy = await startMockProxy(attrCalls);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5066-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5066-home-"));
    fs.mkdirSync(path.join(home, "web"), { recursive: true });
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            class Llm5066 { async resolveModelInfo() { return undefined; } }
            ctx.setModelServices(new Llm5066(), { currentSelection: () => ({ provider: "p5066", model: "m5066" }) });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "dsh native tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeover gate installed");
            _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
            // The #5026 shape: the host scope dies mid-session — every
            // initiator lookup throws the cordis DI error.
            ctx.agents.currentInitiator = () => { throw new Error('cannot get required service "agents" in inactive context'); };
            // declared 1000 < the 1M floor → bar = 1_000_000 tok; 4,000,004 B / 4 = 1,000,001 tok → doom arm.
            _setModelInfoForTest({ provider: "p5066", model: "m5066", contextWindow: 1000 });
            const url = `${proxy.origin}/v1/messages`;
            assert.equal(await gate(url, { bytes: 4_000_004 }), "refuse-oversized");

            // (a) sticky wedged facet on the host-side health record
            const health = _attributionHealthForTest();
            assert.equal(health.state, "threw");
            assert.equal(health.wedged, true);

            // (b) the exposure chain carries it to the proxy (async POST)
            await waitFor(() => attrCalls.some((c) => c.wedged === true), "wedged attribution report");
            assert.ok(attrCalls.some((c) => c.state === "threw" && c.wedged === true), "report pairs state threw with wedged");

            // (c) durable log: ONE detail line per endpoint with thrown message + frames
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            const readLines = () => fs.readFileSync(logFile, "utf8").split("\n");
            let lines = readLines();
            let wedgedLines = lines.filter((l) => l.includes("takeover gate WEDGED"));
            assert.equal(wedgedLines.length, 1, "exactly one WEDGED detail line after first refusal");
            assert.ok(wedgedLines[0].includes('currentInitiator() threw: cannot get required service "agents" in inactive context'), "detail line names the thrown error");
            let frameLines = lines.filter((l) => l.includes("attribution stack:"));
            assert.ok(frameLines.length >= 1, "stack frame(s) logged");
            assert.ok(frameLines.some((l) => l.includes("dsh-native")), "a frame points at the throwing module");

            // second identical retry: same verdict, NO duplicate detail line
            assert.equal(await gate(url, { bytes: 4_000_004 }), "refuse-oversized");
            lines = readLines();
            assert.equal(lines.filter((l) => l.includes("takeover gate WEDGED")).length, 1, "no duplicate detail line on retry");

            // (d) recovery: scope back → gate passes, episode resets, wedged cleared
            ctx.agents.currentInitiator = () => ({ session: { id: "sess-5066" } });
            assert.equal(await gate(url, { bytes: 4_000_004 }), true);
            const recovered = _attributionHealthForTest();
            assert.equal(recovered.state, "ok");
            assert.equal(recovered.wedged, undefined, "recovery clears the sticky facet");
            await waitFor(() => {
                const iWedged = attrCalls.findIndex((c) => c.wedged === true);
                const iOk = attrCalls.findIndex((c) => c.state === "ok");
                return iWedged !== -1 && iOk > iWedged;
            }, "recovery report after the wedged report");
            const iOk = attrCalls.findIndex((c) => c.state === "ok");
            assert.equal(attrCalls[iOk].wedged, undefined, "recovery report does not carry wedged");
        });
    } finally {
        _setThrewRetryForTest();
        _setModelInfoForTest();
        await proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetAttributionHealthForTest();
    }
});

test("#5066: attribution store + wire carry wedged only when strictly true", () => {
    try {
        _resetAttributionStatusForTest();
        recordAttributionReport("dsh-a", { state: "threw", refusals: 1, since: 1, error: "e", endpoint: "ep", wedged: true });
        recordAttributionReport("dsh-b", { state: "threw", refusals: 1, since: 1 });
        recordAttributionReport("dsh-c", { state: "threw", refusals: 1, since: 1, wedged: false });
        const wire = attributionStatusWire();
        assert.equal(wire["dsh-a"].wedged, true);
        assert.equal(wire["dsh-b"].wedged, undefined, "absent stays absent");
        assert.equal(wire["dsh-c"].wedged, undefined, "explicit false never lights the banner");
    } finally {
        _resetAttributionStatusForTest();
    }
});

function stubRes(): { res: http.ServerResponse; status: number | undefined; body: string } {
    const out: { res: http.ServerResponse; status: number | undefined; body: string } = { res: undefined as unknown as http.ServerResponse, status: undefined, body: "" };
    const s: { writeHead: (status: number) => void; end: (body?: string) => void } = {
        writeHead(status: number) { out.status = status; },
        end(body?: string) { if (body !== undefined) out.body += String(body); },
    };
    out.res = s as unknown as http.ServerResponse;
    return out;
}

test("#5066: /__bili/plugin/attribution validates wedged as a strict boolean", () => {
    try {
        _resetAttributionStatusForTest();
        const r1 = stubRes();
        handlePluginAttribution(JSON.stringify({ agent: "dsh-h", state: "threw", refusals: 1, since: 0, wedged: true }), r1.res);
        assert.equal(r1.status, 200);
        assert.equal(attributionStatusWire()["dsh-h"].wedged, true, "valid boolean recorded");

        const r2 = stubRes();
        handlePluginAttribution(JSON.stringify({ agent: "dsh-i", state: "threw", refusals: 1, since: 0, wedged: "yes" }), r2.res);
        assert.equal(r2.status, 200);
        assert.equal(attributionStatusWire()["dsh-i"].wedged, undefined, "truthy string must not light the banner");

        const r3 = stubRes();
        handlePluginAttribution(JSON.stringify({ agent: "dsh-j", state: "bogus", refusals: 1, since: 0 }), r3.res);
        assert.equal(r3.status, 400, "invalid state still rejected");
        assert.equal(attributionStatusWire()["dsh-j"], undefined, "rejected payload not recorded");
    } finally {
        _resetAttributionStatusForTest();
    }
});
