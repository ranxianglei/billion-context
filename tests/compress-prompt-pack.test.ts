import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defaultPrompts, buildCompressSystemPrompt, ACP_TOOLS_OPENAI, applyAcpToolOverrides } from "acp-kernel";
import { mergeCompress, resolveCompressSurface, resolveCompressSurfaceDetailed } from "../src/compress-settings.js";
import { rmrf } from "./tmp-rm.ts";

test("promptPack merges deepest-wins like every other field", () => {
    const merged = mergeCompress(
        { promptPack: "lean" },
        { promptPack: "team" },
        { promptPack: "default" },
    );
    assert.equal(merged.promptPack, "default");
    assert.equal(mergeCompress({ promptPack: "lean" }).promptPack, "lean");
    assert.equal(mergeCompress(undefined, { promptPack: "team" }).promptPack, "team");
    assert.equal(mergeCompress().promptPack, undefined);
});

test("resolveCompressSurface: unset / default / invalid names yield the identity surface", () => {
    assert.deepEqual(resolveCompressSurface({}), {});
    assert.deepEqual(resolveCompressSurface({ promptPack: "default" }), {});
    assert.deepEqual(resolveCompressSurface({ promptPack: "../etc/passwd" }), {});
    assert.deepEqual(resolveCompressSurface({ promptPack: "" }), {});
});

test("resolveCompressSurface: builtin lean resolves from the kernel registry", () => {
    const surface = resolveCompressSurface({ promptPack: "lean" });
    assert.equal(
        surface.toolPrompts?.compress?.description,
        "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs; batch multiple ranges into ONE call (a single string may hold every range).",
    );
    assert.equal(surface.prompts, undefined);
    const tools = applyAcpToolOverrides(ACP_TOOLS_OPENAI, surface.toolPrompts);
    const compress = tools.find((t) => t.function.name === "compress");
    assert.ok(compress);
    assert.equal(compress.function.description, surface.toolPrompts?.compress?.description);
});

test("resolveCompressSurface: unknown names fall back to identity", () => {
    assert.deepEqual(resolveCompressSurface({ promptPack: "no-such-pack" }), {});
});

test("resolveCompressSurface: file packs load from project dir, shadowing builtin", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-pack-"));
    try {
        writeFileSync(
            path.join(dir, "lean.json"),
            JSON.stringify({ name: "lean", toolPrompts: { acp_status: { description: "project lean" } } }),
        );
        const surface = resolveCompressSurface({ promptPack: "lean" }, { projectDir: dir });
        assert.equal(surface.toolPrompts?.acp_status?.description, "project lean");
        assert.equal(surface.toolPrompts?.compress?.description, undefined);
    } finally {
        rmrf(dir);
    }
});

test("resolveCompressSurface: nudge/prompt section overrides flow into the kernel builders", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-pack2-"));
    try {
        writeFileSync(
            path.join(dir, "quiet.json"),
            JSON.stringify({
                promptSections: { summariesInContext: null, acpTags: "QUIET-TAGS" },
                nudgeSections: { efficiencyNote: null },
            }),
        );
        const surface = resolveCompressSurface({ promptPack: "quiet" }, { projectDir: dir });
        const prompt = buildCompressSystemPrompt(defaultPrompts, surface.promptSections);
        assert.ok(prompt.includes("QUIET-TAGS"));
        assert.ok(!prompt.includes("COMPRESSION SUMMARIES IN CONTEXT"));
    } finally {
        rmrf(dir);
    }
});

test("resolveCompressSurfaceDetailed: pack identity travels with the surface", () => {
    assert.deepEqual(resolveCompressSurfaceDetailed({}).packName, "default");
    assert.deepEqual(resolveCompressSurfaceDetailed({ promptPack: "../etc/passwd" }).packName, "default");
    assert.deepEqual(resolveCompressSurfaceDetailed({ promptPack: "no-such-pack" }).packName, "default");
    const lean = resolveCompressSurfaceDetailed({ promptPack: "lean" });
    assert.equal(lean.packName, "lean");
    assert.equal(typeof lean.packVersion, "string");
    assert.equal(lean.surface.toolPrompts?.compress?.description, "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs; batch multiple ranges into ONE call (a single string may hold every range).");
});

test("resolveCompressSurfaceDetailed: file pack reports the requested name and its version", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-pack-meta-"));
    try {
        writeFileSync(
            path.join(dir, "versioned.json"),
            JSON.stringify({ name: "versioned", version: "9.9.9", toolPrompts: { compress: { description: "v" } } }),
        );
        const res = resolveCompressSurfaceDetailed({ promptPack: "versioned" }, { projectDir: dir });
        assert.equal(res.packName, "versioned");
        assert.equal(res.packVersion, "9.9.9");
    } finally {
        rmrf(dir);
    }
});

test("#2335: lean surface now carries the condensed system-prompt contract (pack promptSections reach the proxy builders)", () => {
    // Before the kernel fix the lean surface only swapped tool descriptions and
    // every lane silently assembled the FULL default system prompt (10.9KB).
    const surface = resolveCompressSurface({ promptPack: "lean" });
    assert.ok(surface.promptSections, "lean exposes top-level promptSections");
    const prompt = buildCompressSystemPrompt(defaultPrompts, surface.promptSections);
    assert.ok(prompt.includes("Your summary is the ONLY record"), "condensed lean contract is delivered");
    assert.ok(prompt.includes("Recall on demand only"), "recall discipline is delivered");
    assert.ok(prompt.includes("read that file"), "file-pointer discipline is delivered");
    assert.ok(!prompt.includes("Compression Philosophy: All compression serves the primary task"), "verbose default philosophy is gone");
    // default lane stays byte-stable: no pack → the same default assembly as ever
    const plain = buildCompressSystemPrompt(defaultPrompts, undefined);
    assert.ok(plain.startsWith("Compression Philosophy:\n- All compression serves the primary task"));
    assert.ok(!plain.includes("Your summary is the ONLY record"));
});
