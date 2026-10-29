// Type declarations for tests/test-sandbox-env.mjs (#5116). The helper stays
// plain .mjs because preload-storage-baseline.mjs loads it BEFORE tsx
// registers; this pairing file keeps TS tests importing it fully typed.

export const SANDBOXED_XDG_KEYS: readonly string[];

interface SandboxXdgOptions {
    prefix?: string;
    baseDir?: string;
}

interface SandboxXdgResult {
    root: string | undefined;
    applied: Record<string, string>;
}

export function sandboxXdgEnv(
    env: Record<string, string | undefined>,
    opts?: SandboxXdgOptions,
): SandboxXdgResult;
