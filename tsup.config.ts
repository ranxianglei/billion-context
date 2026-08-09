import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    splitting: false,
    shims: false,
    banner: {
        // node-forge is a CommonJS dependency that calls require("crypto") etc.
        // inlined into our ESM output, esbuild's __require shim throws in an
        // ESM context where `require` is undefined. Provide a real require
        // (via createRequire) so the shim can load node built-ins. Only node
        // built-ins ever reach this path — node-forge is otherwise bundled.
        js: "import { createRequire as __biliCreateRequire } from 'node:module';\nconst require = __biliCreateRequire(import.meta.url);",
    },
});
