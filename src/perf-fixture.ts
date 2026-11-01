// Deterministic perf fixtures for the #5460(P2) bench layer. A fixture is a
// synthetic conversation history whose bytes are a PURE function of
// (seed, msgs, shape) — no Date.now, no Math.random, no host state — so any
// two runs (any machine, any time) replay byte-identical traffic. Content is
// ASCII-only technical filler carrying `sentinel value:` lines and doc# refs
// so that if a run triggers compression, the proxy's own summarization call
// gets a deterministic answer from the bench fake upstream. Zero privacy
// surface by construction: nothing here can contain user data.
//
// Sizes mirror the #5403 incident shape at the large end: ~4 KiB mean
// message → S-large (20k messages) lands near 80 MiB of full-resend history.

export type FixtureShape = "openai" | "anthropic";

export interface FixtureSpec {
    seed: number;
    msgs: number;
    shape: FixtureShape;
}

export interface FixtureMessage {
    role: "user" | "assistant";
    content: string;
}

export interface Fixture {
    seed: number;
    shape: FixtureShape;
    count: number;
    /** Total UTF-8 bytes across all message contents. */
    bytes: number;
    messages: FixtureMessage[];
}

/** mulberry32: small deterministic PRNG, period 2^32, good enough for
 *  filler text — reproducibility matters, statistical quality does not. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WORDS = [
    "context", "window", "token", "session", "ledger", "snapshot", "anchor",
    "prefix", "suffix", "fold", "block", "carrier", "coverage", "reconcile",
    "baseline", "ratchet", "payload", "envelope", "journal", "wal", "index",
    "cursor", "drift", "churn", "spike", "hwm", "percentile", "latency",
    "throughput", "buffer", "stream", "chunk", "delta", "frame", "header",
    "route", "relay", "probe", "sentinel", "fragment", "archive", "digest",
    "mirror", "shadow", "unified", "legacy", "fallback", "degrade", "isolate",
];

function paragraph(rnd: () => number, words: number): string {
    const out: string[] = [];
    for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    return out.join(" ");
}

/** One synthetic message: 2-4 short paragraphs, an occasional large
 *  tool-output-style dump block (~14 B per row), and every 10th message a
 *  sentinel line the fake summarizer must preserve. Mean ≈ 3.7 KiB. */
function buildContent(i: number, seed: number, rnd: () => number): string {
    const lines: string[] = [];
    const paras = 2 + Math.floor(rnd() * 3);
    for (let p = 0; p < paras; p++) {
        let text = paragraph(rnd, 18 + Math.floor(rnd() * 43));
        if (p === 0) text += ` see doc#${i % 500}`;
        lines.push(text);
    }
    if (i % 10 === 0) lines.push(`sentinel value: ${i * 7 + (seed % 997)}`);
    if (rnd() < 0.3) {
        const rows = 200 + Math.floor(rnd() * 1000);
        for (let r = 0; r < rows; r++) {
            lines.push(`row=${Math.floor(rnd() * 0x100000000).toString(16).padStart(8, "0")}`);
        }
    }
    return lines.join("\n");
}

export function generateFixture(spec: FixtureSpec): Fixture {
    if (!Number.isInteger(spec.seed) || spec.seed < 0) throw new Error(`fixture seed must be a non-negative integer, got ${spec.seed}`);
    if (!Number.isInteger(spec.msgs) || spec.msgs < 1) throw new Error(`fixture msgs must be a positive integer, got ${spec.msgs}`);
    if (spec.shape !== "openai" && spec.shape !== "anthropic") throw new Error(`fixture shape must be openai|anthropic, got ${String(spec.shape)}`);
    const rnd = mulberry32(spec.seed);
    const messages: FixtureMessage[] = [];
    let bytes = 0;
    for (let i = 0; i < spec.msgs; i++) {
        const content = buildContent(i, spec.seed, rnd);
        bytes += Buffer.byteLength(content, "utf8");
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content });
    }
    return { seed: spec.seed, shape: spec.shape, count: spec.msgs, bytes, messages };
}

/** OpenAI chat-completions body for one append round (full-resend prefix). */
export function renderOpenaiBody(model: string, history: readonly FixtureMessage[], stream = true): Record<string, unknown> {
    return { model, stream, messages: history.map((m) => ({ role: m.role, content: m.content })) };
}

/** Anthropic Messages-API body for one append round (string content blocks,
 *  fixed max_tokens so output cost stays flat across rounds). */
export function renderAnthropicBody(model: string, history: readonly FixtureMessage[], stream = true): Record<string, unknown> {
    return { model, max_tokens: 1024, stream, messages: history.map((m) => ({ role: m.role, content: m.content })) };
}
