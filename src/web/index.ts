import { renderPage } from "./page.js";
import { VERSION, BUILD_COMMIT } from "../version.js";

export {
    handleConfigGet,
    handleConfigPut,
    handlePricingGet,
    handleSummaryCredentialPut,
    readProviders,
    readUpstreamSettings,
} from "./api.js";

export { buildOverview, buildSessionList, buildSessionPage, buildSessionDetail, buildSessionTree, buildBlockContent, buildMessageContent, hiddenEmptyCount } from "./sessions-data.js";
export type { BlockContentLookup, BlockContentView, MessageContentLookup, WebSessionTreeNode } from "./sessions-data.js";

export function renderUI(origin: string, opts?: { embed?: boolean; theme?: "light" | "dark" }): string {
    // #1426 fix: reuse the bundle-safe VERSION from src/version.ts — resolving
    // package.json relative to import.meta.url broke once tsup bundles this
    // module into dist/index.js (two levels up from dist/ misses the repo).
    // #2321: opts.embed renders the frameless face for hosts that embed the UI
    // in an iframe (the dsh settings panel).
    // #2559: opts.theme pins the palette for hosts whose app-level theme is
    // invisible to the framed document's prefers-color-scheme.
    const theme = opts?.theme === "light" || opts?.theme === "dark" ? opts.theme : undefined;
    return renderPage(origin, `${VERSION} (${BUILD_COMMIT})`, opts?.embed === true, theme);
}
