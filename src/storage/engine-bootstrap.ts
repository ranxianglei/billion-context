/**
 * SQLite engine self-bootstrap (#2833).
 *
 * Closes the mechanism hole #2823 exposed and #2825 stopgapped: bili must be
 * able to obtain a SQLite engine WITHOUT ever depending on host install-time
 * build-script approval (pnpm >=10 strictDepBuilds hard-fails unlisted native
 * deps; dsh profile bundles run pnpm non-interactively against a fixed list).
 *
 * Resolution order (owner-approved): builtin node:sqlite -> host-provided
 * better-sqlite3 -> cached self-downloaded prebuilt -> (this module downloads
 * the prebuilt when none of the above exists) -> none = legacy-only (#2825
 * contract). This module owns ONLY the download/cache step; driver.ts owns
 * resolution order and opening.
 *
 * Artifact: better-sqlite3 v13 ships N-API prebuilds for all eight
 * platform/arch combinations INSIDE its npm tarball (no install script, no
 * per-ABI split — N-API is ABI-stable across Node versions). We pin version +
 * sha512 in-repo; bumping either is a human-visible PR. Download egress honors
 * the same proxy decision chain as model traffic (#609) and the configured
 * registry mirror (BILI_UPDATE_REGISTRY / update.registry).
 *
 * Failure policy: every path is fail-safe — offline, integrity mismatch,
 * unsupported platform, disk errors all degrade to "no self-downloaded
 * engine" (legacy-only where nothing else exists), log once, and arm a 6h
 * retry cooldown so a permanently-offline machine never re-attempts per boot.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { log as loggerLog } from "../logger.js";
import { cacheDir } from "../paths.js";

import { probeBuiltinSqlite, probeHostBetterSqlite3, registerSelfDownloadedBetterSqlite3, type BetterSqlite3Ctor } from "./driver.js";
import { fileStorageAutoDownload, fileStorageUnified, resolveStorageMode, resolveSqliteAutoDownload, updateRegistryBase } from "../knobs.js";
import { normalizeRegistryBase } from "../update.js";
import { proxyDispatcher } from "../upstream-proxy.js";

interface EngineBootstrapSpec {
    version: string;
    /** sha512 base64 digest of the registry tarball — pinned in-repo, verified on every download. */
    sha512Base64: string;
}

/** Pinned engine artifact (#2833). Bump version AND digest together in one PR. */
const DEFAULT_ENGINE_SPEC: Readonly<EngineBootstrapSpec> = Object.freeze({
    version: "13.0.3",
    sha512Base64: "RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
});

const SUPPORTED_TARGETS = [
    "linux-x64", "linux-arm64",
    "linuxmusl-x64", "linuxmusl-arm64",
    "darwin-x64", "darwin-arm64",
    "win32-x64", "win32-arm64",
];

// Whole-download budget for the ~11 MB engine tarball. Must cover a multi-MB
// registry fetch over a non-trivial network (corporate proxy / slow link);
// 10 s locked Node<=21 machines into a 6 h legacy-only cooldown after one slow
// boot (#3338). Aligned with the updater's own tarball budget (src/update.ts).
export const BOOTSTRAP_TIMEOUT_MS = 60_000;
export const COOLDOWN_MS = 6 * 60 * 60 * 1000;

type BootstrapStatus =
    | "not-needed"
    | "cache-hit"
    | "downloaded"
    | "disabled"
    | "unsupported-platform"
    | "cooldown"
    | "failed";

export interface BootstrapOutcome {
    status: BootstrapStatus;
    detail?: string;
}

let specOverride: EngineBootstrapSpec | null = null;
let platformOverride: string | null = null;
let inFlight: Promise<BootstrapOutcome> | null = null;

/** Test seam: swap the pinned artifact (version/sha) for a hermetic fixture. */
export function setEngineBootstrapSpecForTests(spec: EngineBootstrapSpec | null): void {
    specOverride = spec;
}

/** Test seam: force the platform/arch key (null = real process identity). */
export function setPlatformKeyForTests(key: string | null): void {
    platformOverride = key;
}

/** Test seam: drop the process-dedup promise so the next call re-runs. */
export function resetEngineBootstrapForTests(): void {
    inFlight = null;
}

let bootstrapTimeoutOverrideMs: number | null = null;

/** Test seam: override the whole-download timeout (null = production value). */
export function setBootstrapTimeoutMsForTests(ms: number | null): void {
    bootstrapTimeoutOverrideMs = ms;
}

function activeSpec(): EngineBootstrapSpec {
    return specOverride ?? DEFAULT_ENGINE_SPEC;
}

/** Platform key matching better-sqlite3's own binding.js musl detection. */
export function platformTargetKey(overrides?: { platform?: NodeJS.Platform; arch?: string }): string {
    const platform = overrides?.platform ?? process.platform;
    const arch = overrides?.arch ?? process.arch;
    const p = platform === "linux" && !hasGlibcRuntime() ? "linuxmusl" : platform;
    return `${p}-${arch}`;
}

function hasGlibcRuntime(): boolean {
    try {
        // getReport() types its payload as opaque `object`; narrow the one field we need.
        const report = process.report.getReport() as unknown as { header?: { glibcVersionRuntime?: string } };
        return report.header?.glibcVersionRuntime !== undefined;
    } catch {
        return false;
    }
}

function cacheRoot(): string {
    return path.join(cacheDir(), "sqlite");
}

function finalDir(version: string): string {
    return path.join(cacheRoot(), `better-sqlite3-${version}`);
}

function cooldownFile(): string {
    return path.join(cacheRoot(), ".bootstrap-failed.json");
}

export interface CooldownMarker {
    atMs: number;
    reason: string;
}

/** Sync read of the failure marker for status surfaces (#3040): same file and
 *  shape validation as readCooldown, but synchronous so the web endpoints can
 *  report remaining cooldown without awaiting. */
export function readBootstrapFailureMarker(): CooldownMarker | null {
    try {
        const raw = readFileSync(cooldownFile(), "utf8");
        const j = JSON.parse(raw) as Partial<CooldownMarker>;
        if (typeof j.atMs === "number" && typeof j.reason === "string") return { atMs: j.atMs, reason: j.reason };
        return null;
    } catch {
        return null; // corrupt/absent marker: fail open toward retrying
    }
}

async function readCooldown(): Promise<CooldownMarker | null> {
    try {
        const raw = await fsp.readFile(cooldownFile(), "utf8");
        const j = JSON.parse(raw) as Partial<CooldownMarker>;
        if (typeof j.atMs === "number" && typeof j.reason === "string") return { atMs: j.atMs, reason: j.reason };
        return null;
    } catch {
        return null; // corrupt/absent marker: fail open toward retrying
    }
}

async function writeCooldown(reason: string): Promise<void> {
    try {
        await fsp.mkdir(cacheRoot(), { recursive: true });
        const tmp = `${cooldownFile()}.tmp-${randomBytes(4).toString("hex")}`;
        await fsp.writeFile(tmp, JSON.stringify({ atMs: Date.now(), reason }, null, 1));
        await fsp.rename(tmp, cooldownFile());
    } catch (err) {
        loggerLog("debug", `[storage] sqlite bootstrap cooldown marker not written (${String(err)})`);
    }
}

async function clearCooldown(): Promise<void> {
    await fsp.rm(cooldownFile(), { force: true }).catch(() => {});
}

function cacheUsable(dir: string, target: string): boolean {
    return existsSync(path.join(dir, "package.json"))
        && existsSync(path.join(dir, "lib", "index.js"))
        && existsSync(path.join(dir, "prebuilds", `${target}.node`));
}

interface EnsureSqliteEngineOptions {
    /** Egress proxy resolver (same chain as updater/model traffic, #609). Absent = direct. */
    resolveProxy?: (url: string) => string | undefined;
    /** Env tier for knob resolution (tests inject a controlled env). */
    env?: NodeJS.ProcessEnv;
}

/** Idempotent per process: concurrent callers share one attempt. Never throws —
 *  the caller (CLI server path) awaits it before the first session store opens. */
export function ensureSqliteEngine(opts: EnsureSqliteEngineOptions = {}): Promise<BootstrapOutcome> {
    if (!inFlight) inFlight = runBootstrap(opts);
    return inFlight;
}

async function runBootstrap(opts: EnsureSqliteEngineOptions): Promise<BootstrapOutcome> {
    const env = opts.env ?? process.env;
    if (resolveStorageMode(env, fileStorageUnified()) === "legacy") {
        return { status: "not-needed", detail: "unified storage disabled" };
    }
    if (probeBuiltinSqlite()) {
        return { status: "not-needed", detail: "builtin node:sqlite available" };
    }
    if (probeHostBetterSqlite3()) {
        return { status: "not-needed", detail: "host-provided better-sqlite3 available" };
    }
    const spec = activeSpec();
    const target = platformOverride ?? platformTargetKey();
    const pinnedDir = finalDir(spec.version);
    if (cacheUsable(pinnedDir, target)) {
        if (tryRegisterFromCache(pinnedDir)) return { status: "cache-hit", detail: target };
        // #3135⑤: an unloadable cached copy used to park EVERY boot on
        // "cache-hit" plus a permanent degraded banner. The sha512 pin makes
        // re-downloading safe, so remove the dead copy and run the normal
        // ladder; a fresh download that ALSO fails to load arms the cooldown
        // below, bounding any retry loop to one attempt per window.
        loggerLog("warn", `[storage] sqlite engine self-bootstrap: cached copy at ${pinnedDir} present but unloadable — removing it and re-running the bootstrap`);
        await fsp.rm(pinnedDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!SUPPORTED_TARGETS.includes(target)) {
        return { status: "unsupported-platform", detail: target };
    }
    if (!resolveSqliteAutoDownload(env, fileStorageAutoDownload())) {
        return { status: "disabled", detail: "storage.sqliteAutoDownload=false" };
    }
    const cd = await readCooldown();
    if (cd && Date.now() - cd.atMs < COOLDOWN_MS) {
        loggerLog("debug", `[storage] sqlite engine self-bootstrap in cooldown (${cd.reason}); skipping`);
        return { status: "cooldown", detail: cd.reason };
    }
    loggerLog("info", `[storage] sqlite engine self-bootstrap: downloading better-sqlite3@${spec.version} (~11 MB) from ${engineMirrors().join(" → ")} ...`);
    try {
        await downloadAndInstall(spec, target, opts.resolveProxy);
        if (!tryRegisterFromCache(pinnedDir)) {
            // #3135⑤: bytes verified but unloadable in THIS environment — arm
            // the cooldown so the next boot's rm-leg above hits the marker and
            // returns "cooldown" instead of re-downloading in a loop.
            await writeCooldown("freshly downloaded copy failed to load");
            loggerLog("warn", `[storage] sqlite engine self-bootstrap: freshly downloaded copy failed to load — retrying after ${COOLDOWN_MS / 3_600_000}h`);
            return { status: "downloaded", detail: target };
        }
        await clearCooldown();
        await pruneSiblingVersions(pinnedDir);
        loggerLog("info", `[storage] sqlite engine self-bootstrap: ok — engine=better-sqlite3(self-downloaded v${spec.version})`);
        return { status: "downloaded", detail: target };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeCooldown(reason);
        loggerLog("warn", `[storage] sqlite engine self-bootstrap failed (${reason}) — continuing without a self-downloaded engine; retrying after ${COOLDOWN_MS / 3_600_000}h${nodeSqliteUpgradeHint()}`);
        return { status: "failed", detail: reason };
    }
}

/**
 * Builtin registry mirrors for the engine tarball (#3338 directive 2): npm
 * canonical + npmmirror (CN network reality — the #3338/#3385 machines were
 * win32 boxes whose single-default-registry fetch timed out). A configured
 * registry (BILI_UPDATE_REGISTRY / update.registry) is tried FIRST (user
 * intent wins), then the builtins as fallback. Dedup preserves order.
 * Overridable for tests via setEngineMirrorsForTests.
 */
const BUILTIN_REGISTRY_MIRRORS: readonly string[] = [
    "https://registry.npmjs.org",
    "https://registry.npmmirror.com",
];

let mirrorsOverride: readonly string[] | null = null;

export function setEngineMirrorsForTests(mirrors: readonly string[] | null): void {
    mirrorsOverride = mirrors;
}

function engineMirrors(): string[] {
    if (mirrorsOverride) return [...mirrorsOverride];
    const configured = normalizeRegistryBase(updateRegistryBase());
    const list = configured ? [configured, ...BUILTIN_REGISTRY_MIRRORS] : [...BUILTIN_REGISTRY_MIRRORS];
    return [...new Set(list)];
}

/**
 * Directive 3 of #3338: when this Node lacks builtin node:sqlite (< 22.5),
 * say so with the upgrade lever instead of a bare "engine unavailable" —
 * engines: node >= 20 is in-contract, but node:sqlite ships at >= 22.5, so
 * Node 20 users see "no SQLite engine" unless the tarball download succeeds.
 * Pure (version in → text out) so tests pin the threshold logic; empty string
 * on Nodes that already have the builtin.
 */
export function nodeSqliteUpgradeHint(nodeVersion: string = process.versions.node): string {
    const parts = nodeVersion.split(".").map((p) => Number.parseInt(p, 10));
    const major = parts[0];
    const minor = parts[1];
    const hasBuiltin = typeof major === "number" && typeof minor === "number" && !Number.isNaN(major) && !Number.isNaN(minor) && (major > 22 || (major === 22 && minor >= 5));
    if (hasBuiltin) return "";
    return " — node:sqlite needs Node.js >= 22.5; upgrade Node.js for the builtin engine (engine tarball mirrors tried in order: npm + npmmirror; set BILI_UPDATE_REGISTRY or update.registry to pin one)";
}

function tryRegisterFromCache(dir: string): boolean {
    try {
        const r = createRequire(path.join(dir, "package.json"));
        const mod = r("./lib/index.js") as unknown as BetterSqlite3Ctor;
        registerSelfDownloadedBetterSqlite3(() => mod);
        return true;
    } catch (err) {
        loggerLog("debug", `[storage] sqlite engine self-bootstrap: cache registration failed (${String(err)})`);
        return false;
    }
}

async function pruneSiblingVersions(keepDir: string): Promise<void> {
    try {
        const entries = await fsp.readdir(cacheRoot());
        await Promise.all(entries.flatMap((e) => {
            if (!e.startsWith("better-sqlite3-") || path.join(cacheRoot(), e) === keepDir) return [];
            return [fsp.rm(path.join(cacheRoot(), e), { recursive: true, force: true }).catch(() => {})];
        }));
    } catch {
        // pruning is housekeeping only — never fail the bootstrap over it
    }
}

// ---------------------------------------------------------------------------
// Download + verify + extract
// ---------------------------------------------------------------------------

async function downloadAndInstall(spec: EngineBootstrapSpec, target: string, resolveProxy?: (url: string) => string | undefined): Promise<void> {
    const root = cacheRoot();
    await fsp.mkdir(root, { recursive: true });
    const tmpTgz = path.join(root, `.dl-${randomBytes(6).toString("hex")}.tgz`);
    const tmpDir = path.join(root, `.wip-${randomBytes(6).toString("hex")}`);
    try {
        // #3338 directive 2: walk the mirror list; the FIRST mirror that
        // yields a sha512-verified tarball wins. Fetch + integrity are
        // per-mirror; extraction/publishing happens once, mirror-independent.
        let tgz: Buffer | null = null;
        const attempted: string[] = [];
        let lastErr: unknown = null;
        for (const base of engineMirrors()) {
            const url = `${base}/better-sqlite3/-/better-sqlite3-${spec.version}.tgz`;
            attempted.push(base);
            try {
                tgz = await fetchVerifiedTarball(url, spec, tmpTgz, resolveProxy);
                break;
            } catch (err) {
                lastErr = err;
                loggerLog("warn", `[storage] sqlite engine self-bootstrap: mirror ${base} failed (${err instanceof Error ? err.message : String(err)}) — trying next mirror`);
            }
        }
        if (!tgz) {
            const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
            throw new Error(`${reason} (tried mirrors: ${attempted.join(", ")})`);
        }
        await extractTgzToDir(tgz, tmpDir, target);
        const dest = finalDir(spec.version);
        if (existsSync(dest)) {
            // rename(2) over a non-empty dir is ENOTEMPTY: a stale final dir would
            // fail every attempt and re-arm the 6h cooldown indefinitely. A usable
            // one means a concurrent process already published the same pinned
            // artifact — treat that as success instead of overwriting it.
            if (!cacheUsable(dest, target)) await fsp.rm(dest, { recursive: true, force: true });
            else return;
        }
        await fsp.rename(tmpDir, dest);
    } finally {
        await fsp.rm(tmpTgz, { force: true }).catch(() => {});
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

/** One mirror attempt: stream the tarball to `tmpTgz` while hashing; return
 *  the bytes only when the pinned sha512 matches. Throws on timeout / HTTP
 *  error / integrity mismatch so the caller can advance to the next mirror. */
async function fetchVerifiedTarball(url: string, spec: EngineBootstrapSpec, tmpTgz: string, resolveProxy?: (url: string) => string | undefined): Promise<Buffer> {
    const dispatcher = proxyDispatcher(resolveProxy?.(url));
    // @types/node types RequestInit.dispatcher as its internal Dispatcher;
    // cast once here (no `as any`), same pattern as src/update.ts fetchWithEgress.
    const res = await fetch(url, {
        signal: AbortSignal.timeout(bootstrapTimeoutOverrideMs ?? BOOTSTRAP_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    if (!res.ok || !res.body) throw new Error(`registry returned HTTP ${res.status} for ${url}`);
    const hash = createHash("sha512");
    const out = await fsp.open(tmpTgz, "w");
    try {
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                hash.update(value);
                await out.write(value);
            }
        }
    } finally {
        await out.close();
    }
    const digest = hash.digest("base64");
    if (digest !== spec.sha512Base64) {
        throw new Error(`sha512 mismatch (got ${digest.slice(0, 16)}..., pinned ${spec.sha512Base64.slice(0, 16)}...) — quarantining download`);
    }
    return await fsp.readFile(tmpTgz);
}

// ---------------------------------------------------------------------------
// Minimal tgz extractor (devDeps are unavailable at runtime — bili ships a
// self-contained bundle). Supports exactly what npm tarballs of the pinned
// package contain: regular files, directories, GNU long names ('L') and PAX
// path records ('x'). Anything else fails loud rather than half-extracting.
// Only lib/, prebuilds/ and package.json are materialized (~1.5 MB of the
// 27 MB unpacked tarball — the C++ sources are build-time only).
// ---------------------------------------------------------------------------

const INCLUDE_EXACT = new Set(["package/package.json"]);
const INCLUDE_PREFIXES = ["package/lib/", "package/prebuilds/"];

function included(name: string): boolean {
    return INCLUDE_EXACT.has(name) || INCLUDE_PREFIXES.some((p) => name.startsWith(p));
}

export async function extractTgzToDir(tgz: Buffer, destDir: string, target: string): Promise<void> {
    let data: Buffer;
    try {
        data = gunzipSync(tgz);
    } catch (err) {
        throw new Error(`gunzip failed: ${String(err)}`);
    }
    await fsp.mkdir(destDir, { recursive: true });
    let off = 0;
    let pendingName: string | null = null;
    while (off + 512 <= data.length) {
        const header = data.subarray(off, off + 512);
        if (header.every((b) => b === 0)) break;
        const size = parseOctal(header.subarray(124, 136));
        const typeflag = header[156];
        const name = pendingName ?? cstr(header.subarray(0, 100));
        pendingName = null;
        off += 512;
        const payload = data.subarray(off, off + size);
        // Skip the payload AND its 512-byte padding — advancing only the padding
        // desynchronizes every later header (caught by the hermetic fixture suite).
        off += size + pad512(size);
        if (typeflag === 0x4c) { // 'L' GNU longname: payload IS the real name of the NEXT entry
            pendingName = cstr(payload);
            continue;
        }
        if (typeflag === 0x78 || typeflag === 0x67) { // PAX extended header: honor 'path', ignore the rest
            const paxPath = paxRecordPath(payload);
            if (paxPath) pendingName = paxPath;
            continue;
        }
        if (!included(name)) continue;
        if (typeflag === 0x30 || typeflag === 0x00) {
            const dest = destFor(name, destDir);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.writeFile(dest, payload);
        } else if (typeflag === 0x35) {
            await fsp.mkdir(destFor(name, destDir), { recursive: true });
        } else {
            throw new Error(`unsupported tar entry type 0x${typeflag.toString(16)} for ${name}`);
        }
    }
    for (const required of ["package.json", path.join("lib", "index.js"), path.join("prebuilds", `${target}.node`)]) {
        if (!existsSync(path.join(destDir, required))) throw new Error(`tarball missing required file: ${required}`);
    }
}

function destFor(name: string, destDir: string): string {
    const rel = name.startsWith("package/") ? name.slice("package/".length) : name;
    if (rel.length === 0 || rel.includes("..") || path.isAbsolute(rel)) throw new Error(`unsafe tar path: ${name}`);
    return path.join(destDir, rel);
}

function cstr(buf: Buffer): string {
    const nul = buf.indexOf(0);
    return buf.subarray(0, nul === -1 ? buf.length : nul).toString("utf8");
}

function parseOctal(field: Buffer): number {
    const digits = field.toString("ascii").replace(/[^\d]/g, "").slice(0, 11);
    const n = digits.length > 0 ? parseInt(digits, 8) : 0;
    return Number.isFinite(n) ? n : 0;
}

function pad512(n: number): number {
    return (512 - (n % 512)) % 512;
}

function paxRecordPath(payload: Buffer): string | null {
    let off = 0;
    while (off < payload.length) {
        const sp = payload.indexOf(0x20, off);
        if (sp === -1) break;
        const len = parseInt(payload.subarray(off, sp).toString("ascii"), 10);
        if (!Number.isFinite(len) || len <= 0 || off + len > payload.length) break;
        const rec = payload.subarray(off, off + len).toString("utf8");
        const m = /^(\d+) ([\w.-]+)=(.*)$/.exec(rec);
        if (m && m[2] === "path") return m[3];
        off += len;
    }
    return null;
}
