import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";

// #2405(b): a relay that stamps finish_reason:"" on EVERY non-terminal chunk
// made the plugin pipe treat every event as terminal. The per-event tail fold
// then released each held render-tag fragment the instant it arrived, so the
// tag-echo state machine never accumulated a complete tag and stripping
// silently never happened (the 29,462-char summary leak). An empty value must
// count as ABSENT, not terminal.

const LT = "\x3c";
const GT = "\x3e";
const TAG = `${LT}acp tokens="2" type="text"${GT}m00045${LT}/acp${GT}`;
const T1 = `${LT}acp tokens=`;
const T2 = `"2" type="text">${"m000"}`;
const T3 = `45${LT}/acp${GT}`;

function makeSession(id: string, protocol: string): Session {
    return {
        id,
        protocol,
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

function dataLines(raw: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const d = line.slice(6);
        if (d === "[DONE]") continue;
        out.push(JSON.parse(d) as Record<string, unknown>);
    }
    return out;
}

function openaiContent(raw: string): string {
    let s = "";
    for (const ev of dataLines(raw)) {
        const choices = ev["choices"];
        if (!Array.isArray(choices)) continue;
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta && typeof delta["content"] === "string") s += delta["content"];
    }
    return s;
}

function googleText(raw: string): string {
    let s = "";
    for (const ev of dataLines(raw)) {
        const candidates = ev["candidates"];
        if (!Array.isArray(candidates)) continue;
        const c0 = (candidates[0] ?? {}) as Record<string, unknown>;
        const content = c0["content"] as Record<string, unknown> | undefined;
        const parts = content ? content["parts"] : undefined;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
            if (p && typeof p === "object" && typeof (p as Record<string, unknown>)["text"] === "string") {
                s += (p as Record<string, unknown>)["text"] as string;
            }
        }
    }
    return s;
}

function acpOpens(text: string): number {
    const m = text.match(new RegExp(`${LT}(?:acp|apc|cap|cpa|pac|pca)[\\s>]`, "g"));
    return m ? m.length : 0;
}

function oc(delta: Record<string, unknown>, fr: string | null): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-eft", object: "chat.completion.chunk", created: 1, model: "relay-test", choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
}

function gc(text: string | undefined, fr: string): string {
    const parts: Array<Record<string, unknown>> = [];
    if (text !== undefined) parts.push({ text });
    return `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts }, finishReason: fr }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

test("openai chat: relay-stamped empty finish_reason must not disable render-tag stripping (#2405)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            oc({ role: "assistant", content: "Hello " }, ""),
            oc({ content: T1 }, ""),
            oc({ content: T2 }, ""),
            oc({ content: T3 }, ""),
            oc({ content: " world" }, ""),
            oc({}, "stop"),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-eft-o1", "openai"));
    } finally {
        setLogCapture(null);
    }
    const content = openaiContent(out.join(""));
    assert.equal(acpOpens(content), 0, `render tag survived an empty-finish_reason stream: ${JSON.stringify(content)}`);
    assert.ok(!content.includes("m00045"), "tag body leaked into client-visible text");
    assert.ok(content.startsWith("Hello") && content.endsWith("world"), `prose lost: ${JSON.stringify(content)}`);
    assert.ok(
        logs.some((l) => l.includes("[tag-echo]") && l.includes("stripped")),
        `expected a strip record, got: ${logs.join(" | ")}`,
    );
    const terminal = [...dataLines(out.join(""))].reverse().find((ev) => {
        const choices = ev["choices"];
        return Array.isArray(choices) && (choices[0] as Record<string, unknown> | null)?.["finish_reason"] === "stop";
    });
    assert.ok(terminal, "the real finish_reason:stop frame must reach the client");
});

test("openai chat: normal null finish_reason stream still strips (control) (#2405)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            oc({ role: "assistant", content: "Hello " }, null),
            oc({ content: T1 }, null),
            oc({ content: T2 }, null),
            oc({ content: T3 }, null),
            oc({ content: " world" }, null),
            oc({}, "stop"),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-eft-o2", "openai"));
    } finally {
        setLogCapture(null);
    }
    const content = openaiContent(out.join(""));
    assert.equal(acpOpens(content), 0, `render tag survived a normal stream: ${JSON.stringify(content)}`);
    assert.ok(!content.includes("m00045"), "tag body leaked into client-visible text");
    assert.ok(logs.some((l) => l.includes("[tag-echo]") && l.includes("stripped")), "strip record expected");
});

test("google: relay-stamped empty finishReason must not disable render-tag stripping (#2405)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            gc("Hello ", ""),
            gc(T1, ""),
            gc(T2, ""),
            gc(T3, ""),
            gc(" world", ""),
            gc(undefined, "STOP"),
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "google", makeSession("sess-eft-g1", "google"));
    } finally {
        setLogCapture(null);
    }
    const text = googleText(out.join(""));
    assert.equal(acpOpens(text), 0, `render tag survived an empty-finishReason stream: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("m00045"), "tag body leaked into client-visible text");
    assert.ok(text.startsWith("Hello") && text.endsWith("world"), `prose lost: ${JSON.stringify(text)}`);
    assert.ok(
        logs.some((l) => l.includes("[tag-echo]") && l.includes("stripped")),
        `expected a strip record, got: ${logs.join(" | ")}`,
    );
});
