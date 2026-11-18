// #7085 follow-up: source-kind attestation channel (dsh lane).
//
// The durable classifiers in src/durable-message-guards.ts match COPIED TEXT
// markers — a host rewording its snapshot silently disarms them (#7085: dsh
// 0.2.2-rc.3 changed the runtime-context intro and protection was lost for
// three days before anyone noticed). This channel closes the class: the dsh
// plugin attests `(kind, fingerprint-of-exact-text)` pairs on the
// x-bili-msg-kinds header, the server classifies by fingerprint first and
// falls through to the text markers, so an absent header / unmapped kind /
// fingerprint miss all degrade to byte-identical pre-channel behavior.
//
// Gate discipline (#3617) — every behavior asserted BOTH directions:
//   positive: attested reworded text classifies; well-formed headers decode;
//             the host collector and server decoder agree on one corpus;
//   negative: unattested text does NOT classify via the kind path; malformed
//             headers void the WHOLE index (all-or-nothing); wrong role /
//             unknown kind / wrong form never attest.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    dshDurableToolPathWithKinds,
    dshSourceKindToPath,
    msgKindFingerprint,
} from "../src/durable-message-guards.ts";
import { MSG_KINDS_HEADER, incomingMsgKindsHeader } from "../src/msgid-pin.ts";
import { UPSTREAM_HOP_HEADERS } from "../src/server/headers.ts";
import { _kindAttestationsOfForTest, _msgKindFingerprintForTest } from "../src/agent/dsh-native.ts";
import type { CoreMessage } from "acp-kernel";

const textMsg = (text: string, role: CoreMessage["role"] = "user"): CoreMessage =>
    ({ id: `t${Math.random().toString(36).slice(2)}`, role, contentType: "text", text }) as CoreMessage;

/** Build a fingerprint→kind index the way the server seam does from a header. */
const indexFrom = (header: string): Map<string, string> | undefined => incomingMsgKindsHeader(header);

/* ------------------------------------------------------------------ */
/* Header decode (server side)                                        */
/* ------------------------------------------------------------------ */

test("decode: well-formed pairs → fp→kind index", () => {
    const a = msgKindFingerprint("text A");
    const b = msgKindFingerprint("text B");
    const idx = incomingMsgKindsHeader(`runtime-context=${a},subagent-settled=${b}`);
    assert.ok(idx);
    assert.deepEqual([...idx.entries()].sort(), [
        [a, "runtime-context"],
        [b, "subagent-settled"],
    ]);
});

test("decode: duplicate identical pairs are idempotent", () => {
    const fp = msgKindFingerprint("same text");
    const idx = incomingMsgKindsHeader(`skill-catalog=${fp},skill-catalog=${fp}`);
    assert.ok(idx);
    assert.equal(idx.size, 1);
    assert.equal(idx.get(fp), "skill-catalog");
});

test("decode: empty / whitespace-free malformed shapes void the header", () => {
    const fp = msgKindFingerprint("x");
    const bad = [
        "",
        "runtime-context", // no =
        "=abcdef0123456789", // no kind
        `runtime-context=`, // no fp
        `Runtime-context=${fp}`, // uppercase kind
        `1runtime=${fp}`, // leading digit
        `runtime_context=${fp}`, // underscore
        "k".repeat(41) + `=${fp}`, // kind > 40 chars
        `runtime-context=abcdef012345678`, // 15 hex
        `runtime-context=abcdef01234567890`, // 17 hex
        `runtime-context=ABCDEF0123456789`, // uppercase hex
        `runtime-context=abcdef012345678g`, // non-hex
        `runtime-context=${fp}extra`, // trailing junk
        `runtime-context=${fp},oops`, // one bad pair poisons the WHOLE index
    ];
    for (const raw of bad) assert.equal(incomingMsgKindsHeader(raw), undefined, JSON.stringify(raw));
});

test("decode: the same fingerprint attested under two kinds is ambiguous → void", () => {
    const fp = msgKindFingerprint("two kinds?");
    assert.equal(incomingMsgKindsHeader(`runtime-context=${fp},skill-catalog=${fp}`), undefined);
});

test("decode: caps — 512 pairs pass, 513 void; oversized raw voids before any parsing", () => {
    const pair = (i: number) => `kind${i.toString().padStart(2, "0")}=${msgKindFingerprint(String(i))}`;
    const n = (count: number) => Array.from({ length: count }, (_, i) => pair(i)).join(",");
    assert.ok(incomingMsgKindsHeader(n(512)));
    assert.equal(incomingMsgKindsHeader(n(513)), undefined);
    // the byte cap (64KiB, shared with the stamped ids header) fires on the
    // RAW value before pair parsing — well-formed or not
    const over = "a".repeat(64 * 1024 + 1);
    assert.equal(incomingMsgKindsHeader(over), undefined);
});

test("decode: array header values take the first entry (undici shape)", () => {
    const fp = msgKindFingerprint("h");
    const fromArray = incomingMsgKindsHeader([`time-context=${fp}`, "garbage"]);
    const fromString = indexFrom(`time-context=${fp}`);
    assert.deepEqual([...(fromArray ?? []).entries()], [...(fromString ?? []).entries()]);
    assert.equal(incomingMsgKindsHeader(undefined), undefined);
});

test("egress: x-bili-msg-kinds is stripped before the upstream", () => {
    assert.ok(UPSTREAM_HOP_HEADERS.has(MSG_KINDS_HEADER));
    assert.equal(MSG_KINDS_HEADER, "x-bili-msg-kinds"); // keep-in-sync twin in dsh-native.ts
});

/* ------------------------------------------------------------------ */
/* Host collector (dsh-native side)                                   */
/* ------------------------------------------------------------------ */

const hostMsg = (content: unknown, source?: unknown, id = "m1") => ({ id, content, source });

test("collector: only attested (kind, form) pairs emit; everything else is skipped", () => {
    const snap = "<system-reminder>\nThe following information describes your current session:\n\ncwd: /x\n</system-reminder>";
    const msgs = [
        hostMsg(snap, { kind: "runtime-context", form: "snapshot" }),
        hostMsg("real human text", { kind: "user" }),
        hostMsg("sys", { kind: "system-prompt" }),
        hostMsg("no source at all"),
        hostMsg("tmux pane stuff", { kind: "tmux-context" }),
        hostMsg("a reconcile notice", { kind: "agent-instructions", form: "reconcile" }),
        hostMsg("settled?", { kind: "subagent-settled" }),
    ];
    const pairs = _kindAttestationsOfForTest(msgs);
    assert.deepEqual(pairs, [
        `runtime-context=${msgKindFingerprint(snap)}`,
        `subagent-settled=${msgKindFingerprint("settled?")}`,
    ]);
});

test("collector: the form filter admits exactly the attested forms", () => {
    const baseline = "<system-reminder>\nInstructions from: /agents.md\n</system-reminder>";
    const relay = "Agent 7 sent a message: hi";
    assert.deepEqual(_kindAttestationsOfForTest([hostMsg(baseline, { kind: "agent-instructions", form: "instructions" })]),
        [`agent-instructions=${msgKindFingerprint(baseline)}`]);
    assert.deepEqual(_kindAttestationsOfForTest([hostMsg(baseline, { kind: "agent-instructions", form: "reconcile" })]), []);
    assert.deepEqual(_kindAttestationsOfForTest([hostMsg(relay, { kind: "agent-message", form: "relay" })]),
        [`agent-message=${msgKindFingerprint(relay)}`]);
    assert.deepEqual(_kindAttestationsOfForTest([hostMsg(relay, { kind: "agent-message", form: "other" })]), []);
});

test("collector: block content attests each text unit, skips images and empties", () => {
    const a = "text block A";
    const b = "text block B";
    const msg = hostMsg(
        [
            { type: "text", text: a },
            { type: "image", data: "..." },
            { type: "text", text: "" },
            { type: "text", text: b },
        ],
        { kind: "ptc-mode" },
    );
    assert.deepEqual(_kindAttestationsOfForTest([msg]), [
        `ptc-mode=${msgKindFingerprint(a)}`,
        `ptc-mode=${msgKindFingerprint(b)}`,
    ]);
});

test("collector: duplicate (kind, text) pairs dedupe; the 512 cap holds", () => {
    const t = "once";
    const two = _kindAttestationsOfForTest([hostMsg(t, { kind: "dsh-mnemon" }), hostMsg(t, { kind: "dsh-mnemon" })]);
    assert.equal(two.length, 1);
    const many = Array.from({ length: 600 }, (_, i) => hostMsg(`unit ${i}`, { kind: "tool-jobs" }));
    assert.equal(_kindAttestationsOfForTest(many).length, 512);
});

test("collector: empty / non-array inputs degrade to no attestation", () => {
    assert.deepEqual(_kindAttestationsOfForTest(undefined), []);
    assert.deepEqual(_kindAttestationsOfForTest(null), []);
    assert.deepEqual(_kindAttestationsOfForTest("nope"), []);
    assert.deepEqual(_kindAttestationsOfForTest([null, 42, "x"]), []);
});

/* ------------------------------------------------------------------ */
/* Fingerprint lockstep: host mirror ↔ server expression              */
/* ------------------------------------------------------------------ */

test("lockstep: host and server fingerprints agree on one corpus", () => {
    const corpus = [
        "plain ascii",
        "unicode 中文 — 日本語 🚀",
        "trailing newline\n",
        "  padded  ",
        "émoji naïve",
        "long text".repeat(5000),
        "<system-reminder>\nThe following information describes your current session:\n\napproval: read-only\n</system-reminder>",
    ];
    for (const t of corpus) assert.equal(_msgKindFingerprintForTest(String(t)), msgKindFingerprint(String(t)));
});

/* ------------------------------------------------------------------ */
/* Classifier: kind attestation first, text markers as fallback       */
/* ------------------------------------------------------------------ */

/** THE #7085 class: reworded snapshot text that matches NO known marker. */
const REWORDED_SNAPSHOT = "Your session parameters are currently:\napproval: read-only\ncwd: /work";
assert.ok(!REWORDED_SNAPSHOT.includes("Current runtime context"));
assert.ok(!REWORDED_SNAPSHOT.includes("The following information describes your current session"));

const classifier = (index: Map<string, string> | undefined) =>
    dshDurableToolPathWithKinds(index);

test("fix: an attested reworded snapshot classifies as durable/runtime-context", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    assert.equal(classifier(idx)(textMsg(REWORDED_SNAPSHOT)), "durable/runtime-context");
});

test("negative: the SAME reworded text without attestation stays unclassified", () => {
    assert.equal(classifier(undefined)(textMsg(REWORDED_SNAPSHOT)), undefined);
    // and a different header (wrong fp) does not rescue it
    const other = indexFrom(`runtime-context=${msgKindFingerprint("some other text")}`);
    assert.ok(other);
    assert.equal(classifier(other)(textMsg(REWORDED_SNAPSHOT)), undefined);
});

test("fallback: unattested text keeps the existing marker classification", () => {
    const legacy = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
    const idx = indexFrom(`time-context=${msgKindFingerprint("irrelevant")}`);
    assert.ok(idx);
    assert.equal(classifier(idx)(textMsg(legacy)), "durable/runtime-context");
});

test("parity: factory(undefined) is byte-identical to the text-only classifier", () => {
    const corpus: CoreMessage[] = [
        textMsg("<system-reminder><available_skills>a</available_skills></system-reminder>"),
        textMsg("Instructions from: /x/AGENTS.md"),
        textMsg("Current runtime context: none. Earlier runtime-context snapshots no longer apply."),
        textMsg("<mcp_catalog>servers</mcp_catalog>"),
        textMsg("Time sampled while preparing turn 3, step 1: 2026-11-18T00:00:00Z"),
        textMsg("<path>/tmp/i.png</path> <type>image</type> <content>10px</content>"),
        textMsg("background job j1 (build) finished [status: success, exit code: 0]. Read its output with job_output."),
        textMsg("[MNEMON] recalled: the user prefers tabs"),
        textMsg("Background subagent 42 finished and will do no further work unless you send it more."),
        textMsg("Agent 7 sent a message: please review"),
        textMsg("Image shot.png (sha256:ab); request preview 100x200px."),
        textMsg("[image omitted to fit request image limits; original: shot.png] keep going"),
        textMsg("a plain human question"),
        textMsg("<available_skills>echoed", "assistant"),
    ];
    const plain = classifier(undefined);
    const noIndex = dshDurableToolPathWithKinds(undefined);
    for (const msg of corpus) {
        assert.equal(plain(msg), noIndex(msg), JSON.stringify(msg.text ?? msg));
        // plain === dshDurableToolPath: the undefined factory returns it, so
        // spot-check the marker outcome directly on a few rows.
    }
    assert.equal(plain(corpus[0]), "durable/skill-catalog");
    assert.equal(plain(corpus[5]), "oneshot/ptc-image");
    assert.equal(plain(corpus[12]), undefined);
    assert.equal(plain(corpus[13]), undefined); // assistant echo is never a carrier
});

test("one-shot families: a reworded settled notice reaches its oneshot path via kind", () => {
    const reworded = "A background task completed its run.";
    const idx = indexFrom(`subagent-settled=${msgKindFingerprint(reworded)}`);
    assert.ok(idx);
    assert.equal(classifier(idx)(textMsg(reworded)), "oneshot/subagent-settled");
    assert.equal(classifier(undefined)(textMsg(reworded)), undefined);
});

test("unknown attested kinds fall through to the markers (permitlist, not closed vocabulary)", () => {
    const t = "tmux pane 1 output";
    const idx = indexFrom(`tmux-context=${msgKindFingerprint(t)}`);
    assert.ok(idx);
    assert.equal(classifier(idx)(textMsg(t)), undefined);
});

test("the role gate: an attested ASSISTANT message is never a carrier", () => {
    const t = "model echo of the snapshot";
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(t)}`);
    assert.ok(idx);
    assert.equal(classifier(idx)(textMsg(t, "assistant")), undefined);
});

test("empty text never fingerprints (no constant- fp collision)", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint("")}`);
    assert.ok(idx);
    assert.equal(classifier(idx)(textMsg("")), undefined);
});

test("kind→path map: the evidence-permitlist is exactly the nine mapped kinds", () => {
    assert.deepEqual(Object.keys(dshSourceKindToPath).sort(), [
        "agent-instructions",
        "agent-message",
        "dsh-mnemon",
        "ptc-mode",
        "runtime-context",
        "skill-catalog",
        "subagent-settled",
        "time-context",
        "tool-jobs",
    ]);
});

/* ------------------------------------------------------------------ */
/* End-to-end: host collector → header bytes → server decode → classify */
/* ------------------------------------------------------------------ */

test("e2e: what the plugin stamps is exactly what the classifier resolves", () => {
    const snapshot = "<system-reminder>\nThe following information describes your current session.\nIt replaces earlier versions of this context, including any retained in conversation summaries.\n\napproval: full\n</system-reminder>";
    const catalog = "<system-reminder>\n<available_skills>\n<skill name=\"a\">b</skill>\n</available_skills>\n</system-reminder>";
    const pairs = _kindAttestationsOfForTest([
        hostMsg(snapshot, { kind: "runtime-context", form: "snapshot" }),
        hostMsg(catalog, { kind: "skill-catalog" }),
        hostMsg("human: do the thing", { kind: "user" }),
    ]);
    assert.deepEqual(pairs, [
        `runtime-context=${msgKindFingerprint(snapshot)}`,
        `skill-catalog=${msgKindFingerprint(catalog)}`,
    ]);
    const header = pairs.join(",");
    const idx = incomingMsgKindsHeader(header);
    assert.ok(idx);
    const classify = classifier(idx);
    assert.equal(classify(textMsg(snapshot)), "durable/runtime-context");
    assert.equal(classify(textMsg(catalog)), "durable/skill-catalog");
    assert.equal(classify(textMsg("human: do the thing")), undefined);
});
