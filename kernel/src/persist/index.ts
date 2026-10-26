/**
 * Persistence subpath: crash-safe JSON state storage for downstream hosts.
 *
 * The kernel core is pure (no fs). This subpath is the ONLY kernel module
 * that touches the filesystem, so hosts that never persist stay fs-free by
 * not importing `acp-kernel/persist`.
 *
 * Division of responsibility:
 * - store owns MECHANISM: atomic writes, rename retries, debounce,
 *   serialization, discovery, corrupt-file tolerance
 * - downstream owns POLICY: storage location (dir is a constructor
 *   argument — the kernel has no default path), schema version, payload
 *   shape, validation, and lifecycle (when to save, what to load)
 * - the store never deletes files; cleanup is a downstream decision
 */
export { StateStore, flatFileNameFor } from "./store.js";
export type {
  PersistedEnvelope,
  PersistLogger,
  StateStoreCodec,
  StateStoreOptions,
} from "./store.js";
export { mergeCompressionState } from "./state-merge.js";
