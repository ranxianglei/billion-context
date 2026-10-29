// Global test-runner baseline for the unified-storage mode (#2815 rollout)
// plus the XDG directory sandbox (#5116).
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

// #5116: sandbox the four XDG base dirs so any suite that forgets to pin them
// resolves paths into a per-run temp root instead of the developer's real
// $HOME (index.db / session envelopes / state files / live config). Unset and
// empty-string values are replaced; an explicitly set value still wins, so
// suites that pin their own mkdtemp homes are untouched. See
// tests/test-sandbox-env.mjs for the full contract + tests/test-sandbox-env.test.ts.
import { sandboxXdgEnv } from "./test-sandbox-env.mjs";

sandboxXdgEnv(process.env);
