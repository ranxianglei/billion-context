import type { CoreMessage } from "acp-kernel";

/** The one canonical Responses separator literal. Text or shape alone never
 * proves producer ownership; the ordering module separately binds identity. */
export const RESPONSES_TURN_SEPARATOR = "[The exchange between these two assistant turns was compressed.]";

/**
 * Validate the canonical serialized shape at an already-owned index: exactly
 * `type`, `role`, and string `content`, with no extra fields or array content.
 * This check validates a provenance claim; it never establishes ownership.
 */
export function isSeparatorCarrier(item: unknown, text: string = RESPONSES_TURN_SEPARATOR): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  if (Object.keys(record).length !== 3) return false;
  return record["type"] === "message" && record["role"] === "user" && record["content"] === text;
}

/**
 * Shape-only test used after separator ownership became UNKNOWN through an
 * opaque rewrite. It suppresses only the narrow ownership verdict after exact
 * fidelity matching; it must never grant ownership or a standalone exemption.
 */
export function isSeparatorCoreShaped(core: CoreMessage, text: string = RESPONSES_TURN_SEPARATOR): boolean {
  return core.role === "user" && core.contentType === "text" && core.text === text;
}

/** Translate owned wire indexes to a core list parsed from that SAME wire.
 * `responsesToCore` stamps `wireIndex`; cores from other protocols never match. */
export function separatorCoreProvenance(
  ownedWireIndexes: ReadonlySet<number>,
  cores: readonly CoreMessage[] | null | undefined,
): ReadonlySet<number> {
  const owned = new Set<number>();
  if (ownedWireIndexes.size === 0 || !Array.isArray(cores)) return owned;
  for (let index = 0; index < cores.length; index++) {
    const wireIndex = cores[index]!.wireIndex;
    if (wireIndex !== undefined && ownedWireIndexes.has(wireIndex)) owned.add(index);
  }
  return owned;
}
