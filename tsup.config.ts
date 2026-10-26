import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

export default [
defineConfig({
    entry: ["src/index.ts", "src/mcp.ts", "src/claude-mcp-entry.ts", "src/claude-native-bootstrap.ts", "src/agent/pi.ts", "src/agent/pi-native.ts", "src/agent/omp.ts", "src/agent/omp-native.ts", "src/agent/opencode.ts", "src/agent/opencode-native.ts", "src/agent/dsh-acp.ts", "src/agent/dsh-native.ts", "src/agent/dsh-compaction-gate.ts", "src/kimi/native-mcp.ts", "src/kimi/bootstrap-hook.ts", "src/zcode/mcp-entry.ts", "src/zcode/bootstrap-hook.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    // Non-minified esbuild output KEEPS JSDoc comments attached to class
    // members (verified empirically against esbuild bundled with tsup 8.x):
    // undici ships class-body JSDoc like `@param {import('./client.js')}` and
    // those annotations survive into dist verbatim. Node's ESM loader ignores
    // them, but opencode's plugin loader resolves them as REAL files and dies
    // with ENOENT → the whole plugin fails to load (silent dead lane; see the
    // issue filed from #1234). minifyWhitespace makes esbuild drop all
    // non-legal comments while keeping code structure intact (no identifier
    // mangling, no syntax rewriting); legal/license footers stay via the
    // default legalComments. scripts/check-dist-import-annotations.mjs fails
    // the build if any relative import()/require() text ever reappears.
    esbuildOptions(options) {
        options.minifyWhitespace = true;
        // #2186: billion-context-pi-subagents is inlined via noExternal, and
        // its ONLY runtime host import is a namespace import of
        // @earendil-works/pi-coding-agent (config-dir reads CONFIG_DIR_NAME,
        // falling back to ".pi" when absent — the package's documented
        // degradation for aliased hosts). Alias it to a minimal stub so the
        // bundle keeps bili's zero-runtime-dependency contract; no bili entry
        // ever imports the real package.
        options.alias = { "@earendil-works/pi-coding-agent": resolve(dirname(fileURLToPath(import.meta.url)), "src/agent/pi-host-stub.ts") };
    },
    outDir: "dist",
    clean: true,
    // #3777: maps used to ship in the npm tarball (~109 MiB) with no runtime
    // consumer; keep off — local debugging only, do not commit.
    sourcemap: false,
    splitting: false,
    shims: false,
    // acp-kernel is a BUILD-TIME dependency: tsup inlines it into dist so the
    // published artifact is self-contained (zero runtime deps). Without
    // noExternal, esbuild keeps `import ... from "acp-kernel"` in dist, and
    // npm then installs acp-kernel as a runtime dep — breaking the
    // "dist/index.js is self-contained" contract (AGENTS.md §2.1). Same for
    // billion-context-pi-subagents (#2384): vendored under pi-subagents/,
    // consumed via file:, and its own build already inlines its typebox peer,
    // so its dist is self-contained too.
    // jimp (#3400/#3516): deliberately NOT inlined — its transitive dep zod
    // would otherwise be statically linked into dist/index.js & pi-native.js,
    // and installs without a node_modules tree (dsh profile bundles) die at
    // startup with ERR_MODULE_NOT_FOUND while traffic silently bypasses
    // compression. image-rescale.ts loads it lazily at first use and degrades
    // to pass-through when absent (the sharp optionalDependencies precedent).
    // Explicit external: tsup only auto-externalizes dependencies/peerDeps —
    // an optionalDependency would otherwise still be bundled.
    // Defense in depth: scripts/check-dist-external.mjs (wired into
    // `npm run build`) fails the build if ANY external bare import appears
    // in dist outside its allowlist — static forms of allowlisted lazy deps
    // included (#3511 zod, #3516 jimp, #4008 mysql2).
    external: ["jimp"],
    noExternal: ["acp-kernel", "billion-context-pi-subagents", "fzstd", "node-forge", "semver", "tar", "undici", "jsonc-parser", "ws"],
    banner: {
        // node-forge is a CommonJS dependency that calls require("crypto") etc.
        // inlined into our ESM output, esbuild's __require shim throws in an
        // ESM context where `require` is undefined. Provide a real require
        // (via createRequire) so the shim can load node built-ins. Only node
        // built-ins ever reach this path — node-forge is otherwise bundled.
        js: "import { createRequire as __biliCreateRequire } from 'node:module';\nconst require = __biliCreateRequire(import.meta.url);",
    },
}),
// #1590: dsh web-profile settings entry (dsh.client browser half). Built as a
// classic script: CJS body wrapped in window.__ModuleLoader__.load({id,
// factory}) — the banner/footer locals shadow module/exports so esbuild's CJS
// output lands inside the factory closure, whose `require` parameter resolves
// externals through dsh's module system (react stays external; nothing else
// may be required). No clean here: this runs after the main config above.
defineConfig({
    entry: { "agent/dsh-native-client": "src/agent/dsh-native-client.ts" },
    format: ["cjs"],
    target: "es2020",
    platform: "browser",
    external: ["react"],
    outDir: "dist",
    clean: false,
    splitting: false,
    shims: false,
    // Keep the .js name (not tsup's default .cjs): this is a browser classic
    // script, not a node CJS artifact, and package.json points at it as-is.
    outExtension: () => ({ js: ".js" }),
    banner: {
        // Trailing balance: `load({ id, factory: (require) => {` opens call +
        // object + arrow-body, so the footer closes all three.
        js: "window.__ModuleLoader__.load({ id: \"billion-context\", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n",
    },
    footer: {
        js: "\nreturn module.exports;\n}});",
    },
}),
];
