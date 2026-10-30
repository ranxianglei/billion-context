// Shared attach/recovery lifecycle for the native host lanes (#5241 phase 1).
//
// Transplanted verbatim from pi-native.ts (PR-1a): pi/omp/opencode carried
// near-identical copies of this function — dsh carries a thicker variant — so
// every fix had to be applied four times and the same bug class kept
// reappearing on lane after lane (port pinning #926→#4566→#5127, cold-start
// tools #4134→#4998→#5001→#4641; see umbrella #5241). One lane migrates per
// PR; each lane's answers are frozen by the phase-0 stakes
// (tests/contract-v2-stake-verify-attach.test.ts) — a change here that changes
// any lane's observable behavior must update those stakes in the same PR, by
// design.

import { nativeAttachOrigin, singleFlight } from "./native-bootstrap.js";
import { observeRoutedOrigin, type NativeInterceptState } from "./native-intercept.js";
import { fetchProxyVersion, waitForProxyVersion } from "./shared.js";

/** Lane-facing event sink: logHostEvent for the process-owned lanes, the
 *  client-visible event bus for dsh. Level set matches logHostEvent's
 *  "info" | "error" usage below. */
export type NativeLaneEventHandler = (level: "info" | "error", message: string) => void;

/** Everything lane-specific the shared lifecycle needs. Pure transposition:
 *  pi/omp/opencode differ only in strings and publish side effects today;
 *  dsh's extras (older-resident rotation #3544, register bookkeeping) arrive
 *  as additional optional hooks when that lane migrates — never silently
 *  unified. */
export interface NativeLaneSpec {
    /** Lane tag for log lines (`bili-native(<lane>): …`). */
    lane: string;
    /** The lane's module-level intercept state singleton. */
    state: NativeInterceptState;
    /** Test seam, read at CALL time so `_setSpawnForTest` after arming still
     *  applies (see pi-native's `_spawnForTest`). */
    spawnForTest: () => (() => Promise<string | undefined>) | undefined;
    /** Lane bootstrap (ensureProxyRunning wrapper) for the spawn fallback. */
    bootstrap: () => Promise<string | undefined>;
    /** Publish a live origin on the lane's surfaces — pi/omp/opencode: the
     *  shared state + BILLION_CONTEXT_PROXY; dsh additionally re-bases its
     *  register. */
    publish: (origin: string) => void;
    /** Drop the published origin (spawn fallback unfreezes the preset env). */
    unpublish: () => void;
    /** Lane event sink (logHostEvent / persistClientEvent). */
    onEvent: NativeLaneEventHandler;
}

// One lane per process (#5241 phase 1). The four lane implementations all
// assume they are alone: they write the SAME process.env.BILLION_CONTEXT_PROXY,
// bind the SAME global fetch-intercept slot and run background timers that
// outlive any single call. Phase-0 probing (#5242) showed two armed lanes in
// one process overwrite each other's proxy env and spawn counters within
// milliseconds. Production never does this (each lane rides its own host
// process) — this guard turns that accident of deployment into an explicit,
// plainly-worded contract before the lanes share one implementation.
let armedLane: string | undefined;

/** Arm `lane` as this process's native lane. Re-arming the SAME lane is fine
 *  (tests and restarts do it); arming a DIFFERENT lane throws — see above. */
export function armNativeLane(lane: string): void {
    if (armedLane !== undefined && armedLane !== lane) {
        throw new Error(
            `bili native lanes are one-per-process: this process already armed the "${armedLane}" lane, refusing to also arm "${lane}" — two lanes in one process overwrite each other's BILLION_CONTEXT_PROXY and fetch intercept (observed in the #5242 phase-0 stakes). Run each lane in its own host process.`,
        );
    }
    armedLane = lane;
}

/** Test hook: clear the one-lane guard between suites. */
export function _resetArmedLaneForTest(): void {
    armedLane = undefined;
}

/** #1135/#1365 (moved from pi-native.ts, lane-generalized): the attached
 *  origin can go stale — at startup (the owning launcher exited before this
 *  process started) or at runtime (it exits while this session still rides
 *  the shared proxy, #1130). Probe before trusting it: healthy → keep
 *  attaching (a transient blip costs nothing — the session never migrates).
 *  DEAD + routed-channel evidence (#1365: /bili/-baked model traffic was
 *  observed at some origin) → the session's context lives at THAT origin, so
 *  wait for the pinned target to come back (bounded by
 *  BILI_ATTACH_HEALTH_DEADLINE_MS) instead of spawning — a second instance
 *  would serve tools while the model channel stays pinned elsewhere and
 *  every bili tool call 404s against it (unrecoverable split); the env is
 *  preserved so the user's target stays declared. DEAD with no evidence
 *  after the grace window (BILI_ATTACH_EVIDENCE_GRACE_MS) → unfreeze the
 *  preset env and fall back to spawning our own proxy, re-arming respawn as
 *  a pure spawn. Resolves to the origin the client should use — the
 *  (recovered) attach origin, the fallback origin, or undefined when nothing
 *  came up. */
export async function verifyAttachAndRecover(spec: NativeLaneSpec, attachOrigin: string): Promise<string | undefined> {
    const { state } = spec;
    // #1365: routed evidence outranks the planned origin — probe where the
    // model channel actually points, not where the env says it should. An
    // EXPLICIT BILLION_CONTEXT_ATTACH outranks both: it names the plugin API
    // endpoint directly, and a routed model origin may be a plain model-only
    // path (e.g. an admin-gated port) that never exposes the plugin manifest.
    const explicitAttachOrigin = nativeAttachOrigin(process.env);
    const home = explicitAttachOrigin ?? state.routedOrigin ?? attachOrigin;
    const version = await fetchProxyVersion(home).catch(() => undefined);
    if (version !== undefined) {
        // Restore the readyOrigin short-circuit — a runtime recovery clears
        // state.origin before re-probing, and a transient blip must not leave
        // it dangling.
        spec.publish(home);
        return home;
    }
    const pinned = explicitAttachOrigin ?? state.routedOrigin ?? (await observeRoutedOrigin(state));
    if (pinned !== undefined) {
        const back = await waitForProxyVersion(pinned);
        if (back !== undefined) {
            spec.publish(back);
            spec.onEvent("info", `bili-native(${spec.lane}): attach target ${pinned} is healthy again — attached, no second instance spawned`);
            return back;
        }
        spec.onEvent(
            "error",
            explicitAttachOrigin !== undefined
                ? `bili-native(${spec.lane}): explicit attach target ${pinned} unreachable within the health deadline — refusing to spawn a second instance (your declared endpoint stays authoritative). Start your proxy at ${pinned} or unset BILLION_CONTEXT_ATTACH; bili keeps re-checking and self-heals when it comes back.`
                : `bili-native(${spec.lane}): attach target ${pinned} is down and this process's model channel is pinned to it — refusing to spawn a second instance (bili tools would 404 against the other one). Start your proxy at ${pinned} or unset BILLION_CONTEXT_PROXY; bili keeps re-checking and self-heals when it comes back.`,
        );
        state.origin = undefined;
        return undefined;
    }
    spec.onEvent("error", `bili-native(${spec.lane}): attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
    spec.unpublish();
    state.attach = false;
    state.origin = undefined;
    const start = singleFlight(spec.spawnForTest() ?? spec.bootstrap);
    state.respawn = start;
    // Publish whatever origin lands on BOTH the shared state and the env —
    // env readers (compaction reporter, /acp status) must never disagree with
    // what the route resolves, whoever produced the origin.
    const landed = start().then((o) => {
        if (o !== undefined) {
            spec.publish(o);
        }
        return o;
    });
    state.ready = landed;
    return landed;
}
