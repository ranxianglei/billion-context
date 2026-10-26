// #2185 (方案 A, 论证见 #2047): bili self-registers into pi-subagents' global
// required-child-extension registry so pi-subagent children load this entry
// DETERMINISTICALLY — foreground children launch with noExtensions:true and
// background runners may disable ambient discovery (agent-def `extensions: []`)
// or drift off it entirely. Required paths land in the resource loader's
// cliEnabledExtensions bucket (additionalExtensionPaths), which loads even
// under noExtensions:true, and feed background launches through the serialized
// runner config.
//
// We do NOT import pi-subagents (peer-dep risk; the registry is a documented
// globalThis contract keyed by Symbol.for). Shape is mirrored byte-for-byte
// against pi-subagents 0.75.x–0.76.x `required-child-extensions.js`:
//   globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")]
//     = { version: 1, bySession: Map<sessionId, frozen [{ id, path }] }>
// One registration per parent session until disposed; a same-session second
// writer yields first-wins (we are a guest — throwing here would break the
// host's session_start). requireForAllRunners is deliberately NOT set:
// external/machine placements keep today's silent-bypass behavior (#2047).
// Any failure degrades to pre-fix behavior (ambient luck), logged once.

import fs from "node:fs";
import path from "node:path";

const REGISTRY_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");
export const SUBAGENT_EXTENSION_ID = "bili";
const MAX_PATH_BYTES = 4096;
const MAX_SESSION_ID_BYTES = 256;

type FrozenEntry = Readonly<{ readonly id: string; readonly path: string }>;
type FrozenSnapshot = readonly FrozenEntry[];

export interface SubagentRegistryRoot {
    version: number;
    bySession: Map<string, unknown>;
}

/** Per-session registration tracked by ONE factory instance (one pi session's
 *  extension load). Separate sessions get separate instances, so in-process
 *  foreground children never evict their parent's entry. */
export interface SubagentSelfRegState {
    sid?: string;
    snapshot?: FrozenSnapshot;
}

interface SelfRegisterOptions {
    env: NodeJS.ProcessEnv;
    agent: string;
    sessionId?: string;
    filePath?: string;
    log: (msg: string) => void;
    /** Test seam: alternate registry host object (defaults to globalThis,
     *  where pi-subagents reads it). */
    registryRoot?: object;
}

function isRegistryRoot(existing: unknown): existing is SubagentRegistryRoot {
    if (!existing || typeof existing !== "object") return false;
    const root = existing as { version?: unknown; bySession?: unknown };
    return root.version === 1 && root.bySession instanceof Map;
}

/** Mirror of pi-subagents' registry(): accept a well-shaped existing store,
 *  create one when absent (a later pi-subagents load accepts it), return null
 *  for anything malformed (never clobber a foreign shape). */
export function resolveSubagentRegistry(globalRoot: object = globalThis): SubagentRegistryRoot | null {
    const g = globalRoot as unknown as Record<symbol, unknown>;
    const existing = g[REGISTRY_KEY];
    if (existing === undefined) {
        const created: SubagentRegistryRoot = { version: 1, bySession: new Map() };
        g[REGISTRY_KEY] = created;
        return created;
    }
    return isRegistryRoot(existing) ? existing : null;
}

function canonicalizeEntryPath(filePath: string): string | undefined {
    try {
        const resolved = fs.realpathSync(path.resolve(filePath));
        if (!fs.statSync(resolved).isFile()) return undefined;
        if (resolved.includes("\u0000")) return undefined;
        if (Buffer.byteLength(resolved, "utf8") > MAX_PATH_BYTES) return undefined;
        return resolved;
    } catch {
        return undefined;
    }
}

function validSessionId(sessionId: string | undefined): sessionId is string {
    return typeof sessionId === "string" && sessionId.length > 0
        && sessionId.trim() === sessionId
        && Buffer.byteLength(sessionId, "utf8") <= MAX_SESSION_ID_BYTES
        && !sessionId.includes("\u0000");
}

/** Register this entry as a required child extension for the given parent
 *  session. Returns a short machine-readable reason; callers log non-"registered*"
 *  outcomes once per session start. Never throws. */
export function selfRegisterForSession(state: SubagentSelfRegState, opts: SelfRegisterOptions): string {
    if (opts.agent !== "pi") return "not-pi";
    // Kill switches mirror pi-native.ts planNativePi: a disabled native lane
    // must not leave required-extension residue behind. Launcher mode
    // (BILI_PROVIDER_REWRITES) is NOT gated — launcher children benefit too.
    if (opts.env.BILLION_CONTEXT_PLUGIN === "0" || opts.env.BILI_NATIVE_PI === "0") return "kill-switch";
    if (!validSessionId(opts.sessionId)) return "no-session-id";
    if (!opts.filePath || typeof opts.filePath !== "string") return "no-entry-path";
    const entryPath = canonicalizeEntryPath(opts.filePath);
    if (entryPath === undefined) return "path-invalid";
    const root = resolveSubagentRegistry(opts.registryRoot ?? globalThis);
    if (root === null) {
        opts.log("subagent registry present but malformed — skipping self-registration (pre-fix behavior)");
        return "registry-malformed";
    }
    const sid = opts.sessionId;
    // Idempotent re-fire (reload/resume of the same session): keep ours.
    if (state.sid === sid && state.snapshot !== undefined && root.bySession.get(sid) === state.snapshot) {
        return "registered-already";
    }
    if (root.bySession.has(sid)) {
        opts.log(`subagent registry already holds another host's entry for this session — yielding first-wins (pre-fix behavior)`);
        return "conflict-first-wins";
    }
    const snapshot: FrozenSnapshot = Object.freeze([Object.freeze({ id: SUBAGENT_EXTENSION_ID, path: entryPath })]);
    root.bySession.set(sid, snapshot);
    state.sid = sid;
    state.snapshot = snapshot;
    return "registered";
}

/** Drop our entry iff we still own it (identity-checked, like pi-subagents'
 *  dispose). Called from session_shutdown. Never throws. */
export function disposeSubagentSelfReg(state: SubagentSelfRegState, globalRoot: object = globalThis): void {
    if (state.sid === undefined || state.snapshot === undefined) return;
    try {
        const root = resolveSubagentRegistry(globalRoot);
        if (root !== null && root.bySession.get(state.sid) === state.snapshot) {
            root.bySession.delete(state.sid);
        }
    } catch {
        // Process teardown path — nothing sensible to do.
    }
    state.sid = undefined;
    state.snapshot = undefined;
}
