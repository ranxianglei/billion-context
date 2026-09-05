import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

/** Instance registry (#394/#403/#417): the proxy-origin file is upgraded from
 *  a bare URL string to a JSON record identifying the live instance, so
 *  readers (launcher attach, plugin install, MCP shells) can verify liveness
 *  and config compatibility before trusting it. Readers from older builds
 *  treat a JSON body as unreadable and fall back to their default origin; the
 *  writer and all in-tree readers ship together, so the skew window is one
 *  restart. */
export interface ProxyInstanceFile {
    origin: string;
    instanceId: string;
    pid: number;
    startedAt: number;
    host: string;
    port: number;
    passthrough: boolean;
    mitmDomains: string[];
    modelWindows: Record<string, number>;
    launchToken?: string;
}

export function isProxyInstanceFile(v: ProxyInstanceFile | { origin: string } | undefined): v is ProxyInstanceFile {
    return v !== undefined && "instanceId" in v;
}

export function readProxyInstanceFile(file?: string): ProxyInstanceFile | { origin: string } | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(file ?? instanceFilePath(), "utf8").trim();
    } catch {
        return undefined;
    }
    if (raw.startsWith("{")) {
        try {
            const parsed = JSON.parse(raw) as Partial<ProxyInstanceFile>;
            if (typeof parsed.origin === "string" && /^https?:\/\/\S+$/.test(parsed.origin)) {
                const windows: Record<string, number> = {};
                if (parsed.modelWindows && typeof parsed.modelWindows === "object") {
                    for (const [k, v] of Object.entries(parsed.modelWindows)) {
                        const n = Number(v);
                        if (Number.isFinite(n) && n > 0) windows[k] = n;
                    }
                }
                return {
                    origin: parsed.origin,
                    instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : "",
                    pid: typeof parsed.pid === "number" ? parsed.pid : 0,
                    startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
                    host: typeof parsed.host === "string" ? parsed.host : "",
                    port: typeof parsed.port === "number" ? parsed.port : 0,
                    passthrough: Boolean(parsed.passthrough),
                    mitmDomains: Array.isArray(parsed.mitmDomains) ? parsed.mitmDomains.map(String) : [],
                    modelWindows: windows,
                    launchToken: typeof parsed.launchToken === "string" ? parsed.launchToken : undefined,
                };
            }
        } catch {
            // fall through to legacy plain-string parsing
        }
    }
    if (/^https?:\/\/\S+$/.test(raw)) return { origin: raw };
    return undefined;
}

export function instanceFilePath(): string {
    return path.join(stateDir(), "proxy-origin");
}

/** tmp+fsync+rename (same shape as web/api.ts atomicWriteConfig) — a torn
 *  write must never leave a half-file behind (#406 family). Shared by the
 *  proxy-origin record and every registry marker. */
function atomicWriteJson(obj: unknown, filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(tempPath, "wx", 0o644);
        fs.writeSync(descriptor, JSON.stringify(obj) + "\n", null, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {}
        }
        try {
            fs.unlinkSync(tempPath);
        } catch {}
        throw error;
    }
}

export function atomicWriteInstanceFile(info: ProxyInstanceFile, file?: string): void {
    atomicWriteJson(info, file ?? instanceFilePath());
}

/** Remove our record on shutdown — but only if the file still carries OUR
 *  instanceId (a newer instance may have legitimately taken it over). */
export function clearProxyInstanceFile(instanceId: string, file?: string): void {
    const filePath = file ?? instanceFilePath();
    const current = readProxyInstanceFile(filePath);
    if (isProxyInstanceFile(current) && current.instanceId === instanceId) {
        try {
            fs.unlinkSync(filePath);
        } catch {}
    }
}

/** pid liveness (kill-0). EPERM means the process exists but is owned by
 *  another user — still alive. */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

interface RegistryEntry {
    instanceId: string;
    pid: number;
    port: number;
    origin: string;
    startedAt: number;
}

/** Cross-instance liveness registry (#394/#527): one marker file per instance
 *  under <state>/instances/<id>.json, so the registry IS the directory listing
 *  and removal unlinks exactly one file — no shared read-modify-write, hence no
 *  cross-process lost update. Dead owners are reaped on the next registration;
 *  legacy instances.json is folded in read-only. Best-effort. */
function registryDirPath(): string {
    return path.join(stateDir(), "instances");
}

function legacyRegistryFilePath(): string {
    return path.join(stateDir(), "instances.json");
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeRegistryName(instanceId: string): string {
    if (instanceId !== "." && instanceId !== ".." && instanceId.length <= 128 && SAFE_NAME_RE.test(instanceId)) {
        return instanceId;
    }
    return createHash("sha256").update(instanceId).digest("hex");
}

function registryEntryFile(instanceId: string): string {
    return path.join(registryDirPath(), `${safeRegistryName(instanceId)}.json`);
}

function safeReadJson(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

function coerceEntry(value: unknown): RegistryEntry | undefined {
    if (!value || typeof value !== "object") return undefined;
    const o = value as Record<string, unknown>;
    if (typeof o.instanceId !== "string" || o.instanceId === "") return undefined;
    return {
        instanceId: o.instanceId,
        pid: typeof o.pid === "number" ? o.pid : 0,
        port: typeof o.port === "number" ? o.port : 0,
        origin: typeof o.origin === "string" ? o.origin : "",
        startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
    };
}

function readMarkerNames(): string[] {
    try {
        return fs.readdirSync(registryDirPath());
    } catch {
        return [];
    }
}

function readAllRegistryEntries(): RegistryEntry[] {
    const seen = new Set<string>();
    const out: RegistryEntry[] = [];
    for (const name of readMarkerNames()) {
        if (!name.endsWith(".json")) continue;
        const entry = coerceEntry(safeReadJson(path.join(registryDirPath(), name)));
        if (entry && !seen.has(entry.instanceId)) {
            seen.add(entry.instanceId);
            out.push(entry);
        }
    }
    const legacy = safeReadJson(legacyRegistryFilePath()) as { instances?: unknown } | undefined;
    if (legacy && Array.isArray(legacy.instances)) {
        for (const raw of legacy.instances) {
            const entry = coerceEntry(raw);
            if (entry && !seen.has(entry.instanceId)) {
                seen.add(entry.instanceId);
                out.push(entry);
            }
        }
    }
    return out;
}

function reapDeadMarkers(ours: string): void {
    for (const name of readMarkerNames()) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(registryDirPath(), name);
        const entry = coerceEntry(safeReadJson(file));
        if (!entry || entry.instanceId === ours || isPidAlive(entry.pid)) continue;
        try {
            fs.unlinkSync(file);
        } catch {}
    }
}

export function registerInstanceAndWarn(entry: RegistryEntry, warn: (msg: string) => void): void {
    const others = readAllRegistryEntries().filter((e) => e.instanceId !== entry.instanceId && isPidAlive(e.pid));
    for (const other of others) {
        warn(
            `another bili instance is running (pid ${other.pid}, ${other.origin}) — both processes will write the same sessions directory; stop one to avoid state pollution (#394)`,
        );
    }
    reapDeadMarkers(entry.instanceId);
    try {
        atomicWriteJson(entry, registryEntryFile(entry.instanceId));
    } catch {}
}

/** Unlinks only our own marker; cannot clobber another instance's entry (#527). */
export function unregisterInstance(instanceId: string): void {
    try {
        fs.unlinkSync(registryEntryFile(instanceId));
    } catch {}
}
