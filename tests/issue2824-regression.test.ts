import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicToCore, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { createInitialState } from "acp-kernel";
import { PrefixAffinityResolver } from "../src/prefix-affinity.ts";
import { simhashComputeCountForTest } from "../src/affinity-simhash.ts";
import { bodyMightCarryImages, buildIncomingImageIndex, type IndexedImage } from "../src/image-restore.ts";
import type { WireProtocol } from "../src/util.js";

// Isolate stateDir() (image spill) under a throwaway dir. node --test gives each
// file its own process, so the env mutation is safe.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bili-issue2824-"));

/**
 * #2824: 0.1.193 per-request CPU regression from the #2791/#2807 wire-neutral
 * affinity work, two facets:
 *  1) the identified-session branch calls chainFingerprint() every request; the
 *     neutral rewrite made it run the fused hash+sketch pass although its
 *     product carries no sketches — at 24K+ turns (SKETCH_MEMO_CAP=8192 cannot
 *     warm across a sequential scan) that was ~2.2s of SimHash per request.
 *     Pins: hashes-only callers compute ZERO sketches; the anonymous path
 *     computes exactly the capped SKETCH_MAX_DEPTH on a cold resolve, ZERO on a
 *     warm resend, and similarity adoption still works beyond the cap.
 *  2) every image-free request ran the full wire→core history conversion twice
 *     (entry-time index build + post-prepare refresh) only to find no images.
 *     Pins: bodyMightCarryImages() fires for every indexable image shape
 *     (non-vacuously), stays false when the index would be empty, and the
 *     guarded path ≡ the unconditional build on the whole corpus.
 */

const DEEP_TURNS = 4150; // 8300 messages: > SKETCH_MEMO_CAP (8192) and > SKETCH_MAX_DEPTH (2048)
// SKETCH_MAX_DEPTH and MAX_STORED_ITEMS are module-private in src/prefix-affinity.ts;
// pin the values the caps must hold so a constant change forces a re-audit of these
// assertions.
const SKETCH_MAX_DEPTH_PIN = 2048;
const MAX_STORED_ITEMS_PIN = 128;

// Bodies carry enough distinct features that the decorative restamp below stays
// within the per-position similarity gate (ALIGN_SIMILAR_HAMMING=10): a short
// body puts a one-line model stamp just over the threshold and adoption
// legitimately refuses. Real long-session turns are paragraphs, not fragments.
const TAIL = " The surrounding context covers the release cadence, rollback policy, observability dashboards, alert routing rules, on-call rotation schedule, incident review process, change freeze calendar, capacity planning model, cost allocation tags, network topology diagram, storage tiering policy, backup retention window, disaster recovery runbook, performance regression budget, load shedding thresholds, graceful degradation matrix, configuration drift detection, secret rotation cadence, certificate renewal pipeline and end-to-end tracing correlation that ties every stage of the pipeline together";

function deepConversation(salt: string): Record<string, unknown>[] {
    const msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < DEEP_TURNS; i++) {
        msgs.push({ role: "user", content: `${salt} turn ${i}: please analyze the deployment pipeline for service alpha-${i} and report the latency profile of stage ${i} through stage ${i + 3}, including retry counts and queue depth for the whole window${TAIL}` });
        msgs.push({ role: "assistant", content: `${salt} analysis ${i}: stage ${i} shows a stable latency profile with a p95 of ${120 + i}ms; the retry budget was consumed ${i % 7} times; queue depth stayed under ${10 + i}; overall the pipeline for alpha-${i} is healthy and no intervention is required at this point in time${TAIL}` });
    }
    return msgs;
}

/** Trae-shaped decorative rewrite (same recipe as tests/prefix-affinity-simhash.test.ts):
 *  model stamp prepended to every assistant message + reminder appended to some users. */
function restampWithModel(msgs: Record<string, unknown>[], model: string): Record<string, unknown>[] {
    return msgs.map((m, i) => {
        if (m.role !== "assistant") {
            if (i % 5 === 0) return { ...m, content: `${(m as { content: string }).content}\n<system-reminder>session migrated to ${model}</system-reminder>` };
            return m;
        }
        return { ...m, content: `You are a coding agent powered by the ${model} model.\n${(m as { content: string }).content}` };
    });
}

function track(r: PrefixAffinityResolver, msgs: Record<string, unknown>[]): string {
    const a = r.resolve(msgs);
    assert.ok(a, "resolve must produce an affinity for a valid conversation");
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes, false, a.sketches, a.userFlags);
    return a.sessionId;
}

test("#2824: identified-path chainFingerprint computes ZERO sketches (was ~2.2s/request at 24K turns)", () => {
    const r = new PrefixAffinityResolver();
    const deep = deepConversation("idpath");
    const before = simhashComputeCountForTest();
    const fp = r.chainFingerprint(deep);
    assert.ok(fp, "fingerprint must exist for a valid conversation");
    assert.equal(simhashComputeCountForTest() - before, 0, "identified fingerprint must not pay for similarity sketches");
    assert.equal(fp.depth, DEEP_TURNS * 2, "fingerprint product unchanged");
    // Per-item hashes are capped at MAX_STORED_ITEMS (tail window for lineage
    // lookups); depth itself is uncapped.
    assert.equal(fp.itemHashes.length, Math.min(MAX_STORED_ITEMS_PIN, DEEP_TURNS * 2));
});

test("#2824: findResumeParent / findResumeParentWithin / chainContinues compute ZERO sketches", () => {
    const r = new PrefixAffinityResolver();
    const baseId = track(r, deepConversation("resume-base").slice(0, 40));
    const parentId = track(r, deepConversation("resume-parent").slice(0, 40));
    const probeA = deepConversation("resume-probe-a");
    const probeB = deepConversation("resume-probe-b");
    const before = simhashComputeCountForTest();
    r.findResumeParent(probeA, "self-session");
    r.findResumeParentWithin(parentId, probeB, "self-session");
    r.chainContinues(deepConversation("resume-base"), baseId);
    r.chainContinues(probeA, baseId);
    assert.equal(simhashComputeCountForTest() - before, 0, "hashes-only affinity queries must stay sketch-free");
});

test("#2824: anonymous cold resolve computes exactly the capped sketches; warm resend recomputes zero", () => {
    const r = new PrefixAffinityResolver();
    const deep = deepConversation("anon");
    let before = simhashComputeCountForTest();
    const a = r.resolve(deep);
    assert.ok(a && a.via === "new", "first sight mints fresh");
    const firstDelta = simhashComputeCountForTest() - before;
    assert.equal(firstDelta, SKETCH_MAX_DEPTH_PIN, `cold resolve computes the capped ${SKETCH_MAX_DEPTH_PIN} sketches, got ${firstDelta}`);
    assert.equal(a.sketches?.length, SKETCH_MAX_DEPTH_PIN, "resolve exposes the capped sketch list");
    // resolve() only RETURNS an affinity — the server notes the chain separately
    // (src/server/handle.ts). Without this the second resolve sees no tracked
    // chain and mints again.
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes, false, a.sketches, a.userFlags);

    before = simhashComputeCountForTest();
    const b = r.resolve(deep);
    assert.ok(b && b.via === "prefix", "identical resend takes the exact fast path");
    assert.equal(simhashComputeCountForTest() - before, 0, "warm resend must recompute ZERO sketches (memo holds within the cap)");

    const snap = r.exportSnapshot().find((e) => e.sessionId === a.sessionId);
    assert.ok(snap, "tracked chain present in snapshot");
    assert.equal(snap.sketches?.length, SKETCH_MAX_DEPTH_PIN, "persistence carries the capped sketches");
});

test("#2824: similarity adoption still works beyond the sketch cap (deep restamp)", () => {
    const r = new PrefixAffinityResolver();
    const original = deepConversation("adopt");
    const id = track(r, original);
    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r.resolve(rewritten);
    assert.ok(b, "resolve must produce an affinity");
    assert.equal(b.via, "simhash", "decorative rewrite must still adopt at depth > SKETCH_MAX_DEPTH");
    assert.equal(b.sessionId, id);
    assert.ok(b.adoption && b.adoption.coverage >= 0.9, `coverage ${b.adoption?.coverage}`);
});

// ── image-index guard ────────────────────────────────────────────────────────

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const dataUrl = `data:image/png;base64,${PNG}`;

const TO_CORE = {
    anthropic: anthropicToCore,
    openai: openaiToCore,
    responses: responsesToCore,
    google: googleToCore,
};

/** Run the protocol parser and assign deterministic refs (m00001..) like the server does. */
function refState(proto: WireProtocol, body: unknown) {
    const conv = (TO_CORE[proto] as (b: unknown) => unknown)(body);
    const raw = Array.isArray(conv) ? conv : (conv as { msgs?: unknown }).msgs;
    const msgs = (Array.isArray(raw) ? raw : []) as Array<{ id?: string }>;
    const state = createInitialState();
    msgs.forEach((m, i) => {
        if (!m.id) return;
        state.messageRefs.byRaw[m.id] = `m${String(i + 1).padStart(5, "0")}`;
    });
    return state;
}

const IMAGE_FIXTURES: Array<{ name: string; proto: WireProtocol; body: unknown }> = [
    { name: "openai multipart content array", proto: "openai", body: { model: "gpt", messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: dataUrl } }] }] } },
    { name: "responses input_image", proto: "responses", body: { model: "gpt", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: dataUrl }] }] } },
    { name: "anthropic source.base64", proto: "anthropic", body: { model: "claude", max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] } },
    { name: "anthropic source.url data URL", proto: "anthropic", body: { model: "claude", max_tokens: 10, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: dataUrl } }] }] } },
    { name: "anthropic nested tool_result image", proto: "anthropic", body: { model: "claude", max_tokens: 10, messages: [
        { role: "user", content: [{ type: "text", text: "run it" }, { type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
        { role: "assistant", content: [{ type: "text", text: "running" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] },
    ] } },
    { name: "google top-level inlineData", proto: "google", body: { contents: [{ role: "user", parts: [{ text: "see" }, { inlineData: { mimeType: "image/png", data: PNG } }] }] } },
];

test("#2824: bodyMightCarryImages flags every indexable image shape (non-vacuously)", () => {
    for (const fx of IMAGE_FIXTURES) {
        const text = JSON.stringify(fx.body);
        assert.equal(bodyMightCarryImages(text, fx.proto), true, `${fx.name}: predicate must fire`);
        const idx = buildIncomingImageIndex(fx.body, fx.proto, refState(fx.proto, fx.body), `fx-${fx.proto}`);
        assert.ok(idx.size >= 1, `${fx.name}: fixture must actually be indexable (keeps the predicate assertion honest)`);
    }
    // Pretty-printed JSON: the markers are whitespace-tolerant on purpose.
    const prettyAnthropic = IMAGE_FIXTURES.find((f) => f.name === "anthropic source.base64")!;
    const prettyOpenai = IMAGE_FIXTURES.find((f) => f.name === "openai multipart content array")!;
    assert.equal(bodyMightCarryImages(JSON.stringify(prettyAnthropic.body, null, 2), "anthropic"), true, "pretty-printed anthropic base64 still detected");
    assert.equal(bodyMightCarryImages(JSON.stringify(prettyOpenai.body, null, 2), "openai"), true, "pretty-printed openai data URL still detected");
});

const NO_IMAGE_BODIES: Array<{ name: string; proto: WireProtocol; body: unknown }> = [
    { name: "openai text only", proto: "openai", body: { model: "gpt", messages: [{ role: "user", content: "plain text only" }] } },
    { name: "responses text only", proto: "responses", body: { model: "gpt", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "plain" }] }] } },
    { name: "anthropic text only", proto: "anthropic", body: { model: "claude", max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }] } },
    { name: "google text only", proto: "google", body: { contents: [{ role: "user", parts: [{ text: "plain" }] }] } },
    // Remote URLs carry no recoverable bytes — never indexed, must not flag.
    { name: "openai remote http image_url", proto: "openai", body: { model: "gpt", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://files.example/x.png" } }] }] } },
];

test("#2824: bodyMightCarryImages stays false when the index would be empty", () => {
    for (const fx of NO_IMAGE_BODIES) {
        const text = JSON.stringify(fx.body);
        assert.equal(bodyMightCarryImages(text, fx.proto), false, `${fx.name}: predicate must stay silent`);
        const idx = buildIncomingImageIndex(fx.body, fx.proto, refState(fx.proto, fx.body), `nx-${fx.proto}`);
        assert.equal(idx.size, 0, `${fx.name}: unconditional build finds nothing either`);
    }
});

test("#2824: guarded path ≡ unconditional build across the corpus", () => {
    // Includes one deliberately over-approximated case: a pdf inlineData flags
    // the predicate (build runs, finds nothing) — over-approximation may miss
    // an optimization but must never change the result.
    const EXTRA: Array<{ name: string; proto: WireProtocol; body: unknown }> = [
        { name: "google pdf inlineData (over-approx ok)", proto: "google", body: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: "AAAA" } }] }] } },
        { name: "google nested functionResponse inlineData", proto: "google", body: { contents: [{ role: "user", parts: [{ functionResponse: { name: "shot", parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] }] } },
        // openai single-object content: the predicate fires (data: marker) but
        // the kernel never sidecars an image from a non-array content, so both
        // guarded and unconditional builds return ∅ — guarded ≡ unconditional.
        { name: "openai single-object image content (∅ both ways)", proto: "openai", body: { model: "gpt", messages: [{ role: "user", content: { type: "image_url", image_url: { url: dataUrl } } }] } },
    ];
    for (const fx of [...IMAGE_FIXTURES, ...NO_IMAGE_BODIES, ...EXTRA]) {
        const text = JSON.stringify(fx.body);
        const unconditional = buildIncomingImageIndex(fx.body, fx.proto, refState(fx.proto, fx.body), "eq");
        const guarded = bodyMightCarryImages(text, fx.proto)
            ? buildIncomingImageIndex(fx.body, fx.proto, refState(fx.proto, fx.body), "eq")
            : new Map<string, IndexedImage[]>();
        assert.deepStrictEqual(guarded, unconditional, `${fx.name}: guarding must not change the index`);
    }
});

test("#2824: a converter throw degrades the index fail-open but WARNS, never silently", async () => {
    // The #3642 single-object-content TypeError hid precisely because the
    // catch returned an empty index with zero signal — image recovery was
    // silently off for every session carrying that shape. The catch must
    // stay fail-open (request path unaffected) but emit one warn per error
    // signature so the next wire-tolerance break cannot hide.
    const { setLogCapture } = await import("../src/logger.ts");
    const warns: string[] = [];
    setLogCapture((_level, msg) => { warns.push(msg); });
    try {
        // A body shape that makes the converter itself throw: a Proxy that
        // explodes on property access — the conversion cannot get past the
        // first read, exercising the catch directly.
        const bomb = new Proxy({}, {
            get() { throw new TypeError("wire bomb"); },
        });
        const idx = buildIncomingImageIndex(bomb, "openai", createInitialState(), "warn-probe");
        assert.equal(idx.size, 0, "fail-open: empty index, no throw");
        assert.ok(
            warns.some((w) => w.includes("[image-restore] inbound index conversion failed") && w.includes("#2824")),
            `expected the visibility warn, got: ${JSON.stringify(warns)}`,
        );
    } finally {
        setLogCapture(null);
    }
});
