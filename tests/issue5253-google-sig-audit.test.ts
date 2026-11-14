import { test } from "node:test";
import assert from "node:assert/strict";
import { auditGoogleSignatures, googleSigWarnDecision } from "../src/server/google-sig-audit.js";
import type { GoogleContent } from "acp-kernel/wire";

const SIG = "c2ln";

function c(role: string, parts: object[]): GoogleContent {
    return { role, parts } as GoogleContent;
}

test("auditGoogleSignatures: counts signed/unsigned calls and thoughts, records unsigned sites", () => {
    const contents = [
        c("user", [{ text: "plain" }, { functionResponse: { name: "t", response: {} } }]),
        c("model", [
            { thought: true, text: "th", thoughtSignature: SIG },
            { text: "reply" },
            { functionCall: { name: "herdr_pane_read", args: {} }, thoughtSignature: SIG },
        ]),
        c("model", [
            { functionCall: { name: "bash", args: {} } },
            { thought: true, text: "unsigned thinking" },
        ]),
    ];
    const a = auditGoogleSignatures(contents);
    assert.equal(a.signedCalls, 1);
    assert.equal(a.unsignedCalls, 1);
    assert.equal(a.signedThoughts, 1);
    assert.equal(a.unsignedThoughts, 1);
    assert.deepEqual(a.sites, ["contents[2].parts[0] bash"]);
});

test("auditGoogleSignatures: all-signed history stays clean", () => {
    const contents = [
        c("model", [{ thought: true, text: "t", thoughtSignature: SIG }, { functionCall: { name: "x" }, thoughtSignature: SIG }]),
        c("user", [{ functionResponse: { name: "x", response: { output: "ok" } } }, { text: "next" }]),
    ];
    const a = auditGoogleSignatures(contents);
    assert.equal(a.signedCalls + a.signedThoughts, 2);
    assert.equal(a.unsignedCalls + a.unsignedThoughts, 0);
    assert.deepEqual(a.sites, []);
});

test("auditGoogleSignatures: malformed shapes never throw and count nothing", () => {
    const junk = [null, 42, "str", { parts: "nope" }, { role: "model" }, { parts: [null, 7, { functionCall: {} }] }] as never;
    const a = auditGoogleSignatures(junk);
    assert.deepEqual(a, { signedCalls: 0, unsignedCalls: 0, signedThoughts: 0, unsignedThoughts: 0, sites: [] });
});

test("auditGoogleSignatures: site list caps at five entries", () => {
    const parts = Array.from({ length: 7 }, (_, i) => ({ functionCall: { name: `tool${i}` } }));
    const a = auditGoogleSignatures([c("model", parts)]);
    assert.equal(a.unsignedCalls, 7);
    assert.equal(a.sites.length, 5);
});

test("googleSigWarnDecision: warns on first affected turn of a signing model, attributes origin", () => {
    assert.deepEqual(googleSigWarnDecision({ modelSigns: true, unsignedIn: 3, unsignedOut: 3, warnedTurns: 0 }), { warn: true, clientOrigin: true });
    // inbound clean, outbound dirty = bili-side defect attribution
    assert.deepEqual(googleSigWarnDecision({ modelSigns: true, unsignedIn: 0, unsignedOut: 2, warnedTurns: 0 }), { warn: true, clientOrigin: false });
});

test("googleSigWarnDecision: silent for non-signing models and clean outbounds", () => {
    assert.equal(googleSigWarnDecision({ modelSigns: false, unsignedIn: 4, unsignedOut: 4, warnedTurns: 0 }).warn, false);
    assert.equal(googleSigWarnDecision({ modelSigns: true, unsignedIn: 0, unsignedOut: 0, warnedTurns: 0 }).warn, false);
});

test("googleSigWarnDecision: re-warns every tenth affected turn only", () => {
    for (let n = 1; n < 30; n++) {
        const expected = n % 10 === 0;
        assert.equal(googleSigWarnDecision({ modelSigns: true, unsignedIn: 1, unsignedOut: 1, warnedTurns: n }).warn, expected, `turn ${n}`);
    }
});
