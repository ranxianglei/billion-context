import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/mcp.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
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
    noExternal: ["acp-kernel", "fzstd", "node-forge", "tar", "undici"],
    banner: {
        // node-forge is a CommonJS dependency that calls require("crypto") etc.
        // inlined into our ESM output, esbuild's __require shim throws in an
        // ESM context where `require` is undefined. Provide a real require
        // (via createRequire) so the shim can load node built-ins. Only node
        // built-ins ever reach this path — node-forge is otherwise bundled.
        js: "import { createRequire as __biliCreateRequire } from 'node:module';\nconst require = __biliCreateRequire(import.meta.url);",
    },
});
