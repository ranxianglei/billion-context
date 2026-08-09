import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./page.js";

export {
    handleCodexHistoryGet,
    handleCodexHistoryRepair,
    handleConfigGet,
    handleConfigPut,
    readProviders,
    readUpstreamSettings,
} from "./api.js";

function version(): string {
    try {
        const here = fileURLToPath(import.meta.url);
        const packagePath = join(dirname(here), "..", "..", "package.json");
        return (JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string }).version ?? "dev";
    } catch {
        return "dev";
    }
}

export function renderUI(origin: string): string {
    return renderPage(origin, version());
}
