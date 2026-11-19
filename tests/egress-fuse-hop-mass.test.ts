import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";
import { measuredOutbound } from "../src/server.ts";

// #7013: DSH ships hop-only transport fields (its session-log envelope and plugin
// ledger) inside the model request body. The raw walk counted them as prompt
// mass, so the egress window fuse refused sends whose real prompt fit the window
// (`other ~1,597,576` against a 1,048,576 window while messages[] was ~212K).
const ledger = { version: 1, packages: [{ name: "dsh", version: "0.2.2-rc.3" }] };
const envelope = { version: 1, sessionFormatVersion: 4, afterSeq: 0, throughSeq: 5152, events: [{ text: "L".repeat(2_000_000) }] };

test("estimateRawBodyBreakdown: host transport fields are hop mass, not prompt mass (#7013)", () => {
    const body = {
        model: "deepseek-flash",
        system: "s".repeat(1_000),
        messages: [{ role: "user", content: "m".repeat(1_000) }],
        dsh_session_log: envelope,
        dsh_plugin_packages: ledger,
    };
    const b = estimateRawBodyBreakdown(body);
    assert.equal(b.hop, estimateRawBodyTokens(envelope) + estimateRawBodyTokens(ledger), "hop mass is exactly the transport fields");
    assert.equal(b.total, estimateRawBodyTokens(body), "raw meter unchanged: total still counts every leaf");
    assert.equal(b.total, b.messages + b.tools + b.system + b.other, "buckets stay exhaustive — hop lives inside other");
    assert.ok(b.hop > 400_000, "the 2 MB envelope is real mass");
    assert.equal(b.promptTotal, b.total - b.hop, "promptTotal removes exactly the hop mass");
    assert.ok(b.promptTotal < 1_000, "what the model reads stays tiny");

    // NEGATIVE: a permitlist must not swallow prompt text. The same key NESTED
    // inside messages[] is content the model reads, not hop mass.
    const nested = estimateRawBodyBreakdown({ messages: [{ role: "user", content: "c", dsh_session_log: "y".repeat(2_000) }] });
    assert.equal(nested.hop, 0, "only TOP-LEVEL transport fields are hop mass");
    assert.ok(nested.messages > 0, "nested text still lands in the messages bucket");
    assert.equal(nested.promptTotal, nested.total, "nothing is removed when the key is not top-level");
});

test("measuredOutbound: the gate prices prompt mass, so a hop-heavy body forwards (#7013)", () => {
    const body = JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], dsh_session_log: envelope });
    const measured = measuredOutbound({ body });
    assert.ok(measured, "JSON body measures");
    assert.ok(measured!.tokens < 1_000, "gate sees prompt mass");
    assert.ok(measured!.breakdown.total > 400_000, "raw meter still sees the envelope");
});
