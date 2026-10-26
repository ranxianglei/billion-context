import { AsyncLocalStorage } from "node:async_hooks";
import { logHostEvent } from "../host-log.js";

/** Ownership marker for bili's own chain links (#1410). Every function
 *  makeChain produces carries this symbol as an OWN property, so a write-back
 *  of our own (possibly stale) link to globalThis.fetch is recognized as ours
 *  — never counted as a third-party evict spending re-arm budget. */
const CHAIN_MARKER = Symbol.for("billion-context.native-fetch-chain");

function markOwnChain(fn: typeof globalThis.fetch): void {
    Object.defineProperty(fn, CHAIN_MARKER, { value: true, configurable: true, writable: true, enumerable: false });
}

function isOwnChain(v: unknown): boolean {
    return typeof v === "function" && Object.prototype.hasOwnProperty.call(v, CHAIN_MARKER);
}

/** #1158 escape hatch: `BILI_RECLAIM_FETCH_PATCH=0` keeps the classic direct
 *  install — a third-party re-arm (dsh-http-proxy refresh) then wins and
 *  bili stops seeing model traffic (documented degradation, visible instead
 *  of silently healed) for setups that NEED the third-party chain on top
 *  (e.g. a socks egress bili's upstream proxying does not support). */
function shouldReclaimFetchPatch(): boolean {
    const raw = process.env.BILI_RECLAIM_FETCH_PATCH;
    if (raw === undefined) return true;
    return !/^(0|false|off|no)$/i.test(raw.trim());
}

/** #1158 self-heal: the property descriptor captured before we installed the
 *  guarded accessor, so _resetForTest can restore a plain writable data
 *  property. Undefined before the first install in a process. */
let preInstallDesc: PropertyDescriptor | undefined;

/** The accessor descriptor we defined on globalThis.fetch — identity-compared
 *  by _resetForTest before restoring preInstallDesc, so a third party's legal
 *  delete/redefine in between (#1410) is never clobbered. */
let installedDesc: PropertyDescriptor | undefined;

/** #1410 re-anchor ledger: every fetch this process has ever observed at the
 *  top slot, ordered oldest→newest. The oldest entry is the module-load
 *  anchor — whatever fetch existed BEFORE any plugin ran, i.e. the host's
 *  native fetch. When the adopted downstream dies underneath us (its owner
 *  tore its wrapper down behind our back — scope end nulling its closure
 *  locals) we re-anchor to the OLDEST still-live entry instead of the
 *  newest: the newest may itself be someone else's transient scope wrapper
 *  (adopting it would just repeat the failure one teardown later), while the
 *  oldest has already survived every prior teardown in this process. */
let moduleAnchor: typeof globalThis.fetch | undefined = typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;
let observedFetches: Array<typeof globalThis.fetch> = moduleAnchor !== undefined ? [moduleAnchor] : [];
const knownDeadFetches = new Set<typeof globalThis.fetch>();
let warnedReanchor = false;

// #1662: per-request dispatch depth, tracked in an async context — NOT a
// global counter, because concurrent top-level requests must not see each
// other. 1 = inside bili's own dispatch body. A re-entry observed at depth
// 1 is PROOF of accumulated nesting: a link of ours is being called from
// within our own dispatch, which is only possible through a foreign wrapper
// that captured one of our older tops (the churn shape of dsh-codex-
// subscription). 2 = already performed the depth-1 termination jump; any
// further re-entry falls back to the plain walk (degenerate multi-plugin
// nesting) so the termination itself can never loop.
const dispatchDepth = new AsyncLocalStorage<number>();
// #4527: one-hop descent marker. Each link's `send` stamps the EXACT
// downstream function it is about to call; a bili link whose `patched`
// wrapper is entered with this marker pointing at ITSELF is being called by
// the bili link directly above it (e.g. the native intercept handing its
// INLINE_ORIGIN rewrite down to the inline transport) — a legitimate hop
// through our own stack that must still run this link's dispatch. A foreign
// wrapper in between re-issues the call as ITS own hop, so the identity
// match fails and #1662's truncation below keeps protecting the descent.
const chainHop = new AsyncLocalStorage<unknown>();
let warnedReentry = false;

/** #1410: the dead-closure signature. A wrapper whose owner nulled its
 *  closure locals dies exactly like this ("baseFetch is not a function").
 *  Network failures NEVER match: undici throws "fetch failed", provider SDKs
 *  throw their own messages — only the missing-closure shape does. */
export function isDeadClosureError(err: unknown): boolean {
    return err instanceof TypeError && /is not a function$/.test(err.message);
}

function noteFetch(f: unknown): void {
    if (typeof f !== "function") return;
    const fn = f as typeof globalThis.fetch;
    if (!observedFetches.includes(fn)) observedFetches.push(fn);
}

/** Mark `dead` (just proven torn down) and return the oldest observed fetch
 *  still believed live, or undefined when nothing is left. */
function nextLiveAnchor(dead: typeof globalThis.fetch): typeof globalThis.fetch | undefined {
    knownDeadFetches.add(dead);
    return observedFetches.find((f) => !knownDeadFetches.has(f));
}

export function installFetchChain(makeDispatch: (send: typeof globalThis.fetch) => typeof globalThis.fetch): void {
    const orig = globalThis.fetch;
    noteFetch(orig);
    const makeChain = (downstream: typeof globalThis.fetch) => {
        // #1410: the downstream reference is MUTABLE. send() swaps it when
        // proof arrives that the current one was torn down underneath us
        // (dead-closure error) and retries on the oldest still-live fetch.
        let ds = downstream;
        const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            let cur = ds;
            for (;;) {
                try {
                    // #4527: stamp the hop so the downstream link (when it is
                    // one of ours) can tell a legitimate descent from a
                    // foreign wrapper's re-entry (#1662).
                    return await chainHop.run(cur, () => cur(input, init));
                } catch (err) {
                    const next = isDeadClosureError(err) ? nextLiveAnchor(cur) : undefined;
                    if (next === undefined) throw err;
                    if (!warnedReanchor) {
                        warnedReanchor = true;
                        logHostEvent("warn", "[native-client]", "[bili-native] adopted downstream fetch was torn down by its owner (#1410) — re-anchored the chain onto the oldest live fetch");
                    }
                    ds = next;
                    cur = next;
                }
            }
        };
        const dispatchBody = makeDispatch(send);

        // #1662: re-entry termination. A coexisting plugin (dsh-codex-
        // subscription shape) that repeatedly wraps the CURRENT top grows the
        // chain one (wrapper, bili-link) pair per wrap: C_n → w_n → C_{n-1}
        // → … . Pre-fix, every request walked the ENTIRE accumulated history
        // (each stacked link re-running the full dispatch), so stack depth
        // grew with session lifetime until the host process died with
        // "RangeError: Maximum call stack size exceeded" (observed live on
        // Windows). The depth check below is the proof of such nesting: an
        // OUR link called from within our own dispatch can only be reached
        // through a foreign wrapper that captured one of our older tops.
        // A recognized pi-web-access link still owns proxy routing even after
        // bili dispatched, so retain it at depth 1. Its older bili links must
        // still be able to truncate unknown wrapper history.
        // ponytail: unknown wrappers retain the #1662 cutoff; preserving their
        // deeper hooks requires a shared chain protocol.
        const patched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            // #4527: legitimate descent through our own link stack — the link
            // directly above called THIS wrapper by identity (see chainHop).
            // The #1662 depth logic below exists to terminate FOREIGN
            // re-wraps, whose hop identity can never match; run our dispatch
            // at one deeper level instead of skipping or truncating it.
            if (chainHop.getStore() === patched) {
                return dispatchDepth.run((dispatchDepth.getStore() ?? 0) + 1, () => dispatchBody(input, init));
            }
            const depth = dispatchDepth.getStore();
            if (depth === 1) {
                if (Reflect.get(ds, "__piWebAccessProxyFetch") === true) return send(input, init);
                const anchor = observedFetches.find((f) => !knownDeadFetches.has(f));
                if (anchor !== undefined && anchor !== ds) {
                    if (!warnedReentry) {
                        warnedReentry = true;
                        logHostEvent("warn", "[native-client]", "[bili-native] nested re-entry into the bili fetch chain detected (#1662) — a coexisting plugin re-wrapped bili's own chain; terminating the descent at the oldest live anchor so request depth stays constant");
                    }
                    return dispatchDepth.run(2, () => anchor(input, init));
                }
                return send(input, init);
            }
            if (depth !== undefined) return send(input, init);
            return dispatchDepth.run(1, () => dispatchBody(input, init));
        };

        const chain = patched as typeof globalThis.fetch;
        markOwnChain(chain);
        // Keep the install guard visible, following ds if dead-closure recovery changes it.
        Object.defineProperty(chain, "__piWebAccessProxyFetch", {
            get: () => Reflect.get(ds, "__piWebAccessProxyFetch"),
        });
        return chain;
    };

    // #1158 self-heal re-arm: dsh-http-proxy (0.1.3) re-applies by writing its
    // module-load-time frozen originalFetch over globalThis.fetch, silently
    // un-routing every model request away from bili while the session keeps
    // working (observed live on Windows). Guard the property instead of
    // trusting the assignment to survive: any third-party install becomes
    // our downstream and model traffic keeps routing through bili.
    const desc = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let rearmCount = 0;
    // #2685: true once this install cycle adopted a recognized pi-web-access
    // wrapper. Its own guard (marker passthrough, #2435) makes the first adopt
    // the only one, so the FIRST marked install is a supported coexistence
    // handshake, not an evict. A LATER marked install is abnormal and keeps the
    // full warning — the flag never blanket-suppresses the diagnostic channel.
    let webAccessAdopted = false;
    const REARM_LIMIT = 16;
    const guard = desc === undefined || desc.configurable;
    let top = makeChain(orig);
    if (guard && shouldReclaimFetchPatch()) {
        preInstallDesc = desc;
        const accessor: PropertyDescriptor = {
            configurable: true,
            enumerable: desc?.enumerable ?? true,
            get: () => top,
            set: (v: unknown) => {
                if (typeof v !== "function" || v === top) return;
                // #1410: our own (possibly stale) chain link written back —
                // recognize it by marker and ignore, never spend re-arm
                // budget on ourselves.
                if (isOwnChain(v)) return;
                // #2685: a recognized pi-web-access wrapper is a SUPPORTED
                // coexistence install, not an evict — its first adopt is a quiet
                // handshake (neutral note, no alarm). Post-#1158-self-heal the
                // guard ALWAYS re-adopts, so routing authority never actually
                // leaves; "evict" was the pre-self-heal framing and is dropped
                // from the wording. Unknown wrappers and any LATER (repeat /
                // abnormal) marked install keep the full diagnostic below.
                const webAccess = Reflect.get(v, "__piWebAccessProxyFetch") === true;
                // Visibility (#1158): a third-party install used to be silent —
                // log it so "un-routed by a third party" is diagnosable. Past
                // REARM_LIMIT the WARNING stops (log spam), but the adoption
                // continues: #1662 showed that surrendering the top slot past
                // the limit (`top = v`) left every later foreign install stacking
                // on the orphaned chain with ZERO visibility — unbounded growth,
                // silent, until the host process died. With the re-entry
                // termination in makeChain each further adopt costs O(1) per
                // request regardless of history length, so the cap now bounds
                // LOGGING only, and routing authority never leaves the guard.
                if (webAccess && !webAccessAdopted) {
                    webAccessAdopted = true;
                    logHostEvent("info", "[native-client]", "[bili-native] adopted pi-web-access proxy fetch as downstream (supported coexistence, #2435)");
                } else if (rearmCount < REARM_LIMIT) {
                    logHostEvent("warn", "[native-client]", `[bili-native] third-party globalThis.fetch install detected (#1158) — re-chaining as downstream (install ${rearmCount + 1})`);
                }
                rearmCount += 1;
                noteFetch(v);
                top = makeChain(v as typeof globalThis.fetch);
            },
        };
        installedDesc = accessor;
        Object.defineProperty(globalThis, "fetch", accessor);
    } else {
        // Non-configurable host property or reclaim disabled
        // (BILI_RECLAIM_FETCH_PATCH=0): keep the classic direct install
        // (no guard, the old behavior).
        globalThis.fetch = top;
    }
}

export function resetFetchChainForTest(opts: { anchor?: typeof globalThis.fetch } = {}): void {
    if (opts.anchor !== undefined) moduleAnchor = opts.anchor;
    observedFetches = moduleAnchor !== undefined ? [moduleAnchor] : [];
    knownDeadFetches.clear();
    warnedReanchor = false;
    warnedReentry = false;
    if (preInstallDesc !== undefined) {
        const d = preInstallDesc;
        preInstallDesc = undefined;
        // #1410: restore ONLY while the property is still ours — it is
        // configurable, so a third party may legally have deleted/redefined
        // it meanwhile; restoring blindly would clobber their install. The
        // comparison must be on the accessor FUNCTIONS, not the descriptor
        // object: on the global object V8 rebuilds the descriptor wrapper
        // around every set, so object identity is never stable.
        const cur = Object.getOwnPropertyDescriptor(globalThis, "fetch");
        if (cur !== undefined && installedDesc !== undefined && cur.get === installedDesc.get && cur.set === installedDesc.set) {
            Object.defineProperty(globalThis, "fetch", { ...d, configurable: true });
        }
        installedDesc = undefined;
    }
}
