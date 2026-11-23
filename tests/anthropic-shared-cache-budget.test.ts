import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInitialState } from "acp-kernel";
import { anthropicToCore, coreToAnthropic, type AnthropicRequestBody } from "acp-kernel/wire";
import {
    anthropicSystemCacheControlCount,
    anthropicToolsCacheControlCount,
    anthropicToolsCarryCacheControl,
    computeAnthropicMessageMarks,
    stampAnthropicSystemCacheControl,
    stampSystemWithinAnthropicBudget,
} from "../src/loop/cache-control.js";
import type { Session } from "../src/session.js";

function makeSession(id: string): Session {
    return {
        id,
        metadata: {},
        stats: {},
        state: createInitialState(),
    } as unknown as Session;
}

describe("Anthropic shared 4-breakpoint cache budget", () => {
    it("computeAnthropicMessageMarks skips unmarkable trailing reasoning blocks and coreToAnthropic applies bili cache_control marks on rawAnthropicBlock messages", () => {
        const session = makeSession("test-skip-reasoning-and-raw-block");
        const parsed: AnthropicRequestBody = {
            model: "claude-opus-4-6",
            max_tokens: 4096,
            system: [{ type: "text", text: "System prompt (~19.5K with tools)" }],
            tools: [{ name: "bash", description: "run bash", input_schema: { type: "object" } }],
            messages: [
                { role: "user", content: [{ type: "text", text: "[Compressed b1 summary]" }] },
                { role: "assistant", content: [{ type: "text", text: "Ack b1" }, { type: "thinking", thinking: "trailing thinking", signature: "sig1" }] },
            ],
        };

        const converted = anthropicToCore(parsed);
        const processedMessages = converted.msgs;
        assert.equal(converted.cacheControls.size, 0);
        assert.equal(anthropicToolsCarryCacheControl(parsed.tools), false);

        const marks = computeAnthropicMessageMarks(processedMessages as { id?: string; contentType?: string }[], 0, session);
        assert.ok(marks && marks.size > 0, "Expected computeAnthropicMessageMarks to skip trailing reasoning and mark the preceding markable message");

        const wire = coreToAnthropic(processedMessages, marks);
        const markedBlocks = wire.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => Boolean((b as { cache_control?: unknown }).cache_control));
        assert.equal(markedBlocks.length, 1, "Expected coreToAnthropic to stamp cache_control onto the marked message even when rawAnthropicBlock is present");
    });

    it("shared 4-breakpoint budget preserves pre-fold stable prefix anchors when client marks only trailing message blocks", () => {
        const session = makeSession("test-shared-budget-sticky-anchor");
        const parsed1: AnthropicRequestBody = {
            model: "claude-opus-4-6",
            max_tokens: 4096,
            system: [
                { type: "text", text: "System prompt (~19.7K)", cache_control: { type: "ephemeral" } },
                { type: "text", text: "ACP instructions" },
            ],
            tools: [{ name: "bash", description: "run bash", input_schema: { type: "object" } }],
            messages: [
                { role: "user", content: [{ type: "text", text: "u1 stable head" }] },
                { role: "assistant", content: [{ type: "text", text: "a1 stable prefix" }] },
                { role: "user", content: [{ type: "text", text: "u2 stable prefix before fold" }] },
                { role: "assistant", content: [{ type: "text", text: "a2 tail turn", cache_control: { type: "ephemeral" } }] },
                { role: "user", content: [{ type: "text", text: "u3 latest user turn", cache_control: { type: "ephemeral" } }] },
            ],
        };

        const conv1 = anthropicToCore(parsed1);
        const sysMarks1 = anthropicSystemCacheControlCount(parsed1.system);
        const toolMarks1 = anthropicToolsCacheControlCount(parsed1.tools);
        assert.equal(sysMarks1, 1);
        assert.equal(toolMarks1, 0);
        assert.equal(conv1.cacheControls.size, 2);

        const marks1 = computeAnthropicMessageMarks(
            conv1.msgs as { id?: string; contentType?: string }[],
            0,
            session,
            conv1.cacheControls,
            sysMarks1 + toolMarks1,
        );
        assert.ok(marks1, "Expected merged marks map");
        assert.equal(marks1.size, 3, "Expected 2 client marks + 1 bili stable-prefix anchor");
        assert.ok(marks1.has(conv1.msgs[2]!.id), "Expected bili anchor immediately before earliest client-marked message");

        const sysOut1 = stampSystemWithinAnthropicBudget(parsed1.system, parsed1.tools, parsed1.system, marks1, true);
        const sysOutMarks1 = Array.isArray(sysOut1) ? sysOut1.filter((b) => Boolean(b.cache_control)).length : 0;
        const wire1 = coreToAnthropic(conv1.msgs, marks1);
        const wireMsgMarks1 = wire1.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => Boolean((b as { cache_control?: unknown }).cache_control)).length;
        assert.equal(sysOutMarks1 + toolMarks1 + wireMsgMarks1, 4, "Total WC-010 breakpoints must equal 4 and never exceed 4");

        const parsed2: AnthropicRequestBody = {
            ...parsed1,
            messages: [
                parsed1.messages[0]!,
                parsed1.messages[1]!,
                parsed1.messages[2]!,
                { role: "assistant", content: [{ type: "text", text: "a3 post-fold response", cache_control: { type: "ephemeral" } }] },
                { role: "user", content: [{ type: "text", text: "u4 post-fold follow-up", cache_control: { type: "ephemeral" } }] },
            ],
        };
        const conv2 = anthropicToCore(parsed2);
        const marks2 = computeAnthropicMessageMarks(
            conv2.msgs as { id?: string; contentType?: string }[],
            0,
            session,
            conv2.cacheControls,
            sysMarks1 + toolMarks1,
        );
        assert.ok(marks2?.has(conv2.msgs[2]!.id), "Pre-fold sticky anchor must survive across the fold");
        const wire2 = coreToAnthropic(conv2.msgs, marks2);
        assert.deepEqual(wire2.slice(0, 3), wire1.slice(0, 3), "Stable prefix messages 0..2 must be byte-identical across the fold");

        // Verify global-scope suppression via shared helper.
        const globalSystem: AnthropicRequestBody["system"] = [{ type: "text", text: "Sys", cache_control: { type: "ephemeral", scope: "global" } as unknown as { type: "ephemeral" } }];
        const unstamped = stampSystemWithinAnthropicBudget([{ type: "text", text: "Sys" }], parsed1.tools, globalSystem, marks1, true);
        assert.equal(Array.isArray(unstamped) && unstamped.some((b) => Boolean(b.cache_control)), false);
        assert.equal((stampAnthropicSystemCacheControl([{ type: "text", text: "Sys" }], true, 0) as { cache_control?: unknown }[])[0]?.cache_control, undefined);
    });
});
