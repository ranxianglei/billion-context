// Build-gate tests (scripts/check-dist-import-annotations.mjs): the gate must
// catch surviving JSDoc import() annotations and real relative dynamic
// imports, while passing bare specifiers, node: builtins, and clean bundles.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findRelativeImportRefs, checkDistImportAnnotations } from "../scripts/check-dist-import-annotations.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

test("findRelativeImportRefs catches JSDoc-style and real relative calls", () => {
    const bad = [
        "/** @param {import('./client.js')} client */ function f() {}",
        "const x = require('../core/request.js');",
        "const y = import(\"./shared.js\").then((m) => m.f);",
        "import(  './spaced.js'  )",
    ].join("\n");
    const refs = findRelativeImportRefs(bad);
    assert.equal(refs.length, 4);
});

test("findRelativeImportRefs passes bare specifiers, node: builtins, clean code", () => {
    const good = [
        "const z = await import('zod');",
        "await import('node:fs');",
        'require("crypto")',
        "class C { constructor() {} }",
        "export { a as b } from \"./other\";",
    ].join("\n");
    assert.deepEqual(findRelativeImportRefs(good), []);
});

test("checkDistImportAnnotations walks dist recursively and reports per file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-distgate-"));
    try {
        mkdirSync(path.join(root, "agent"), { recursive: true });
        writeFileSync(path.join(root, "index.js"), "export default 1;\n");
        writeFileSync(path.join(root, "agent", "opencode-native.js"), "var a = {import('./client.js')};\n");
        writeFileSync(path.join(root, "agent", "map-ignored.js.map"), JSON.stringify({ sourcesContent: ["{import('./x.js')}"] }));
        const violations = checkDistImportAnnotations(root);
        assert.equal(violations.length, 1);
        assert.ok(violations[0].file.endsWith(path.join("agent", "opencode-native.js")));
        assert.equal(violations[0].refs.length, 1);
    } finally {
        rmrf(root);
    }
});
