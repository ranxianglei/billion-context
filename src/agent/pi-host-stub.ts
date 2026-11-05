// #2186: esbuild alias target for the single runtime host import inside the
// inlined billion-context-pi-subagents bundle. The package's config-dir
// module namespace-imports @earendil-works/pi-coding-agent only to read
// CONFIG_DIR_NAME; provide its canonical ".pi" fallback explicitly so esbuild
// can resolve the export without an import-is-undefined warning. Aliasing
// the full pi agent to this stub keeps dist/agent/pi.js dependency-free,
// preserving bili's zero-runtime-dependency contract.
export const CONFIG_DIR_NAME = ".pi";
