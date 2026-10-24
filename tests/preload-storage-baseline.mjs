// Global test-runner baseline for the unified-storage mode (#2815 rollout).
//
// resolveStorageMode() defaults to "full" when neither the env nor the config
// file says anything (#3818 production default flip; the interim #2815-era
// default was "shadow"). The broad wire/e2e corpus, though, was written
// against the legacy default: hundreds of suites build SessionStores in
// mkdtemp dirs and rmSync them without SQLite handle choreography (Windows
// EPERM territory) and some assert index.db absence incidentally. Keep that
// corpus on an explicit legacy baseline; any suite whose assertions depend on
// a specific storage mode MUST pin BILI_STORAGE_UNIFIED itself — relying on
// the production default passes locally but breaks here (#4011 lesson). The
// storage family (tests/storage-*.test.ts, tests/identity-registry.test.ts,
// tests/bounded-storage*.test.ts, tests/export-jsonl.test.ts,
// tests/e2e/e2e-sqlite-bootstrap.test.ts) pins and overrides its own modes,
// and the default's own semantics are covered by the resolveStorageMode
// matrices plus the shadow/full engine proofs.
//
// ??= keeps an explicit shell/CI env authoritative for ad-hoc experiments.
process.env.BILI_STORAGE_UNIFIED ??= "legacy";
