import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFile } from "../paths.js";
import {
    loadRoutes,
    normalizeUrlKey,
    parseCompressSettings,
    parseRouteEntry,
    parseUpstreamProxyMode,
    passthroughState,
    safeReadJson,
    type ProviderRoute,
    type ProviderRoutes,
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

export function readProviders(): ProviderRoutes {
    return loadRoutes();
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
    if (!hasProviders && !hasProxy && !hasMode && !hasCompress && !hasPassthrough) return sendError(res, 400, "expected providers, upstream proxy, compress, or passthrough settings");

    const routes: Record<string, ProviderRoute> = {};
    if (hasProviders) {
        if (!body.providers || typeof body.providers !== "object" || Array.isArray(body.providers)) {
            return sendError(res, 400, "providers must be an object");
        }
        for (const [url, value] of Object.entries(body.providers as Record<string, unknown>)) {
            const route = parseRouteEntry(value);
            if (!url || !route) return sendError(res, 400, `invalid provider entry: ${url || "(empty)"}`);
            try { validateHttpProxy(route.proxy, biliPort); } catch (error) {
                return sendError(res, 400, `invalid provider proxy for ${url}: ${String(error)}`);
            }
            routes[normalizeUrlKey(url)] = route;
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
    if (hasProviders) config.providers = routes;
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
    if (hasProviders) changed.push(`${Object.keys(routes).length} routes`);
    if (hasProxy || hasMode) changed.push("network");
    if (hasCompress) changed.push("compress");
    if (hasPassthrough) changed.push("passthrough");
    log("info", `[acp-web] configuration updated (${changed.join(", ") || "none"})`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers: hasProviders ? Object.keys(routes).length : undefined }));
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
