import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #5490: host-resolved tier aliases (WorkBuddy's "fast-model") exist in no
// window source bili reads — no table entry, no registry identity by design —
// so they resolve to source=default/fallback=true and silently ride the
// anonymous default window (200000 → 152000 effective) in every session. The
// first-sight [window] line is info-level and once-per-process, and a
// mid-session [window-change] onto that guessed base is likewise info: an
// operator never learns that dozens of sessions are sized against a guess,
// until one of them reads usage=1567% and EMERGENCY-folds. These tests pin
// the observability fix:
//   1. noteUnresolvedModelSession — distinct-session counter, true exactly
//      once per process at the threshold;
//   2. e2e — first sight of a fully unresolved model warns ("resolved to
//      NOTHING"), recurrence across distinct sessions warns once with the
//      declaration that fixes it;
//   3. e2e — a mid-session [window-change] landing on the anonymous default
//      escalates to warn with the LANDING annotation;
//   4. negative gates — table hits, operator-tuned windows, and known→known
//      switches must NOT trigger any of the new warns.

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { noteUnresolvedModelSession, UNRESOLVED_MODEL_SESSION_THRESHOLD, _resetUnresolvedModelSessionsForTest } from "../src/server/context-window.ts";

type LogEntry = { level: string; msg: string };

test("#5490 unit: noteUnresolvedModelSession counts DISTINCT sessions and fires exactly once", () => {
    _resetUnresolvedModelSessionsForTest();
    // First session: counted, not yet recurring.
    assert.equal(noteUnresolvedModelSession("fast-model", "s1"), false);
    // Repeat requests in the same session: still below threshold.
    assert.equal(noteUnresolvedModelSession("fast-model", "s1"), false);
    assert.equal(noteUnresolvedModelSession("fast-model", "s1"), false);
    // Second distinct session: threshold crossed → true exactly here …
    assert.equal(UNRESOLVED_MODEL_SESSION_THRESHOLD, 2);
    assert.equal(noteUnresolvedModelSession("fast-model", "s2"), true);
    // … and never again for this process, however many sessions follow.
    assert.equal(noteUnresolvedModelSession("fast-model", "s3"), false);
    assert.equal(noteUnresolvedModelSession("fast-model", "s2"), false);
    // Other models count independently.
    assert.equal(noteUnresolvedModelSession("wb-lite", "s1"), false);
    assert.equal(noteUnresolvedModelSession("wb-lite", "s2"), true);
    _resetUnresolvedModelSessionsForTest();
    assert.equal(noteUnresolvedModelSession("fast-model", "s9"), false, "reset clears the counter");
});

const WINDOW = 100_000;
const MODEL_KNOWN_A = "gpt-known-a-5490";
const MODEL_KNOWN_B = "gpt-known-b-5490";
const MODEL_ALIAS_1 = "fast-model-5490a";
const MODEL_ALIAS_2 = "balanced-model-5490b";
const MODEL_TABLE_HIT = "qwen-mystery-5490c";

function makeUpstream(model: string): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c5490", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c5490", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c5490", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } })}\n\n`);
        res.end(`data: [DONE]\n\n`);
    });
}

// Provider route keys are boundary-safe prefixes of the FULL upstream URL
// (#2317): "http://127.0.0.1" would not match "http://127.0.0.1:<port>/…", so
// the key must carry the upstream's real port.
type RoutesFor = (upPort: number) => ProxyOptions["routes"];

async function startHarness(routesFor: RoutesFor, compress?: NonNullable<ProxyOptions["compress"]>): Promise<{ proxy: http.Server; up: http.Server; proxyPort: number; upPort: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const up = makeUpstream("up");
    up.listen(0, "127.0.0.1");
    await once(up, "listening");
    const upPort = (up.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routesFor(upPort) ?? {},
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: compress ?? { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, up, proxyPort: (proxy.address() as { port: number }).port, upPort };
}

async function drive(proxyPort: number, upPort: number, model: string, session: string): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        // max_tokens must clear the side-request threshold (<=200 → passthrough,
        // kernel pipeline skipped) or [window-change] is never reached.
        body: JSON.stringify({ model, max_tokens: 300, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(r.status, 200, `request must succeed, got ${r.status}: ${await r.text().catch(() => "")}`);
    await r.body?.cancel().catch(() => { /* drained */ });
}

async function withHarness<T>(routesFor: RoutesFor, compress: NonNullable<ProxyOptions["compress"]> | undefined, fn: (h: Awaited<ReturnType<typeof startHarness>>, logs: LogEntry[]) => Promise<void>): Promise<void> {
    _resetUnresolvedModelSessionsForTest();
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => { logs.push({ level, msg }); });
    const h = await startHarness(routesFor, compress);
    try {
        await fn(h, logs);
    } finally {
        setLogCapture(null);
        h.proxy.close();
        h.proxy.closeIdleConnections?.();
        h.up.close();
        h.up.closeIdleConnections?.();
        await Promise.allSettled([once(h.proxy, "close"), once(h.up, "close")]);
    }
}

test("#5490 e2e: first sight of a fully unresolved model warns; recurrence across sessions warns once", async () => {
    await withHarness(() => ({}), undefined, async (h, logs) => {
        await drive(h.proxyPort, h.upPort, MODEL_ALIAS_1, "s-a");
        // The info line is the one carrying source=/fallback= fields; the new
        // warn shares the "[window] model=X" prefix but not the fields.
        const winLines = logs.filter((l) => l.msg.includes(`[window] model=${MODEL_ALIAS_1} source=`));
        assert.equal(winLines.length, 1, `one [window] line on first sight, got: ${JSON.stringify(winLines)}`);
        assert.ok(winLines[0].msg.includes("source=default") && winLines[0].msg.includes("fallback=true"), winLines[0].msg);
        let nothingWarns = logs.filter((l) => l.level === "warn" && l.msg.includes(`model=${MODEL_ALIAS_1} resolved to NOTHING`));
        assert.equal(nothingWarns.length, 1, `first-sight warn must fire exactly once, got: ${JSON.stringify(nothingWarns)}`);
        assert.ok(nothingWarns[0].msg.includes("anonymous default"), nothingWarns[0].msg);
        assert.ok(nothingWarns[0].msg.includes("providers.<upstream>.models."), nothingWarns[0].msg);
        assert.ok(!logs.some((l) => l.msg.includes("still unresolved after")), "no recurrence warn within one session");

        // More requests in the SAME session: no further warns of either kind.
        await drive(h.proxyPort, h.upPort, MODEL_ALIAS_1, "s-a");
        nothingWarns = logs.filter((l) => l.level === "warn" && l.msg.includes(`model=${MODEL_ALIAS_1} resolved to NOTHING`));
        assert.equal(nothingWarns.length, 1, "same-session repeats must not re-warn");
        assert.ok(!logs.some((l) => l.msg.includes("still unresolved after")), "same-session repeats must not count as recurrence");

        // A SECOND distinct session: the alias is clearly recurring now.
        await drive(h.proxyPort, h.upPort, MODEL_ALIAS_1, "s-b");
        const recurWarns = logs.filter((l) => l.level === "warn" && l.msg.includes(`model=${MODEL_ALIAS_1} still unresolved after`));
        assert.equal(recurWarns.length, 1, `recurrence warn must fire exactly once, got: ${JSON.stringify(recurWarns)}`);
        assert.ok(recurWarns[0].msg.includes(`${UNRESOLVED_MODEL_SESSION_THRESHOLD}+ sessions`), recurWarns[0].msg);
        assert.ok(recurWarns[0].msg.includes("providers.<upstream>.models."), recurWarns[0].msg);

        // Further sessions: silent (once per process).
        await drive(h.proxyPort, h.upPort, MODEL_ALIAS_1, "s-c");
        assert.equal(logs.filter((l) => l.level === "warn" && l.msg.includes("still unresolved after")).length, 1, "recurrence warn must stay at one per process");
    });
});

test("#5490 e2e: mid-session switch ONTO the anonymous default escalates [window-change] to warn", async () => {
    const routesFor = (upPort: number): ProxyOptions["routes"] => ({ [`http://127.0.0.1:${upPort}`]: { models: { [MODEL_KNOWN_A]: { context: WINDOW }, [MODEL_KNOWN_B]: { context: WINDOW } } } });
    await withHarness(routesFor, undefined, async (h, logs) => {
        // Healthy known state first (configured window, no fallback).
        await drive(h.proxyPort, h.upPort, MODEL_KNOWN_A, "s-switch");
        const winA = logs.find((l) => l.msg.includes(`[window] model=${MODEL_KNOWN_A} `));
        assert.ok(winA?.msg.includes("source=configured") && winA?.msg.includes("fallback=false"), winA?.msg ?? "no [window] line for the known model");

        // Picker click: same session, unresolvable alias.
        await drive(h.proxyPort, h.upPort, MODEL_ALIAS_2, "s-switch");
        const changes = logs.filter((l) => l.msg.includes("[window-change]") && l.msg.includes(MODEL_ALIAS_2));
        assert.equal(changes.length, 1, `one [window-change] for the switch, got: ${JSON.stringify(changes)}`);
        assert.equal(changes[0].level, "warn", `[window-change] onto the anonymous default must be WARN, got ${changes[0].level}: ${changes[0].msg}`);
        assert.ok(changes[0].msg.includes("LANDING ON THE ANONYMOUS DEFAULT"), changes[0].msg);
        assert.ok(changes[0].msg.includes(`-> ${MODEL_ALIAS_2}/default/${WINDOW}`), changes[0].msg);
        assert.ok(changes[0].msg.includes("(#5490)"), changes[0].msg);
    });
});

test("#5490 negative gates: known→known switch, table hit, and operator tuning stay quiet", async () => {
    const routesFor = (upPort: number): ProxyOptions["routes"] => ({ [`http://127.0.0.1:${upPort}`]: { models: { [MODEL_KNOWN_A]: { context: WINDOW }, [MODEL_KNOWN_B]: { context: WINDOW } } } });
    await withHarness(routesFor, undefined, async (h, logs) => {
        // Known → known: [window-change] fires but stays INFO, no LANDING text.
        await drive(h.proxyPort, h.upPort, MODEL_KNOWN_A, "s-neg");
        await drive(h.proxyPort, h.upPort, MODEL_KNOWN_B, "s-neg");
        const changes = logs.filter((l) => l.msg.includes("[window-change]") && l.msg.includes(MODEL_KNOWN_B));
        assert.equal(changes.length, 1, `one [window-change] for the known→known switch, got: ${JSON.stringify(changes)}`);
        assert.equal(changes[0].level, "info", `known→known must stay INFO, got ${changes[0].level}: ${changes[0].msg}`);
        assert.ok(!changes[0].msg.includes("LANDING ON THE ANONYMOUS DEFAULT"), changes[0].msg);

        // Built-in table hit: fallback=true but native IS defined → no NOTHING warn.
        await drive(h.proxyPort, h.upPort, MODEL_TABLE_HIT, "s-neg-table");
        const winT = logs.find((l) => l.msg.includes(`[window] model=${MODEL_TABLE_HIT} `));
        assert.ok(winT?.msg.includes("source=table-or-registry") && winT?.msg.includes("fallback=true"), winT?.msg ?? "no [window] line for the table-hit model");
        assert.ok(!logs.some((l) => l.msg.includes(`model=${MODEL_TABLE_HIT} resolved to NOTHING`)), "table hit must not claim NOTHING");
        assert.ok(!logs.some((l) => l.msg.includes(`model=${MODEL_TABLE_HIT} still unresolved`)), "table hit must not count as unresolved");
    });

    // Operator-tuned global window: the "default" base is owned by the
    // operator, not a guess — neither warn may fire. Fresh model name:
    // windowSourceLogged is once-per-process with no reset export.
    const MODEL_ALIAS_TUNED = "lite-model-5490d";
    await withHarness(() => ({}), { injectTool: true, injectNudge: true, modelContextLimit: 50_000 }, async (h, logs) => {
        await drive(h.proxyPort, h.upPort, MODEL_ALIAS_TUNED, "s-tuned");
        const win = logs.find((l) => l.msg.includes(`[window] model=${MODEL_ALIAS_TUNED} `));
        assert.ok(win?.msg.includes("base=50000") && win?.msg.includes("fallback=false"), win?.msg ?? "no [window] line for the tuned model");
        assert.ok(!logs.some((l) => l.msg.includes("resolved to NOTHING")), "operator-tuned default must not warn as a guess");
        assert.ok(!logs.some((l) => l.msg.includes("still unresolved after")), "operator-tuned default must not count as unresolved");
    });
});
