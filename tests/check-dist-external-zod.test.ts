import test from "node:test";
import assert from "node:assert/strict";
const gateSpec = "../scripts/check-dist-external-zod.mjs";
const { findStaticZodRefs, checkDistExternalZod } = await import(gateSpec) as {
    findStaticZodRefs: (text: string) => string[];
    checkDistExternalZod: (distDir: string) => Array<{ file: string; refs: string[] }>;
};

/** The guard exists because #3425's jimp inlining leaked 16 STATIC
 *  `from"zod"` imports into dist — module-load-time imports with no degrade
 *  path, crashing every thin install (package without node_modules). These
 *  tests pin the regex so the gate keeps catching exactly that class and
 *  never flags the sanctioned lazy path (opaque specifier) or plain
 *  "zod" strings (zod's own vendor markers survive bundling). */

test("static zod import forms are violations (the #3425 leak shapes)", () => {
    const hits = findStaticZodRefs(
        `import{z as z2}from"zod";const r=require("zod");await import("zod");export{x}from"zod";`,
    );
    assert.equal(hits.length, 4, "minified static import, require, literal dynamic import, re-export");
});

test("the sanctioned lazy path and incidental zod strings are not violations", () => {
    const clean = findStaticZodRefs(
        `const zodSpecifier="zod";const z=await import(zodSpecifier);const v={vendor:"zod"};`,
    );
    assert.equal(clean.length, 0);
});

test("checkDistExternalZod reports per file", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(tmpdir(), `bili-zod-guard-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
        writeFileSync(path.join(dir, "good.js"), `const s="zod";await import(s);\n`, "utf8");
        writeFileSync(path.join(dir, "bad.js"), `import{z}from"zod";\n`, "utf8");
        writeFileSync(path.join(dir, "not-js.txt"), `import{z}from"zod"\n`, "utf8");
        const violations = checkDistExternalZod(dir);
        assert.equal(violations.length, 1);
        assert.match(violations[0].file, /bad\.js$/);
        assert.equal(violations[0].refs.length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
