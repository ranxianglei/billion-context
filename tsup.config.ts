import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/mcp.ts", "src/claude-native-bootstrap.ts", "src/agent/pi.ts", "src/agent/pi-native.ts", "src/agent/omp.ts", "src/agent/omp-native.ts", "src/agent/opencode.ts", "src/agent/opencode-native.ts", "src/agent/dsh-acp.ts", "src/agent/dsh-native.ts", "src/kimi/native-mcp.ts", "src/kimi/bootstrap-hook.ts", "src/zcode/mcp-entry.ts", "src/zcode/bootstrap-hook.ts"],
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
    },
    outDir: "dist",
    clean: true,
    sourcemap: true,
    splitting: false,
    shims: false,
    // acp-kernel is a BUILD-TIME dependency: tsup inlines it into dist so the
    // published artifact is self-contained (zero runtime deps). Without
    // noExternal, esbuild keeps `import ... from "acp-kernel"` in dist, and
    // npm then installs acp-kernel as a runtime dep — breaking the
    // "dist/index.js is self-contained" contract (AGENTS.md §2.1).
    noExternal: ["acp-kernel", "fzstd", "node-forge", "semver", "tar", "undici", "jsonc-parser"],
    // sharp is an OPTIONAL runtime dependency (native module): it must stay
    // EXTERNAL so dist keeps a real lazy `import("sharp")` that Node resolves
    // at runtime from node_modules — missing ⇒ clean pass-through, and the
    // bundle stays independent of which sharp version npm resolved (the caret
    // range in optionalDependencies would otherwise bake that version into
    // dist and break reproducible builds). tsup does not auto-externalize
    // optionalDependencies, hence the explicit entry.
    external: ["sharp"],
    banner: {
        // node-forge is a CommonJS dependency that calls require("crypto") etc.
        // inlined into our ESM output, esbuild's __require shim throws in an
        // ESM context where `require` is undefined. Provide a real require
        // (via createRequire) so the shim can load node built-ins. Only node
        // built-ins ever reach this path — node-forge is otherwise bundled.
        js: "import { createRequire as __biliCreateRequire } from 'node:module';\nconst require = __biliCreateRequire(import.meta.url);",
    },
});
