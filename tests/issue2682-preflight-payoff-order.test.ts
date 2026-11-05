/**
 * #2682: preflight fold ordering — two-tier dispatch.
 *
 * Tier 1 (ranges outside the soft-protected recent zone): highest payoff
 * (largest span) first — a summarization call costs the same wall clock
 * whether it folds 6K or 64K tokens (measured 25-44s/call regardless of
 * size), and the head range re-grows after each fold (its block + newer
 * messages form one bigger range again), so oldest-first re-folded an
 * almost-exhausted head every round while the largest ranges never got
 * dispatched within the pass budget (measured: five head re-folds over a
 * 180s pass; two ranges worth 108K tokens never touched).
 *
 * Tier 2 (ranges entering the zone, present only after a #330/#1841 relax):
 * oldest-first within it, never outranking old content — the zone is a
 * preference to spend last, not the biggest available span.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession, type Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetForTest as resetRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "Summary: the range contained only repeated filler data; nothing actionable.";

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
    resetRegistryForTest();
});

function padTo(head: string, totalChars: number): string {
    return head + "x".repeat(Math.max(0, totalChars - head.length));
}

function makeServer(bodies: Record<string, unknown>[]): http.Server {
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = JSON.parse(raw);
            bodies.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY } }] }));
        });
    });
    return server;
}

interface RunOpts {
    preserveRecentMessages?: number;
    preserveRecentTokens?: number;
    setup?: (session: Session) => void;
}

async function runPreflight(window: number, messages: CoreMessage[], bodies: Record<string, unknown>[], opts: RunOpts = {}) {
    const server = makeServer(bodies);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const logs: string[] = [];
    try {
        const session = getSession(`pfo-${randomUUID()}`);
        opts.setup?.(session);
        const config = defaultConfig(window);
        config.preserveRecentMessages = opts.preserveRecentMessages ?? 0;
        config.preserveRecentTokens = opts.preserveRecentTokens ?? 0;
        const deps: PreflightDeps = {
            core: createCore(), session, config,
            prompts: defaultPrompts, protocol: "openai",
            url: `http://127.0.0.1:${port}/v1/messages`,
            headers: {}, model: "test-model",
            log: (_level, message) => logs.push(message),
        };
        const result = await preflightCompress(deps, messages);
        return { session, result, logs };
    } finally {
        server.close();
        await once(server, "close");
    }
}

test("#2682 preflight dispatches the largest range first, not the oldest", async () => {
    const messages: CoreMessage[] = [];
    // Oldest content: twelve small alternating messages (~1K tok each).
    for (let i = 0; i < 12; i++) {
        messages.push({ id: `head${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: padTo(`HEAD_${i}_`, 4000) });
    }
    messages.push({ id: "sep1", role: "user", contentType: "text", text: "Zone A." });
    // Middle: four consecutive assistants, 6K tok each -> one 24K-tok range.
    for (let i = 0; i < 4; i++) {
        messages.push({ id: `mid${i}`, role: "assistant", contentType: "text", text: padTo(`MID_${i}_`, 24_000) });
    }
    messages.push({ id: "sep2", role: "user", contentType: "text", text: "Zone B." });
    // Newest bulk: eight consecutive assistants, 7K tok each -> one 56K-tok range.
    for (let i = 0; i < 8; i++) {
        messages.push({ id: `huge${i}`, role: "assistant", contentType: "text", text: padTo(`HUGE_${i}_`, 28_000) });
    }
    messages.push({ id: "tail", role: "user", contentType: "text", text: "Go." });

    const bodies: Record<string, unknown>[] = [];
    const { session, result } = await runPreflight(60_000, messages, bodies);

    assert.equal(result.compressedRanges, 1, `expected exactly one folded range, failure=${JSON.stringify(result.failure ?? null)}`);
    assert.ok(bodies.length >= 1, "at least one summary call");
    const textOf = (b: Record<string, unknown>) => JSON.stringify(b);
    // THE regression: with oldest-first the first call targets the head
    // (HEAD_* markers); payoff order must target the 56K range instead.
    assert.ok(textOf(bodies[0]).includes("HUGE_"), "first summarization call must target the largest range, not the oldest");
    for (const b of bodies) {
        const t = textOf(b);
        assert.ok(t.includes("HUGE_"), "every call in this pass targets the largest range");
        assert.ok(!t.includes("HEAD_") && !t.includes("MID_"), "smaller ranges stay untouched while the payload converges");
    }
    const block = session.state.blocks.find((b) => b.active && b.effectiveMessageIds.includes("huge0"));
    assert.ok(block, "an active block covers the folded huge range");
});

test("#2682 equal-mass ranges keep the legacy oldest-first tie-break", async () => {
    const messages: CoreMessage[] = [];
    messages.push({ id: "head0", role: "user", contentType: "text", text: padTo("HEAD_0_", 4000) });
    messages.push({ id: "head1", role: "assistant", contentType: "text", text: padTo("HEAD_1_", 4000) });
    messages.push({ id: "sep1", role: "user", contentType: "text", text: "Zone A." });
    for (let i = 0; i < 6; i++) {
        messages.push({ id: `tieA${i}`, role: "assistant", contentType: "text", text: padTo(`TIE_A_${i}_`, 20_000) });
    }
    messages.push({ id: "sep2", role: "user", contentType: "text", text: "Zone B." });
    for (let i = 0; i < 6; i++) {
        messages.push({ id: `tieB${i}`, role: "assistant", contentType: "text", text: padTo(`TIE_B_${i}_`, 20_000) });
    }
    messages.push({ id: "tail", role: "user", contentType: "text", text: "Go." });

    const bodies: Record<string, unknown>[] = [];
    const { session, result } = await runPreflight(40_000, messages, bodies);

    assert.ok(result.compressedRanges >= 1, `expected at least one folded range, failure=${JSON.stringify(result.failure ?? null)}`);
    assert.ok(bodies.length >= 1, "at least one summary call");
    const textOf = (b: Record<string, unknown>) => JSON.stringify(b);
    // Both ~30K zones tie on mass -> the OLDER one goes first (legacy order,
    // pinned so the tie-break cannot silently flip to newest-first). Later
    // folds may legally straddle the boundary once ranges merge, so only the
    // FIRST dispatch is pinned here; convergence is pinned via fitsWindow.
    assert.ok(textOf(bodies[0]).includes("TIE_A_"), "oldest range wins the tie");
    assert.ok(!textOf(bodies[0]).includes("TIE_B_"), "newer tied range is not dispatched first");
    assert.equal(result.fitsWindow, true, "the pass converges within the window");
    const block = session.state.blocks.find((b) => b.active && b.effectiveMessageIds.includes("tieA0"));
    assert.ok(block, "an active block covers the folded older tied range");
});

test("#2682 after a #330/#1841 relax, zone content stays last-resort", async () => {
    // Old unprotected bulk is small; the two newest messages (inside the
    // soft-protected recent zone) are by far the largest spans. The outer
    // mass cannot close the gap, so the pass must relax up front (#1841) —
    // and even then spend the old content before the zone content.
    const messages: CoreMessage[] = [
        { id: "old0", role: "user", contentType: "text", text: "Start." },
        { id: "old1", role: "assistant", contentType: "text", text: padTo("OLD_SMALL_", 30_000) },
        { id: "old2", role: "user", contentType: "text", text: "Check." },
        { id: "tailA", role: "assistant", contentType: "text", text: padTo("TAIL_A_", 200_000) },
        { id: "tailB", role: "assistant", contentType: "text", text: padTo("TAIL_B_", 200_000) },
        { id: "tailU", role: "user", contentType: "text", text: "Go." },
    ];
    const bodies: Record<string, unknown>[] = [];
    const { result, logs } = await runPreflight(60_000, messages, bodies, {
        preserveRecentMessages: 3,
        setup: (session) => { session.stats.lastInputTokens = 108_000; },
    });

    assert.ok(logs.some((l) => l.includes("relaxing soft protection up front")), "outer mass cannot close the gap -> #1841 up-front relax");
    assert.ok(bodies.length >= 1, "at least one summary call");
    const textOf = (b: Record<string, unknown>) => JSON.stringify(b);
    // THE pin: pure mass order would dispatch the ~100K-tok tail range first;
    // the two-tier order spends the older unprotected content before the
    // relaxed zone (and keeps oldest-first inside the zone, #330).
    assert.ok(textOf(bodies[0]).includes("OLD_SMALL_"), "old unprotected content is dispatched before relaxed zone content");
    assert.ok(!textOf(bodies[0]).includes("TAIL_A_") && !textOf(bodies[0]).includes("TAIL_B_"), "zone content never outranks old content");
    assert.ok(result.compressedRanges >= 2, "both the old range and the relaxed zone eventually fold");
    assert.ok(bodies.some((b) => textOf(b).includes("TAIL_A_")), "relaxed zone content is folded once old content is spent");
    assert.equal(result.fitsWindow, true, "the pass converges within the window");
});
