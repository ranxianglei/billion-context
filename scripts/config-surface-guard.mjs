#!/usr/bin/env node
// #2643 — config-surface guard. Blocks NON-COMPLIANTLY ADDED configuration.
// Zero-dep: plain node, no npm install (same posture as check-unused-exports.mjs).
//
// AGENTS.md makes the whole config surface owner-gated territory. #2107 already
// enforces env vars + FileConfig TOP-LEVEL keys via tools/gen-config-docs.mjs
// check-coverage. This closes the two surfaces that previously slipped through:
//   1. NESTED config-file leaf fields — #2107's `k === K || k.startsWith(K + ".")`
//      let any new leaf under an already-documented block pass silently.
//   2. CLI --flags — never checked at all.
//
// Documentation targets (single source of truth, no parallel baseline):
//   config-file leaf field  -> a seed `key:` entry in website/config-reference/*.yaml
//   CLI long flag (--xxx)   -> mentioned in CONFIGURATION.md
// (env vars remain owned by tools/gen-config-docs.mjs check-coverage.)
//
// Posture: an UNDOCUMENTED addition FAILS (the point of the guard). A STALE item
// (documented but no longer read) is a WARNING only — dynamic/generated names
// legitimately lag, matching the existing env-var gate. Stale detection is applied
// where it is unambiguous (CLI flags); it is skipped for leaf fields because the
// seed namespace also holds provider-route keys and env names that would pollute it.
//
// Usage:
//   node scripts/config-surface-guard.mjs            # check: exit 1 on undocumented addition
//   node scripts/config-surface-guard.mjs report     # print report, always exit 0

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.join(ROOT, p);
const readRel = (p) => readFileSync(rel(p), "utf8");

// ---- comment/string-aware source helpers ------------------------------------

// Strip // and /* */ comments WITHOUT touching string/template literals. Keeps
// newlines so line numbers stay stable if we ever surface them.
export function stripComments(src) {
    let out = "";
    let mode = "code"; // code | line | block | sq | dq | tpl
    for (let i = 0; i < src.length; i++) {
        const c = src[i], d = i + 1 < src.length ? src[i + 1] : "";
        if (mode === "code") {
            if (c === "/" && d === "/") { mode = "line"; i++; continue; }
            if (c === "/" && d === "*") { mode = "block"; i++; continue; }
            if (c === "'") mode = "sq";
            else if (c === '"') mode = "dq";
            else if (c === "`") mode = "tpl";
            out += c;
            continue;
        }
        if (mode === "line") {
            if (c === "\n") { mode = "code"; out += c; }
            continue;
        }
        if (mode === "block") {
            if (c === "*" && d === "/") { mode = "code"; i++; continue; }
            if (c === "\n") out += "\n";
            continue;
        }
        // string/template modes: copy verbatim, honor backslash escapes
        out += c;
        if (c === "\\") { out += d ?? ""; i++; continue; }
        const close = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
        if (c === close) mode = "code";
    }
    return out;
}

// Given src and the index of an opening "{", return the text between the matched
// braces (exclusive of the braces). Tracks (), [], {} depth and string state.
function objectBody(src, openIdx) {
    let depth = 0;
    let inStr = null;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (inStr) {
            if (c === inStr && src[i - 1] !== "\\") inStr = null;
            continue;
        }
        if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
            depth--;
            if (depth === 0) return src.slice(openIdx + 1, i);
        }
    }
    throw new Error("unbalanced object literal near index " + openIdx);
}

// Split an object-literal body into [{ name, type }] members on ";" at depth 0.
export function parseObjectMembers(body) {
    const raw = [];
    let depth = 0, cur = "", inStr = null;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) { cur += c; if (c === inStr && body[i - 1] !== "\\") inStr = null; continue; }
        if (c === "'" || c === '"' || c === "`") { inStr = c; cur += c; continue; }
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        if (c === ";" && depth === 0) { const t = cur.trim(); if (t) raw.push(t); cur = ""; continue; }
        cur += c;
    }
    const t = cur.trim(); if (t) raw.push(t);
    const members = [];
    for (const seg of raw) {
        const m = seg.match(/^([A-Za-z_][\w$]*)\??\s*:\s*([\s\S]+)$/);
        if (m) members.push({ name: m[1], type: m[2].trim() });
    }
    return members;
}

// First identifier in a type position, unwrapping Partial<T> and trailing [].
function baseName(typeText) {
    let t = typeText.trim().replace(/\[\]\s*$/g, "");
    const pm = t.match(/^Partial<\s*([\w$]+)\s*>$/);
    if (pm) return pm[1];
    const m = t.match(/^([\w$]+)/);
    return m ? m[1] : t;
}

// Collect every locally-declared object-literal type/interface body by name.
function namedTypeBodies(src) {
    const bodies = {};
    const re = /(?:interface|type)\s+([A-Za-z_][\w$]*)\s*(?:=\s*)?\{/g;
    let m;
    while ((m = re.exec(src))) {
        const open = re.lastIndex - 1;
        try { bodies[m[1]] = objectBody(src, open); } catch { /* non-object type */ }
    }
    return bodies;
}

// Extract the quoted identifiers of `const <varName> = new Set([ ... ]);`.
export function extractStringSet(src, varName) {
    // Locate the DEFINITION (`const <name> = new Set([`), not the first textual
    // mention: doc comments legitimately reference the identifier above its
    // definition (#3675's header did exactly that and fed the extractor the
    // wrong bracket window — the join(", ") in unrelated code parsed as a
    // leaf named ", ").
    const def = src.indexOf(varName + " = new Set([");
    const i = def >= 0 ? def : src.indexOf(varName);
    if (i < 0) throw new Error(varName + " not found");
    const open = src.indexOf("[", i);
    const close = src.indexOf("]", open);
    const inner = src.slice(open + 1, close);
    const out = [];
    const re = /["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(inner))) out.push(m[1]);
    return out;
}

// ---- config-file leaf extraction --------------------------------------------
// Walks the canonical FileConfig shape and emits every leaf dot-path the proxy
// accepts in ~/.config/billion-context/billion-context.json. Rules:
//   inline `{ ... }`            -> recurse to leaves
//   `compress`                  -> expand via the COMPRESS_SETTING_FIELDS mirror Set
//                                   (its real shape spans cross-file types; the Set is
//                                   the maintained authoritative list of its direct fields)
//   `Record<...>` / ResignSchemeMap / `<NamedType> | boolean` -> OPEN map/union:
//                                   the parent path is the documented unit, no children
//   other local named type       -> resolve its body and recurse
//   primitive / literal union    -> scalar leaf
export function extractConfigLeaves(configSrc) {
    const src = stripComments(configSrc);
    const leaves = new Set();
    const namedBodies = namedTypeBodies(src);
    const compressFields = extractStringSet(src, "COMPRESS_SETTING_FIELDS");
    const openNamed = new Set(["ResignSchemeMap"]);

    const fcIdx = src.indexOf("type FileConfig");
    if (fcIdx < 0) throw new Error("FileConfig not found in config source");
    const fcBody = objectBody(src, src.indexOf("{", fcIdx));

    function processType(typeText, prefix) {
        const t = typeText.trim();
        const braceIdx = t.indexOf("{");
        if (braceIdx >= 0) {
            for (const m of parseObjectMembers(objectBody(t, braceIdx))) {
                processType(m.type, prefix ? `${prefix}.${m.name}` : m.name);
            }
            return;
        }
        if (t.includes("Record<")) { leaves.add(prefix); return; }
        if (openNamed.has(baseName(t))) { leaves.add(prefix); return; }
        if (/^boolean\s*\||\|\s*boolean(\s*$|\s*\|)/.test(t)) { leaves.add(prefix); return; }
        const base = baseName(t);
        if (namedBodies[base]) {
            for (const m of parseObjectMembers(namedBodies[base])) {
                processType(m.type, prefix ? `${prefix}.${m.name}` : m.name);
            }
            return;
        }
        leaves.add(prefix);
    }

    for (const m of parseObjectMembers(fcBody)) {
        if (m.name === "compress") {
            for (const f of compressFields) leaves.add(`compress.${f}`);
            continue;
        }
        processType(m.type, m.name);
    }
    return [...leaves].sort();
}

// ---- CLI flag extraction -----------------------------------------------------
// Every --flag (and short alias) accepted by parseArgs. Flags live only in this
// one switch today; scanning the whole file is equivalent and future-proof.
export function extractCliFlags(cliSrc) {
    const src = stripComments(cliSrc);
    const flags = new Set();
    const re = /case\s+"(-{1,2}[A-Za-z][\w-]*)"/g;
    let m;
    while ((m = re.exec(src))) flags.add(m[1]);
    return [...flags].sort();
}

// ---- documentation sources ---------------------------------------------------

// All documented seed keys across website/config-reference/*.yaml.
export function loadDocumentedKeys() {
    const dir = rel("website/config-reference");
    const keys = new Set();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
        const txt = readRel(`website/config-reference/${f}`);
        const re = /^\s*-\s*key:\s*["']?([A-Za-z_][\w./-]*)["']?/gm;
        let m;
        while ((m = re.exec(txt))) keys.add(m[1]);
    }
    return keys;
}

// ---- checks ------------------------------------------------------------------

// A long flag counts as documented if it appears in README.md OR CONFIGURATION.md
// (the two surfaces users consult for CLI reference; neither alone covers every
// flag). README.md is never regenerated by tools/gen-config-docs.mjs, so a mention
// there is drift-safe; CONFIGURATION.md's hand-written sections are likewise safe.
function flagDocumented(flag, readme, configMd) {
    return readme.includes(flag) || configMd.includes(flag);
}

export function runChecks() {
    const configSrc = readRel("src/config.ts");
    const cliSrc = readRel("src/cli.ts");
    const readme = readRel("README.md");
    const configMd = readRel("CONFIGURATION.md");
    const docKeys = loadDocumentedKeys();

    const leaves = extractConfigLeaves(configSrc);
    const flags = extractCliFlags(cliSrc);
    const longFlags = flags.filter((f) => f.startsWith("--"));

    // UNDOCUMENTED additions fail (the guard's purpose). We deliberately do NOT do
    // stale detection here: the leaf namespace mixes provider-route keys and env
    // names into one Set, and flags live in free prose — both make a reliable
    // stale signal impossible without false alarms. A loud miss of an ADDITION is
    // what we optimize for; a reworded doc line at worst produces a self-evident
    // red that is fixed by keeping the literal flag string in the prose.
    const missingLeaves = leaves.filter((l) => !docKeys.has(l)).sort();
    const missingFlags = longFlags.filter((f) => !flagDocumented(f, readme, configMd)).sort();

    return { leaves, flags, longFlags, missingLeaves, missingFlags };
}

function main() {
    const cmd = process.argv[2] ?? "check";
    const r = runChecks();
    console.log(`config-surface: ${r.leaves.length} leaf fields, ${r.flags.length} CLI flags (${r.longFlags.length} long)`);
    if (cmd === "report") {
        console.log("\nconfig-file leaf fields:");
        for (const l of r.leaves) console.log(`  ${l}`);
        console.log("\nCLI flags:");
        for (const f of r.flags) console.log(`  ${f}`);
        return;
    }
    if (r.missingLeaves.length) {
        console.error(`FAIL: ${r.missingLeaves.length} config-file field(s) lack a seed entry in website/config-reference/*.yaml:`);
        for (const k of r.missingLeaves) console.error(`  - ${k}`);
    }
    if (r.missingFlags.length) {
        console.error(`FAIL: ${r.missingFlags.length} CLI flag(s) not documented in README.md or CONFIGURATION.md:`);
        for (const f of r.missingFlags) console.error(`  - ${f}`);
    }
    if (cmd === "check" && (r.missingLeaves.length || r.missingFlags.length)) {
        console.error("\nDocument each before merging: add a seed entry (config field) or a reference in README.md/CONFIGURATION.md (flag). See AGENTS.md 'Configuration Surface Discipline'.");
        process.exit(1);
    }
    console.log("✓ config-surface coverage OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
