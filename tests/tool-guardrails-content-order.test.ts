import assert from "node:assert/strict";
import { test } from "node:test";
import { capToolOutput, wireToolGuardrails } from "../src/agent/tool-guardrails.ts";
import type { ExtensionAPI } from "../src/agent/pi.ts";

type Part = { type: string; text?: string; [key: string]: unknown };

function toolResult(content: Part[]) {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const pi = {
        on(name: string, handler: (...args: never[]) => unknown) {
            handlers[name] = handler as (...args: unknown[]) => unknown;
        },
    } as unknown as ExtensionAPI;
    wireToolGuardrails(pi);
    const result = handlers.tool_result!({ toolName: "screenshots", toolCallId: "s1", content });
    assert.ok(result && typeof result === "object" && "content" in result && Array.isArray(result.content));
    return result.content as Part[];
}

function payload(parts: Part[]): string {
    return parts.filter(p => p.type === "text").map(p => p.text ?? "").join("\n")
        .split("\n\n[ACP guardrail:")[0]!;
}

test("registered tool_result guardrail keeps captions before their images at the default cap", () => {
    const before = { type: "image", data: "before", mimeType: "image/png" };
    const after = { type: "image", data: "after", mimeType: "image/png" };
    const annotations = { audience: ["assistant"] };
    const content = [
        { type: "text", text: "Before screenshot:", annotations }, before,
        { type: "text", text: "After screenshot: " + "x".repeat(60_000), annotations }, after,
    ];
    const original = structuredClone(content);
    const result = toolResult(content);
    assert.deepEqual(result.map(p => p.type), ["text", "image", "text", "image"]);
    assert.equal(result[0]?.text, "Before screenshot:");
    assert.ok(result[2]?.text?.startsWith("After screenshot: "));
    assert.equal(result[1], before);
    assert.equal(result[3], after);
    assert.equal(result[0]?.annotations, annotations);
    assert.equal(result[2]?.annotations, annotations);
    assert.equal(Buffer.byteLength(payload(result)), 50_000);
    assert.deepEqual(content, original);
});

test("a shared byte cap preserves UTF-8 across interleaved parts", () => {
    const image = { type: "image", data: "preview" };
    const result = capToolOutput([
        { type: "text", text: "X" }, image, { type: "text", text: "你好".repeat(10) },
    ], 12)!;
    assert.deepEqual(result.map(p => p.type), ["text", "image", "text"]);
    assert.equal(result[1], image);
    assert.equal(payload(result), "X\n你好你");
    assert.ok(Buffer.byteLength(payload(result)) <= 12);
    assert.ok(!payload(result).includes("\uFFFD"));
});

test("truncating an early part keeps later opaque blocks in their original order", () => {
    const image = { type: "image", data: "image" };
    const resource = { type: "resource", uri: "memory://example" };
    const result = capToolOutput([
        { type: "text", text: "a".repeat(40) }, image,
        { type: "text", text: "omitted" }, resource,
    ], 10, "/tmp/tool-output.txt")!;
    assert.deepEqual(result.map(p => p.type), ["text", "image", "resource"]);
    assert.equal(result[1], image);
    assert.equal(result[2], resource);
    assert.equal(payload(result), "a".repeat(10));
    assert.match(result[0]!.text!, /Full output saved to: \/tmp\/tool-output\.txt/);
});

test("an empty retained prefix anchors its notice at the first text position", () => {
    const image = { type: "image", data: "image" };
    const result = capToolOutput([
        { type: "text", text: "你", annotations: { priority: 1 } }, image,
        { type: "text", text: "omitted" },
    ], 1)!;
    assert.deepEqual(result.map(p => p.type), ["text", "image"]);
    assert.equal(payload(result), "");
    assert.deepEqual(result[0]?.annotations, { priority: 1 });
    assert.equal(result[1], image);
    assert.match(result[0]!.text!, /output capped at 1B/);
});

test("complete-line preference retains separate text parts and their metadata", () => {
    const result = capToolOutput([
        { type: "text", text: "ab", label: "first" },
        { type: "text", text: "cd", label: "second" },
        { type: "text", text: "long tail", label: "third" },
    ], 8)!;
    assert.equal(payload(result), "ab\ncd");
    assert.deepEqual(result.map(p => p.label), ["first", "second"]);
    assert.equal(result.filter(p => p.text?.includes("[ACP guardrail:")).length, 1);
});

test("small output, disabled limits and text-free output remain untouched", () => {
    const content = [{ type: "text", text: "caption" }, { type: "image", data: "image" }];
    assert.equal(capToolOutput(content, 100), undefined);
    assert.equal(capToolOutput(content, 0), undefined);
    assert.equal(capToolOutput(content.slice(1), 1), undefined);
});
