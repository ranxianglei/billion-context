import { randomUUID } from "node:crypto";
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

/** Per-launch handshake report (#446): keyed by launchToken so concurrent
 *  launcher-spawned proxies don't clobber each other's single proxy-origin
 *  record. The launcher reads only its own child's report (matched by
 *  construction — it generated the token), so N isolated launchers coexist. */
export function launchTokenFilePath(token: string): string {
    return path.join(stateDir(), `proxy-origin-${token}`);
}

/** tmp+fsync+rename (same shape as web/api.ts atomicWriteConfig) — a torn
 *  write must never leave a half-origin behind (#406 family). */
export function atomicWriteInstanceFile(info: ProxyInstanceFile, file?: string): void {
    const filePath = file ?? instanceFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(tempPath, "wx", 0o644);
        fs.writeSync(descriptor, JSON.stringify(info) + "\n", null, "utf8");
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

function registryFilePath(): string {
    return path.join(stateDir(), "instances.json");
}

/** Cross-instance liveness registry (#394): every proxy registers itself at
 *  listen time; a second live registrant triggers the dual-writer warning.
 *  Entries whose pid is dead are pruned on read. Best-effort throughout. */
export function registerInstanceAndWarn(entry: RegistryEntry, warn: (msg: string) => void): void {
    const file = registryFilePath();
    const entries: RegistryEntry[] = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { instances?: RegistryEntry[] };
        if (Array.isArray(parsed.instances)) {
            for (const e of parsed.instances) {
                if (e && typeof e.instanceId === "string" && e.instanceId !== entry.instanceId && isPidAlive(e.pid)) {
                    entries.push(e);
                }
            }
        }
    } catch {}
    for (const other of entries) {
        warn(
            `another bili instance is running (pid ${other.pid}, ${other.origin}) — both processes will write the same sessions directory; stop one to avoid state pollution (#394)`,
        );
    }
    entries.push(entry);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ instances: entries }) + "\n");
    } catch {}
}

export function unregisterInstance(instanceId: string): void {
    const file = registryFilePath();
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { instances?: RegistryEntry[] };
        if (!Array.isArray(parsed.instances)) return;
        const kept = parsed.instances.filter(
            (e) => !(e && typeof e.instanceId === "string" && e.instanceId === instanceId) && isPidAlive(e.pid),
        );
        fs.writeFileSync(file, JSON.stringify({ instances: kept }) + "\n");
    } catch {}
}
