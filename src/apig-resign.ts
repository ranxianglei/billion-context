import { createHash, createHmac } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RESIGN_BUILTIN_SCHEME, resolveResignSettings, type ProviderRoute } from "./config.js";
import { configFile, stateDir } from "./paths.js";

/**
 * #1884 (CodeArts APIG): requests signed with SDK-HMAC-SHA256 carry a
 * signature over the exact request bytes. bili's pipeline rewrites bodies
 * (compression, compat), which invalidates the inbound signature — the
 * upstream then rejects every rewritten request with 401 (APIG.0301 body
 * hash mismatch). The native lane tunnels these requests with a re-sign
 * arm instead: the dsh credential service supplies the signing credential
 * via `x-bili-resign` / `x-bili-resign-credential` markers, and every
 * egress body bili produces (initial forward, role-ladder retry, overflow
 * refold, compress-loop rounds, degenerate continuation refetch) is
 * re-signed here before it hits the wire.
 *
 * The signer is a byte-exact port of the CodeArts plugin's signRequestHuawei
 * (dsh codearts plugin src/sign.ts — itself aligned with the Rust reference
 * implementation `sign_request_huawei`): same canonical-request layout, same
 * date format, same header set. Verified by the hermetic mock upstream in
 * tests/apig-resign.test.ts which validates signatures with the ak/sk it
 * issued.
 *
 * Kill switch: BILI_RESIGN=0 un-deploys the feature: the native lane stops
 * arming signed requests (they fall through to the normal takeover path —
 * pre-#1884 behavior) and the server-side guard stays silent.
 *
 * A signed request that cannot be re-signed (no credential resolvable for
 * its scheme) is REFUSED — 403 naming the scheme — per the owner's
 * binary-contract ruling (#2090): a signed request has exactly two legal
 * outcomes, RE-SIGNED+COMPRESSED or REFUSED; there is NO unsigned
 * pass-through mode, because letting a signed body through un-compressed
 * hides the bypass from the user. The sole exception is the pre-existing
 * #1884 escape hatch on the BUILT-IN scheme itself
 * (resign["sdk-hmac-sha256"].passthrough / BILI_RESIGN_PASSTHROUGH=1): its
 * refusal has a user-side fix (provide the credential), so opting into
 * uncompressed forwarding there is a real decision. For every OTHER scheme
 * passthrough settings are INERT and the request always refuses. Refusals
 * are remembered (recordSignedRefusal → stateDir()/resign-pending.json) so
 * every bili startup lists still-unresolved schemes next to the listen
 * banner until bili ships their re-signer — except schemes whose registry
 * entry carries a status note, which are permanent-policy refusals that no
 * re-signer will resolve (#4632). resign["<scheme>"].enabled=false
 * / BILI_RESIGN=0 un-deploy the branch entirely (pre-#1884 rewrite behavior
 * — upstream may reject the rewritten bodies; that choice also clears the
 * reminder).
 *
 * Credential refresh is intentionally NOT ported: the plugin refreshes its
 * own credentials; when they expire, the upstream 401 is visible and the
 * plugin's next successful refresh re-arms a fresh credential.
 */

/** Internal marker headers (loopback only — stripped before egress). */
export const APIG_RESIGN_HEADER = "x-bili-resign";
export const APIG_RESIGN_CREDENTIAL_HEADER = "x-bili-resign-credential";
/** Marker value for the scheme this module can re-sign (the config-level
 *  identity of the built-in resign key — see RESIGN_BUILTIN_SCHEME). */
export const APIG_RESIGN_SCHEME = RESIGN_BUILTIN_SCHEME;

/** #2090 plan A: the known body-covering signature schemes. Shape detection
 *  (inboundSignedScheme) is the backstop that guarantees an UNregistered
 *  scheme still fails loudly (actionable 403) instead of silently rewriting
 *  a signed body; this registry adds friendly labels + provenance so refusal
 *  messages, startup reminders, and the web UI can say WHAT the scheme is
 *  instead of just its token. The list converges: every newly discovered
 *  gateway scheme gets one entry (with the issue it came from). */
interface KnownSignatureScheme {
    label: string;
    source: string;
    builtIn?: boolean;
    /** #4632: status note rendered into every user-facing channel (refusal
     *  message, startup banner, dsh boot warning, web UI card) — the registry
     *  is the single source of truth for a scheme's status, so one change
     *  updates all channels at once. */
    note?: string;
    /** Chinese variant of the note for the bilingual web UI (code channels
     *  stay English, matching the other refusal messages). */
    noteZh?: string;
}

export const KNOWN_SIGNATURE_SCHEMES: Record<string, KnownSignatureScheme> = {
    "sdk-hmac-sha256": { label: "CodeArts APIG SDK-HMAC-SHA256", source: "#1884", builtIn: true },
    "aws4-hmac-sha256": { label: "AWS SigV4 (AWS4-HMAC-SHA256)", source: "AWS SigV4" },
    "hmac-sha256": { label: "generic HMAC-SHA256 authorization", source: "#1884" },
    // dsh-our-free-model EAC channel: HMAC over `${timestamp}\n${METHOD}\n${path}\nsha256(body)`
    "x-ofm-signature": {
        label: "dsh-our-free-model EAC gateway signature",
        source: "#2090",
        // #4632: the service blocks bili-routed traffic on this channel and its
        // terms forbid third-party proxies from intercepting/re-signing; the
        // note below is rendered by signedRefusal(), the startup banner, the
        // dsh boot warning and the web UI card (single source of truth).
        note: "The service side blocks bili-routed traffic on this channel (#4632): its terms do not allow third-party proxies to intercept or re-sign its requests, and bili will not circumvent that block — this project does not support software that violates others' terms of service; the compatibility handling here exists only so the rest of your setup keeps working with bili. Your options: keep bili (these models stay refused locally, never silently broken; everything else compresses normally); or remove the billion-context plugin from the dsh profile (bili plugin remove dsh) and route only the models you want compressed through the /bili/ prefix instead (their base URL becomes http://localhost:8787/bili/<upstream>, the free-model endpoint stays direct, run bili start) — these models then go direct with valid signatures while everything else still compresses; or wait for an official bili-compatible mode from the service. Do NOT restore this channel with resign[\"x-ofm-signature\"].enabled=false / BILI_RESIGN=0 — that ships signature-invalid requests to the upstream. Details: README \"Signed upstreams\" · CLIENTS.md (dsh lane).",
        noteZh: "服务方在本渠道屏蔽经 bili 的流量（#4632）：其条款不允许第三方代理拦截或重签其请求，bili 不会绕过该屏蔽——本项目不支持违反他人协议的软件，此处的兼容处理仅仅是为了让你的其余链路能继续用 bili。你的选择：保留 bili（这些模型在本地被响亮拒绝、绝不静默坏掉，其余模型正常压缩）；或把 billion-context 插件从 dsh profile 移除（bili plugin remove dsh），改为只把想压缩的模型经 /bili/ 前缀路由（其 base URL 改为 http://localhost:8787/bili/<上游>，免费模型端点保持直连，运行 bili start）——这些模型直连且签名有效，其余照常压缩；或等待服务方提供官方兼容模式。不要用 resign[\"x-ofm-signature\"].enabled=false / BILI_RESIGN=0 恢复该渠道——那会向对方发送验签失败的请求。详见 README「签名上游」· CLIENTS.md（dsh 车道）。",
    },
};

/** The minimal signing credential (subset of the plugin's CodeArtsCredential). */
export interface ApigCredential {
    ak: string;
    sk: string;
    /** Temporary-credential security token; empty string for permanent keys. */
    token?: string;
}

/** Benefit (free-quota) models require the signed `maas_type: benefit` header
 *  (InferHub.002002009.404 "model is not registered" otherwise). Strict
 *  three-level resolution (#1884): env BILI_RESIGN_BENEFIT (comma-separated
 *  model list) wins over the whole tree; otherwise the per-model entry
 *  `providers.<url>.models.<name>.benefit` (true/false explicit, unset falls
 *  through) decides, and unset everywhere falls back to this static mirror of
 *  the plugin's CODEARTS_BENEFIT_FALLBACK. */
const DEFAULT_BENEFIT_MODELS = ["glm-5.3-flash", "deepseek-v4.1-flash"];

export function apigBenefitFor(model: string | undefined, route?: ProviderRoute): boolean {
    if (model === undefined) return false;
    const lower = model.toLowerCase();
    const envBenefit = process.env.BILI_RESIGN_BENEFIT?.trim();
    if (envBenefit !== undefined && envBenefit !== "") {
        const set = new Set(envBenefit.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));
        return set.has(lower);
    }
    const entry = route?.models?.[model] ?? route?.models?.[lower];
    if (entry?.benefit !== undefined) return entry.benefit;
    return DEFAULT_BENEFIT_MODELS.includes(lower);
}

export function resignEnabled(route?: ProviderRoute, scheme: string = APIG_RESIGN_SCHEME): boolean {
    return resolveResignSettings(process.env, route?.resign, scheme).enabled;
}

/** Opt-in verbatim forwarding for signed requests that cannot be re-signed
 *  (no silent passthrough by default — see the refusal rationale above). */
export function resignPassthroughEnabled(route?: ProviderRoute, scheme: string = APIG_RESIGN_SCHEME): boolean {
    return resolveResignSettings(process.env, route?.resign, scheme).passthrough;
}

interface SignedRefusal {
    status: number;
    contentType: string;
    body: string;
}

/** The 403 payload returned when a body-covering signature cannot be re-signed.
 *  Protocol-native shapes (anthropic/openai wire) so real clients surface the
 *  message instead of choking on it.
 *  #2090 owner ruling ("either compress or refuse"): the pass-through outcome
 *  exists ONLY for the built-in scheme (its refusal has a user-side fix —
 *  provide the credential — so #1884 shipped the passthrough escape hatch).
 *  Non-built-in schemes have NO pass-through mode at all: they stay refused
 *  until bili ships a re-signer for them, and the message says so instead of
 *  offering a config that would not work. #4632: schemes whose registry entry
 *  carries a `note` (deliberately blocked channels) get that note as their
 *  status text instead — we do not promise a re-signer for those. */
export function signedRefusal(scheme: string, protocol: "anthropic" | "openai"): SignedRefusal {
    const known = KNOWN_SIGNATURE_SCHEMES[scheme];
    const schemeName = known ? `${scheme} (${known.label}, ${known.source})` : scheme;
    const statusTail = known?.note
        ? ` ${known.note}`
        : ` It stays unavailable until bili ships re-signing support for it. Restoring pre-resign handling with {"resign":{"${scheme}":{"enabled":false"}}} / BILI_RESIGN=0 is possible, but the upstream will reject the rewritten body.`;
    const message = scheme === APIG_RESIGN_SCHEME
        ? `bili refused to forward this ${schemeName}-signed request: the signature covers the request body, and any rewrite (context compression) would invalidate it upstream (401 APIG.0301 / SignatureDoesNotMatch). No re-sign credential was available for this scheme. The link WORKS WITHOUT COMPRESSION if you opt in explicitly — that opt-in is the acknowledgment that this link runs uncompressed: add {"resign":{"${scheme}":{"passthrough":true}}} to the config file (${configFile()}) or set env BILI_RESIGN_PASSTHROUGH=1, then restart bili; the bili web UI (/__bili/, Configuration → Signed upstreams) lists this scheme too. Alternatively restore pre-resign handling with {"resign":{"${scheme}":{"enabled":false}}} / BILI_RESIGN=0 — the body is then rewritten and the upstream may reject it. Providing a signing credential (dsh: an enabled codearts account in jet-hub state.json via the dsh credentials service) makes bili re-sign instead of refusing.`
        : `bili refused to forward this ${schemeName}-signed request: the signature covers the request body, and any rewrite (context compression) would invalidate it upstream (401 SignatureDoesNotMatch). bili has no re-signer for this scheme${known?.note ? "" : " yet"}, and by design signed requests are either RE-SIGNED+COMPRESSED or REFUSED — there is no unsigned pass-through mode, so NO configuration can make this link work (passthrough settings do not apply to this scheme).${statusTail}`;
    if (protocol === "anthropic") {
        return { status: 403, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }) };
    }
    return { status: 403, contentType: "application/json", body: JSON.stringify({ error: { type: "signed_request_requires_resign", code: "bili_resign_unavailable", message, retryable: false } }) };
}

function sha256Hex(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function hmacSha256Hex(key: Uint8Array, data: Uint8Array): string {
    return createHmac("sha256", key).update(data).digest("hex");
}

/** #2090: body-covering signatures are a long tail — every gateway/plugin
 *  invents its own header set (the dsh free-model plugin ships
 *  `x-ofm-signature`, AWS ships `x-amz-content-sha256`, CodeArts ships
 *  `SDK-HMAC-SHA256`), so a closed name whitelist keeps missing new shapes
 *  and silently lets signed bodies through the rewrite path (upstream then
 *  rejects with 401 SignatureDoesNotMatch, and the symptom lands in
 *  someone else's plugin UI as "invalid credentials"). Detection is
 *  SHAPE-based instead of name-listed: an Authorization scheme token naming
 *  an HMAC construction, or any request header whose name ends in
 *  `-signature` / `-content-sha256`. Bearer/Basic/API-key auth never match. */
function isBodySignatureHeaderName(name: string): boolean {
    const n = name.toLowerCase();
    return n.endsWith("-signature") || n.endsWith("-content-sha256");
}

/** Detect a body-covering signature from request headers (lowercased keys,
 *  as node delivers them; the native lane normalizes Headers into this
 *  shape before calling). Returns the scheme token (lowercased) or
 *  undefined for unsigned traffic. Deterministic: the Authorization scheme
 *  wins over shaped headers, and shaped headers are scanned in sorted-name
 *  order. The returned token doubles as the per-scheme config key
 *  (`resign["<token>"]`). */
export function inboundSignedScheme(headers: Record<string, string | string[] | undefined>): string | undefined {
    const auth = String(headers["authorization"] ?? "").trim();
    const token = auth.split(/\s+/)[0] ?? "";
    if (token !== "" && /hmac/i.test(token)) return token.toLowerCase();
    for (const name of Object.keys(headers).sort()) {
        if (isBodySignatureHeaderName(name)) return name.toLowerCase();
    }
    return undefined;
}

/** Decode the loopback credential marker. Tolerates malformed payloads by
 *  returning undefined — a broken marker degrades to the direct fallback,
 *  never to a thrown error mid-dispatch. */
export function decodeApigCredential(encoded: string | undefined): ApigCredential | undefined {
    if (typeof encoded !== "string" || encoded === "") return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
        const ak = typeof parsed["ak"] === "string" ? parsed["ak"] : undefined;
        const sk = typeof parsed["sk"] === "string" ? parsed["sk"] : undefined;
        if (ak === undefined || sk === undefined || ak === "" || sk === "") return undefined;
        const token = typeof parsed["token"] === "string" ? parsed["token"] : "";
        return { ak, sk, token };
    } catch {
        return undefined;
    }
}

export function encodeApigCredential(cred: ApigCredential): string {
    return Buffer.from(JSON.stringify({ ak: cred.ak, sk: cred.sk, token: cred.token ?? "" }), "utf8").toString("base64");
}

/** Header names this signer owns on the egress request. All forms are
 *  removed (case-insensitively) before re-signing so a rewrite can never
 *  leak the previous round's stale signature as a duplicate header. */
const SIGNED_HEADER_NAMES = new Set([
    "authorization",
    "x-sdk-date",
    "x-sdk-content-sha256",
    "x-security-token",
    "maas_type",
]);

function deleteSignedHeaders(target: Record<string, string>): void {
    for (const key of Object.keys(target)) {
        if (SIGNED_HEADER_NAMES.has(key.toLowerCase())) delete target[key];
    }
}

function apigDateStamp(now: Date): string {
    return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

interface ApigSignOptions {
    /** Extra headers that join the signature (e.g. `maas_type: benefit`). */
    extraSignedHeaders?: Record<string, string>;
    /** Clock injection for deterministic tests. */
    now?: Date;
}

/** Sign `body` for `urlStr` into `target` (mutated in place). Byte-exact
 *  port of the plugin's signRequestHuawei: canonical request over the
 *  sorted signed-header set, `SDK-HMAC-SHA256\n<date>\n<canonical-hash>`
 *  string-to-sign, HMAC-SHA256 with the secret key. Always includes
 *  `x-security-token` (empty for permanent keys — the plugin does the same)
 *  and `content-type: application/json` on non-GET requests. */
export function signApigHeaders(
    target: Record<string, string>,
    cred: ApigCredential,
    method: string,
    urlStr: string,
    body: Uint8Array,
    opts: ApigSignOptions = {},
): void {
    const url = new URL(urlStr);
    let uri = url.pathname;
    if (!uri.endsWith("/")) uri += "/";
    const query = url.search.slice(1);
    const dateStamp = apigDateStamp(opts.now ?? new Date());
    const payloadHash = sha256Hex(body);

    const signed = new Map<string, string>();
    signed.set("host", url.host);
    signed.set("x-sdk-date", dateStamp);
    signed.set("x-sdk-content-sha256", payloadHash);
    signed.set("x-security-token", cred.token ?? "");
    if (opts.extraSignedHeaders !== undefined) {
        for (const [key, value] of Object.entries(opts.extraSignedHeaders)) signed.set(key, value);
    }
    if (method.toUpperCase() !== "GET") signed.set("content-type", "application/json");

    const names = [...signed.keys()].sort();
    const canonicalRequest = [
        method.toUpperCase(),
        uri,
        query,
        names.map((k) => `${k}:${signed.get(k) ?? ""}`).join("\n"),
        "",
        names.join(";"),
        payloadHash,
    ].join("\n");
    const canonicalHash = sha256Hex(Buffer.from(canonicalRequest, "utf8"));
    const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
    const signature = hmacSha256Hex(Buffer.from(cred.sk, "utf8"), Buffer.from(stringToSign, "utf8"));

    deleteSignedHeaders(target);
    target["host"] = url.host;
    target["x-sdk-date"] = dateStamp;
    target["x-sdk-content-sha256"] = payloadHash;
    target["x-security-token"] = cred.token ?? "";
    if (opts.extraSignedHeaders !== undefined) {
        for (const [key, value] of Object.entries(opts.extraSignedHeaders)) target[key] = value;
    }
    if (method.toUpperCase() !== "GET") target["content-type"] = "application/json";
    target["authorization"] = `SDK-HMAC-SHA256 Access=${cred.ak},SignedHeaders=${names.join(";")},Signature=${signature}`;
}

/** Extract the request model from a wire body JSON (best effort — used to
 *  resolve the benefit set for `maas_type`). */
export function modelOfJsonBody(body: string): string | undefined {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        return typeof parsed["model"] === "string" ? parsed["model"] : undefined;
    } catch {
        return undefined;
    }
}

/** Convenience: sign `target` for `body`, adding `maas_type: benefit` when
 *  the request's model is in the benefit set. */
export function resignApig(
    target: Record<string, string>,
    cred: ApigCredential,
    method: string,
    urlStr: string,
    body: string | Buffer,
    route?: ProviderRoute,
    now?: Date,
): void {
    const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const model = modelOfJsonBody(bodyBuf.toString("utf8"));
    const benefit = apigBenefitFor(model, route);
    signApigHeaders(target, cred, method, urlStr, bodyBuf, {
        extraSignedHeaders: benefit ? { maas_type: "benefit" } : undefined,
        now,
    });
}

// #2090 plan A — refusal memory. A refusal is only visible for the lifetime
// of the request that got it; the user who will fix the config sees nothing
// until the next failure. Persisting (scheme → where/when/how often) lets
// EVERY bili startup re-surface still-unresolved schemes next to the listen
// banner and in the web UI, until the user configures them away. The file is
// a reminder aid, never a correctness path: read/write failures degrade to
// "no reminder", never to a broken request.

interface ResignPendingEntry {
    origin: string;
    firstSeen: string;
    lastSeen: string;
    count: number;
}

const RESIGN_PENDING_MAX_ENTRIES = 32;

function resignPendingFile(): string {
    return path.join(stateDir(), "resign-pending.json");
}

function readPendingRefusalsRaw(): Record<string, ResignPendingEntry> {
    try {
        const parsed: unknown = JSON.parse(readFileSync(resignPendingFile(), "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, ResignPendingEntry> = {};
        for (const [scheme, raw] of Object.entries(parsed as Record<string, unknown>)) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const e = raw as Record<string, unknown>;
            out[scheme] = {
                origin: typeof e["origin"] === "string" ? e["origin"] : "",
                firstSeen: typeof e["firstSeen"] === "string" ? e["firstSeen"] : new Date(0).toISOString(),
                lastSeen: typeof e["lastSeen"] === "string" ? e["lastSeen"] : new Date(0).toISOString(),
                count: typeof e["count"] === "number" && Number.isFinite(e["count"]) && e["count"] > 0 ? Math.floor(e["count"]) : 1,
            };
        }
        return out;
    } catch {
        return {};
    }
}

function writePendingRefusals(map: Record<string, ResignPendingEntry>): void {
    try {
        mkdirSync(stateDir(), { recursive: true });
        const tmp = `${resignPendingFile()}.tmp`;
        // fsync before rename: a crash between write and rename otherwise leaves
        // a size-correct, VDL=0 zero file (#3157).
        const fd = openSync(tmp, "w");
        try {
            writeFileSync(fd, JSON.stringify(map, null, 2));
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(tmp, resignPendingFile());
    } catch (err) {
        console.warn(`bili: cannot persist resign-pending.json (${err instanceof Error ? err.message : String(err)})`);
    }
}

/** Remember that a signed request was refused (both lanes call this on the
 *  refusal path). Bounded: newest 32 schemes survive a restart. */
export function recordSignedRefusal(scheme: string, url: string): void {
    const key = scheme.trim().toLowerCase();
    if (key.length === 0) return;
    const map = readPendingRefusalsRaw();
    let origin = "";
    try { origin = new URL(url).origin; } catch { origin = url.slice(0, 120); }
    const now = new Date().toISOString();
    const prev = map[key];
    map[key] = prev
        ? { origin: prev.origin || origin, firstSeen: prev.firstSeen, lastSeen: now, count: prev.count + 1 }
        : { origin, firstSeen: now, lastSeen: now, count: 1 };
    const keys = Object.keys(map);
    if (keys.length > RESIGN_PENDING_MAX_ENTRIES) {
        // Drop the oldest-seen overflow entries; keep the most recently active.
        keys.sort((a, b) => map[a].firstSeen.localeCompare(map[b].firstSeen));
        for (const drop of keys.slice(0, keys.length - RESIGN_PENDING_MAX_ENTRIES)) delete map[drop];
    }
    writePendingRefusals(map);
}

/** Forget a scheme's refusal memory — called when the scheme is configured
 *  away (passthrough opted in, or the branch un-deployed via enabled=false /
 *  BILI_RESIGN=0), so startup reminders stop nagging about it. */
export function clearSignedRefusal(scheme: string): void {
    const key = scheme.trim().toLowerCase();
    const map = readPendingRefusalsRaw();
    if (!(key in map)) return;
    delete map[key];
    writePendingRefusals(map);
}

export function readPendingRefusals(): Record<string, ResignPendingEntry> {
    return readPendingRefusalsRaw();
}

/** Schemes whose refusal is still UNRESOLVED under the current settings —
 *  drives the startup banner and the web UI card. An entry resolves ONLY when
 *  the branch is un-deployed (enabled=false / BILI_RESIGN=0 — the user accepts
 *  the upstream rejecting rewritten bodies) or, for the BUILT-IN scheme only,
 *  when its passthrough is opted in (the pre-existing #1884 escape hatch, file
 *  or BILI_RESIGN_PASSTHROUGH). Non-built-in schemes NEVER resolve via
 *  passthrough (#2090 owner ruling: signed requests are re-signed+compressed
 *  or refused — no unsigned pass-through); they stay listed until bili ships
 *  their re-signer. */
export function unresolvedRefusals(env: NodeJS.ProcessEnv = process.env): Record<string, ResignPendingEntry> {
    if (env.BILI_RESIGN === "0") return {};
    const out: Record<string, ResignPendingEntry> = {};
    for (const [scheme, entry] of Object.entries(readPendingRefusalsRaw())) {
        const settings = resolveResignSettings(env, {}, scheme);
        if (!settings.enabled) continue;
        const builtinPassthrough = scheme === APIG_RESIGN_SCHEME && (settings.passthrough || env.BILI_RESIGN_PASSTHROUGH === "1" || env.BILI_RESIGN_PASSTHROUGH === "true");
        if (builtinPassthrough) continue;
        out[scheme] = entry;
    }
    return out;
}
