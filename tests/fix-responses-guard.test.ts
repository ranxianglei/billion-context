import { test } from "node:test";
import assert from "node:assert/strict";
import { compressLoopResponsesJson } from "../src/compress-loop-responses.ts";
import type {
    ApplyCompressionInput,
    ApplyCompressionResult,
    CompressionCore,
    Config,
    CoreMessage,
} from "acp-kernel";
import { createCore } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { getSession } from "../src/session.ts";

test("compressLoopResponsesJson: mutatedThisTurn guard — second mutating call in a turn is a no-op", async () => {
    let applyCalls = 0;
    const baseCore = createCore();
    const applyCompression = (input: ApplyCompressionInput): ApplyCompressionResult => {
        applyCalls += 1;
        return {
            state: input.state,
            result: { blocksCreated: 0, tokensCompressed: 0, errors: [], warnings: [] },
        };
    };
    const core: CompressionCore = { ...baseCore, applyCompression };
    const session = getSession("test-guard");
    const ctx = {
        core,
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session,
        log: () => {},
    };

    let forwarded: Record<string, unknown> | undefined;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
            JSON.stringify({
                id: "resp_final",
                status: "completed",
                output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as typeof fetch;

    try {
        const initial = {
            id: "resp_two_compress",
            status: "completed",
            output: [
                {
                    type: "function_call",
                    id: "fc_c1",
                    call_id: "call_c1",
                    name: "compress",
                    arguments: JSON.stringify({ content: [{ startId: "m1", endId: "m1", summary: "first" }] }),
                },
                {
                    type: "function_call",
                    id: "fc_c2",
                    call_id: "call_c2",
                    name: "compress",
                    arguments: JSON.stringify({ content: [{ startId: "m2", endId: "m2", summary: "second" }] }),
                },
            ],
        };
        const out = await compressLoopResponsesJson(
            initial,
            ctx,
            { model: "gpt-5", input: [{ type: "message", role: "user", content: "go" }] },
            { url: "https://unused.example/responses", headers: { "content-type": "application/json" } },
        );

        assert.equal(
            applyCalls,
            1,
            "applyCompression must run exactly once — second compress is a no-op (mutatedThisTurn guard)",
        );

        assert.ok(forwarded, "upstream was re-requested with both compress markers folded in");
        const input = forwarded.input as Array<Record<string, unknown>>;
        const devMessages = input.filter((item) => item.role === "developer");
        assert.equal(devMessages.length, 2, "two developer markers (one per compress call)");

        const NO_OP = /Already compressed once this turn\. Do not compress again; generate your normal response now\./;
        assert.match(
            JSON.stringify(devMessages[1]),
            NO_OP,
            "second compress returns the no-op 'Already compressed...' message",
        );
        assert.doesNotMatch(
            JSON.stringify(devMessages[0]),
            NO_OP,
            "first compress executed for real, not the no-op",
        );

        const finalMsg = (out.output as Array<Record<string, unknown>>)[0]!;
        const part = (finalMsg.content as Array<Record<string, unknown>>)[0]!;
        assert.equal(part.text, "done");
    } finally {
        globalThis.fetch = previousFetch;
    }
});
