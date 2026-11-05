// #3909: an image-dense session on the plain/proxy/pi-native HTTP relay lane forwards tens of MiB
// of base64 every round; the upstream rejects on raw bytes / pixel-decode CPU (Cloudflare Worker
// 503) while token-space folding stays below its trigger, so every retry resends the same pixels
// and the session is permanently dead. This suite pins the byte-space backstop for that lane:
// pre-send shedding against network.httpOutboundBytes applies ONLY when no managed transport is
// installed (global fetch), never to a managed-but-not-WS transport (#3701 Finding 1 — dsh-inline /
// inline-engine deliver large bodies fine), and never leaks into the WS lane's own budget.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { shedEgressIfOverBudget } from "../src/egress-shed.ts";
import { markWsLaneTransport, withFetchTransport } from "../src/fetch-transport.ts";
import { createSession } from "../src/session.ts";

type Item = Record<string, unknown>;

/** Incompressible-noise base64 blob (~rawBytes of payload → ~4/3 rawBytes of base64). jimp cannot
 *  decode it, so rung B yields null and only rung A (archive) reduces the size — predictable math. */
function fakeB64(seed: number, rawBytes = 150_000): string {
    const buf = Buffer.alloc(rawBytes);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + seed * 7) % 256;
    return buf.toString("base64");
}

const userImage = (text: string, b64: string): Item => ({
    type: "message",
    role: "user",
    content: [
        { type: "input_text", text },
        { type: "input_image", image_url: `data:image/png;base64,${b64}` },
    ],
});

// 12 x ~200 KiB of base64 ≈ 2.4 MiB — over a small budget, under the 10 MiB default.
const bigBody = (): string => {
    const input: Item[] = [];
    for (let i = 0; i < 12; i++) input.push(userImage(`image ${i}`, fakeB64(i + 1)));
    return JSON.stringify({ model: "m", input });
};

test("#3909 shedEgressIfOverBudget: plain relay (no transport) sheds against httpOutboundBytes", async () => {
    const session = createSession(`http-shed-${randomUUID()}`);
    const big = bigBody();
    process.env.BILI_HTTP_OUTBOUND_BYTES = String(1_000_000);
    try {
        const logs: string[] = [];
        // No withFetchTransport wrapper → currentFetchTransport() === undefined → plain/proxy/pi-native
        // relay lane → governed by network.httpOutboundBytes.
        const out = await shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session, log: (level, msg) => logs.push(`${level}:${msg}`), phase: "unit" });
        assert.ok(out.stats.changed, "over-budget image body is shed");
        assert.ok(out.stats.archived >= 1, "oldest non-protected images archived");
        assert.ok(out.body.length < big.length, "outbound copy got smaller");
        const meta = session.metadata.httpByteShed as Record<string, unknown> | undefined;
        assert.ok(meta, "httpByteShed recorded on the session");
        assert.equal(meta?.phase, "unit");
        assert.ok((meta?.fromBytes as number) > (meta?.toBytes as number));
        assert.ok(logs.some(l => l.includes("[http-byte-shed]")), "shed logged under the http tag");
    } finally {
        delete process.env.BILI_HTTP_OUTBOUND_BYTES;
    }
});

test("#3909 Finding 1: a managed-but-not-WS transport (dsh-inline shape) is never shed", async () => {
    const session = createSession(`http-shed-mgmt-${randomUUID()}`);
    const big = bigBody();
    process.env.BILI_HTTP_OUTBOUND_BYTES = String(1_000_000);
    try {
        // A DEFINED non-WS transport is the inline-engine / dsh-inline shape: large bodies deliver
        // fine over it, so the gate must pass it through untouched even when over the HTTP budget.
        const out = await withFetchTransport(async () => new Response("unused"), () =>
            shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session }));
        assert.equal(out.body, big, "managed HTTP transport passes through byte-identical");
        assert.equal(out.stats.changed, false);
        assert.equal(out.stats.archived, 0);
        assert.equal(session.metadata.httpByteShed, undefined, "no httpByteShed recorded for a managed lane");
    } finally {
        delete process.env.BILI_HTTP_OUTBOUND_BYTES;
    }
});

test("#3909 lane isolation: the http budget does not leak into the WS lane", async () => {
    const session = createSession(`http-shed-ws-${randomUUID()}`);
    const big = bigBody();
    process.env.BILI_HTTP_OUTBOUND_BYTES = String(1_000_000);
    process.env.BILI_WS_OUTBOUND_BYTES = "0";
    try {
        // WS-tagged transport → governed by network.wsOutboundBytes (here disabled = 0), NOT by the
        // http budget. Even though the body exceeds the http budget, the WS lane must pass through.
        const out = await withFetchTransport(markWsLaneTransport(async () => new Response("unused")), () =>
            shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session }));
        assert.equal(out.body, big, "WS lane ignores the http budget");
        assert.equal(out.stats.changed, false);
        assert.equal(session.metadata.httpByteShed, undefined);
    } finally {
        delete process.env.BILI_HTTP_OUTBOUND_BYTES;
        delete process.env.BILI_WS_OUTBOUND_BYTES;
    }
});

test("#3909 shedEgressIfOverBudget: 0 disables the http pre-send shed", async () => {
    const session = createSession(`http-shed-off-${randomUUID()}`);
    const big = bigBody();
    process.env.BILI_HTTP_OUTBOUND_BYTES = "0";
    try {
        const out = await shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session });
        assert.equal(out.body, big, "budget 0 restores send-as-is");
        assert.equal(out.stats.changed, false);
    } finally {
        delete process.env.BILI_HTTP_OUTBOUND_BYTES;
    }
});

test("#3909 shedEgressIfOverBudget: under-budget body passes through byte-identical", async () => {
    const session = createSession(`http-shed-under-${randomUUID()}`);
    const big = bigBody();
    // ~2.4 MiB body is well under this budget → nothing sheddable, passthrough.
    process.env.BILI_HTTP_OUTBOUND_BYTES = String(50 * 1024 * 1024);
    try {
        const out = await shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session });
        assert.equal(out.body, big, "under-budget body untouched");
        assert.equal(out.stats.changed, false);
    } finally {
        delete process.env.BILI_HTTP_OUTBOUND_BYTES;
    }
});
