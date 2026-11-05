// Build gate: fail if any STATIC import of "zod" survives into dist.
//
// zod is a declared runtime dependency for exactly one sanctioned consumer:
// the opencode V1 host interop (src/agent/opencode-native.ts), which loads it
// LAZILY through an opaque specifier so it resolves the HOST's zod instance
// inside opencode and degrades to proxy mode on thin installs. Everything
// else must be bundled: #3425 inlined jimp (devDependency, noExternal) whose
// module-scope `import { z } from "zod"` leaked 16 static `from"zod"` imports
// into dist/index.js and dist/agent/pi-native.js. Static imports resolve at
// module load with NO degrade path — installs that ship the package without
// its node_modules (dsh profile bare copies, thin plugin copies: the real
// dsh/pi plugin shapes) died with ERR_MODULE_NOT_FOUND and model traffic
// silently went direct, uncompressed (#3511 P0). The fix bundles zod via
// noExternal; this check keeps it bundled.
//
// Violations matched (specifier must be the bare literal "zod"):
//  - import ... from "zod"          (any static import form)
//  - export ... from "zod"
//  - require("zod")
//  - import("zod")                  (literal dynamic — esbuild would have
//                                     bundled or rewritten it; the sanctioned
//                                     lazy load goes through a variable)
//
// Bare-specifier NODE builtins are fine (node:*, fs, crypto, ...); other
// packages are inlined by noExternal, so "zod" is the only name that can
// appear here legitimately only through the sanctioned opaque path, which
// this regex cannot match.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const STATIC_ZOD = [
    /import\s*[^;(]*?from\s*(["'])zod\1/g,
    /export\s*[^;(]*?from\s*(["'])zod\1/g,
    /require\s*\(\s*(["'])zod\1\s*\)/g,
    /import\s*\(\s*(["'])zod\1\s*\)/g,
];

export function findStaticZodRefs(text) {
    const hits = [];
    for (const re of STATIC_ZOD) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const line = text.slice(0, m.index).split("\n").length;
            hits.push(`${re.source.slice(0, 40)}… line ${line}`);
        }
    }
    return hits;
}

export function checkDistExternalZod(distDir) {
    const violations = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) { walk(full); continue; }
            if (!name.endsWith(".js")) continue;
            const refs = findStaticZodRefs(readFileSync(full, "utf8"));
            if (refs.length > 0) violations.push({ file: full, refs });
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
    const violations = checkDistExternalZod(distDir);
    if (violations.length > 0) {
        for (const v of violations) {
            console.error(`dist-external-zod: ${v.file}:`);
            for (const r of v.refs.slice(0, 5)) console.error(`  ${r}`);
            if (v.refs.length > 5) console.error(`  … (+${v.refs.length - 5} more)`);
        }
        console.error(`dist-external-zod: FAIL — ${violations.reduce((n, v) => n + v.refs.length, 0)} static zod import ref(s) across ${violations.length} file(s). dist must stay self-contained: bundle zod (tsup noExternal) or load it through the sanctioned opaque lazy path (opencode V1 interop). Static zod imports crash thin installs (no node_modules) with ERR_MODULE_NOT_FOUND (#3511 P0).`);
        process.exit(1);
    }
    console.log("dist-external-zod: OK");
}
