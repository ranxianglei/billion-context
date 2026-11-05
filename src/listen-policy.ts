/**
 * EADDRINUSE retry policy for the proxy's own listen socket (#407/#964/#1723/#3044).
 * Pure decision table extracted from the server's 'error' handler so every
 * branch can be pinned without booting a server.
 *
 * #3044: a self-restart replacement must own EXACTLY the port its predecessor
 * freed. Hopping +1 strands it serving no client while the prior instance
 * keeps holding the real port — the orphan-leak shape reported in #3044. It
 * gets the bounded same-port predecessor wait (#1723 overlap: slow release),
 * then fails fast instead of laddering.
 *
 * #3044 follow-up: a live holder running OUR build on the same lane is a
 * twin, not a predecessor — nothing is draining, so the newcomer exits loudly
 * instead of hopping (the duplicate loses; the serving instance keeps serving
 * and the next launch attaches to it). Applies to marked AND unmarked spawns.
 *
 * #4125: a holder that PROVES itself a strictly NEWER same-lane build is
 * neither twin nor predecessor — nothing is draining there either, so no wait
 * or ladder variant may touch the port (laddering would fork the lane into a
 * dual instance behind a port nobody routes to anymore). The newcomer exits
 * with the adoption signal (#3654 code 3) so its spawner rides the newer one
 * instead of deadlocking behind it (#3544 reverse: an older generation can't
 * attach and rotation only reaches strictly OLDER residents).
 */
/** Internal spawn-channel env set by performSelfRestart onto its replacement
 *  (#3044): the marked process must bind-or-die on exactly the freed port. */
export const UPGRADE_REPLACEMENT_ENV = "BILI_UPGRADE_REPLACEMENT";

/** #3654: the exit code a twin-collision loser reports to its spawner. The
 *  duplicate still LOSES (#3044 — it cannot bind the port the serving twin
 *  holds), but the code says WHY it died: the spawner reads it as an adopt
 *  signal and attaches to the serving twin instead of failing the bring-up —
 *  closing the #3654 contradiction where discovery judged the holder dead
 *  (busy) while the twin rule proved it alive. Every other listen failure
 *  keeps exit 1. */
export const TWIN_ADOPT_EXIT_CODE = 3;

export type FailFastReason = "upgrade-replacement" | "strict-port" | "port-busy" | "twin-collision";

/** Pure exit-code mapping for a terminal EADDRINUSE decision — extracted so
 *  the server (which calls process.exit) and its tests share one definition
 *  without booting a listener (#3654). */
export function eaddrinuseExitCode(reason: FailFastReason | undefined): number {
    return reason === "twin-collision" ? TWIN_ADOPT_EXIT_CODE : 1;
}

type EaddrinuseAction =
    | { kind: "wait-predecessor"; port: number }
    /** nextPort 0 = ask the OS for an ephemeral port (ladder exhausted). */
    | { kind: "ladder"; nextPort: number }
    | { kind: "fail-fast"; reason: "upgrade-replacement" | "strict-port" | "port-busy" | "twin-collision" };

export interface EaddrinuseContext {
    /** #3044: this process is a self-restart replacement (BILI_UPGRADE_REPLACEMENT). */
    upgradeReplacement: boolean;
    /** #3044 follow-up: a live same-lane instance running our build holds the port. */
    twinHolds: boolean;
    /** #4125: a strictly NEWER same-lane build (verified by live health
     *  version, not just the registry claim) holds the port. */
    newerHolderHolds: boolean;
    launchToken: boolean;
    strictPort: boolean;
    attempts: number;
    maxAttempts: number;
    predecessorTicksLeft: number;
    predecessorHolds: boolean;
    lastTriedPort: number;
}

export function decideEaddrinuse(ctx: EaddrinuseContext): EaddrinuseAction {
    // The twin rule outranks everything else: a healthy peer already serves
    // real traffic on that port, so no wait/ladder variant may touch it — the
    // newcomer dies loudly regardless of its own spawn rights. Same verdict for
    // a strictly NEWER holder (#4125): riding it is the spawner's job via the
    // adoption signal below, and waiting/laddering only strands traffic in the
    // classic two-install deadlock (older lane can't attach; #3544 rotation
    // only reaches strictly older residents).
    if (ctx.twinHolds || ctx.newerHolderHolds) return { kind: "fail-fast", reason: "twin-collision" };
    if (ctx.upgradeReplacement) {
        if (ctx.predecessorTicksLeft > 0 && ctx.predecessorHolds) {
            return { kind: "wait-predecessor", port: ctx.lastTriedPort };
        }
        return { kind: "fail-fast", reason: "upgrade-replacement" };
    }
    if (!ctx.launchToken || ctx.strictPort || ctx.attempts >= ctx.maxAttempts) {
        return { kind: "fail-fast", reason: ctx.strictPort ? "strict-port" : "port-busy" };
    }
    if (ctx.predecessorTicksLeft > 0 && ctx.predecessorHolds) {
        return { kind: "wait-predecessor", port: ctx.lastTriedPort };
    }
    const nextAttempts = ctx.attempts + 1;
    return { kind: "ladder", nextPort: nextAttempts === ctx.maxAttempts ? 0 : ctx.lastTriedPort + 1 };
}

/** #3044/#2941: ladder rights for the POST-BIND claim check (port-owner's
 *  resolvePortClaim). A launcher-spawned child that finds a foreign live
 *  listener on its just-bound port may move +1 off the contested port (#2941);
 *  strict-port and manual launches never did. A marked upgrade replacement must
 *  not either, even though it inherits its parent's launch token: hopping is
 *  exactly the orphan shape #3044 kills, and this is the second path where a
 *  replacement could hop — on socket semantics that tolerate a concurrent bind
 *  onto an actively-listening port, a successful bind does not exclude the
 *  still-draining predecessor or a racing host respawn (#707/libuv#1360). */
export function postBindCanLadder(hasLaunchToken: boolean, strictPort: boolean, upgradeReplacement: boolean): boolean {
    return hasLaunchToken && !strictPort && !upgradeReplacement;
}

/** Windows reports a bind collision with a listener held on ANOTHER address
 *  family as WSAEACCES, not WSAEADDRINUSE: an IPv6 wildcard listener makes the
 *  IPv4 bind of the same port fail with EACCES even though the port is well
 *  above the privileged range. Left untreated, a launcher-spawned child dies
 *  with the misleading "port N requires privileges. Use a port >= 1024" hint
 *  instead of laddering off the squatted zone port (#1660). Privileged-port
 *  EACCES (below 1024) stays a real permission error. */
export function isPortBusyError(code: string | undefined, port: number, platform: NodeJS.Platform = process.platform): boolean {
    if (code === "EADDRINUSE") return true;
    return platform === "win32" && code === "EACCES" && port >= 1024;
}
