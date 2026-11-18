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
// #7120: the same index also rescues the side-request demotion gate
// (isDshSingleShotSidecar) and the title derivation
// (deriveTitle / isAutoInjectedNotification) — the two surfaces left
// marker-only by v1.
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
    dshSourceKindToPath,
    dshTextUnitIsCarrier,
    durableMessageToolPathFactories,
    dshDurableToolPathWithKinds,
    msgKindFingerprint,
    oneShotCarrierPathFactories,
    oneShotCarrierPaths,
} from "../src/durable-message-guards.ts";
import { MSG_KINDS_HEADER, incomingMsgKindsHeader } from "../src/msgid-pin.ts";
import { UPSTREAM_HOP_HEADERS } from "../src/server/headers.ts";
import { isDshSingleShotSidecar } from "../src/server/side-request.ts";
import { deriveTitle, isAutoInjectedNotification } from "../src/server.ts";
import {
    _attestableKindFormsForTest,
    _attestableSourceKindsForTest,
    _kindAttestationsOfForTest,
    _msgKindFingerprintForTest,
} from "../src/agent/dsh-native.ts";
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
    // the cap counts RAW pairs (duplicates included) — the documented
    // "≤512 pairs" is about the header's work, not the deduped index
    const dup = [Array.from({ length: 512 }, (_, i) => pair(i)), ...Array.from({ length: 2 }, (_, i) => pair(i))].join(",");
    assert.equal(incomingMsgKindsHeader(dup), undefined);
    // the byte cap (64KiB, shared with the stamped ids header) fires on the
    // RAW value before pair parsing — well-formed or not
    const over = "a".repeat(64 * 1024 + 1);
    assert.equal(incomingMsgKindsHeader(over), undefined);
});

test("decode: interior-comma tolerance; a space in any pair voids the whole header", () => {
    const fp1 = msgKindFingerprint("one");
    const fp2 = msgKindFingerprint("two");
    const idx = indexFrom(`time-context=${fp1},,skill-catalog=${fp2}`);
    assert.ok(idx);
    assert.equal(idx.get(fp1), "time-context");
    assert.equal(idx.get(fp2), "skill-catalog");
    // a space (e.g. from a raw "a, b" join or leading whitespace) is not in
    // the pair alphabet — the header voids, it never half-decodes
    assert.equal(indexFrom(`time-context=${fp1}, skill-catalog=${fp2}`), undefined);
    assert.equal(indexFrom(` time-context=${fp1}`), undefined);
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
    const many = Array.from({ length: 600 }, (_, i) => hostMsg(`unit ${i}`, { kind: "tool-jobs", form: "notice" }));
    assert.equal(_kindAttestationsOfForTest(many).length, 512);
});

test("collector: a bare string ARRAY PART is its own unit (matches the openai wire codec)", () => {
    const msg = hostMsg(["plain string part", { type: "text", text: "block part" }], { kind: "dsh-mnemon" });
    assert.deepEqual(_kindAttestationsOfForTest([msg]), [
        `dsh-mnemon=${msgKindFingerprint("plain string part")}`,
        `dsh-mnemon=${msgKindFingerprint("block part")}`,
    ]);
});

test("collector: assistant-role messages are skipped (defensive; server role gate still applies)", () => {
    const t = "an assistant echo with a source stamped on it";
    assert.deepEqual(_kindAttestationsOfForTest([{ id: "m", role: "assistant", content: t, source: { kind: "dsh-mnemon" } }]), []);
});

test("lockstep: host attestable kind set === server permitlist keys (asymmetry would pin both directions)", () => {
    const hostKinds = [..._attestableSourceKindsForTest, ...Object.keys(_attestableKindFormsForTest)].sort();
    assert.deepEqual(hostKinds, Object.keys(dshSourceKindToPath).sort());
});

test("factory registry: exactly { dsh } — a non-dsh pluginAgent can never obtain the dsh factory", () => {
    assert.deepEqual(Object.keys(durableMessageToolPathFactories), ["dsh"]);
    assert.equal(durableMessageToolPathFactories["pi"], undefined);
    assert.equal(durableMessageToolPathFactories["opencode"], undefined);
    const idx = indexFrom(`runtime-context=${msgKindFingerprint("x")}`);
    assert.ok(idx);
    assert.equal(durableMessageToolPathFactories["dsh"](idx)(textMsg("x")), "durable/runtime-context");
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

/* ------------------------------------------------------------------ */
/* One-shot carrier FACTORY (fold-drift accounting, channel 1)         */
/* ------------------------------------------------------------------
 * The fold-reconcile expected-rebase accounting (fold-reconcile.ts channel
 * 1) classifies NEW inbound carrier ids with a marker-based classifier.
 * A reworded carrier that misses every marker is never recorded as an
 * expected rebase → it later lands in `missing` → the #5139 O(full-history)
 * drift tax + a false drift warning. The factory mirrors the protection
 * classifier: kind-first, marker-fallback, byte-identical when unattested.
 */

const oneShotClassifier = (index: Map<string, string> | undefined) =>
    oneShotCarrierPathFactories["dsh"](index);

test("one-shot factory registry: exactly { dsh } — a non-dsh pluginAgent can never obtain the dsh one-shot factory", () => {
    assert.deepEqual(Object.keys(oneShotCarrierPathFactories), ["dsh"]);
    assert.equal(oneShotCarrierPathFactories["pi"], undefined);
    assert.equal(oneShotCarrierPathFactories["opencode"], undefined);
});

test("one-shot parity: factory(undefined) IS the text-only classifier (same reference)", () => {
    assert.equal(oneShotCarrierPathFactories["dsh"](undefined), oneShotCarrierPaths["dsh"]);
});

test("one-shot fix: an attested reworded carrier reaches its oneshot path via kind (channel 1)", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    assert.equal(oneShotClassifier(idx)(textMsg(REWORDED_SNAPSHOT)), "durable/runtime-context");
    assert.equal(oneShotCarrierPaths["dsh"](textMsg(REWORDED_SNAPSHOT)), undefined); // unattested = marker miss
});

test("one-shot negative: unattested reworded carrier stays unclassified (marker miss)", () => {
    const other = indexFrom(`time-context=${msgKindFingerprint("some other text")}`);
    assert.ok(other);
    assert.equal(oneShotClassifier(other)(textMsg(REWORDED_SNAPSHOT)), undefined);
});

test("one-shot fallback: unattested text keeps the existing marker classification", () => {
    const legacy = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
    const idx = indexFrom(`time-context=${msgKindFingerprint("irrelevant")}`);
    assert.ok(idx);
    assert.equal(oneShotClassifier(idx)(textMsg(legacy)), "durable/runtime-context");
});

test("one-shot role gate: an attested ASSISTANT message is never a carrier", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    assert.equal(oneShotClassifier(idx)(textMsg(REWORDED_SNAPSHOT, "assistant")), undefined);
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

/* ------------------------------------------------------------------ */
/* #7120 surface 2: side-request demotion gate (isDshSingleShotSidecar) */
/* ------------------------------------------------------------------
 * A tool-less single-user body carrying a durable-state marker is a MAIN
 * turn, not a utility sidecar — routing it to the verbatim side lane skips
 * the kernel, so the classifier can never stamp the carrier's BLOCKED ref
 * (#2419/#2446/#2447/#2817/#5403). The marker list is copied text: a host
 * rewording its snapshot silently disarms the gate (the #7085 class). The
 * kind attestation index (x-bili-msg-kinds) rescues the reworded units; an
 * `undefined` index (no header / voided) keeps the gate byte-identical to
 * the marker-only behavior.
 */

const sidecarBody = (userContent: unknown) => ({
    model: "m",
    messages: [
        { role: "system", content: "You are a title generator." },
        { role: "user", content: userContent },
    ],
});

test("sidecar fix: an attested reworded carrier keeps the body on the MAIN lane", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(REWORDED_SNAPSHOT), idx), false);
});

test("sidecar negative: the SAME reworded body without the header still takes the side lane", () => {
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(REWORDED_SNAPSHOT)), true);
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(REWORDED_SNAPSHOT), undefined), true);
});

test("sidecar negative: an attestation for OTHER text (wrong fp) does not rescue", () => {
    const other = indexFrom(`runtime-context=${msgKindFingerprint("some other text")}`);
    assert.ok(other);
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(REWORDED_SNAPSHOT), other), true);
});

test("sidecar negative: an unmapped kind (tmux-context) never rescues", () => {
    const idx = indexFrom(`tmux-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(REWORDED_SNAPSHOT), idx), true);
});

test("sidecar parity: a marker-matching carrier is a MAIN turn with or without the header", () => {
    const legacy = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(legacy)), false);
    const idx = indexFrom(`time-context=${msgKindFingerprint("irrelevant")}`);
    assert.ok(idx);
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(legacy), idx), false);
});

test("sidecar fix: the parts-array content form is rescued the same way", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    const parts = [{ text: REWORDED_SNAPSHOT }];
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(parts), idx), false);
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody(parts)), true);
});

test("sidecar parity: a genuine sidecar keeps the side lane even with an unrelated header", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    assert.equal(isDshSingleShotSidecar("openai", sidecarBody("summarize this document"), idx), true);
});

/* ------------------------------------------------------------------ */
/* #7120 surface 3: title derivation (deriveTitle / isAutoInjectedNotification) */
/* ------------------------------------------------------------------
 * deriveTitle skips host-injected notifications by PREFIX — copied text a
 * host rewords (the #7085 class) titles the session on the notification
 * forever (the title is set-once, #2286). The kind attestation index
 * rescues the reworded units; the fingerprint is over the UNTRIMMED bytes,
 * the exact unit the host attested. An `undefined` index keeps the
 * derivation byte-identical to pre-channel.
 */

/** A reworded notification on ONE line (no marker, no prefix match). */
const REWORDED_SINGLE_LINE = "Your session parameters: approval read-only, cwd /work";
assert.ok(!REWORDED_SINGLE_LINE.includes("Current runtime context"));
assert.ok(!REWORDED_SINGLE_LINE.startsWith("\x3csystem-reminder\x3e"));

test("title fix: an attested reworded notification is skipped, the real question wins", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SINGLE_LINE)}`);
    assert.ok(idx);
    const msgs = [textMsg(REWORDED_SINGLE_LINE), textMsg("fix the auth bug")];
    assert.equal(deriveTitle(msgs, idx), "fix the auth bug");
});

test("title negative: the SAME history without the header titles on the reworded carrier", () => {
    const msgs = [textMsg(REWORDED_SINGLE_LINE), textMsg("fix the auth bug")];
    assert.equal(deriveTitle(msgs), REWORDED_SINGLE_LINE);
    assert.equal(deriveTitle(msgs, undefined), REWORDED_SINGLE_LINE);
});

test("title fix: isAutoInjectedNotification recognizes the attested reworded unit, not a real question", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SINGLE_LINE)}`);
    assert.ok(idx);
    assert.equal(isAutoInjectedNotification(REWORDED_SINGLE_LINE, idx), true);
    assert.equal(isAutoInjectedNotification("fix the auth bug", idx), false);
});

test("title parity: the legacy prefix fallback is unchanged with or without the header", () => {
    const legacy = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
    assert.equal(isAutoInjectedNotification(legacy), true);
    assert.equal(isAutoInjectedNotification(legacy, undefined), true);
    const idx = indexFrom(`time-context=${msgKindFingerprint("irrelevant")}`);
    assert.ok(idx);
    assert.equal(isAutoInjectedNotification(legacy, idx), true);
});

test("title byte-equality: the fingerprint is over the UNTRIMMED bytes the host attested", () => {
    const padded = `  ${REWORDED_SINGLE_LINE}  `;
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(padded)}`);
    assert.ok(idx);
    // the wire unit carries the padding the host sent — it is skipped
    assert.equal(isAutoInjectedNotification(padded, idx), true);
    // the trimmed form is a DIFFERENT unit: no rescue (no normalization)
    assert.equal(isAutoInjectedNotification(REWORDED_SINGLE_LINE, idx), false);
});

test("helper: dshTextUnitIsCarrier is false without an index and for empty text", () => {
    const idx = indexFrom(`runtime-context=${msgKindFingerprint(REWORDED_SNAPSHOT)}`);
    assert.ok(idx);
    assert.equal(dshTextUnitIsCarrier(REWORDED_SNAPSHOT, idx), true);
    assert.equal(dshTextUnitIsCarrier(REWORDED_SNAPSHOT, undefined), false);
    assert.equal(dshTextUnitIsCarrier("", idx), false);
});
