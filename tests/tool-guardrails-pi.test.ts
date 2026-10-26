import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resolveBashTimeout,
    capToolOutput,
    detectBashTimeout,
    appendTimeoutNotice,
    isBashToolResult,
    wireToolGuardrails,
    canonicalStringify,
    repetitionFingerprint,
    RepetitionTracker,
    type GuardrailOptions,
} from "../src/agent/tool-guardrails.ts";
import type { ExtensionAPI } from "../src/agent/pi.ts";
import { guardrailBashTimeout } from "../src/knobs.ts";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

type TextPart = { type: "text"; text: string };
type NonTextPart = { type: string } & Record<string, unknown>;
type Content = Array<TextPart | NonTextPart>;
const text = (t: string): Content => [{ type: "text", text: t }];

test("resolveBashTimeout returns undefined when the model already set a timeout", () => {
    assert.equal(resolveBashTimeout({ timeout: 30 }, 60), undefined);
});

test("resolveBashTimeout injects the default when the model omitted timeout", () => {
    assert.equal(resolveBashTimeout({}, 60), 60);
    assert.equal(resolveBashTimeout({ timeout: undefined }, 60), 60);
});

test("resolveBashTimeout returns undefined when the default is disabled (0 / negative / NaN)", () => {
    assert.equal(resolveBashTimeout({}, 0), undefined);
    assert.equal(resolveBashTimeout({}, -5), undefined);
    assert.equal(resolveBashTimeout({}, Number.NaN), undefined);
});

test("resolveBashTimeout does NOT inject when the default is undefined (no built-in fallback, #3331)", () => {
    assert.equal(resolveBashTimeout({}, undefined), undefined);
    assert.equal(resolveBashTimeout({ timeout: undefined }, undefined), undefined);
});

test("capToolOutput leaves small output untouched (returns undefined)", () => {
    assert.equal(capToolOutput(text("hello"), 100), undefined);
});

test("capToolOutput returns undefined when the cap is disabled", () => {
    assert.equal(capToolOutput(text("x".repeat(10_000)), 0), undefined);
    assert.equal(capToolOutput(text("x".repeat(10_000)), undefined), undefined);
});

test("capToolOutput truncates oversized text to under the byte cap and adds a notice", () => {
    const big = "line\n".repeat(4000);
    const out = capToolOutput(text(big), 500);
    assert.ok(out, "should return truncated content");
    const t = (out![0] as TextPart).text;
    assert.ok(Buffer.byteLength(t, "utf8") <= 500 + 200, "truncated payload must be near the cap (notice adds a little)");
    assert.match(t, /ACP guardrail/);
    assert.match(t, /dropped/);
});

test("capToolOutput keeps a complete last line (no mid-line cut)", () => {
    const big = "0123456789\n".repeat(2000);
    const out = capToolOutput(text(big), 100);
    const t = (out![0] as TextPart).text;
    const body = t.split("\n\n[ACP guardrail")[0];
    for (const line of body.split("\n")) {
        assert.ok(line.length === 0 || line.length === 10, "no partial line: " + JSON.stringify(line));
    }
});

test("capToolOutput mentions the saved full-output path for bash-style results", () => {
    const big = "x".repeat(10_000);
    const out = capToolOutput(text(big), 500, "/tmp/acp-full.log");
    const t = (out![0] as TextPart).text;
    assert.match(t, /\/tmp\/acp-full\.log/);
});

test("capToolOutput preserves non-text (image) content alongside truncated text", () => {
    const img: NonTextPart = { type: "image", source: { media_type: "image/png", data: "AAAA" } };
    const content: Content = [{ type: "text", text: "x".repeat(10_000) }, img];
    const out = capToolOutput(content, 500);
    assert.ok(out);
    assert.equal(out!.some((c) => c.type === "image"), true, "image part must survive");
    assert.equal(out!.some((c) => c.type === "text"), true, "truncated text part must be present");
});

test("capToolOutput is UTF-8 safe (never splits a multibyte sequence)", () => {
    const big = "中文测试\n".repeat(3000);
    const out = capToolOutput(text(big), 200);
    const t = (out![0] as TextPart).text;
    const body = t.split("\n\n[ACP guardrail")[0];
    const buf = Buffer.from(body, "utf8");
    let i = 0;
    while (i < buf.length) {
        const b = buf[i];
        const size = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
        assert.ok(i + size <= buf.length, "no truncated multibyte sequence at byte " + i);
        i += size;
    }
});

test("detectBashTimeout extracts the seconds from Pi's timeout error text", () => {
    assert.equal(detectBashTimeout(text("Command timed out after 60 seconds")), 60);
    assert.equal(detectBashTimeout(text("partial output\nCommand timed out after 300 seconds")), 300);
});

test("detectBashTimeout returns undefined when there is no timeout error", () => {
    assert.equal(detectBashTimeout(text("Command aborted")), undefined);
    assert.equal(detectBashTimeout(text("no error here")), undefined);
    assert.equal(detectBashTimeout([]), undefined);
});

test("appendTimeoutNotice appends actionable guidance to the last text part", () => {
    const out = appendTimeoutNotice(text("Command timed out after 60 seconds"), 60);
    assert.equal(out.length, 1);
    const t = (out[0] as TextPart).text;
    assert.match(t, /killed after 60s/);
    assert.match(t, /\`timeout\`/);
    assert.match(t, /"timeout": 120/);
});

test("appendTimeoutNotice suggests a larger timeout that scales with the kill time", () => {
    const out = appendTimeoutNotice(text("Command timed out after 300 seconds"), 300);
    const t = (out[0] as TextPart).text;
    assert.match(t, /"timeout": 600/);
});

test("appendTimeoutNotice adds a new text part when content has no text part", () => {
    const img: NonTextPart = { type: "image", source: { media_type: "image/png", data: "AAAA" } };
    const out = appendTimeoutNotice([img], 30);
    assert.equal(out.length, 2);
    assert.equal(out[1].type, "text");
});

test("isBashToolResult narrows by toolName and exposes bash details (vendored guard, host-agnostic)", () => {
    const bash = { toolName: "bash", toolCallId: "b1", content: text("ok"), isError: false, details: { fullOutputPath: "/tmp/x" } };
    const other = { toolName: "read", toolCallId: "r1", content: text("ok"), isError: false };
    assert.equal(isBashToolResult(bash), true);
    assert.equal(isBashToolResult(other), false);
    if (isBashToolResult(bash)) {
        assert.equal(bash.details?.fullOutputPath, "/tmp/x");
    }
});

// --- wiring: the default-application contract (issue #210) ---

function wireFor(opts: GuardrailOptions = {}) {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const pi = {
        on: (name: string, fn: (...a: never[]) => unknown) => {
            handlers[name] = fn as (...a: unknown[]) => unknown;
        },
    } as unknown as ExtensionAPI;
    wireToolGuardrails(pi, opts);
    return (event: unknown) => handlers["tool_result"]!(event);
}

const readResult = (t: string) => ({ toolName: "read", content: text(t), isError: false });

function textOf(part: unknown): string {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
    }
    throw new Error("expected a text content part");
}

test("wireToolGuardrails applies the documented 50KB default when maxBytes is unset", () => {
    const onResult = wireFor();
    const ret = onResult(readResult("x".repeat(300 * 1024)));
    assert.ok(ret && typeof ret === "object" && "content" in ret && Array.isArray(ret.content),
        "oversized output must be capped even with no explicit config");
    const t = textOf(ret.content[0]);
    assert.match(t, /\[ACP guardrail/);
    assert.ok(Buffer.byteLength(t, "utf8") < 60 * 1024, "payload must be truncated near the 50KB default");
});

test("wireToolGuardrails is pass-through: no opts means NO injection (the 60s default lives in guardrailBashTimeout so 0 can disable end-to-end)", () => {
    const w = wireRepetition();
    const call = { toolName: "bash", toolCallId: "b1", input: { command: "npm install" } as { command: string; timeout?: number } };
    w.call(call);
    assert.equal(call.input.timeout, undefined, "wireToolGuardrails itself must not re-default — knobs own the default");
});
test("pi lane end-to-end: guardrailBashTimeout() default injects 60 (#3066 anti-hang), 0 disables", () => {
    assert.equal(guardrailBashTimeout(), 60, "#3066 owner default — unsupervised bash hung pi sessions for a day");
    withEnv({ BILI_GUARDRAIL_BASH_TIMEOUT: "0" }, () => {
        assert.equal(guardrailBashTimeout(), undefined, "0 = pi-native no injection");
    });
    const w = wireRepetition({ bashTimeout: guardrailBashTimeout() });
    const call = { toolName: "bash", toolCallId: "b1", input: { command: "npm install" } as { command: string; timeout?: number } };
    w.call(call);
    assert.equal(call.input.timeout, 60);
});

test("wireToolGuardrails injects the configured bashTimeout when the model omitted timeout", () => {
    const w = wireRepetition({ bashTimeout: 90 });
    const call = { toolName: "bash", toolCallId: "b1", input: { command: "npm install" } as { command: string; timeout?: number } };
    w.call(call);
    assert.equal(call.input.timeout, 90);
});

test("wireToolGuardrails never overrides an explicit per-call timeout", () => {
    const w = wireRepetition({ bashTimeout: 90 });
    const call = { toolName: "bash", toolCallId: "b2", input: { command: "sleep", timeout: 600 } };
    w.call(call);
    assert.equal(call.input.timeout, 600);
});

test("wireToolGuardrails keeps an explicit maxBytes: 0 as disable", () => {
    const onResult = wireFor({ maxBytes: 0 });
    assert.equal(onResult(readResult("x".repeat(300 * 1024))), undefined);
});

test("wireToolGuardrails honors an explicit smaller cap", () => {
    const onResult = wireFor({ maxBytes: 1000 });
    const ret = onResult(readResult("x".repeat(10_000)));
    assert.ok(ret && typeof ret === "object" && "content" in ret && Array.isArray(ret.content));
    const t = textOf(ret.content[0]);
    assert.ok(Buffer.byteLength(t, "utf8") < 2000, "payload must be truncated to the explicit cap");
});

// --- generic tool-call repetition guard (issue #308) ---

test("canonicalStringify is key-order independent for objects", () => {
    assert.equal(canonicalStringify({ a: 1, b: 2 }), canonicalStringify({ b: 2, a: 1 }));
});

test("canonicalStringify preserves array order (arrays are ordered)", () => {
    assert.notEqual(canonicalStringify([1, 2]), canonicalStringify([2, 1]));
});

test("canonicalStringify recurses into nested objects and drops undefined values", () => {
    assert.equal(
        canonicalStringify({ x: { p: 1, q: 2 }, y: 3 }),
        canonicalStringify({ y: 3, x: { q: 2, p: 1 } }),
    );
    assert.equal(canonicalStringify({ a: 1, b: undefined }), canonicalStringify({ a: 1 }));
});

test("repetitionFingerprint is stable across argument key order", () => {
    assert.equal(
        repetitionFingerprint("acp_status", { scope: "uncompressed", view: "ranges" }),
        repetitionFingerprint("acp_status", { view: "ranges", scope: "uncompressed" }),
    );
});

test("repetitionFingerprint changes when any argument differs", () => {
    const base = repetitionFingerprint("acp_status", { scope: "uncompressed", view: "ranges" });
    assert.notEqual(base, repetitionFingerprint("acp_status", { scope: "uncompressed", view: "messages" }));
    assert.notEqual(base, repetitionFingerprint("acp_status", {}));
});

test("repetitionFingerprint distinguishes different tools with identical args", () => {
    assert.notEqual(repetitionFingerprint("read", { path: "/x" }), repetitionFingerprint("bash", { path: "/x" }));
});

test("RepetitionTracker escalates none -> warn -> abort by consecutive count", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    assert.equal(t.note("x", {}).action, "none");
    assert.equal(t.note("x", {}).action, "none");
    assert.equal(t.note("x", {}).action, "warn");
    assert.equal(t.note("x", {}).action, "warn");
    assert.equal(t.note("x", {}).action, "abort");
    assert.equal(t.note("x", {}).action, "abort");
});

test("RepetitionTracker resets on a different fingerprint (args or tool name)", () => {
    const t = new RepetitionTracker({ warn: 2, abort: 99 });
    t.note("x", { a: 1 });
    t.note("x", { a: 1 });
    assert.equal(t.note("x", { a: 2 }).action, "none");
    assert.equal(t.note("y", { a: 1 }).action, "none");
});

test("RepetitionTracker.reset() clears the run", () => {
    const t = new RepetitionTracker({ warn: 2, abort: 3 });
    t.note("x", {});
    t.note("x", {});
    t.reset();
    assert.equal(t.note("x", {}).action, "none");
});

function makeRepCtx(sid = "sess-rep") {
    const ctx = {
        ui: { notify: () => {} },
        abortCalls: 0,
        sessionManager: { getSessionId: () => sid },
        abort: () => {
            ctx.abortCalls += 1;
        },
    };
    return ctx;
}

function wireRepetition(opts: GuardrailOptions = {}) {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const pi = {
        on: (name: string, fn: (...a: never[]) => unknown) => {
            handlers[name] = fn as (...a: unknown[]) => unknown;
        },
    } as unknown as ExtensionAPI;
    const ctx = makeRepCtx();
    wireToolGuardrails(pi, opts);
    return {
        call: (event: unknown) => handlers["tool_call"]!(event, ctx),
        result: (event: unknown) => handlers["tool_result"]!(event),
        input: (source: string) => handlers["input"]!({ source }, ctx),
        shutdown: () => handlers["session_shutdown"]!({}, ctx),
        ctx,
    };
}

const statusCall = (id: string) => ({ type: "tool_call", toolName: "acp_status", toolCallId: id, input: { scope: "uncompressed", view: "ranges" } });

const statusResult = (id: string) => ({ toolName: "acp_status", toolCallId: id, content: text("status ok"), isError: false });

const hasContent = (ret: unknown): ret is { content: Content } =>
    !!ret && typeof ret === "object" && "content" in ret;

test("repetition guard queues a warning at warn=3 (default) without blocking", () => {
    const w = wireRepetition();
    assert.equal(w.call(statusCall("c1")), undefined);
    assert.equal(w.call(statusCall("c2")), undefined);
    assert.equal(w.call(statusCall("c3")), undefined, "warn threshold must not block");
    const res = w.result(statusResult("c3"));
    assert.ok(hasContent(res), "warned result must be modified");
    const t = textOf(res.content[0]);
    assert.match(t, /CONSECUTIVE identical/);
    assert.match(t, /acp_status/);
});

test("repetition guard blocks and aborts at abort=5 (default)", () => {
    const w = wireRepetition();
    for (const id of ["k1", "k2", "k3", "k4"]) {
        assert.equal(w.call(statusCall(id)), undefined, "below abort must not block");
    }
    const fifth = w.call(statusCall("k5")) as { block?: boolean; reason?: string };
    assert.equal(fifth?.block, true, "5th identical call must be blocked");
    assert.match(fifth?.reason ?? "", /BLOCKED/);
    assert.equal(w.ctx.abortCalls, 1, "turn must be aborted exactly once");
    const sixth = w.call(statusCall("k6")) as { block?: boolean };
    assert.equal(sixth?.block, true, "still blocked after abort");
});

test("repetition guard resets the run when arguments change", () => {
    const w = wireRepetition();
    const other = { type: "tool_call", toolName: "acp_status", toolCallId: "x", input: { scope: "compressed" } };
    w.call(statusCall("r1"));
    w.call(statusCall("r2"));
    w.call(other);
    w.call(statusCall("r3"));
    w.call(statusCall("r4"));
    assert.equal(w.result(statusResult("r4")), undefined, "only 2 consecutive identical -> no warning yet");
    w.call(statusCall("r5"));
    const res5 = w.result(statusResult("r5"));
    assert.ok(hasContent(res5), "3rd consecutive identical -> warning");
});

test("repetition guard run resets on real user input but not extension-sent input", () => {
    const w = wireRepetition();
    w.call(statusCall("u1"));
    w.call(statusCall("u2"));
    w.input("interactive");
    w.call(statusCall("u3"));
    w.call(statusCall("u4"));
    assert.equal(w.result(statusResult("u4")), undefined, "after user-input reset, only 2 consecutive -> no warning");
    w.input("extension");
    w.call(statusCall("u5"));
    const res5 = w.result(statusResult("u5"));
    assert.ok(hasContent(res5), "extension-sent input must not reset the run");
});

test("repetition guard is fully inert when repetition is disabled", () => {
    const w = wireRepetition({ repetition: false });
    for (let i = 1; i <= 6; i++) {
        assert.equal(w.call(statusCall(`d${i}`)), undefined, `identical call ${i} must not be blocked when disabled`);
    }
    assert.equal(w.ctx.abortCalls, 0, "never aborts when disabled");
});

test("repetition guard honors custom warn/abort thresholds", () => {
    const w = wireRepetition({ repetition: { warn: 2, abort: 3 } });
    assert.equal(w.call(statusCall("t1")), undefined);
    assert.equal(w.call(statusCall("t2")), undefined);
    const res2 = w.result(statusResult("t2"));
    assert.ok(hasContent(res2), "warn fires at custom warn=2");
    const third = w.call(statusCall("t3")) as { block?: boolean };
    assert.equal(third?.block, true, "abort fires at custom abort=3");
});

test("#3170: all three ctx handlers tolerate a missing ctx (no throw, block still enforced)", () => {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const pi = {
        on: (name: string, fn: (...a: never[]) => unknown) => {
            handlers[name] = fn as (...a: unknown[]) => unknown;
        },
    } as unknown as ExtensionAPI;
    wireToolGuardrails(pi);
    let ret: unknown;
    for (let i = 1; i <= 5; i++) {
        ret = handlers["tool_call"]!(statusCall(`u${i}`), undefined);
    }
    assert.equal((ret as { block?: boolean })?.block, true, "5th identical call must still be blocked without a ctx");
    assert.doesNotThrow(() => handlers["input"]!({ source: "interactive" }, undefined));
    assert.doesNotThrow(() => handlers["session_shutdown"]!({}, undefined));
});
