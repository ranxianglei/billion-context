/** Canonicalization lives in src/storage/canonical.ts (shared with the
 *  shadow dry-run reconciler); re-exported here so golden/corpus tests and
 *  the shadow agree byte-for-byte. */
export { canonicalize, sha256 } from "../src/storage/canonical.ts";
import { canonicalize, sha256 } from "../src/storage/canonical.ts";

/** Canonical JSON → sha256, with a final pass of STRING-level environment
 *  normalization (ports, session ids embedded inside text fields). */
function digestOf(value: unknown, extra?: { normalize?: (s: string) => string }): string {
    let text = JSON.stringify(canonicalize(value));
    if (extra?.normalize) text = extra.normalize(text);
    return sha256(text);
}
