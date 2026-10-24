import type { CoreMessage, MessageRefMap } from "./types.js";

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
  /**
   * Returns true when a message must NEVER receive a numeric ref — it gets
   * BLOCKED_REF instead (invisible to the advertised compressible set). Pass
   * ONLY the permanently-pinned class (unrecoverable media, statically-
   * protected tools); do NOT pass the demotable latest-per-identity class
   * (#3999): those are numbered at birth so their later demotion inserts zero
   * bytes, and their fold exclusion happens at projection time, not via the
   * ref value.
   */
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

export function highestUsedIndex(map: MessageRefMap): number {
  let highest = 0;
  for (const ref of Object.values(map.byRaw)) {
    const index = ref === BLOCKED_REF ? null : refToIndex(ref);
    if (index !== null && index > highest) highest = index;
  }
  return highest;
}
