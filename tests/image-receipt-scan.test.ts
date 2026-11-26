import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { BiliMessage } from "acp-kernel/wire";
import { shedWireImagesToCount } from "../src/egress-shed.js";
import { applyImageRescaleItems, applyImageRescalePass } from "../src/image-rescale.js";
import { createSession } from "../src/session.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const OTHER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const RECEIPT = `Billion original image receipt v1 sha256=${createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex")}`;
type Wire = "anthropic" | "google" | "responses";

function imagePart(wire: Wire, b64: string): Record<string, unknown> {
    if (wire === "anthropic") return { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } };
    if (wire === "google") return { inlineData: { mimeType: "image/png", data: b64 } };
    return { type: "input_image", image_url: `data:image/png;base64,${b64}` };
}

function toolEntry(wire: Wire, parts: unknown[]): Record<string, unknown> {
    if (wire === "anthropic") return { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: parts }] };
    if (wire === "google") return { role: "user", parts };
    return { type: "function_call_output", call_id: "call", output: parts };
}

function wireBody(wire: Wire, outputs: unknown[][]): string {
    return JSON.stringify({ [wire === "anthropic" ? "messages" : wire === "google" ? "contents" : "input"]: outputs.map(parts => toolEntry(wire, parts)) }, null, 2);
}

for (const mode of ["anthropic", "google", "responses", "responses-items"] as const) {
    for (const count of [0, 32]) {
        test(`${mode}: receipt text reads stay bounded for ${count} images`, async t => {
            const previous = process.env.BILI_IMAGE_RESCALE;
            process.env.BILI_IMAGE_RESCALE = "1";
            t.after(() => {
                if (previous === undefined) delete process.env.BILI_IMAGE_RESCALE;
                else process.env.BILI_IMAGE_RESCALE = previous;
            });
            let reads = 0;
            const text = "ordinary tool output\n".repeat(100);
            const wire = mode === "responses-items" ? "responses" : mode;
            const parts = [
                { type: wire === "responses" ? "input_text" : "text", get text() { reads++; return text; } },
                ...Array.from({ length: count }, () => imagePart(wire, PNG)),
            ];
            const session = createSession(`receipt-scan-${mode}-${count}`);
            const ctx = { session, sessionId: session.id, log: () => {}, maxDim: 1600, toolArmed: true };
            if (mode === "responses-items") {
                const input = [toolEntry(wire, parts)];
                const before = JSON.stringify(input);
                reads = 0;
                const output = await applyImageRescaleItems(input, ctx);
                assert.ok(reads <= (count === 0 ? 0 : 4), `receipt text read ${reads} times`);
                assert.equal(JSON.stringify(output), before);
                assert.equal(JSON.stringify(input), before);
            } else {
                const message: BiliMessage = { id: "result", role: "tool", contentType: "tool-result", text: "" };
                if (wire === "anthropic") message.rawAnthropicBlock = { type: "tool_result", tool_use_id: "call", content: parts };
                else if (wire === "google") message.rawGoogleParts = parts;
                else message.rawResponsesItem = toolEntry(wire, parts);
                const input = [message];
                const before = JSON.stringify(input);
                reads = 0;
                const output = await applyImageRescalePass(input, ctx);
                assert.ok(reads <= (count === 0 ? 0 : 4), `receipt text read ${reads} times`);
                assert.equal(JSON.stringify(output), before);
                assert.equal(JSON.stringify(input), before);
            }
        });
    }
}

for (const wire of ["anthropic", "google", "responses"] as const) {
    test(`${wire}: repeated receipts protect only the matching decoded image`, async () => {
        const parts = [{ type: "text", text: `before\r\n${RECEIPT}\r\n${RECEIPT}\r\nafter` }, imagePart(wire, PNG), imagePart(wire, OTHER_PNG)];
        const result = await shedWireImagesToCount(wireBody(wire, [parts]), wire, 0);
        assert.equal(result.stats.archived, 1);
        assert.ok(result.body.includes(PNG));
        assert.ok(!result.body.includes(OTHER_PNG));
    });

    test(`${wire}: missing and malformed receipts leave images eligible`, async () => {
        for (const text of ["", RECEIPT.replace("v1", "v2"), RECEIPT.slice(0, -1), `${RECEIPT} extra`, RECEIPT.replace(/sha256=.*/, `sha256=${"0".repeat(64)}`)]) {
            const result = await shedWireImagesToCount(wireBody(wire, [[{ type: "text", text }, imagePart(wire, PNG)]]), wire, 0);
            assert.equal(result.stats.archived, 1, text);
            assert.ok(!result.body.includes(PNG), text);
        }
    });

    test(`${wire}: receipt matches do not survive output or pass boundaries`, async () => {
        const textPart = { type: "text", text: RECEIPT };
        const parts = [textPart, imagePart(wire, PNG)];
        const matched = wireBody(wire, [parts]);
        assert.equal((await shedWireImagesToCount(matched, wire, 0)).body, matched);
        textPart.text = "";
        assert.equal((await shedWireImagesToCount(wireBody(wire, [parts]), wire, 0)).stats.archived, 1);
        const separate = wireBody(wire, [[{ type: "text", text: RECEIPT }], [imagePart(wire, PNG)]]);
        assert.equal((await shedWireImagesToCount(separate, wire, 0)).stats.archived, 1);
        const textOnly = wireBody(wire, [[{ type: "text", text: RECEIPT }]]);
        assert.equal((await shedWireImagesToCount(textOnly, wire, 0)).body, textOnly);
    });
}
