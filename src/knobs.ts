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
import { parseDurationField } from "./duration.js";
import { UPSTREAM_TIMEOUT_MS, REPLAY_MAX_ATTEMPTS, REPLAY_BASE_DELAY_MS } from "./fetch-util.js";
import { PROXY_KEEPALIVE_MAX_MS } from "./upstream-proxy.js";
import { WAL_JOURNAL_SIZE_LIMIT } from "./storage/schema.js";

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

/** Stagger knobs: env stays raw ms (programmatic / e2e pins); the config-file
 *  value accepts either raw ms numbers or human-readable durations parsed by
 *  the shared #3619 leaf ("15m", "2d", "1d12h" — bare numbers or unknown
 *  shapes fall through as NaN so callers see "not set"). */
function staggerKnobMs(envName: string, fileValue: unknown): number {
    const envRaw = process.env[envName];
    if (envRaw !== undefined && envRaw !== "") return Number(envRaw);
    if (typeof fileValue === "number" && Number.isFinite(fileValue)) return fileValue;
    if (typeof fileValue === "string") {
        const ms = parseDurationField(fileValue);
        if (ms !== undefined) return ms;
    }
    return NaN;
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

/** BILI_CA_FILE > network.caFile > unset. Path to a PEM bundle of extra root CAs
 *  trusted by bili's OWN outbound upstream fetch — for security software doing
 *  HTTPS/encrypted-connection scanning (Kaspersky, enterprise DLP) or a corporate
 *  MITM proxy whose re-signed upstream cert Node's default trust (built-ins +
 *  NODE_EXTRA_CA_CERTS) rejects with SELF_SIGNED_CERT_IN_CHAIN (#3776). The PEM is
 *  MERGED with Node's built-in roots, never replacing them (#3776). */
export function upstreamCaFile(): string | undefined {
    const envRaw = process.env["BILI_CA_FILE"];
    if (envRaw !== undefined && envRaw !== "") return envRaw;
    const fileValue = fileNetwork().caFile;
    return typeof fileValue === "string" && fileValue !== "" ? fileValue : undefined;
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

// --- #4204 egress-side 429 throttle governor ---

const THROTTLE_429_MAX_CONSECUTIVE = 5;
const THROTTLE_429_BASE_DELAY_MS = 2_000;
const THROTTLE_429_MAX_DELAY_MS = 30_000;

/** BILI_THROTTLE_429 > network.throttle429Enabled > true. The egress 429
 *  governor (#4204) is ON by default: consecutive upstream 429s put sends to
 *  that origin+credential on local backoff instead of amplifying a
 *  concurrency-style provider limit. "0"/"false" restores the legacy
 *  always-forward behavior. Read per request so the switch flips live. */
export function throttle429Enabled(): boolean {
    const envRaw = process.env.BILI_THROTTLE_429;
    if (envRaw !== undefined) return !(envRaw === "0" || envRaw === "false");
    return fileNetwork().throttle429Enabled !== false;
}

/** BILI_THROTTLE_429_MAX_CONSECUTIVE > network.throttle429MaxConsecutive > 5.
 *  Consecutive upstream 429s before the hold turns TERMINAL (local 424 answers
 *  outside every known SDK retry set, so hosts stop re-driving). */
export function throttle429MaxConsecutive(): number {
    const v = tInt("BILI_THROTTLE_429_MAX_CONSECUTIVE", fileNetwork().throttle429MaxConsecutive);
    return Number.isInteger(v) && v >= 1 ? v : THROTTLE_429_MAX_CONSECUTIVE;
}

/** BILI_THROTTLE_429_BASE_DELAY_MS > network.throttle429BaseDelayMs > 2000. */
export function throttle429BaseDelayMs(): number {
    const v = tNum("BILI_THROTTLE_429_BASE_DELAY_MS", fileNetwork().throttle429BaseDelayMs);
    return Number.isFinite(v) && v >= 0 ? v : THROTTLE_429_BASE_DELAY_MS;
}

/** BILI_THROTTLE_429_MAX_DELAY_MS > network.throttle429MaxDelayMs > 30000. */
export function throttle429MaxDelayMs(): number {
    const v = tNum("BILI_THROTTLE_429_MAX_DELAY_MS", fileNetwork().throttle429MaxDelayMs);
    return Number.isFinite(v) && v >= 0 ? v : THROTTLE_429_MAX_DELAY_MS;
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

/** BILI_ALLOW_PRIVATE_HTTP_PROVIDERS > network.allowPrivateHttpProviders > false
 *  (#2984 opt-in plain-HTTP trust for private-network providers; positive
 *  judgment mirrors persistZstdEnabled — only "1"/"true" enable). */
export function allowPrivateHttpProviders(): boolean {
    const envRaw = process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS;
    if (envRaw !== undefined) return envRaw === "1" || envRaw === "true";
    return fileNetwork().allowPrivateHttpProviders === true;
}

const MITM_HANDSHAKE_TIMEOUT_MS_DEFAULT = 10_000;

/** BILI_MITM_HANDSHAKE_TIMEOUT_MS > mitm.handshakeTimeoutMs > 10000. */
export function mitmHandshakeTimeoutMs(): number {
    const v = tInt("BILI_MITM_HANDSHAKE_TIMEOUT_MS", loadConfigFile().mitm?.handshakeTimeoutMs);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : MITM_HANDSHAKE_TIMEOUT_MS_DEFAULT;
}

// --- request-body byte budgets (#3128) ---

const DEFAULT_LIMITS_RECEIVE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_LIMITS_DECODED_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_LIMITS_OUTBOUND_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_WS_OUTBOUND_BYTES = 10 * 1024 * 1024;

/** BILI_RECEIVE_BODY_BYTES > network.receiveBodyBytes > 5 GiB. Max inbound wire bytes
 *  read into memory per request. #3128: these were hardcoded 100 MiB constants; the
 *  HTTP path now resolves them here with a 5 GiB default so multi-gigabyte single
 *  requests are accepted instead of reset. They bound SINGLE-REQUEST in-RAM buffering
 *  (~2x peak while a body is read+decoded); cross-turn history lives in SQLite and is
 *  unaffected. The WebSocket lanes keep the fixed 100 MiB surface (MAX_REQUEST_BYTES). */
export function limitsReceiveBytes(): number {
    const v = tInt("BILI_RECEIVE_BODY_BYTES", loadConfigFile().network?.receiveBodyBytes);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LIMITS_RECEIVE_BYTES;
}

/** BILI_DECODED_BODY_BYTES > network.decodedBodyBytes > 10 GiB. Max DECODED bytes after
 *  content-encoding expansion (2x the receive default, mirroring the legacy decode cap). */
export function limitsDecodedBytes(): number {
    const v = tInt("BILI_DECODED_BODY_BYTES", loadConfigFile().network?.decodedBodyBytes);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LIMITS_DECODED_BYTES;
}

/** BILI_OUTBOUND_BODY_BYTES > network.outboundBodyBytes > 5 GiB. Max rebuilt bytes forwarded upstream. */
export function limitsOutboundBytes(): number {
    const v = tInt("BILI_OUTBOUND_BODY_BYTES", loadConfigFile().network?.outboundBodyBytes);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LIMITS_OUTBOUND_BYTES;
}

/** BILI_WS_OUTBOUND_BYTES > network.wsOutboundBytes > 10 MiB. Soft egress byte budget for the
 *  WebSocket lane (#3701): above it, older non-protected images are archived/downscaled from
 *  the OUTBOUND COPY before sending, because the observed WS gateway rejects oversized frames
 *  with close 1009 and zero events regardless of token usage. The default sits below the
 *  smallest failing observation (16.1 MiB) with margin, above the smallest success (11.5 MiB);
 *  it is a bili-side budget, not a proven upstream limit. 0 disables the pre-send shed
 *  (legacy send-as-is). The HTTP lane is unaffected: its hard refusal cap stays
 *  network.outboundBodyBytes. */
export function limitsWsOutboundBytes(): number {
    const v = tInt("BILI_WS_OUTBOUND_BYTES", loadConfigFile().network?.wsOutboundBytes);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_WS_OUTBOUND_BYTES;
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

// --- auto-mode classifier forge (#2740) ---

/** BILI_AUTO_MODE_FORGE > autoModeForge.enabled > true (#2740 owner decision:
 *  local forge ON by default — zero egress/billing for the lane; "0"/"false"
 *  restores pure passthrough for users who pay for real verdicts). */
export function autoModeForgeEnabled(): boolean {
    const envRaw = process.env.BILI_AUTO_MODE_FORGE;
    if (envRaw !== undefined) return !(envRaw === "0" || envRaw === "false");
    return loadConfigFile().autoModeForge?.enabled !== false;
}

// --- pi/omp plugin tool guardrails (#3066, #3331) — read in the pi/omp host
// process, so the env tier is what the launcher forwards; the FILE tier reads
// the same state dir's config the proxy reads. ---

/** BILI_GUARDRAIL_BASH_TIMEOUT > guardrails.bashTimeout > 60 (#3066 owner
 *  intent, re-affirmed in #3366: an unsupervised bash call could hang a pi
 *  session for a whole day — the host schema provides no default, so the
 *  proxy injects one). Positive N = inject N seconds as the bash `timeout`
 *  when the model omits it; 0 (or negative) disables injection for hosts
 *  that want pi-native behavior. */
export function guardrailBashTimeout(): number | undefined {
    const n = tNumLoose("BILI_GUARDRAIL_BASH_TIMEOUT", loadConfigFile().guardrails?.bashTimeout);
    if (!Number.isFinite(n)) return 60;
    return n > 0 ? Math.floor(n) : undefined; // 0 or negative = no injection
}

/** BILI_GUARDRAIL_MAX_OUTPUT_BYTES > guardrails.maxOutputBytes > 50000 (50KB). 0 disables the cap. */
export function guardrailMaxOutputBytes(): number | undefined {
    const n = tNumLoose("BILI_GUARDRAIL_MAX_OUTPUT_BYTES", loadConfigFile().guardrails?.maxOutputBytes);
    if (!Number.isFinite(n)) return 50_000;
    return n > 0 ? Math.floor(n) : undefined; // 0 or negative = no cap
}

/** BILI_GUARDRAIL_REPETITION > guardrails.repetition > true (identical-call loop-breaker, warn 3 / abort 5). */
export function guardrailRepetition(): boolean {
    const envRaw = process.env.BILI_GUARDRAIL_REPETITION;
    if (envRaw !== undefined) return !(envRaw === "0" || envRaw === "false");
    return loadConfigFile().guardrails?.repetition !== false;
}

/** #3260 text-run breaker default: parity with pi's findDegenerateRuns minRun
 *  (200) — single exported source so runaway-guard.ts and the docs never
 *  drift apart. */
export const DEFAULT_TEXT_RUN_THRESHOLD = 200;

/** BILI_GUARDRAIL_TEXT_RUN_THRESHOLD > guardrails.textRunThreshold > 200
 *  (#3406 item 1, from the #3331 review: the output-side single-codepoint
 *  repetition breaker had no escape hatch — legit long same-char output (code
 *  comment separators, ASCII rules) got cut mid-stream, and the
 *  thinking/reasoning channels sit inside the lane too). Positive N = trip at
 *  N consecutive identical codepoints in decoded model text; 0 (or negative)
 *  disables the lane. Unlike the three guardrail knobs above this one is read
 *  in the PROXY process (the stream guard), not the pi/omp host. */
export function guardrailTextRunThreshold(): number {
    const n = tNumLoose("BILI_GUARDRAIL_TEXT_RUN_THRESHOLD", loadConfigFile().guardrails?.textRunThreshold);
    if (!Number.isFinite(n)) return DEFAULT_TEXT_RUN_THRESHOLD;
    return n > 0 ? Math.floor(n) : 0; // 0 or negative = lane off
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

/** BILI_SESSION_WARM_MAX > sessions.warmMax > 0 (#2803 bounded startup, #3050 R3 ②-0:
 *  how many most-recently-saved sessions boot hydrates before listening; 0 warms none.
 *  Default 0 — measured -151 MB RSS at boot with no traffic-facing cost: an un-warmed
 *  session pays one on-demand load (file read or unified lookup) on first touch
 *  instead. Set 8 to restore the #2803 eager warm set.) */
export function sessionWarmMax(): number {
    const v = tInt("BILI_SESSION_WARM_MAX", loadConfigFile().sessions?.warmMax);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** BILI_SESSION_WARM_MAX_BYTES > sessions.warmMaxBytes > 64 MiB (#2803 decoded-byte
 *  budget for the boot warm set; a single file over the budget is never warmed). */
export function sessionWarmMaxBytes(): number {
    const v = tInt("BILI_SESSION_WARM_MAX_BYTES", loadConfigFile().sessions?.warmMaxBytes);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 64 * 1024 * 1024;
}

/** BILI_SESSION_RESIDENT_MAX_BYTES > sessions.residentMaxBytes > 512 MiB (#2803 soft
 *  target for estimated resident session bytes; active/in-flight state stays pinned). */
export function sessionResidentMaxBytes(): number {
    const v = tInt("BILI_SESSION_RESIDENT_MAX_BYTES", loadConfigFile().sessions?.residentMaxBytes);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 512 * 1024 * 1024;
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

/** BILI_UPDATE_POLICY_URL > update.policyUrl > undefined (caller applies the
 *  official-repo raw default). The override exists for TESTS — the production
 *  URL is fixed to the official repo (#3619 security boundary). */
export function updatePolicyUrl(): string | undefined {
    const envRaw = process.env.BILI_UPDATE_POLICY_URL;
    if (envRaw !== undefined && envRaw.trim().length > 0) return envRaw.trim();
    const f = loadConfigFile().update?.policyUrl;
    return typeof f === "string" && f.trim().length > 0 ? f.trim() : undefined;
}

/** BILI_UPDATE_STAGGER_MIN_MS > update.staggerMinDelayMs > undefined. The
 *  undefined result means "not set locally": the caller composes with the
 *  remote policy's default window and then the built-in 15-min floor (#3619).
 *  0 is valid: it disables the delay for this machine (legacy immediate).
 *  The env var is raw ms (programmatic); the config-file value additionally
 *  accepts human-readable durations like "15m" / "1d12h" (#3619). */
export function updateStaggerMinDelayMs(): number | undefined {
    const v = staggerKnobMs("BILI_UPDATE_STAGGER_MIN_MS", loadConfigFile().update?.staggerMinDelayMs);
    return Number.isInteger(v) && v >= 0 ? Math.floor(v) : undefined;
}

/** BILI_UPDATE_STAGGER_MAX_MS > update.staggerMaxDelayMs > undefined (built-in 48 h).
 *  0 is valid: together with min 0 it restores legacy immediate upgrades.
 *  Same string-duration support as the min knob above. */
export function updateStaggerMaxDelayMs(): number | undefined {
    const v = staggerKnobMs("BILI_UPDATE_STAGGER_MAX_MS", loadConfigFile().update?.staggerMaxDelayMs);
    return Number.isInteger(v) && v >= 0 ? Math.floor(v) : undefined;
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

/** BILI_DSH_AUTHORED_COMPACTION — #3733 bili-authored dsh client compaction.
 *  Default OFF ("0"/unset): the #1729 guard keeps refusing dsh's native
 *  compaction summarize calls, exactly as before. "1": when the session
 *  holds active fold blocks, the guard site answers the call LOCALLY with
 *  our folded snapshot (zero egress) instead of refusing — dsh records our
 *  checkpoint and its file shrinks (#3733/#3723). Read per-request so a
 *  running proxy flips without a restart. Env-only for the rollout window;
 *  the #2028-style file/web toggle follows once adopted. */
export function dshAuthoredCompactionEnabled(): boolean {
    const envRaw = process.env.BILI_DSH_AUTHORED_COMPACTION;
    if (envRaw !== undefined) return envRaw.trim() !== "0";
    // #3723/#3901 flip: ON by default since the 0.1.203 dogfood window held
    // (the guard answers locally, zero egress — the failure mode is a dsh
    // checkpoint not shrinking, never data loss). The config-file key
    // `dsh.authoredCompaction` mirrors the env; "0"/false is the escape
    // hatch back to the #1729 refusal path.
    const file = loadConfigFile().dsh?.authoredCompaction;
    if (typeof file === "boolean") return file;
    return true;
}

/** BILI_DSH_CONTEXT_TAB > dsh.contextTab > true (#4237). Whether the official
 *  dsh client registers its per-session Context tab (conversation.view slot).
 *  Default ON = today's behavior; "0"/"false" (env) or false (file) hides the
 *  top-bar entry only — compression is untouched and the ledger stays
 *  reachable through the settings section, the plugin bundle config face, the
 *  Web UI and /acp. Resolved by the host half at page-load time and shipped to
 *  the browser half via the __BILI__ snapshot / /bili/origin route. */
export function dshContextTabEnabled(): boolean {
    const envRaw = process.env.BILI_DSH_CONTEXT_TAB;
    if (envRaw !== undefined) return !(envRaw.trim() === "0" || envRaw.trim().toLowerCase() === "false");
    return loadConfigFile().dsh?.contextTab !== false;
}

/** dsh.contextTabLabel (#4237): custom label for that Context tab. File-only
 *  on purpose (#2030 env-var discipline: a display preference, not a secret /
 *  spawn channel / host posture) and settable from the Web config page. A
 *  trimmed non-empty string wins over the built-in localized label; anything
 *  else keeps it. */
export function dshContextTabLabel(): string | undefined {
    const f = loadConfigFile().dsh?.contextTabLabel;
    const s = typeof f === "string" ? f.trim() : "";
    return s.length > 0 ? s : undefined;
}

/** BILI_DECOMPRESS_TMP_CAP > decompressTmpCap > 50. */
export function decompressTmpCap(): number {
    const v = tIntLoose("BILI_DECOMPRESS_TMP_CAP", loadConfigFile().decompressTmpCap);
    return Number.isFinite(v) && v > 0 ? v : 50;
}

// --- image rescale (#3400) ---

/** Default longest-edge target of the egress rescale pass (single source of
 *  truth; BILI_IMAGE_RESCALE_MAX_DIM overrides). */
const IMAGE_RESCALE_DEFAULT_MAX_DIM = 1600;

/** BILI_IMAGE_RESCALE > imageRescale > true. The egress image-rescale pass is
 *  ON by default (owner decision, #3400): big images are sent downscaled and
 *  the original stays in local session storage. "0"/"false" disables it
 *  (every image passes through untouched). Read per request so the switch
 *  flips without a restart. */
export function imageRescaleEnabled(): boolean {
    const envRaw = process.env.BILI_IMAGE_RESCALE;
    if (envRaw !== undefined) return !(envRaw === "0" || envRaw === "false");
    return loadConfigFile().imageRescale !== false;
}

/** BILI_IMAGE_RESCALE_MAX_DIM > IMAGE_RESCALE_DEFAULT_MAX_DIM. Longest-edge
 *  target of the rescale pass (fit-inside, never upscale). Env-only by design
 *  (#3400 spec): the config file carries just the on/off key. Floor 128 keeps
 *  a typo'd 0/16 from degenerating every image to an icon. */
export function imageRescaleMaxDim(): number {
    const v = tIntLoose("BILI_IMAGE_RESCALE_MAX_DIM", undefined);
    return Number.isInteger(v) && v >= 128 ? v : IMAGE_RESCALE_DEFAULT_MAX_DIM;
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

/** BILI_DUMP_MAX_TOTAL_BYTES > diagnostics.maxTotalBytes > off (null). Total-size cap
 *  for debug dump dirs (#2412); floor 1 MiB; 0/negative/non-numeric = off. */
export function dumpGcMaxTotalBytes(): number | null {
    const envRaw = process.env.BILI_DUMP_MAX_TOTAL_BYTES;
    if (envRaw !== undefined) {
        const v = Number(envRaw);
        return Number.isFinite(v) && v > 0 ? Math.max(1 << 20, v) : null;
    }
    const f = fileDiag().maxTotalBytes;
    if (typeof f === "number" && Number.isFinite(f) && f > 0) return Math.max(1 << 20, f);
    return null;
}

/** BILI_DUMP_MAX_AGE_DAYS > diagnostics.maxAgeDays > off (null). Age cap for debug dump
 *  dirs (#2412); floor 1 h; 0/negative/non-numeric = off. */
export function dumpGcMaxAgeMs(): number | null {
    const envRaw = process.env.BILI_DUMP_MAX_AGE_DAYS;
    if (envRaw !== undefined) {
        const d = Number(envRaw);
        return Number.isFinite(d) && d > 0 ? Math.max(1 / 24, d) * 86_400_000 : null;
    }
    const f = fileDiag().maxAgeDays;
    if (typeof f === "number" && Number.isFinite(f) && f > 0) return Math.max(1 / 24, f) * 86_400_000;
    return null;
}

/** ACP_RENDER_NONE > diagnostics.renderNone > false (any non-empty env value enables). */
export function renderNone(): boolean {
    const envRaw = process.env.ACP_RENDER_NONE;
    if (envRaw !== undefined) return envRaw.length > 0;
    return fileDiag().renderNone === true;
}

/** BILI_INVARIANT_JUDGE > diagnostics.invariantJudge > true (#3938 decision ②).
 * The I1/I2 outbound-invariant judge runs as an L1 advisory on every request —
 * violations log at warn, clean verdicts at debug, traffic is never blocked.
 * "0"/"false" disarms (env precedence follows the boolean-off convention so an
 * operator can silence a noisy judge without a config edit). */
export function invariantJudgeEnabled(): boolean {
    const envRaw = process.env.BILI_INVARIANT_JUDGE;
    if (envRaw !== undefined) return !(envRaw === "0" || envRaw === "false" || envRaw === "off");
    const f = fileDiag().invariantJudge;
    return typeof f === "boolean" ? f : true;
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

/** Config-file tiers of the storage knobs (#3040): single readers so the
 *  runtime-status surface and the store constructor report exactly what the
 *  file says (moved out of persist.ts, which used to be the only home). */
export function fileStorageUnified(): string | undefined {
    const v = loadConfigFile().storage?.unified;
    return typeof v === "string" ? v : undefined;
}

export function fileStorageJsonWriter(): string | undefined {
    const v = loadConfigFile().storage?.jsonWriter;
    return typeof v === "string" ? v : undefined;
}

export function fileStorageAutoDownload(): boolean | undefined {
    const v = loadConfigFile().storage?.sqliteAutoDownload;
    return typeof v === "boolean" ? v : undefined;
}

export function fileStorageArchiveAfterDays(): number | undefined {
    const v = loadConfigFile().storage?.archiveAfterDays;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function fileStorageBackend(): string | undefined {
    const v = loadConfigFile().storage?.backend;
    return typeof v === "string" ? v : undefined;
}

/** storage.mysql.dsn (#3388 step 2): the DSN for storage.backend="mysql".
 *  env BILI_MYSQL_DSN wins (resolveMysqlDsn applies the precedence). */
export function fileStorageMysqlDsn(): string | undefined {
    const v = loadConfigFile().storage?.mysql?.dsn;
    return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

export function fileStorageWalJournalSizeLimit(): number | undefined {
    const v = loadConfigFile().storage?.walJournalSizeLimitBytes;
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Tiered storage-migration switch (#2671): legacy | shadow | full. Lives here
 *  per the env-var discipline — env tier BILI_STORAGE_UNIFIED (1/true = shadow,
 *  full/unified = full, 0/false/legacy/garbage = legacy) wins over the
 *  config-file `storage.unified` value (strict spellings); absent everywhere =
 *  full (#3818 flip — the shadow dry-run ran as the default since #2815 and
 *  the digest reconciliation held, so the index is now the load path by
 *  default; JSON envelopes keep being written, and "legacy" remains the
 *  one-line escape hatch). */
export type StorageMode = "legacy" | "shadow" | "full";

/** Resolve the unified-storage level. Pure: env + file tier value in, mode out
 *  (total function — never throws; an explicit legacy or a garbage spelling
 *  degrades to legacy, only full absence lands on the default). */
/** #3901/#3463: session retention window in days. Sessions whose
 *  updated_at is older than the cutoff are archived by gc() (export +
 *  tombstone + CAS release). 0 disables the age sweep entirely. env
 *  BILI_STORAGE_ARCHIVE_AFTER_DAYS > file storage.archiveAfterDays >
 *  default 365. */
export function resolveArchiveAfterDays(env: NodeJS.ProcessEnv = process.env, fileDays?: number): number {
    const raw = env.BILI_STORAGE_ARCHIVE_AFTER_DAYS?.trim();
    if (raw !== undefined && raw !== "") {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    if (typeof fileDays === "number" && Number.isFinite(fileDays) && fileDays >= 0) return fileDays;
    return 365;
}

export function resolveStorageMode(env: NodeJS.ProcessEnv = process.env, fileUnified?: string): StorageMode {
    const raw = env.BILI_STORAGE_UNIFIED?.trim().toLowerCase();
    if (raw) {
        if (raw === "full" || raw === "unified") return "full";
        if (raw === "1" || raw === "true" || raw === "shadow") return "shadow";
        return "legacy";
    }
    const file = fileUnified?.trim().toLowerCase();
    if (file === "full") return "full";
    if (file === "shadow") return "shadow";
    if (file) return "legacy";
    return "full";
}

/** Phase 3 JSON-envelope switch (#2960): when the unified store runs in
 *  full mode, `storage.jsonWriter=off` stops writing the legacy JSON envelope —
 *  the SQLite index becomes the only persistent copy (reads were already
 *  unified-first since #2671; boot enumerates the index union since #2992).
 *  Env BILI_STORAGE_JSON_WRITER (0/false/off = off; 1/true/on = on) wins over
 *  the config-file `storage.jsonWriter` value; absent = on. Only honored when
 *  the effective mode is full — under shadow/legacy the JSON file remains the
 *  sole source of truth and the request is ignored with a one-time warning.
 *  Rollback: unset the knob (JSON writing resumes; index-only sessions keep
 *  loading via the boot union, and replicas/restore re-materialize envelopes). */
export function resolveJsonWriterOff(env: NodeJS.ProcessEnv = process.env, fileValue?: string): boolean {
    const raw = env.BILI_STORAGE_JSON_WRITER?.trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off") return true;
    if (raw === "1" || raw === "true" || raw === "on") return false;
    return fileValue?.trim().toLowerCase() === "off";
}

/** Snapshot-render SHADOW observability switch (#3756 follow-up): compute the
 *  snapshot view on every armed proxy turn WITHOUT using it (outbound bytes
 *  stay the legacy path), classify the diff against what was actually sent,
 *  and record per-session counters surfaced by the web panel + the
 *  `snapshot-shadow` diagnostics topic. This is how the fleet proves the
 *  render engine healthy BEFORE the rollout flip — the same dry-run-then-flip
 *  discipline storage used (#2815 shadow → #3818 full default).
 *  Env BILI_SNAPSHOT_SHADOW (0/false/off = off; 1/true/on = on) wins over the
 *  config-file `snapshot.shadow` boolean; absent everywhere = ON (the render
 *  lane itself stays rollout-gated at 0%, so the shadow lane is pure
 *  observation). Garbage spellings fall through to the file/default tier.
 *  Pure: env + file value in, decision out (never throws). */
export function resolveSnapshotShadow(env: NodeJS.ProcessEnv = process.env, fileShadow?: boolean): boolean {
    const raw = env.BILI_SNAPSHOT_SHADOW?.trim().toLowerCase();
    if (raw === "1" || raw === "true" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "off") return false;
    return typeof fileShadow === "boolean" ? fileShadow : true;
}

/** SQLite engine self-download switch (#2833): env BILI_SQLITE_AUTO_DOWNLOAD
 *  (1/true vs 0/false, strict) wins over config-file `storage.sqliteAutoDownload`
 *  (strict boolean); absent = true (enabled). Garbage env values fall through to
 *  the file/default tier rather than silently disabling the download. Pure:
 *  env + file value in, decision out (never throws). */
export function resolveSqliteAutoDownload(env: NodeJS.ProcessEnv = process.env, fileValue?: boolean): boolean {
    const raw = env.BILI_SQLITE_AUTO_DOWNLOAD?.trim().toLowerCase();
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return typeof fileValue === "boolean" ? fileValue : true;
}

/** #3250 WAL reclamation cap in bytes. Env
 *  BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES (positive integer) wins over the
 *  config-file `storage.walJournalSizeLimitBytes`; a garbage/non-positive env
 *  value falls through to the file/default tier (same discipline as
 *  resolveSqliteAutoDownload — never crash boot on a typo'd knob). Pure:
 *  env + file value in, bytes out (never throws). */
export function resolveStorageWalJournalSizeLimit(env: NodeJS.ProcessEnv = process.env, fileValue?: number): number {
    const raw = env.BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES?.trim();
    if (raw) {
        const n = Number(raw);
        if (Number.isInteger(n) && n > 0) return n;
    }
    if (typeof fileValue === "number" && Number.isInteger(fileValue) && fileValue > 0) return fileValue;
    return WAL_JOURNAL_SIZE_LIMIT;
}
