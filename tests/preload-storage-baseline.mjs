// Global test-runner baseline for the unified-storage mode (#2815 rollout).
//
// resolveStorageMode() now defaults to "shadow" when neither the env nor the
// config file says anything (production default flip). The broad wire/e2e
// corpus, though, was written against the legacy default: hundreds of suites
// build SessionStores in mkdtemp dirs and rmSync them without SQLite handle
// choreography (Windows EPERM territory) and some assert index.db absence
// incidentally. Keep that corpus on an explicit legacy baseline; the storage
// family (tests/storage-*.test.ts, tests/identity-registry.test.ts,
// tests/bounded-storage*.test.ts, tests/export-jsonl.test.ts,
// tests/e2e/e2e-sqlite-bootstrap.test.ts) pins and overrides its own modes,
// and the default's own semantics are covered by the resolveStorageMode
// matrices plus the shadow/full engine proofs.
//
// ??= keeps an explicit shell/CI env authoritative for ad-hoc experiments.
process.env.BILI_STORAGE_UNIFIED ??= "legacy";

// Default-dir sandbox. Suites that build stores/servers WITHOUT pinning a
// directory resolve through the XDG defaults into the developer's REAL
// ~/.local/{share,state,cache}/billion-context: envelopes, index.db rows,
// state bookkeeping (rollout-id, prefix-affinity, proxy-origin) and caches
// land beside production data (found while triaging #5082 — a local run of
// tests/anthropic-cache-control.test.ts wrote `sess-1639-*` rows and
// sessions/anthropic/127.0.0.1_* envelopes into the live sessions dir; the
// legacy baseline above stops the SQLite rows but NOT those files). Point the
// defaults at a per-run temp tree instead. ||= keeps a non-empty explicit
// environment authoritative (empty counts as unset, matching the XDG handling
// in scripts/test-suite-lock.mjs): CI containers and tests that pin their own
// XDG_* win unchanged, and setting the three vars yourself deliberately
// re-attaches a run to the real machine state.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sandboxRoot = mkdtempSync(path.join(tmpdir(), "bili-test-dirs-"));
process.env.XDG_DATA_HOME ||= path.join(sandboxRoot, "data");
process.env.XDG_STATE_HOME ||= path.join(sandboxRoot, "state");
process.env.XDG_CACHE_HOME ||= path.join(sandboxRoot, "cache");
