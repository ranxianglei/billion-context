// Build gate: fail if any external bare import survives into dist outside
// the sanctioned allowlist below.
//
// dist must stay self-contained for thin installs — the package copied
// WITHOUT its node_modules tree (dsh profile bare copies, plugin copies,
// bili's own e2e rigs). A STATIC bare import resolves at module load with NO
// degrade path: the process dies before it binds a port and model traffic
// silently goes direct, uncompressed. History of the class this pins:
//   #3425/#3511 P0 — jimp inlining leaked 16 static `from"zod"` imports into
//     dist (this script started life as the zod-only guard);
//   #3516 — jimp itself moved to external + lazy dynamic load (allowlisted);
//   #4008 — mysql2 (declared dep, auto-externalized by tsup) arrived with a
//     TOP-LEVEL static import in src/storage/mysql.ts; openBackend's
//     internal-module dynamic import got hoisted by the single-file bundle
//     and the driver import rode along to the top of dist/index.js and
//     dist/agent/pi-native.js — every thin install crashed at startup with
//     ERR_MODULE_NOT_FOUND even when sqlite was selected. This
//     generalization closes the class: ANY new external specifier fails the
//     build unless explicitly listed below WITH a reason, and listed
//     specifiers may only appear in their sanctioned forms (dynamic-only
//     entries keep their lazy-load contract — a static form of them is still
//     a violation).
//
// Node builtins (node:* and module.builtinModules) and relative paths are
// fine. Opaque variable specifiers (`const s="zod"; import(s)`) are invisible
// to a text scan by design — that is the sanctioned lazy path (opencode V1
// interop loads the HOST's zod instance through a variable; see
// src/agent/opencode-native.ts). A literal `import("zod")` is NOT sanctioned
// (esbuild would bundle or rewrite it) and fails via the allowlist.

import { builtinModules } from "node:module";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const NODE_BUILTINS = new Set(builtinModules);

/** Sanctioned external specifiers. kind "static" covers every form that
 *  resolves at module load (import decl / export-from / require); "dynamic"
 *  covers import(). `files` restricts an entry to specific dist-relative
 *  artifact paths when given. Every entry needs a reason — the allowlist is
 *  evidence, not convenience. */
const ALLOWED_EXTERNALS = [
    {
        spec: "jimp",
        kinds: ["dynamic"],
        reason: "#3516 optional image-rescale dependency — loaded at first use (src/image-rescale.ts) and degrades to pass-through when absent; a static form would crash thin installs at module load",
    },
    {
        spec: "react",
        kinds: ["static"],
        files: ["agent/dsh-native-client.js"],
        reason: "#1590 browser CJS bundle for the dsh web profile — react resolves through dsh's own module system at runtime (classic-script wrapper); nothing else may reference it",
    },
    {
        spec: "mysql2/promise",
        kinds: ["dynamic"],
        reason: "#4008 storage driver — loaded at openBackend(\"mysql\") time only (src/storage/backend.ts); a static form crashes thin installs at module load even when sqlite is selected",
    },
];

// Import forms, each capturing the bare specifier. Static forms first; the
// dynamic form is separate because its KIND is what the allowlist polices.
const STATIC_REF_PATTERNS = [
    // side-effect: import "x"
    /\bimport\s*["']([^"'\n]+)["']/g,
    // named: import { a, b as c } from "x"  (minified or spaced)
    /\bimport\s*\{[^}]*\}\s*from\s*["']([^"'\n]+)["']/g,
    // namespace (optionally with named tail): import * as ns from "x"
    /\bimport\s*\*\s*as\s+[\w$]+\s*,?\s*(?:\{[^}]*\})?\s*from\s*["']([^"'\n]+)["']/g,
    // default + namespace: import def, * as ns from "x"
    /\bimport\s+[\w$]+\s*,\s*\*\s*as\s+[\w$]+\s+from\s*["']([^"'\n]+)["']/g,
    // default + named: import def, { a } from "x"
    /\bimport\s+[\w$]+\s*,\s*\{[^}]*\}\s*from\s*["']([^"'\n]+)["']/g,
    // default: import def from "x"
    /\bimport\s+[\w$]+\s+from\s*["']([^"'\n]+)["']/g,
    // re-export: export * [as ns] from "x"  /  export { a } from "x"
    // (\s* after export and before from: minified output writes
    // export{x}from"x" — braces need no separators, unlike identifier-from
    // which always has one; exports.foo never matches — the group demands * or {)
    /\bexport\s*(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g,
    // CJS require (resolves at call, i.e. factory execution for our bundles)
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const DYNAMIC_REF_PATTERN = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

function lineOf(text, index) {
    return text.slice(0, index).split("\n").length;
}

function collectRefs(text, re, kind) {
    const refs = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const spec = m[1];
        if (!spec || spec.startsWith(".") || spec.startsWith("/")) continue;
        const base = spec.replace(/^node:/, "").split("/")[0];
        if (NODE_BUILTINS.has(base)) continue;
        refs.push({ spec, kind, line: lineOf(text, m.index) });
    }
    return refs;
}

/** All bare external refs in a source text (builtins/relative excluded),
 *  each tagged with the import kind that produced it. */
export function findExternalRefs(text) {
    const refs = [];
    for (const re of STATIC_REF_PATTERNS) refs.push(...collectRefs(text, re, "static"));
    refs.push(...collectRefs(text, DYNAMIC_REF_PATTERN, "dynamic"));
    return refs;
}

function classify(refs, relFile) {
    const violations = [];
    for (const ref of refs) {
        const entry = ALLOWED_EXTERNALS.find((e) => e.spec === ref.spec);
        if (!entry) {
            violations.push(`${ref.kind} ${ref.spec} @ line ${ref.line} — not on the allowlist (bundle it via tsup noExternal, or add it here WITH a reason)`);
            continue;
        }
        if (!entry.kinds.includes(ref.kind)) {
            violations.push(`${ref.kind} ${ref.spec} @ line ${ref.line} — allowed kinds: ${entry.kinds.join(", ")} (${entry.reason})`);
            continue;
        }
        if (entry.files && !entry.files.includes(relFile)) {
            violations.push(`${ref.kind} ${ref.spec} @ line ${ref.line} — restricted to ${entry.files.join(", ")}`);
        }
    }
    return violations;
}

/** Walk a dist tree and report every disallowed external ref per file. */
export function checkDistExternal(distDir) {
    const violations = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) { walk(full); continue; }
            if (!name.endsWith(".js")) continue;
            const relFile = path.relative(distDir, full).split(path.sep).join("/");
            const refs = findExternalRefs(readFileSync(full, "utf8"));
            const bad = classify(refs, relFile);
            if (bad.length > 0) violations.push({ file: full, refs: bad });
        }
    };
    walk(distDir);
    return violations;
}

const invoked = process.argv[1];
// Realpath both sides: Node resolves entry-point symlinks, so argv[1] can differ from import.meta.url
const isMain = !!invoked && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
if (isMain) {
    const distDir = process.argv[2] ?? "dist";
    const violations = checkDistExternal(distDir);
    if (violations.length > 0) {
        for (const v of violations) {
            console.error(`dist-external: ${v.file}:`);
            for (const r of v.refs.slice(0, 5)) console.error(`  ${r}`);
            if (v.refs.length > 5) console.error(`  … (+${v.refs.length - 5} more)`);
        }
        console.error(`dist-external: FAIL — ${violations.reduce((n, v) => n + v.refs.length, 0)} disallowed external import ref(s) across ${violations.length} file(s). dist must stay self-contained for thin installs (no node_modules): bundle new deps via tsup noExternal, keep lazy loads DYNAMIC, or extend the allowlist in scripts/check-dist-external.mjs with a reason (#3511/#3516/#4008 class).`);
        process.exit(1);
    }
    console.log("dist-external: OK");
}
