// #3662: the always-on half of the #3354 compaction gate. bili-native used to
// own BOTH the load-time overlay and the service the four web-profile presets
// inject — so disabling or kill-switching it removed the service and left the
// presets pending forever, bricking session creation. The overlay now lives in
// this separate entry, which has no dependencies of its own and therefore
// activates whenever the bundle patch / launcher overlay is mounted, whatever
// bili-native's state. It registers the transform and provides the gate
// service atomically (the #3354 ordering guarantee survives the split);
// WHETHER the transform actually disables rows is decided per process by the
// verdict bili-native declares — see dsh-compaction-disable.ts.
// #7111/#7117: it also reconciles the presets that were already mounted —
// registered for the verdict declaration (not run on the spot), because the
// one-shot loader callback fires BEFORE the declaration on a real host.
import {
    hostPlaneOverrideLostWarning,
    hostPlaneRowsMissingAutoFalse,
    onDshCompactionDeclared,
    reconcileLoadedPresets,
    registerCompactionDisable,
    type CompactionDisableHost,
} from "./dsh-compaction-disable.js";
import { logHostEvent } from "./host-log.js";

/** What the #7113 scan and the #7111 reconcile need from the host loader.
 *  Deliberately not a hard dependency: an entry-level inject is fail-closed
 *  (no optional dependency, no timeout, no fallback), and a required `loader`
 *  would restore exactly the failure this change removes. */
type LoaderFace = { loader?: { entries?: () => Iterable<unknown> } };

type GateContext = CompactionDisableHost & {
    inject?: (deps: string[], callback: (inner: LoaderFace) => void) => unknown;
};

export const name = "bili-compaction-gate";
export const inject: string[] = [];

/** Boot-time alarm text for a profile whose host-plane override is gone
 *  (null = the declaration survived, or the row is stock-disabled). */
export function hostPlaneWarningFor(inner: LoaderFace): string | null {
    const entries = inner.loader?.entries?.();
    if (entries === undefined) return null;
    const lost = hostPlaneRowsMissingAutoFalse(entries);
    return lost.length === 0 ? null : hostPlaneOverrideLostWarning(lost);
}

export function apply(ctx: GateContext): void {
    registerCompactionDisable(ctx);
    ctx.inject?.(["loader"], (inner) => {
        const warning = hostPlaneWarningFor(inner);
        if (warning !== null) logHostEvent("warn", "bili-compaction-gate", warning);
        // #7117: this callback fires ONCE, and on a real host it runs before
        // bili-native declares the verdict (presets ~140ms, declaration
        // ~960ms) — reconciling on the spot would see an absent verdict and
        // never run again. Register for the declaration instead; entries are
        // re-read at fire time, so presets mounted after the callback are
        // covered too.
        onDshCompactionDeclared(() => {
            reconcileLoadedPresets(inner.loader?.entries?.() ?? []);
        });
    });
}
