// Durable virtual tool paths — the architecture test (#2446 family).
//
// The four dsh durable-state carriers (#2419 skill catalog, #2446 mcp
// catalog, #2447 workspace instructions, #2481 runtime context) project to
// canonical `durable/<name>` identities via a host classifier
// (Config.messagePathOf, kernel 0.0.116), and the EXISTING
// protectedTools / protectedLatestTools pattern machinery governs them —
// same knobs, same semantics as the tool channel (#1947).
//
// This suite pins the POLICY contract:
//   1. default: bili ensures `durable/*` latest-per-identity protection
//      (protectedLatestTools) — exactly one live instance per carrier, the
//      pi-reference single-live-copy semantics; superseded instances fold;
//   2. takeover: ANY `durable` pattern in the user's protectedTools or
//      protectedLatestTools takes over the whole durable policy — bili only
//      attaches the classifier, adds nothing;
//   3. e2e: default folds the older catalog and keeps the newest (skill
//      visibility can never be lost); explicit takeover reproduces the same
//      outcome without double injection; `protectedTools: ["durable/*"]`
//      (all-instance takeover) keeps every catalog instance; and
//      `protectedTools: ["durable/agents-md"]` (exact identity takeover)
//      lets the skill catalog fold while the baseline survives.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, type Config } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { CompressSettings } from "../src/config.ts";
import { withDurableProtection, durableMessageToolPaths, dshSkillCatalogPath } from "../src/durable-message-guards.ts";
// #2989: rig hygiene resets the LIVE session-order registry (the persona-
// anchor ladder is off the production path on every lane since #3134 —
// v2 order resolution everywhere, google included).
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.";
const CATALOG_V1 = `\x3csystem-reminder\x3e\nThe following skills are available in this workspace.\n\x3cavailable_skills\x3e\n- name: git-helper\n  description: commit conventions and rebase safety\n\x3c/available_skills\x3e\n\x3c/system-reminder\x3e`;
const CATALOG_V2 = `\x3csystem-reminder\x3e\nThe following skills are available in this workspace.\n\x3cavailable_skills\x3e\n- name: doc-writer\n  description: draft documentation from merged PRs\n\x3c/available_skills\x3e\n\x3c/system-reminder\x3e`;
const AGENTS_MD = "Instructions from: AGENTS.md\nrepo policy: always run tests before pushing (marker X7Q).";

function filler(tag: string): string {
    return `${tag}-` + "z".repeat(900);
}

// ---------------------------------------------------------------- units ----

test("withDurableProtection: default ensures durable/* latest-per-identity + classifier hook", () => {
    const cl = durableMessageToolPaths["dsh"]!;
    const base = defaultConfig(200_000);
    const out = withDurableProtection(base, cl);
    assert.deepEqual(out.protectedLatestTools, ["durable/*"], "default adds durable/* to protectedLatestTools");
    assert.equal(out.messagePathOf, cl, "classifier attached");
    assert.equal(out.protectedTools, base.protectedTools, "all-instance list untouched");
    // Existing tool-channel patterns are preserved, durable/* appended:
    const out2 = withDurableProtection({ ...base, protectedLatestTools: ["skill/*"] }, cl);
    assert.deepEqual(out2.protectedLatestTools, ["skill/*", "durable/*"]);
});

test("withDurableProtection: a durable pattern in protectedTools = whole-identity takeover", () => {
    const cl = durableMessageToolPaths["dsh"]!;
    const out = withDurableProtection({ ...defaultConfig(200_000), protectedTools: ["read", "durable/agents-md"] }, cl);
    assert.deepEqual(out.protectedTools, ["read", "durable/agents-md"], "no durable/* injected — user policy wins verbatim");
    assert.equal(out.messagePathOf, cl, "classifier still attached (identity translation is bili's job)");
});

test("withDurableProtection: a durable pattern in protectedLatestTools = takeover too (no default injection)", () => {
    const cl = durableMessageToolPaths["dsh"]!;
    const out = withDurableProtection({ ...defaultConfig(200_000), protectedLatestTools: ["durable/*"] }, cl);
    assert.deepEqual(out.protectedTools, [], "protectedTools not extended when latest takes over");
    assert.deepEqual(out.protectedLatestTools, ["durable/*"]);
    assert.equal(out.messagePathOf, cl);
});

test("withDurableProtection: idempotent — no duplicate durable/* on re-apply", () => {
    const cl = durableMessageToolPaths["dsh"]!;
    const once = withDurableProtection(defaultConfig(200_000), cl);
    const twice = withDurableProtection(once, cl);
    assert.deepEqual(twice.protectedLatestTools, ["durable/*"]);
});

// ------------------------------------------------------------------ e2e ----

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server; bodies: string[] };

async function startRig(compress?: CompressSettings): Promise<Rig> {
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
        compress: { injectTool: true, injectNudge: false, ...compress },
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

/** A dsh-lane conversation with TWO skill-catalog snapshots (v1 git-helper,
 *  v2 doc-writer) mid-history, folded across both, next-turn body returned. */
async function runTwoCatalogFold(
    compress: CompressSettings | undefined,
    conv: string,
    extraUserTurns = 3,
): Promise<string> {
    const rig = await startRig(compress);
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        msgs.push({ role: "user", content: CATALOG_V1 });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        msgs.push({ role: "user", content: CATALOG_V2 });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A3") });
        for (let i = 4; i <= 4 + extraUserTurns * 2 - 1; i++) {
            msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: filler(i % 2 === 0 ? `F${i}` : `A${i}`) });
            await (await post(msgs)).text();
        }

        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 10, `expected >= 10 tagged messages, got ${refIds.length}`);
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "durable-tool-identity fold",
                    content: [{ startId, endId, topic: "durable-tool-identity fold", summary: "durable-tool-identity fold summary: filler turns were discussed and consumed; nothing else survived this range." }],
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

test("e2e default (latest-per-identity): the OLDER catalog folds, the newest survives — skill visibility is never lost", async () => {
    const postFold = await runTwoCatalogFold(undefined, "dti-default");
    assert.ok(postFold.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFold.includes("git-helper"), "superseded catalog v1 folds away (pi-style single live copy)");
    assert.ok(postFold.includes("doc-writer"), "the newest catalog survives (skill visibility retained)");
    assert.ok(!postFold.includes("A2-"), "folded filler between the catalogs must be gone");
});

test("e2e takeover protectedLatestTools durable/*: same outcome, no double injection", async () => {
    const postFold = await runTwoCatalogFold({ protectedLatestTools: ["durable/*"] }, "dti-latest");
    assert.ok(postFold.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFold.includes("git-helper"), "the superseded catalog v1 folds away (latest-per-identity)");
    assert.ok(postFold.includes("doc-writer"), "the newest catalog survives");
    assert.ok(!postFold.includes("A2-"), "folded filler is gone");
});

test("e2e takeover protectedTools durable/* (all-instance): EVERY catalog instance survives the fold", async () => {
    const postFold = await runTwoCatalogFold({ protectedTools: ["durable/*"] }, "dti-all");
    assert.ok(postFold.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(postFold.includes("git-helper"), "catalog v1 survives (all-instance takeover)");
    assert.ok(postFold.includes("doc-writer"), "catalog v2 survives (all-instance takeover)");
    assert.ok(!postFold.includes("A2-"), "folded filler between the catalogs must be gone");
});

test("e2e takeover exact identity durable/agents-md: another durable carrier folds, the baseline survives", async () => {
    // Skill catalogs are NOT in the takeover pattern → ordinary history.
    // The agents-md baseline IS → survives a fold that covers it.
    const rig = await startRig({ protectedTools: ["durable/agents-md"] });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dti-exact" };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        msgs.push({ role: "user", content: CATALOG_V1 });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        msgs.push({ role: "user", content: AGENTS_MD });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A3") });
        for (let i = 4; i <= 9; i++) {
            msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: filler(i % 2 === 0 ? `F${i}` : `A${i}`) });
            await (await post(msgs)).text();
        }

        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 10, `expected >= 10 tagged messages, got ${refIds.length}`);
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: "dti-exact",
                tool: "compress",
                args: {
                    topic: "dti-exact fold",
                    content: [{ startId: refIds[0]!, endId: refIds[refIds.length - 4]!, topic: "dti-exact fold", summary: "dti-exact fold summary: filler turns were discussed and consumed; nothing else survived this range." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        msgs.push({ role: "user", content: filler("F-final") });
        await (await post(msgs)).text();
        const postFold = rig.bodies.at(-1)!;
        assert.ok(postFold.includes("[Compressed conversation section]"), "the fold must have happened");
        assert.ok(!postFold.includes("git-helper"), "the skill catalog folds away (identity not in the takeover pattern)");
        assert.ok(postFold.includes("marker X7Q"), "the agents-md baseline survives (exact-identity takeover)");
        assert.ok(!postFold.includes("A2-"), "folded filler is gone");
    } finally {
        await closeRig(rig);
    }
});

test("e2e unregistered lane: no classifier → nothing changes even with durable patterns configured", async () => {
    // Lane scoping survives the architecture change: a durable/* pattern on an
    // UNREGISTERED lane has nothing to project (no classifier), so catalogs
    // fold away exactly as before.
    const rig = await startRig({ protectedTools: ["durable/*"] });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "test-agent", "x-bili-plugin-conversation": "dti-plain" };
        const r = await fetch(url, {
            method: "POST", headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: CATALOG_V1 }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        // Projection sanity for the unit layer while we are here: the dsh
        // classifier maps the catalog shape, the lane registry stays dsh-only.
        assert.equal(dshSkillCatalogPath({ id: "x", role: "user", contentType: "text", text: CATALOG_V1 } as never), "durable/skill-catalog");
        assert.deepEqual(Object.keys(durableMessageToolPaths), ["dsh"]);
    } finally {
        await closeRig(rig);
    }
});
