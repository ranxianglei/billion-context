import type { CompressionState,  CoreMessage, MessageRefMap } from "./types.js";

// Ref tags render zero-padded to REF_WIDTH digits up to 99,999 ("m00001");
// above that they widen naturally ("m100000" … "m9999999") so every tag ever
// issued below the old cap stays byte-identical while the ceiling lifts
// (acp-kernel#483, the #191-sanctioned fix). REF_WIDTH is a padding floor,
// not a fixed width — indexToRef's padStart is a no-op for indices ≥ 10^5.
const REF_WIDTH = 5;
const MIN_INDEX = 1;
const MAX_INDEX = 9_999_999;
const REF_PATTERN = /^m0*(\d{1,7})$/;

export const BLOCKED_REF = "BLOCKED";

export function emptyRefMap(): MessageRefMap {
  return { byRaw: {}, byRef: {} };
}

export function indexToRef(index: number): string {
  if (!Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX) {
    throw new RangeError(
      `ref index out of bounds: ${index} (allowed ${MIN_INDEX}-${MAX_INDEX})`,
    );
  }
  return `m${String(index).padStart(REF_WIDTH, "0")}`;
}

export function refToIndex(ref: string): number | null {
  const match = REF_PATTERN.exec(ref.trim().toLowerCase());
  if (!match) return null;
  const index = Number(match[1]);
  if (index < MIN_INDEX || index > MAX_INDEX) return null;
  return index;
}

export function refForRaw(map: MessageRefMap, rawId: string): string | null {
  return map.byRaw[rawId] ?? null;
}

/** Canonical DISPLAY order for a positional ref pair. Direction is
 *  notational — resolveBoundaries swaps reversed pairs, so both orders select
 *  the same region and rendering may canonicalize to ascending numeric order.
 *  Under non-monotonic refs (client history rewrite #1001, subagent
 *  interleaving) a positional span's endpoint labels can be numerically
 *  descending; printing them as-is reads as a malformed range, and copy-
 *  pasted reversed pairs trip validators that reject startId > endId (#2168).
 *  Pairs with an unparseable side ("BLOCKED", bN specs) pass through. */
export function orderedRefPair(
  startRef: string,
  endRef: string,
): [string, string] {
  const a = refToIndex(startRef);
  const b = refToIndex(endRef);
  if (a !== null && b !== null && b < a) return [endRef, startRef];
  return [startRef, endRef];
}

export function rawForRef(map: MessageRefMap, ref: string): string | null {
  return map.byRef[ref] ?? null;
}

export interface AssignRefsResult {
  map: MessageRefMap;
  nextIndex: number;
  newlyAssigned: number;
  /** Ids whose stale BLOCKED entry migrated to a fresh numeric ref this pass
   *  (#2607). The caller defers their carrier re-render (#3939 ②/#3805). */
  migratedIds: string[];
}

export interface AssignRefsOptions {
  existing: MessageRefMap;
  nextIndex: number;
  isProtected?: (message: CoreMessage) => boolean;
  shouldSkip?: (message: CoreMessage) => boolean;
}

export function assignRefs(
  messages: CoreMessage[],
  options: AssignRefsOptions,
): AssignRefsResult {
  const map: MessageRefMap = {
    byRaw: { ...options.existing.byRaw },
    byRef: { ...options.existing.byRef },
  };
  let cursor =
    Number.isInteger(options.nextIndex) && options.nextIndex >= MIN_INDEX
      ? options.nextIndex
      : MIN_INDEX;
  let newlyAssigned = 0;
  const migratedIds: string[] = [];

  // #3945: a BLOCKED binding is keyed by id but SHARED by every message
  // carrying that id, while protection is decided per message. Migrating the
  // binding the moment ONE sibling loses protection would re-tag a
  // still-protected sibling's already-sent bytes. Migration requires that NO
  // message with that id is protected this pass.
  const siblingProtected = new Set<string>();
  for (const message of messages) {
    if (!message.id || options.shouldSkip?.(message)) continue;
    if (options.isProtected?.(message)) siblingProtected.add(message.id);
  }

  for (const message of messages) {
    if (!message.id || options.shouldSkip?.(message)) continue;

    const protectedNow = options.isProtected?.(message) ?? false;
    const prev = map.byRaw[message.id];
    if (prev) {
      // Stale BLOCKED entries migrate to a fresh numeric ref once protection
      // is lifted (#2607: #1188 pinned all media; archivable images now fold
      // and must be citable via decompress({ imageRef })). Fresh number only —
      // the id-never-reused contract holds.
      if (
        prev === BLOCKED_REF &&
        !protectedNow &&
        !siblingProtected.has(message.id)
      ) {
        delete map.byRaw[message.id];
        migratedIds.push(message.id);
      } else continue;
    }

    if (protectedNow) {
      map.byRaw[message.id] = BLOCKED_REF;
      continue;
    }

    // #4316 layer 3: store-served views stamp ledgerSeq — the unified
    // transcript position, assigned once and never re-minted. The ref IS the
    // ledger number (direct display), so byte churn cannot renumber
    // citations. Collisions (should be impossible — (session, seq) is a PK)
    // fall through to the counter path; the cursor advances past the stamp so
    // later counter-allocated refs never collide with future stamps either.
    const ledgerSeq: number | undefined = message.ledgerSeq;
    if (
      typeof ledgerSeq === "number" &&
      Number.isInteger(ledgerSeq) &&
      ledgerSeq >= MIN_INDEX &&
      ledgerSeq <= MAX_INDEX
    ) {
      const text = indexToRef(ledgerSeq);
      if (!map.byRef[text]) {
        map.byRaw[message.id] = text;
        map.byRef[text] = message.id;
        newlyAssigned++;
        if (ledgerSeq >= cursor) cursor = ledgerSeq + 1;
        continue;
      }
    }

    const ref = allocateFreeRef(map, cursor);
    cursor = ref.index + 1;
    map.byRaw[message.id] = ref.text;
    map.byRef[ref.text] = message.id;
    newlyAssigned++;
  }

  return { map, nextIndex: cursor, newlyAssigned, migratedIds };
}

function allocateFreeRef(
  map: MessageRefMap,
  start: number,
): { text: string; index: number } {
  let candidate = Math.max(start, MIN_INDEX);
  while (candidate <= MAX_INDEX) {
    const text = indexToRef(candidate);
    if (!map.byRef[text]) {
      return { text, index: candidate };
    }
    candidate++;
  }
  throw new Error(
    `ref capacity exhausted: cannot allocate beyond ${indexToRef(MAX_INDEX)}`,
  );
}

export function rebuildRefIndex(map: MessageRefMap): MessageRefMap {
  const byRef: Record<string, string> = {};
  for (const [rawId, ref] of Object.entries(map.byRaw)) {
    if (ref !== BLOCKED_REF) byRef[ref] = rawId;
  }
  return { byRaw: { ...map.byRaw }, byRef };
}

export interface RefRestampOutcome {
  /** Row-backed refs that already equalled seq+1 — untouched. */
  kept: number;
  /** Row-backed refs re-pointed onto seq+1. */
  restamped: number;
  /** Unbacked refs displaced by a stamp and re-homed onto fresh numbers. */
  rehomed: number;
  /** BLOCKED entries — protected messages keep taking no number. */
  blocked: number;
  /** Old ref → rawId for EVERY mapping that changed hands. Hosts keep this
   *  for the process lifetime so a compress call replaying pre-restart refs
   *  (a resent in-flight tool call) is honestly rejected instead of silently
   *  folding whatever message now owns the number. */
  superseded: Map<string, string>;
}

/** #4316 layer 3 PR3/3 — align the existing citation space with the unified
 *  ledger, exactly once per state. The counter path numbers messages in
 *  arrival order but skips protected messages (BLOCKED takes no number) while
 *  the store still gives them a row seq, so refs minted after a protected
 *  message drift ahead of seq+1; edits and churn widen the gap. After this
 *  call every row-backed, currently-mapped raw id holds ref = seq+1 — the
 *  same numbers the stamped lanes (assignRefs' ledgerSeq path) mint — so the
 *  model citation space and the storage truth agree and churn cannot renumber
 *  citations anymore.
 *
 *  Scope honesty: raw ids with NO current mapping are left to assignRefs (the
 *  stamp path aligns them on next sight); BLOCKED entries stay BLOCKED; dead
 *  refs stay reserved; an unbacked ref displaced by a stamp is re-homed onto a
 *  fresh number (the id-never-reused contract holds — it keeps A ref). */
export function restampRefsToLedger(
  state: CompressionState,
  seqByRawId: Map<string, number>,
): RefRestampOutcome {
  const out: RefRestampOutcome = {
    kept: 0,
    restamped: 0,
    rehomed: 0,
    blocked: 0,
    superseded: new Map(),
  };
  if (state.refLedgerAligned === true) return out;
  const refs = state.messageRefs;
  if (!refs || !refs.byRaw || !refs.byRef) return out;

  // Scratch copies — the state is swapped only after the full pass computes
  // without throwing (a mid-way failure must not leave a half-renumbered map).
  const byRaw: Record<string, string> = { ...refs.byRaw };
  const byRef: Record<string, string> = { ...refs.byRef };
  const scratch: MessageRefMap = { byRaw, byRef };
  const displaced: string[] = [];
  // MessageRefMap carries no cursor field — the caller recomputes it from the
  // highest used index (compress.ts:1047 pattern). We still track a local
  // cursor for free-number allocation during this pass.
  let nextIndex = highestUsedIndex(refs) + 1;

  for (const [rawId, seq] of seqByRawId) {
    const current = byRaw[rawId];
    // Unmapped ids (never rendered, or already dead) are assignRefs'
    // business, not ours.
    if (current === undefined) continue;
    if (current === BLOCKED_REF) {
      out.blocked++;
      continue;
    }
    const targetIndex = seq + 1;
    if (targetIndex < MIN_INDEX || targetIndex > MAX_INDEX) continue;
    const target = indexToRef(targetIndex);
    if (current === target) {
      out.kept++;
      if (targetIndex + 1 > nextIndex) nextIndex = targetIndex + 1;
      continue;
    }
    const occupant = byRef[target];
    if (occupant !== undefined && occupant !== rawId) displaced.push(occupant);
    if (byRef[current] === rawId) delete byRef[current];
    out.superseded.set(current, rawId);
    byRaw[rawId] = target;
    byRef[target] = rawId;
    out.restamped++;
    if (targetIndex + 1 > nextIndex) nextIndex = targetIndex + 1;
  }

  // Displaced occupants lost their number to a stamp — re-home them onto
  // fresh numbers at/after the cursor (never a dead or low reserved number).
  for (const rawId of displaced) {
    const held = byRaw[rawId];
    if (held === undefined) continue;
    if (byRef[held] === rawId) continue;
    const free = allocateFreeRef(scratch, nextIndex);
    out.superseded.set(held, rawId);
    byRaw[rawId] = free.text;
    byRef[free.text] = rawId;
    nextIndex = free.index + 1;
    out.rehomed++;
  }

  state.messageRefs = { byRaw, byRef };
  state.refLedgerAligned = true;
  return out;
}

export function highestUsedIndex(map: MessageRefMap): number {
  let highest = 0;
  for (const ref of Object.values(map.byRaw)) {
    const index = ref === BLOCKED_REF ? null : refToIndex(ref);
    if (index !== null && index > highest) highest = index;
  }
  return highest;
}
