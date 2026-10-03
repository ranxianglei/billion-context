// Public host-adapter contract subpath (package.json exports "./contract"):
// multi-session hosts validate/read `<sessionFile>.acp.json` sidecars against
// this shape (docs/host-adapter.md). Stable across releases — see contract.ts.
import blockV1Schema from "./schema/bcp-block-v1.json" with { type: "json" };

export { SIDECAR_SCHEMA_VERSION, sidecarProducer } from "./contract.js";
export type { BcpBlockV1, BcpSidecarV1 } from "./contract.js";

/** The JSON Schema (draft 2020-12) for one persisted block, inlined at build. */
export const BLOCK_V1_SCHEMA = blockV1Schema;
