// Ticket 01: bili-owned model route for the native Codex CLI.
//
// Ordinary API-key mode routes Codex through bili by writing the ONE field
// Codex documents for it — the top-level `openai_base_url` — pointing at
// bili's `/bili/` prefix. This is the persistent, no-wrapper entry point the
// Codex proxy spec asks for; the MCP block (plugin-install.ts codexBlock) is a
// SEPARATE concern and proves nothing about model traffic.
//
// Ownership is CONTENT-BASED, exactly like the claude lane's managed block
// (plugin-install.ts isBiliClaudeBaseUrl / unwrapBiliBaseUrl): a value shaped
// `<loopback origin>/bili/<real url>` is ours and may be refreshed; anything
// else is the user's (or CC Switch's) and is never overwritten — the write is
// refused and reported instead, so bili can never end up fighting a provider
// manager over the same field.

import fs from "node:fs";
import path from "node:path";
import { parseCodexToml } from "../client-config.js";
import type { CodexConfig } from "../client-config.js";
import { lanePreferredPort } from "../instance.js";
import {
    findTableScalar,
    findTopLevelScalar,
    removeTableScalar,
    removeTopLevelScalar,
    setTableScalar,
    setTopLevelScalar,
} from "./toml-field.js";

/** The top-level Codex field this module owns. */
const CODEX_ROUTE_KEY = "openai_base_url";

/** Codex's built-in OpenAI default (codex-rs model-provider-info), used when
 *  the user has declared no provider and no base URL. */
const CODEX_DEFAULT_UPSTREAM = "https://api.openai.com/v1";

/** `<loopback origin>/bili/<real url>` — the shape bili itself writes. Accepts
 *  any loopback port (the lane's zone port drifts with the EADDRINUSE ladder,
 *  #1660) and both `127.0.0.1` and `localhost`, because a user may have copied
 *  a documented value by hand. */
const BILI_ROUTE_RE =
    /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5})\/bili\/(https?:\/\/.+)$/;

function isBiliCodexRoute(value: string): boolean {
    return BILI_ROUTE_RE.test(value.trim());
}

/** Inverse of `codexRouteValue`: recover the real upstream. undefined for
 *  anything bili did not write. */
function unwrapCodexRoute(value: string): string | undefined {
    const m = BILI_ROUTE_RE.exec(value.trim());
    return m ? m[2] : undefined;
}

/** Build the routed value for a real upstream, preserving any `/bili/`
 *  wrapper the caller already had (so re-planning is idempotent). */
export function codexRouteValue(origin: string, upstream: string): string {
    const real = unwrapCodexRoute(upstream) ?? upstream;
    return `${origin.replace(/\/+$/, "")}/bili/${real.replace(/\/+$/, "")}`;
}

/** The origin the persistent Codex route should point at. Uses the lane's
 *  sticky zone port (`instance.ts` port-zone.json, honoring the existing
 *  BILI_ZONE_PORT override) so the route survives the proxy's +1 EADDRINUSE
 *  ladder and machine reboots — the same stable-origin discipline as every
 *  other lane (#1660). No new config/env surface is introduced for this. */
export function codexRouteOrigin(env: NodeJS.ProcessEnv = process.env): string {
    return `http://127.0.0.1:${lanePreferredPort("codex", env)}`;
}

/** The upstream Codex would reach WITHOUT bili in the path — the provider the
 *  route must wrap. Mirrors launcher.ts `codexUpstreamUrl`'s precedence
 *  (`model_provider`'s `base_url` > top-level `openai_base_url` > OpenAI
 *  default) but unwraps bili's own value so re-planning never double-wraps. */
function codexRealUpstream(config: CodexConfig | undefined): string {
    const provider =
        config?.modelProvider !== undefined
            ? config?.providers?.[config.modelProvider]?.baseUrl
            : undefined;
    if (provider !== undefined && provider !== "")
        return unwrapCodexRoute(provider) ?? provider;
    const direct = config?.openaiBaseUrl;
    if (direct !== undefined && direct !== "")
        return unwrapCodexRoute(direct) ?? direct;
    return CODEX_DEFAULT_UPSTREAM;
}

/** Why the route cannot be (or is not) the effective one. Both are reported,
 *  never silently "fixed": the spec forbids fighting a provider manager. */
type CodexRouteConflict =
    /** A foreign (non-bili) `openai_base_url` is already set. */
    | { kind: "foreign-openai-base-url"; value: string }
    /** `model_provider` names a provider with its own `base_url`, so Codex
     *  ignores the top-level field entirely — writing it would be a no-op. */
    | { kind: "shadowed-by-provider"; provider: string; value: string };

interface CodexRoutePlan {
    action: "install" | "refresh" | "keep" | "conflict";
    /** The full file text after the action (`keep`/`conflict` return it unchanged). */
    text: string;
    /** The routed value bili owns or would own. */
    value?: string;
    target?: CodexRouteTarget;
    conflict?: CodexRouteConflict;
    note: string;
}

type CodexRouteTarget =
    | { kind: "top-level" }
    | { kind: "provider"; provider: string };

export interface CodexRouteRecord {
    schemaVersion: 1;
    writtenValue: string;
    previousValue: string | null;
    upstream: string;
    target?: CodexRouteTarget;
}

export function codexRouteRecordPath(configFile: string): string {
    return `${configFile}.bili-route.json`;
}

export function readCodexRouteRecord(
    file: string,
): CodexRouteRecord | undefined {
    try {
        const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const row = value as Record<string, unknown>;
        if (
            row.schemaVersion !== 1 ||
            typeof row.writtenValue !== "string" ||
            !(typeof row.previousValue === "string" || row.previousValue === null) ||
            typeof row.upstream !== "string"
        )
            return undefined;
        const target = row.target === undefined
            ? { kind: "top-level" as const }
            : row.target;
        if (
            target === null ||
            typeof target !== "object" ||
            !("kind" in target) ||
            (target.kind !== "top-level" &&
                (target.kind !== "provider" || !("provider" in target) || typeof target.provider !== "string"))
        ) return undefined;
        return {
            schemaVersion: 1,
            writtenValue: row.writtenValue,
            previousValue: row.previousValue,
            upstream: row.upstream,
            target: target as CodexRouteTarget,
        };
    } catch {
        return undefined;
    }
}

export function writeCodexRouteRecord(
    file: string,
    record: CodexRouteRecord,
): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
    });
    fs.renameSync(temporary, file);
}

export function removeCodexRouteRecord(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            throw error;
    }
}

/** Pure planner: decide what (if anything) to do to `text`. Provider-table
 *  routes are allowed only for an explicitly detected CC Switch Direct mode;
 *  Routing/Aggregation/unknown remain untouched. */
export function planCodexRoute(
    text: string,
    opts: {
        origin: string;
        config?: CodexConfig;
        ownedValue?: string;
        ownedRecord?: CodexRouteRecord;
        ccSwitchMode?: "direct" | "routing" | "aggregation" | "unknown";
    },
): CodexRoutePlan {
    const config = opts.config ?? parseCodexToml(text);
    const provider = config.modelProvider;
    const providerBase = provider ? config.providers?.[provider]?.baseUrl : undefined;
    const record = opts.ownedRecord;
    const recordedTarget = record?.target ?? { kind: "top-level" as const };
    const activeTarget: CodexRouteTarget =
        provider && providerBase ? { kind: "provider", provider } : { kind: "top-level" };
    if (
        record &&
        (recordedTarget.kind !== activeTarget.kind ||
            (recordedTarget.kind === "provider" &&
                activeTarget.kind === "provider" &&
                recordedTarget.provider !== activeTarget.provider))
    ) {
        return {
            action: "conflict",
            text,
            conflict: provider && providerBase
                ? { kind: "shadowed-by-provider", provider, value: providerBase }
                : { kind: "foreign-openai-base-url", value: "active Codex target changed" },
            note: `Codex's effective route target changed since bili installed it; run bili plugin remove codex before installing the new provider route`,
        };
    }
    const ownProvider =
        recordedTarget.kind === "provider" &&
        recordedTarget.provider === provider &&
        record?.writtenValue === providerBase;

    if (provider && providerBase) {
        const target: CodexRouteTarget = { kind: "provider", provider };
        if (
            record && recordedTarget.kind === "provider" &&
            recordedTarget.provider === provider && providerBase !== record.writtenValue
        ) {
            return {
                action: "conflict",
                text,
                conflict: { kind: "shadowed-by-provider", provider, value: providerBase },
                note: `provider ${provider} base_url changed after bili installed it; likely a CC Switch rewrite, so it was left untouched`,
            };
        }
        if (ownProvider && opts.ccSwitchMode !== "direct") {
            return {
                action: "conflict",
                text,
                conflict: { kind: "shadowed-by-provider", provider, value: providerBase },
                note: `CC Switch is no longer confirmed in Direct mode; existing bili route was left untouched`,
            };
        }
        if (ownProvider) {
            const value = codexRouteValue(opts.origin, record!.upstream);
            if (providerBase === value)
                return { action: "keep", text, value, target, note: `CC Switch Direct provider ${provider} already routes through bili` };
            return {
                action: "refresh",
                text: setTableScalar(text, `model_providers.${provider}`, "base_url", value),
                value,
                target,
                note: `CC Switch Direct provider ${provider} route refreshed -> ${value}`,
            };
        }
        if (isBiliCodexRoute(providerBase)) {
            return {
                action: "conflict",
                text,
                conflict: { kind: "shadowed-by-provider", provider, value: providerBase },
                note: `provider ${provider} already has a bili-shaped base_url without matching ownership evidence — left untouched`,
            };
        }
        if (opts.ccSwitchMode !== "direct") {
            return {
                action: "conflict",
                text,
                conflict: { kind: "shadowed-by-provider", provider, value: providerBase },
                note: `model_provider = "${provider}" declares base_url ${providerBase}; only detected CC Switch Direct mode may route this provider`,
            };
        }
        const value = codexRouteValue(opts.origin, providerBase);
        return {
            action: "install",
            text: setTableScalar(text, `model_providers.${provider}`, "base_url", value),
            value,
            target,
            note: `CC Switch Direct provider ${provider} routed through bili -> ${value}; CC Switch may rewrite it when provider or mode changes`,
        };
    }

    const existing = findTopLevelScalar(text, CODEX_ROUTE_KEY);
    const ownTopLevel =
        recordedTarget.kind === "top-level" &&
        ((record?.writtenValue !== undefined && existing?.value === record.writtenValue) ||
            (opts.ownedValue !== undefined && existing?.value === opts.ownedValue));
    if (existing && !ownTopLevel) {
        return {
            action: "conflict",
            text,
            conflict: { kind: "foreign-openai-base-url", value: existing.value },
            note: `${CODEX_ROUTE_KEY} is already set to a non-bili value — left untouched`,
        };
    }
    const value = codexRouteValue(opts.origin, codexRealUpstream(config));
    if (existing?.value === value)
        return { action: "keep", text, value, target: { kind: "top-level" }, note: `${CODEX_ROUTE_KEY} already routed through bili` };
    return {
        action: ownTopLevel ? "refresh" : "install",
        text: setTopLevelScalar(text, CODEX_ROUTE_KEY, value),
        value,
        target: { kind: "top-level" },
        note: ownTopLevel
            ? `${CODEX_ROUTE_KEY} refreshed -> ${value}`
            : `${CODEX_ROUTE_KEY} routed through bili -> ${value}`,
    };
}

/** What bili currently finds in `text` — the read side of ownership, shared by
 *  status reporting and uninstall. */
interface CodexRouteState {
    /** A bili-owned route is present. */
    routed: boolean;
    /** The raw field value, when any. */
    value?: string;
    /** The real upstream behind a bili-owned route. */
    upstream?: string;
    conflict?: CodexRouteConflict;
}

export function readCodexRoute(
    text: string,
    ownership?: CodexRouteRecord | string,
): CodexRouteState {
    const config = parseCodexToml(text);
    const record = typeof ownership === "string" ? undefined : ownership;
    const ownedValue = typeof ownership === "string" ? ownership : record?.writtenValue;
    const target = record?.target ?? { kind: "top-level" as const };
    const provider = config.modelProvider;
    const providerBase = provider ? config.providers?.[provider]?.baseUrl : undefined;
    const out: CodexRouteState = { routed: false };
    if (target.kind === "provider") {
        if (provider === target.provider && providerBase !== undefined) {
            out.value = providerBase;
            if (providerBase === ownedValue && isBiliCodexRoute(providerBase)) {
                out.routed = true;
                out.upstream = record?.upstream ?? unwrapCodexRoute(providerBase);
            } else {
                out.conflict = { kind: "shadowed-by-provider", provider, value: providerBase };
            }
            return out;
        }
        if (target.provider !== provider && provider && providerBase)
            out.conflict = { kind: "shadowed-by-provider", provider, value: providerBase };
        return out;
    }
    const existing = findTopLevelScalar(text, CODEX_ROUTE_KEY);
    if (existing !== undefined) {
        out.value = existing.value;
        if (ownedValue !== undefined && existing.value === ownedValue && isBiliCodexRoute(existing.value)) {
            out.routed = true;
            out.upstream = record?.upstream ?? unwrapCodexRoute(existing.value);
        } else {
            out.conflict = { kind: "foreign-openai-base-url", value: existing.value };
        }
    }
    if (provider && providerBase)
        out.conflict = { kind: "shadowed-by-provider", provider, value: providerBase };
    return out;
}

/** The route value bili would write right now for `file` — used by status
 *  reporting to tell "configured for THIS origin" from "configured for a
 *  drifted one". */
export function desiredCodexRoute(text: string, origin: string): string {
    return codexRouteValue(origin, codexRealUpstream(parseCodexToml(text)));
}

/** Remove bili's route field, leaving every other byte alone. Returns the new
 *  text plus whether anything changed. */
export function restoreCodexRoute(
    text: string,
    record?: CodexRouteRecord,
): {
    text: string;
    restored: boolean;
    stillOwned: boolean;
} {
    if (record === undefined) return { text, restored: false, stillOwned: false };
    const target = record.target ?? { kind: "top-level" as const };
    if (target.kind === "provider") {
        const table = `model_providers.${target.provider}`;
        const existing = findTableScalar(text, table, "base_url");
        if (existing === undefined || existing.value !== record.writtenValue)
            return { text, restored: false, stillOwned: false };
        const next =
            record.previousValue === null
                ? removeTableScalar(text, table, "base_url")
                : setTableScalar(text, table, "base_url", record.previousValue);
        return { text: next, restored: true, stillOwned: true };
    }
    const existing = findTopLevelScalar(text, CODEX_ROUTE_KEY);
    if (existing === undefined || existing.value !== record.writtenValue)
        return { text, restored: false, stillOwned: false };
    const next =
        record.previousValue === null
            ? removeTopLevelScalar(text, CODEX_ROUTE_KEY)
            : setTopLevelScalar(text, CODEX_ROUTE_KEY, record.previousValue);
    return { text: next, restored: true, stillOwned: true };
}
