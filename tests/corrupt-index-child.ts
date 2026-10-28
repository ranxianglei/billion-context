/**
 * #4338: the corrupt index.db degrade scenarios run in a spawned CHILD
 * process, and this file is both the child program and the shared helper
 * module the two parent test files import.
 *
 * Why a child: on Windows, node:sqlite's FAILED open of a corrupt index.db
 * can leave an OS file handle held with no JS-side instance to release
 * (upstream open-failure behavior; src/storage/driver.ts:105 throws before
 * the variable is assigned, and the catch paths keep no reference). POSIX
 * unlink succeeds on open files, so the leak only shows on Windows — as a
 * persistent EBUSY in the tests' finally { rmrf(dir) } that outlives the
 * entire tests/tmp-rm.ts retry ladder (~9.9s). A child process exiting
 * RELEASES all its handles by OS guarantee, so the corrupt-db construction +
 * degradation checks execute here and the parent's rmrf can no longer hit a
 * stale lock.
 *
 * Contract: the child performs the exact same operations and assertions the
 * in-process tests performed, then prints ONE JSON verdict line to stdout —
 * {ok: true, checks: [{name, ok}, ...]} or {ok: false, failure: "<check
 * name>: <detail>", checks: [...]} — and exits 0/1. The parent spawns this
 * file (node --import tsx <this file> <mode> <args...>), captures stdout +
 * exit code, and re-asserts every named check, so assertion semantics stay
 * 1:1 with the in-process era: same assertions, executed in the child,
 * verified in the parent.
 *
 * Single-definition exports (no drift between parent and child): the storage
 * view digests (moved from tests/storage-engine-proofs.test.ts), the banner
 * proxy opts + StorageWire shape (moved from tests/web-storage-banner.test.ts),
 * and the spawn/verdict runner. The child main() only runs when this file is
 * the process entry (spawned directly), never when imported by a test file.
 */

import { spawnSync } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { loadLegacyView, toLegacyLike } from "../src/storage/ingest.ts";
import { canonicalize, sha256, sortObjectKeys } from "./golden-canonical.ts";

// ---------------------------------------------------------------------------
// Shared with the parent test files (moved verbatim, single definition).
// ---------------------------------------------------------------------------

export function viewDigest(view: ReturnType<typeof loadLegacyView>): string {
    return sha256(JSON.stringify(canonicalize({
        id: view.id,
        meta: view.meta,
        stats: view.stats,
        metadata: view.metadata,
        state: view.state,
        blockContents: [...view.blockContents.entries()],
        lastMessages: view.lastMessages,
        lastMessagesFolded: view.lastMessagesFolded,
        pluginSnapshot: view.pluginSnapshot,
        contentStore: view.contentStore,
    })));
}

/** #2960 ⑤: viewDigest minus the tail pointer fields — full mode serves the
 *  RAW tail from the table while legacy serves the envelope's bounded folded
 *  re-render, so cross-mode "identical state" proofs compare the state proper
 *  (folds/refs/blocks/contents) and pin the tail relationship separately. */
export function viewStateDigest(view: ReturnType<typeof loadLegacyView>): string {
    return sha256(JSON.stringify(canonicalize({
        id: view.id,
        meta: view.meta,
        stats: view.stats,
        metadata: view.metadata,
        state: view.state,
        blockContents: [...view.blockContents.entries()],
        pluginSnapshot: view.pluginSnapshot,
        contentStore: view.contentStore,
    })));
}

/** #4316 layer 3 PR3/3 (380ef4dac): a unified full-mode cold load performs a
 *  ONE-TIME ledger alignment — citation numbers are re-homed onto ledger
 *  sequence (kernel restampRefsToLedger) and state.refLedgerAligned is stamped.
 *  Cross-mode / cross-read-path "identical state" proofs must therefore compare
 *  the state modulo that one-time renumbering: this strips the alignment stamp
 *  and re-homes every ref number to a canonical order (k-th smallest raw id ->
 *  m0000k), so two views differing ONLY in which numbering scheme produced
 *  their refs hash identically under viewDigest/viewStateDigest. Object key
 *  order is normalized too: different hydration paths build identical content
 *  under different insertion orders, and canonicalize preserves them. Pure
 *  function — returns a new object, input untouched. */
export function stripOneTimeAlignment<T>(view: T): T {
    const v = view as { state?: unknown; blockContents?: unknown };
    if (!v.state || typeof v.state !== "object") return view;
    const byRaw = (v.state as { messageRefs?: { byRaw?: Record<string, string> } }).messageRefs?.byRaw;
    const remap = new Map<string, string>();
    if (byRaw) {
        for (const [raw, ref] of Object.entries(byRaw).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            remap.set(ref, `m${String(remap.size + 1).padStart(5, "0")}`);
        }
    }
    // The JSON pass below flattens Maps — pull blockContents out while it is
    // still a Map, renumber its keys afterwards, rebuild it. Everything else
    // in these views is JSON-native.
    const bcIsMap = v.blockContents instanceof Map;
    let bcEntries: Array<[string, string]> | null = null;
    let source: unknown = view;
    if (bcIsMap) {
        bcEntries = [...(v.blockContents as Map<string, string>).entries()];
        source = { ...(v as Record<string, unknown>), blockContents: undefined };
    }
    let json = JSON.stringify(canonicalize(source));
    if (remap.size > 0) {
        // Single-pass alternation: sequential per-token replacement would chain
        // (a target that is also another source gets re-mapped on the next pass).
        const re = new RegExp(`\\b(${[...remap.keys()].join("|")})\\b`, "g");
        json = json.replace(re, (tok) => remap.get(tok)!);
    }
    const out = JSON.parse(json) as (T & { state?: Record<string, unknown>; blockContents?: unknown }) & Record<string, unknown>;
    if (out.state && "refLedgerAligned" in out.state) delete out.state["refLedgerAligned"];
    // cacheLedger line `bd` digests hash the RAW outbound bodies — bodies whose
    // only cross-leg delta is this same citation renumbering. The bodies are
    // compared directly (per-turn shaCiteNorm), so masking the derived digests
    // hides nothing; keeping them would fail every aligned comparison.
    const ledger = (out.metadata as { cacheLedger?: { lines?: Array<Record<string, unknown>> } } | undefined)?.cacheLedger;
    // Segment bookkeeping, not content, in the aligned view (#4599): a restart
    // appends a fresh open tail line and re-anchors the closed-segment byte
    // boundaries (be/bl/bs), so no-restart and restart legs legitimately differ
    // there. Keep the closed segments' content; drop the unfinalized tail and
    // the bookkeeping trio everywhere.
    if (Array.isArray(ledger?.lines)) {
      while (ledger.lines.length > 0 && ledger.lines[ledger.lines.length - 1]?.bl === undefined) ledger.lines.pop();
      for (const line of ledger.lines) { delete line["bd"]; delete line["be"]; delete line["bl"]; delete line["bs"]; delete line["prov"]; delete line["seam"]; }
    }
    // agg is the same experience telemetry summed: a restart re-partitions the
    // provider-cache misses into seam buckets (seamMissed/seamSuspects vs
    // providerSideMissed), so legs legitimately disagree. Per-line content
    // fields stay; only the derived aggregate goes.
    if (ledger) delete (ledger as { agg?: unknown }).agg;
    // snapshotShadow is the shadow-copier's OWN health telemetry — it reports
    // the ingest pipeline's experience of building this view (errors, watermark
    // drops), which is inherently load-path-dependent, not conversation state.
    if (out.metadata && "snapshotShadow" in (out.metadata as Record<string, unknown>)) delete (out.metadata as Record<string, unknown>)["snapshotShadow"];
    if (bcEntries) out.blockContents = new Map(bcEntries.map(([k, val]) => [remap.get(k) ?? k, val]));
    return sortObjectKeys(out) as T;
}

export interface StorageWire {
    requested: string;
    effective: string;
    degraded: boolean;
    intentionalOptOut: boolean;
    reason: string | null;
    engine: { name: string; source: string } | null;
    bootstrap: string | null;
    bootstrapFailure: unknown;
    cooldownRemainingMs: number | null;
    sidecarDisabled: boolean;
}

export function makeOpts(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
}

// ---------------------------------------------------------------------------
// Named checks — the child produces them, the parent re-asserts them. Both
// sides reference these constants, so the coverage list cannot drift.
// ---------------------------------------------------------------------------

const ENGPROOF_CHECK_NAMES = {
    fallbackRead: "legacy fallback returned a session over the corrupt index",
    midFlowGuard: "no live handle after the corrupt-index read (#2781 rename guard)",
    stateDigest: "corrupt-index fallback state digest matches the clean full-mode read",
    writeNow: "writeNow keeps working over the legacy path after the corrupt-index degrade",
    postCloseGuard: "no live handle after the final close (post-close rename guard)",
    fdGuard: "no open fd into the corrupt index dir after close (/proc/self/fd, Linux)",
} as const;
export const ENGPROOF_CHECKS: readonly string[] = Object.values(ENGPROOF_CHECK_NAMES);

const BANNER_CHECK_NAMES = {
    overviewAnswers: "/__bili/overview answers 200 with JSON",
    requestedFull: "storage.requested is full",
    effectiveLegacy: "storage.effective is legacy",
    degraded: "storage.degraded is true (corrupt index.db trips the warning)",
    intentionalOptOut: "storage.intentionalOptOut is false",
    reason: "storage.reason matches /index database failed to open/",
    engine: "storage.engine is null",
} as const;
export const BANNER_CHECKS: readonly string[] = Object.values(BANNER_CHECK_NAMES);

interface CorruptIndexCheck {
    name: string;
    ok: boolean;
    detail?: string;
}
interface CorruptIndexVerdict {
    ok: boolean;
    failure: string | null;
    checks: CorruptIndexCheck[];
}

/** Parent-side runner: spawn this file as the child, parse its JSON verdict
 *  line. `env` is used VERBATIM as the child's environment — the caller
 *  builds the full {...process.env, ...overrides} (plus any deletions), so
 *  the parent's own env is never mutated. Throws when the child produced no
 *  parseable verdict (crash, timeout) with the stderr tail for diagnosis. */
export function spawnCorruptIndexChild(mode: "engproof" | "banner", argv: string[], env: NodeJS.ProcessEnv): CorruptIndexVerdict {
    const entry = fileURLToPath(new URL(import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", entry, mode, ...argv], {
        env,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    const lastLine = result.stdout.trim().split(/\r?\n/).filter((line) => line.length > 0).pop() ?? "";
    let verdict: CorruptIndexVerdict | null = null;
    try {
        const parsed: unknown = JSON.parse(lastLine);
        if (parsed && typeof parsed === "object" && typeof (parsed as CorruptIndexVerdict).ok === "boolean") {
            verdict = parsed as CorruptIndexVerdict;
        }
    } catch {
        // no verdict line — fall through to the loud error below
    }
    if (!verdict) {
        const err = result.error instanceof Error ? result.error.message : String(result.error ?? "none");
        throw new Error(
            `corrupt-index child (${mode}) produced no verdict: status=${String(result.status)} error=${err} stderr=${(result.stderr ?? "").slice(-2000)}`,
        );
    }
    return verdict;
}

// ---------------------------------------------------------------------------
// Child program (runs only when spawned directly).
// ---------------------------------------------------------------------------

/** Mirrors node:assert stop-at-first-throw semantics: once a check fails,
 *  later checks are skipped (absent from checks[]) and the verdict carries
 *  the failure — exactly how the in-process test died at its first failed
 *  assert. */
class CheckRun {
    readonly checks: CorruptIndexCheck[] = [];
    failure: string | null = null;

    async run(name: string, fn: () => void | Promise<void>): Promise<boolean> {
        if (this.failure !== null) return false;
        try {
            await fn();
            this.checks.push({ name, ok: true });
            return true;
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.checks.push({ name, ok: false, detail });
            this.failure = `${name}: ${detail}`;
            return false;
        }
    }
}

/** rename dir→dir+suffix→dir; both directions must succeed. Windows refuses
 *  to move/delete a directory while any process holds a file inside it open;
 *  on POSIX the pair is a no-op that always succeeds, so the guard only bites
 *  where the bug lives. */
async function runGuard(run: CheckRun, name: string, dir: string, suffix: string): Promise<void> {
    await run.run(name, () => {
        const probe = dir + suffix;
        fs.renameSync(dir, probe);
        fs.renameSync(probe, dir);
    });
}

/** #4357: the rename guard above is a POSIX no-op — a leaked sqlite handle is
 *  invisible to it on Linux. Scan our own fd table directly so an in-process
 *  leak (the quick_check throw path) trips by name there too, not only as an
 *  EBUSY unlink on Windows. No-op pass elsewhere: Windows is covered
 *  end-to-end by the parent's teardown rmrf no longer hitting EBUSY. */
async function runFdGuard(run: CheckRun, name: string, dir: string): Promise<void> {
    await run.run(name, () => {
        if (process.platform !== "linux") return;
        const held: string[] = [];
        for (const entry of fs.readdirSync("/proc/self/fd")) {
            let target = "";
            try {
                target = fs.readlinkSync(path.join("/proc/self/fd", entry));
            } catch {
                continue; // fd dropped between readdir and readlink
            }
            if (target === dir || target.startsWith(`${dir}${path.sep}`)) {
                held.push(`${entry}→${target}`);
            }
        }
        assert.equal(held.length, 0, `open handle(s) into the corrupt index dir after close: ${held.join(", ")}`);
    });
}

/** tests/storage-engine-proofs.test.ts #2771 scenario: argv = [dir,
 *  expectedStateDigest] — the parent seeded dir (corpus + full-mode write +
 *  clean full-mode read) and hands in the clean read's state digest. */
async function engproofScenario(argv: string[], run: CheckRun): Promise<void> {
    const [dir, expectedStateDigest] = argv;
    if (!dir || !expectedStateDigest) throw new Error("engproof mode needs <dir> <expectedStateDigest>");

    // Corrupt the index header (crashed checkpoint / stray write).
    const fd = fs.openSync(path.join(dir, "index.db"), "r+");
    fs.writeSync(fd, Buffer.alloc(512, 0x5a), 0, 512, 0);
    fs.closeSync(fd);

    // THE #2771 regression: construction must survive, reads must fall
    // back to the legacy file, and the digest must be exact.
    const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
    const reloaded = store2.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
    store2.cancelAll();
    try {
        await run.run(ENGPROOF_CHECK_NAMES.fallbackRead, () =>
            assert.ok(reloaded, "legacy fallback returned null over a corrupt index"));
        if (!reloaded) return;

        // Regression (#2781): the failed open must have CLOSED its handle.
        await runGuard(run, ENGPROOF_CHECK_NAMES.midFlowGuard, dir, "-moved");

        // #4316 PR3/3: the clean full-mode read carried the one-time ledger
        // alignment; the legacy fallback over the corrupt index did not. The
        // parent passes its digest already modulo that alignment (single
        // definition), so strip it here too before comparing.
        await run.run(ENGPROOF_CHECK_NAMES.stateDigest, () =>
            assert.equal(viewStateDigest(stripOneTimeAlignment(toLegacyLike(reloaded))), expectedStateDigest,
                "corrupt-index fallback state digest drift vs clean full-mode read"));

        // Writes must keep working (legacy path) — no throw, file refreshed.
        await run.run(ENGPROOF_CHECK_NAMES.writeNow, () => store2.writeNow(reloaded));
    } finally {
        store2.closeQuietly();
    }

    // #4338 direction 4: the #2781 guard above only covers the window between
    // loadSync and writeNow — the leak behind #4338 was (re)acquired during
    // the write phase, past that guard, and only surfaced at rmrf after the
    // whole retry ladder burned. Guard AFTER the final close too, so future
    // handle-leak drift trips here — named, deterministic, at the right
    // place — instead of as a 10-second EBUSY in teardown.
    await runGuard(run, ENGPROOF_CHECK_NAMES.postCloseGuard, dir, "-postclose");

    // #4357: POSIX rename cannot see open files — scan our own fd table so the
    // quick_check throw-path leak trips by name on Linux as well.
    await runFdGuard(run, ENGPROOF_CHECK_NAMES.fdGuard, dir);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

/** tests/web-storage-banner.test.ts #3040 scenario: argv = [base] — the
 *  parent created the temp base and points the child's env at it
 *  (BILI_SESSIONS_DIR=<base>/sessions, absent config, isolated XDG roots,
 *  BILI_STORAGE_UNIFIED/BILI_ENCRYPTION_KEY unset — requested resolves to the
 *  full default, src/knobs.ts resolveStorageMode). */
async function bannerScenario(argv: string[], run: CheckRun): Promise<void> {
    const [base] = argv;
    if (!base) throw new Error("banner mode needs <base>");
    const dir = path.join(base, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.db"), Buffer.from("this is definitely not a sqlite database file".repeat(8)));
    const store = new SessionStore({ dir, enabled: true });
    _setStoreForTest(store);
    const upstreamPort = await freePort();
    const proxy = await startServer(makeOpts(upstreamPort));
    await once(proxy, "listening");
    try {
        const port = (proxy.address() as { port: number }).port;
        // Holder (not a plain let): the assignment happens inside the check
        // closure, and TS control-flow narrowing cannot see closure writes —
        // a `let overview = null` would narrow to `never` at the guard below.
        const overview: { storage?: StorageWire } = {};
        await run.run(BANNER_CHECK_NAMES.overviewAnswers, async () => {
            const res = await fetch(`http://127.0.0.1:${port}/__bili/overview`);
            assert.equal(res.status, 200, "/__bili/overview answers 200");
            overview.storage = ((await res.json()) as { storage: StorageWire }).storage;
        });
        const storage = overview.storage;
        if (!storage) return;
        await run.run(BANNER_CHECK_NAMES.requestedFull, () => assert.equal(storage.requested, "full"));
        await run.run(BANNER_CHECK_NAMES.effectiveLegacy, () => assert.equal(storage.effective, "legacy"));
        await run.run(BANNER_CHECK_NAMES.degraded, () => assert.equal(storage.degraded, true, "corrupt index.db trips the warning"));
        await run.run(BANNER_CHECK_NAMES.intentionalOptOut, () => assert.equal(storage.intentionalOptOut, false));
        await run.run(BANNER_CHECK_NAMES.reason, () => assert.match(storage.reason ?? "", /index database failed to open/));
        await run.run(BANNER_CHECK_NAMES.engine, () => assert.equal(storage.engine, null));
    } finally {
        await close(proxy);
        store.closeQuietly();
    }
}

async function main(argv: string[]): Promise<number> {
    const run = new CheckRun();
    const [mode, ...rest] = argv;
    try {
        if (mode === "engproof") await engproofScenario(rest, run);
        else if (mode === "banner") await bannerScenario(rest, run);
        else throw new Error(`unknown corrupt-index child mode: ${mode ?? "(none)"}`);
    } catch (err) {
        // Crash outside any named check (bad argv, spawn-level failure...).
        run.failure = err instanceof Error ? err.message : String(err);
    }
    const verdict: CorruptIndexVerdict = { ok: run.failure === null, failure: run.failure, checks: run.checks };
    writeSync(1, JSON.stringify(verdict) + "\n");
    return verdict.ok ? 0 : 1;
}

const isDirectRun = (() => {
    try {
        return import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href;
    } catch {
        return false;
    }
})();

if (isDirectRun) {
    main(process.argv.slice(2))
        .then((code: number) => process.exit(code))
        .catch((err: unknown) => {
            const failure = err instanceof Error ? err.stack : String(err);
            writeSync(1, JSON.stringify({ ok: false, failure: `child crashed: ${failure}`, checks: [] }) + "\n");
            process.exit(1);
        });
}
