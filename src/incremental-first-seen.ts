/** Host-only recovery journal for timestamps not yet covered by canonical rows.
 * Values originate in the kernel's timestamp map, never in client headers. */
import { createHash } from 'node:crypto';
export const FIRST_SEEN_KEY = "inc:first-seen-pending";
const requests = new WeakSet<object>();
const committed = new WeakSet<object>();
const retries = new WeakMap<StampStore, Map<string, Stamps>>();
/** Process-local authority: an external header cannot impersonate this marker. */
export function markFirstSeenRequest(request: object): void { requests.add(request); }
export function isFirstSeenRequest(request: object): boolean { return requests.has(request); }
export function commitFirstSeenRequest(request: object): void { committed.add(request); }
export function isFirstSeenCommitted(request: object): boolean { return committed.has(request); }
export interface StampStore {
    getSessionExt(sessionId: string, key: string): unknown;
    setSessionExt(sessionId: string, key: string, value: unknown): void;
    deleteSessionExt?(sessionId: string, key: string): number;
    listSessionExt?(sessionId: string): { key: string; value: unknown }[];
    withSessionExtTransaction?<T>(action: () => T): T;
}
type Stamps = Record<string, number>;
type StampedIdentity = { id: string; ts?: number };

function read(store: StampStore, sessionId: string): Stamps {
    const value = store.getSessionExt(sessionId, FIRST_SEEN_KEY);
    if (value === undefined) return Object.create(null);
    if (value && typeof value === 'object' && Reflect.get(value, 'version') === 2) {
        const chunks: unknown = Reflect.get(value, 'chunks');
        if (!Array.isArray(chunks) || !chunks.every(key => typeof key === 'string' && /^inc:first-seen:[a-f0-9]{64}$/.test(key)) || new Set(chunks).size !== chunks.length) throw new Error('Invalid first-seen manifest');
        const result: Stamps = Object.create(null);
        for (const key of chunks) {
            const chunk = store.getSessionExt(sessionId, key);
            if (typeof chunk !== 'string' || key !== `inc:first-seen:${createHash('sha256').update(chunk).digest('hex')}`) throw new Error('Missing or changed first-seen chunk');
            const entries: unknown = JSON.parse(chunk);
            if (!Array.isArray(entries)) throw new Error('Invalid first-seen chunk');
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || !Number.isSafeInteger(entry[1]) || entry[1] < 0 || Object.hasOwn(result, entry[0])) throw new Error('Invalid first-seen chunk entry');
                result[entry[0]] = entry[1];
            }
        }
        return result;
    }
    if (!value || typeof value !== "object" || Reflect.get(value, "version") !== 1) throw new Error("Invalid first-seen journal");
    const stamps: unknown = Reflect.get(value, "stamps");
    if (!stamps || typeof stamps !== "object" || Array.isArray(stamps)) throw new Error("Invalid first-seen stamps");
    const result: Stamps = Object.create(null);
    for (const [id, stamp] of Object.entries(stamps)) {
        if (!id || !Number.isSafeInteger(stamp) || stamp < 0) throw new Error("Invalid first-seen entry");
        result[id] = stamp;
    }
    return result;
}

function write(store: StampStore, sessionId: string, stamps: Stamps): void {
    writeChunks(store, sessionId, stamps);
    if (store.withSessionExtTransaction) collectChunks(store, sessionId);
}

function transact<T>(store: StampStore, action: () => T): T {
    return store.withSessionExtTransaction ? store.withSessionExtTransaction(action) : action();
}

function collectChunks(store: StampStore, sessionId: string): void {
    if (!store.listSessionExt || !store.deleteSessionExt) return;
    const manifest = store.getSessionExt(sessionId, FIRST_SEEN_KEY);
    const keys: unknown = manifest && typeof manifest === 'object' ? Reflect.get(manifest, 'chunks') : undefined;
    const retained = new Set(Array.isArray(keys) ? keys : []);
    for (const { key } of store.listSessionExt(sessionId)) {
        if (/^inc:first-seen:[a-f0-9]{64}$/.test(key) && !retained.has(key)) store.deleteSessionExt(sessionId, key);
    }
}

function writeChunks(store: StampStore, sessionId: string, stamps: Stamps): void {
    const previous = store.getSessionExt(sessionId, FIRST_SEEN_KEY);
    const previousChunks: unknown = previous && typeof previous === 'object' ? Reflect.get(previous, 'chunks') : undefined;
    const chunks: string[] = [];
    let entries: [string, number][] = [];
    let bytes = 2;
    const flush = (): void => {
        if (!entries.length) return;
        const encoded = JSON.stringify(entries);
        const key = `inc:first-seen:${createHash('sha256').update(encoded).digest('hex')}`;
        const existing = store.getSessionExt(sessionId, key);
        if (existing !== undefined && existing !== encoded) throw new Error('First-seen chunk collision');
        if (existing === undefined) store.setSessionExt(sessionId, key, encoded);
        chunks.push(key);
        entries = [];
        bytes = 2;
    };
    for (const entry of Object.entries(stamps)) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (size > 256 * 1024) throw new Error('First-seen identity exceeds chunk budget');
        if (bytes + size > 256 * 1024) flush();
        entries.push(entry);
        bytes += size;
    }
    flush();
    // Immutable chunks precede the sole atomic publication point. A failed
    // chunk or manifest write leaves the prior readable manifest untouched.
    store.setSessionExt(sessionId, FIRST_SEEN_KEY, { version: 2, chunks });
    // Publish first, then remove only chunks owned by the replaced manifest.
    // Cleanup failure costs space, never invalidates the committed receipt.
    if (Array.isArray(previousChunks) && store.deleteSessionExt) {
        const retained = new Set(chunks);
        for (const key of previousChunks) {
            if (typeof key === 'string' && /^inc:first-seen:[a-f0-9]{64}$/.test(key) && !retained.has(key)) {
                try { store.deleteSessionExt(sessionId, key); } catch { /* retain unreferenced bytes */ }
            }
        }
    }
}

/** Stage a complete validated merge before the caller changes session state. */
export function recoveredFirstSeen(store: StampStore, sessionId: string, current: Stamps | undefined): Stamps {
    const recover = (): Stamps => {
        const pending = read(store, sessionId);
        collectChunks(store, sessionId);
        return pending;
    };
    // Publication and collection share the SQLite write transaction; another
    // writer cannot publish a manifest referencing a chunk being collected.
    const pending = store.withSessionExtTransaction ? store.withSessionExtTransaction(recover) : read(store, sessionId);
    // The kernel's persisted/current timestamp remains authoritative.
    return { ...pending, ...current };
}

/** Call before a successful applied-seq acknowledgement. Throws on failed commit. */
export function rememberFirstSeen(store: StampStore, sessionId: string, added: readonly StampedIdentity[], stamps: Stamps | undefined): void {
    let sessions = retries.get(store);
    if (!sessions) { sessions = new Map(); retries.set(store, sessions); }
    const staged = { ...sessions.get(sessionId) };
    for (const message of added) {
        const stamp = stamps?.[message.id];
        if (stamp !== undefined) Object.defineProperty(staged, message.id, { value: stamp, enumerable: true, configurable: true, writable: true });
    }
    sessions.set(sessionId, staged);
    transact(store, () => {
    const pending = read(store, sessionId);
    let changed = false;
    for (const [id, stamp] of Object.entries(staged)) {
        if (stamp === undefined) continue; // Timestamp feature may be disabled.
        if (!Number.isSafeInteger(stamp) || stamp < 0) throw new Error("Invalid kernel first-seen value");
        if (Object.hasOwn(pending, id) && pending[id] !== stamp) throw new Error("Conflicting pending first-seen value");
        if (!Object.hasOwn(pending, id)) {
            pending[id] = stamp;
            changed = true;
        }
    }
    if (changed) write(store, sessionId, pending);
    });
    // Keep retry state until COMMIT itself has succeeded too.
    sessions.delete(sessionId);
}

/** Only exact timestamp-bearing rows independently read from SQLite qualify. */
export function forgetSettledFirstSeen(store: StampStore, sessionId: string, confirmed: readonly StampedIdentity[]): void {
    transact(store, () => {
        const pending = read(store, sessionId);
        let changed = false;
        for (const message of confirmed) {
            if (Object.hasOwn(pending, message.id) && pending[message.id] === message.ts) {
                delete pending[message.id];
                changed = true;
            }
        }
        if (changed) write(store, sessionId, pending);
    });
    const sessions = retries.get(store);
    const staged = sessions?.get(sessionId);
    if (staged) {
        for (const message of confirmed) {
            if (Object.hasOwn(staged, message.id) && staged[message.id] === message.ts) delete staged[message.id];
        }
        if (!Object.keys(staged).length) sessions!.delete(sessionId);
    }
}
