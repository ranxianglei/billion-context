import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFile } from "../paths.js";
import {
    collectNamedProviders,
    loadNamedProviders,
    parseBiliConfig,
    parseCacheKeepaliveSettings,
    parseCompressSettings,
    parseNamedProviderRecipe,
    parseRouteEntry,
    parseUpstreamProxyMode,
    passthroughState,
    rejectLegacyRoute,
    type UpstreamProxyMode,
} from "../config.js";
import { log } from "../logger.js";
import { validateHttpProxy } from "../upstream-proxy.js";
import { SummaryCredentialStore, type SummaryCredentialState } from "../external-summary-credentials.js";
import { parseExternalSummaryChain, expandExternalSummaryChain } from "../external-summary-settings.js";
import { agentProviderRecipes, agentRegistryStatus } from "../agent-providers.js";

type ConfigShape = Record<string, unknown> & {
    providers?: Record<string, unknown>;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
};

// #3572: parse bili's own config file through the SAME tolerant parser the runtime
// loader uses (loadConfigFile → parseBiliConfig), else a JSONC config that works at
// runtime would show "not valid JSON" here and block every PUT. A genuinely malformed
// file still throws — that is what keeps the PUT-block guard in configParseError honest.
function readConfigRaw(): { value: unknown; error: string | null } {
    if (!existsSync(configFile())) return { value: undefined, error: null };
    let raw: string;
    try { raw = readFileSync(configFile(), "utf8").replace(/^\uFEFF/, ""); }
    catch { return { value: undefined, error: null }; }
    try { return { value: parseBiliConfig(raw), error: null }; }
    catch (e) { return { value: undefined, error: String(e) }; }
}

function readConfig(): ConfigShape {
    const { value } = readConfigRaw();
    return value && typeof value === "object" && !Array.isArray(value) ? value as ConfigShape : {};
}

/** The config file exists on disk but does not parse as JSON/JSONC (genuinely broken
 *  syntax, not just comments/trailing commas which are valid JSONC per #3572). Distinct
 *  from "missing": a broken file must never be silently rebuilt from {} by a PUT — that
 *  would wipe every field the loader could not read. Only real syntax errors block it. */
function configParseError(): string | null {
    if (!existsSync(configFile())) return null;
    const { value, error } = readConfigRaw();
    if (value && typeof value === "object" && !Array.isArray(value)) return null;
    return `config file is not valid JSON: ${configFile()}${error ? ` (${error})` : ""}`;
}

/** Raw inline `providers` block exactly as written in the config file. The
 *  Web UI edits it verbatim (JSON textarea round-trip), so this must NOT be
 *  the parsed/merged route table: parsing would drop named-entry identity
 *  fields (`bind`, `compactionOptIn`) and merging would leak external
 *  ACP_PROVIDERS entries that a save cannot persist (#1469). */
export function readProviders(): Record<string, unknown> {
    const providers = readConfig().providers;
    return providers && typeof providers === "object" && !Array.isArray(providers) ? providers : {};
}

export function readUpstreamSettings(): { mode: UpstreamProxyMode; proxy?: string } {
    const config = readConfig();
    const proxy = typeof config.upstreamProxy === "string" && config.upstreamProxy.trim()
        ? config.upstreamProxy.trim()
        : undefined;
    return {
        mode: parseUpstreamProxyMode(config.upstreamProxyMode ?? (proxy ? "manual" : undefined)),
        ...(proxy ? { proxy } : {}),
    };
}

function atomicWriteConfig(config: ConfigShape): void {
    const filePath = configFile();
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(tempPath, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify(config, null, 2) + "\n", "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(tempPath, filePath);
    } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(tempPath); } catch { }
        throw error;
    }
}

export async function handleConfigGet(res: ServerResponse): Promise<void> {
    const upstream = readUpstreamSettings();
    const config = readConfig();
    const rawCompress = config.compress && typeof config.compress === "object" ? config.compress as Record<string, unknown> : undefined;
    const credentialStatus: Record<string, boolean> = {};
    // #3488: additive five-state view (missing vs invalid value vs unreadable
    // store) alongside the legacy boolean record scripts already consume.
    const credentialDetail: Record<string, SummaryCredentialState> = {};
    let hideInvalidSummary = false;
    // Disabled chains skip strict target validation (an inert chain must not
    // brick the config view), so surface credential status from the raw
    // target list when the parsed chain carries no targets.
    const rawCredentialRefs = (value: unknown): string[] => {
        const targets = (value && typeof value === "object" ? (value as { targets?: unknown }).targets : undefined);
        if (!Array.isArray(targets)) return [];
        return [...new Set(targets.filter((item): item is { credentialRef: string } =>
            !!item && typeof item === "object" && typeof (item as { credentialRef?: unknown }).credentialRef === "string")
            .map((item) => item.credentialRef))];
    };
    if (rawCompress?.externalSummary !== undefined) {
        try {
            const chain = parseExternalSummaryChain(rawCompress.externalSummary);
            // Credential status now comes from the named recipes the chain
            // references (refs themselves carry no credential). Legacy
            // inline-target files still surface their refs via the raw scan.
            const refs = chain.targets.length > 0
                ? Object.values(loadNamedProviders()).flatMap((recipe) => recipe.credentialRef !== undefined ? [`secret:${recipe.credentialRef}`] : recipe.apiKeyEnv !== undefined ? [`env:${recipe.apiKeyEnv}`] : [])
                : rawCredentialRefs(rawCompress.externalSummary);
            const store = new SummaryCredentialStore();
            for (const ref of refs) {
                const state = store.status(ref);
                credentialStatus[ref] = state === "configured";
                credentialDetail[ref] = state;
            }
        } catch {
            // A manually edited invalid block can contain inline credentials.
            // Never echo that block through either structured or raw config GET.
            config.compress = { ...rawCompress, externalSummary: { invalid: true } };
            hideInvalidSummary = true;
        }
    }
    const parseError = configParseError();
    if (parseError) log("warn", `[acp-web] ${parseError} — showing empty view; PUT is blocked until fixed`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        path: configFile(),
        providers: readProviders(),
        upstreamProxy: upstream.proxy ?? null,
        upstreamProxyMode: upstream.mode,
        compress: config.compress ?? null,
        externalSummaryCredentials: credentialStatus,
        externalSummaryCredentialStatus: credentialDetail,
        agentProviders: agentRegistryStatus(),
        passthrough: passthroughState(process.env),
        ...(existsSync(configFile()) ? { raw: hideInvalidSummary ? JSON.stringify(config, null, 2) : readFileSync(configFile(), "utf8") } : {}),
        ...(parseError ? { parseError } : {}),
    }, null, 2));
}

export async function handleSummaryCredentialPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJsonBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sendError(res, 400, "expected credential object");
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "name" && key !== "key") || typeof body.name !== "string"
        || (body.key !== null && typeof body.key !== "string")) return sendError(res, 400, "expected name and key (null deletes)");
    try {
        new SummaryCredentialStore().set(body.name, body.key as string | null);
    } catch { return sendError(res, 400, "could not save credential; check the name, key and private store permissions"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, configured: body.key !== null }));
}

export async function handleConfigPut(
    req: IncomingMessage,
    res: ServerResponse,
    onChanged?: () => void,
    biliPort: number = 8787,
): Promise<void> {
    const raw = await readJsonBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sendError(res, 400, "expected JSON object");
    // Guard the unreadable-config footgun: if the on-disk file exists but
    // does not parse, merging into an empty {} and saving would silently
    // drop every field the JSON loader could not read. Refuse instead —
    // the user fixes the syntax error by hand (the GET view surfaces
    // parseError with the path) and PUT works again.
    const parseError = configParseError();
    if (parseError) return sendError(res, 409, `${parseError} — fix the syntax error by hand, then retry; refusing to overwrite`);
    const body = raw as Record<string, unknown>;
    const hasProviders = Object.prototype.hasOwnProperty.call(body, "providers");
    const hasProxy = Object.prototype.hasOwnProperty.call(body, "upstreamProxy");
    const hasMode = Object.prototype.hasOwnProperty.call(body, "upstreamProxyMode");
    const hasCompress = Object.prototype.hasOwnProperty.call(body, "compress");
    const hasPassthrough = Object.prototype.hasOwnProperty.call(body, "passthrough");
    const hasDsh = Object.prototype.hasOwnProperty.call(body, "dsh");
    const hasFile = Object.prototype.hasOwnProperty.call(body, "file");
    if (!hasProviders && !hasProxy && !hasMode && !hasCompress && !hasPassthrough && !hasDsh && !hasFile) return sendError(res, 400, "expected providers, upstream proxy, compress, passthrough, or the full config file");
    // Raw whole-file save (web config card): validate the known fields exactly like the
    // structured payload, then replace the ENTIRE config — preserving unknown keys such
    // as promptPack/ccr that per-field PUTs cannot touch.
    if (hasFile) {
        if (typeof body.file !== "string") return sendError(res, 400, "file must be a string (raw config JSON text)");
        let next: ConfigShape;
        try {
            const p = parseBiliConfig(body.file);
            if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("top level must be a JSON object");
            // #3666: legacy dsh.* / top-level allowDshCompaction keys are no
            // longer relocated — whole-file saves preserve them verbatim (the
            // load path warns once that they are ignored).
            next = p as ConfigShape;
        } catch (error) {
            return sendError(res, 400, `file is not valid JSON: ${String(error)}`);
        }
        if (next.providers !== undefined) {
            if (typeof next.providers !== "object" || Array.isArray(next.providers)) return sendError(res, 400, "providers must be an object");
            for (const [url, value] of Object.entries(next.providers as Record<string, unknown>)) {
                let route: ReturnType<typeof parseRouteEntry>;
                try { route = parseRouteEntry(value); } catch (error) {
                    return sendError(res, 400, `invalid provider entry for ${url || "(empty)"}: ${String(error)}`);
                }
                if (!url || !route) return sendError(res, 400, `invalid provider entry: ${url || "(empty)"}`);
                // Named entries may carry a dialing recipe (baseUrl/api/...) —
                // validate its shape at save time too, so the chain
                // references below can only fail on dangling names.
                if (!/^https?:\/\//.test(url)) {
                    try { parseNamedProviderRecipe(value); } catch (error) {
                        return sendError(res, 400, `invalid recipe on named provider "${url}": ${String(error)}`);
                    }
                }
                try { validateHttpProxy(route.proxy, biliPort); } catch (error) { return sendError(res, 400, `invalid provider proxy for ${url}: ${String(error)}`); }
            }
        }
        if (next.upstreamProxy !== undefined) {
            if (next.upstreamProxy !== null && typeof next.upstreamProxy !== "string") return sendError(res, 400, "upstreamProxy must be a string or null");
            try { validateHttpProxy(typeof next.upstreamProxy === "string" ? next.upstreamProxy.trim() || undefined : undefined, biliPort); } catch (error) { return sendError(res, 400, String(error)); }
        }
        if (next.upstreamProxyMode !== undefined && (typeof next.upstreamProxyMode !== "string" || !["auto", "manual", "direct"].includes(next.upstreamProxyMode))) return sendError(res, 400, "upstreamProxyMode must be auto, manual, or direct");
        if (next.compress !== undefined && next.compress !== null && parseCompressSettings(next.compress) === undefined) return sendError(res, 400, "invalid compress settings");
        if (next.cacheKeepalive !== undefined && next.cacheKeepalive !== null && parseCacheKeepaliveSettings(next.cacheKeepalive) === undefined) return sendError(res, 400, "invalid cacheKeepalive settings");
        // The chain references named recipes — validate the expansion against
        // the providers table BEING SAVED (not the on-disk one), so a save
        // cannot strand the config on a dangling reference. Only enabled
        // chains are strict (a disabled chain is inert by contract).
        if (next.compress !== undefined && next.compress !== null) {
            const parsed = parseCompressSettings(next.compress);
            if (parsed?.externalSummary?.enabled === true) {
                // #2336: agent-registry recipes are a fallback layer — a
                // chain may reference them without duplicating the dialing
                // config in the file (file recipes win on name collision,
                // matching the request-path merge order).
                const fileRecipes = next.providers !== undefined && typeof next.providers === "object" && !Array.isArray(next.providers)
                    ? collectNamedProviders(next.providers as Record<string, unknown>)
                    : loadNamedProviders();
                const recipes = { ...agentProviderRecipes(), ...fileRecipes };
                try { expandExternalSummaryChain(parsed.externalSummary, recipes); } catch (error) {
                    return sendError(res, 400, `compress.externalSummary cannot be resolved: ${String(error)}`);
                }
            }
        }
        if (next.passthrough !== undefined && next.passthrough !== null && typeof next.passthrough !== "boolean") return sendError(res, 400, "passthrough must be a boolean or null");
        if (next.passthrough === true && passthroughState(process.env).source === "env") return sendError(res, 409, "passthrough is forced by the ACP_PASSTHROUGH environment variable (or --passthrough flag); unset it and restart to change here");
        // #3666: dsh.* settings were removed — whole-file saves preserve any
        // leftover dsh keys verbatim (the load path warns once that they are
        // ignored), so there is nothing to validate or reconcile here.
        try {
            atomicWriteConfig(next);
            onChanged?.();
        } catch (error) {
            return sendError(res, 500, `failed to apply config: ${String(error)}`);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, applied: ["config file"] }, null, 2));
        return;
    }

    let rawProviders: Record<string, unknown> | undefined;
    if (hasProviders) {
        if (!body.providers || typeof body.providers !== "object" || Array.isArray(body.providers)) {
            return sendError(res, 400, "providers must be an object");
        }
        // Validate-only: the RAW entry is what gets written back, so identity
        // fields outside the routing schema (`bind`, `compactionOptIn`) survive
        // the save round-trip (#1469). The runtime table is rebuilt from these
        // values by loadRoutes at startup / hot-reload.
        rawProviders = {};
        for (const [url, value] of Object.entries(body.providers as Record<string, unknown>)) {
            try { rejectLegacyRoute(url, value); } catch (error) {
                return sendError(res, 400, String(error));
            }
            let route: ReturnType<typeof parseRouteEntry>;
            try { route = parseRouteEntry(value); } catch (error) {
                return sendError(res, 400, `invalid provider entry for ${url || "(empty)"}: ${String(error)}`);
            }
            if (!url || !route) return sendError(res, 400, `invalid provider entry: ${url || "(empty)"}`);
            try { validateHttpProxy(route.proxy, biliPort); } catch (error) {
                return sendError(res, 400, `invalid provider proxy for ${url}: ${String(error)}`);
            }
            rawProviders[url] = value;
        }
    }

    let proxy: string | undefined;
    if (hasProxy) {
        if (body.upstreamProxy !== null && typeof body.upstreamProxy !== "string") {
            return sendError(res, 400, "upstreamProxy must be a string or null");
        }
        proxy = typeof body.upstreamProxy === "string" ? body.upstreamProxy.trim() || undefined : undefined;
        try { validateHttpProxy(proxy, biliPort); } catch (error) {
            return sendError(res, 400, String(error));
        }
    }
    let mode: UpstreamProxyMode | undefined;
    if (hasMode) {
        if (typeof body.upstreamProxyMode !== "string" || !["auto", "manual", "direct"].includes(body.upstreamProxyMode)) {
            return sendError(res, 400, "upstreamProxyMode must be auto, manual, or direct");
        }
        mode = parseUpstreamProxyMode(body.upstreamProxyMode);
    }
    if (mode === "manual" && !proxy && !readUpstreamSettings().proxy) {
        return sendError(res, 400, "manual mode requires an upstream proxy URL");
    }

    let compress: ReturnType<typeof parseCompressSettings>;
    if (hasCompress) {
        compress = body.compress === null ? {} : parseCompressSettings(body.compress);
        if (compress === undefined) return sendError(res, 400, "invalid compress settings");
        // Same dangling-reference guard as the whole-file save: the chain
        // must expand against the providers BEING SAVED (or the on-disk
        // table when providers are untouched) plus the agent-registry
        // fallback layer (#2336 — file recipes win on name collision).
        if (compress.externalSummary?.enabled === true) {
            const fileRecipes = hasProviders && body.providers !== null && typeof body.providers === "object" && !Array.isArray(body.providers)
                ? collectNamedProviders(body.providers as Record<string, unknown>)
                : loadNamedProviders();
            try { expandExternalSummaryChain(compress.externalSummary, { ...agentProviderRecipes(), ...fileRecipes }); } catch (error) {
                return sendError(res, 400, `compress.externalSummary cannot be resolved: ${String(error)}`);
            }
        }
    }

    // #405: the panel must be able to READ and CLEAR passthrough. An env
    // ACP_PASSTHROUGH (or --passthrough flag, which lands in env) outranks
    // the file on every reload — a file write would be a silent no-op, so
    // refuse with the exact way out instead.
    if (hasPassthrough) {
        if (body.passthrough !== null && typeof body.passthrough !== "boolean") {
            return sendError(res, 400, "passthrough must be a boolean or null");
        }
        if (passthroughState(process.env).source === "env") {
            return sendError(res, 409, "passthrough is forced by the ACP_PASSTHROUGH environment variable (or --passthrough flag); unset it and restart to change here");
        }
    }

    // #3666: dsh.* settings were removed — the wire guard now refuses dsh
    // native compaction unconditionally, so any dsh write is rejected loudly
    // instead of silently ignored (loud-reject rule for user config).
    if (hasDsh) {
        return sendError(res, 400, "dsh.* settings were removed (#3651): dsh native compaction is refused unconditionally — delete the key(s) from your config");
    }

    const config = readConfig();
    if (hasProviders) config.providers = rawProviders;
    if (hasProxy) {
        if (proxy) config.upstreamProxy = proxy;
        else delete config.upstreamProxy;
    }
    if (hasMode && mode) config.upstreamProxyMode = mode;
    if (hasCompress) {
        if (compress && Object.keys(compress).length > 0) config.compress = compress;
        else delete config.compress;
    }
    if (hasPassthrough) {
        if (body.passthrough === true) config.passthrough = true;
        else delete config.passthrough;
    }
    try {
        atomicWriteConfig(config);
        onChanged?.();
    } catch (error) {
        return sendError(res, 500, `failed to apply config: ${String(error)}`);
    }
    const changed: string[] = [];
    if (hasProviders) changed.push(`${Object.keys(rawProviders ?? {}).length} routes`);
    if (hasProxy || hasMode) changed.push("network");
    if (hasCompress) changed.push("compress");
    if (hasPassthrough) changed.push("passthrough");
    log("info", `[acp-web] configuration updated (${changed.join(", ") || "none"})`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers: hasProviders && rawProviders ? Object.keys(rawProviders).length : undefined }));
}

function sendError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256 * 1024) {
                req.destroy();
                resolve(undefined);
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(undefined); }
        });
        req.on("error", () => resolve(undefined));
    });
}
