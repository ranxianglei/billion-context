import { test } from "node:test";
import assert from "node:assert/strict";
import {
    composeStreamFilters,
    containsEchoResidue,
    createBiliArtifactFilter,
    createMarkerLineFilter,
    createTagEchoFilter,
    isOrphanMarkupText,
    mayStartBiliInternal,
    mayStartDegenerateRenderTag,
    mayStartMarkerLine,
    mayStartRenderTag,
    stripAcpTags,
} from "../src/loop/tag-echo-filter.ts";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

const OPEN = "\x3cacp tokens=\"23\" type=\"text\"\x3e";
const REF = "m05712";

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
        out += tagFilter.push(delta);
    }
    return out + tagFilter.flush();
}

test("#2190 streaming: real field chunk sequence with degenerate close strips the residue", () => {
    const chunks = ["\x3c", "ac", "p", " tokens", "=\u0022", "173", "\u0022", " type", "=\u0022", "text", "\u0022", "\u003e", "m", "057", "12", "\u003c/", "ap", "\u003e\n", "Let me first survey the workspace."];
    const out = streamThrough(chunks);
    assert.ok(!out.includes(REF), "ref must not leak");
    assert.ok(!out.includes("\u003c/ap\u003e"), "degenerate close must not leak");
    assert.ok(!out.includes("\u003cacp"), "open tag must not leak");
    assert.equal(out, "\nLet me first survey the workspace.", "surrounding prose survives verbatim");
});

test("#2190 streaming: every attested degenerate close name is stripped character-by-character", () => {
    for (const name of ["ap", "p", "a", "apc", "cap", "ck", "div", "warn", "aph", "ambient", "apm"]) {
        const whole = `intro ${OPEN}${REF}\u003c/${name}\u003e after prose here.`;
        const out = streamThrough([...whole]);
        assert.ok(!out.includes(REF), `${name}: ref leaked`);
        assert.ok(!out.includes(`\u003c/${name}\u003e`), `${name}: close leaked`);
        assert.ok(out.startsWith("intro "), `${name}: leading prose lost`);
        assert.ok(out.endsWith("after prose here."), `${name}: trailing prose lost`);
    }
});

test("#2190 streaming: multi-tag blob with mixed valid and degenerate closes", () => {
    const blob = `\u003cacp tokens="419" type="text"\u003em00501\u003c/acp\u003e \u003cacp tokens="193" type="text"\u003em00503\u003c/acp\u003e \u003cacp tokens="0"\u003em00505\u003c/p\u003e \u003cacp tokens="291"\u003em00502\u003c/p\u003e done.`;
    assert.equal(streamThrough([blob]), "    done.");
});

test("#2190 streaming: degenerate close near stream end no longer eats the following prose", () => {
    const out = streamThrough([`\u003cacp tokens="1" type="text"\u003em00042\u003c/ck\u003e End of message.`]);
    assert.equal(out, " End of message.");
});

test("#2190 streaming: prose body with a valid close keeps the prose (#1720 guard)", () => {
    const out = streamThrough([`\u003cacp tokens="1" type="text"\u003eLet me check the file.\u003c/acp\u003e`]);
    assert.equal(out, "Let me check the file.");
});

test("#2190 fast path: prose with stray HTML closes or comparison tails passes byte-identical", () => {
    const prose = "The model wrote \u003c/p\u003e and \u003c/a\u003e in its reply.";
    assert.equal(streamThrough([prose]), prose);
    assert.equal(streamThrough(["if a\u003cb"]), "if a\u003cb");
    assert.equal(streamThrough([" and c\u003ed then ok"]), " and c\u003ed then ok");
});

test("#2190 gate predicates: broad tail engages the machine while orphan-markup accounting stays prose", () => {
    assert.equal(mayStartDegenerateRenderTag("\u003c"), true);
    assert.equal(mayStartDegenerateRenderTag("\u003c/"), true);
    assert.equal(mayStartDegenerateRenderTag("a\u003cb"), true);
    assert.equal(mayStartDegenerateRenderTag("\u003cabcdefghijklmnopq"), false);
    assert.equal(mayStartDegenerateRenderTag("\u003cdiv class="), false);
    assert.equal(mayStartDegenerateRenderTag("OK"), false);
    assert.equal(isOrphanMarkupText("\u003c/p\u003e"), false);
    assert.equal(mayStartRenderTag("a\u003cb"), false);
    assert.equal(containsEchoResidue("m05712\u003c/ap\u003e"), true);
    assert.equal(containsEchoResidue("m05712 \u003c/ap\u003e"), true);
    assert.equal(containsEchoResidue("see m1234"), false);
    assert.equal(containsEchoResidue("m12345\u003cp\u003e"), false);
});

test("#2190 wrapped imitation: payload with ref-shaped content is still swallowed whole", () => {
    const f = createTagEchoFilter();
    let out = f.push(`\u003cacp tokens="1" type="text \u003cfoo\u003e${REF}\u003c/p\u003e more payload`);
    out += f.flush();
    assert.equal(out, "");
});

test("#2190 stripAcpTags: degenerate pairs die atomically, genuine HTML untouched", () => {
    assert.equal(stripAcpTags(`\u003cacp tokens="1" type="text"\u003em05712\u003c/ck\u003e`), "");
    assert.equal(stripAcpTags(`before \u003cacp\u003em00042\u003c/p\u003e after`), "before  after");
    assert.equal(stripAcpTags(`\u003cacp tokens="419" type="text"\u003em00501\u003c/acp\u003e \u003cacp tokens="0"\u003em00505\u003c/p\u003e`), " ");
    assert.equal(stripAcpTags(`\u003cdiv class="x"\u003ehello\u003c/div\u003e`), `\u003cdiv class="x"\u003ehello\u003c/div\u003e`);
    assert.equal(stripAcpTags(`see \u003c/p\u003e and \u003ca\u003em1234 text\u003c/a\u003e`), `see \u003c/p\u003e and \u003ca\u003em1234 text\u003c/a\u003e`);
    assert.equal(stripAcpTags(`\u003cacp tokens="5" type="text"\u003em00001\u003c/acp\u003e`), "");
});

function makeSession(): Session {
    return {
        id: "testsess",
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

function makeRes(chunks: string[]) {
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
    } as unknown as import("node:http").ServerResponse;
}

function sse(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
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

test("#2190 responses pipe: micro-fragmented degenerate tag never reaches the client", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const whole = `ok \u003cacp tokens="23" type="text"\u003em05712\u003c/ck\u003e tail`;
    const micro = whole.match(/.{1,4}/gs) ?? [];
    const events = [
        ...micro.map((piece) => sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: piece })),
        sse({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m05712"), "ref never reaches the client");
    const joined = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()) as { type?: string; delta?: string })
        .filter((ev) => ev.type === "response.output_text.delta" && typeof ev.delta === "string")
        .map((ev) => ev.delta as string)
        .join("");
    assert.equal(joined, "ok  tail", "surrounding prose reassembles to the tag-free text");
});

test("#2190 responses pipe: done-family full-text payload with degenerate pair is cleaned", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "clean" }),
        sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: `clean \u003cacp tokens="1" type="text"\u003em00001\u003c/p\u003e` }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00001"), "done-family payload must be cleaned");
    assert.ok(text.includes("clean "), "prose survives");
});

// #2190 round 2: field-attested drift names outside the core+insertion set.
// Round 3 decontamination (#2190 thread): inclusion requires CLEAN spontaneous
// evidence (block-initial, tokens= attribute, deduped n>=4) because open-side
// grep counts are inflated by models quoting tag names in their own reasoning.
// Qualifying: acacp/accessp/acb. acpx was added in round 2 and REMOVED in
// round 3 (its raw census ~217 proved self-referential/constructed; one
// case-variant sighting only) — excluded forms stay observable via the
// residue audits, so a clean attestation earns re-inclusion later. Every
// name-derived matcher consumes ACP_NAME_ALT: one point covers gate+filter.
const DRIFT_FORMS: Array<[string, string, string]> = [
    ["acacp", "\x3cacacp tokens=\"34\" type=\"text\"\x3em00375\x3c/acacp\x3e", "m00375"],
    ["accessp", "\x3caccessp tokens=\"37\" type=\"text\"\x3em07960\x3c/accessp\x3e", "m07960"],
    ["acb", "\x3c" + "acb" + "\x3e" + "m00123" + "\x3c/" + "acb" + "\x3e", "m00123"],
];

test("#2190 round 2 streaming: attested drift-name forms are stripped character-by-character", () => {
    for (const [name, whole, ref] of DRIFT_FORMS) {
        const out = streamThrough([...whole]);
        assert.ok(!out.includes(ref), `${name}: ref leaked`);
        assert.ok(!out.toLowerCase().includes(`\x3c${name}`), `${name}: open leaked`);
        assert.equal(out, "", `${name}: whole span must die, got ${JSON.stringify(out)}`);
        const withProse = [`before ${whole} after`];
        const out2 = streamThrough(withProse[0].split(""));
        assert.equal(out2, "before  after", `${name}: surrounding prose must survive verbatim`);
    }
});

test("#2190 round 2 streaming: case-folded drift names strip; cross-name pairing strips", () => {
    const cases = [
        "\x3cACACP tokens=\"34\"\x3em00375\x3c/aCaCp\x3e",
        "\x3cacP tokens=\"1\" type=\"text\"\x3em00001\x3c/acacp\x3e",
        "\x3cAcAcP tokens=\"2\"\x3em00002\x3c/ACCESSP\x3e",
    ];
    for (const c of cases) {
        const out = streamThrough([...c]);
        assert.equal(out, "", `case/cross form must die, got ${JSON.stringify(out)}`);
    }
});

test("#2190 round 2 stripAcpTags: drift forms die whole-text, genuine words survive byte-identical", () => {
    const leaky = DRIFT_FORMS.map(([, w]) => w).join(" ");
    assert.equal(stripAcpTags(leaky), "  ", "all three drift spans strip atomically");
    const legit = [
        "\x3caccount\x3em00375\x3c/account\x3e",
        "\x3caction\x3em00375\x3c/action\x3e",
        "\x3cACTIVE\x3em00375\x3c/active\x3e",
        "\x3cacgroup\x3em00375\x3c/acgroup\x3e",
        "\x3cacmap\x3em00375\x3c/acmap\x3e",
        "\x3cacstep\x3em00375\x3c/acstep\x3e",
        "\x3cacpipe\x3em00375\x3c/acpipe\x3e",
    ];
    for (const l of legit) {
        assert.equal(stripAcpTags(l), l, `legit word must stay verbatim: ${l}`);
        assert.equal(streamThrough([...l]), l, `legit word must stream verbatim: ${l}`);
    }
});

// #2190 round 4: H2-exclusion invariant (#2248 debate). Every state-machine
// path that TOUCHES a well-formed acplike pair must fire at least one onDrop
// (i.e. leave a [tag-echo] log line): swallow-mode entry always follows a
// logged drop (match path / BROKEN_ATTRS), the definite-tail hold budget is
// TAG_OPEN_CAP with DROP-not-release over-cap, and the 80-char release budget
// only exists inside swallow mode. A zero-log stream therefore cannot have
// leaked a complete pair through the filter — the residual question (why the
// bytes never entered) is answered by the exit audits, not by a silent
// internal path. Probed empirically on the v0.1.185-identical filter.
test("#2190 round 4 invariant: touching a well-formed pair always fires >=1 drop callback", () => {
    const LT = String.fromCharCode(0x3c), GT = String.fromCharCode(0x3e);
    const runScenario = (chunks: string[]): { drops: number; out: string } => {
        let drops = 0;
        const f = createTagEchoFilter(() => { drops++; });
        let out = "";
        for (const c of chunks) out += f.push(c);
        out += f.flush();
        return { drops, out };
    };
    const openTrunc = LT + "acp tokens=\"2\"";
    const openFull = openTrunc + GT;
    const close = LT + "/" + "acp" + GT;
    // A: truncated open + short body, stream ends -> EOF rule drops, logged
    let r = runScenario([openTrunc, "x".repeat(90)]);
    assert.equal(r.drops, 1, "A: EOF drop must be logged");
    assert.equal(r.out.includes("m"), false);
    // B: truncated open + body past TAG_OPEN_CAP -> over-cap drop, logged
    r = runScenario([openTrunc, "x".repeat(4200)]);
    assert.equal(r.drops, 1, "B: over-cap definite-tail drop must be logged");
    assert.equal(r.out.length, 0, "B: nothing released");
    // C: complete pair char-by-char -> stripped, logged
    r = runScenario([...(openFull + "m00001" + close)]);
    assert.equal(r.drops, 1, "C: pair strip must be logged");
    assert.equal(r.out, "", "C: pair dies");
    // D: complete open + body past SWALLOW_CAP, no close -> budget RELEASES
    // the prose body, but the open's drop already logged
    r = runScenario([openFull, "y".repeat(90)]);
    assert.ok(r.drops >= 1, "D: swallow entry drop must be logged");
    assert.equal(r.out, "y".repeat(90), "D: body is prose, released verbatim");
    // E: truncated open + long body, close arrives late -> ref leaks as BARE
    // prose (no pair) but drops are logged
    r = runScenario([openTrunc, "z".repeat(4200), GT + "m00001" + close]);
    assert.ok(r.drops >= 1, "E: drops must be logged");
    assert.ok(!r.out.includes(LT), "E: no tag markup survives");
});

// #2190 round 8: field replay — session-1f3d2c0f seq=22409, the exact 71
// tokenizer shards of a turn whose fourth tag closes with the degenerate
// name </ak> (k outside every acplike class). Proves the close side needs NO
// list membership: the ref-anchored open-set rule (degenCloseAfterRef /
// DEGEN_PAIR) strips it because the body is one bare ref. Output must be the
// three inter-tag newlines only.
test("#2190 round 8 field replay: 71 real shards ending in degenerate close strip fully", () => {
    const AK_SHARDS = [
        "<",
        "ac",
        "p",
        " tokens",
        "=\"",
        "299",
        "\"",
        " type",
        "=\"",
        "text",
        "\">",
        "m",
        "122",
        "07",
        "</",
        "ac",
        "p",
        ">\n",
        "<",
        "ac",
        "p",
        " tokens",
        "=\"",
        "473",
        "\"",
        " type",
        "=\"",
        "text",
        "\">",
        "m",
        "122",
        "05",
        "</",
        "ac",
        "p",
        ">\n",
        "<",
        "ac",
        "p",
        " tokens",
        "=\"",
        "221",
        "\"",
        " type",
        "=\"",
        "text",
        "\">",
        "m",
        "122",
        "06",
        "</",
        "ac",
        "p",
        ">\n",
        "<",
        "ac",
        "p",
        " tokens",
        "=\"",
        "120",
        "\"",
        " type",
        "=\"",
        "text",
        "\">",
        "m",
        "122",
        "11",
        "</",
        "ak",
        ">"
    ];
    let drops = 0;
    const tagFilter = composeStreamFilters(
        composeStreamFilters(createTagEchoFilter(() => { drops++; }), createMarkerLineFilter()),
        createBiliArtifactFilter(),
    );
    let out = "";
    for (const delta of AK_SHARDS) {
        if (!mayStartRenderTag(delta) && !mayStartMarkerLine(delta) && !mayStartBiliInternal(delta) && !mayStartDegenerateRenderTag(delta) && !tagFilter.pending()) {
            out += delta;
            continue;
        }
        out += tagFilter.push(delta);
    }
    out += tagFilter.flush();
    assert.equal(out, "\n\n\n", "only the three inter-tag newlines may survive");
    assert.ok(drops >= 1, "drop must be logged");
});

test("#2190 round 2 gate: drift-name heads engage the render-tag predicates once spaced", () => {
    assert.equal(mayStartRenderTag("\x3cacacp "), true);
    assert.equal(mayStartRenderTag("\x3caccessp x"), true);
    assert.equal(mayStartRenderTag("\x3c" + "acb" + " "), true);
    // acpx boundary pin (round 3 exclusion): NOT in the name set anymore —
    // the render-tag predicates must stay false for it, while the BROAD tail
    // keeps engaging the gate so such bytes at least enter the state machine
    // (and the residue audits observe any release).
    assert.equal(mayStartRenderTag("\x3cacpx"), false, "excluded form: render-tag predicate stays false");
    assert.equal(mayStartDegenerateRenderTag("\x3cacpx"), true, "BROAD tail still engages on the bare head");
    assert.equal(mayStartRenderTag("\x3cacpx\x3e"), false, "excluded form: terminated head stays prose");
    assert.equal(mayStartRenderTag("\x3caccount"), false, "genuine word stays prose");
    assert.equal(mayStartRenderTag("\x3cacgroup"), false, "custom tag stays prose");
});

// #2862: the dead ref-close unit — a refs run glued to a close head whose
// terminator (\x3e) never arrives mid-text (all LONE_CLOSE-family matchers
// require it, TRUNC_REF_CLOSE is $-anchored), released as prose with only a
// residue warn. Once an echo is attested in the same response, the unit dies
// whole and the prose after it survives.
const RESIDUE_MID = "done m00491\x3c/acp   **resolved** next.";
const RESIDUE_MID_EXPECT = "done    **resolved** next.";

test("#2862 streaming: attested pair + mid-text dead ref-close strips the unit, keeps prose", () => {
    const whole = `\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e ${RESIDUE_MID}`;
    const out = streamThrough([whole]);
    assert.ok(!out.includes("m00491"), "dead ref must not leak");
    assert.ok(!out.includes("\x3c/acp"), "dead close head must not leak");
    assert.equal(out, ` ${RESIDUE_MID_EXPECT}`, "prose after the unit survives verbatim");
});

test("#2862 streaming: release path (markup after the head) strips the unit mid-stream", () => {
    // The \x3cb\x3e after the head defeats every PARTIAL_TAIL hold, so the
    // span reaches the plain release branch in one frame.
    const whole = `\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e done m00491\x3c/acp see \x3cb\x3e bold`;
    const out = streamThrough([whole]);
    assert.ok(!out.includes("m00491"), "dead ref must not leak");
    assert.ok(!out.includes("\x3c/acp"), "dead close head must not leak");
    assert.equal(out, " done  see \x3cb\x3e bold", "prose and live markup survive");
});

test("#2862 streaming: character-sharded production shape (tokenizer fragments)", () => {
    const whole = `\x3cacp tokens="23" type="text"\x3em05712\x3c/acp\x3e ${RESIDUE_MID}`;
    const out = streamThrough([...whole]);
    assert.equal(out, ` ${RESIDUE_MID_EXPECT}`, "sharded stream reassembles to the cleaned text");
});

test("#2862 streaming: EOF dead unit (TRUNC_CLOSE shadow) dies whole, not as a bare ref", () => {
    const whole = `\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e tail m01233\x3c/acp`;
    const out = streamThrough([whole]);
    assert.ok(!out.includes("m01233"), "ref must not survive as bare prose");
    assert.ok(!out.includes("\x3c/acp"), "close head must not leak");
    assert.equal(out, " tail ", "trailing prose survives");
});

test("#2862 streaming: live orphan close still goes through the close rules, not the dead-unit strip", () => {
    const whole = `\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e ref m01233\x3c/acp x\x3e tail`;
    const out = streamThrough([whole]);
    // Exact equality: a dead-rule misfire on this LIVE close would strip only
    // through the name and leave ` x>` behind — the weak includes/endsWith
    // asserts below would have passed that corruption silently.
    assert.equal(out, " ref  tail", "orphan rule dies the whole unit incl. attrs, prose survives");
});

test("#2862 streaming: no attested echo — close-only shape stays verbatim (#1760 scope)", () => {
    const prose = "see m00491\x3c/acp and \x3ci\x3e it";
    const out = streamThrough([prose]);
    assert.equal(out, prose, "close-only dead shape with no attestation passes byte-identical");
});

test("#2862 streaming: word-adjacent run (xm01233) is not a dead unit", () => {
    const whole = `\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e xm01233\x3c/acp and \x3ci\x3e ok`;
    const out = streamThrough([whole]);
    assert.ok(out.includes("xm01233"), "word-adjacent run survives (lookbehind guard)");
    assert.ok(out.includes("\x3ci\x3e ok"), "prose survives");
});

test("#2862 stripAcpTags: dead units die whole-text, unattested stays verbatim", () => {
    assert.equal(stripAcpTags(`\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e ${RESIDUE_MID}`), ` ${RESIDUE_MID_EXPECT}`, "attested: unit dies, prose survives");
    assert.equal(stripAcpTags(`\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e tail m01233\x3c/acp`), " tail ", "attested EOF: unit dies whole, not as a bare ref");
    const unattested = "see m00491\x3c/acp and \x3ci\x3e it";
    assert.equal(stripAcpTags(unattested), unattested, "close-only shape with no attestation stays byte-identical");
});

test("#2862 responses pipe: residue frame after an attested pair never reaches the client", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e ` }),
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: RESIDUE_MID }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00491"), "dead ref never reaches the client");
    assert.ok(!text.includes("m05712"), "pair ref never reaches the client");
    assert.ok(!JSON.stringify(text).includes("\\u003c/acp"), "close head never reaches the client");
    assert.ok(text.includes("resolved"), "prose survives");
});

// #2862 review round: attestation evidence the first cut missed. An unclosed
// acplike open and a degen pair are removed LATER in the whole-text chain than
// the original gate sat — so their presence had to count as attestation too,
// and stripping the open also un-glues a ref that sat right after its \x3e
// (the [\w>] lookbehind otherwise admits nothing). Streaming release prefixes
// ahead of a just-won echo match had the same hole, plus one lookahead guard
// that no test could break.

test("#2862 r2 whole-text: unclosed-open attestation strips the dead unit", () => {
    const input = `\x3cacp tokens="1" type="text"\x3em00491\x3c/acp   **done** rest.`;
    assert.equal(stripAcpTags(input), `   **done** rest.`, "open is attestation; un-glued ref dies with its close head");
});

test("#2862 r2 whole-text: degen-pair attestation strips a later dead unit", () => {
    const input = `\x3cacp\x3em00491\x3c/err\x3e done m00500\x3c/acp   **z**`;
    assert.equal(stripAcpTags(input), ` done    **z**`, "degen pair is attestation for the later unit");
});

test("#2862 r2 streaming: dead unit before the first echo dies when the echo lands later", () => {
    const out = streamThrough([`m00491\x3c/acp `, `\x3cacp tokens="1"\x3em05712\x3c/acp\x3e rest`]);
    // The dead unit dies whole; its trailing space and the pair's leading
    // space both survive byte-exact.
    assert.equal(out, `  rest`, "prefix released ahead of the attesting pair is cleaned, not raw");
});

test("#2862 r2 streaming: settled dead unit in a hold-prefix releases clean", () => {
    // First frame attests; second frame settles a dead unit mid-buffer while a
    // fresh partial close tail holds — the prefix between them must not leak
    // the settled unit verbatim.
    const out = streamThrough([
        `\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e x`,
        ` m00491\x3c/acp see \x3cb\x3e bold m00500\x3c/ac`,
    ]);
    assert.equal(out, ` x  see \x3cb\x3e bold `, "settled unit dies on prefix release; live markup and prose survive");
});

test("#2862 r2: live NON-acplike close survives the dead-unit rule (liveness lookahead teeth)", () => {
    // Only the dead rule can touch this shape (LONE/ORPHAN need the acplike
    // name class). A correct liveness lookahead sees the \x3e within 32 chars
    // and skips; a broken one would strip through the name and leave ` x>`.
    const tail = `ref m01233\x3c/ap x\x3e tail`;
    assert.equal(
        stripAcpTags(`\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e ${tail}`),
        ` ${tail}`,
        "whole-text: live non-acplike close byte-identical",
    );
    assert.equal(
        streamThrough([`\x3cacp tokens="1" type="text"\x3em05712\x3c/acp\x3e ${tail}`]),
        ` ${tail}`,
        "streaming: live non-acplike close byte-identical",
    );
});

test("#2862 r3 streaming: over-cap definite tail as first event cleans its released prefix", () => {
    // The >TAG_OPEN_CAP unterminated <acp opening is this response's FIRST
    // echo event: its drop is recorded only as the settled prefix is being
    // released, so the prefix must be cleaned with forced attestation —
    // otherwise the dead unit ahead of it leaks verbatim (#2862 shape).
    const out = streamThrough([`m00491\x3c/acp   prose ` + "\x3cacp " + "x".repeat(4200)]);
    assert.equal(out, "   prose ", "settled unit dies with the over-cap tail drop; prose survives byte-exact");
});
