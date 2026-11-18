/** #1420: minimal safe Markdown → HTML for server-rendered session handoff
 *  documents and bundled articles. The renderer lives in web/mdrender.ts
 *  (single implementation, shared with the browser IIFE — see there for the
 *  escape-first/XSS-safety and dep-free rationale). This wrapper keeps the
 *  historical import surface. */
import { makeMdRender } from "./mdrender.js";

const md = makeMdRender();

export function markdownToHtml(mdSource: string): string {
    return md.render(mdSource);
}
