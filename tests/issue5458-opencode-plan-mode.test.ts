// #5458: OpenCode v2 injects ONE-SHOT state notices on plan/build agent
// switches — exactly two \x3csystem-reminder\x3e-wrapped user-role templates
// ("You are in Plan mode. …" / "You are NO LONGER in Plan mode. …"), emitted
// once per switch and never re-emitted. No class rule existed for them
// (`grep -c "system-reminder" dist/index.js` = 0 in 0.1.211), so one fold of
// the LATEST notice silently reverted the session to the previous state
// forever: the incident kept the stale "in Plan mode" notice visible at the
// head while the exit notice was folded, and the model obeyed plan-mode
// restrictions for 20+ turns after switching to build. Fix: project both
// variants to the SAME durable identity (`durable/plan-mode`) via the
// opencode-lane classifier in src/durable-message-guards.ts — under the
// default latest-per-identity policy exactly the newest declaration stays
// pinned and superseded ones fold away, so the visible state converges to
// the current one. Same shape precedent as the dsh runtime-context
// populated/cleared pair (#2481). This test pins BOTH ends: the opencode
// lane keeps the latest notice across a real fold executed through
// /__bili/plugin/tool (and folds the superseded one), and an unregistered
// lane still folds both away (allowlist discipline — KDD #9).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { opencodePlanModePath, durableMessageToolPaths } from "../src/durable-message-guards.ts";
// #2989: rig hygiene resets the LIVE session-order registry.
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { peekSession, getSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are OpenCode, the main coding agent.";
// Exact templates extracted verbatim from the shipped OpenCode v2 CLI bundle
// (the `opencode.plan` effect). Angle brackets hex-escaped per KDD #2.
const ENTER_MSG = "\x3csystem-reminder\x3e\nYou are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:\n/home/user/.opencode/plan\n\nDo not modify any other files or ask a subagent to do so.\n\nYou remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.\n\x3c/system-reminder\x3e";
const EXIT_MSG = "\x3csystem-reminder\x3e\nYou are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.\n\x3c/system-reminder\x3e";
const EXIT_MARKER = "NO LONGER in Plan mode";
const ENTER_MARKER = "Discuss the plan with the user directly";

function filler(tag: string): string {
    return `${tag}-` + "z".repeat(900);
}

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server; bodies: string[] };

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString("utf8")));
        req.on("end", () => {
            bodies.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetSessionOrderForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 0,
            compress: { minCompressRange: 500, maxSummaryLength: 20_000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: false },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream, bodies };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

/** Ref of the (non-system) message whose text starts with `prefix`. Scans
 *  non-system messages only: the injected system prompt carries literal
 *  ACP-tag EXAMPLES that a whole-body scan would mistake for live refs. */
function refOfPrefix(body: string, prefix: string): string {
    const messages = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    for (const m of messages) {
        if (m.role === "system") continue;
        const c = typeof m.content === "string" ? m.content : "";
        const clean = c.replace(/^<acp [^>]*>[^<]*<\/acp>\n?/, "");
        if (!clean.startsWith(prefix)) continue;
        const t = c.match(/<acp [^>]*>\s*(m\d+)\s*<\/acp>/);
        assert.ok(t, `the ${prefix} message must carry a ref tag`);
        return t[1]!;
    }
    throw new Error(`no non-system message starting with "${prefix}" in the upstream body`);
}

/** Grow an opencode-lane conversation in the INCIDENT geometry: ENTER notice
 *  near the head (positionally OUTSIDE the fold range), EXIT notice
 *  mid-history (INSIDE the range), then execute a real compress through
 *  /__bili/plugin/tool covering the EXIT position and return the next turn's
 *  upstream body. */
async function runIncidentGeometry(agent: string, conv: string): Promise<{ postFoldBody: string; toolJson: Record<string, unknown> }> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        // Non-system order that results: F1 A1 ENTER A2 F3 A3 F4 A4 F5 A5 F6
        // A6 EXIT A7 F8 A8 F9 A9 F10 A10 F11 (last posted turn ends at F11).
        // On the opencode lane the two notices carry no visible ref (EXIT is
        // BLOCKED; ENTER was demoted by EXIT and its ref render is deferred to
        // the next fold boundary per #3939), so refs are looked up BY CONTENT.
        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        msgs.push({ role: "user", content: ENTER_MSG });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        for (let i = 3; i <= 6; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }
        msgs.push({ role: "user", content: EXIT_MSG });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A7") });
        for (let i = 8; i <= 11; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }

        // Fold F3..F9: covers EXIT POSITIONALLY (it sits between A6 and A7),
        // leaves ENTER outside the range — exactly the incident's geometry,
        // where the stale head notice survived and the new one was folded.
        // Ending at F9 keeps the preserve-recent tail (F10/A10/F11) whole.
        const lastBody = rig.bodies.at(-1)!;
        const startId = refOfPrefix(lastBody, "F3-");
        const endId = refOfPrefix(lastBody, "F9-");
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "issue5458 fold",
                    content: [{ startId, endId, topic: "issue5458 fold", summary: "issue5458 fold summary: filler turns F3..F9 were discussed and consumed; nothing else survived this range." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        msgs.push({ role: "user", content: filler("F12") });
        await (await post(msgs)).text();
        return { postFoldBody: rig.bodies.at(-1)!, toolJson };
    } finally {
        await closeRig(rig);
    }
}

/** Grow a conversation where BOTH notices sit inside ONE fold range (ENTER
 *  between fillers, EXIT between fillers), execute the compress, return the
 *  next turn's upstream body. */
async function runBothCovered(agent: string, conv: string): Promise<{ postFoldBody: string; toolJson: Record<string, unknown> }> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        // Order: F1 A1 E2 A2 ENTER A3 F4 A4 F5 A5 EXIT A6 F7 A7 F8 A8 F9 A9
        // F10 (last posted turn ends at F10). Same ref-render caveat as the
        // incident geometry: look refs up by content.
        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        msgs.push({ role: "user", content: filler("E2") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        msgs.push({ role: "user", content: ENTER_MSG });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A3") });
        for (let i = 4; i <= 5; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }
        msgs.push({ role: "user", content: EXIT_MSG });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A6") });
        for (let i = 7; i <= 10; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }

        // Fold E2..F8: covers BOTH notices (ENTER between A2/A3, EXIT between
        // A5/A6). Ending at F8 keeps the preserve-recent tail (F9/A9/F10) whole.
        const lastBody = rig.bodies.at(-1)!;
        const startId = refOfPrefix(lastBody, "E2-");
        const endId = refOfPrefix(lastBody, "F8-");
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "issue5458 both-covered fold",
                    content: [{ startId, endId, topic: "issue5458 both-covered fold", summary: "issue5458 both-covered summary: filler turns E2..F8 plus the plan-mode switch history were discussed and consumed." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        msgs.push({ role: "user", content: filler("F11") });
        await (await post(msgs)).text();
        return { postFoldBody: rig.bodies.at(-1)!, toolJson };
    } finally {
        await closeRig(rig);
    }
}

test("opencodePlanModePath: projects both one-shot switch notices to durable/plan-mode, nothing else", () => {
    const msg = (role: string, contentType: string, text: unknown) => ({ id: "id-1", createdAt: 0, role, contentType, text }) as never;
    assert.equal(opencodePlanModePath(msg("user", "text", ENTER_MSG)), "durable/plan-mode", "the enter notice projects");
    assert.equal(opencodePlanModePath(msg("user", "text", EXIT_MSG)), "durable/plan-mode", "the exit notice projects to the SAME identity (latest-per-identity semantics)");
    assert.equal(opencodePlanModePath(msg("user", "text", "plain prose about planning your day")), undefined, "ordinary prose never matches");
    assert.equal(opencodePlanModePath(msg("assistant", "text", ENTER_MSG)), undefined, "#2766: an assistant echo must not take over the carrier identity");
    assert.equal(opencodePlanModePath(msg("user", "tool-call", EXIT_MSG)), undefined, "non-text content types never match");
    assert.equal(opencodePlanModePath(msg("user", "text", undefined)), undefined, "missing text is safe");
    const ocClassifier = durableMessageToolPaths["opencode"];
    assert.ok(ocClassifier, "opencode lane is registered");
    assert.equal(ocClassifier!(msg("user", "text", EXIT_MSG)), "durable/plan-mode", "lane entry covers the exit shape");
    assert.deepEqual(Object.keys(durableMessageToolPaths).sort(), ["dsh", "opencode"], "allowlist stays evidence-backed (KDD #9) — no wholesale lanes");
});

test("opencode lane (#5458 incident geometry): the exit notice survives a fold that positionally covers it", async () => {
    const { postFoldBody } = await runIncidentGeometry("opencode", "i5458-opencode");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
    assert.ok(postFoldBody.includes(EXIT_MARKER), "the LATEST state declaration must survive the fold — this is the bug: pre-fix it was folded and the session kept acting on the stale head notice");
    assert.ok(postFoldBody.includes(ENTER_MARKER), "the head notice sat outside the range and stays visible; the newest declaration (the exit) governs because it is later in the conversation");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler inside the range must be gone (the fold really consumed its range)");
    assert.ok(!postFoldBody.includes("A5-"), "folded assistant filler inside the range must be gone too");
});

test("opencode lane (#5458 convergence): one fold covering BOTH notices keeps the latest, folds the superseded", async () => {
    const { postFoldBody } = await runBothCovered("opencode", "i5458-converge");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(postFoldBody.includes(EXIT_MARKER), "the newest declaration (exit) stays pinned under latest-per-identity");
    assert.ok(!postFoldBody.includes(ENTER_MARKER), "the SUPERSEDED declaration (enter) is foldable — shared identity means the visible state converges instead of piling up contradictory notices");
    assert.ok(!postFoldBody.includes("E2-"), "folded filler before the enter notice must be gone");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler between the two notices must be gone too (the whole range was consumed)");
});

test("unregistered lane: without the guard both notices fold away (pins lane scoping)", async () => {
    const { postFoldBody } = await runIncidentGeometry("test-agent", "i5458-plain");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFoldBody.includes(EXIT_MARKER), "an unregistered lane has no durable-state guard — the exit notice is ordinary history and folds away");
});

test("session-level: the opencode lane stamps the guard onto the effective config", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "i5458-stamp" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: EXIT_MSG }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = peekSession("i5458-stamp");
        assert.ok(s, "opencode session exists");
        // Proven indirectly: the session's only non-system message got a
        // BLOCKED ref, i.e. the notice was recognized as protected AT
        // ASSIGNMENT TIME on the very first turn.
        const sFull = getSession("i5458-stamp");
        const exitBlocked = Object.entries(sFull.state.messageRefs.byRaw).some(([, ref]) => ref === "BLOCKED");
        assert.ok(exitBlocked, "the exit notice must carry a BLOCKED ref (never advertised, never foldable)");
    } finally {
        await closeRig(rig);
    }
});
