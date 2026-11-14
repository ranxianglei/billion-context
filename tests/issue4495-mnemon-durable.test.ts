// #4495: dsh-mnemon (a THIRD-PARTY dsh plugin) injects its runtime memory
// snapshot — the user profile (USER.md) + working reference (MEMORY.md), the
// one piece of context that is supposed to be ALWAYS present — as an ordinary
// user/text message starting with "MNEMON RUNTIME MEMORY SNAPSHOT". It matched
// none of the four durable classifiers, so once it left the recent zone a
// fold silently killed the session's persona forever: the plugin re-injects
// only when the rendered text CHANGES (injectedMemoryText equality gate), so
// a stable profile is injected ONCE and never again. Same mechanism family as
// #2419/#2446/#2447/#2481, fifth carrier, second one whose emitter is the dsh
// plugin ecosystem rather than dsh core. Fix: project the header line to its
// durable identity via the dsh-lane classifier in src/durable-message-guards.ts
// (dshMnemonMemoryPath); the default durable/* latest-per-identity policy then
// pins exactly the NEWEST snapshot while superseded ones stay foldable. This
// test pins BOTH ends: the dsh lane keeps the newest snapshot across a real
// fold executed through /__bili/plugin/tool (the superseded one folds away),
// and an unregistered lane still folds it away (allowlist discipline — KDD #9).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { dshMnemonMemoryPath, durableMessageToolPaths } from "../src/durable-message-guards.ts";
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
// Shape per the #4495 report: header line, Revision line, then a
// runtime-memory-file section per memory file. Two revisions so the
// latest-per-identity semantics (newest pinned, superseded foldable) can be
// witnessed in ONE conversation; P7K/Q2W are assertion markers.
const MNEMON_V1 = `MNEMON RUNTIME MEMORY SNAPSHOT
Revision: 7
Contents of USER.md (user profile; always applied):
\x3cruntime-memory-file name="USER.md"\x3e
User prefers concise answers and TypeScript strict mode. (marker P7K)
\x3c/runtime-memory-file\x3e`;
const MNEMON_V2 = `MNEMON RUNTIME MEMORY SNAPSHOT
Revision: 9
Contents of USER.md (user profile; always applied):
\x3cruntime-memory-file name="USER.md"\x3e
User prefers concise answers, uses vim keybindings. (marker Q2W)
\x3c/runtime-memory-file\x3e`;

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

test("dshMnemonMemoryPath: projects the snapshot header to durable/mnemon-memory on non-assistant text only", () => {
    const msg = (role: string, contentType: string, text: unknown) => ({ id: "id-1", createdAt: 0, role, contentType, text }) as never;
    assert.equal(dshMnemonMemoryPath(msg("user", "text", MNEMON_V1)), "durable/mnemon-memory", "the full snapshot projects");
    assert.equal(dshMnemonMemoryPath(msg("user", "text", "MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: 1")), "durable/mnemon-memory", "the bare header line projects too — a layout change below the header cannot disarm the classifier");
    // Deliberately foldable neighbors stay consumable:
    assert.equal(dshMnemonMemoryPath(msg("user", "text", "plain prose about a memory snapshot without the exact header")), undefined, "prose without the exact header stays foldable (narrow signature on purpose)");
    assert.equal(dshMnemonMemoryPath(msg("user", "text", "\x3cruntime-memory-file name=\"USER.md\"\x3e…\x3c/runtime-memory-file\x3e")), undefined, "an inner section tag alone does NOT project — only the header line identifies the snapshot");
    assert.equal(dshMnemonMemoryPath(msg("user", "text", "\x3cavailable_skills\x3e…\x3c/available_skills\x3e")), undefined, "the #2419 skill catalog is a DIFFERENT carrier (own identity)");
    assert.equal(dshMnemonMemoryPath(msg("user", "tool-call", MNEMON_V1)), undefined, "non-text content types never match");
    assert.equal(dshMnemonMemoryPath(msg("user", "text", undefined)), undefined, "missing text is safe");
    // #2766 role boundary: every carrier is a host injection into the user
    // channel — a model ECHO of the header must not project (under
    // latest-per-identity it would take the identity over from the real
    // carrier and get the real one folded away).
    assert.equal(dshMnemonMemoryPath(msg("assistant", "text", MNEMON_V1)), undefined, "an assistant echo of the snapshot never projects");
    const dshClassifier = durableMessageToolPaths["dsh"];
    assert.ok(dshClassifier, "dsh lane is registered");
    assert.equal(dshClassifier!(msg("user", "text", MNEMON_V1)), "durable/mnemon-memory", "lane entry covers the #4495 snapshot shape");
    assert.equal(dshClassifier!(msg("user", "text", "\x3cavailable_skills\x3e…\x3c/available_skills\x3e")), "durable/skill-catalog", "lane entry still covers the #2419 catalog shape");
    assert.equal(dshClassifier!(msg("user", "text", "Instructions from: AGENTS.md")), "durable/agents-md", "lane entry still covers the #2447 baseline shape");
    assert.equal(dshClassifier!(msg("user", "text", "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.")), "durable/runtime-context", "lane entry still covers the #2481 snapshot shape");
    assert.equal(dshClassifier!(msg("user", "text", "\x3cmcp_catalog\x3e…\x3c/mcp_catalog\x3e")), "durable/mcp-catalog", "lane entry still covers the #2446 catalog shape");
    assert.deepEqual(Object.keys(durableMessageToolPaths), ["dsh"], "allowlist stays dsh-only (KDD #9 evidence-permitlist discipline)");
});

/** Grow a dsh-lane conversation carrying TWO mnemon snapshots (v1 then v2,
 *  mid-history between tagged fillers), execute a real compress through
 *  /__bili/plugin/tool whose range POSITIONALLY covers both, and return the
 *  next turn's upstream body. */
async function runTwoSnapshotFold(agent: string, conv: string): Promise<string> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        msgs.push({ role: "user", content: MNEMON_V1 });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        msgs.push({ role: "user", content: MNEMON_V2 });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A3") });
        for (let i = 4; i <= 9; i++) {
            msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: filler(i % 2 === 0 ? `F${i}` : `A${i}`) });
            await (await post(msgs)).text();
        }

        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 10, `expected >= 10 tagged messages, got ${refIds.length}`);
        // Fold from the FIRST tagged message up to four back from the tail
        // (clears preserveRecentMessages: 3): both snapshots sit inside the
        // range positionally — without the guard both would fold away.
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "issue4495 fold",
                    content: [{ startId, endId, topic: "issue4495 fold", summary: "issue4495 fold summary: filler turns were discussed and consumed; nothing else survived this range." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        msgs.push({ role: "user", content: filler("F-final") });
        await (await post(msgs)).text();
        return rig.bodies.at(-1)!;
    } finally {
        await closeRig(rig);
    }
}

test("dsh lane (#4495): the newest mnemon snapshot survives a fold that positionally covers it; the superseded one folds away", async () => {
    const postFold = await runTwoSnapshotFold("dsh", "i4495-dsh");
    assert.ok(postFold.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
    assert.ok(postFold.includes("Q2W"), "the NEWEST snapshot survives (always-on persona context retained — the reported bug)");
    assert.ok(!postFold.includes("P7K"), "the SUPERSEDED snapshot folds away (latest-per-identity: superseded instances are not worth the tokens)");
    // A2 (not F1/A1): the kernel pins the session's FIRST user message on the
    // wire even when a block covers it (kernel/src/prune.ts rebuildMessages),
    // so A1 cannot witness consumption; A2 sits between the two snapshots.
    assert.ok(!postFold.includes("A2-"), "folded filler between the snapshots must be gone (the fold really consumed its range)");
    assert.ok(!postFold.includes("F6-"), "folded filler after the snapshots must be gone");
});

test("unregistered lane: without the guard both snapshots fold away (pins lane scoping)", async () => {
    const postFold = await runTwoSnapshotFold("test-agent", "i4495-plain");
    assert.ok(postFold.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFold.includes("P7K"), "an unregistered lane has no durable-state guard — the older snapshot is ordinary history and folds away");
    assert.ok(!postFold.includes("Q2W"), "…and neither does the newest (no classifier, no identity, no protection)");
});

test("session-level: the dsh lane stamps BLOCKED refs onto mnemon snapshots at assignment time", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "i4495-stamp" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: MNEMON_V1 }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = peekSession("i4495-stamp");
        assert.ok(s, "dsh session exists");
        // Proven indirectly: the snapshot got a BLOCKED ref, i.e. it was
        // recognized as protected AT ASSIGNMENT TIME on the very first turn —
        // it can never receive an mNNNNN ref, so no compress range can ever
        // target it (structural exemption, not a convention).
        const sFull = getSession("i4495-stamp");
        const blockedRefs = Object.entries(sFull.state.messageRefs.byRaw).filter(([, ref]) => ref === "BLOCKED").length;
        assert.ok(blockedRefs >= 1, "the snapshot message must carry a BLOCKED ref (never advertised, never foldable)");
    } finally {
        await closeRig(rig);
    }
});
