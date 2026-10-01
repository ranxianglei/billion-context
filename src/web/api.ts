import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFile } from "../paths.js";
import {
    parseCompressSettings,
    parseRouteEntry,
    parseUpstreamProxyMode,
    passthroughState,
    rejectLegacyRoute,
    safeReadJson,
    type UpstreamProxyMode,
} from "../config.js";
import { log } from "../logger.js";
import { validateHttpProxy } from "../upstream-proxy.js";

type ConfigShape = Record<string, unknown> & {
    providers?: Record<string, unknown>;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
};

function readConfig(): ConfigShape {
    const parsed = safeReadJson(configFile());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ConfigShape : {};
}

/** The config file exists on disk but does not parse as JSON (hand-edited
 *  comment, trailing comma, …). Distinct from "missing": a broken file must
 *  never be silently rebuilt from {} by a PUT — that would wipe every field
 *  the loader could not read. */
function configParseError(): string | null {
    if (!existsSync(configFile())) return null;
    const parsed = safeReadJson(configFile());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return null;
    return `config file is not valid JSON: ${configFile()}`;
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
    const parseError = configParseError();
    if (parseError) log("warn", `[acp-web] ${parseError} — showing empty view; PUT is blocked until fixed`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        path: configFile(),
        providers: readProviders(),
        upstreamProxy: upstream.proxy ?? null,
        upstreamProxyMode: upstream.mode,
        compress: config.compress ?? null,
        passthrough: passthroughState(process.env),
        ...(existsSync(configFile()) ? { raw: readFileSync(configFile(), "utf8") } : {}),
        ...(parseError ? { parseError } : {}),
    }, null, 2));
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
    const hasFile = Object.prototype.hasOwnProperty.call(body, "file");
    if (!hasProviders && !hasProxy && !hasMode && !hasCompress && !hasPassthrough && !hasFile) return sendError(res, 400, "expected providers, upstream proxy, compress, passthrough settings, or the full config file");
    // Raw whole-file save (web config card): validate the known fields exactly like the
    // structured payload, then replace the ENTIRE config — preserving unknown keys such
    // as promptPack/ccr that per-field PUTs cannot touch.
    if (hasFile) {
        if (typeof body.file !== "string") return sendError(res, 400, "file must be a string (raw config JSON text)");
        let next: ConfigShape;
        try {
            const p = JSON.parse(body.file);
            if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("top level must be a JSON object");
            next = p as ConfigShape;
        } catch (error) {
            return sendError(res, 400, `file is not valid JSON: ${String(error)}`);
        }
        if (next.providers !== undefined) {
            if (typeof next.providers !== "object" || Array.isArray(next.providers)) return sendError(res, 400, "providers must be an object");
            for (const [url, value] of Object.entries(next.providers as Record<string, unknown>)) {
                const route = parseRouteEntry(value);
                if (!url || !route) return sendError(res, 400, `invalid provider entry: ${url || "(empty)"}`);
                try { validateHttpProxy(route.proxy, biliPort); } catch (error) { return sendError(res, 400, `invalid provider proxy for ${url}: ${String(error)}`); }
            }
        }
        if (next.upstreamProxy !== undefined) {
            if (next.upstreamProxy !== null && typeof next.upstreamProxy !== "string") return sendError(res, 400, "upstreamProxy must be a string or null");
            try { validateHttpProxy(typeof next.upstreamProxy === "string" ? next.upstreamProxy.trim() || undefined : undefined, biliPort); } catch (error) { return sendError(res, 400, String(error)); }
        }
        if (next.upstreamProxyMode !== undefined && (typeof next.upstreamProxyMode !== "string" || !["auto", "manual", "direct"].includes(next.upstreamProxyMode))) return sendError(res, 400, "upstreamProxyMode must be auto, manual, or direct");
        if (next.compress !== undefined && next.compress !== null && parseCompressSettings(next.compress) === undefined) return sendError(res, 400, "invalid compress settings");
        if (next.passthrough !== undefined && next.passthrough !== null && typeof next.passthrough !== "boolean") return sendError(res, 400, "passthrough must be a boolean or null");
        if (next.passthrough === true && passthroughState(process.env).source === "env") return sendError(res, 409, "passthrough is forced by the ACP_PASSTHROUGH environment variable (or --passthrough flag); unset it and restart to change here");
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
            const route = parseRouteEntry(value);
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
