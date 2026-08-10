import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { dataDir } from "./paths.js";
import {
    appendCodexProviderSection,
    codexConfigFile,
    getCodexProviderField,
    getCodexProviderFieldSnapshot,
    readCodexConfig,
    removeCodexProviderField,
    removeCodexProviderSectionWithPrefixIfEmpty,
    restoreCodexProviderField,
    resolveActiveCodexProvider,
    setCodexProviderField,
    type ActiveCodexProvider,
    type ProviderFieldValue,
} from "./codex-provider.js";

export const CODEX_ROUTE_STATE_VERSION = 1;

const INSTALLED_BASE_FIELDS: Record<string, ProviderFieldValue> = {
    name: "OpenAI",
    wire_api: "responses",
    requires_openai_auth: true,
};

type StoredField = {
    present: boolean;
    value?: ProviderFieldValue;
    encoded?: string;
};

export type CodexRouteState = {
    version: typeof CODEX_ROUTE_STATE_VERSION;
    active: true;
    pid?: number;
    providerId: string;
    configPath: string;
    sectionAdded: boolean;
    sectionPrefixLength: number;
    insertedFields: string[];
    originalFields: Record<string, StoredField>;
    original: {
        baseUrl: string;
        supportsWebsockets: boolean;
    };
    installed: {
        baseUrl: string;
        supportsWebsockets: false;
    };
    configHashBefore: string;
    startedAt: string;
    lastRequestAt?: string;
    lastRequestPath?: string;
};

export type CodexTakeoverStatus = {
    state: "enabled" | "disabled" | "conflict";
    configPath: string;
    statePath: string;
    provider?: ActiveCodexProvider;
    providerId?: string;
    port?: number;
    baseUrl?: string;
    originalBaseUrl?: string;
    lastRequestAt?: string;
    lastRequestPath?: string;
    detail?: string;
};

export type CodexTakeoverPaths = {
    configPath?: string;
    statePath?: string;
    ownerPid?: number;
};

export function codexRouteStateFile(): string {
    const override = process.env.BILI_CODEX_ROUTE_STATE?.trim();
    return override ? path.resolve(override) : path.join(dataDir(), "codex-route-state.json");
}

function resolvePaths(options: CodexTakeoverPaths = {}): Required<Pick<CodexTakeoverPaths, "configPath" | "statePath">> & Pick<CodexTakeoverPaths, "ownerPid"> {
    return {
        configPath: options.configPath ?? codexConfigFile(),
        statePath: options.statePath ?? codexRouteStateFile(),
        ownerPid: options.ownerPid,
    };
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function atomicWrite(filePath: string, text: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const mode = existsSync(filePath) ? statSync(filePath).mode : 0o600;
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
        fd = openSync(tempPath, "wx", mode);
        writeFileSync(fd, text, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tempPath, filePath);
    } catch (error) {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(tempPath); } catch { }
        throw error;
    }
}

function parseState(statePath: string): CodexRouteState | undefined {
    if (!existsSync(statePath)) return undefined;
    try {
        const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<CodexRouteState>;
        if (
            value.version === CODEX_ROUTE_STATE_VERSION &&
            value.active === true &&
            typeof value.providerId === "string" &&
            typeof value.configPath === "string" &&
            typeof value.original?.baseUrl === "string" &&
            typeof value.installed?.baseUrl === "string" &&
            value.installed.supportsWebsockets === false &&
            value.originalFields && typeof value.originalFields === "object" &&
            Array.isArray(value.insertedFields) &&
            typeof value.sectionPrefixLength === "number" && value.sectionPrefixLength >= 0
        ) return value as CodexRouteState;
    } catch {
    }
    return undefined;
}

function writeState(statePath: string, state: CodexRouteState): void {
    atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n");
}

function removeState(statePath: string): void {
    try { unlinkSync(statePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function installedBaseUrl(port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid bili port: ${port}`);
    return `http://127.0.0.1:${port}/codex`;
}

function isInstalledBaseUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return url.protocol === "http:" &&
            (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
            url.pathname.replace(/\/+$/, "") === "/codex";
    } catch {
        return false;
    }
}

function storedField(text: string, providerId: string, key: string): StoredField {
    const snapshot = getCodexProviderFieldSnapshot(text, providerId, key);
    return snapshot === undefined ? { present: false } : { present: true, ...snapshot };
}

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export function getCodexRouteState(options: CodexTakeoverPaths = {}): CodexRouteState | undefined {
    return parseState(resolvePaths(options).statePath);
}

export function getCodexTakeoverStatus(options: CodexTakeoverPaths = {}): CodexTakeoverStatus {
    const paths = resolvePaths(options);
    const state = parseState(paths.statePath);
    if (!state) {
        try {
            return {
                state: "disabled",
                configPath: paths.configPath,
                statePath: paths.statePath,
                provider: resolveActiveCodexProvider(paths.configPath),
            };
        } catch (error) {
            return {
                state: "disabled",
                configPath: paths.configPath,
                statePath: paths.statePath,
                detail: String(error),
            };
        }
    }
    if (path.resolve(state.configPath) !== path.resolve(paths.configPath)) {
        return {
            state: "conflict",
            configPath: paths.configPath,
            statePath: paths.statePath,
            providerId: state.providerId,
            detail: `route state belongs to a different Codex config: ${state.configPath}`,
        };
    }
    const text = readCodexConfig(paths.configPath);
    const currentBase = getCodexProviderField(text, state.providerId, "base_url");
    const currentWebsockets = getCodexProviderField(text, state.providerId, "supports_websockets");
    const matches = currentBase === state.installed.baseUrl && currentWebsockets === false;
    const port = Number.parseInt(new URL(state.installed.baseUrl).port, 10);
    return {
        state: matches ? "enabled" : "conflict",
        configPath: paths.configPath,
        statePath: paths.statePath,
        providerId: state.providerId,
        port,
        baseUrl: state.installed.baseUrl,
        originalBaseUrl: state.original.baseUrl,
        lastRequestAt: state.lastRequestAt,
        lastRequestPath: state.lastRequestPath,
        ...(matches ? {} : { detail: "managed Codex route fields changed; restore will preserve user edits" }),
    };
}

export function enableCodexTakeover(port: number, options: CodexTakeoverPaths = {}): CodexTakeoverStatus {
    const paths = resolvePaths(options);
    const existing = parseState(paths.statePath);
    if (existing) {
        const status = getCodexTakeoverStatus(paths);
        const otherLiveOwner = existing.pid && existing.pid !== paths.ownerPid && pidAlive(existing.pid);
        if (status.state === "enabled" && status.port === port) {
            if (otherLiveOwner && paths.ownerPid) {
                throw new Error(`Codex route is owned by running bili process ${existing.pid}`);
            }
            if (paths.ownerPid && existing.pid !== paths.ownerPid) {
                existing.pid = paths.ownerPid;
                writeState(paths.statePath, existing);
                return getCodexTakeoverStatus(paths);
            }
            return status;
        }
        if (otherLiveOwner) {
            throw new Error(`Codex route is owned by running bili process ${existing.pid}`);
        }
        disableCodexTakeover(paths);
    }
    const provider = resolveActiveCodexProvider(paths.configPath);
    if (provider.wireApi !== "responses") {
        throw new Error(`Codex provider \"${provider.id}\" uses wire_api=${provider.wireApi}; local route requires responses`);
    }
    if (isInstalledBaseUrl(provider.baseUrl)) {
        throw new Error("Codex provider already points at a local /codex route without billion-context ownership state");
    }
    const before = readCodexConfig(paths.configPath);
    const installedUrl = installedBaseUrl(port);
    const managedKeys = ["base_url", "supports_websockets"];
    const originalFields: Record<string, StoredField> = {};
    for (const key of managedKeys) originalFields[key] = storedField(before, provider.id, key);
    let after = before;
    const insertedFields: string[] = [];
    let sectionAdded = false;
    if (!provider.sectionExists) {
        sectionAdded = true;
        const fields = {
            ...INSTALLED_BASE_FIELDS,
            base_url: installedUrl,
            supports_websockets: false,
        };
        after = appendCodexProviderSection(after, provider.id, fields);
        insertedFields.push(...Object.keys(fields));
    } else {
        const baseResult = setCodexProviderField(after, provider.id, "base_url", installedUrl);
        after = baseResult.text;
        if (baseResult.added) insertedFields.push("base_url");
        const websocketResult = setCodexProviderField(after, provider.id, "supports_websockets", false);
        after = websocketResult.text;
        if (websocketResult.added) insertedFields.push("supports_websockets");
    }
    const state: CodexRouteState = {
        version: CODEX_ROUTE_STATE_VERSION,
        active: true,
        ...(paths.ownerPid ? { pid: paths.ownerPid } : {}),
        providerId: provider.id,
        configPath: paths.configPath,
        sectionAdded,
        sectionPrefixLength: sectionAdded
            ? before.length === 0
                ? 0
                : /(?:\r\n|\r|\n)$/.test(before)
                  ? (before.match(/(\r\n|\r|\n)$/)?.[0].length ?? 1)
                  : 2 * (before.match(/\r\n|\r|\n/)?.[0].length ?? (process.platform === "win32" ? 2 : 1))
            : 0,
        insertedFields,
        originalFields,
        original: { baseUrl: provider.baseUrl, supportsWebsockets: provider.supportsWebsockets },
        installed: { baseUrl: installedUrl, supportsWebsockets: false },
        configHashBefore: sha256(before),
        startedAt: new Date().toISOString(),
    };
    writeState(paths.statePath, state);
    try {
        atomicWrite(paths.configPath, after);
    } catch (error) {
        removeState(paths.statePath);
        throw error;
    }
    return getCodexTakeoverStatus(paths);
}

export function disableCodexTakeover(options: CodexTakeoverPaths = {}): CodexTakeoverStatus {
    const paths = resolvePaths(options);
    const state = parseState(paths.statePath);
    if (!state) return getCodexTakeoverStatus(paths);
    let text = readCodexConfig(state.configPath);
    const preserved: string[] = [];
    const installedValues: Record<string, ProviderFieldValue> = {
        ...INSTALLED_BASE_FIELDS,
        base_url: state.installed.baseUrl,
        supports_websockets: false,
    };
    for (const [key, installedValue] of Object.entries(installedValues)) {
        if (!state.sectionAdded && key !== "base_url" && key !== "supports_websockets") continue;
        const current = getCodexProviderField(text, state.providerId, key);
        if (current !== installedValue) {
            if (current !== undefined) preserved.push(key);
            continue;
        }
        const original = state.originalFields[key];
        if (original?.present && original.value !== undefined) {
            text = typeof original.encoded === "string"
                ? restoreCodexProviderField(text, state.providerId, key, {
                    value: original.value,
                    encoded: original.encoded,
                })
                : setCodexProviderField(text, state.providerId, key, original.value).text;
        } else {
            text = removeCodexProviderField(text, state.providerId, key);
        }
    }
    if (state.sectionAdded) {
        text = removeCodexProviderSectionWithPrefixIfEmpty(text, state.providerId, state.sectionPrefixLength ?? 0);
    }
    atomicWrite(state.configPath, text);
    removeState(paths.statePath);
    const status = getCodexTakeoverStatus({ ...paths, configPath: state.configPath });
    if (preserved.length > 0) status.detail = `检测到用户修改，已保留：${preserved.join(", ")}`;
    return status;
}

export function recoverStaleCodexTakeover(options: CodexTakeoverPaths = {}): CodexTakeoverStatus {
    const paths = resolvePaths(options);
    const state = parseState(paths.statePath);
    if (state?.pid && !pidAlive(state.pid)) return disableCodexTakeover(paths);
    return getCodexTakeoverStatus(paths);
}

export function claimCodexTakeover(ownerPid: number = process.pid, options: CodexTakeoverPaths = {}): CodexTakeoverStatus {
    const paths = resolvePaths(options);
    const state = parseState(paths.statePath);
    if (!state) return getCodexTakeoverStatus(paths);
    if (state.pid && state.pid !== ownerPid && pidAlive(state.pid)) {
        throw new Error(`Codex route is owned by running bili process ${state.pid}`);
    }
    state.pid = ownerPid;
    writeState(paths.statePath, state);
    return getCodexTakeoverStatus(paths);
}

export function restoreCodexTakeoverOwnedBy(ownerPid: number = process.pid, options: CodexTakeoverPaths = {}): CodexTakeoverStatus {
    const paths = resolvePaths(options);
    const state = parseState(paths.statePath);
    if (!state || state.pid !== ownerPid) return getCodexTakeoverStatus(paths);
    return disableCodexTakeover(paths);
}

export function recordCodexRouteRequest(requestPath: string, options: CodexTakeoverPaths = {}): void {
    const paths = resolvePaths(options);
    const state = parseState(paths.statePath);
    if (!state) return;
    state.lastRequestAt = new Date().toISOString();
    state.lastRequestPath = requestPath;
    writeState(paths.statePath, state);
}
