import { BLOCKED_REF } from "./refs.js";
import { RETRIEVED_ID_PREFIX } from "./ccr.js";
import { resolveAbsorbConfig } from "./absorb.js";
import { resolveCcrConfig } from "./ccr.js";
import { resolveCrushConfig } from "./crush.js";
import type { CompressionState, CoreMessage, ViewLatchEntry } from "./types.js";
import type { NodeIO, PipelineNode, PipelineContext } from "./pipeline.js";

/** Stash the post-prune, pre-transform view (#3939 ⑤). The view-latch node
 *  replays latched bytes from this array — the transform nodes have already
 *  dropped or rewritten their targets by the time the latch runs, so the
 *  source-of-truth resent bytes live here. */
export const preTransformSnapshotNode: PipelineNode = {
  name: "pre-transform-snapshot",
  run(io) {
    return {
      ...io,
      effects: { ...io.effects, preTransformMessages: io.messages },
    };
  },
};

/** Fold-gated view latch (#3939 ⑤/#3805): replay post-transform bytes
 *  verbatim on quiet turns; refresh latches only at fold boundaries. Runs
 *  after every opt-in transform node (ccr-store, absorb-hide, crush,
 *  absorb-prompt, filter) and after hide-compress-calls (its own #3784 fold
 *  gate stays authoritative — the latch only records its output), before
 *  recommend/nudge/emergency-truncate/render so downstream nodes judge the
 *  same view the model actually sees. */
export const viewLatchNode: PipelineNode = {
  name: "view-latch",
  run(io, ctx) {
    return applyViewLatch(io, ctx);
  },
};

function latchKeyEqual(
  a: Record<string, ViewLatchEntry> | undefined,
  b: Record<string, ViewLatchEntry> | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (Object.keys(a).length !== Object.keys(b).length) return false;
  for (const [k, v] of Object.entries(a)) {
    const o = b[k];
    if (!o || o.text !== v.text || o.hidden !== v.hidden) return false;
  }
  return true;
}

/** Transform-relevant config slices — a change here is a user action
 *  boundary (①): the latch releases so enable/disable applies immediately
 *  instead of waiting for a fold. tokenCount is deliberately NOT included
 *  (pressure fluctuation is what the latch exists to gate). */
export function viewLatchConfigDigest(ctx: PipelineContext): string {
  return JSON.stringify({
    absorb: resolveAbsorbConfig(ctx.config),
    crush: resolveCrushConfig(ctx.config),
    // CCR rides the same boundary: a session that disarms CCR must never
    // keep projecting latched [acp-stored] placeholders — the retrieve
    // channel they advertise would be gone (dangling placeholder = silent
    // loss, the #1273 plugin-governance contract). A digest change releases
    // the latch and re-judges every message under the CURRENT config.
    ccr: resolveCcrConfig(ctx.config),
    filters: {
      enabled: ctx.config.messageFilters?.enabled ?? false,
      filters: ctx.config.messageFilters?.filters ?? null,
    },
  });
}

export function applyViewLatch(io: NodeIO, ctx?: PipelineContext): NodeIO {
  const pre = io.effects.preTransformMessages;
  if (!pre) return io;
  // Config boundary (#3939 ①/⑤): digest change releases the latch — the
  // transform enable/disable applies this turn (one rewrite riding the user's
  // config edit), never silently later.
  const digest = ctx ? viewLatchConfigDigest(ctx) : undefined;
  const configChanged =
    digest !== undefined && digest !== io.state.viewLatchConfigDigest;
  const prev = configChanged ? undefined : io.state.viewLatches;
  const post = new Map<string, CoreMessage>();
  for (const m of io.messages) if (m.id) post.set(m.id, m);

  const out: CoreMessage[] = [];
  const latches: Record<string, ViewLatchEntry> = {};
  let latchedTransform = false;

  for (const m of pre) {
    if (!m.id || m.id.startsWith(RETRIEVED_ID_PREFIX)) {
      const t = post.get(m.id!);
      if (t) out.push(t);
      continue;
    }
    const ref = io.state.messageRefs.byRaw[m.id];
    if (!ref || ref === BLOCKED_REF) {
      const t = post.get(m.id);
      if (t) out.push(t);
      continue;
    }
    const transformed = post.get(m.id);
    const prevEntry = prev?.[ref];
    if (prevEntry) {
      // REPLAY the latched bytes — a transform's fresh output for an
      // already-latched ref is deferred to the next fold boundary.
      if (prevEntry.hidden) {
        latches[ref] = prevEntry;
        continue;
      }
      if (prevEntry.text === null) {
        if (transformed) out.push(m);
        latches[ref] = prevEntry;
        continue;
      }
      latchedTransform = true;
      if (transformed && transformed.text === prevEntry.text) out.push(transformed);
      else out.push({ ...m, text: prevEntry.text });
      latches[ref] = prevEntry;
    } else {
      // FRESH: latch whatever the transforms produced at this arrival
      // boundary (arrival/first-enable IS a history change; the flip rides it).
      if (!transformed) {
        latches[ref] = { text: null, hidden: true };
        continue;
      }
      if (transformed.text !== m.text) {
        latches[ref] = { text: transformed.text ?? null };
        latchedTransform = true;
        out.push(transformed);
      } else {
        latches[ref] = { text: null };
        out.push(m);
      }
    }
  }

  // Steady state (identical latch map) must not churn the state object and
  // force an adapter save every turn (render-refs snapshot precedent).
  if (
    !configChanged &&
    digest === io.state.viewLatchConfigDigest &&
    latchKeyEqual(io.state.viewLatches, latches)
  ) {
    return { ...io, messages: out };
  }
  // No prior latches and every entry passthrough → nothing worth pinning
  // (no opt-in transform active); skip the write entirely.
  if (!prev && !latchedTransform) return io;
  return {
    ...io,
    messages: out,
    state: {
      ...io.state,
      viewLatches: latches,
      ...(digest !== undefined ? { viewLatchConfigDigest: digest } : {}),
    },
  };
}

/** #3939 ⑤: a successful fold rewrote history — the latch refresh rides it. */
export function resetViewLatches(state: CompressionState): CompressionState {
  if (state.viewLatches === undefined) return state;
  return { ...state, viewLatches: undefined };
}
