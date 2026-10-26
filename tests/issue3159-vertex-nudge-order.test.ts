import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startFakeUpstream, VALIDATORS } from "./wire-contract-fakes.ts";
import { appendTrailingUserText } from "../src/wire-body.ts";
import { insertCheckpointCarrier } from "../src/chain-checkpoint.ts";

// Regression for #3159: Vertex rejects a request whose user content carries
// plain text AFTER a functionResponse part ("Requests ending with a model
// turn are not supported"). Bili used to produce that shape two ways:
// appendGoogleNudge appended any trailing note/nudge text after the trailing
// functionResponse part, and coreToGoogle's flushUser reassembled user runs
// as [responses..., content...] regardless of the client's own order. Both
// boundaries now stable-partition plain text before non-text parts. The
// validation-parity fake enforces WC-018 on every forwarded body, so a
// regression relays the fake's 400 instead of passing silently.
//
// Triggers are chosen to be deterministic with the shared fake (its
// usageMetadata hardcodes promptTokenCount:10, so kernel-nudge growth arming
// can never fire here); the sysNotes drift below drives the SAME
// appendGoogleNudge call site the nudge uses, so the host boundary is covered
// either way.

interface Harness {
    proxyUrl: string;
    close(): Promise<void>;
}

async function startHarness(fakeUrl: string): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: fakeUrl,
        routes: { [fakeUrl]: { models: { "gemini-test": { context: 1_000_000 } } } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: true },
        // Explicit: ProxyOptions does not inherit the file-config default, and
        // the sysNotes trigger below requires the anchor reconciler to run.
        stableSystemAnchor: true,
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
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    return {
        proxyUrl: `http://127.0.0.1:${port}/bili/${fakeUrl}`,
        close: () => new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve()))),
    };
}

const TURN_1_CONTENTS = [{ role: "user", parts: [{ text: "What is 37 plus 29?" }] }];
// Multi-line heads: a 1→2 line change scores 0.5 on the anchor's shared-line
// ratio (DIFF_MIN_SHARED 0.7) and is treated as structural (no note); 10→11
// lines scores 10/11 and stays a localized edit worth annotating.
const BASE_SYSTEM = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
const MODEL_TURN = { role: "model", parts: [{ functionCall: { name: "add", args: { a: 37, b: 29 }, id: "call_1" } }] };
const TOOL_RESPONSE_PART = { functionResponse: { name: "add", response: { result: 66 }, id: "call_1" } };

async function sendTurn(h: Harness, sessionId: string, contents: unknown[], system?: { parts: Array<{ text: string }> }): Promise<number> {
    const res = await fetch(`${h.proxyUrl}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ contents, ...(system ? { systemInstruction: system } : {}), generationConfig: { maxOutputTokens: 4096 } }),
    });
    await res.text();
    return res.status;
}

test("#3159 vertex: trailing note appended after a tool response forwards with text BEFORE functionResponse", async () => {
    const fake = await startFakeUpstream("google");
    let h: Harness | undefined;
    try {
        h = await startHarness(fake.url);
        // Turn 1 captures the system anchor silently; turn 2's localized
        // head-system change makes reconcileSystemAnchor emit a diff note,
        // which appendGoogleNudge appends to the trailing user content — the
        // exact #3159 shape (plain text after the functionResponse part).
        assert.equal(await sendTurn(h, "issue3159-note", TURN_1_CONTENTS, { parts: [{ text: BASE_SYSTEM }] }), 200, "turn 1 baseline completes");
        const turn2Status = await sendTurn(
            h,
            "issue3159-note",
            [...TURN_1_CONTENTS, MODEL_TURN, { role: "user", parts: [TOOL_RESPONSE_PART] }],
            { parts: [{ text: `${BASE_SYSTEM}\nUPDATED LINE` }] },
        );
        assert.equal(turn2Status, 200, "turn 2 must complete — a WC-018 violation would relay the fake's 400");
        assert.equal(fake.violations.length, 0, `fake upstream violations:\n${fake.violations.join("\n")}`);

        const capturedBody = fake.requests[1]?.body as
            | { contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
            | undefined;
        assert.ok(capturedBody?.contents, "upstream saw the turn-2 request with contents");
        const last = capturedBody.contents[capturedBody.contents.length - 1]!;
        assert.equal(last.role, "user");
        const parts = last.parts ?? [];
        assert.ok(parts.length >= 2, `expected note text + functionResponse part, got ${JSON.stringify(parts)}`);
        assert.equal(typeof parts[0]?.text, "string", "forwarded user content leads with the NOTE TEXT part");
        assert.ok(String(parts[0]?.text).includes("UPDATED"), "the appended text is the system-drift diff note");
        assert.equal((parts[1]?.functionResponse as { id?: string } | undefined)?.id, "call_1", "the functionResponse trails the note text");

        const wc017 = VALIDATORS.google(capturedBody).filter((v) => v.startsWith("WC-018"));
        assert.deepEqual(wc017, [], `no WC-018 violations in the forwarded turn-2 body:\n${wc017.join("\n")}`);
    } finally {
        if (h) await h.close();
        await fake.close();
    }
});

test("#3159 vertex: defective client order (functionResponse before text) is normalized on rebuild", async () => {
    const fake = await startFakeUpstream("google");
    let h: Harness | undefined;
    try {
        h = await startHarness(fake.url);
        assert.equal(await sendTurn(h, "issue3159-reorder", TURN_1_CONTENTS), 200, "turn 1 baseline completes");
        // No system instruction ⇒ no anchor notes; tiny session with flat
        // reported usage ⇒ nudge idle. Nothing appends — the forwarded shape
        // is the pure rebuild of the client's own defective order.
        assert.equal(
            await sendTurn(
                h,
                "issue3159-reorder",
                [...TURN_1_CONTENTS, MODEL_TURN, { role: "user", parts: [TOOL_RESPONSE_PART, { text: "carry on" }] }],
            ),
            200,
            "turn 2 completes — pre-fix this forwarded [functionResponse, text] and the fake relayed its 400",
        );
        assert.equal(fake.violations.length, 0, `fake upstream violations:\n${fake.violations.join("\n")}`);

        const capturedBody = fake.requests[1]?.body as
            | { contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
            | undefined;
        const last = capturedBody?.contents?.[capturedBody.contents.length - 1];
        assert.ok(last, "forwarded body has contents");
        const parts = last.parts ?? [];
        // Tagged text parts carry the kernel's ACP ref tag (an
        // <acp ...>mNNNNN</acp> element, hex-escaped per KDD#2) followed by
        // "\n" + the original text — pre-existing Google-lane rendering
        // present at turn 1 and in sessions without any functionResponse
        // (control-probe verified), orthogonal to the #3159 ordering fix.
        const t0 = typeof parts[0]?.text === "string" ? parts[0].text : "";
        assert.ok(t0.startsWith("\x3cacp "), "first part is the tagged text part");
        assert.ok(t0.endsWith("\ncarry on"), "client text preserved verbatim after the rendered tag");
        assert.deepEqual(parts[1], TOOL_RESPONSE_PART, "the functionResponse part follows the text, byte-exact");
    } finally {
        if (h) await h.close();
        await fake.close();
    }
});

// The two post-assembly boundaries that mutate an ALREADY forwarded body:
// appendTrailingUserText (degenerate-turn retry nudge / fake-completion hint)
// and insertCheckpointCarrier (opt-in outbound chain stamp). Both used to
// append text after whatever parts existed — including a trailing
// functionResponse — re-creating the WC-017 shape invisible to the rebuild.
test("#3159 vertex: post-assembly trailing-text merge keeps text before functionResponse", () => {
    const out = appendTrailingUserText("google", JSON.stringify({ contents: [{ role: "user", parts: [{ text: "q" }, TOOL_RESPONSE_PART] }] }), "nudge-text")!;
    const parsed = JSON.parse(out) as { contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> };
    const parts = parsed.contents[0]?.parts ?? [];
    assert.deepEqual(parts, [{ text: "q" }, { text: "nudge-text" }, TOOL_RESPONSE_PART], "merged text leads the trailing functionResponse");
    assert.deepEqual(VALIDATORS.google(parsed).filter((v) => v.startsWith("WC-017")), [], "merged body carries no WC-017 violation");
    // No defect ⇒ plain append, byte-stable (prefix-cache anchor untouched).
    const plain = appendTrailingUserText("google", JSON.stringify({ contents: [{ role: "user", parts: [{ text: "q" }] }] }), "more")!;
    assert.deepEqual(JSON.parse(plain), { contents: [{ role: "user", parts: [{ text: "q" }, { text: "more" }] }] });
});

test("#3159 vertex: outbound chain-checkpoint carrier lands before a trailing functionResponse", () => {
    const stamped = insertCheckpointCarrier({ contents: [{ role: "user", parts: [{ text: "q" }, TOOL_RESPONSE_PART] }] }, "google", "checkpoint-tag") as
        | { contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
        | null;
    assert.ok(stamped, "carrier inserted into the google body");
    const parts = stamped.contents[0]?.parts ?? [];
    assert.deepEqual(parts, [{ text: "q" }, { text: "checkpoint-tag" }, TOOL_RESPONSE_PART], "carrier text leads the trailing functionResponse");
    assert.deepEqual(VALIDATORS.google(stamped).filter((v) => v.startsWith("WC-017")), [], "stamped body carries no WC-017 violation");
});
