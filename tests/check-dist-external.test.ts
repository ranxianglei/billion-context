import test from "node:test";
import assert from "node:assert/strict";
const gateSpec = "../scripts/check-dist-external.mjs";
const { findExternalRefs, checkDistExternal } = await import(gateSpec) as {
    findExternalRefs: (text: string) => Array<{ spec: string; kind: string; line: number }>;
    checkDistExternal: (distDir: string) => Array<{ file: string; refs: string[] }>;
};

/** The guard exists because external bare imports in dist kill thin installs
 *  (package without node_modules): a STATIC one resolves at module load with
 *  no degrade path — #3425/#3511 (zod leak), #4008 (mysql2 driver hoisted by
 *  the single-file bundle). These tests pin BOTH directions (#3617): every
 *  disallowed shape is caught, and every sanctioned lazy path / builtin /
 *  allowlisted form stays clean. */

test("the #4008 shape: minified static mysql2 import is a violation", () => {
    const text = 'import{createPool}from"mysql2/promise";';
    const refs = findExternalRefs(text);
    assert.equal(refs.length, 1);
    assert.deepEqual({ spec: refs[0].spec, kind: refs[0].kind }, { spec: "mysql2/promise", kind: "static" });
});

test("dynamic (lazy) loads of allowlisted externals pass the checker", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(tmpdir(), `bili-ext-guard-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
        const text = 'const d=await import("mysql2/promise");const j=await import("jimp").catch(()=>null);\n';
        writeFileSync(path.join(dir, "index.js"), text, "utf8");
        const refs = findExternalRefs(text);
        assert.equal(refs.length, 2, "both dynamic refs are found...");
        assert.ok(refs.every((r) => r.kind === "dynamic"));
        assert.equal(checkDistExternal(dir).length, 0, "...and neither violates (dynamic-only allowlist entries)");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("zod stays blocked in every literal form (the #3511 pin)", () => {
    const hits = findExternalRefs(
        'import{z as z2}from"zod";const r=require("zod");await import("zod");export{x}from"zod";',
    );
    assert.equal(hits.length, 4, "minified static import, require, literal dynamic import, re-export");
    assert.ok(hits.every((h) => h.spec === "zod"));
});

test("the sanctioned opaque path and incidental strings are invisible", () => {
    const clean = findExternalRefs(
        'const zodSpecifier="zod";const z=await import(zodSpecifier);const v={vendor:"zod"};',
    );
    assert.equal(clean.length, 0);
});

test("node builtins (with and without node: prefix) are clean", () => {
    const clean = findExternalRefs(
        'import{readFile}from"node:fs";import crypto from"crypto";const u=require("util");',
    );
    assert.equal(clean.length, 0);
});

test("an unknown new package fails in every form (no silent new externals)", () => {
    for (const text of [
        'import{a}from"left-pad";',
        'import leftPad from"left-pad";',
        'import*as lp from"left-pad";',
        'import"left-pad";',
        'export{a}from"left-pad";',
        'const l=require("left-pad");',
    ]) {
        const refs = findExternalRefs(text);
        assert.equal(refs.length, 1, `one static ref for: ${text}`);
        assert.equal(refs[0].spec, "left-pad");
        assert.equal(refs[0].kind, "static");
    }
});

test("a STATIC form of an allowlisted dynamic-only entry still fails", async () => {
    // jimp + mysql2 are allowed ONLY as lazy dynamic imports; a static form
    // of them is exactly the #3516/#4008 crash shape.
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(tmpdir(), `bili-ext-guard-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
        writeFileSync(path.join(dir, "index.js"), 'import Jimp from"jimp";\n', "utf8");
        const violations = checkDistExternal(dir);
        assert.equal(violations.length, 1);
        assert.match(violations[0].file, /index\.js$/);
        assert.equal(violations[0].refs.length, 1);
        assert.match(violations[0].refs[0], /allowed kinds: dynamic/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("react is confined to the dsh browser bundle", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(tmpdir(), `bili-ext-guard-${process.pid}-${Date.now()}`);
    mkdirSync(path.join(dir, "agent"), { recursive: true });
    try {
        writeFileSync(path.join(dir, "agent", "dsh-native-client.js"), 'var r=require("react");\n', "utf8");
        let violations = checkDistExternal(dir);
        assert.equal(violations.length, 0, "require(\"react\") inside dsh-native-client.js is sanctioned");
        writeFileSync(path.join(dir, "index.js"), 'var r=require("react");\n', "utf8");
        violations = checkDistExternal(dir);
        assert.equal(violations.length, 1, "require(\"react\") anywhere else fails");
        assert.match(violations[0].file, /index\.js$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("checkDistExternal reports per file and passes a clean tree", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(tmpdir(), `bili-ext-guard-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
        writeFileSync(path.join(dir, "good.js"), 'const s="zod";await import(s);\n', "utf8");
        writeFileSync(path.join(dir, "bad.js"), 'import{z}from"zod";\n', "utf8");
        writeFileSync(path.join(dir, "not-js.txt"), 'import{z}from"zod"\n', "utf8");
        const violations = checkDistExternal(dir);
        assert.equal(violations.length, 1);
        assert.match(violations[0].file, /bad\.js$/);
        assert.equal(violations[0].refs.length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
