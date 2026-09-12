import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defaultPrompts, buildCompressSystemPrompt, ACP_TOOLS_OPENAI, applyAcpToolOverrides } from "acp-kernel";
import { mergeCompress, resolveCompressSurface } from "../src/compress-settings.js";

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
        "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.",
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
        rmSync(dir, { recursive: true, force: true });
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
        rmSync(dir, { recursive: true, force: true });
    }
});
