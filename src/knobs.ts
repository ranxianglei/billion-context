// #2030: canonical home for runtime knobs. Every knob resolves
// env var > config file > default:
//  - the ENV tier is byte-exact with the historical parsing (deployments and
//    test seams set these live after import and rely on the quirks);
//  - the FILE tier reads the JSON config file (strict typed values);
//  - defaults are unchanged from pre-#2030 behavior.
//
// Development standard (AGENTS.md "Environment Variable Discipline"): a new
// knob MUST land here with a config-file key by default. A knob may be
// env-only only when it falls into a documented necessity category — secret,
// per-process channel between bili components, third-party convention,
// bootstrap variable, or host-side posture read in a foreign process — and
// the read site must say so in a comment.
//
// Resolution happens on every call: the ENV tier is read live (deployments and
// test seams set these after import), while the FILE tier goes through
// loadConfigFile()'s content-keyed parse cache (#2078 — the old
// deliberately-uncached readFileSync+JSON.parse per call cost ~5-10 parses per
// request). The raw file text is the invalidation key, so any rewrite is
// visible on the next call — hot-reload (web-UI Apply) and file-mutating test
// seams keep working unchanged.

import path from "node:path";
import { stateDir } from "./paths.js";
import { loadConfigFile } from "./config.js";
import { UPSTREAM_TIMEOUT_MS, REPLAY_MAX_ATTEMPTS, REPLAY_BASE_DELAY_MS } from "./fetch-util.js";
import { PROXY_KEEPALIVE_MAX_MS } from "./upstream-proxy.js";

/** Tiered raw number: the env var wins when SET (even empty/garbage — the
 *  caller applies the historical validation), else a finite number from the
 *  config file, else NaN (caller falls back to its default). */
function tNum(envName: string, fileValue: unknown): number {
    const envRaw = process.env[envName];
    if (envRaw !== undefined) return Number(envRaw);
    return typeof fileValue === "number" && Number.isFinite(fileValue) ? fileValue : NaN;
}

/** Like tNum but an empty-string env counts as UNSET (historical `if (!raw)` guards). */
function tNumLoose(envName: string, fileValue: unknown): number {
    const envRaw = process.env[envName];
    if (envRaw !== undefined && envRaw !== "") return Number(envRaw);
    return typeof fileValue === "number" && Number.isFinite(fileValue) ? fileValue : NaN;
}

function tInt(envName: string, fileValue: unknown): number {
    const envRaw = process.env[envName];
    if (envRaw !== undefined) return Number.parseInt(envRaw, 10);
    return typeof fileValue === "number" && Number.isFinite(fileValue) ? fileValue : NaN;
}

function tIntLoose(envName: string, fileValue: unknown): number {
    const envRaw = process.env[envName];
    if (envRaw !== undefined && envRaw !== "") return Number.parseInt(envRaw, 10);
    return typeof fileValue === "number" && Number.isFinite(fileValue) ? fileValue : NaN;
}

function fileNetwork() {
    return loadConfigFile().network ?? {};
}

// --- network & timing (was BILI_*_MS / BILI_REPLAY_* env-only) ---

/** BILI_UPSTREAM_TIMEOUT_MS > network.upstreamTimeoutMs > 12 minutes. */
export function upstreamTimeoutMs(): number {
    const v = tNum("BILI_UPSTREAM_TIMEOUT_MS", fileNetwork().upstreamTimeoutMs);
    return Number.isInteger(v) && v > 0 ? v : UPSTREAM_TIMEOUT_MS;
}

/** BILI_REPLAY_RETRY_MAX > network.replayRetryMax > 3. */
export function replayMaxAttempts(): number {
    const v = tNum("BILI_REPLAY_RETRY_MAX", fileNetwork().replayRetryMax);
    return Number.isInteger(v) && v >= 1 ? v : REPLAY_MAX_ATTEMPTS;
}

/** BILI_REPLAY_RETRY_BASE_MS > network.replayRetryBaseMs > 1500. */
export function replayBaseDelayMs(): number {
    const v = tNum("BILI_REPLAY_RETRY_BASE_MS", fileNetwork().replayRetryBaseMs);
    return Number.isFinite(v) && v >= 0 ? v : REPLAY_BASE_DELAY_MS;
}

/** BILI_MAX_SHRINK_PER_COMPRESS > network.maxShrinkPerCompress > unset (no steering). */
export function maxShrinkPerCompress(): number | undefined {
    const v = tNum("BILI_MAX_SHRINK_PER_COMPRESS", fileNetwork().maxShrinkPerCompress);
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
}

/** BILI_REQUEST_WATCHDOG_MS > network.requestWatchdogMs > 2× upstream timeout. */
export function requestWatchdogBudgetMs(): number {
    const v = tNumLoose("BILI_REQUEST_WATCHDOG_MS", fileNetwork().requestWatchdogMs);
    return Number.isFinite(v) ? Math.floor(v) : 2 * upstreamTimeoutMs();
}

/** BILI_KEEP_ALIVE_TIMEOUT_MS > network.keepAliveTimeoutMs > 5000. */
export function keepAliveTimeoutMs(): number {
    const v = tNum("BILI_KEEP_ALIVE_TIMEOUT_MS", fileNetwork().keepAliveTimeoutMs);
    return Number.isInteger(v) && v > 0 ? v : 5_000;
}

/** BILI_CLIENT_ERROR_BACKSTOP_MS > network.clientErrorBackstopMs > 30000. */
export function clientErrorBackstopMs(): number {
    const v = tNum("BILI_CLIENT_ERROR_BACKSTOP_MS", fileNetwork().clientErrorBackstopMs);
    return Number.isInteger(v) && v >= 0 ? v : 30_000;
}

/** BILI_EXPOSURE_LOG_INTERVAL_MS > network.exposureLogIntervalMs; garbage → 3600000, 0 disables. */
export function exposureLogIntervalMs(): number {
    const v = tNum("BILI_EXPOSURE_LOG_INTERVAL_MS", fileNetwork().exposureLogIntervalMs);
    return Number.isInteger(v) ? Math.max(0, v) : 3_600_000;
}

const STREAM_KEEPALIVE_DEFAULT_MS = 15_000;

/** BILI_STREAM_KEEPALIVE_MS > network.streamKeepAliveMs > 15000 (0 disables the hold). */
export function streamKeepAliveMs(): number {
    const v = tNumLoose("BILI_STREAM_KEEPALIVE_MS", fileNetwork().streamKeepAliveMs);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : STREAM_KEEPALIVE_DEFAULT_MS;
}

const PREFLIGHT_HOLD_GRACE_DEFAULT_MS = 30_000;

/** BILI_PREFLIGHT_HOLD_MS > network.preflightHoldMs > 30000. */
export function preflightHoldGraceMs(): number {
    const v = tNumLoose("BILI_PREFLIGHT_HOLD_MS", fileNetwork().preflightHoldMs);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : PREFLIGHT_HOLD_GRACE_DEFAULT_MS;
}

const PREFLIGHT_DEAD_END_COOLDOWN_DEFAULT_MS = 5 * 60_000;

/** BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS > network.preflightDeadEndCooldownMs > 300000. */
export function preflightDeadEndCooldownMs(): number {
    const v = tNumLoose("BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS", fileNetwork().preflightDeadEndCooldownMs);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : PREFLIGHT_DEAD_END_COOLDOWN_DEFAULT_MS;
}

/** BILI_PROXY_KEEPALIVE_MAX_MS > network.proxyKeepAliveMaxMs > 55000 (0 = one-shot connections). */
export function proxyKeepAliveMaxMs(): number {
    const v = tNum("BILI_PROXY_KEEPALIVE_MAX_MS", fileNetwork().proxyKeepAliveMaxMs);
    return Number.isFinite(v) && v < 0 ? PROXY_KEEPALIVE_MAX_MS
        : v === 0 ? 0
            : Number.isFinite(v) && v > 0 ? Math.floor(v) : PROXY_KEEPALIVE_MAX_MS;
}

const POST_RESPONSE_LINGER_MS_DEFAULT = 5_000;

/** BILI_POST_RESPONSE_LINGER_MS > network.postResponseLingerMs > 5000 (#1982
 *  post-response close linger budget; mirrors nginx lingering_time). Env tier
 *  preserves the historical parseInt parsing byte-exact: set (even empty/
 *  garbage) wins and non-numeric or non-positive values fall back to the
 *  default without consulting the file tier. */
export function postResponseLingerMs(): number {
    const v = tInt("BILI_POST_RESPONSE_LINGER_MS", fileNetwork().postResponseLingerMs);
    return Number.isFinite(v) && v > 0 ? v : POST_RESPONSE_LINGER_MS_DEFAULT;
}

const MITM_HANDSHAKE_TIMEOUT_MS_DEFAULT = 10_000;

/** BILI_MITM_HANDSHAKE_TIMEOUT_MS > mitm.handshakeTimeoutMs > 10000. */
export function mitmHandshakeTimeoutMs(): number {
    const v = tInt("BILI_MITM_HANDSHAKE_TIMEOUT_MS", loadConfigFile().mitm?.handshakeTimeoutMs);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : MITM_HANDSHAKE_TIMEOUT_MS_DEFAULT;
}

// --- session persistence (was BILI_PERSIST_* env-only) ---

function filePersist() {
    return loadConfigFile().persist ?? {};
}

/** BILI_PERSIST > persist.enabled > true (any non-"0"/non-"false" env value means ON). */
export function persistEnabled(): boolean {
    const envRaw = process.env.BILI_PERSIST;
    if (envRaw !== undefined) return !(envRaw === "0" || envRaw === "false");
    return filePersist().enabled !== false;
}

/** BILI_PERSIST_ZSTD > persist.zstd > false (#1080 owner decision: plain JSON default). */
export function persistZstdEnabled(): boolean {
    const envRaw = process.env.BILI_PERSIST_ZSTD;
    if (envRaw !== undefined) return envRaw === "1" || envRaw === "true";
    return filePersist().zstd === true;
}

/** BILI_PERSIST_DEBOUNCE_MS > persist.debounceMs > 500. */
export function persistDebounceMs(): number {
    const v = tInt("BILI_PERSIST_DEBOUNCE_MS", filePersist().debounceMs);
    return Number.isFinite(v) && v >= 0 ? v : 500;
}

/** BILI_PERSIST_TAIL_TOKENS > persist.tailTokens > 16384 (0 disables message persistence). */
export function persistTailTokens(): number {
    const v = tInt("BILI_PERSIST_TAIL_TOKENS", filePersist().tailTokens);
    return Number.isFinite(v) && v >= 0 ? v : 16_384;
}

/** BILI_PERSIST_EPERM_ALERT_THRESHOLD > persist.epermAlertThreshold > 5. */
export function persistEpermAlertThreshold(): number {
    const v = tInt("BILI_PERSIST_EPERM_ALERT_THRESHOLD", filePersist().epermAlertThreshold);
    return Number.isFinite(v) && v > 0 ? v : 5;
}

/** BILI_PERSIST_EPERM_ALERT_REPEAT_MS > persist.epermAlertRepeatMs > 0 (no repeat cap). */
export function persistEpermAlertRepeatMs(): number {
    const v = tInt("BILI_PERSIST_EPERM_ALERT_REPEAT_MS", filePersist().epermAlertRepeatMs);
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

// --- session pool & GC (was BILI_MAX_SESSIONS / BILI_SESSION_GC* env-only) ---

/** BILI_MAX_SESSIONS > sessions.max > 256. */
export function maxSessions(): number {
    const envRaw = process.env.BILI_MAX_SESSIONS;
    const v = envRaw !== undefined
        ? Number.parseInt(envRaw, 10)
        : (() => {
            const f = loadConfigFile().sessions?.max;
            return typeof f === "number" && Number.isFinite(f) ? f : NaN;
        })();
    return Math.max(1, v || 256);
}

interface GcSettings {
    enabled: boolean;
    maxAgeMs: number;
    maxTokens: number;
    intervalMs: number;
}

const GC_DAY_MS = 86_400_000;

/** BILI_SESSION_GC{,_MAX_AGE_DAYS,_MAX_TOKENS,_INTERVAL_MS} > sessions.gc.* > off/7d/1M/1h. */
export function gcSettings(): GcSettings {
    const gc = loadConfigFile().sessions?.gc ?? {};
    const envRaw = process.env.BILI_SESSION_GC;
    const enabled = envRaw !== undefined
        ? ["1", "true", "on"].includes(envRaw.toLowerCase())
        : gc.enabled === true;
    const ageDays = tIntLoose("BILI_SESSION_GC_MAX_AGE_DAYS", gc.maxAgeDays);
    const maxTokens = tIntLoose("BILI_SESSION_GC_MAX_TOKENS", gc.maxTokens);
    const intervalMs = tIntLoose("BILI_SESSION_GC_INTERVAL_MS", gc.intervalMs);
    return {
        enabled,
        maxAgeMs: (Number.isFinite(ageDays) && ageDays > 0 ? Math.floor(ageDays) : 7) * GC_DAY_MS,
        maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1_000_000,
        intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : 3_600_000,
    };
}

// --- updater (was BILI_UPDATE_REGISTRY / BILI_UPDATE_CHECK_INTERVAL_MS env-only) ---

/** BILI_UPDATE_REGISTRY > update.registry > undefined (caller applies normalizeRegistryBase). */
export function updateRegistryBase(): string | undefined {
    const envRaw = process.env.BILI_UPDATE_REGISTRY;
    if (envRaw !== undefined && envRaw.trim().length > 0) return envRaw.trim();
    const f = loadConfigFile().update?.registry;
    return typeof f === "string" && f.trim().length > 0 ? f.trim() : undefined;
}

/** BILI_UPDATE_CHECK_INTERVAL_MS > update.checkIntervalMs > 180000. */
export function updateCheckIntervalMs(): number {
    const v = tNumLoose("BILI_UPDATE_CHECK_INTERVAL_MS", loadConfigFile().update?.checkIntervalMs);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 3 * 60 * 1000;
}

// --- CCR / codex / misc host-adjacent knobs ---

/** BILI_PUBLIC_SNAPSHOT_CAP_BYTES > plugin.snapshotCapBytes > 100 MiB (#2017
 *  D-B). Caps the raw wire-history snapshot retained per plugin session for
 *  the public fork API; beyond it the session fails closed (409) instead of
 *  retaining an unbounded raw copy. Default raised from 16 MiB on 2026-10-08
 *  (owner sign-off in the #2383 thread, tracked as #2394 G3): a ~20MB+
 *  serialized session — e.g. a multi-million-token dsh fork replay — must
 *  stay forkable out of the box. `0` disables retention entirely. Env tier
 *  preserves the original plugin.ts parsing byte-exact: set (even empty/garbage
 *  → Number() semantics) wins; NaN/negative falls back to the default. */
export function publicSnapshotCapBytes(): number {
    const raw = process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
    const v = raw !== undefined
        ? Number(raw)
        : (() => {
            const f = loadConfigFile().plugin?.snapshotCapBytes;
            return typeof f === "number" && Number.isFinite(f) ? f : NaN;
        })();
    return Number.isFinite(v) && v >= 0 ? v : 104_857_600;
}

/** BILI_CCR_RETRIEVAL_TTL_MS > ccrRetrievalTtlMs > 600000. */
export function ccrRetrievalTtlMs(): number {
    const envRaw = process.env.BILI_CCR_RETRIEVAL_TTL_MS;
    const v = envRaw === undefined || envRaw === ""
        ? (() => {
            const f = loadConfigFile().ccrRetrievalTtlMs;
            return typeof f === "number" ? f : NaN;
        })()
        : Number(envRaw);
    return Number.isFinite(v) && v >= 0 ? v : 10 * 60 * 1000;
}

export type CodexCompactMode = "intercept" | "pass";

/** BILI_CODEX_COMPACT > codexCompact > "intercept". Read per-request so the kill-switch flips without a restart. */
export function codexCompactMode(): CodexCompactMode {
    const envRaw = process.env.BILI_CODEX_COMPACT;
    if (envRaw !== undefined) return envRaw.trim().toLowerCase() === "pass" ? "pass" : "intercept";
    return loadConfigFile().codexCompact === "pass" ? "pass" : "intercept";
}

/** BILI_DECOMPRESS_TMP_CAP > decompressTmpCap > 50. */
export function decompressTmpCap(): number {
    const v = tIntLoose("BILI_DECOMPRESS_TMP_CAP", loadConfigFile().decompressTmpCap);
    return Number.isFinite(v) && v > 0 ? v : 50;
}

// --- diagnostics & debug surface (was ACP_DUMP_*/BILI_DUMP_*/ACP_RENDER_NONE etc.) ---

function fileDiag() {
    return loadConfigFile().diagnostics ?? {};
}

/** ACP_DUMP_BODY > diagnostics.dumpBody > false (conversation bodies leak to disk, #276). */
export function bodyDumpEnabled(): boolean {
    const envRaw = process.env.ACP_DUMP_BODY;
    if (envRaw !== undefined) return envRaw === "1";
    return fileDiag().dumpBody === true;
}

/** ACP_DUMP_REQ > diagnostics.dumpReq > true (request-side dumps ride along with body dumps). */
export function dumpReqAllowed(): boolean {
    const envRaw = process.env.ACP_DUMP_REQ;
    if (envRaw !== undefined) return envRaw !== "0";
    return fileDiag().dumpReq !== false;
}

/** ACP_RAW_DUMP_DIR > diagnostics.rawDumpDir > <state>/raw. */
export function rawDumpDir(): string {
    const envRaw = process.env.ACP_RAW_DUMP_DIR;
    if (envRaw) return envRaw;
    const f = fileDiag().rawDumpDir;
    if (typeof f === "string" && f.trim().length > 0) return f;
    return path.join(stateDir(), "raw");
}

/** BILI_DUMP_4XX > diagnostics.dump4xx > false. */
export function dump4xxEnabled(): boolean {
    const envRaw = process.env.BILI_DUMP_4XX;
    if (envRaw !== undefined) return envRaw === "1";
    return fileDiag().dump4xx === true;
}

/** BILI_DUMP_4XX_MAX_BYTES > diagnostics.dump4xxMaxBytes > 2 MiB (floor 1 KiB). */
export function dump4xxMaxBytes(): number {
    const envRaw = process.env.BILI_DUMP_4XX_MAX_BYTES;
    if (envRaw !== undefined) return Math.max(1024, Number(envRaw) || 2 * 1024 * 1024);
    const f = fileDiag().dump4xxMaxBytes;
    const n = typeof f === "number" && Number.isFinite(f) && f > 0 ? f : NaN;
    return Math.max(1024, n || 2 * 1024 * 1024);
}

/** ACP_RENDER_NONE > diagnostics.renderNone > false (any non-empty env value enables). */
export function renderNone(): boolean {
    const envRaw = process.env.ACP_RENDER_NONE;
    if (envRaw !== undefined) return envRaw.length > 0;
    return fileDiag().renderNone === true;
}

/** ACP_NO_INJECT_TOOL > diagnostics.noInjectTool > false. */
export function noInjectTool(): boolean {
    const envRaw = process.env.ACP_NO_INJECT_TOOL;
    if (envRaw !== undefined) return envRaw.length > 0;
    return fileDiag().noInjectTool === true;
}

/** ACP_NO_COMPRESS_PROMPT > diagnostics.noCompressPrompt > false. */
export function noCompressPrompt(): boolean {
    const envRaw = process.env.ACP_NO_COMPRESS_PROMPT;
    if (envRaw !== undefined) return envRaw.length > 0;
    return fileDiag().noCompressPrompt === true;
}

/** ACP_COUNT_TOKENS_PASSTHROUGH > diagnostics.countTokensPassthrough > false. */
export function countTokensPassthrough(): boolean {
    const envRaw = process.env.ACP_COUNT_TOKENS_PASSTHROUGH;
    if (envRaw !== undefined) return envRaw === "1";
    return fileDiag().countTokensPassthrough === true;
}

/** ACP_COMPRESS_PROTOCOL > diagnostics.compressProtocol > "tools". Frozen at import time by callers. */
export function forceTextProtocol(): boolean {
    const envRaw = process.env.ACP_COMPRESS_PROTOCOL;
    if (envRaw !== undefined) return envRaw === "text";
    return fileDiag().compressProtocol === "text";
}

// --- wire-compat knobs living in the existing compat block ---

/** ACP_KEEP_RESPONSE_ID > compat.keepResponseId > false. */
export function keepResponseId(): boolean {
    const envRaw = process.env.ACP_KEEP_RESPONSE_ID;
    if (envRaw !== undefined) return envRaw === "1";
    return loadConfigFile().compat?.keepResponseId === true;
}

/** BILI_NO_CACHE_CONTROL > compat.noCacheControl > false. Historical quirk preserved in the env
 *  tier: ANY non-empty value (even "0") disables stamping; the file tier is a strict boolean. */
export function noCacheControl(): boolean {
    const envRaw = process.env.BILI_NO_CACHE_CONTROL;
    if (envRaw !== undefined) return envRaw.length > 0;
    return loadConfigFile().compat?.noCacheControl === true;
}

// --- fake-completion fallback (was BILI_FAKE_COMPLETION_* env-only) ---

/** BILI_FAKE_COMPLETION_RETRIES > fakeCompletion.retries > 0 (disabled; opt-in). */
export function fakeCompletionRetries(): number {
    const v = tInt("BILI_FAKE_COMPLETION_RETRIES", loadConfigFile().fakeCompletion?.retries);
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** BILI_FAKE_BUF_CAP > fakeCompletion.bufCapBytes > 16 MiB. */
export function fakeBufCapBytes(): number {
    const v = tInt("BILI_FAKE_BUF_CAP", loadConfigFile().fakeCompletion?.bufCapBytes);
    return Number.isFinite(v) && v > 0 ? v : 16 * 1024 * 1024;
}
