// #7264: dsh's skill BODY (the \x3cskill_content name="…"\x3e block injected
// when the user invokes a skill, e.g. /prompt-refiner) is DURABLE STATE carried
// as an ordinary user-role text message — but unlike the skill CATALOG
// (#2419, durable/skill-catalog), it had NO classifier, so one fold of a 7K-char
// skill body collapsed it to a 1–1.3K summary, dropping the programmatic
// input-classification rules and example strategies the model needs to follow
// the skill. The host loads the body once per invocation and does NOT resend it
// (unlike the catalog's fingerprint gate), so one fold kills the skill's steps
// forever. Fix: the dshSkillLoadPath classifier projects the body to
// durable/skill-load, so the default latest-per-identity policy pins the most
// recently loaded skill body while superseded loads fold normally. This test
// pins BOTH ends: the classifier projects the marker correctly (unit), and the
// dsh lane keeps the skill body across a real fold executed through
// /__bili/plugin/tool while an unregistered lane still folds it away (lane
// scoping — KDD #9: never enable wholesale).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { dshSkillLoadPath, durableMessageToolPaths, oneShotCarrierPaths, dshCarrierRawMarkers } from "../src/durable-message-guards.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { peekSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.";
const SKILL_MARKER = "\x3cskill_content name=";
// Production shape (reporter evidence 2026-11-19): the skill body is a
// user-role text block carrying the \x3cskill_content name="…"\x3e wrapper with
// the skill's full programmatic steps. The name attribute value varies per
// skill, so the classifier matches the distinctive tag-prefix, not the full tag.
const SKILL_BODY = `\x3cskill_content name="prompt-refiner"\x3e\n# Prompt Refiner\n\n## Input classification rules\n1. If the input is a raw prompt, classify it by intent.\n2. If the input is a file, read it first.\n\n## Example strategy\n- Always produce three variants.\n- Never drop the original constraints.\n\n## Pre-delivery checklist (seven questions)\n1. Does it keep the user's intent?\n2. Does it add no new constraints?\n3. Is it shorter?\n4. Is it clearer?\n5. Is it testable?\n6. Is it reusable?\n7. Is it honest?\n\x3c/skill_content\x3e`;

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

/** Refs from NON-SYSTEM message content only: the injected system prompt
 *  carries literal ACP-tag EXAMPLES that a whole-body scan would mistake for
 *  live refs. */
function parseRefIds(body: string): string[] {
    let messages: Array<{ role?: string; content?: unknown }> = [];
    try {
        messages = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    } catch {
        return [];
    }
    const text = messages
        .filter((m) => m.role !== "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
        .join("\n");
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) ids.push(m[1]!);
    return ids;
}

test("dshSkillLoadPath: projects the skill-body marker to durable/skill-load on text messages only", () => {
    const msg = (contentType: string, text: unknown) => ({ id: "id-1", createdAt: 0, contentType, text }) as never;
    assert.equal(dshSkillLoadPath(msg("text", SKILL_BODY)), "durable/skill-load", "user text carrying the skill body projects to its identity");
    assert.equal(dshSkillLoadPath(msg("text", "plain prose about a skill without the marker")), undefined, "prose mentioning a skill is not a carrier");
    assert.equal(dshSkillLoadPath(msg("text", "\x3cskill_content\x3e no name attribute")), undefined, "the marker requires the name= attribute (distinctive tag-prefix)");
    assert.equal(dshSkillLoadPath(msg("tool-result", SKILL_BODY)), undefined, "non-text content types never match (the body is 0/73 in tool_result)");
    assert.equal(dshSkillLoadPath(msg("text", undefined)), undefined, "missing text is safe");
    // #2766 role gate: a model ECHO of the marker must never project (under
    // latest-per-identity it would take the durable/skill-load identity over
    // from the real carrier and get it folded away).
    const echo = { id: "e", role: "assistant", contentType: "text", text: SKILL_BODY } as never;
    assert.equal(dshSkillLoadPath(echo), undefined, "assistant echo must never classify (#2766)");
    // The marker is in the raw-marker pre-filter (side-request routing + drift
    // accounting) and the drift-accounting registry.
    assert.ok(dshCarrierRawMarkers.includes(SKILL_MARKER), "the skill-body marker is in dshCarrierRawMarkers");
    assert.equal(oneShotCarrierPaths.dsh!({ id: "u", role: "user", contentType: "text", text: SKILL_BODY } as never), "durable/skill-load", "drift-accounting registry");
    assert.deepEqual(Object.keys(durableMessageToolPaths), ["dsh"], "allowlist stays dsh-only (KDD #9 evidence-permitlist discipline)");
});

/** Grow a dsh-lane conversation whose fold range POSITIONALLY covers the
 *  skill body (it sits mid-history between two tagged fillers), execute a real
 *  compress through /__bili/plugin/tool, and return the next turn's upstream
 *  body. */
async function runFoldScenario(agent: string, conv: string): Promise<{ postFoldBody: string; toolJson: Record<string, unknown> }> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        // Turn 1: one tagged filler BEFORE the skill body…
        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        // …turn 2 drops the skill body mid-history…
        msgs.push({ role: "user", content: SKILL_BODY });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        // …and turns 3–8 grow past it.
        for (let i = 3; i <= 8; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }

        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 10, `expected >= 10 tagged messages, got ${refIds.length}`);
        // Fold from the FIRST tagged message (before the skill body) up to four
        // back from the tail (clears preserveRecentMessages: 3): the range
        // covers the skill body positionally — the old code folds it away.
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "issue7264 fold",
                    content: [{ startId, endId, topic: "issue7264 fold", summary: "issue7264 fold summary: filler turns F1..F8 were discussed and consumed; nothing else survived this range." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        // Next turn: the rebuilt wire is the assertion surface.
        msgs.push({ role: "user", content: filler("F9") });
        await (await post(msgs)).text();
        return { postFoldBody: rig.bodies.at(-1)!, toolJson };
    } finally {
        await closeRig(rig);
    }
}

test("dsh lane (#7264): the skill body survives a fold that positionally covers it", async () => {
    const { postFoldBody } = await runFoldScenario("dsh", "i7264-dsh");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
    assert.ok(postFoldBody.includes(SKILL_MARKER), "the dsh skill body must survive the fold (durable/skill-load, latest-per-identity pinned)");
    // The programmatic steps (the pre-delivery checklist) are the payload the
    // bug lost — assert a distinctive line survives, not just the wrapper.
    assert.ok(postFoldBody.includes("Pre-delivery checklist"), "the skill body's programmatic content must survive, not just the tag");
    // A1 (not F1): the kernel pins the session's FIRST user message on the
    // wire even when a block covers it, so F1 would survive any fold and cannot
    // witness consumption.
    assert.ok(!postFoldBody.includes("A1-"), "folded filler before the skill body must be gone (the fold really consumed its range)");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler after the skill body must be gone");
});

test("unregistered lane: without the guard the skill body folds away (pins lane scoping)", async () => {
    const { postFoldBody } = await runFoldScenario("test-agent", "i7264-plain");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFoldBody.includes(SKILL_MARKER), "an unregistered lane has no durable-state guard — the skill body is ordinary history and folds away");
});

test("session-level: the dsh lane stamps the skill-load guard onto the effective config", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "i7264-stamp" };
        // Turn 1 is a tool-less single-shot shape: the #5656 generic dsh
        // single-shot sidecar gate diverts it onto the verbatim side lane
        // (kernel no-touch — the declared residual), so no refs are assigned
        // yet. Turn 2 is the first full-pipeline turn.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: SKILL_BODY }] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.ok(peekSession("i7264-stamp"), "dsh session exists");
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: SKILL_BODY }, { role: "assistant", content: "ok" }, { role: "user", content: "Second turn after the skill body." }] }) });
        assert.equal(r2.status, 200);
        await r2.text();
        // The stamped effective config (read by /__bili/plugin/tool) carries
        // the guard — proven indirectly: the skill body got a BLOCKED ref,
        // i.e. it was recognized as protected AT ASSIGNMENT TIME on the first
        // full-pipeline turn (turn 2 — turn 1 rides the #5656 side lane). A
        // BLOCKED ref also proves the skill body carries a virtual path, so
        // lastUserAnchor skips it and the newest human request keeps the
        // anchor (the skill body never steals it).
        const sFull = peekSession("i7264-stamp")!;
        const skillBodyBlocked = Object.entries(sFull.state.messageRefs.byRaw).some(([, ref]) => ref === "BLOCKED");
        assert.ok(skillBodyBlocked, "the skill body must carry a BLOCKED ref by the first full-pipeline turn (never advertised, never foldable)");
    } finally {
        await closeRig(rig);
    }
});
