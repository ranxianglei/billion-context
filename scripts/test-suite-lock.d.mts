interface LockRecord {
    pid: number;
    ts: number;
    cmdline?: string;
    cwd?: string;
}
interface AcquireResult {
    acquired: boolean;
    holder: LockRecord | null;
}
export function resolveLockPath(env?: NodeJS.ProcessEnv): string;
export function readLock(lockPath: string): Promise<LockRecord | null>;
export function isAlive(pid: number): boolean;
export const STALE_LOCK_MS: number;
export function holderIsStale(holder: LockRecord, now?: number): boolean;
export function staleStealMessage(holder: LockRecord, lockPath: string, now?: number): string;
export function forceEnabled(env?: NodeJS.ProcessEnv): boolean;
export function formatAge(msAgo: number): string;
export function blockedMessage(holder: LockRecord, lockPath: string, now?: number): string;
export function acquireLock(
    lockPath: string,
    meta: { pid: number; cmdline?: string; cwd?: string },
): Promise<AcquireResult>;
export function releaseLock(lockPath: string, myPid: number): Promise<void>;
export function releaseLockSync(lockPath: string, myPid: number): void;
export function listTestFiles(root?: string): string[];
