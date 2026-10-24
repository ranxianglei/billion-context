import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { listSessions } from "../src/session.ts";
import { forkAdoptionSkippedOf } from "../src/fork-adoption.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/**
 * #629 fork block-adoption end-to-end: an anonymous (prefix-affinity) client
 * grows a conversation, the proxy-mode compress folds a block, then the
 * client FORKS its history (edits the last user message). The fork must
 * resolve to a NEW session that ADOPTS the parent's block (copy-on-fork,
 * seeded refs) instead of restarting at zero — and the parent must stay
 * untouched. With forkAdoption disabled the same fork starts empty.
 */

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

const FILLER = "the quick brown fox jumps over the lazy dog again and again. ";

function userText(run: string, i: number): string {
    return `run ${run} user turn ${i}: ${FILLER.repeat(12)}`;
}

function relayReply(body: string, n: number): string {
    let lastUser = "";
    try {
        const parsed = JSON.parse(body) as { messages?: ChatMsg[] };
        const msgs = parsed.messages ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.role === "user") {
                lastUser = msgs[i]!.content;
                break;
            }
        }
    } catch {
        /* fall through with empty echo */
    }
    return `run reply ${n} to <${lastUser.slice(0, 48)}>: ${FILLER.repeat(10)}`;
}

type RelayState = { upstreamReqs: string[]; compressed: boolean };

function startMockUpstream(state: RelayState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.upstreamReqs.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            if (!state.compressed && refIds.length >= 5) {
                state.compressed = true;
                const from = refIds[1]!;
                const to = refIds[refIds.length - 3]!;
                res.write(
                    sseLine({
                        id: "c1",
                        object: "chat.completion.chunk",
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    role: "assistant",
                                    content: null,
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call_compress_1",
                                            type: "function",
                                            function: {
                                                name: "compress",
                                                arguments: JSON.stringify({
                                                    content: [
                                                        {
                                                            startId: from,
                                                            endId: to,
                                                            topic: "fork adoption fixture",
                                                            summary: `folded early turns of the fork-adoption fixture conversation: the user asked numbered questions, the assistant answered with filler prose, and several exchanges accumulated before the context was folded. No decisions were made; the content is early-session chatter. Range ${from}..${to}.`,
                                                        },
                                                    ],
                                                }),
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                );
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 500, completion_tokens: 2 } }));
            } else {
                const text = relayReply(body, state.upstreamReqs.length);
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 50 } }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type ChatMsg = { role: string; content: string };

async function chat(url: string, messages: ChatMsg[]): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let reply = "";
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
            const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            reply += parsed.choices?.[0]?.delta?.content ?? "";
        } catch {
            /* ignore keepalives */
        }
    }
    return reply;
}

function proxyOpts(relayUrl: string, forkAdoption: boolean): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 400,
            compress: { minCompressRange: 200, minSummaryLength: 20, maxSummaryLength: 5000 },
        }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        forkAdoption,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

async function runForkScenario(forkAdoption: boolean): Promise<{ parentId: string; parentBlocks: number; parentBlockIds: string[]; childBlockIds: string[]; childBlocks: number; childContents: number; lineage: string | undefined; derivedFromSessionId: string | undefined; derivedBlocksAdopted: boolean; forkAdoptionSkipped: ReturnType<typeof forkAdoptionSkippedOf> }> {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const opts = proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`, forkAdoption);
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;

    const history: ChatMsg[] = [];
    const preExisting = new Set(listSessions().map((s) => s.id));
    const newSessions = () => listSessions().filter((s) => !preExisting.has(s.id));
    try {
        // Grow the parent: 8 anonymous turns (full history replayed each time).
        for (let i = 1; i <= 8; i++) {
            history.push({ role: "user", content: userText(run, i) });
            const reply = await chat(url, history);
            assert.ok(reply.length > 0, `turn ${i} must produce a reply`);
            history.push({ role: "assistant", content: reply });
        }

        const sessionsBefore = newSessions();
        assert.equal(sessionsBefore.length, 1, "one anonymous session so far");
        const parent = sessionsBefore[0]!;
        const parentBlocks = parent.state.blocks.filter((b) => b.active).length;
        assert.ok(parentBlocks >= 1, `parent must have a folded block (got ${parentBlocks})`);
        const parentIdCount = parent.state.blocks.length;

        // Fork: same history, a MIDDLE message edited (edit-and-resend /
        // regenerate an earlier turn). Editing only the LAST message would be
        // indistinguishable from a normal next turn (its first 15 items are a
        // full prefix of the stored chain and it reattaches); the divergence
        // must sit inside the replay for prefix-affinity to mint a fork. The
        // edit sits AFTER the compressed block's span (items 1..6), so the
        // block is fully present in the forked request and adoptable.
        const EDIT_AT = 8;
        const forkHistory = history.map((m, i) =>
            i === EDIT_AT ? { role: m.role, content: `${m.content} (edited branch)` } : m,
        );
        const forkReply = await chat(url, forkHistory);
        assert.ok(forkReply.length > 0, "fork turn must produce a reply");

        const after = newSessions();
        assert.equal(after.length, 2, "fork must create a second session");
        const child = after.find((s) => s.id !== parent.id)!;
        // Snapshot metrics BEFORE the follow-up: the live session object's
        // affinity metadata is rewritten by the follow-up request (via
        // "prefix", lineage dropped) and would mask the fork mint.
        const snapshot = {
            parentBlocks,
            parentBlockIds: parent.state.blocks.filter((b) => b.active).map((b) => b.blockId),
            childBlockIds: child.state.blocks.filter((b) => b.active).map((b) => b.blockId),
            childBlocks: child.state.blocks.filter((b) => b.active).length,
            childContents: child.state.blocks.filter((b) => child.blockContents.has(b.blockId)).length,
            lineage: (child.metadata.anonymousPrefixAffinity as { lineage?: { reason?: string } } | undefined)?.lineage?.reason,
            // #3925 → #3011 C9: the persistent lineage link + adoption markers
            // must be on the child regardless of the adoption outcome.
            derivedFromSessionId: typeof child.metadata.derivedFromSessionId === "string" ? child.metadata.derivedFromSessionId : undefined,
            derivedBlocksAdopted: child.metadata.derivedBlocksAdopted === true,
            forkAdoptionSkipped: forkAdoptionSkippedOf(child),
        };
        assert.equal(snapshot.lineage, "forked", "child lineage must record the fork");

        if (forkAdoption) {
            // Seeded refs must preserve the parent's exact raw→ref mapping for
            // every adopted id. Order-based assignment only coincides with it
            // while the edit sits AFTER the folded span — pin the contract.
            for (const b of child.state.blocks.filter((x) => x.active)) {
                for (const raw of b.effectiveMessageIds) {
                    const parentRef = parent.state.messageRefs.byRaw[raw];
                    assert.ok(parentRef, `parent must hold a ref for adopted id (${b.blockId})`);
                    assert.equal(child.state.messageRefs.byRaw[raw], parentRef, `child ref for ${raw} must equal the parent's seeded ref`);
                }
            }
            assert.ok(child.state.nextBlockId >= parent.state.nextBlockId, "child block-id cursor must not fall behind the parent's");
            assert.ok(child.state.nextRunId >= parent.state.nextRunId, "child run-id cursor must not fall behind the parent's");
        }

        // The fork branch keeps talking — the adopted state must reconcile.
        forkHistory.push({ role: "assistant", content: forkReply });
        forkHistory.push({ role: "user", content: userText(run, 9) });
        const followUp = await chat(url, forkHistory);
        assert.ok(followUp.length > 0, "fork follow-up must produce a reply");

        assert.equal(parent.state.blocks.length, parentIdCount, "parent blocks must be untouched (copy-on-fork)");
        return { ...snapshot, parentId: parent.id, parentBlockIds: [...snapshot.parentBlockIds], childBlockIds: [...snapshot.childBlockIds] };
    } finally {
        await close(proxy);
        await close(relay);
    }
}

test("anonymous fork adopts the parent's fully-present compression blocks (#629)", async () => {
    const result = await runForkScenario(true);
    assert.ok(result.childBlocks >= 1, `fork session must adopt the parent block (got ${result.childBlocks})`);
    assert.equal(result.childContents, result.childBlocks, "adopted blocks must carry their summaries");
    const adopted = result.parentBlockIds.filter((id) => result.childBlockIds.includes(id));
    assert.ok(adopted.length >= 1, `child must carry the parent's block id (parent=${JSON.stringify(result.parentBlockIds)} child=${JSON.stringify(result.childBlockIds)})`);
    // #3925 → #3011 C9: the lineage link is recorded and the derived-blocks
    // gate closes on real adoption; nothing is marked skipped.
    assert.equal(result.derivedFromSessionId, result.parentId, "adopting child must link its parent persistently");
    assert.equal(result.derivedBlocksAdopted, true, "derived-blocks gate must close on real block adoption (#3351)");
    assert.equal(result.forkAdoptionSkipped, undefined, "no skipped marker when adoption succeeded");
});

test("forkAdoption disabled leaves the fork at zero compression state", async () => {
    const result = await runForkScenario(false);
    assert.equal(result.lineage, "forked", "fork lineage is still recorded");
    assert.equal(result.childBlocks, 0, "disabled adoption must not seed blocks");
    assert.equal(result.childContents, 0, "disabled adoption must not seed summaries");
    // #3925 → #3011 C9: even when adoption bails, the persistent lineage link
    // must be recorded — without it the startup sweep can never heal the child
    // across a restart and decompress/search_context stay parent-blind for
    // life. The skipped marker carries what was left on the table.
    assert.equal(result.derivedFromSessionId, result.parentId, "bailed fork must still link its parent persistently");
    assert.equal(result.derivedBlocksAdopted, false, "bailed fork must NOT close the derived-blocks gate (boot-sweep door stays open)");
    assert.ok(result.forkAdoptionSkipped, "bailed fork must record the skipped-adoption marker for acp_status");
    assert.equal(result.forkAdoptionSkipped?.parentId, result.parentId, "skipped marker must name the parent");
    assert.ok((result.forkAdoptionSkipped?.blocks ?? 0) >= 1, "skipped marker must count the adoptable blocks that were left behind");
    assert.ok((result.forkAdoptionSkipped?.tokens ?? 0) > 0, "skipped marker must carry the token inventory");
});
