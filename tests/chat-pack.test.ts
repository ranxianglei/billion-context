/** #5319: the host-shipped `chat` prompt pack (src/chat-pack.ts) and its
 *  slot in the resolution chain [project > user > shipped > builtin]. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildCompressSystemPrompt, builtinSource, createDirPackSource, createPackResolver, defaultPrompts } from "acp-kernel";
import { CHAT_COMPRESS_PHILOSOPHY, CHAT_HOW_TO_COMPRESS, CHAT_PROMPT_SECTIONS, chatPack, shippedPacksSource } from "../src/chat-pack.js";
import { resolveCompressSurfaceDetailed } from "../src/compress-settings.js";
import { rmrf } from "./tmp-rm.ts";

const NO_PROJ = path.join(tmpdir(), `chatpack-noproj-${process.pid}`);
const NO_USER = path.join(tmpdir(), `chatpack-nouser-${process.pid}`);
const ISOLATED = { projectDir: NO_PROJ, userDirs: [NO_USER] };

test("shipped chain order: project > user > shipped > builtin; unknown falls back to default", () => {
    const proj = mkdtempSync(path.join(tmpdir(), "chatpack-proj-"));
    const user = mkdtempSync(path.join(tmpdir(), "chatpack-user-"));
    try {
        // Bare: resolves from the shipped source, byte-identical to the exported pack.
        let d = resolveCompressSurfaceDetailed({ promptPack: "chat" }, ISOLATED);
        assert.equal(d.packName, "chat");
        assert.equal(d.packVersion, "0.1.0");
        assert.deepEqual(d.surface, chatPack.surface);

        // User-dir file shadows the shipped pack.
        writeFileSync(path.join(user, "chat.json"), JSON.stringify({
            version: "9.9.9",
            promptSections: { howToCompress: "USER SHADOW MARKER" },
        }));
        d = resolveCompressSurfaceDetailed({ promptPack: "chat" }, { projectDir: NO_PROJ, userDirs: [user] });
        assert.equal(d.packName, "chat");
        assert.equal(d.packVersion, "9.9.9");
        assert.ok((d.surface.promptSections?.howToCompress ?? "").includes("USER SHADOW MARKER"));

        // Project-dir file shadows the user-dir file.
        writeFileSync(path.join(proj, "chat.json"), JSON.stringify({
            promptSections: { philosophy: "PROJECT SHADOW MARKER" },
        }));
        d = resolveCompressSurfaceDetailed({ promptPack: "chat" }, { projectDir: proj, userDirs: [user] });
        assert.ok((d.surface.promptSections?.philosophy ?? "").includes("PROJECT SHADOW MARKER"));

        // Kernel builtins stay reachable below the shipped layer; typos still fall back.
        assert.equal(resolveCompressSurfaceDetailed({ promptPack: "lean" }, ISOLATED).packName, "lean");
        const fallback = resolveCompressSurfaceDetailed({ promptPack: "no-such-pack-xyz" }, ISOLATED);
        assert.deepEqual(fallback.surface, {});
        assert.equal(fallback.packName, "default");
    } finally {
        rmrf(proj);
        rmrf(user);
    }
});

test("listPacks surfaces chat exactly once alongside the kernel builtins", () => {
    const packs = createPackResolver([createDirPackSource("project", NO_PROJ), shippedPacksSource, builtinSource]).listPacks();
    const names = packs.map((p) => p.name);
    assert.equal(names.filter((n) => n === "chat").length, 1);
    for (const expected of ["default", "lean"]) assert.ok(names.includes(expected), `missing builtin ${expected}`);
});

test("pi adapter mirrors the top-level sections object", () => {
    const adapter = chatPack.surface.adapters?.pi as { promptSections?: typeof CHAT_PROMPT_SECTIONS } | undefined;
    assert.equal(adapter?.promptSections, CHAT_PROMPT_SECTIONS);
});

test("buildCompressSystemPrompt substitutes both sections end-to-end (tri-state override)", () => {
    const out = buildCompressSystemPrompt(defaultPrompts, {
        philosophy: CHAT_COMPRESS_PHILOSOPHY,
        howToCompress: CHAT_HOW_TO_COMPRESS,
    });
    assert.ok(out.includes(CHAT_COMPRESS_PHILOSOPHY), "chat philosophy rendered");
    assert.ok(out.includes(CHAT_HOW_TO_COMPRESS.slice(0, 60)), "chat how-to-compress rendered");
    // Default rule text that ONLY the code-oriented default/lean contracts carry:
    assert.ok(!out.includes("Function/class/type signatures"), "default code-rule bullet gone");
    assert.ok(!out.includes("user goal/evolution/intent/hard constraints"), "default priority line gone");
});

test("open-objective carry-forward invariants survive in the chat wording (drift guard)", () => {
    for (const needle of [
        "Open objectives:",
        "User said (m00132)",
        "TASK AS OF THIS BLOCK",
        "(answered)",
        "- TIMELINE",
    ]) {
        assert.ok(CHAT_HOW_TO_COMPRESS.includes(needle), `chat contract lost load-bearing line: ${needle}`);
    }
    assert.ok(CHAT_HOW_TO_COMPRESS.length < 4500 && CHAT_HOW_TO_COMPRESS.length > 2000, "sanity bounds on contract size");
    assert.ok(CHAT_COMPRESS_PHILOSOPHY.length < 800 && CHAT_COMPRESS_PHILOSOPHY.length > 100, "sanity bounds on philosophy size");
});
