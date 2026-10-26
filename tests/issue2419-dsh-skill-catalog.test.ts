// #2419: dsh's skill catalog is DURABLE STATE carried as an ordinary user
// message (dsh-tool-skill ships \x3cavailable_skills\x3e once per session and
// fingerprint-gates resends — sha256 over name+description; unchanged ⇒ never
// resent). The generic ACP fold treats every history message as consumable,
// so one compression killed skill visibility permanently. Fix: the kernel's
// host-declared Config.isMessageProtected hard-protection hook (kernel 0.0.108)
// plus the dsh-lane-scoped guard in src/durable-message-guards.ts. This test
// pins BOTH ends: the dsh lane keeps the catalog across a real fold executed
// through /__bili/plugin/tool, and an unregistered lane still folds it away
// (allowlist discipline — KDD #9: never enable wholesale).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { dshSkillCatalogPath, durableMessageToolPaths } from "../src/durable-message-guards.ts";
// #2989: rig hygiene resets the LIVE session-order registry (the persona-
// anchor ladder is off the production path on every lane since #3134 —
// v2 order resolution everywhere, google included).
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.";
const CATALOG_MARKER = "\x3cavailable_skills\x3e";
const CATALOG_MSG = `\x3csystem-reminder\x3e\nThe following skills are available in this workspace. Use the matching skill when its trigger words appear.\n${CATALOG_MARKER}\n- name: git-helper\n  description: commit conventions and rebase safety\n- name: release-notes\n  description: draft release notes from merged PRs\n\x3c/available_skills\x3e\n\x3c/system-reminder\x3e`;

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

/** Refs from NON-SYSTEM message content only: the injected system prompt
 *  carries literal ACP-tag EXAMPLES (e.g. \x3cacp …\x3em00001\x3c/acp\x3e)
 *  that a whole-body scan would mistake for live refs. */
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

test("dshSkillCatalogPath: projects the catalog marker to durable/skill-catalog on text messages only", () => {
    const msg = (contentType: string, text: unknown) => ({ id: "id-1", createdAt: 0, contentType, text }) as never;
    assert.equal(dshSkillCatalogPath(msg("text", CATALOG_MSG)), "durable/skill-catalog", "user text carrying the catalog projects to its identity");
    assert.equal(dshSkillCatalogPath(msg("text", "plain prose without any catalog")), undefined);
    assert.equal(dshSkillCatalogPath(msg("tool-call", CATALOG_MARKER)), undefined, "non-text content types never match");
    assert.equal(dshSkillCatalogPath(msg("text", undefined)), undefined, "missing text is safe");
    assert.deepEqual(Object.keys(durableMessageToolPaths), ["dsh"], "allowlist stays dsh-only (KDD #9 evidence-permitlist discipline)");
});

/** Grow a dsh-lane conversation whose fold range POSITIONALLY covers the
 *  catalog message (it sits mid-history between two tagged fillers), execute
 *  a real compress through /__bili/plugin/tool, and return the next turn's
 *  upstream body. */
async function runFoldScenario(agent: string, conv: string): Promise<{ postFoldBody: string; toolJson: Record<string, unknown> }> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        // Turn 1: two tagged fillers BEFORE the catalog…
        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        // …turn 2 drops the catalog mid-history…
        msgs.push({ role: "user", content: CATALOG_MSG });
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
        // Fold from the FIRST tagged message (before the catalog) up to four
        // back from the tail (clears preserveRecentMessages: 3): the range
        // covers the catalog positionally — the old code folds it away.
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "issue2419 fold",
                    content: [{ startId, endId, topic: "issue2419 fold", summary: "issue2419 fold summary: filler turns F1..F8 were discussed and consumed; nothing else survived this range." }],
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

test("dsh lane (#2419): the skill catalog survives a fold that positionally covers it", async () => {
    const { postFoldBody } = await runFoldScenario("dsh", "i2419-dsh");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
    assert.ok(postFoldBody.includes(CATALOG_MARKER), "the dsh skill catalog must survive the fold (hard-protected, stays fully visible)");
    // A1 (not F1): the kernel pins the session's FIRST user message on the
    // wire even when a block covers it (kernel/src/prune.ts rebuildMessages,
    // DESIGN.md §8.1 — strict providers reject user-less conversations), so
    // F1 would survive any fold and cannot witness consumption.
    assert.ok(!postFoldBody.includes("A1-"), "folded filler before the catalog must be gone (the fold really consumed its range)");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler after the catalog must be gone");
});

test("unregistered lane: without the guard the catalog folds away (pins lane scoping)", async () => {
    const { postFoldBody } = await runFoldScenario("test-agent", "i2419-plain");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFoldBody.includes(CATALOG_MARKER), "an unregistered lane has no durable-state guard — the catalog is ordinary history and folds away");
});

test("session-level: the dsh lane stamps the guard onto the effective config", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "i2419-stamp" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: CATALOG_MSG }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = peekSession("i2419-stamp");
        assert.ok(s, "dsh session exists");
        // The stamped effective config (read by /__bili/plugin/tool) carries the
        // guard — proven indirectly: the catalog got a BLOCKED ref, i.e. it was
        // recognized as protected AT ASSIGNMENT TIME on the very first turn.
        const sFull = getSession("i2419-stamp");
        const catalogBlocked = Object.entries(sFull.state.messageRefs.byRaw).some(([, ref]) => ref === "BLOCKED");
        assert.ok(catalogBlocked, "the catalog message must carry a BLOCKED ref (never advertised, never foldable)");
    } finally {
        await closeRig(rig);
    }
});
