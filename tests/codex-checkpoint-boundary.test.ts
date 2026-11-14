// End-to-end coordination: dsh-codex-subscription stamps the server-side
// compaction checkpoint on the wire, the proxy treats that header as the
// authoritative remote-compaction boundary (no message-text guessing), closes
// the folded history into a read-only generation, and keeps old refs/blocks
// restorable afterwards. Consecutive checkpoints on the same conversation must
// archive a new generation each time and never re-issue ids or refs.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, historyGenerationsOf, REF_FLOOR_RAW_ID, type Session } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { refIndex } from "../src/history-generations.ts";

const MODEL = "gpt-resp";
const WINDOW = 30_000;
const INSTRUCTIONS = "You are the test coding agent.";
const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

type Harness = { url: string; pluginToolUrl: string; bodies: Record<string, unknown>[]; headers: Record<string, string | string[] | undefined>[]; close: () => Promise<void> };

async function startHarness(): Promise<Harness> {
    const bodies: Record<string, unknown>[] = [];
    const headers: Record<string, string | string[] | undefined>[] = [];
    const upstream = http.createServer((req, res) => {
        headers.push(req.headers);
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>); } catch { /* non-JSON probe */ }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(completed(800));
            res.end();
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
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
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`,
        pluginToolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        bodies,
        headers,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function messages(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({ type: "message", role: (from + i) % 2 === 0 ? "user" : "assistant", content: `message ${from + i} ${"x".repeat(4000)}` }));
}

function body(conv: string, input: unknown[]): string {
    return JSON.stringify({
        model: MODEL,
        stream: true,
        session_id: conv,
        instructions: INSTRUCTIONS,
        input,
        tools: [{ type: "function", name: "shell", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    });
}

function checkpointHeaders(conv: string, id: string, seq: number, state: "fresh" | "reuse" = "fresh"): Record<string, string> {
    return {
        "content-type": "application/json",
        "x-bili-plugin": "dsh",
        "x-bili-plugin-conversation": conv,
        "x-bili-codex-checkpoint": id,
        "x-bili-codex-checkpoint-seq": String(seq),
        "x-bili-codex-checkpoint-state": state,
        "x-bili-codex-checkpoint-covered": "7",
        "x-bili-codex-checkpoint-digest": "0123456789abcdef0123456789abcdef",
    };
}

function findSession(conv: string): Session {
    const session = listSessions().find((s) => s.id === conv || s.meta.label === conv);
    assert.ok(session, "session exists");
    return session!;
}

async function foldRefs(h: Harness, conv: string, refs: string[]): Promise<void> {
    const r = await fetch(h.pluginToolUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: refs[0], endId: refs[refs.length - 1], topic: "folded head", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok && !j.result?.includes("[Compression FAILED"), `fold accepted: ${j.result?.slice(0, 200)}`);
}

function restoredText(result: string | undefined): string {
    const at = /written to: (\S+)/.exec(result ?? "");
    return at ? readFileSync(at[1], "utf8") : result ?? "";
}

function mappedRefs(session: Session): string[] {
    return Object.entries(session.state.messageRefs.byRaw)
        .filter(([raw]) => raw !== REF_FLOOR_RAW_ID)
        .map(([, ref]) => ref)
        .sort((a, b) => refIndex(a) - refIndex(b));
}

test("codex checkpoint header rebases once, archives a generation, and old refs stay restorable across consecutive compactions", async () => {
    const h = await startHarness();
    try {
        const conv = "codex-ckpt-conv";
        // Seed a folded session through the plugin tool channel.
        await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv }, body: body(conv, messages(0, 12)) }).then((r) => r.text());
        const seeded = findSession(conv);
        await foldRefs(h, conv, mappedRefs(seeded).slice(0, 7));
        assert.ok(seeded.state.blocks.some((b) => b.active), "a fold block exists before compaction");
        const firstBlock = seeded.state.blocks.find((b) => b.active)!.blockId;
        const firstMaxRef = refIndex(mappedRefs(seeded).at(-1) ?? "m00000");

        // Remote compaction: the client resends only the retained tail plus the header truth.
        const res = await fetch(h.url, { method: "POST", headers: checkpointHeaders(conv, "cp-e2e-1", 1), body: body(conv, messages(7, 5)) });
        assert.equal(res.status, 200);
        await res.text();
        const session = findSession(conv);
        assert.ok(session.metadata.codexCloudCheckpoint, "checkpoint identity is recorded");
        const gens = historyGenerationsOf(session);
        assert.equal(gens.length, 1, "one read-only generation closed by the header");
        assert.equal(gens[0].checkpointId, "cp-e2e-1");
        assert.deepEqual(gens[0].blockIds, [firstBlock]);

        // Context quality: the model never gets the archived history resent; it
        // gets a compact navigation index instead, on the very turn that closed
        // the generation.
        const wire = JSON.stringify(h.bodies.at(-1)?.input ?? []);
        assert.match(wire, /Closed history generations — \d+ generation\(s\) are preserved read-only/, "navigation note reaches the model");
        assert.doesNotMatch(wire, /message 0 /, "archived history is not resent to the model");
        const forwarded = Object.keys(h.headers.at(-1) ?? {});
        assert.ok(forwarded.every((k) => !k.startsWith("x-bili-codex-checkpoint")), `internal checkpoint headers must not reach the upstream: ${forwarded.join(",")}`);

        // Live ids/refs never restart below the archived high-water mark.
        assert.ok(session.state.nextBlockId > Number(firstBlock.slice(1)), "block cursor is pinned above the archived block");
        assert.ok(refIndex(mappedRefs(session).at(-1) ?? "m00000") > firstMaxRef, "refs continue above the pre-compaction floor");

        // The acknowledged boundary never re-fires on a retry of the same identity.
        const retry = await fetch(h.url, { method: "POST", headers: checkpointHeaders(conv, "cp-e2e-1", 1), body: body(conv, messages(7, 5)) });
        await retry.text();
        assert.equal(historyGenerationsOf(findSession(conv)).length, 1, "duplicate checkpoint does not archive twice");

        // Old refs restore from the generation through the real tool endpoint.
        const range = await fetch(h.pluginToolUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "decompress", args: { blockId: firstBlock, startId: "m00001", endId: "m00003" } }),
        }).then((r) => r.json()) as { ok: boolean; result?: string };
        assert.ok(range.ok, "range restore succeeds");
        assert.match(range.result ?? "", /read-only/);
        assert.match(range.result ?? "", /generation 1/);
        const rangeText = restoredText(range.result);
        assert.match(rangeText, /message 0 /);
        assert.match(rangeText, /message 1 /);
        assert.match(rangeText, /message 2 /);
        // The archived block's captured original is still restorable verbatim.
        const whole = await fetch(h.pluginToolUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "decompress", args: { blockId: firstBlock } }),
        }).then((r) => r.json()) as { ok: boolean; result?: string };
        assert.ok(whole.ok, "whole-block restore from the generation succeeds");
        assert.match(whole.result ?? "", /history generation 1/);
        assert.match(restoredText(whole.result), /message 0 /);

        // The model keeps working on the SAME conversation: the retained tail
        // plus eight fresh messages, with the client tool surface intact.
        const continued = messages(7, 13);
        await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv }, body: body(conv, continued) }).then((r) => r.text());
        assert.equal((h.bodies.at(-1)?.tools as unknown[]).length, 1, "client tool surface survives the compaction boundary");
        const grown = findSession(conv);
        // Fold the first five of the eight messages this turn just added (the
        // tail three stay protected), not the resent post-checkpoint tail.
        await foldRefs(h, conv, mappedRefs(grown).slice(-8, -3));
        const secondBlock = grown.state.blocks.find((b) => b.active)!.blockId;
        assert.notEqual(secondBlock, firstBlock);
        await fetch(h.url, { method: "POST", headers: checkpointHeaders(conv, "cp-e2e-2", 2, "reuse"), body: body(conv, continued) }).then((r) => r.text());
        const after = findSession(conv);
        const both = historyGenerationsOf(after);
        assert.deepEqual(both.map((g) => g.checkpointId), ["cp-e2e-1", "cp-e2e-2"]);
        for (const gen of both) {
            const ref = gen.lastRef ?? gen.firstRef ?? "m00001";
            const restored = await fetch(h.pluginToolUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId: conv, tool: "decompress", args: { blockId: gen.blockIds[0], startId: ref, endId: ref } }),
            }).then((r) => r.json()) as { ok: boolean; result?: string };
            assert.ok(restored.ok, `generation ${gen.generation} refs restorable after consecutive compactions`);
            assert.match(restored.result ?? "", new RegExp(`generation ${gen.generation}`));
            assert.match(restoredText(restored.result), /message \d+ /);
        }
    } finally {
        await h.close();
    }
});
