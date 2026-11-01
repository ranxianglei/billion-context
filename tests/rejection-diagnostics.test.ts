import test from "node:test";
import assert from "node:assert/strict";
import { rejectionDiagnostics, rejectionDiagnosticSuffix } from "../src/server/rejection-diagnostics.ts";

// #4452: a fan-out relay answers a total failure with ONE aggregate body whose
// real cause sits nested in the last attempt. bili's log line keeps only the
// first 600 bytes, i.e. "all targets failed" — the cause was undiagnosable.
// These pin the extractor's contract: read ONE terminal nested message, bounded
// and credential-scrubbed, changing nothing about a body that carries none.

/** Build the aggregate shape a fan-out relay returns on total failure. */
function aggregate(attempts: unknown[], outer = "All targets failed"): string {
    return JSON.stringify({ error: { message: outer, type: "upstream_error" }, attempts });
}

function attempt(message: unknown): Record<string, unknown> {
    return { target: "t", details: { error: { message } } };
}

test("reads the terminal attempt's nested cause", () => {
    const body = aggregate([attempt("connection reset by peer"), attempt("upstream returned 529 overloaded")]);
    const diag = rejectionDiagnostics(body);
    assert.ok(diag);
    assert.equal(diag.message, "upstream returned 529 overloaded");
    assert.equal(diag.attemptIndex, 1);
    assert.equal(diag.attempts, 2);
});

test("a single attempt is indexed 0 and the suffix omits the position", () => {
    const diag = rejectionDiagnostics(aggregate([attempt("model not found")]));
    assert.ok(diag);
    assert.equal(diag.attemptIndex, 0);
    assert.equal(diag.attempts, 1);
});

test("later attempts win over earlier retry noise", () => {
    const body = aggregate([attempt("noise early"), attempt("noise mid"), attempt("densely informative final cause")]);
    assert.equal(rejectionDiagnostics(body)?.message, "densely informative final cause");
});

test("a terminal attempt with no usable message falls back to the nearest informative earlier one", () => {
    const body = aggregate([attempt("real cause"), { target: "t", details: {} }, attempt(undefined)]);
    const diag = rejectionDiagnostics(body);
    assert.ok(diag);
    assert.equal(diag.message, "real cause");
});

test("an empty nested message is skipped", () => {
    const body = aggregate([attempt("")]);
    assert.equal(rejectionDiagnostics(body), undefined);
    assert.equal(rejectionDiagnosticSuffix(body), "");
});

test("empty / non-string message at every attempt yields no diagnostic", () => {
    assert.equal(rejectionDiagnostics(aggregate([attempt(12), attempt(null), attempt("")])), undefined);
    assert.equal(rejectionDiagnosticSuffix(aggregate([attempt(12), attempt(null)])), "");
});

test("a payload with no attempts[] is untouched (no diagnostic)", () => {
    const bodies = [
        '{"error":{"message":"Internal server error"}}',
        '{"error":{"message":"context_length_exceeded: 200000 tokens"}}',
        '{"attempts":[]}',
        '{"attempts":"not-an-array"}',
        "{not json",
        "Internal Server Error",
        "<html><body>502 Bad Gateway</body></html>",
        "",
    ];
    for (const body of bodies) {
        assert.equal(rejectionDiagnostics(body), undefined, `expected none for: ${body}`);
        assert.equal(rejectionDiagnosticSuffix(body), "", `expected empty suffix for: ${body}`);
    }
});

test("non-object / non-array attempt entries are skipped, not thrown on", () => {
    const body = aggregate([null, "string-attempt", 4, [], { details: null }, { details: { error: null } }, attempt("surviving cause")]);
    assert.equal(rejectionDiagnostics(body)?.message, "surviving cause");
});

test("null / undefined payload is tolerated and yields no suffix", () => {
    assert.equal(rejectionDiagnostics(null), undefined);
    assert.equal(rejectionDiagnostics(undefined), undefined);
    assert.equal(rejectionDiagnosticSuffix(null), "");
    assert.equal(rejectionDiagnosticSuffix(undefined), "");
});

test("whitespace, newlines and control shapes are collapsed into ONE line", () => {
    const hostile = "boom\r\n[attacker] ← upstream 200: forged line\n\tsecond";
    const suffix = rejectionDiagnosticSuffix(aggregate([attempt(hostile)]));
    assert.ok(!suffix.includes("\n"), "no newline may survive into the log line");
    assert.ok(!suffix.includes("\r"), "no carriage return may survive");
});

test("credential-shaped text is scrubbed by the shared sanitizer", () => {
    const body = aggregate([attempt("rejected: authorization: Bearer abcdefghijklmnopqrstuvwxyz012345")]);
    const suffix = rejectionDiagnosticSuffix(body);
    assert.ok(!suffix.includes("abcdefghijklmnopqrstuvwxyz012345"), "bearer token must not reach the log");
});

test("an sk- API key echoed by a provider is masked", () => {
    const suffix = rejectionDiagnosticSuffix(aggregate([attempt("incorrect key sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA supplied")]));
    assert.ok(!suffix.includes("sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
});

test("a long cause is clamped, and the clamp is bounded", () => {
    const suffix = rejectionDiagnosticSuffix(aggregate([attempt("x".repeat(4000))]));
    // 300 retained chars + the ellipsis marker + the fixed prefix.
    assert.ok(suffix.length < 340, `suffix too long: ${suffix.length}`);
    assert.ok(suffix.endsWith(" …"));
});

test("an oversized body is not parsed at all", () => {
    const huge = aggregate([attempt("y".repeat(64 * 1024 + 10))]);
    assert.equal(rejectionDiagnostics(huge), undefined);
    assert.equal(rejectionDiagnosticSuffix(huge), "");
});

test("the suffix never echoes the outer narrative or the raw payload", () => {
    const body = aggregate([attempt("inner cause")], "All targets failed: secret-route-label");
    const suffix = rejectionDiagnosticSuffix(body);
    assert.ok(!suffix.includes("All targets failed"));
    assert.ok(!suffix.includes("secret-route-label"));
    assert.ok(!suffix.includes("{"), "no JSON structure may leak into the log");
});

test("reads the terminal provider cause from CCR's nested error envelope", () => {
    const body = JSON.stringify({
        error: {
            message: "All target providers failed.",
            attempts: [attempt("earlier transient error"), attempt("messages.32: tool_use has no following tool_result")],
        },
    });
    assert.equal(rejectionDiagnostics(body)?.message, "messages.32: tool_use has no following tool_result");
    assert.equal(rejectionDiagnostics(body)?.attemptIndex, 1);
});

test("terminal control bytes cannot reach the diagnostic line", () => {
    const body = aggregate([attempt("refused\u001b[2J\u0000\u007f by provider")]);
    assert.equal(rejectionDiagnostics(body)?.message, "refused [2J by provider");
});

test("the parsing budget counts UTF-8 bytes rather than UTF-16 characters", () => {
    const body = aggregate([attempt("错".repeat(24 * 1024))]);
    assert.ok(body.length < 64 * 1024);
    assert.equal(rejectionDiagnostics(body), undefined);
});
