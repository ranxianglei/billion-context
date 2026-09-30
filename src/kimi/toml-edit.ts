// Line-surgery for ~/.kimi-code/config.toml backing kimi native mode (#963).
// Safe because kimi v2 hot-reloads config.toml (watch on by default) and its
// own writeback is line-surgical per domain — our block survives login/logout/
// catalog refresh as long as it uses its own provider name + model alias
// (the refresh orchestrator preserves user-owned entries).

export const KIMI_PROVIDER = "bili";
export const KIMI_ALIAS = "bili-kimi";
export const KIMI_MANAGED_BEGIN = "# bili begin (managed by billion-context — `bili plugin install kimi`)";
const KIMI_MANAGED_END = "# bili end";
const KIMI_PREV_MODEL_KEY = "# bili prev-default-model";
const KIMI_DEFAULT_UPSTREAM = "https://api.kimi.com/coding/v1";
const KIMI_CODE_PROVIDER = "managed:kimi-code";

interface LineDoc {
    lines: string[];
    eol: string;
}

function openDoc(text: string): LineDoc {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return { lines: text.split(/\r?\n/), eol };
}

function closeDoc(doc: LineDoc): string {
    while (doc.lines.length > 1 && doc.lines[doc.lines.length - 1].trim() === "") doc.lines.pop();
    return doc.lines.join(doc.eol) + doc.eol;
}

// Split a TOML table header into path parts, honoring quoted segments
// (`[providers."managed:kimi-code"]` → ["providers", "managed:kimi-code"]).
function tomlPathParts(header: string): string[] {
    const parts: string[] = [];
    let cur = "";
    let dq = false;
    let sq = false;
    for (const ch of header) {
        if (ch === '"' && !sq) dq = !dq;
        else if (ch === "'" && !dq) sq = !sq;
        else if (ch === "." && !dq && !sq) { parts.push(cur); cur = ""; }
        else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim());
}

function headerParts(line: string): string[] | undefined {
    const m = /^\[\[?(.+?)\]\]?\s*(?:#.*)?$/.exec(line.trim());
    if (!m) return undefined;
    return tomlPathParts(m[1]);
}

function keyValue(line: string): { key: string; strVal?: string; numVal?: number } | undefined {
    const l = line.trim();
    if (!l || l.startsWith("#") || l.startsWith("[")) return undefined;
    const strMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(l);
    if (strMatch) return { key: strMatch[1], strVal: strMatch[2] !== undefined ? strMatch[2] : strMatch[3] };
    const numMatch = /^([A-Za-z0-9_.-]+)\s*=\s*([0-9]+)\b/.exec(l);
    if (numMatch) return { key: numMatch[1], numVal: Number(numMatch[2]) };
    // Inline tables / arrays ({ x-bili-plugin = "kimi" }, ["a"]) have no scalar
    // value — key-only, so callers can still locate/replace the line.
    const tblMatch = /^([A-Za-z0-9_.-]+)\s*=\s*[{[]/.exec(l);
    if (tblMatch) return { key: tblMatch[1] };
    return undefined;
}

/** Remove the managed block (markers inclusive). Throws on a half-present
 *  block — a lone marker means manual tampering, and guessing is worse than
 *  refusing. */
export function stripKimiManagedBlock(text: string): { text: string; hadBlock: boolean } {
    const doc = openDoc(text);
    let start = -1;
    let end = -1;
    for (let i = 0; i < doc.lines.length; i++) {
        const t = doc.lines[i].trim();
        if (t === KIMI_MANAGED_BEGIN) start = i;
        else if (t === KIMI_MANAGED_END) {
            if (start >= 0) {
                end = i;
                break;
            }
            throw new Error("config.toml contains a stray \"# bili end\" marker outside a managed block — fix it manually or run `bili plugin remove kimi`");
        }
    }
    if (start >= 0 && end < 0) throw new Error("config.toml managed block is truncated (missing \"# bili end\") — fix it manually or run `bili plugin remove kimi`");
    if (start < 0) return { text, hadBlock: false };
    // drop one blank separator line left behind above the block
    const cutFrom = start > 0 && doc.lines[start - 1].trim() === "" ? start - 1 : start;
    doc.lines.splice(cutFrom, end - cutFrom + 1);
    return { text: closeDoc(doc), hadBlock: true };
}

export interface KimiRouteState {
    readonly port: number;
    readonly upstream: string;
    readonly modelId: string;
    readonly contextWindow?: number;
    readonly maxOutput?: number;
    readonly authLines: string[];
}

export function kimiProxiedBaseUrl(port: number, upstream: string): string {
    return `http://127.0.0.1:${port}/bili/${upstream.replace(/\/+$/, "")}`;
}

export function extractBiliUpstream(baseUrl: string): string | undefined {
    const m = /^https?:\/\/[^/]+\/bili\/(https?:\/\/.+)$/.exec(baseUrl);
    return m?.[1]?.replace(/\/+$/, "");
}

/** Render the managed block. `authLines` are spliced verbatim between the
 *  base_url key and the next table header — the resolver owns their meaning
 *  (an `api_key` line, an `api_key_env` line, or `api_key = ""` + an
 *  `[providers.bili.oauth]` sub-table copied from the active provider). */
function renderKimiManagedBlock(state: KimiRouteState, prevDefaultModel: string): string {
    const out: string[] = [];
    out.push(KIMI_MANAGED_BEGIN);
    out.push(`# Routes ${KIMI_ALIAS} through the local bili proxy. Managed by `);
    out.push("# billion-context — edits here are overwritten; uninstall restores your config.");
    out.push(`[providers.${KIMI_PROVIDER}]`);
    out.push('type = "kimi"');
    out.push(`base_url = "${kimiProxiedBaseUrl(state.port, state.upstream)}"`);
    for (const line of state.authLines) out.push(line);
    out.push("");
    out.push(`[models.${KIMI_ALIAS}]`);
    out.push(`provider = "${KIMI_PROVIDER}"`);
    out.push(`model = "${state.modelId}"`);
    if (state.contextWindow !== undefined) out.push(`max_context_size = ${state.contextWindow}`);
    if (state.maxOutput !== undefined) out.push(`max_output_size = ${state.maxOutput}`);
    out.push("");
    out.push(`${KIMI_PREV_MODEL_KEY} = ${prevDefaultModel === "" ? "ABSENT" : JSON.stringify(prevDefaultModel)}`);
    out.push(KIMI_MANAGED_END);
    return out.join("\n");
}

function firstTableHeaderIndex(lines: string[]): number {
    for (let i = 0; i < lines.length; i++) if (headerParts(lines[i])) return i;
    return lines.length;
}

function topLevelDefaultModel(lines: string[], headerAt: number): { index: number; value: string } | undefined {
    for (let i = 0; i < headerAt; i++) {
        const kv = keyValue(lines[i]);
        if (kv?.key === "default_model" && kv.strVal !== undefined) return { index: i, value: kv.strVal };
    }
    return undefined;
}

function readCarriedDefaultModel(text: string): string | undefined {
    for (const line of text.split(/\r?\n/)) {
        const m = new RegExp(`^\\s*${KIMI_PREV_MODEL_KEY}\\s*=\\s*(.+?)\\s*$`).exec(line.trim());
        if (m) return m[1] === "ABSENT" ? "" : m[1].replace(/^["']|["']$/g, "");
    }
    return undefined;
}

/** Strip any previous managed block, point `default_model` at our alias
 *  (recording the previous value inside the block), and append a fresh block.
 *  Refuses to write when the user already owns [providers.bili] or
 *  [models.bili-kimi] outside the markers. */
export function applyKimiManagedConfig(text: string, state: KimiRouteState): string {
    const stripped = stripKimiManagedBlock(text);
    const doc = openDoc(stripped.text);
    for (const line of doc.lines) {
        const parts = headerParts(line);
        if (parts && ((parts[0] === "providers" && parts[1] === KIMI_PROVIDER) || (parts[0] === "models" && parts[1] === KIMI_ALIAS))) {
            throw new Error(`config.toml already defines [${parts.slice(0, 2).join(".")}] outside the bili managed block — rename it, or run \`bili plugin remove kimi\` first`);
        }
    }
    const headerAt = firstTableHeaderIndex(doc.lines);
    const existing = topLevelDefaultModel(doc.lines, headerAt);
    let prevDefaultModel = existing?.value ?? "";
    if (stripped.hadBlock) {
        // Re-apply (a new session bootstraps again): carry the ORIGINAL
        // pre-native value forward — otherwise every bootstrap degrades it to
        // our own alias and unroute would leave the user stuck on bili-kimi.
        // A default_model the user switched to by hand during native mode is
        // their latest intent: leave it untouched (routing stays off until
        // they pick us again), never yank it back to our alias (§7.3).
        const carried = readCarriedDefaultModel(text);
        if (carried !== undefined) prevDefaultModel = carried;
        if (existing && existing.value !== KIMI_ALIAS) {
            if (doc.lines[doc.lines.length - 1].trim() !== "") doc.lines.push("");
            for (const line of renderKimiManagedBlock(state, prevDefaultModel).split("\n")) doc.lines.push(line);
            return closeDoc(doc);
        }
    }
    if (existing) doc.lines[existing.index] = `default_model = "${KIMI_ALIAS}"`;
    else doc.lines.splice(0, 0, `default_model = "${KIMI_ALIAS}"`);
    if (doc.lines[doc.lines.length - 1].trim() !== "") doc.lines.push("");
    for (const line of renderKimiManagedBlock(state, prevDefaultModel).split("\n")) doc.lines.push(line);
    return closeDoc(doc);
}

/** Reverse of applyKimiManagedConfig: strip the block and restore the
 *  pre-install `default_model` recorded inside it. A user who changed
 *  default_model by hand during native mode keeps their value unless it is
 *  still our alias. */
export function unrouteKimiConfig(text: string): string {
    const doc = openDoc(text);
    let start = -1;
    let end = -1;
    for (let i = 0; i < doc.lines.length; i++) {
        const t = doc.lines[i].trim();
        if (t === KIMI_MANAGED_BEGIN) start = i;
        else if (t === KIMI_MANAGED_END) {
            if (start >= 0) {
                end = i;
                break;
            }
        }
    }
    if (start < 0 || end < 0) return text;
    let prev: string | undefined;
    for (let i = start; i <= end; i++) {
        const m = new RegExp(`^\\s*${KIMI_PREV_MODEL_KEY}\\s*=\\s*(.+?)\\s*$`).exec(doc.lines[i]);
        if (m) {
            prev = m[1] === "ABSENT" ? "" : m[1].replace(/^["']|["']$/g, "");
            break;
        }
    }
    const cutFrom = start > 0 && doc.lines[start - 1].trim() === "" ? start - 1 : start;
    doc.lines.splice(cutFrom, end - cutFrom + 1);
    const headerAt = firstTableHeaderIndex(doc.lines);
    const existing = topLevelDefaultModel(doc.lines, headerAt);
    if (prev === undefined) return closeDoc(doc);
    // A manual change made DURING native mode is the user's latest intent —
    // only our own alias (or no line at all) yields to the recorded value.
    if (existing && existing.value !== KIMI_ALIAS) return closeDoc(doc);
    if (prev === "") {
        if (existing) doc.lines.splice(existing.index, 1);
        return closeDoc(doc);
    }
    if (existing) doc.lines[existing.index] = `default_model = "${prev}"`;
    else doc.lines.splice(0, 0, `default_model = "${prev}"`);
    return closeDoc(doc);
}

type KimiRouteResolution =
    | {
        readonly ok: true;
        readonly upstream: string;
        readonly modelId: string;
        readonly alias: string;
        readonly contextWindow?: number;
        readonly maxOutput?: number;
        readonly authLines: string[];
        readonly authSource: string;
    }
    | { readonly ok: false; readonly reason: string };

interface ProviderScan {
    baseUrl?: string;
    envBaseUrl?: string;
    apiKeyLine?: string;
    apiKeyEnvLine?: string;
    oauthLines: string[];
}

interface ModelScan {
    modelId?: string;
    window?: number;
    maxOutput?: number;
    baseUrl?: string;
    provider?: string;
}

function scanText(text: string): { defaultModel?: string; providers: Map<string, ProviderScan>; models: Map<string, ModelScan> } {
    const providers = new Map<string, ProviderScan>();
    const models = new Map<string, ModelScan>();
    let defaultModel: string | undefined;
    let parts: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const h = headerParts(rawLine);
        if (h) {
            parts = h;
            continue;
        }
        const kv = keyValue(rawLine);
        if (!kv) continue;
        if (parts.length === 0) {
            if (kv.key === "default_model" && kv.strVal !== undefined) defaultModel = kv.strVal;
            continue;
        }
        if (parts[0] === "providers" && parts[1]) {
            const prov = providers.get(parts[1]) ?? { oauthLines: [] };
            if (parts.length === 2) {
                if (kv.key === "base_url" && kv.strVal !== undefined) prov.baseUrl = kv.strVal;
                else if (kv.key === "api_key" && kv.strVal !== undefined && kv.strVal !== "") prov.apiKeyLine = rawLine.trim();
                else if (kv.key === "api_key_env" && kv.strVal !== undefined) prov.apiKeyEnvLine = rawLine.trim();
            } else if (parts.length === 3 && parts[2] === "env" && kv.strVal !== undefined && /_BASE_URL$/.test(kv.key)) {
                prov.envBaseUrl = kv.strVal;
            } else if (parts.length === 3 && parts[2] === "oauth") {
                prov.oauthLines.push(rawLine.trim());
            }
            providers.set(parts[1], prov);
        } else if (parts[0] === "models" && parts[1]) {
            const st = models.get(parts[1]) ?? {};
            if (parts.length === 2) {
                if (kv.key === "model" && kv.strVal !== undefined) st.modelId = kv.strVal;
                else if (kv.key === "provider" && kv.strVal !== undefined) st.provider = kv.strVal;
                else if (kv.key === "max_context_size" && kv.numVal !== undefined) st.window = kv.numVal;
                else if (kv.key === "max_output_size" && kv.numVal !== undefined) st.maxOutput = kv.numVal;
                else if (kv.key === "base_url" && kv.strVal !== undefined) st.baseUrl = kv.strVal;
            }
            models.set(parts[1], st);
        }
    }
    return { defaultModel, providers, models };
}

function authLinesFor(prov: ProviderScan | undefined): string[] | undefined {
    if (!prov) return undefined;
    if (prov.oauthLines.length > 0) return [`api_key = ""`, `[providers.${KIMI_PROVIDER}.oauth]`, ...prov.oauthLines];
    if (prov.apiKeyLine) return [prov.apiKeyLine];
    if (prov.apiKeyEnvLine) return [prov.apiKeyEnvLine];
    return undefined;
}

/** Resolve where the ACTIVE model route points today and what credentials
 *  back it, so the managed block can clone both. `ok: false` with a reason
 *  when routing is impossible — callers must skip the rewrite, never guess. */
export function resolveKimiRoute(text: string, env: NodeJS.ProcessEnv): KimiRouteResolution {
    const scan = scanText(text);
    const alias = scan.defaultModel;
    if (!alias) return { ok: false, reason: "no default_model set in config.toml" };

    const envOverride = env.KIMI_CODE_BASE_URL?.trim().replace(/\/+$/, "");

    if (alias === KIMI_ALIAS) {
        // Idempotent re-apply: recover the original upstream embedded in our
        // own base_url plus the auth sub-table we cloned on first apply.
        const selfProv = scan.providers.get(KIMI_PROVIDER);
        const selfModel = scan.models.get(KIMI_ALIAS);
        const upstream = selfProv?.baseUrl ? extractBiliUpstream(selfProv.baseUrl) : undefined;
        const auth = authLinesFor(selfProv);
        if (!auth) return { ok: false, reason: "managed block lost its credentials — run `bili plugin remove kimi` and reinstall" };
        if (!upstream) return { ok: false, reason: "managed block base_url no longer embeds a bili route — run `bili plugin remove kimi` and reinstall" };
        return {
            ok: true,
            upstream,
            modelId: selfModel?.modelId ?? alias,
            alias,
            contextWindow: selfModel?.window,
            maxOutput: selfModel?.maxOutput,
            authLines: auth,
            authSource: KIMI_PROVIDER,
        };
    }

    const modelSection = scan.models.get(alias);
    const providerName = modelSection?.provider ?? KIMI_CODE_PROVIDER;
    const prov = scan.providers.get(providerName);

    const upstream = envOverride
        ?? prov?.baseUrl?.replace(/\/+$/, "")
        ?? prov?.envBaseUrl?.replace(/\/+$/, "")
        ?? modelSection?.baseUrl?.replace(/\/+$/, "")
        ?? KIMI_DEFAULT_UPSTREAM;

    const auth = authLinesFor(prov);
    if (!auth) {
        return {
            ok: false,
            reason: prov === undefined
                ? `provider "${providerName}" is not defined in config.toml — log in to kimi first ('kimi login')`
                : `provider "${providerName}" has no api_key / api_key_env / oauth`,
        };
    }
    return {
        ok: true,
        upstream,
        modelId: modelSection?.modelId ?? alias,
        alias,
        contextWindow: modelSection?.window,
        maxOutput: modelSection?.maxOutput,
        authLines: auth,
        authSource: providerName,
    };
}

/** Add/refresh `custom_headers = { x-bili-plugin = "kimi" }` inside our
 *  managed [providers.bili] section — the plugin-mode stamp. Written only
 *  after the ACP tool list is known good, so round 1 rides wire mode. */
export function stampKimiPluginHeader(text: string): string {
    const doc = openDoc(text);
    let start = -1;
    for (let i = 0; i < doc.lines.length; i++) if (doc.lines[i].trim() === KIMI_MANAGED_BEGIN) { start = i; break; }
    if (start < 0) return text;
    let sectionAt = -1;
    for (let i = start + 1; i < doc.lines.length; i++) {
        const t = doc.lines[i].trim();
        if (t === KIMI_MANAGED_END) break;
        const parts = headerParts(doc.lines[i]);
        if (parts && parts[0] === "providers" && parts[1] === KIMI_PROVIDER) { sectionAt = i; break; }
    }
    if (sectionAt < 0) return text;
    const line = 'custom_headers = { x-bili-plugin = "kimi" }';
    for (let i = sectionAt + 1; i < doc.lines.length; i++) {
        const kv = keyValue(doc.lines[i]);
        if (kv === undefined && headerParts(doc.lines[i]) !== undefined) break;
        if (kv?.key === "custom_headers") { doc.lines[i] = line; return closeDoc(doc); }
    }
    doc.lines.splice(sectionAt + 1, 0, line);
    return closeDoc(doc);
}
