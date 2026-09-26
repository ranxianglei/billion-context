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
    modelMaxOutputs?: Record<string, number>;
    launchToken?: string;
    /** #1225: which client/lane the launcher that spawned this instance
     *  belongs to (BILI_LAUNCHER_LANE). Absent for manual `bili start`
     *  daemons and pre-#1225 instances — both stay shareable (wildcard). */
    lane?: string;
    /** #1225: sha256 of the entry script this instance is RUNNING. A missing
     *  fingerprint means pre-#1225 code — attaching new code to it would
     *  serve stale behavior, so readers must treat absence as incompatible. */
    codeFingerprint?: string;
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
                const maxOutputs: Record<string, number> = {};
                if (parsed.modelMaxOutputs && typeof parsed.modelMaxOutputs === "object") {
                    for (const [k, v] of Object.entries(parsed.modelMaxOutputs)) {
                        const n = Number(v);
                        if (Number.isFinite(n) && n > 0) maxOutputs[k] = n;
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
                    modelMaxOutputs: Object.keys(maxOutputs).length > 0 ? maxOutputs : undefined,
                    launchToken: typeof parsed.launchToken === "string" ? parsed.launchToken : undefined,
                    lane: typeof parsed.lane === "string" && parsed.lane !== "" ? parsed.lane : undefined,
                    codeFingerprint: typeof parsed.codeFingerprint === "string" && parsed.codeFingerprint !== "" ? parsed.codeFingerprint : undefined,
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

/** #1225: content identity of a bili entry script (sha256 of its bytes).
 *  The spawned child records this for ITS script; an attaching launcher
 *  compares it against the hash of the script it would spawn — so "same
 *  version" is never enough: two installs of 0.1.x with different dist
 *  contents (local rebuild, npm link, unpublished branch) must not be
 *  confused for one codebase. Unreadable file → undefined → never attach. */
const scriptFingerprints = new Map<string, string>();
export function entryScriptFingerprint(scriptPath?: string): string | undefined {
    if (!scriptPath) return undefined;
    const resolved = path.resolve(scriptPath);
    const cached = scriptFingerprints.get(resolved);
    if (cached !== undefined) return cached;
    let digest: string;
    try {
        digest = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
    } catch {
        return undefined;
    }
    scriptFingerprints.set(resolved, digest);
    return digest;
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

/** Cross-process starting marker (#707): while a launcher sits between spawn
 *  and healthy, no instance record exists yet, so concurrent launches see
 *  nothing to attach to and double-spawn — two writers over one sessions dir.
 *  The starter claims this file with O_EXCL before spawning; concurrent
 *  callers find it and wait for the bring-up instead of spawning their own. */
export interface ProxyStartingMarker {
    token: string;
    pid: number;
    host: string;
    port: number;
    startedAt: number;
    /** #1225: starter's lane — cross-lane concurrent launches skip the wait
     *  instead of stalling behind a bring-up they could never attach to. */
    lane?: string;
}

export function startingMarkerPath(): string {
    return path.join(stateDir(), "proxy-starting");
}

export function readStartingMarker(file?: string): ProxyStartingMarker | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(file ?? startingMarkerPath(), "utf8");
    } catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<ProxyStartingMarker>;
        if (typeof parsed.token !== "string" || parsed.token === "") return undefined;
        if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
        if (typeof parsed.startedAt !== "number") return undefined;
        return {
            token: parsed.token,
            pid: parsed.pid,
            host: typeof parsed.host === "string" ? parsed.host : "",
            port: typeof parsed.port === "number" ? parsed.port : 0,
            startedAt: parsed.startedAt,
            ...(typeof parsed.lane === "string" && parsed.lane !== "" ? { lane: parsed.lane } : {}),
        };
    } catch {
        return undefined;
    }
}

/** Claim the marker atomically across processes (O_EXCL create — a rename-based
 *  write would leave the same race at the marker level). Returns false when a
 *  claimant already holds it or the state dir is unwritable; coordination then
 *  degrades to the pre-#707 behavior instead of failing the launch. */
export function claimStartingMarker(marker: ProxyStartingMarker, file?: string): boolean {
    const filePath = file ?? startingMarkerPath();
    let descriptor: number | undefined;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        descriptor = fs.openSync(filePath, "wx", 0o644);
        fs.writeSync(descriptor, JSON.stringify(marker) + "\n", null, "utf8");
        fs.fsyncSync(descriptor);
        descriptor = undefined;
        return true;
    } catch {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {}
        }
        return false;
    }
}

/** Remove the marker only if it still carries OUR token (a newer claimant may
 *  have taken it over). Mirrors clearProxyInstanceFile. */
export function clearStartingMarker(token: string, file?: string): void {
    const filePath = file ?? startingMarkerPath();
    const current = readStartingMarker(filePath);
    if (current && current.token === token) {
        try {
            fs.unlinkSync(filePath);
        } catch {}
    }
}

/** Unconditional best-effort removal — used only on markers the caller has
 *  already verified stale (dead owner / expired). */
export function removeStartingMarker(file?: string): void {
    try {
        fs.unlinkSync(file ?? startingMarkerPath());
    } catch {}
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

export interface RegistryEntry {
    instanceId: string;
    pid: number;
    port: number;
    origin: string;
    startedAt: number;
    /** #1232: identity fields mirroring the proxy-origin record (minus the
     *  launcher-private launchToken) — lane-aware attach discovery and the
     *  lane-aware #394 warning need them for EVERY live instance, not just
     *  the last writer of the single proxy-origin file. Absent in markers
     *  written by pre-#1232 builds → wildcard lane / never-attachable. */
    host?: string;
    passthrough?: boolean;
    mitmDomains?: string[];
    modelWindows?: Record<string, number>;
    modelMaxOutputs?: Record<string, number>;
    lane?: string;
    codeFingerprint?: string;
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
    const windows: Record<string, number> = {};
    if (o.modelWindows && typeof o.modelWindows === "object") {
        for (const [k, v] of Object.entries(o.modelWindows as Record<string, unknown>)) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) windows[k] = n;
        }
    }
    const maxOutputs: Record<string, number> = {};
    if (o.modelMaxOutputs && typeof o.modelMaxOutputs === "object") {
        for (const [k, v] of Object.entries(o.modelMaxOutputs as Record<string, unknown>)) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) maxOutputs[k] = n;
        }
    }
    return {
        instanceId: o.instanceId,
        pid: typeof o.pid === "number" ? o.pid : 0,
        port: typeof o.port === "number" ? o.port : 0,
        origin: typeof o.origin === "string" ? o.origin : "",
        startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
        ...(typeof o.host === "string" && o.host !== "" ? { host: o.host } : {}),
        ...(typeof o.passthrough === "boolean" ? { passthrough: o.passthrough } : {}),
        ...(Array.isArray(o.mitmDomains) ? { mitmDomains: o.mitmDomains.map(String) } : {}),
        ...(Object.keys(windows).length > 0 ? { modelWindows: windows } : {}),
        ...(Object.keys(maxOutputs).length > 0 ? { modelMaxOutputs: maxOutputs } : {}),
        ...(typeof o.lane === "string" && o.lane !== "" ? { lane: o.lane } : {}),
        ...(typeof o.codeFingerprint === "string" && o.codeFingerprint !== "" ? { codeFingerprint: o.codeFingerprint } : {}),
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

/** Includes dead markers on purpose (#1235) — doctor must surface zombies; do not add liveness filtering here. */
export function listInstances(): RegistryEntry[] {
    return readAllRegistryEntries();
}

/** Main script path from /proc/<pid>/cmdline (Linux); undefined on other platforms or when unreadable (#1235). */
export function procMainScript(pid: number): string | undefined {
    if (process.platform !== "linux") return undefined;
    let raw: string;
    try {
        raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
        return undefined;
    }
    for (const arg of raw.split("\0")) {
        if (!arg || arg.startsWith("-")) continue;
        if (arg.includes("/") && (arg.endsWith(".js") || arg.endsWith(".mjs") || arg.endsWith(".cjs"))) return arg;
    }
    return undefined;
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

/** #1232: two instances' lanes overlap iff either is undeclared (a manual
 *  `bili start` daemon can serve ANY client, so it shares every lane's
 *  hazard) or both declare the same lane. Different declared lanes serve
 *  disjoint clients/conversations — concurrent use there is legitimate and
 *  must not trigger the "stop one" advice. */
function lanesOverlap(a: string | undefined, b: string | undefined): boolean {
    return a === undefined || b === undefined || a === b;
}

export function registerInstanceAndWarn(entry: RegistryEntry, warn: (msg: string) => void): void {
    const others = readAllRegistryEntries().filter((e) => e.instanceId !== entry.instanceId && isPidAlive(e.pid));
    for (const other of others) {
        if (!lanesOverlap(entry.lane, other.lane)) continue;
        const laneNote = entry.lane !== undefined && other.lane !== undefined ? ` on lane "${entry.lane}"` : "";
        warn(
            `another bili instance is running (pid ${other.pid}, ${other.origin})${laneNote} — both processes will write the same sessions directory; stop one to avoid state pollution (#394)`,
        );
    }
    reapDeadMarkers(entry.instanceId);
    try {
        atomicWriteJson(entry, registryEntryFile(entry.instanceId));
    } catch {}
}

/** #1232: every LIVE registered instance as a full identity record. The
 *  single proxy-origin file is last-writer-wins and cannot represent
 *  per-lane proxies (#1225/#1231); the registry IS the directory listing,
 *  so it is the authoritative multi-instance view behind attach decisions.
 *  Dead owners are skipped here (reaped lazily on the next registration).
 *  Markers from pre-#1232 builds carry no fingerprint → never attachable. */
export function discoverLiveInstances(): ProxyInstanceFile[] {
    const out: ProxyInstanceFile[] = [];
    for (const e of readAllRegistryEntries()) {
        if (!isPidAlive(e.pid)) continue;
        out.push({
            origin: e.origin,
            instanceId: e.instanceId,
            pid: e.pid,
            startedAt: e.startedAt,
            host: e.host ?? "",
            port: e.port,
            passthrough: Boolean(e.passthrough),
            mitmDomains: e.mitmDomains ?? [],
            modelWindows: e.modelWindows ?? {},
            modelMaxOutputs: e.modelMaxOutputs,
            lane: e.lane,
            codeFingerprint: e.codeFingerprint,
        });
    }
    return out;
}

/** Unlinks only our own marker; cannot clobber another instance's entry (#527). */
export function unregisterInstance(instanceId: string): void {
    try {
        fs.unlinkSync(registryEntryFile(instanceId));
    } catch {}
}
