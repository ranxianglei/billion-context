// #5825 identity-channel wiring: the ONE server-side seam that gives a
// loopback client without an explicit body channel (`biliMsgIds`) a stable
// session + per-message identity, harvested from the client's own local
// store (transcript JSONL / SQLite), aligned 1:1 to the outbound request.
//
// Design law (owner ruling 2026-11-07): every lane wires INTO this registry
// and the existing consume path — no consumer may read client storage itself.
// Adapters are self-contained config+reader modules; the registry owns:
//
//   1. the kill/scope switch (env BILI_IDENTITY_HARVEST) OR the install-level
//      rollout key (identityChannelHarvest, #5825 owner ruling 2026-11-07:
//      the seam has its OWN cohort ramp so turning one's own install on via
//      env never requires bumping an unrelated rollout — pluginLaneServerHistory
//      governs where stamped ids get pinned to rows, which this seam FEEDS);
//      either may allow a harvest, neither defaulting on;
//   2. the loopback-only trust boundary (a remote caller may never trigger a
//      local-file read keyed on headers it controls — same boundary as the
//      #3248 capabilities probe and the loopback-gated turn path);
//   3. STRICT canonical msgid validation (validateMsgIds is the single rule
//      source, #4491) and the whole-turn-degrade contract: an adapter returns
//      exactly `expectedLen` ids in wire order or null — a partial or shifted
//      array degrades the ENTIRE turn to the pre-wiring path. Ids are never
//      reused by any harvested client, so misbinding is impossible; a failed
//      alignment at worst misses pinning, it cannot attach a wrong identity.
//
// Consumption after a hit is exactly today's stamped-body path: handle.ts
// re-stamps the validated ids onto `parsed` under MSG_IDS_BODY_FIELD before
// prepare runs, so the anthropic-lane pin (#4491), the resolve-stage
// last-resort rung (#5719) and membership probing all see one shape.

import fs from "node:fs";
import path from "node:path";
import { validateMsgIds } from "./msgid-pin.js";
import { featureEnabled } from "./rollout.js";
import { isLoopbackAddress } from "./util.js";
import { log as loggerLog } from "./logger.js";

const ENV = "BILI_IDENTITY_HARVEST";

/** Bounded tail-read for append-only transcripts that outgrow memory comfort:
 *  alignment only ever consumes the LAST `expectedLen` rows, so a bounded
 *  tail (dropping a possibly-partial first line) is exact for its purpose. */
export const HARVEST_TAIL_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_DIRS = 2000;
/** Boundary positions compared when both sides expose roles at them. */
const MAX_ROLE_SPOT_CHECK = 4;

export interface IdentityHarvestCtx {
    /** The recognized conversation-identity value for this request (the raw
     *  session key BEFORE persona/fork resolution). */
    sessionId: string;
    /** Normalized message count of the outbound request. Adapters must return
     *  exactly this many ids, in wire order, or null. */
    expectedLen: number;
    /** Request socket address — the loopback gate input. */
    remoteAddress?: string;
    /** Lowercased inbound headers (first value per name where multiple), for
     *  adapter matching — always read via headerFirst(). */
    headers?: Record<string, string | string[] | undefined>;
    /** Wire roles of the outbound messages, for cheap boundary verification
     *  when an adapter can map its stored rows onto wire roles. */
    messageRoles?: readonly string[] | undefined;
}

interface IdentitySource {
    /** Roster name ("claude", "codebuddy", ...). Appears in logs/tests. */
    readonly id: string;
    /** Cheap synchronous gate: header presence / id shape. Must not touch disk. */
    matches(ctx: IdentityHarvestCtx): boolean;
    /** Read the client's local store and align. Exactly expectedLen ids in
     *  wire order, or null (whole-turn degrade). Loopback already enforced by
     *  the registry. */
    snapshot(ctx: IdentityHarvestCtx): readonly string[] | null;
}

let sources: IdentitySource[] = [];

export function registerIdentitySource(source: IdentitySource): void {
    if (!sources.some((s) => s.id === source.id)) sources.push(source);
}

/** enabled(): "" unset → null (no env scope); "1"/"all" → every registered
 *  source; comma list → scope to named sources. EITHER this switch or the
 *  identityChannelHarvest rollout may enable harvesting (harvestIdentity). */
function enabledSources(): Set<string> | null {
    const raw = process.env[ENV] ?? "";
    const v = raw.trim();
    if (v.length === 0) return null;
    if (v === "1" || v.toLowerCase() === "all") return new Set(sources.map((s) => s.id));
    return new Set(v.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    loggerLog("warn", `[identity-harvest] ${message}`);
}

/** First header value for an adapter match — http.IncomingMessage carries
 *  string | string[] per name; only the first element is a candidate id. */
export function headerFirst(ctx: IdentityHarvestCtx, name: string): string | undefined {
    const v = ctx.headers?.[name];
    return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
}

export function resetIdentityHarvestForTest(): void {
    sources = [];
    warned.clear();
}

/** Tail alignment shared by every harvest source: exact count parity on the
 *  last `expectedLen` rows + a role spot-check over up to MAX_ROLE_SPOT_CHECK
 *  boundary positions WHERE BOTH SIDES EXPOSE A ROLE (either side lacking one
 *  at a position skips it — schemas differ per client). Any agreement
 *  disagreement degrades the whole turn. ids in wire order. */
export function alignTailIds(ctx: IdentityHarvestCtx, rows: Array<{ id: string; role?: string }>): string[] | null {
    if (rows.length < ctx.expectedLen) return null;
    const tail = rows.slice(-ctx.expectedLen);
    if (ctx.messageRoles && ctx.messageRoles.length === ctx.expectedLen) {
        let checked = 0;
        for (let i = tail.length - 1; i >= 0 && checked < MAX_ROLE_SPOT_CHECK; i--) {
            const want = String(ctx.messageRoles[i] ?? "").toLowerCase();
            const have = tail[i].role?.toLowerCase();
            if (!want || !have) continue;
            if (want !== have) return null;
            checked++;
        }
    }
    return tail.map((r) => r.id);
}

type HarvestResult = { ids: readonly string[]; sourceId: string } | null;

/** The single call site (handle.ts, once per request, BEFORE persona/fork
 *  resolution consumes identity evidence): host-stamped body ids always win —
 *  harvesting fills only the absent case. */
export function harvestIdentity(ctx: IdentityHarvestCtx): HarvestResult {
    if (ctx.expectedLen <= 0) return null;
    let allowed = enabledSources();
    if (allowed === null) {
        // No per-install env switch: only the cohort-wide rollout key may act
        // (defaulting OFF), and without an env scope it covers all sources.
        if (!featureEnabled("identityChannelHarvest")) return null;
        allowed = new Set(sources.map((s) => s.id));
    }
    if (allowed.size === 0) return null;
    if (!isLoopbackAddress(ctx.remoteAddress)) return null; // trust boundary
    for (const source of sources) {
        if (!allowed.has(source.id)) continue;
        let matched = false;
        try {
            matched = source.matches(ctx);
        } catch {
            warnOnce(`match:${source.id}`, `matches() threw — source disabled for this turn`);
            continue;
        }
        if (!matched) continue;
        let ids: readonly string[] | null;
        try {
            ids = source.snapshot(ctx);
        } catch (e) {
            warnOnce(`snapshot:${source.id}`, `snapshot() failed (${String(e)}) — degrading turn to content-derived ids`);
            return null;
        }
        if (ids === null || ids.length !== ctx.expectedLen) {
            warnOnce(`degrade:${source.id}`, `alignment incomplete (${ids?.length ?? 0} of ${ctx.expectedLen}) — degrading turn to content-derived ids (no partial pairing)`);
            return null;
        }
        const v = validateMsgIds(ids, ctx.expectedLen);
        if (!v.ok) {
            warnOnce(`invalid:${source.id}:${v.reason}`, `harvested ids fail canonical validation (${v.reason}) — degrading turn`);
            return null;
        }
        loggerLog("info", `[identity-harvest] ${source.id}: ${ctx.sessionId.slice(0, 18)}… pinned ${String(ctx.expectedLen)} transcript id(s) this turn (#5825)`);
        return { ids: v.ids, sourceId: source.id };
    }
    return null;
}

/* ---------------- shared readers (claude-class layouts) ----------------
 * Both claude-code (`<config>/projects/<encoded-cwd>/<session>.jsonl`, SDK
 * encoding too fiddly to recompute — probe instead, cf. #1486 lineage reader)
 * and codebuddy (`$CODEBUDDY_CONFIG_DIR/projects/<escaped-cwd>/<conversation-id>.jsonl`,
 * filename == conversation id, measured 2.181.0) share this prober. Returns
 * real files whose realpath stays inside their projects root. */
export function findProjectJsonlFiles(configDirs: string[], fileBaseName: string, subdir?: string): string[] {
    const found: string[] = [];
    for (const dir of configDirs) {
        // Config roots may be passed as either `<root>` or `<root>/projects`.
        const projects = dir.endsWith(path.sep + "projects") || dir === "projects" ? dir : path.join(dir, "projects");
        let root: string;
        let entries: fs.Dirent[];
        try {
            root = fs.realpathSync(projects);
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        let probed = 0;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (++probed > MAX_PROJECT_DIRS) break;
            const candidate = subdir ? path.join(root, entry.name, subdir, `${fileBaseName}.jsonl`) : path.join(root, entry.name, `${fileBaseName}.jsonl`);
            try {
                const real = fs.realpathSync(candidate);
                if (!real.startsWith(root + path.sep)) continue; // symlink escape
                if (!fs.statSync(real).isFile()) continue;
                if (!found.includes(real)) found.push(real);
            } catch { /* absent here — keep probing */ }
        }
    }
    return found;
}

/** Tail-read an append-only JSONL (bounded), returning ONLY complete lines
 *  (a trailing partial line — a transcript being written — is dropped). */
export function readJsonlTail(file: string, maxBytes: number = HARVEST_TAIL_BYTES): string[] {
    let size: number;
    try {
        size = fs.statSync(file).size;
    } catch {
        return [];
    }
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    let off = start;
    let n = 0;
    let fd: number | null = null;
    try {
        fd = fs.openSync(file, "r");
        while (n < buf.length) {
            const r = fs.readSync(fd, buf, n, buf.length - n, off + n);
            if (r <= 0) break;
            n += r;
        }
    } catch {
        return [];
    } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    }
    let text = buf.subarray(0, n).toString("utf8");
    if (start > 0) {
        // Drop everything up to the first complete newline: the first line of
        // the window may be split mid-entry.
        const nl = text.indexOf("\n");
        if (nl < 0) return [];
        text = text.slice(nl + 1);
    }
    const lines = text.split("\n");
    // Drop the final segment ALWAYS: with a trailing newline it's the empty
    // post-EOF piece; without one it's a line still being written (torn or
    // mid-flush) and must never be aligned on.
    lines.pop();
    return lines.filter((l) => l.length > 0);
}

