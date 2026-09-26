import { renderPage } from "./page.js";
import { VERSION } from "../version.js";

export {
    handleConfigGet,
    handleConfigPut,
    readProviders,
    readUpstreamSettings,
} from "./api.js";

export { buildOverview, buildSessionList, buildSessionDetail } from "./sessions-data.js";

export function renderUI(origin: string): string {
    // #1426 fix: reuse the bundle-safe VERSION from src/version.ts — resolving
    // package.json relative to import.meta.url broke once tsup bundles this
    // module into dist/index.js (two levels up from dist/ misses the repo).
    return renderPage(origin, VERSION);
}
