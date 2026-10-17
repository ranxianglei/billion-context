// #3224: three-way provenance detection for dsh profile copies of billion-context.
//
// The manifest declaration (profile package.json spec), the lockfile resolution
// (pnpm-lock.yaml / package-lock.json) and the on-disk copy version are three
// independent records of the same fact — what this profile actually runs. No
// other code cross-checks them: self-heal targets come from the registry
// (fetchRegistryVersion), so a copy that is NOT above the target passes every
// one-way semver gate while the manifest beside it can still carry a spec no
// install ever resolved (#3160 residual: ^1.2.9 left beside a lockfile that
// resolves 0.1.196 → the next 'pnpm install' 404s, and nothing said so).
//
// DETECTION ONLY: reads state, warns loudly. Never installs, writes or spawns —
// stays out of the single-writer contract and out of src/update.ts's human-gated
// territory (no §5 no-op release prerequisite). The "copy above registry" face
// is #3164's advisory; the two are complementary and non-overlapping.

import fs from "node:fs";
import path from "node:path";
import { DSH_DESKTOP_PROFILE, DSH_PACKAGE, dshProfileDirs, dshProfileDepSpec, isRegistryDepSpec } from "./dsh-channel.js";
import type { Logger } from "./logger.js";

type ProvenanceFindingKind = "copy-vs-lock" | "manifest-vs-lock" | "copy-vs-manifest";

interface ProvenanceFinding {
    profile: string;
    kind: ProvenanceFindingKind;
    copyVersion: string;
    /** Set when the finding concerns a lockfile-recorded resolution. */
    lockVersion?: string;
    spec: string;
    /** One-sentence, human-ready description carrying the remediation. */
    detail: string;
}

interface LockResolution {
    specifier?: string;
    version?: string;
}

function readJsonFile(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

function readCopyVersion(profileDir: string): string | undefined {
    const doc = readJsonFile(path.join(profileDir, "node_modules", DSH_PACKAGE, "package.json")) as
        | { version?: unknown }
        | undefined;
    return typeof doc?.version === "string" ? doc.version : undefined;
}

/** Strip YAML scalar quoting pnpm may apply to some values. */
function unquote(v: string): string {
    return v.replace(/^["']|["']$/g, "");
}

const PKG_RE = new RegExp(`^\\s+${DSH_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([ \\t]*(\\S+))?[ \\t]*$`);

/**
 * Read the lockfile's recorded resolution for billion-context. Handles both
 * shapes pnpm emits:
 *  - nested (lockfile ≥6): `dependencies:` → `billion-context:` with indented
 *    `specifier:`/`version:` fields below it (under importers in v9);
 *  - flat (lockfile ≤5.4): same-line values — under the top-level `specifiers:`
 *    section the value is the declared spec, under the flat `dependencies:` map
 *    it is the RESOLVED version.
 * Returns undefined when no lockfile exists or records no entry for the package.
 */
function readPnpmLockResolution(profileDir: string): LockResolution | undefined {
    let text: string;
    try {
        text = fs.readFileSync(path.join(profileDir, "pnpm-lock.yaml"), "utf8");
    } catch {
        return undefined;
    }
    const lines = text.split("\n");
    const out: LockResolution = {};
    // Track the current top-level section so a same-line value can be told
    // apart (declared spec vs resolved version).
    let section = "";
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/^[ \t]/.test(line)) {
            section = line.match(/^([A-Za-z_][\w-]*):/)?.[1] ?? "";
            continue;
        }
        const m = line.match(PKG_RE);
        if (m === null) continue;
        if (m[2] !== undefined) {
            if (section === "specifiers" && out.specifier === undefined) out.specifier = unquote(m[2]);
            else if (section === "dependencies" && out.version === undefined) out.version = unquote(m[2]);
            continue;
        }
        // Block form: bare entry, its fields indented further below it.
        const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
        for (let j = i + 1; j < lines.length; j++) {
            const inner = lines[j];
            if (inner.trim() === "") continue;
            const innerIndent = inner.match(/^[ \t]*/)?.[0].length ?? 0;
            if (innerIndent <= indent) break;
            const spec = inner.match(/^\s*specifier:\s*(\S+)/);
            if (spec && out.specifier === undefined) out.specifier = unquote(spec[1]);
            const ver = inner.match(/^\s*version:\s*(\S+)/);
            if (ver && out.version === undefined) out.version = unquote(ver[1]);
        }
    }
    return out.specifier !== undefined || out.version !== undefined ? out : undefined;
}

/** npm-materialized profiles record the same two facts in package-lock.json. */
function readPackageLockResolution(profileDir: string): LockResolution | undefined {
    const doc = readJsonFile(path.join(profileDir, "package-lock.json")) as
        | { packages?: Record<string, { version?: unknown; dependencies?: Record<string, unknown> }> }
        | undefined;
    if (doc?.packages === undefined) return undefined;
    const out: LockResolution = {};
    const spec = doc.packages[""]?.dependencies?.[DSH_PACKAGE];
    if (typeof spec === "string") out.specifier = spec;
    const resolved = doc.packages[`node_modules/${DSH_PACKAGE}`];
    if (resolved !== undefined && typeof resolved.version === "string") out.version = resolved.version;
    return out.specifier !== undefined || out.version !== undefined ? out : undefined;
}

/**
 * Does `spec` admit `version`? Exact/caret/tilde only; anything else (dist-tag,
 * range, URL) returns undefined — UNJUDGABLE must stay silent, never a finding.
 * Deliberately loose where semver would be stricter (e.g. ^0.1.x admitted at
 * any 0.x ≥ min): this gates a warning, so err on fewer false positives.
 */
export function specAdmits(spec: string, version: string): boolean | undefined {
    const base = spec.replace(/^[~^]/, "");
    const parse = (s: string): [number, number, number] | undefined => {
        const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
    };
    const b = parse(base);
    const v = parse(version);
    if (b === undefined || v === undefined) return undefined;
    if (v[0] !== b[0]) return false;
    if (spec.startsWith("^")) return v[1] > b[1] || (v[1] === b[1] && v[2] >= b[2]);
    if (spec.startsWith("~")) return v[1] === b[1] && v[2] >= b[2];
    return v[1] === b[1] && v[2] === b[2];
}

function remediation(profile: string): string {
    return `reinstall through the host channel so manifest, lockfile and copy agree again: run \`dsh plugin --profile ${profile} add ${DSH_PACKAGE}\` from a shell where \`dsh\` resolves, or \`bili plugin install dsh\``;
}

/**
 * Pure per-profile audit: compare manifest spec / lockfile resolution / on-disk
 * copy version. Never throws; returns [] for every skip condition (no dep,
 * non-registry-form dev pin, no copy — the last is doctor's "broken" verdict).
 */
export function dshProfileCopyFindings(profileDir: string): ProvenanceFinding[] {
    const profile = path.basename(profileDir);
    // Desktop profile excluded by design (#3224 option A, decided in-thread): bili is
    // the in-place writer of this one lane — after every self-update the manifest spec
    // is synced to the new version while the lockfile stays stale BY DESIGN until dsh's
    // in-app manager reconciles it (#2894), so post-update disagreement there is
    // expected and locally indistinguishable from a true wedge; the ahead face rides
    // #3164's registry advisory, and the CLI refuses --profile desktop (#1575), which
    // would make our remediation wrong. One guard covers both detection exits
    // (startup audit + doctor lane).
    if (profile === DSH_DESKTOP_PROFILE) return [];
    const spec = dshProfileDepSpec(profileDir);
    if (spec === undefined) return [];
    if (!isRegistryDepSpec(spec)) return [];
    const copyVersion = readCopyVersion(profileDir);
    if (copyVersion === undefined) return [];
    const lock = readPnpmLockResolution(profileDir) ?? readPackageLockResolution(profileDir);
    const findings: ProvenanceFinding[] = [];
    if (lock?.version !== undefined && lock.version !== copyVersion) {
        findings.push({
            profile, kind: "copy-vs-lock", copyVersion, lockVersion: lock.version, spec,
            detail: `${DSH_PACKAGE} copy v${copyVersion} does not match the lockfile resolution v${lock.version} — the copy was written out-of-band (the host package manager never resolved it); ${remediation(profile)}`,
        });
    }
    if (lock?.specifier !== undefined && lock.specifier !== spec) {
        findings.push({
            profile, kind: "manifest-vs-lock", copyVersion, lockVersion: lock.version, spec,
            detail: `profile manifest declares ${spec} but the lockfile records ${lock.specifier} — the declaration changed without an install; the next package-manager run may fail or roll the copy back; ${remediation(profile)}`,
        });
    }
    if (lock === undefined && specAdmits(spec, copyVersion) === false) {
        findings.push({
            profile, kind: "copy-vs-manifest", copyVersion, spec,
            detail: `${DSH_PACKAGE} copy v${copyVersion} does not satisfy the manifest spec ${spec}, and no lockfile exists to explain the difference; ${remediation(profile)}`,
        });
    }
    return findings;
}

/**
 * Startup audit across every dsh profile: warn once per finding, never throw —
 * a wedged profile must never delay or break startup. Synchronous by design:
 * all inputs are local files (no registry round-trip).
 */
export function auditDshProfileCopyProvenance(opts?: { env?: NodeJS.ProcessEnv; log?: Logger }): ProvenanceFinding[] {
    const log = opts?.log ?? (() => {});
    let dirs: string[];
    try {
        dirs = dshProfileDirs(opts?.env ?? process.env);
    } catch {
        return []; // dsh has never run on this machine — nothing to audit
    }
    const findings: ProvenanceFinding[] = [];
    for (const dir of dirs) {
        try {
            findings.push(...dshProfileCopyFindings(dir));
        } catch {
            // one unreadable profile must not silence the rest
        }
    }
    for (const f of findings) {
        log("warn", `[dsh-profile] ${f.profile}: ${f.detail}`);
    }
    return findings;
}
