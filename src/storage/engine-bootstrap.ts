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
 * Artifacts are pinned PER NODE MAJOR, because the binding is not portable
 * below the floor the package declares (#3341, #3894). better-sqlite3 v13
 * ships N-API prebuilds for all eight platform/arch combinations INSIDE its
 * npm tarball, but it declares `engines: node >= 22` and compiles them for
 * N-API 10, while Node 20 only provides N-API 9 — loading that binding on
 * Node 20 is undefined behavior rather than a clean failure: the win32-x64
 * prebuild faults inside `process.dlopen` (access violation, uncatchable) and
 * the linux-x64 one faults on the first `new Database()`. Node 20 therefore
 * gets the last 12.x line, which declares `engines: 20.x || 22.x || ...` and
 * ships no binding of its own: its npm tarball is pure JS and the native half
 * is an ABI-keyed prebuild (`better-sqlite3-v<ver>-node-v115-<target>.tar.gz`)
 * published on the GitHub release / npmmirror binary mirrors. v12's
 * `lib/database.js` accepts an injected `nativeBinding`, so the two halves
 * compose without `bindings`, `prebuild-install` or any install script — the
 * #2833 contract holds: pinned artifacts, sha512 verified on every download,
 * no host build approval. Downgrading such users to legacy JSON storage would
 * be the wrong answer: legacy is scheduled for removal, so "low Node" must
 * stay on the unified lane with a lower artifact, not fall off it.
 *
 * A spec is eligible only when its Node floor AND (when it has one) its
 * prebuild ABI match the running Node. When nothing is eligible the bootstrap
 * reports `unsupported-node` instead of registering a binding that would crash
 * the process. We pin version + sha512 + floor + per-target prebuild digests
 * in-repo; bumping any of them is a human-visible PR. Download egress honors
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

/** The separate ABI-keyed binding artifact a JS-only npm tarball needs. */
interface EnginePrebuild {
    /** sha512 base64 per Node ABI (`process.versions.modules`) and platform target - pinned in-repo, verified on every download. */
    sha512Base64ByAbi: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

interface EngineBootstrapSpec {
    version: string;
    /** sha512 base64 digest of the registry tarball — pinned in-repo, verified on every download. */
    sha512Base64: string;
    /** Node major floor copied from the artifact's own `engines.node`; below it the binding is undefined behavior (process crash), not a graceful failure. */
    minNodeMajor: number;
    /** Node N-API floor the binding was compiled against (its binding.gyp NAPI_VERSION). A runtime below it cannot load the addon: `process.dlopen` faults uncatchably instead of reporting a missing symbol. Absent = no N-API floor. */
    minNapiVersion?: number;
    /** Present when the npm tarball carries no binding of its own (v12 and earlier). */
    prebuild?: EnginePrebuild;
}

/**
 * Pinned engine artifacts (#2833), one per Node major band. Bump version,
 * digests, floor and ABI together in one PR.
 *
 * Order is preference order: the newest artifact that serves the running Node
 * wins, so a Node 22+ machine keeps the single-tarball v13 lane even though
 * v12 could also serve it. Serving is decided on THREE axes, not just the
 * major: the package's own engines floor, the N-API version the binding was
 * compiled against, and the ABI of the binary we would register. Node
 * 22.0-22.12 passes the v13 major floor but only ships N-API 9, so it falls
 * through to the v12 ABI 127 band instead of dlopen'ing a N-API 10 addon.
 */
const ENGINE_SPECS: readonly EngineBootstrapSpec[] = Object.freeze([
    {
        version: "13.0.3",
        sha512Base64: "RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdVVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
        minNodeMajor: 22,
        minNapiVersion: 10,
    },
    {
        version: "12.9.0",
        sha512Base64: "wqUv4Gm3toFpHDQmaKD4QhZm3g1DjUBI0yzS4UBl6lElUmXFYdTQmmEDpAFa5o8FiFiymURypEnfVHzILKaxqQ==",
        minNodeMajor: 20,
        prebuild: {
            sha512Base64ByAbi: Object.freeze({
                "115": Object.freeze({
                    "linux-x64": "fNMKurhPKb0ki9mnZJK9PVazCiRugcdmauo5qGjqQjUGIrdaVWrb4nlLwU7IiyppcfLu8n/qUsQ5CEZ36uoGaw==",
                    "linux-arm64": "7q7wZe0+5LLQt2YUkocGb41B9TvEMLKIaNI+CiQUQQ2DFBO1RPr3ixj/Gtb+0noMYHjJrqtqKUMO1xMQXnE0iw==",
                    "linuxmusl-x64": "GCriICDKw7K5dNjAVo8xFpSJXcYXXBAK9RDoeuSUv6rB5IVRP96IwxeynTy4Xc21l1507Efz+I2yy6FW5gKQ/w==",
                    "linuxmusl-arm64": "2OWfVP1nklnuR8ZfCwozJcLB0ZpOTRHqAkDpsLonEF5uHZMBnOAzGtd5d+nuPU+KaS5czciU0tXZFhsCUw7dbg==",
                    "darwin-x64": "tW2Vb19+Bh+PLfcGVnrERhc9Mk50Vi8HciIc0nwIJXlPm21xzKL6uEQHMoyKIAxF+vNXxDsUoJyNRg/TgCXjkA==",
                    "darwin-arm64": "H6jehr7s1D/RSTRplCL++hneLTgpqVzgzjrX/NJCsf0OMBSKNGCd9kMYAZJjMlp0IetS39sG5PTG7AcLCTQKeg==",
                    "win32-x64": "r+BAeN980mQEdIwDcrNU3iJqzAryuOyfeICFfYHuHVclonTr2L0IlzsaGp2D50KNWUeLQrIhBCFuNoT2+iBDTw==",
                    "win32-arm64": "jMSa36VrAiLsWFtnwWX+FEs4JWIjHeduVITY44ZcHsqn7BzPcMljL8LdJ0tVVGssV8x9PuqgIqMD5gFmzcYh9w==",
                }),
                "127": Object.freeze({
                    "linux-x64": "jpVKlRCjwmKDIfohRK4Zf/potrKjl2CuvKiWm2SOL1eY7pTRQrGBc1DSEr4OBulYHE6PTl59w7hoAlzNOefG3g==",
                    "linux-arm64": "ei++r3DQbhwXsP97PHYENHnNd3jrai5dy11SCDZqzmqEm6mjloT1qwrpglVJmW4TLliYBJ8U9bMG/6Y8nbDBCQ==",
                    "linuxmusl-x64": "eFglLYVSmdQo7ehLh30dOF4H9csX92XIn1oKB3TdtTZ+7TTh7cfViO7TQIC4NPt6Ufbl3cos9y6/pU8FNL1dQg==",
                    "linuxmusl-arm64": "e72bURjJ4SYseIMY7uW1IkubTqzuKzD6NIVP0InsD8+DJBnRwi8+yIEEcODIK4xsFKSO6tE8TLuvPmetXEk8aA==",
                    "darwin-x64": "GxXg+WENfyP9DGnvOSMnPge+kDkEZmU8cF7EFOoFSzAFhEwYOBvFB4VTTqhZ6G4y54I7ufkjgkOxZmafdSOXOw==",
                    "darwin-arm64": "V1mPpKKnv3AvfZb/++CSOx49tmUi4fba4vORsD8GTaJVwvKmveJ/uPqXaEVhYQgDkao5VLiWL6gN2wk9rQXfPw==",
                    "win32-x64": "7chlb4LP9ETESK6djkGxDq4aDTTByiG1VoUwadJk7JZFhfn2u7vblPCulZaM2C3Ju3jHowc8LBKKQZiH52Uc5g==",
                    "win32-arm64": "0mD1nLGHG066cUFdIgMTEJfhbIeOgD52+dE0r8LAALarhU5JD0uyKPvpQH/V3rBjvwTOtaQtYqeEFgRj5NUL/g==",
                }),
            }),
        },
    },
]);

const SUPPORTED_TARGETS = [
    "linux-x64", "linux-arm64",
    "linuxmusl-x64", "linuxmusl-arm64",
    "darwin-x64", "darwin-arm64",
    "win32-x64", "win32-arm64",
];

// Whole-download budget for the engine artifacts (v13: one ~11 MB tarball;
// v12: ~2.6 MB of JS plus a ~1 MB prebuild). Must cover a multi-MB registry
// fetch over a non-trivial network (corporate proxy / slow link); 10 s locked
// Node<=21 machines into a 6 h legacy-only cooldown after one slow boot
// (#3338). Aligned with the updater's own tarball budget (src/update.ts).
export const BOOTSTRAP_TIMEOUT_MS = 60_000;
export const COOLDOWN_MS = 6 * 60 * 60 * 1000;

type BootstrapStatus =
    | "not-needed"
    | "cache-hit"
    | "downloaded"
    | "disabled"
    | "unsupported-platform"
    | "unsupported-node"
    | "cooldown"
    | "failed";

export interface BootstrapOutcome {
    status: BootstrapStatus;
    detail?: string;
}

let specOverride: EngineBootstrapSpec | null = null;
let platformOverride: string | null = null;
let inFlight: Promise<BootstrapOutcome> | null = null;

/** Test seam: swap the pinned artifact (version/digests/floor) for a hermetic fixture. */
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

/**
 * Pure floor predicate (version in -> verdict out) so tests pin the threshold
 * boundary without depending on the Node running them. An unparseable major
 * counts as satisfied: `process.versions.node` is semver by contract, and
 * bricking unified storage on an exotic runtime would be the worse failure.
 */
export function nodeMajorSatisfiesFloor(minNodeMajor: number, nodeVersion: string = process.versions.node): boolean {
    const major = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
    if (!Number.isFinite(major)) return true;
    return major >= minNodeMajor;
}

/** Why this spec cannot serve the running Node, or null when it can. Both
 *  halves are load-bearing: the floor is what the package declares, the ABI is
 *  what the binary was actually built against — a JS-only tarball whose
 *  prebuild targets a different ABI loads just as badly as one below its floor. */
function specUnusableReason(spec: EngineBootstrapSpec, nodeVersion: string = process.versions.node, nodeAbi: string = process.versions.modules, napiVersion: string = process.versions.napi ?? ""): string | null {
    if (!nodeMajorSatisfiesFloor(spec.minNodeMajor, nodeVersion)) {
        return `better-sqlite3@${spec.version} needs Node.js >= ${spec.minNodeMajor}, this is ${nodeVersion}`;
    }
    if (spec.minNapiVersion !== undefined) {
        const napi = Number.parseInt(napiVersion, 10);
        if (!Number.isFinite(napi)) return null;
        if (napi < spec.minNapiVersion) {
            return `better-sqlite3@${spec.version} is built against N-API ${spec.minNapiVersion}, this Node.js ${nodeVersion} ships N-API ${napiVersion}`;
        }
    }
    if (spec.prebuild && !spec.prebuild.sha512Base64ByAbi[nodeAbi]) {
        return `better-sqlite3@${spec.version} ships no binding for Node ABI ${nodeAbi} (pinned ABIs: ${Object.keys(spec.prebuild.sha512Base64ByAbi).join(", ")}), this is Node.js ${nodeVersion}`;
    }
    return null;
}

function pinnedSpecForThisNode(): EngineBootstrapSpec | null {
    return ENGINE_SPECS.find((s) => specUnusableReason(s) === null) ?? null;
}

/** Pure band selector (runtime triple in -> pinned version out, null = nothing
 *  fits) so tests pin the whole matrix — including the Node 22.0-22.12 band
 *  that passes v13's major floor but predates N-API 10 — without downloads. */
export function pinnedEngineVersionFor(nodeVersion: string = process.versions.node, nodeAbi: string = process.versions.modules, napiVersion: string = process.versions.napi ?? ""): string | null {
    return ENGINE_SPECS.find((s) => specUnusableReason(s, nodeVersion, nodeAbi, napiVersion) === null)?.version ?? null;
}

/** Honest "nothing fits" text: names the running Node/ABI and every pinned
 *  band, so the report explains itself instead of blaming the network. */
function unsupportedNodeDetail(nodeVersion: string = process.versions.node, nodeAbi: string = process.versions.modules): string {
    const covered = ENGINE_SPECS.map((s) => (s.prebuild
        ? `better-sqlite3@${s.version} on Node.js ${s.minNodeMajor}.x (ABI ${Object.keys(s.prebuild.sha512Base64ByAbi).join("/")})`
        : `better-sqlite3@${s.version} on Node.js >= ${s.minNodeMajor} (N-API >= ${s.minNapiVersion ?? 0})`)).join(" or ");
    return `no pinned SQLite engine runs on Node.js ${nodeVersion} (ABI ${nodeAbi}) — the pinned artifacts cover ${covered}`;
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

function finalDir(spec: EngineBootstrapSpec, nodeAbi: string = process.versions.modules): string {
    const suffix = spec.prebuild ? `-abi${nodeAbi}` : "";
    return path.join(cacheRoot(), `better-sqlite3-${spec.version}${suffix}`);
}

function cooldownFile(): string {
    return path.join(cacheRoot(), ".bootstrap-failed.json");
}

export interface CooldownMarker {
    atMs: number;
    reason: string;
}

/** Absolute path of the failure marker (#3788): surfaced in the storage
 *  diagnostics blob so a user can delete it to force an immediate retry
 *  instead of waiting out the whole cooldown window. #4427: the publish-boundary
 *  sink (redactForPublish) rewrites any $HOME prefix to ~ before the blob ships,
 *  so this absolute form never leaks the user's home dir / username publicly. */
export function bootstrapFailureMarkerPath(): string {
    return cooldownFile();
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
    const spec = specOverride ?? pinnedSpecForThisNode();
    if (!spec) {
        const detail = unsupportedNodeDetail();
        loggerLog("warn", `[storage] sqlite engine self-bootstrap: skipped — ${detail}; staying on legacy storage${nodeSqliteUpgradeHint()}`);
        return { status: "unsupported-node", detail };
    }
    const unusable = specUnusableReason(spec);
    if (unusable) {
        // Never register a binding outside the range it declares: the load
        // faults uncatchably, so a probe cannot save us — only refusing can.
        loggerLog("warn", `[storage] sqlite engine self-bootstrap: skipped — ${unusable}; a self-downloaded engine would crash this process on load, staying on legacy storage${nodeSqliteUpgradeHint()}`);
        return { status: "unsupported-node", detail: unusable };
    }
    const target = platformOverride ?? platformTargetKey();
    const dest = finalDir(spec);
    if (cacheUsable(dest, target)) {
        if (!tryRegisterFromCache(dest, spec, target)) {
            // #3135 ⑤/#3818: the copy's bytes were sha-verified when cached,
            // so "unloadable" means the environment changed under it (major
            // Node upgrade, truncated cache write, platform drift). A cache
            // that cannot load is worthless in place — remove it and fall
            // through to ONE pinned re-download (sha512 keeps the retry
            // safe); the old keep-warn-never-retry stance left a #2833
            // user permanently stuck on legacy with only a log line.
            loggerLog("warn", `[storage] sqlite engine self-bootstrap: cached copy present but unloadable — removed, retrying one pinned download`);
            await fsp.rm(dest, { recursive: true, force: true }).catch(() => {
                // best-effort cleanup; the pinned download re-verifies anyway
            });
        } else {
            return { status: "cache-hit", detail: target };
        }
    }
    if (!SUPPORTED_TARGETS.includes(target)) {
        return { status: "unsupported-platform", detail: target };
    }
    if (spec.prebuild && !spec.prebuild.sha512Base64ByAbi[process.versions.modules]?.[target]) {
        return { status: "unsupported-platform", detail: `${target} (no pinned prebuild for better-sqlite3@${spec.version})` };
    }
    if (!resolveSqliteAutoDownload(env, fileStorageAutoDownload())) {
        return { status: "disabled", detail: "storage.sqliteAutoDownload=false" };
    }
    const cd = await readCooldown();
    if (cd && Date.now() - cd.atMs < COOLDOWN_MS) {
        loggerLog("debug", `[storage] sqlite engine self-bootstrap in cooldown (${cd.reason}); skipping`);
        return { status: "cooldown", detail: cd.reason };
    }
    loggerLog("info", `[storage] sqlite engine self-bootstrap: downloading better-sqlite3@${spec.version}${spec.prebuild ? " + its Node-ABI prebuild" : ""} from ${engineMirrors().join(" → ")} ...`);
    try {
        await downloadAndInstall(spec, target, process.versions.modules, opts.resolveProxy);
        if (!tryRegisterFromCache(dest, spec, target)) {
            // #3819 review: the bytes landed but the engine still won't load
            // (AV quarantine, truncated extract, platform drift). Same
            // semantics as a failed attempt below: arm the cooldown so a
            // persistently broken environment stops re-downloading the
            // artifacts per boot, and report "failed" — "downloaded" would
            // claim an engine that never registered.
            const reason = "post-download registration failed";
            await writeCooldown(reason);
            loggerLog("warn", `[storage] sqlite engine self-bootstrap: download ok but engine still unloadable (${reason}) — continuing without it; retrying after ${COOLDOWN_MS / 3_600_000}h`);
            return { status: "failed", detail: reason };
        }
        await clearCooldown();
        await pruneSiblingVersions(dest);
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

/**
 * Mirrors for the ABI-keyed prebuild tarball, which no npm registry serves —
 * upstream publishes it as a GitHub release asset and npmmirror republishes
 * those assets under its binary mirror. npmmirror is tried first because this
 * path only runs on Nodes that cannot use the single-tarball artifact (Node 20
 * and 22.0-22.12 — the CN-heavy population of #3338/#3385) and github.com is
 * unreachable from mainland networks without a proxy.
 */
const BUILTIN_PREBUILD_MIRRORS: readonly string[] = [
    "https://registry.npmmirror.com/-/binary/better-sqlite3",
    "https://github.com/WiseLibs/better-sqlite3/releases/download",
];

let mirrorsOverride: readonly string[] | null = null;
let prebuildMirrorsOverride: readonly string[] | null = null;

export function setEngineMirrorsForTests(mirrors: readonly string[] | null): void {
    mirrorsOverride = mirrors;
}

export function setPrebuildMirrorsForTests(mirrors: readonly string[] | null): void {
    prebuildMirrorsOverride = mirrors;
}

function engineMirrors(): string[] {
    if (mirrorsOverride) return [...mirrorsOverride];
    const configured = normalizeRegistryBase(updateRegistryBase());
    const list = configured ? [configured, ...BUILTIN_REGISTRY_MIRRORS] : [...BUILTIN_REGISTRY_MIRRORS];
    return [...new Set(list)];
}

function prebuildMirrors(): string[] {
    return prebuildMirrorsOverride ? [...prebuildMirrorsOverride] : [...BUILTIN_PREBUILD_MIRRORS];
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

/** v12 and earlier construct with `(file, { nativeBinding })`; the extra option
 *  is what lets a JS-only tarball bind the pinned ABI prebuild without the
 *  `bindings` resolver or an install script. A path (not the addon object) is
 *  passed so the binding is loaded by v12 at construction time, keeping
 *  `dlopen` inside the one call the ABI gate has already cleared. */
type BetterSqlite3CtorWithBinding = new (file: string, options: { nativeBinding: string }) => InstanceType<BetterSqlite3Ctor>;

function withNativeBinding(Database: BetterSqlite3CtorWithBinding, addonPath: string): BetterSqlite3Ctor {
    const Bound = function BoundDatabase(this: unknown, file: string): InstanceType<BetterSqlite3Ctor> {
        return new Database(file, { nativeBinding: addonPath });
    };
    return Bound as unknown as BetterSqlite3Ctor;
}

function tryRegisterFromCache(dir: string, spec: EngineBootstrapSpec, target: string): boolean {
    try {
        const r = createRequire(path.join(dir, "package.json"));
        const mod = r("./lib/index.js") as unknown as BetterSqlite3Ctor;
        if (!spec.prebuild) {
            registerSelfDownloadedBetterSqlite3(() => mod);
            return true;
        }
        const addonPath = path.join(dir, "prebuilds", `${target}.node`);
        if (!existsSync(addonPath)) return false;
        registerSelfDownloadedBetterSqlite3(() => withNativeBinding(mod as unknown as BetterSqlite3CtorWithBinding, addonPath));
        return true;
    } catch (err) {
        loggerLog("debug", `[storage] sqlite engine self-bootstrap: cache registration failed (${String(err)})`);
        return false;
    }
}

const PINNED_DIR_PREFIXES = ENGINE_SPECS.map((s) => `better-sqlite3-${s.version}`);

async function pruneSiblingVersions(keepDir: string): Promise<void> {
    try {
        const entries = await fsp.readdir(cacheRoot());
        await Promise.all(entries.flatMap((e) => {
            const dir = path.join(cacheRoot(), e);
            if (!e.startsWith("better-sqlite3-") || dir === keepDir) return [];
            // Pinned siblings stay: switching Node majors (20 <-> 22) must not
            // re-download an artifact this build already knows how to load. The
            // prefix match also keeps every pinned ABI variant of one version.
            if (PINNED_DIR_PREFIXES.some((p) => e === p || e.startsWith(`${p}-abi`))) return [];
            return [fsp.rm(dir, { recursive: true, force: true }).catch(() => {})];
        }));
    } catch {
        // pruning is housekeeping only — never fail the bootstrap over it
    }
}

// ---------------------------------------------------------------------------
// Download + verify + extract
// ---------------------------------------------------------------------------

async function downloadAndInstall(spec: EngineBootstrapSpec, target: string, nodeAbi: string, resolveProxy?: (url: string) => string | undefined): Promise<void> {
    const root = cacheRoot();
    await fsp.mkdir(root, { recursive: true });
    const tmpDir = path.join(root, `.wip-${randomBytes(6).toString("hex")}`);
    try {
        // #3338 directive 2: walk the mirror list; the FIRST mirror that
        // yields a sha512-verified tarball wins. Fetch + integrity are
        // per-mirror; extraction/publishing happens once, mirror-independent.
        const npmTgz = await fetchFirstMirror(
            engineMirrors().map((base) => ({ url: `${base}/better-sqlite3/-/better-sqlite3-${spec.version}.tgz`, label: base })),
            spec.sha512Base64,
            root,
            resolveProxy,
        );
        await extractTgzToDir(npmTgz, tmpDir, target, { withPrebuilds: !spec.prebuild });
        if (spec.prebuild) {
            const pinned = spec.prebuild.sha512Base64ByAbi[nodeAbi]?.[target];
            if (!pinned) throw new Error(`no pinned prebuild digest for ${target} on ABI ${nodeAbi}`);
            const fileName = `better-sqlite3-v${spec.version}-node-v${nodeAbi}-${target}.tar.gz`;
            const prebuildTgz = await fetchFirstMirror(
                prebuildMirrors().map((base) => ({ url: `${base}/v${spec.version}/${fileName}`, label: base })),
                pinned,
                root,
                resolveProxy,
            );
            await extractPrebuildTgz(prebuildTgz, tmpDir, target);
        }
        const dest = finalDir(spec, nodeAbi);
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
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

interface MirrorAttempt {
    url: string;
    /** Shown in the retry log — the mirror root, not the full asset URL. */
    label: string;
}

async function fetchFirstMirror(attempts: readonly MirrorAttempt[], expectedSha512Base64: string, scratchDir: string, resolveProxy?: (url: string) => string | undefined): Promise<Buffer> {
    const tmpTgz = path.join(scratchDir, `.dl-${randomBytes(6).toString("hex")}.tgz`);
    const attempted: string[] = [];
    let lastErr: unknown = null;
    try {
        for (const attempt of attempts) {
            attempted.push(attempt.label);
            try {
                return await fetchVerifiedTarball(attempt.url, expectedSha512Base64, tmpTgz, resolveProxy);
            } catch (err) {
                lastErr = err;
                loggerLog("warn", `[storage] sqlite engine self-bootstrap: mirror ${attempt.label} failed (${err instanceof Error ? err.message : String(err)}) — trying next mirror`);
            }
        }
        const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
        throw new Error(`${reason} (tried mirrors: ${attempted.join(", ")})`);
    } finally {
        await fsp.rm(tmpTgz, { force: true }).catch(() => {});
    }
}

/** One mirror attempt: stream the tarball to `tmpTgz` while hashing; return
 *  the bytes only when the pinned sha512 matches. Throws on timeout / HTTP
 *  error / integrity mismatch so the caller can advance to the next mirror. */
async function fetchVerifiedTarball(url: string, expectedSha512Base64: string, tmpTgz: string, resolveProxy?: (url: string) => string | undefined): Promise<Buffer> {
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
    if (digest !== expectedSha512Base64) {
        throw new Error(`sha512 mismatch (got ${digest.slice(0, 16)}..., pinned ${expectedSha512Base64.slice(0, 16)}...) — quarantining download`);
    }
    return await fsp.readFile(tmpTgz);
}

// ---------------------------------------------------------------------------
// Minimal tgz extractor (devDeps are unavailable at runtime — bili ships a
// self-contained bundle). Supports exactly what the pinned artifacts contain:
// regular files, directories, GNU long names ('L') and PAX path records ('x').
// Anything else fails loud rather than half-extracting.
// ---------------------------------------------------------------------------

const INCLUDE_EXACT = new Set(["package/package.json"]);

function included(name: string, withPrebuilds: boolean): boolean {
    if (INCLUDE_EXACT.has(name) || name.startsWith("package/lib/")) return true;
    return withPrebuilds && name.startsWith("package/prebuilds/");
}

interface ExtractTgzOptions {
    /** The npm tarball carries `prebuilds/<target>.node` itself (v13). Off for a
     *  JS-only tarball whose binding arrives as a separate ABI prebuild (v12). */
    withPrebuilds?: boolean;
}

export async function extractTgzToDir(tgz: Buffer, destDir: string, target: string, opts: ExtractTgzOptions = {}): Promise<void> {
    const withPrebuilds = opts.withPrebuilds ?? true;
    await fsp.mkdir(destDir, { recursive: true });
    await extractTgzEntries(tgz, (name) => (included(name, withPrebuilds) ? destFor(name, destDir) : null));
    const required = withPrebuilds
        ? ["package.json", path.join("lib", "index.js"), path.join("prebuilds", `${target}.node`)]
        : ["package.json", path.join("lib", "index.js")];
    for (const rel of required) {
        if (!existsSync(path.join(destDir, rel))) throw new Error(`tarball missing required file: ${rel}`);
    }
}

/** Extract the ABI-keyed prebuild tarball (a single `build/Release/*.node`) to
 *  `prebuilds/<target>.node` — the location cacheUsable() and the v12 loader
 *  both expect, regardless of the source layout. */
export async function extractPrebuildTgz(tgz: Buffer, destDir: string, target: string): Promise<void> {
    const dest = path.join(destDir, "prebuilds", `${target}.node`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await extractTgzEntries(tgz, (name) => (name.endsWith(".node") ? dest : null));
    if (!existsSync(dest)) throw new Error(`prebuild tarball missing a .node binding for ${target}`);
}

async function extractTgzEntries(tgz: Buffer, resolveDest: (name: string) => string | null): Promise<void> {
    let data: Buffer;
    try {
        data = gunzipSync(tgz);
    } catch (err) {
        throw new Error(`gunzip failed: ${String(err)}`);
    }
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
        const dest = resolveDest(name);
        if (dest === null) continue;
        if (typeflag === 0x30 || typeflag === 0x00) {
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.writeFile(dest, payload);
        } else if (typeflag === 0x35) {
            await fsp.mkdir(dest, { recursive: true });
        } else {
            throw new Error(`unsupported tar entry type 0x${typeflag.toString(16)} for ${name}`);
        }
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
