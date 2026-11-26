// #5403/#5418 unified watermark channel: the ONE client-side state machine
// (src/agent/pf-channel.ts) plus its single chokepoint in native-intercept.ts.
// Module-state isolation: every group uses a unique sid (the channel has no
// reset hook on purpose — mirrors the old per-lane maps).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import * as pfChannel from "../src/agent/pf-channel.ts";
import { laneMsgIdsForOpenAiWire } from "../src/agent/pi-msgids.ts";
import { makeRecordingFetch, type RecordedCall } from "./helpers/hot-replace.ts";

const CONVO = "x-bili-plugin-conversation";

function learn(headersIn: Record<string, string>, seq: string | null | undefined, status = 200, mode?: "incremental" | "full"): void {
    const respHeaders = new Headers();
    if (seq !== null && seq !== undefined) respHeaders.set("x-bili-pf-seq", seq);
    if (mode !== undefined) respHeaders.set("x-bili-msgid-mode", mode);
    pfChannel.pfLearnStamp(headersIn, status, respHeaders);
}

// #6785 review fix tests: n distinct short ids (the steady-state shape)
function gen(n: number, prefix = "m"): string[] {
    return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
}

test("pf-channel: no stamp yet ⇒ no headers", () => {
    assert.deepEqual(pfChannel.pfRequestHeaders({ [CONVO]: "sid-fresh-1" }), {});
    assert.deepEqual(pfChannel.pfRequestHeaders({}), {});
});

test("pf-channel: count mode; tail-ids ride only a validated list; encoding", () => {
    const sid = "sid-count-1";
    const inH = { [CONVO]: sid };
    learn(inH, "2");
    // count-only until ids are captured
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "2" });
    pfChannel.pfCaptureIds(sid, ["a", "b", "c"]);
    // K=2 ⇒ [id(K-1)] + new = ["b","c"]; per-segment encode
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], "b,c");
    // comma inside an id travels %2C; the separator stays literal (K=1 ⇒ whole list sent)
    learn(inH, "1");
    pfChannel.pfCaptureIds(sid, ["pre,v1", "new,id"]);
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], encodeURIComponent("pre,v1") + "," + encodeURIComponent("new,id"));
    // a list shorter than K degrades to count-only (never partial)
    const sidShort = "sid-count-short";
    learn({ [CONVO]: sidShort }, "2");
    pfChannel.pfCaptureIds(sidShort, ["x"]);
    assert.deepEqual(pfChannel.pfRequestHeaders({ [CONVO]: sidShort }), { "x-bili-pf-count": "2" });
});

test("pf-channel: tail-ids full slice when the stamp freezes and under the byte budget (#7367)", () => {
    const sid = "sid-cap-1";
    const inH = { [CONVO]: sid };
    // k2 frozen at 2 (the flag flipped off, so the stamp never advances again)
    learn(inH, "2");
    // a long session: 200 ids captured; the full [K-1..] slice is 199 ids
    pfChannel.pfCaptureIds(sid, Array.from({ length: 200 }, (_, i) => `id${i}`));
    const tail = pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"];
    assert.ok(tail !== undefined, "tail-ids present");
    const segs = tail!.split(",");
    // under the byte budget ⇒ the full slice goes out (no count-cap)
    assert.equal(segs.length, 199, "full slice under the byte budget");
    assert.equal(segs[0], "id1", "full slice starts at the window origin");
    assert.equal(segs[198], "id199", "full slice ends at the newest id");
    // a delta NARROWER than the cap is sent whole (no truncation)
    const sidNarrow = "sid-cap-narrow";
    learn({ [CONVO]: sidNarrow }, "2");
    pfChannel.pfCaptureIds(sidNarrow, Array.from({ length: 10 }, (_, i) => `n${i}`));
    const narrowTail = pfChannel.pfRequestHeaders({ [CONVO]: sidNarrow })["x-bili-pf-tail-ids"];
    assert.equal(narrowTail!.split(",").length, 9, "narrow delta sent whole (ids.slice(k-1))");
});

test("pf-channel: failed whole-resolution CLEARS the stored list (no stale slice)", () => {
    const sid = "sid-clear-1";
    const inH = { [CONVO]: sid };
    learn(inH, "2");
    pfChannel.pfCaptureIds(sid, ["a", "b"]);
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], "b");
    for (const bad of [null, undefined, "not-an-array", [], 42, Array.from({ length: 2049 }, (_, i) => `m${i}`)]) {
        pfChannel.pfCaptureIds(sid, bad);
        assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "2" }, `bad=${String(bad)} must clear`);
    }
});

test("pf-channel: bad SLOTS ride '?' — one id-less element never poisons the list (owner 2026-11-02)", () => {
    const sid = "sid-slots-1";
    const inH = { [CONVO]: sid };
    learn(inH, "2"); // K=2 ⇒ this turn's wire carries slots[1..]
    for (const row of [
        [["ok", 7], "%3F"],
        [["ok", ""], "%3F"],
        [["acp_summary_x", "y"], "y"],
        [["a b", "c"], "c"],
        [["c", "c"], "%3F"], // duplicate real id collapses its repeat to unknown
        [["z".repeat(513), "w"], "w"],
    ] as const) {
        pfChannel.pfCaptureIds(sid, [...row[0]]);
        assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], row[1], `slots=${JSON.stringify(row[0])}`);
    }
    // an ALL-unknown span degrades back to pure count mode (noise beats signal)
    pfChannel.pfCaptureIds(sid, ["", 7]);
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "2" });
});

test("pf-channel: stamp learning screens input", () => {
    const sid = "sid-stamp-1";
    const inH = { [CONVO]: sid };
    learn(inH, "abc");        // non-numeric ignored
    learn(inH, null);          // absent header ignored
    learn({}, "9");            // no conversation id ⇒ nothing learned
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), {});
    learn(inH, "0");           // T=0 is not a usable total (elements ≥1)
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), {});
    learn(inH, "3");
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "3" });
    // non-2xx guard lives at the chokepoint (resp.status check), here: only
    // well-formed numeric stamps mutate state — re-learn overwrites
    learn(inH, "7");
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "7" });
});

async function withPfPatch(
    fn: (fetch: typeof globalThis.fetch, sink: RecordedCall[]) => Promise<unknown>,
    extra?: Partial<NativeInterceptState>,
): Promise<{ sink: RecordedCall[] }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const sink: RecordedCall[] = [];
    globalThis.fetch = makeRecordingFetch(sink);
    try {
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:41001",
            ready: Promise.resolve("http://127.0.0.1:41001"),
            ...extra,
        };
        assert.equal(installNativeFetchIntercept(state), true);
        await fn(globalThis.fetch, sink);
        return { sink };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("chokepoint: routed model request carries count+tail-ids; the response learns back", async () => {
    const sid = "sid-e2e-choke-1";
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        // turn 1: no stamp yet — plain model request (conversation stamped by the lane's headersFor)
        await fetch("http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        // the fake Response carries no pf-seq ⇒ nothing learned; now simulate
        // the proxy answering, then send turn 2 with captured ids.
        pfChannel.pfLearnStamp({ [CONVO]: sid }, 200, new Headers({ "x-bili-pf-seq": "2" }));
        pfChannel.pfCaptureIds(sid, ["m1", "m2", "m3"]);
        await fetch("http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        assert.equal(sinkIn.length, 2);
        assert.equal(sinkIn[0].headers["x-bili-pf-count"], undefined, "turn 1 unseeded");
    });
    assert.equal(sink[1].headers["x-bili-pf-count"], "2");
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], "m2,m3");
    // the chokepoint fabricates no lane identity of its own
    assert.ok(!("x-bili-plugin" in sink[1].headers), "chokepoint must not add a lane plugin header");
});

test("chokepoint: direct-to-proxy self-branch emits and learns (dsh profile shape, #5418)", async () => {
    const sid = "sid-e2e-self-1";
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        // dsh profile bundles point the provider straight at the proxy root
        // (default origin of withPfPatch); turn 1 unseeded
        await fetch("http://127.0.0.1:41001/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        pfChannel.pfLearnStamp({ [CONVO]: sid }, 200, new Headers({ "x-bili-pf-seq": "4" }));
        pfChannel.pfCaptureIds(sid, ["n1", "n2", "n3", "n4", "n5"]);
        await fetch("http://127.0.0.1:41001/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        assert.equal(sinkIn[0].headers["x-bili-pf-count"], undefined, "turn 1 unseeded on the self branch too");
    });
    assert.equal(sink[1].headers["x-bili-pf-count"], "4");
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], "n4,n5");
});

test("chokepoint: already-routed /bili/ MODEL url is stamped; __bili/ control-plane never is", async () => {
    const sid = "sid-e2e-control-1";
    learn({ [CONVO]: sid }, "4");
    pfChannel.pfCaptureIds(sid, ["a", "b", "c", "d", "e"]);
    const { sink } = await withPfPatch(async (fetch) => {
        // an already-routed /bili/ MODEL url: stamped branch
        await fetch("http://127.0.0.1:41001/bili/http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        // control-plane (incremental envelope endpoint): passes through, no pf
        await fetch("http://127.0.0.1:41001/__bili/plugin/turn", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
    }, { headersFor: () => ({ "x-bili-plugin": "dsh" }) });
    assert.equal(sink.length, 2);
    assert.equal(sink[0].headers["x-bili-pf-count"], "4");
    assert.equal(sink[0].headers["x-bili-pf-tail-ids"], "d,e");
    assert.equal(sink[1].headers["x-bili-pf-count"], undefined);
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], undefined);
    assert.ok(!sink[1].url.includes("/bili/"), "control plane must not be re-routed");
});

test("chokepoint: no conversation header ⇒ nothing pf at all", async () => {
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });
        assert.equal(sinkIn.length, 1);
    });
    assert.equal(sink.length, 1);
    assert.equal(sink[0].headers["x-bili-pf-count"], undefined);
    assert.equal(sink[0].headers["x-bili-pf-tail-ids"], undefined);
});

// #5813 regression: the dsh lane stamps x-bili-plugin-conversation via
// headersFor, NOT in the client's own request. pfRequestHeaders must see the
// merged view or it can never find the sid and the count header is silently
// dropped every turn (the original bug: 3795 evaluations, 0 hits).
test("chokepoint: conversation header from headersFor (not client) still emits count (#5813)", async () => {
    const sid = "sid-headersfor-1";
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        // turn 1: client sends NO conversation header; headersFor provides it
        await fetch("http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            body: "{}",
        });
        // simulate the proxy stamping the response
        pfChannel.pfLearnStamp({ [CONVO]: sid }, 200, new Headers({ "x-bili-pf-seq": "5" }));
        pfChannel.pfCaptureIds(sid, ["a", "b", "c", "d", "e", "f"]);
        // turn 2: same shape — client still has no convo header
        await fetch("http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            body: "{}",
        });
        assert.equal(sinkIn.length, 2);
        assert.equal(sinkIn[0].headers["x-bili-pf-count"], undefined, "turn 1 unseeded");
    }, {
        headersFor: () => ({ [CONVO]: sid, "x-bili-plugin": "dsh" }),
    });
    assert.equal(sink[0].headers[CONVO], sid, "headersFor convo header lands on the wire");
    assert.equal(sink[1].headers["x-bili-pf-count"], "5", "count emitted from headersFor-provided sid");
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], "e,f", "tail-ids ride alongside");
});

test("chokepoint self-branch: conversation header from headersFor still emits count (#5813)", async () => {
    const sid = "sid-self-headersfor-1";
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        await fetch("http://127.0.0.1:41001/v1/chat/completions", {
            method: "POST",
            body: "{}",
        });
        pfChannel.pfLearnStamp({ [CONVO]: sid }, 200, new Headers({ "x-bili-pf-seq": "3" }));
        pfChannel.pfCaptureIds(sid, ["x1", "x2", "x3", "x4"]);
        await fetch("http://127.0.0.1:41001/v1/chat/completions", {
            method: "POST",
            body: "{}",
        });
        assert.equal(sinkIn[0].headers["x-bili-pf-count"], undefined, "self branch turn 1 unseeded");
    }, {
        headersFor: () => ({ [CONVO]: sid, "x-bili-plugin": "dsh" }),
    });
    assert.equal(sink[1].headers["x-bili-pf-count"], "3", "self branch emits count from headersFor sid");
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], "x3,x4");
});

test("chokepoint routed branch: conversation header from headersFor still emits count (#5813)", async () => {
    const sid = "sid-routed-headersfor-1";
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        // already-routed /bili/ model URL (launcher settings-overlay shape);
        // the client carries NO conversation header — headersFor is its sole
        // source, exactly like the rewrite/self shapes above
        const url = "http://127.0.0.1:41001/bili/http://127.0.0.1:8199/v1/chat/completions";
        await fetch(url, { method: "POST", body: "{}" });
        pfChannel.pfLearnStamp({ [CONVO]: sid }, 200, new Headers({ "x-bili-pf-seq": "5" }));
        pfChannel.pfCaptureIds(sid, ["r1", "r2", "r3", "r4", "r5", "r6"]);
        await fetch(url, { method: "POST", body: "{}" });
        assert.equal(sinkIn[0].headers["x-bili-pf-count"], undefined, "routed branch turn 1 unseeded");
    }, {
        headersFor: () => ({ [CONVO]: sid, "x-bili-plugin": "dsh" }),
    });
    assert.equal(sink[0].headers[CONVO], sid, "headersFor convo header lands on the wire");
    assert.equal(sink[1].headers["x-bili-pf-count"], "5", "routed branch emits count from headersFor sid");
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], "r5,r6");
});

// --- openai-chat family resolver (#5403/#5418 protocol-unified capture) ---

test("laneMsgIdsForOpenAiWire: leading system slot gets a position token, rest align to branch", () => {
    const branch = [
        { type: "message", id: "aaaa1111", message: { role: "user", content: "a" } },
        { type: "message", id: "bbbb2222", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    ];
    assert.deepEqual(
        laneMsgIdsForOpenAiWire(
            [
                { role: "system", content: "You are T." },
                { role: "user", content: "a" },
                { role: "assistant", content: "b" },
            ],
            branch,
        ),
        ["bili-ps-0", "aaaa1111", "bbbb2222"],
    );
});

test("laneMsgIdsForOpenAiWire: tool calls/results align through the shared entry walk", () => {
    const branch = [
        { type: "message", id: "cccc3333", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1" }] } },
        { type: "message", id: "dddd4444", message: { role: "toolResult", toolCallId: "tc1" } },
    ];
    assert.deepEqual(
        laneMsgIdsForOpenAiWire(
            [
                { role: "assistant", content: null, tool_calls: [{ id: "tc1" }] },
                { role: "tool", tool_call_id: "tc1", content: "ok" },
            ],
            branch,
        ),
        ["cccc3333", "dddd4444"],
    );
});

test("laneMsgIdsForOpenAiWire: bails honestly on anything unprovable", () => {
    const branch = [
        { type: "message", id: "eeee5555", message: { role: "user", content: "x" } },
    ];
    // non-leading system element
    assert.equal(
        laneMsgIdsForOpenAiWire([{ role: "user", content: "x" }, { role: "system", content: "s" }], [...branch]),
        undefined,
    );
    // reasoning-family field anywhere
    assert.equal(
        laneMsgIdsForOpenAiWire([{ role: "user", content: "x" }, { role: "assistant", content: "y", reasoning_content: "r" }], branch),
        undefined,
    );
    // leftover branch entry the wire cannot explain
    assert.equal(
        laneMsgIdsForOpenAiWire([{ role: "user", content: "x" }], [
            branch[0],
            { type: "message", id: "ffff6666", message: { role: "user", content: "ghost" } },
        ]),
        undefined,
    );
});

// ---------------------------------------------------------------------------
// #7064 §8: the pin-mode signal (x-bili-msgid-mode) — the client sends the
// FULL msgid list only until the server proves steady-state incremental pins
// work for this conversation; a 'full' signal / 4xx / shrink re-converges.
// ---------------------------------------------------------------------------

test("pf-channel: 'incremental' signal ⇒ the full msgid list stops riding the wire", () => {
    const sid = "sid-mode-inc-1";
    const inH = { [CONVO]: sid };
    // not learned yet ⇒ never suppress
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), false);
    // the signal rides WITH the seq stamp (the server stamps both)
    learn(inH, "10", 200, "incremental");
    // #6785 review fix: suppression requires the CARRIER to be capturable —
    // production always captures this turn's ids before the stamp decision
    pfChannel.pfCaptureIds(sid, gen(10));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), true, "wireCount == learned total ⇒ steady state");
    pfChannel.pfCaptureIds(sid, gen(12));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 12), true, "growing wire ⇒ still steady state");
    // a mode without a usable seq total is inert (structural coupling to the
    // watermark cohort — the server only stamps the signal there)
    const sidNoSeq = "sid-mode-inc-noseq";
    learn({ [CONVO]: sidNoSeq }, null, 200, "incremental");
    assert.equal(pfChannel.pfSuppressFullMsgIds(sidNoSeq, 10), false, "no seq total ⇒ nothing to anchor a count against");
});

test("pf-channel: 'full' signal ⇒ the full list keeps riding (no suppression)", () => {
    const sid = "sid-mode-full-1";
    const inH = { [CONVO]: sid };
    learn(inH, "10", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(10));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), true);
    // a degraded turn tells the client to go full again
    learn(inH, "10", 200, "full");
    pfChannel.pfCaptureIds(sid, gen(10));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), false, "'full' overwrites 'incremental'");
    // the client can grow back into steady state once pins succeed again
    learn(inH, "11", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(11));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 11), true);
});

test("pf-channel: shrink (wire shorter than the learned total) ⇒ clear + send full this turn", () => {
    const sid = "sid-mode-shrink-1";
    const inH = { [CONVO]: sid };
    learn(inH, "10", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(10));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), true);
    // compaction/rewind: the wire shrank — the stale anchor cannot be pinned
    pfChannel.pfCaptureIds(sid, gen(7));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 7), false, "shrinking turn sends the full list");
    pfChannel.pfCaptureIds(sid, gen(10));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), false, "the mode is CLEARED, not just skipped for one turn");
    // a fresh incremental signal re-arms it
    learn(inH, "7", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(7));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 7), true);
});

test("pf-channel: a >=4xx response clears the learned mode immediately", () => {
    const sid = "sid-mode-4xx-1";
    const inH = { [CONVO]: sid };
    learn(inH, "10", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(10));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), true);
    learn(inH, null, 400);
    pfChannel.pfCaptureIds(sid, gen(10));
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 10), false, "4xx ⇒ back to full until a 2xx restamps");
    // 4xx on an unknown sid is a no-op
    learn({ [CONVO]: "sid-mode-4xx-unknown" }, null, 429);
});

// #6785 review fix (2026-11-19, owner): ultra-long sessions still send
// TAIL-ONLY — the capture keeps the last MAX_IDS entries (baseOffset) and
// the steady-state slice (t-1, one core short of the list end) always lands
// in that window. Only a slice reaching BELOW the kept window (a stale
// small stamp after a big growth) or an over-byte-budget tail degrades to
// the full form riding instead — the server then re-proves and restamps.
test("pf-channel: list over the capture ceiling ⇒ tail window kept, tail-only slice goes out, body suppressed", () => {
    const sid = "sid-mode-oversize-1";
    const inH = { [CONVO]: sid };
    // steady state: previous total 2999, this turn adds one core (m3000)
    learn(inH, "2999", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(3000)); // > MAX_IDS ⇒ last 2048 kept, baseOffset 952
    const h = pfChannel.pfRequestHeaders(inH);
    assert.equal(h["x-bili-pf-count"], "2999");
    assert.equal(h["x-bili-pf-tail-ids"], "m2999,m3000", "anchor + new core only — the body's full list stays suppressed");
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 3000), true, "carrier out ⇒ suppression on (no full-body bytes for a 3000-id session)");
});

test("pf-channel: stamp below the kept tail window ⇒ count-only AND full form rides (safe degrade)", () => {
    const sid = "sid-mode-oversize-2";
    const inH = { [CONVO]: sid };
    // stale tiny stamp (e.g. first stamp after the slot was evicted) while
    // the host already holds a 3000-element list: the slice would start at
    // index 99 — below the kept window (baseOffset 952) and would be a
    // 2901-id header — so the carrier stays off and the full form rides
    learn(inH, "100", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(3000));
    const h = pfChannel.pfRequestHeaders(inH);
    assert.equal(h["x-bili-pf-count"], "100");
    assert.equal(h["x-bili-pf-tail-ids"], undefined, "slice reaches below the window ⇒ count-only");
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 3000), false, "no carrier ⇒ the full form rides (pins fine; server restamps next turn)");
    // one 2xx later the stamp tracks the real size and tail-only resumes
    learn(inH, "3000", 200, "incremental");
    pfChannel.pfCaptureIds(sid, gen(3001));
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], "m3000,m3001", "steady state resumes tail-only");
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 3001), true);
});

test("pf-channel: tail payload over the byte budget ⇒ no tail header AND no suppression", () => {
    const sid = "sid-mode-budget-1";
    const inH = { [CONVO]: sid };
    learn(inH, "1", 200, "incremental");
    // one turn adds 500 cores × ~29 chars ⇒ encoded tail ≈ 15 KB > the 8 KB
    // header budget (a 431 would kill the WHOLE model request)
    pfChannel.pfCaptureIds(sid, Array.from({ length: 500 }, (_, i) => `${"a".repeat(28)}${i}`));
    const h = pfChannel.pfRequestHeaders(inH);
    assert.equal(h["x-bili-pf-count"], "1");
    assert.equal(h["x-bili-pf-tail-ids"], undefined, "over budget ⇒ the whole request must not 431");
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 500), false, "no carrier ⇒ full form rides");
    // within budget again ⇒ steady state resumes
    pfChannel.pfCaptureIds(sid, gen(500));
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], gen(500).join(","), "short ids ⇒ the tail goes out");
    assert.equal(pfChannel.pfSuppressFullMsgIds(sid, 500), true);
});

// #7811: the carrier's size and drop reason must be greppable from bili.log —
// the 16 KB header-overflow class is invisible from the proxy side (the
// header dies in the client's socket layer before any request line exists).
test("pf-channel: tail-ids emit and drop land in bili.log with size/reason (#7811)", () => {
    const saved = process.env.XDG_STATE_HOME;
    const root = mkdtempSync(path.join(os.tmpdir(), "pf-channel-log-"));
    process.env.XDG_STATE_HOME = root;
    const logFile = path.join(root, "billion-context", "bili.log");
    const log = (): string => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
    try {
        const sid = "sid-log-1";
        const inH = { [CONVO]: sid };
        learn(inH, "2");
        // count-only pre-capture ⇒ no pf-channel line (no noise)
        pfChannel.pfRequestHeaders(inH);
        assert.equal(log().includes("[pf-channel]"), false, "count-only pre-capture writes nothing");
        // tail emitted ⇒ info line with T, id count, encoded byte count
        pfChannel.pfCaptureIds(sid, ["a", "b", "c"]);
        pfChannel.pfRequestHeaders(inH);
        assert.match(log(), /\[pf-channel\] pf-tail-ids sid=sid-log-1 T=2 ids=2 bytes=3/, "emit line: T + id count + byte count");
        // over the byte budget ⇒ warn line with the drop reason and measured bytes
        const sidBig = "sid-log-big";
        learn({ [CONVO]: sidBig }, "1");
        pfChannel.pfCaptureIds(sidBig, Array.from({ length: 500 }, (_, i) => `${"a".repeat(28)}${i}`));
        pfChannel.pfRequestHeaders({ [CONVO]: sidBig });
        assert.match(log(), /pf-tail-ids dropped sid=sid-log-big T=1 ids=500 base=0 reason=over-byte-budget \d+B>8192B/, "drop line: reason with the measured bytes");
    } finally {
        if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
        rmSync(root, { recursive: true, force: true });
    }
});

// #7064 §8 phase 2: pfIdTailForm — the client-side tail derivation for
// lanes WITHOUT a watermark plane (anthropic / responses egress).
{
    const learnMode = (sid: string, mode: "incremental" | "full"): void =>
        learn({ [CONVO]: sid }, null, 200, mode);
    test("pfIdTailForm: bootstrap stores the baseline and sends full", () => {
        learnMode("tail-a", "incremental");
        assert.equal(pfChannel.pfIdTailForm("tail-a", ["p1", "p2", "p3"]), undefined, "no previous list ⇒ full (bootstrap)");
        assert.deepEqual(pfChannel.pfIdTailForm("tail-a", ["p1", "p2", "p3", "p4"]), ["p3", "p4"], "next turn: anchor + new core");
        assert.deepEqual(pfChannel.pfIdTailForm("tail-a", ["p1", "p2", "p3", "p4", "p5"]), ["p4", "p5"], "rolling forward");
    });
    test("pfIdTailForm: shrink and rewrite both reanchor with the full list", () => {
        learnMode("tail-b", "incremental");
        pfChannel.pfIdTailForm("tail-b", ["q1", "q2", "q3"]);
        assert.equal(pfChannel.pfIdTailForm("tail-b", ["q1"]), undefined, "shrink (host compacted) ⇒ full reanchor");
        assert.deepEqual(pfChannel.pfIdTailForm("tail-b", ["q1", "q9"]), ["q1", "q9"], "…and the shortened list becomes the new baseline");
        pfChannel.pfIdTailForm("tail-b", ["q1", "q9", "q5"]);
        assert.equal(pfChannel.pfIdTailForm("tail-b", ["r1", "q9", "q5"]), undefined, "prefix rewrite ⇒ full reanchor");
    });
    test("pfIdTailForm: mode 'full' or absent ⇒ always full; a 4xx clears the learned state", () => {
        learnMode("tail-c", "full");
        pfChannel.pfIdTailForm("tail-c", ["s1"]);
        assert.equal(pfChannel.pfIdTailForm("tail-c", ["s1", "s2"]), undefined, "mode 'full' ⇒ never tail");
        learnMode("tail-d", "incremental");
        pfChannel.pfIdTailForm("tail-d", ["u1", "u2"]);
        assert.deepEqual(pfChannel.pfIdTailForm("tail-d", ["u1", "u2", "u3"]), ["u2", "u3"]);
        learn({ [CONVO]: "tail-d" }, null, 400);
        pfChannel.pfIdTailForm("tail-d", ["u1", "u2"]);
        assert.equal(pfChannel.pfIdTailForm("tail-d", ["u1", "u2", "u3"]), undefined, "after a 4xx the baseline + mode are cleared ⇒ full again");
    });
}
