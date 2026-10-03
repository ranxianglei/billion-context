import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGE_NAME_CONST = "billion-context";

// The proxy's own identity, read from package.json at runtime — works in both
// dev (tsx: src/** → repo root) and bundled (tsup: dist/**/*.js → package
// root). Walks UP from the module's directory so nested entries (dist/agent/*)
// resolve too, and accepts only the package named "billion-context" so an
// unrelated ancestor package.json (monorepo roots, stray copies) can never
// supply a foreign version/name. Single source for the CLI banner, the /acp
// panel header, and the acp_status surface-meta host line.
function readPkgField(field: string, fallback: string): string {
    try {
        let dir = path.dirname(fileURLToPath(import.meta.url));
        for (let i = 0; i < 6; i++) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
            } catch {
                dir = path.dirname(dir);
                continue;
            }
            if (parsed !== null && typeof parsed === "object" && (parsed as Record<string, unknown>).name === PACKAGE_NAME_CONST) {
                const v = (parsed as Record<string, unknown>)[field];
                return typeof v === "string" ? v : fallback;
            }
            dir = path.dirname(dir);
        }
        return fallback;
    } catch {
        return fallback;
    }
}

export const VERSION = readPkgField("version", "dev");
export const PACKAGE_NAME = readPkgField("name", "billion-context");
