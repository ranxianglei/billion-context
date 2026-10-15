/** The Gemini request carries the model in the URL path, never in the body
 *  (`POST /v1beta/models/gemini-3.8-flash:streamGenerateContent`). Every
 *  model-keyed decision (window resolution, thresholds, the summarization
 *  adapter, degenerate-turn analysis) reads it from here instead of
 *  `parsed.model`. Returns undefined when the path carries no model or an
 *  undecodable one. */
export function googleModelFromPath(urlPath: string): string | undefined {
    const m = /\/models\/([^/:?]+):(?:streamGenerateContent|generateContent|countTokens)\b/.exec(urlPath);
    if (!m || !m[1]) return undefined;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}
