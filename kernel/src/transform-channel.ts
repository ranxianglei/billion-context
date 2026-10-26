export type TransformChannel = "message" | "wire";

/**
 * Pick the transform channel: an explicit preference always wins; otherwise
 * the wire channel is used only when the caller's host actually applies the
 * wire-payload replacement (adapters pass `wireViable` — e.g. the body format
 * is in WIRE_FORMATS and the host honors the hook's return value).
 */
export function resolveTransformChannel(
  explicit: TransformChannel | undefined,
  wireViable: boolean,
): TransformChannel {
  return explicit ?? (wireViable ? "wire" : "message");
}
