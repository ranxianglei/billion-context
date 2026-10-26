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
