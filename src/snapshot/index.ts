/**
 * #5874 — snapshot-table compression foundation: public barrel.
 *
 * The module is the server's single storage source of truth for the
 * full-resend lane (proposal §4). It is deliberately self-contained: it
 * depends only on kernel public types (CoreMessage) and the storage layer's
 * structural row shapes — never on the legacy prepare path — so the legacy
 * path stays untouched and the A/B byte-parity test (T4) has an honest
 * oracle.
 *
 * Six stages (proposal §0):
 *   0  identity      — world match / issue / probe / resync (identity.ts)
 *   1  protocol      — span parse (reuses the kernel's wire codec)
 *   2  rewrite       — kernel compression (zero kernel change; the events are
 *                      derived by reconcile.ts from the kernel's pipeline
 *                      evidence: the blocks, the summary cores, the view)
 *   3  snapshot      — the commit primitive (storage commitSnapshot) +
 *                      checkpoint fold
 *   4  egress        — mapEgress = active rows by pos ++ fresh tail
 *                      (egress.ts), then coreToX
 *   5  outbound      — tripwire sample (lane.ts) + the existing relay
 */
export { sha256hex, canonicalJson, envelopeChecksum, rowPostChecksum, s4Aggregate, stateChecksum } from "./checksums.ts";
export { matchWorld } from "./identity.ts";
export { reconcile } from "./reconcile.ts";
export { buildEgressView } from "./egress.ts";
export { hydratePlane, parseEnvelope } from "./hydrate.ts";
export type { HydrateWorld, HydrateRow, HydrateCkpt } from "./hydrate.ts";
export { decideSnapshotLane } from "./lane.ts";
export type { SnapshotLaneDecision } from "./lane.ts";
export type {
    SnapEventKind,
    SnapEvent,
    WorldMode,
    WorldDecision,
    CheckpointMeta,
    PlaneHealth,
    PlaneState,
    SnapshotRowView,
    RedGate,
    DecisionToken,
    ReconcileInput,
    ReconcileOutput,
    EgressInput,
    EgressOutput,
} from "./types.ts";
