import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFile } from "../paths.js";
import {
    loadRoutes,
    normalizeUrlKey,
    parseRouteEntry,
    parseUpstreamProxyMode,
    safeReadJson,
    type ProviderRoute,
    type ProviderRoutes,
    type UpstreamProxyMode,
} from "../config.js";
import { log } from "../logger.js";
import { validateHttpProxy } from "../upstream-proxy.js";
import { previewLegacyCodexHistory, repairLegacyCodexHistory } from "../codex-history.js";
import { getUpdateStatus, runScheduledUpdate, installUpdate, type UpdateOptions } from "../update.js";

type ConfigShape = Record<string, unknown> & {
    providers?: Record<string, unknown>;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
    update?: { mode?: string };
    compress?: { nudgeGrowthTokens?: number };
};

function readConfig(): ConfigShape {
    const parsed = safeReadJson(configFile());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ConfigShape : {};
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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        path: configFile(),
        providers: readProviders(),
        upstreamProxy: upstream.proxy ?? null,
        upstreamProxyMode: upstream.mode,
        updateMode: config.update?.mode ?? null,
        nudgeGrowthTokens: config.compress?.nudgeGrowthTokens ?? null,
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
    const body = raw as Record<string, unknown>;
    const hasProviders = Object.prototype.hasOwnProperty.call(body, "providers");
    const hasProxy = Object.prototype.hasOwnProperty.call(body, "upstreamProxy");
    const hasMode = Object.prototype.hasOwnProperty.call(body, "upstreamProxyMode");
    const hasUpdateMode = Object.prototype.hasOwnProperty.call(body, "updateMode");
    const hasNudgeGrowthTokens = Object.prototype.hasOwnProperty.call(body, "nudgeGrowthTokens");
    if (!hasProviders && !hasProxy && !hasMode && !hasUpdateMode && !hasNudgeGrowthTokens) {
        return sendError(res, 400, "expected providers, upstream proxy settings, updateMode, or nudgeGrowthTokens");
    }

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

    let updateMode: string | undefined;
    if (hasUpdateMode) {
        if (body.updateMode !== null && (typeof body.updateMode !== "string" || !["auto", "check", "manual"].includes(body.updateMode))) {
            return sendError(res, 400, "updateMode must be auto, check, manual, or null");
        }
        updateMode = typeof body.updateMode === "string" ? body.updateMode : undefined;
    }
    let nudgeGrowthTokens: number | undefined;
    if (hasNudgeGrowthTokens) {
        if (body.nudgeGrowthTokens !== null && body.nudgeGrowthTokens !== undefined) {
            const value = body.nudgeGrowthTokens;
            const num = typeof value === "number" ? value : Number(String(value).trim());
            if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
                return sendError(res, 400, "nudgeGrowthTokens must be a finite positive integer (> 0) or null");
            }
            nudgeGrowthTokens = num;
        }
    }

    const config = readConfig();
    if (hasProviders) config.providers = routes;
    if (hasProxy) {
        if (proxy) config.upstreamProxy = proxy;
        else delete config.upstreamProxy;
    }
    if (hasMode && mode) config.upstreamProxyMode = mode;
    if (hasUpdateMode) {
        if (updateMode) config.update = { ...(config.update ?? {}), mode: updateMode };
        else if (config.update) delete config.update.mode;
    }
    if (hasNudgeGrowthTokens) {
        if (nudgeGrowthTokens) config.compress = { ...(config.compress ?? {}), nudgeGrowthTokens };
        else if (config.compress) delete config.compress.nudgeGrowthTokens;
    }
    try {
        atomicWriteConfig(config);
        onChanged?.();
    } catch (error) {
        return sendError(res, 500, `failed to apply config: ${String(error)}`);
    }
    log("info", `[acp-web] configuration updated (${hasProviders ? `${Object.keys(routes).length} routes` : "network only"})`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers: hasProviders ? Object.keys(routes).length : undefined }));
}

export async function handleCodexHistoryGet(res: ServerResponse): Promise<void> {
    try {
        const preview = await previewLegacyCodexHistory();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(preview));
    } catch (error) {
        sendError(res, 409, String(error));
    }
}

export async function handleCodexHistoryRepair(res: ServerResponse): Promise<void> {
    try {
        const result = await repairLegacyCodexHistory();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
    } catch (error) {
        sendError(res, 409, String(error));
    }
}

/** GET /__bili/update/status — current update state (mode, versions, last
 *  check/install outcome). Never touches the network. */
export function handleUpdateStatus(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getUpdateStatus()));
}

/** POST /__bili/update/check — run one explicit check now (bypasses throttle).
 *  Respects the mode: auto/check report; only auto installs. */
export async function handleUpdateCheck(res: ServerResponse, opts: UpdateOptions): Promise<void> {
    await runScheduledUpdate(opts, true);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getUpdateStatus()));
}

/** POST /__bili/update/install — check + install the latest version now. */
export async function handleUpdateInstall(res: ServerResponse, opts: UpdateOptions): Promise<void> {
    const result = await installUpdate(opts);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: result.ok, error: result.error ?? null, installedTo: result.installedTo ?? null, ...getUpdateStatus() }));
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
