// Global proxy-origin pointer protocol (#405).
//
// The pointer file (stateDir()/proxy-origin) tells host-spawned MCP shells
// which proxy to dial. Two rules keep it honest:
//
//   WRITERS (proxy boot, src/server.ts): never clobber a pointer that a LIVE
//   instance owns — claim only when the existing origin is dead or absent.
//   A sidecar lease (stateDir()/proxy-origin.lease) records who claimed it
//   (port + pid + bootedAt + instanceId) so readers can prove ownership and
//   graceful shutdowns can release exactly their own pointer.
//
//   READERS (MCP shell, src/mcp.ts): never trust the pointer blindly — probe
//   /__bili/health before dialing, fall through candidate origins on a dead
//   one, and re-resolve after any network failure.
//
// The main file keeps its historical format (one URL line) so older shells
// keep reading it; the lease is additive and ignored by them.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

export interface OriginLease {
    v: 2;
    origin: string;
    pid: number;
    bootedAt: number;
    instanceId: string;
}

export interface OriginClaim extends Omit<OriginLease, "v"> {}

type OriginLogger = (level: "info" | "warn", msg: string) => void;

const ORIGIN_RE = /^https?:\/\/\S+$/;
const PROBE_TIMEOUT_MS = 1500;

export function proxyOriginPath(): string {
    return path.join(stateDir(), "proxy-origin");
}

export function proxyLeasePath(): string {
    return path.join(stateDir(), "proxy-origin.lease");
}

function readPointerRaw(): string | null {
    try {
        const raw = fs.readFileSync(proxyOriginPath(), "utf8").trim();
        return raw.length > 0 ? raw : null;
    } catch {
        return null;
    }
}

/** The origin URL currently in the pointer file, or null when absent /
 *  unreadable / not a valid http(s) URL. */
export function readPointerOrigin(): string | null {
    const raw = readPointerRaw();
    return raw !== null && ORIGIN_RE.test(raw) ? raw : null;
}

/** The sidecar lease describing who owns the pointer, or null when absent /
 *  malformed. Never throws. */
export function readPointerLease(): OriginLease | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(proxyLeasePath(), "utf8"));
        if (!parsed || typeof parsed !== "object") return null;
        const l = parsed as Partial<OriginLease>;
        if (typeof l.origin !== "string" || typeof l.pid !== "number" || typeof l.bootedAt !== "number" || typeof l.instanceId !== "string") return null;
        return l as OriginLease;
    } catch {
        return null;
    }
}

/** Liveness probe for a bili instance: GET <origin>/__bili/health. The
 *  response's `instanceId` proves WHICH instance answers (attribution for
 *  rebind logging); older versions answer without it — still live. */
export async function probeOrigin(origin: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<{ live: boolean; instanceId?: string }> {
    try {
        const res = await fetch(`${origin}/__bili/health`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { live: false };
        const data = (await res.json()) as { ok?: boolean; instanceId?: string };
        return { live: data.ok === true, instanceId: typeof data.instanceId === "string" && data.instanceId.length > 0 ? data.instanceId : undefined };
    } catch {
        return { live: false };
    }
}

function writeFileAtomic(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, file);
    } catch (err) {
        try {
            fs.unlinkSync(tmp);
        } catch {}
        throw err;
    }
}

function removeIfExists(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch {}
}

/** Claim the global pointer for this instance at bili boot (#405 fix #2).
 *  If another origin is HEALTHY we keep it — that running instance owns the
 *  pointer, and overwriting it was exactly how launcher-spawned ephemeral
 *  proxies used to hijack discovery (dual-instance fork). Dead pointers get
 *  reclaimed. Best-effort: never throws. Returns true when we hold the file. */
export async function claimProxyOrigin(myOrigin: string, lease: OriginClaim, log: OriginLogger): Promise<boolean> {
    try {
        const existing = readPointerOrigin();
        if (existing !== null && existing !== myOrigin) {
            const probe = await probeOrigin(existing);
            if (probe.live) {
                log("info", `[origin] kept existing proxy-origin ${existing}${probe.instanceId ? ` (live instance ${probe.instanceId.slice(0, 8)})` : ""}; this instance ${myOrigin} did not take the pointer`);
                return false;
            }
            log("info", `[origin] reclaiming dead proxy-origin ${existing} -> ${myOrigin}`);
        }
        writeFileAtomic(proxyOriginPath(), `${myOrigin}\n`);
        const full: OriginLease = { v: 2, origin: lease.origin, pid: lease.pid, bootedAt: lease.bootedAt, instanceId: lease.instanceId };
        writeFileAtomic(proxyLeasePath(), `${JSON.stringify(full)}\n`);
        log("info", `[origin] proxy-origin -> ${myOrigin} (instance ${lease.instanceId.slice(0, 8)}, pid ${lease.pid})`);
        return true;
    } catch (err) {
        log("warn", `[origin] failed to update proxy-origin: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/** Graceful shutdown (#405 fix #2): release the pointer IFF it still points at
 *  us — file origin match, or lease (origin + instanceId) match. When a newer
 *  instance already reclaimed it, neither matches and we leave it alone.
 *  Removing (rather than restoring) the file sends readers down their
 *  fallback chain instead of leaving a dead pointer behind. Never throws. */
export function releaseProxyOrigin(myOrigin: string, instanceId: string, log: OriginLogger): void {
    try {
        const current = readPointerOrigin();
        const lease = readPointerLease();
        const ours = current === myOrigin || (lease !== null && lease.origin === myOrigin && lease.instanceId === instanceId);
        if (!ours) return;
        removeIfExists(proxyOriginPath());
        removeIfExists(proxyLeasePath());
        log("info", `[origin] released proxy-origin (was ${current ?? "?"})`);
    } catch {}
}
