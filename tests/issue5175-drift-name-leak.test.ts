import { test } from "node:test";
import assert from "node:assert/strict";
import {
    composeStreamFilters,
    createBiliArtifactFilter,
    createIdentityStreamFilter,
    createMarkerLineFilter,
    createTagEchoFilter,
    mayStartBiliInternal,
    mayStartDegenerateRenderTag,
    mayStartMarkerLine,
    mayStartRenderTag,
    stripAcpTags,
    stripDriftResidue,
} from "../src/loop/tag-echo-filter.ts";
import { endsWithDraftClose, isDraftDump } from "../src/degenerate-turn.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #5175 defect A: the open-side name enum only ever allowed MID-name mutation
// (`acpi`), never a tail append, so every drifted name (`acpt`/`apct`/`acct`/
// `accent`/`acad`/`actp`/`acme`/`acc`) missed all three streaming gates at once
// and reached the client verbatim — the exact text in the report:
//   acpt> </acpt> <acpt m17138></acpt>  </apct> </apct> ...
const REPORTED =
    "acpt> </acpt> <acpt m17138></acpt>  </apct> </apct>" +
    " <acpt m17140></acpt>  </apct> </apct> <acpt m17142></acpt>  </apct> </apct>";

function streamThrough(chunks: string[]): string {
    const tagFilter = composeStreamFilters(
        composeStreamFilters(createTagEchoFilter(), createMarkerLineFilter()),
        createBiliArtifactFilter(),
    );
    let out = "";
    for (const delta of chunks) {
        if (!mayStartRenderTag(delta) && !mayStartMarkerLine(delta) && !mayStartBiliInternal(delta) && !mayStartDegenerateRenderTag(delta) && !tagFilter.pending()) {
            out += delta;
            continue;
        }
        // #5175: mirror `pushField` exactly — the filter releases, then the
        // release-point adjudication runs `stripDriftResidue`. Testing only the
        // filter hides the gate bug that let the bytes skip both.
        out += stripDriftResidue(tagFilter.push(delta));
    }
    return out + stripDriftResidue(tagFilter.flush());
}

function chunked(s: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
    return chunks;
}

// #5175 defect A, the actual production gap: EVERY probe above is a test of the
// filter, and the filter was never reached. The streaming fast path releases a
// delta verbatim when all four "mayStart…" probes are false, and
// `mayStartDegenerateRenderingTag` only looked for an ambiguous head at the
// chunk's TAIL (`\x3c…$`). The reported paragraph ends with a CLOSED `</apct>`,
// so that probe missed, the bytes rode the fast path, and everything else in
// this file was dead code on the wire. This test drives the REAL fast-path
// decision, so it fails if the gate regresses even while the filter is perfect.
// Drive the REAL openai plugin pipeline and return only the assistant text the
// client received, so the assertion is on what the user actually sees.
async function driveChat(chunks: string[]): Promise<string> {
    const writes: string[] = [];
    const res = makeResLocal(writes);
    const chat = (delta: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    const stop = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
    const events = [chat({ role: "assistant" }), ...chunks.map((c) => chat({ content: c })), stop, "data: [DONE]\n\n"];
    await pipePluginChatWithStrip(streamOfLocal(events), res as unknown as import("node:http").ServerResponse, "openai", makeSessionLocal(), undefined, undefined);
    return [...writes.join("").matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

// #5175 defect A, the ACTUAL production gap — and the reason every other test
// in this file could pass while the user still saw the paragraph verbatim:
//
// The SSE fast path (`processOpenai`/`processResponses`) forwards a delta
// untouched when all four "mayStart…" probes are false. `mayStartDegenerate…`
// only looked for an ambiguous head at the chunk's TAIL (`\x3c…$`). The
// reported paragraph ends with a CLOSED `</acct>`, so that probe missed, the
// bytes rode the fast path, and the filter — plus the release-point
// adjudication behind it — was never called at all.
//
// So this test drives the REAL plugin pipeline end to end, not a hand-rolled
// copy of the condition. A hand-rolled copy can drift from production (this one
// did, and hid the bug); `pipePluginChatWithStrip` cannot.
test("#5175 A: the streaming fast path must not release a drifted unit verbatim", async () => {
    assert.equal(mayStartDegenerateRenderTag(REPORTED), true, "a complete drifted unit anywhere in the delta must engage the state machine, not only a head at its tail");
    const got = await driveChat([REPORTED]);
    // The bar is "no kernel citation reaches the client". The orphan halves
    // (`acpt>`, whose `\x3c` was lost upstream before bili saw it) survive as
    // the pinned KNOWN RESIDUAL below — asserting `got === ""` here would fail
    // for a reason this PR explicitly does not fix.
    assert.equal((got.match(/m\d{4,}/g) ?? []).length, 0, `a kernel ref reached the client: ${JSON.stringify(got)}`);
    assert.ok(!got.includes("<acpt"), `a render-tag open reached the client: ${JSON.stringify(got)}`);
});

test("#5175 A: the reported drift-name paragraph is fully stripped whole-text", () => {
    const out = stripAcpTags(REPORTED);
    assert.ok(!/m\d{4,}/.test(out), `no kernel ref may survive, got ${JSON.stringify(out)}`);
    assert.equal(out, "", "the paragraph is pure residue");
});

test("#5175 A: drift cats — every tail-append name form dies", () => {
    for (const name of ["acpt", "apct", "acct", "accent", "acad", "actp", "acme", "acc", "acptokens"]) {
        const input = `<${name} tokens="18">m10556</${name}>`;
        assert.equal(stripAcpTags(input), "", `<${name}> render echo must be stripped`);
    }
});

test("#5175 A: a drifted pair whose ref sits in the ATTRIBUTE slot dies", () => {
    // Corpus census found this shape only outside the sessions dump (it is the
    // form the report showed), so the rule must key on the payload, not a list.
    assert.equal(stripAcpTags("<acpt m17138></acpt>"), "");
    assert.equal(stripAcpTags("<acpt m17138></acpt><acpt m17140></acpt>"), "");
});

test("#5175 A: genuine HTML sharing a field with an echo survives", () => {
    // The rule keys on a refs-only payload, so markup never joins the race.
    const kept = ['<div class="x">hello world</div>', "<span>text</span>", "<p>the ref is m12345 here</p>"];
    for (const input of kept) {
        assert.equal(stripAcpTags(input), input, `must not touch ${JSON.stringify(input)}`);
    }
    // A prose BODY is released, only the tags go (#2190) — unchanged here.
    assert.equal(stripAcpTags('<acp tokens="2">the ref is m12345</acp>'), "the ref is m12345");
});



test("#5175 A: the signed-thinking channel is never rewritten by the drift rule", () => {
    // #1960 / #2229 unified invariant: `thinking` / `reasoning_content` /
    // `reasoning` ride BYTE-FOR-BYTE — any rewrite desyncs a signature and
    // bricks replay, so `filterFor` hands them an identity filter. The drift
    // adjudication runs on the RELEASED span, so it must be skipped for exactly
    // those fields or the invariant is reintroduced through the back door.
    //
    // Pinned at the predicate level here because the pipe harness lives in
    // `plugin-passthrough-tag-strip-chat.test.ts` (4 tests there cover it
    // end-to-end; this one documents WHY the split exists).
    const echo = '<acpt tokens="18">m10556</acpt>';
    // Visible text channel: adjudicated.
    assert.equal(stripAcpTags(echo), "", "visible text channel is filtered");
    // The verbatim channel rides the PRODUCTION identity filter — the same
    // object `filterFor` hands the signed-thinking fields — so an echo there is
    // expected to survive byte-for-byte: that is the invariant, not a leak.
    // Asserting against `createIdentityStreamFilter()` keeps this a real
    // tripwire: if a verbatim field is ever routed through a stripping filter,
    // this fails instead of documenting a stub.
    const identity = createIdentityStreamFilter();
    assert.equal(identity.push(echo), echo, "the verbatim channel is byte-for-byte identity");
    assert.equal(identity.flush(), "", "the identity filter buffers nothing");
    assert.equal(identity.pending(), false, "the identity filter never holds bytes back");
});

test("#5175 A: the kernel's OWN protocol tags are never read as drift", () => {
    // #1439 regression: `<acp_status></acp_status>` is a READ-ONLY trigger that
    // the non-streaming Responses loop executes. It is also an "unknown" open
    // name with an empty body, i.e. exactly the shape `stripEmptyPairs` drops —
    // so a shape-only rule ate the trigger before the loop could run it. The
    // kernel publishes these four names in a CLOSED set, so enumerating them is
    // legitimate (unlike the model's open drift set) and they must survive.
    const protocol = [
        "<acp_compress>m00001-m00005</acp_compress>",
        "<acp_status></acp_status>",
        "<acp_search>quantum flux</acp_search>",
        "<acp_decompress>b3</acp_decompress>",
    ];
    for (const tag of protocol) {
        assert.equal(stripAcpTags(tag), tag, `kernel protocol tag must survive: ${tag}`);
    }
    // …and in a real sentence, with prose around it.
    const sentence = "status please <acp_status></acp_status>";
    assert.equal(stripAcpTags(sentence), sentence);
    // The streaming lane must not eat it either.
    assert.equal(streamChunked(sentence, 1), sentence);
    assert.equal(streamChunked(sentence, 5), sentence);
});

test("#5175 B: a draft dump is detected when the envelope sits mid-text", () => {
    const midText =
        "Let me chronologically analyze this conversation to produce a comprehensive summary.\n" +
        "... analysis prose ...\n\n" +
        "Now let me write the summary.\n</analysis>\n\n<summary>\n## 1. Primary Request and Intent\n\n" +
        "The user reported a leak, and the analysis continues at length\n" +
        "with the rest of the summary body still being written.";
    assert.equal(endsWithDraftClose(midText), false, "the pre-fix predicate misses it (regression control)");
    assert.equal(isDraftDump(midText), true, "#5175 must catch the envelope form");
});

test("#5175 B: the historical tail form still detects (no regression)", () => {
    const tail = "I will now hand off.\n</analysis>";
    assert.equal(endsWithDraftClose(tail), true);
    assert.equal(isDraftDump(tail), true);
});

test("#5175 B: ordinary prose is never a draft dump", () => {
    for (const s of ["", "The ref is m12345 and here is normal prose.", "I analyzed it. Done."]) {
        assert.equal(isDraftDump(s), false, `false positive on ${JSON.stringify(s)}`);
    }
});

// #5175 end-to-end: the REAL responses-lane pipe, not just the pure filter.
// This is the path the reported turn travelled — a `response.output_text.delta`
// family stream where the model wrote the drifted render tag as prose.
function makeResLocal(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
        writeHead() {},
        setHeader() {},
        getHeader() { return undefined; },
        removeHeader() {},
        headersSent: false,
    };
}

function makeSessionLocal(): Session {
    return {
        id: "testsess5175",
        protocol: "responses",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function sseLocal(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function streamOfLocal(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}


// #5175 defect A, streaming lane: the state machine's matchers are all
// enumeration-scoped (NAME feeds PAIRED/LONE_OPEN/LONE_CLOSE/PARTIAL_TAIL), so
// a drifted name never entered it and its bytes were released one push at a
// time. The whole-text pass only sees the finished text, long after the client
// rendered the frames. These pin the two lanes to the SAME verdict at rest:
// whatever chunking the SSE wire picks, the client must receive what
// stripAcpTags would have produced. (#3198 chunk-split determinism.)
function streamChunked(text: string, size: number): string {
    const f = createTagEchoFilter();
    let out = "";
    for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
    return out + f.flush();
}

const PARITY_SHAPES: Array<[string, string]> = [
    ["reported paragraph", REPORTED],
    ["attribute-slot pair", "<acpt m17138></acpt>"],
    ["two pairs, text between", "<acpt m17138></acpt> between <apct m17140></apct>"],
    ["emitter attribute pair", '<acct tokens="0" text="text">m00257</acct>'],
    ["genuine html", '<div class="x">hello world</div>'],
    ["genuine html with ref", "<account>m00375</account>"],
    ["documented residual", "m01233</kem>"],
    // #5179: an empty SAME-name pair is valid XML and appears in real content
    // (a driver-repository response body, a paper quoting <answer></answer>).
    // It is not emitter evidence, so both lanes must leave it byte-identical.
    ["genuine xml empty pair", "Repository header:\n\x3cfields\x3e\n\t\n\x3c/fields\x3e\n\x3cpage\x3e1\x3c/page\x3e"],
    ["genuine xml answer pair", "Reasoning goes in \x3cthink\x3e\x3c/think\x3e and the answer in \x3canswer\x3e\x3c/answer\x3e tags."],
];

// Two shapes cannot be fixed from the streaming lane and are pinned here as a
// KNOWN RESIDUAL rather than left as a silently-accepted difference:
//
//   1. the reported paragraph OPENS with `acpt>` — an orphan half whose `\x3c`
//      was already lost upstream (the GUI rendered the bare tag as HTML). It
//      cannot start a tag, so no matcher can hold it and those five bytes are
//      on the wire before the pair that would license their removal arrives.
//      This is the same class as #1720's documented `m01233</x>` leftover.
//   2. the orphan closes that trail it are line-adjudicated whole-text (one
//      half licenses stripping its siblings on the same line). The streaming
//      lane has no line state — the state machine's cross-push state is tag
//      STRUCTURE (held/preHeld/swallowed) — and adding it collides with the
//      #2190 balanced-markup contract.
//
// Everything the lane CAN decide is asserted exactly, in the test below.
// The only streaming leftover this lane cannot remove is ORPHAN drift tags
// carrying no ref content: halves whose `\x3c` was lost upstream (`acpt>`, which
// the GUI rendered as bare HTML) and the closing halves that need line state to
// license their removal. They are 100% whitespace-and-fragments, they carry no
// citation, and — crucially — they are byte-identical at every chunk size, so
// chunk-split determinism (#3198) still holds. The assertion below therefore
// pins the INVARIANT rather than a literal: no ref may leak, and removing
// drift-shaped fragments must reproduce the whole-text verdict exactly.
const DRIFT_FRAGMENT =
    /<\/?[A-Za-z][A-Za-z0-9_]{0,31}[^<>]{0,32}>|(?<![\w<>\/])[A-Za-z][A-Za-z0-9_]{0,31}>/g;
function refCount(s: string): number {
    return (s.match(/m\d{4,}/g) ?? []).length;
}




// Shapes that MUST come out byte-identical: genuine markup and prose are never
// touched by either lane, so exactness is the right bar there.
const MUST_PRESERVE = new Set([
    "genuine html",
    "genuine html with ref",
    "documented residual",
    "genuine xml empty pair",
    "genuine xml answer pair",
]);

for (const [name, text] of PARITY_SHAPES) {
    test(`#5175 streaming parity A: ${name} survives every chunking`, () => {
        const truth = stripAcpTags(text);
        const seen: string[] = [];
        for (const size of [1, 2, 3, 5, 7, 11, 13, 64, text.length]) {
            const got = streamChunked(text, size);
            seen.push(got);
            if (MUST_PRESERVE.has(name)) {
                // Genuine content is not merely consistent across lanes: the
                // SOURCE text must survive intact. Comparing got to truth alone
                // is too weak — if both lanes over-strip the same way the test
                // still passes (caught by the #5179 negative control).
                assert.equal(got, text, `chunk size ${size}: genuine content was rewritten: ${JSON.stringify(got)} !== ${JSON.stringify(text)}`);
                assert.equal(truth, text, `whole-text pass rewrote genuine content: ${JSON.stringify(truth)} !== ${JSON.stringify(text)}`);
                continue;
            }
            // Echo shapes: no citation may leak, and removing the drift-shaped
            // leftovers must reproduce the whole-text verdict exactly.
            assert.equal(refCount(got), refCount(truth), `chunk size ${size}: ref count ${refCount(got)} !== ${refCount(truth)} (${JSON.stringify(got)})`);
            assert.equal(got.replace(new RegExp(DRIFT_FRAGMENT.source, "g"), "").trim(), truth.trim(), `chunk size ${size}: ${JSON.stringify(got)} !== ${JSON.stringify(truth)}`);
        }
        // #3198: the verdict must not depend on where the wire cut.
        assert.equal(new Set(seen).size, 1, `chunking changed the output: ${JSON.stringify([...new Set(seen)])}`);
    });
}

// ---------- #4764 follow-up: the retry CANNOT retract what already left ----------

// #4764 and this case are the same residual: the #2303 retry fires at stream
// END, but every delta was already appended to the client's reply as it was
// parsed (`appendReply` at each chunk). `retryEmptyTurn` only does
// `streams.clear(); reader.cancel(); buf = ""` — it abandons the old attempt,
// it cannot un-send bytes. So a draft dump that IS detected still lands in the
// transcript, and the retry merely appends a second (correct) answer after it.
//
// This is pinned as a CHARACTERIZATION test, not an aspiration: it documents
// why "just strip the draft from the stream" is not a one-line fix, and why
// the real fix has to HOLD the draft span before releasing it (#4764).
test("#4764 the #2303 retry documents its own limit: already-streamed draft bytes are not retracted", async () => {
    const { pipePluginChatWithStrip } = await import("../src/plugin.ts");
    const enc = new TextEncoder();
    const chunk = (delta: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    const stop = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
    const DONE = "data: [DONE]\n\n";
    const of = (ev: string[]): ReadableStream<Uint8Array> => {
        let i = 0;
        return new ReadableStream<Uint8Array>({
            pull(c) {
                if (i < ev.length) c.enqueue(enc.encode(ev[i++]));
                else c.close();
            },
        });
    };
    const writes: string[] = [];
    const res = {
        write(b: Buffer | string) {
            writes.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) writes.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
    const session = { id: "s", protocol: "openai", upstreamOrigin: "http://127.0.0.1:9/v1", label: "t", createdAt: 0, lastUsedAt: 0, requests: 0, lastInputTokens: 0, stats: {}, dirty: false } as never;

    const DRAFT = "<analysis>\nThe user asked for X.\n</analysis>\n<summary>\n1. Primary Request: X.\n";
    const firstTurn = [chunk({ role: "assistant" }), chunk({ content: DRAFT }), stop, DONE];
    let calls = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array>> => {
        calls += 1;
        return Promise.resolve(of([chunk({ role: "assistant" }), chunk({ content: "recovered action" }), stop, DONE]));
    };

    await pipePluginChatWithStrip(of(firstTurn), res, "openai", session, undefined, refetch);

    const text = writes.join("");
    assert.equal(calls, 1, "the draft IS detected and retried — the detector works");
    // The measured limit: the draft text is still in what the client received.
    assert.ok(text.includes("Primary Request: X"), "the already-streamed draft CANNOT be retracted (measured, not assumed)");
    assert.ok(text.includes("recovered action"), "the retry appends its answer after it");
});

// ---------- #5175 regressions found while reviewing the fix ----------

// A COMPLETE draft envelope (analysis close → summary open → summary close)
// followed by substantive prose delivered both the draft and an answer: the
// turn converged. The unconditional envelope rule read the spent draft as a
// stalled handoff and re-issued it on the real chat pipe, so the client got its
// answer TWICE plus a "#870 degenerated again" frame. Pristine master answers
// once. The rule now counts only an UNFINISHED envelope — a model that stopped
// inside the summary body (the reported shape) still detects.
test("#5175 B: a COMPLETE draft envelope followed by an answer is not retried", () => {
    const complete =
        "<analysis>\nThe user asked about sharding.\n</analysis>\n\n<summary>\n- notes\n</summary>\n\n" +
        "Here is the real answer: the shard key is user_id.";
    assert.equal(isDraftDump(complete), false, "a finished draft that kept writing is not a stalled handoff");
    // The reported shape: still inside the summary body when the stream ends.
    const open = "<analysis>\n…\n</analysis>\n\n<summary>\n1. Primary Request and Intent\n- sharding\n";
    assert.equal(isDraftDump(open), true, "an UNFINISHED envelope is still a draft dump");
    // And the #2303 tail form is untouched.
    assert.equal(isDraftDump("I will now hand off.\n</analysis>"), true);
});

// The retry's adjudication must not inherit the abandoned attempt's counters:
// the first attempt's prose is already on the wire, so judging the retry against
// it emitted the #870 error for a turn that had answered correctly.
test("#5175 B: a retried turn that answers correctly emits no #870 error", async () => {
    const enc = new TextEncoder();
    const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const DONE = "data: [DONE]\n\n";
    const of = (ev: string[]): ReadableStream<Uint8Array> => {
        let i = 0;
        return new ReadableStream<Uint8Array>({
            pull(c) {
                if (i < ev.length) c.enqueue(enc.encode(ev[i++]));
                else c.close();
            },
        });
    };
    const writes: string[] = [];
    const res = {
        write(b: Buffer | string) {
            writes.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) writes.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
    const session = { id: "s2", protocol: "openai", upstreamOrigin: "http://127.0.0.1:9/v1", label: "t", createdAt: 0, lastUsedAt: 0, requests: 0, lastInputTokens: 0, stats: {}, dirty: false } as never;

    const DRAFT = "<analysis>\n…\n</analysis>\n\n<summary>\n1. Primary Request: X.\n";
    let calls = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array>> => {
        calls += 1;
        return Promise.resolve(of([chunk({ role: "assistant" }), chunk({ content: "the real answer" }), chunk({}, "stop"), DONE]));
    };
    await pipePluginChatWithStrip(of([chunk({ role: "assistant" }), chunk({ content: DRAFT }), chunk({}, "stop"), DONE]), res, "openai", session, undefined, refetch);

    const text = writes.join("");
    assert.equal(calls, 1, "the unfinished draft IS retried");
    assert.ok(text.includes("the real answer"), "the retry's answer reaches the client");
    assert.equal(text.includes("degenerated again"), false, "the retry answered, so no #870 error may be emitted");
});

// #5175 defect A, second lane: the chat wire adjudicates a released delta at the
// release point (`pushField` → `stripDriftResidue`); the responses wire had NO
// such call, so the reported paragraph rode `response.output_text.delta`
// straight to the client. The original proof for A drove the chat pipe only, so
// the suite stayed green while the responses lane kept leaking. Two wires, one
// gateway: the same model output must reach the client as the same text.
const DRIFTED =
    "acpt> </apct> <acpt m17138></epct>  </apct> </apct>";

function driveResponsesOnce(payload: string): Promise<{ text: string; calls: number }> {
    const enc = new TextEncoder();
    const sse = (type: string, extra: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
    const of = (ev: string[]): ReadableStream<Uint8Array> => {
        let i = 0;
        return new ReadableStream<Uint8Array>({ pull(c) { if (i < ev.length) c.enqueue(enc.encode(ev[i++])); else c.close(); } });
    };
    const writes: string[] = [];
    const res = makeResLocal(writes);
    const session = { ...makeSessionLocal(), id: "testsess5175_resp_" + Math.random().toString(36).slice(2), stats: { pendingFoldUsage: false, compressCreditTokens: 0 } } as unknown as Session;
    let calls = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array>> => {
        calls += 1;
        return Promise.resolve(of([sse("response.output_text.delta", { item_id: "oi1", output_index: 0, delta: "the real answer" }), sse("response.completed", { response: { id: "r1", usage: { input_tokens: 1, output_tokens: 1 } } })]));
    };
    const events = [sse("response.output_text.delta", { item_id: "oi1", output_index: 0, delta: payload }), sse("response.completed", { response: { id: "r1", usage: { input_tokens: 1, output_tokens: 1 } } })];
    return pipePluginResponsesWithStrip(streamOfLocal(events), res as unknown as import("node:http").ServerResponse, session, undefined, refetch).then(() => ({
        text: [...writes.join("").matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join(""),
        calls,
    }));
}

test("#5175 A: the responses lane strips the reported unit too, not just the chat pipe", async () => {
    // REPORTED's pairs are all ENUMERATED closes (`</apct>`), so the state
    // machine claims them before any drift rule runs: it exercises the fast-path
    // gate well and the drift adjudication poorly. DRIFTED carries a close that
    // is NOT in the enum — that is what actually reaches the drift rules.
    const { text, calls } = await driveResponsesOnce(DRIFTED);
    assert.equal((text.match(/m\d{4,}/g) ?? []).length, 0, `a kernel ref reached the responses client: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("<acpt"), `a render-tag open reached the responses client: ${JSON.stringify(text)}`);
    assert.equal(calls, 1, "the responses lane must judge the fully stripped turn degenerate and re-issue it");
    assert.ok(text.includes("the real answer"), `the retry's answer must reach the client, got ${JSON.stringify(text)}`);
});

// A drift-stripped delta IS stripped evidence for the #732/#821 empty-turn gate.
// Without recording it the gate judges the turn "bare" and hands the client a
// silently EMPTY assistant message — strictly worse than the verbatim leak it
// replaced, because the host renders nothing and the turn reads as a stall.
test("#5175 A: a drift-stripped turn is retried instead of reaching the client empty", async () => {
    const enc = new TextEncoder();
    const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const DONE = "data: [DONE]\n\n";
    const of = (ev: string[]): ReadableStream<Uint8Array> => {
        let i = 0;
        return new ReadableStream<Uint8Array>({ pull(c) { if (i < ev.length) c.enqueue(enc.encode(ev[i++])); else c.close(); } });
    };
    const writes: string[] = [];
    const res = makeResLocal(writes);
    const session = makeSessionLocal();
    let calls = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array>> => {
        calls += 1;
        return Promise.resolve(of([chunk({ role: "assistant" }), chunk({ content: "the real answer" }), chunk({}, "stop"), DONE]));
    };
    await pipePluginChatWithStrip(of([chunk({ role: "assistant" }), chunk({ content: DRIFTED }), chunk({}, "stop"), DONE]), res as unknown as import("node:http").ServerResponse, "openai", session, undefined, refetch);
    const text = [...writes.join("").matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
    assert.equal(calls, 1, "a fully drift-stripped turn must be retried, not passed through empty");
    assert.ok(text.includes("the real answer"), `the retry's answer must reach the client, got ${JSON.stringify(text)}`);
});

// #5175 defect A, the two shapes that survived the FIRST cut.
//
// Both are a drifted opening half carrying the emitter's `tokens=` attribute
// slot whose CLOSING name disagrees with the opening name:
//   <actp tokens="80">m08844</action>
//   <tool_call tokens="0" type="text">m10234</acctokens>
// `DRIFT_PAIR` and `DRIFT_ATTR` both carry a `\1` backreference, so they require
// the halves to agree; `DRIFT_EMPTY_MISMATCH` only covers an EMPTY body. The
// compound shape therefore had no owner and rode the fast path verbatim — found
// by replaying the shipped corpus (57 units across 6 fields, all safe: neither
// name is HTML or a kernel protocol tag) and then confirmed on the real wire.
const ATTR_MISMATCH = "Here is the status report.\n\n<actp tokens=\"80\">m08844</action>\n\nThat is all.";
const TOOLCALL_MISMATCH = "x\n\n<tool_call tokens=\"0\" type=\"text\">m10234</acctokens>\n\ny";

test("#5175 A: an attr+mismatch unit is stripped whole-text", () => {
    const got = stripAcpTags(ATTR_MISMATCH);
    assert.equal(got, "Here is the status report.\n\n\n\nThat is all.",
        `the attr+mismatch unit must not survive, got ${JSON.stringify(got)}`);
    const pure = stripDriftResidue(TOOLCALL_MISMATCH);
    assert.equal(pure, "x\n\n\n\ny",
        `the underscored drifted unit survived whole-text, got ${JSON.stringify(pure)}`);
});

test("#5175 A: an attr+mismatch unit never survives any chunking on the chat wire", async () => {
    for (const size of [0, 40, 13, 7, 1]) {
        const chunks = size === 0 ? [ATTR_MISMATCH] : chunked(ATTR_MISMATCH, size);
        const text = await driveChat(chunks);
        assert.equal((text.match(/m\d{4,}/g) ?? []).length, 0,
            `a kernel ref reached the client at size=${size}: ${JSON.stringify(text)}`);
        assert.ok(!/<actp/.test(text), `render-tag markup reached the client at size=${size}: ${JSON.stringify(text)}`);
        assert.ok(text.includes("That is all."), `prose was lost at size=${size}: ${JSON.stringify(text)}`);
    }
});

test("#5175 A: a drifted open name containing '_' engages the gate and dies", async () => {
    for (const size of [0, 40, 13, 7, 1]) {
        const chunks = size === 0 ? [TOOLCALL_MISMATCH] : chunked(TOOLCALL_MISMATCH, size);
        const text = await driveChat(chunks);
        assert.equal((text.match(/m\d{4,}/g) ?? []).length, 0,
            `a kernel ref reached the client at size=${size}: ${JSON.stringify(text)}`);
        assert.ok(!/<tool_call/.test(text), `drifted marker reached the client at size=${size}: ${JSON.stringify(text)}`);
    }
});

test("#5178 negative: a genuine html opening tag stays prose and is never stripped", () => {
    const genuine = '<div tokens="3">m00257</span>';
    assert.equal(stripDriftResidue(genuine), genuine, "a genuine html name must never be read as a drifted render name");
    assert.equal(mayStartDegenerateRenderTag('<div class="x"'), false,
        "a genuine opening tag at the tail must stay prose to the accounting pass (#1760)");
});

// #5175 third shape: the emitter put the REF where a render tag keeps its
// ATTRIBUTES, and closed under a different guessed name — `<acpt m17138></apct>`.
// The reported paragraph is made of exactly this unit. Every earlier drift rule
// missed it: DRIFT_PAIR/DRIFT_ATTR carry a `\1` backreference (halves must
// agree), DRIFT_EMPTY_MISMATCH allows disagreement but only for an EMPTY
// attribute slot, and DRIFT_ATTR_MISMATCH allows disagreement plus a ref body
// but demands `tokens=`. So "bare-ref attribute + disagreeing close" had no
// owner and reached the client verbatim.
const BARE_MISMATCH = "Here is the status report.\n\n<acpt m17138></apct>\n\nThat is all.";

test("#5175 A: a bare-ref attribute with a disagreeing close is stripped whole-text", () => {
    const got = stripAcpTags(BARE_MISMATCH);
    assert.equal(got, "Here is the status report.\n\n\n\nThat is all.",
        `the bare-ref+mismatch unit must not survive, got ${JSON.stringify(got)}`);
    // The same unit reached through the other entry point (responses wire retry).
    assert.equal(stripDriftResidue(BARE_MISMATCH), "Here is the status report.\n\n\n\nThat is all.",
        "stripDriftResidue must own the bare-ref+mismatch unit too");
});

test("#5175 A: a bare-ref attribute with a disagreeing close never survives any chunking", async () => {
    for (const size of [0, 40, 13, 7, 1]) {
        const chunks = size === 0 ? [BARE_MISMATCH] : chunked(BARE_MISMATCH, size);
        const text = await driveChat(chunks);
        assert.equal((text.match(/m\d{4,}/g) ?? []).length, 0,
            `a kernel ref reached the client at size=${size}: ${JSON.stringify(text)}`);
        assert.ok(!/<acpt/.test(text), `render-tag markup reached the client at size=${size}: ${JSON.stringify(text)}`);
        assert.ok(text.includes("That is all."), `prose was lost at size=${size}: ${JSON.stringify(text)}`);
    }
});

test("#5178 negative: a genuine mismatched html pair stays prose", () => {
    // Both names are canonical HTML, so this is malformed author markup, not an
    // emitter guessing its own name — it must survive untouched.
    const genuine = '<div class="x">m00257</span>';
    assert.equal(stripDriftResidue(genuine), genuine,
        "a canonical-html mismatched pair must never be read as a drifted render unit");
    // And a real attribute slot (name=value) is NOT a bare ref: same restraint.
    const attrs = '<acpt class="x">m00257</apct>';
    assert.equal(stripDriftResidue(attrs), attrs,
        "a real name=value attribute slot must not license the bare-ref rule");
});

// ---------- #5175 last mile: the invariant that survives the residual ----------

// Measured on the REAL plugin lane (`pipePluginChatWithBuf`), across 16 chunk
// sizes from 1 to 200 bytes:
//
//   * no kernel ref and no drifted render-tag opener ever reaches the client —
//     that was the reported harm, and it is gone at every size;
//   * the delivered PROSE is identical at every size;
//   * only which ref-LESS orphan fragments get removed varies with the cut.
//
// That last point is the honest residual: an orphan half whose `\x3c` was lost
// upstream cannot be adjudicated without line state, and line state collides with
// the #2190 balanced-markup contract (see the KNOWN RESIDUAL note above). What
// must never vary is the citation bar and the prose. Pinning THOSE turns this
// test into a tripwire for any future rule that starts eating content — such a
// rule would break the skeleton assertion while every per-shape test still
// passed.
const FRAGMENT =
    /<\/?[A-Za-z][A-Za-z0-9_]{0,40}[^<>]{0,40}>|(?<![\w<>/])[A-Za-z][A-Za-z0-9_]{0,40}>/g;
function proseSkeleton(s: string): string {
    return s.replace(new RegExp(FRAGMENT.source, "g"), "").replace(/\s+/g, " ").trim();
}

const LAST_MILE_CASES: Array<[string, string]> = [
    ["the reported paragraph", REPORTED],
    [
        "an orphan half beside prose",
        "Here is the report.\n\nacpt> </apct> <acpt m17138></acct>  </apct> </apct>\n\nThat is all.",
    ],
    [
        "a drifted unit between two prose blocks",
        'Start.\n\n<acpt tokens="80">m08844</action>\n\nMiddle words here.\n\n<acct tokens="0" text="text">m00257</acct>\n\nEnd.',
    ],
];

const LAST_MILE_SIZES = [1, 2, 3, 5, 7, 11, 13, 17, 23, 31, 40, 50, 64, 90, 127, 200];

for (const [name, text] of LAST_MILE_CASES) {
    test(`#5175 last mile: ${name} varies only in ref-less residue, never in prose`, async () => {
        const skeletons = new Set<string>();
        for (const size of LAST_MILE_SIZES) {
            const got = await driveChat(chunked(text, size));
            assert.equal(
                (got.match(/m\d{4,}/g) ?? []).length,
                0,
                `a kernel ref reached the client at size=${size}: ${JSON.stringify(got)}`,
            );
            assert.ok(
                !/<(?:acpt|apct|acct|acad|acme|accent|actp)\b/i.test(got),
                `a drifted render-tag opener reached the client at size=${size}: ${JSON.stringify(got)}`,
            );
            skeletons.add(proseSkeleton(got));
        }
        assert.equal(
            skeletons.size,
            1,
            `the delivered prose changed with the chunking: ${JSON.stringify([...skeletons])}`,
        );
    });
}
