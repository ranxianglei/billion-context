// #3496: the THREE LEDGERS of a dsh profile — the manifest's declared dep spec
// (package.json), the lockfile's recorded resolution (pnpm-lock.yaml /
// package-lock.json), and the on-disk bundle copy (node_modules/billion-context)
// — read, compared, and CONVERGED.
//
// Why this module exists: bili's desktop-lane self-heal swaps the on-disk copy
// in place (#1575) and #2894 taught it to follow the manifest spec — but the
// lockfile record stayed behind on purpose, so every in-place write left a
// latent wedge: dsh's in-app plugin manager reconciles node_modules against
// that stale record (silently reverting the update), or a hand-edited manifest
// (#3160: a spec the registry cannot resolve) makes the next
// `pnpm install` 404. This module closes the loop:
//   - the self-heal hook (src/update.ts) converges manifest + lockfile in the
//     SAME operation as the copy swap, so drift is never produced;
//   - `bili doctor --fix` (src/doctor.ts) converges pre-existing drift to the
//     on-disk copy version, printing exactly what changed.
//
// Comparison semantics are deliberately identical to #3231's provenance
// detection (same three rungs, same skip conditions, same loose specAdmits) so
// "detection says clean" and "convergence says done" can never disagree. When
// both land, the duplicated readers collapse into this module (follow-up).

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { DSH_DESKTOP_PROFILE, DSH_PACKAGE, dshProfileDepSpec, isRegistryDepSpec, planDshProfileManifestSpec } from "./dsh-channel.js";

type LedgerLockKind = "pnpm" | "npm" | "none";

interface DshLedgerState {
    /** The manifest's declared spec for billion-context (registry form or pin). */
    spec?: string;
    /** What the lockfile records as the DECLARED spec (may differ from the manifest). */
    lockSpecifier?: string;
    /** What the lockfile records as the RESOLVED version. */
    lockVersion?: string;
    /** The version of the on-disk bundle copy, or undefined when unreadable. */
    copyVersion?: string;
    /** The direct deps the on-disk copy declares (its package.json) — the
     *  cross-check source for a cloned store entry's dep map (#7125). */
    copyDeps?: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    /** The pnpm lockfile records a version whose store sections
     *  (packages:/snapshots:) lack that version's entries — the record was
     *  written without its resolution data (#7125). undefined = not judged
     *  (no pnpm lockfile, flat ≤5.4 shape, or no recorded version). */
    lockStoreBroken?: boolean;
    lockKind: LedgerLockKind;
}

type LedgerFindingKind = "copy-vs-lock" | "manifest-vs-lock" | "copy-vs-manifest" | "lockfile-internal";

export interface LedgerFinding {
    profile: string;
    kind: LedgerFindingKind;
    copyVersion?: string;
    lockVersion?: string;
    spec?: string;
    detail: string;
}

export interface LedgerChangeDetail {
    file: string;
    field: string;
    before: string;
    after: string;
}

interface LedgerConvergenceResult {
    /** Profile-relative file names that were rewritten. Empty when nothing written. */
    changed: string[];
    /** Before→after for every ledger fact that moved (for the explicit report). */
    details: LedgerChangeDetail[];
    /** Human-readable notes (respected pins, missing lockfile, …). */
    notes: string[];
    /** Set when the state is not safely convergable — NOTHING was written. */
    error?: string;
    /** Set with `error` when at least one ledger (manifest spec / lockfile
     *  record) exists and still records the OLD version after the copy moved
     *  — the caller must not destroy the displaced copy (the only rollback
     *  source). Absent/false = no ledgers to diverge from (nothing to
     *  converge) or convergence succeeded. */
    divergent?: boolean;
}

const PKG_ESCAPED = DSH_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PKG_ENTRY_RE = new RegExp(`^([ \\t]+)${PKG_ESCAPED}:([ \\t]*(\\S+))?[ \\t]*$`);

function readJsonFile(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

function unquote(v: string): string {
    return v.replace(/^["']|["']$/g, "");
}

/** Split a pnpm lockfile `version:` value into the resolved version and the
 *  peer-resolution suffix pnpm appends when the package (or something it
 *  depends on) has peers — `1.2.3(@types/node@16.9.1)` → ["1.2.3",
 *  "(@types/node@16.9.1)"]. The suffix names which peer set this install was
 *  resolved against; it is NOT part of the version, so every comparison with
 *  the on-disk copy must ignore it, and a rewrite must carry it over (the
 *  `snapshots:` key it points at carries the same suffix). */
function splitPeerSuffix(v: string): [version: string, peerSuffix: string] {
    const at = v.indexOf("(");
    return at > 0 ? [v.slice(0, at), v.slice(at)] : [v, ""];
}

/** Plain-YAML-safe scalar: quote anything that could be misread (leading
 *  indicators like `>` or the alias indicator `*`, whitespace, …). Versions,
 *  ^/~ specs, and base64 integrity hashes stay bare — their `+`/`/`/`=` are
 *  legal inside a YAML plain scalar, and pnpm writes them bare; a leading `*`
 *  is quoted because YAML would parse it as an alias token, not a spec (pnpm's
 *  own writer quotes it too). */
function yamlScalar(v: string): string {
    return /^[A-Za-z0-9.^~_-][\w.^~*+=/-]*$/.test(v) ? v : JSON.stringify(v);
}

/** Read all three ledgers of one profile. Never throws; every absent part is
 *  simply undefined. */
export function readDshLedgerState(profileDir: string): DshLedgerState {
    const state: DshLedgerState = { spec: dshProfileDepSpec(profileDir), lockKind: "none" };
    const doc = readJsonFile(path.join(profileDir, "node_modules", DSH_PACKAGE, "package.json")) as
        | { version?: unknown; dependencies?: unknown; optionalDependencies?: unknown }
        | undefined;
    if (typeof doc?.version === "string") {
        state.copyVersion = doc.version;
        state.copyDeps = readDepMaps(doc);
    }
    const pnpm = readPnpmLockResolution(profileDir);
    if (pnpm !== undefined) {
        state.lockKind = "pnpm";
        state.lockSpecifier = pnpm.specifier;
        state.lockVersion = pnpm.version;
        state.lockStoreBroken = pnpm.storeBroken;
        return state;
    }
    const npm = readPackageLockResolution(profileDir);
    if (npm !== undefined) {
        state.lockKind = "npm";
        state.lockSpecifier = npm.specifier;
        state.lockVersion = npm.version;
    }
    return state;
}

/** The direct dep maps of a package.json doc. Only well-formed maps
 *  (object of name → string spec) are kept; a malformed doc yields undefined,
 *  which means "no cross-check" for the store sync — never a wrong one. */
function readDepMaps(doc: { dependencies?: unknown; optionalDependencies?: unknown }): { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } | undefined {
    const out: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } = {};
    for (const key of ["dependencies", "optionalDependencies"] as const) {
        const raw = doc[key];
        if (typeof raw !== "object" || raw === null) continue;
        const map: Record<string, string> = {};
        let wellFormed = true;
        for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof spec !== "string") { wellFormed = false; break; }
            map[name] = spec;
        }
        if (wellFormed) out[key] = map;
    }
    return out.dependencies !== undefined || out.optionalDependencies !== undefined ? out : undefined;
}

interface LockResolution {
    specifier?: string;
    version?: string;
    /** The recorded version value VERBATIM (peer suffix included) — the key
     *  the suffixed store entry (v9 snapshots:, v6–v8 packages:) carries. */
    versionRaw?: string;
    /** #7125: the recorded version has no store-section entry (packages: /
     *  snapshots:) — the record was written without its resolution data.
     *  undefined = not judged (flat shape, no store sections, no version). */
    storeBroken?: boolean;
}

/** Read the lockfile's recorded resolution for billion-context. Handles the
 *  shapes pnpm emits (ported verbatim from #3231's provenance reader):
 *   - nested (lockfile ≥6): `billion-context:` entries with indented
 *     `specifier:`/`version:` fields (under `importers:` in v9, top-level
 *     `dependencies:` in v6–v8);
 *   - flat (lockfile ≤5.4): same-line values — under the top-level
 *     `specifiers:` section the value is the declared spec, under the flat
 *     `dependencies:` map it is the RESOLVED version.
 * The resolved version is returned WITHOUT pnpm's peer suffix
 * (`1.2.3(@types/node@16.9.1)` reads as `1.2.3`) — see splitPeerSuffix.
 * Returns undefined when no lockfile exists or records no entry. */
function readPnpmLockResolution(profileDir: string): LockResolution | undefined {
    let text: string;
    try {
        text = fs.readFileSync(path.join(profileDir, "pnpm-lock.yaml"), "utf8");
    } catch {
        return undefined;
    }
    const lines = text.split("\n");
    const out: LockResolution = {};
    let section = "";
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/^[ \t]/.test(line)) {
            section = line.match(/^([A-Za-z_][\w-]*):/)?.[1] ?? "";
            continue;
        }
        const m = line.match(PKG_ENTRY_RE);
        if (m === null) continue;
        if (m[3] !== undefined) {
            if (section === "specifiers" && out.specifier === undefined) out.specifier = unquote(m[3]);
            else if (section === "dependencies" && out.version === undefined) out.version = unquote(m[3]);
            continue;
        }
        const indent = m[1].length;
        for (let j = i + 1; j < lines.length; j++) {
            const inner = lines[j];
            if (inner.trim() === "") continue;
            const innerIndent = inner.match(/^[ \t]*/)?.[0].length ?? 0;
            if (innerIndent <= indent) break;
            const spec = inner.match(/^\s*specifier:\s*(\S+)/);
            if (spec && out.specifier === undefined) out.specifier = unquote(spec[1]);
            const ver = inner.match(/^\s*version:\s*(\S+)/);
            if (ver && out.version === undefined) {
                out.version = splitPeerSuffix(unquote(ver[1]))[0];
                out.versionRaw = unquote(ver[1]);
            }
        }
    }
    if (out.version !== undefined) out.storeBroken = pnpmStoreBroken(lines, out.version, out.versionRaw ?? out.version);
    return out.specifier !== undefined || out.version !== undefined ? out : undefined;
}

/** #7125: does the recorded version have its store-section entries?
 *  v9+ (packages: AND snapshots: present) — packages: carries the BARE key
 *  `billion-context@<version>`, snapshots: the SUFFIXED key
 *  `billion-context@<versionRaw>`; either missing = broken. v6–v8 (only
 *  packages:) — the key is `/billion-context/<versionRaw>`; missing = broken.
 *  Flat ≤5.4 has no store sections → not judged (undefined). */
function pnpmStoreBroken(lines: string[], version: string, versionRaw: string): boolean {
    const sections = topLevelSections(lines);
    const packages = sections.get("packages");
    const snapshots = sections.get("snapshots");
    if (snapshots !== undefined && packages !== undefined) {
        return findStoreEntry(lines, packages, `billion-context@${version}`) === undefined
            || findStoreEntry(lines, snapshots, `billion-context@${versionRaw}`) === undefined;
    }
    if (packages !== undefined) {
        return findStoreEntry(lines, packages, `/billion-context/${versionRaw}`) === undefined;
    }
    return false;
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

/** Does `spec` admit `version`? Exact/caret/tilde only; anything else
 *  (dist-tag, range, URL) returns undefined — UNJUDGABLE must stay silent,
 *  never a finding. Deliberately loose where semver would be stricter (same
 *  semantics as #3231's specAdmits, which gates a warning — err on fewer
 *  false positives). */
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
    return `run \`bili doctor --fix\` to converge the ledgers to the on-disk copy, or reinstall through the host channel (\`dsh plugin --profile ${profile} add ${DSH_PACKAGE}\` / \`bili plugin install dsh\`)`;
}

/** Pure per-profile audit: compare manifest spec / lockfile resolution /
 *  on-disk copy version (the three rungs of #3231). Never throws; [] for every
 *  skip condition (no dep, non-registry pin, no copy). The DETECTION surface
 *  (startup audit, plain `bili doctor`) excludes the desktop profile by design
 *  (#3224 option A — bili is its in-place writer); `--fix` passes
 *  includeDesktop because explicit repair must reach the very profile where
 *  the #3160 incident happened. */
export function dshProfileLedgerFindings(profileDir: string, opts?: { includeDesktop?: boolean }): LedgerFinding[] {
    const profile = path.basename(profileDir);
    if (profile === DSH_DESKTOP_PROFILE && !opts?.includeDesktop) return [];
    const spec = dshProfileDepSpec(profileDir);
    if (spec === undefined) return [];
    if (!isRegistryDepSpec(spec)) return [];
    const state = readDshLedgerState(profileDir);
    const copyVersion = state.copyVersion;
    if (copyVersion === undefined) return [];
    const findings: LedgerFinding[] = [];
    if (state.lockVersion !== undefined && state.lockVersion !== copyVersion) {
        findings.push({
            profile, kind: "copy-vs-lock", copyVersion, lockVersion: state.lockVersion, spec,
            detail: `${DSH_PACKAGE} copy v${copyVersion} does not match the lockfile resolution v${state.lockVersion} — the copy was written out-of-band (the host package manager never resolved it); ${remediation(profile)}`,
        });
    }
    if (state.lockStoreBroken === true) {
        // #7125: the record and its resolution data disagree — invisible to
        // the three-rung audit above (importer, copy and manifest all agree),
        // but package-manager operations (update/remove of other plugins)
        // hard-fail on it.
        findings.push({
            profile, kind: "lockfile-internal", copyVersion, lockVersion: state.lockVersion, spec,
            detail: `the lockfile records ${DSH_PACKAGE} v${state.lockVersion} but its store sections (packages:/snapshots:) lack that version's entries — the record was written without its resolution data; ${remediation(profile)}`,
        });
    }
    if (state.lockSpecifier !== undefined && state.lockSpecifier !== spec) {
        findings.push({
            profile, kind: "manifest-vs-lock", copyVersion, lockVersion: state.lockVersion, spec,
            detail: `profile manifest declares ${spec} but the lockfile records ${state.lockSpecifier} — the declaration changed without an install; the next package-manager run may fail or roll the copy back; ${remediation(profile)}`,
        });
    }
    if (state.lockKind === "none" && specAdmits(spec, copyVersion) === false) {
        findings.push({
            profile, kind: "copy-vs-manifest", copyVersion, spec,
            detail: `${DSH_PACKAGE} copy v${copyVersion} does not satisfy the manifest spec ${spec}, and no lockfile exists to explain the difference; ${remediation(profile)}`,
        });
    }
    return findings;
}

// — convergence (the fix half of #3496) ——————————————————————————————————————

type PnpmPatch = { kind: "ok"; next: string; details: LedgerChangeDetail[] } | { kind: "fail"; reason: string };

/** Index the top-level sections of a pnpm lockfile: key → [startLine, endLine)
 *  where endLine is the next column-0 line (or EOF). */
function topLevelSections(lines: string[]): Map<string, [number, number]> {
    const sections = new Map<string, [number, number]>();
    let current: [string, number] | undefined;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(/^([A-Za-z_][\w-]*):/);
        if (m !== null) {
            if (current !== undefined) sections.set(current[0], [current[1], i]);
            current = [m[1], i];
        } else if (current !== undefined && lines[i]!.trim() !== "" && !/^[ \t]/.test(lines[i]!)) {
            // a column-0 line that is not a `key:` line still ends the section
            sections.set(current[0], [current[1], i]);
            current = undefined;
        }
    }
    if (current !== undefined) sections.set(current[0], [current[1], lines.length]);
    return sections;
}

/** Patch every nested `billion-context:` entry (indented specifier:/version:
 *  children) inside the given line range. Returns the details of every field
 *  that actually changed. Fails (no partial result) when the expected entry or
 *  its fields cannot be found. */
function patchNestedEntries(lines: string[], from: number, to: number, spec: string, version: string): PnpmPatch {
    const details: LedgerChangeDetail[] = [];
    let patched = 0;
    for (let i = from; i < to; i++) {
        const m = lines[i]!.match(PKG_ENTRY_RE);
        if (m === null || m[3] !== undefined) continue; // same-line value — not a nested entry
        const indent = m[1].length;
        let sawSpecifier = false;
        let sawVersion = false;
        for (let j = i + 1; j < to; j++) {
            const inner = lines[j]!;
            if (inner.trim() === "") continue;
            const innerIndent = inner.match(/^[ \t]*/)?.[0].length ?? 0;
            if (innerIndent <= indent) break;
            const sm = inner.match(/^([ \t]*)specifier:[ \t]*(\S.*)?$/);
            if (sm !== null) {
                sawSpecifier = true;
                const want = yamlScalar(spec);
                if (unquote(sm[2] ?? "") !== spec) {
                    lines[j] = `${sm[1]}specifier: ${want}`;
                    details.push({ file: "pnpm-lock.yaml", field: "specifier", before: unquote(sm[2] ?? ""), after: spec });
                }
                continue;
            }
            const vm = inner.match(/^([ \t]*)version:[ \t]*(\S.*)?$/);
            if (vm !== null) {
                sawVersion = true;
                // Compare and swap the version part only: a peer suffix
                // (`1.2.3(@types/node@16.9.1)`) is kept verbatim, in the
                // quoting style the line already has (pnpm writes it bare;
                // yamlScalar would quote it and churn the line).
                const raw = (vm[2] ?? "").trimEnd();
                const cur = unquote(raw);
                const [curVersion, peerSuffix] = splitPeerSuffix(cur);
                if (curVersion !== version) {
                    const quote = /^["']/.test(raw) ? raw[0] : "";
                    const next = peerSuffix === "" ? yamlScalar(version) : `${quote}${version}${peerSuffix}${quote}`;
                    lines[j] = `${vm[1]}version: ${next}`;
                    details.push({ file: "pnpm-lock.yaml", field: "version", before: cur, after: `${version}${peerSuffix}` });
                }
            }
        }
        if (!sawSpecifier || !sawVersion) {
            return { kind: "fail", reason: "the lockfile's billion-context entry lacks both specifier: and version: fields — structure not recognized, manual repair needed" };
        }
        patched++;
    }
    if (patched === 0) return { kind: "fail", reason: "no billion-context entry found in the lockfile — run 'dsh plugin --profile <name> add billion-context' once so the package manager records the resolution, then retry" };
    return { kind: "ok", next: lines.join("\n"), details };
}

/** Patch the flat ≤5.4 same-line entries: `specifiers:` section carries the
 *  declared spec, `dependencies:` carries the resolved version. */
function patchFlatEntries(lines: string[], spec: string, version: string): PnpmPatch {
    const sections = topLevelSections(lines);
    const details: LedgerChangeDetail[] = [];
    const patchSection = (key: "specifiers" | "dependencies", value: string, field: string): string | undefined => {
        const range = sections.get(key);
        if (range === undefined) return `no top-level '${key}:' section in the lockfile`;
        for (let i = range[0] + 1; i < range[1]; i++) {
            const m = lines[i]!.match(PKG_ENTRY_RE);
            if (m === null || m[3] === undefined) continue;
            const cur = unquote(m[3]);
            if (cur !== value) {
                lines[i] = `${m[1]}${DSH_PACKAGE}: ${yamlScalar(value)}`;
                details.push({ file: "pnpm-lock.yaml", field, before: cur, after: value });
            }
            return undefined;
        }
        return `no ${DSH_PACKAGE} entry under the '${key}:' section`;
    };
    const err1 = patchSection("specifiers", spec, "specifier");
    if (err1 !== undefined) return { kind: "fail", reason: err1 };
    const err2 = patchSection("dependencies", version, "version");
    if (err2 !== undefined) return { kind: "fail", reason: err2 };
    return { kind: "ok", next: lines.join("\n"), details };
}

/** Options for the store-section sync in patchPnpmLock (#7125). */
interface PnpmLockPatchOpts {
    /** The NEW version's SRI integrity (from the registry doc). Required when
     *  a store entry must be created and its source carries an integrity —
     *  the source's hash is NEVER carried to the new key. Absent → the patch
     *  fails soft (zero writes) rather than writing a broken lockfile. */
    integrity?: string;
    /** The on-disk copy's direct deps (its package.json) — cross-checked
     *  against the cloned store entry's dep map. Absent → the map is cloned
     *  as-is. */
    deps?: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
}

type StoreSync = { kind: "ok"; details: LedgerChangeDetail[] } | { kind: "fail"; reason: string };

interface StoreEntry { start: number; end: number; inline: string | undefined; }

/** Locate the store entry for `key` (a 2-space-indented `key:` line) inside
 *  [from, to). pnpm writes an entry either as a block (`  key:` + indented
 *  children) or inline (`  key: {}`); both are recognized — `inline` carries
 *  the inline value when present, else the block runs to the next 2-space key
 *  line or the section end. */
function findStoreEntry(lines: string[], range: readonly [number, number], key: string): StoreEntry | undefined {
    for (let i = range[0] + 1; i < range[1]; i++) {
        const m = lines[i]!.match(/^  ([^\s:]+):([ \t]*.*)$/);
        if (m === null || m[1] !== key) continue;
        const rest = m[2].trim();
        if (rest !== "") return { start: i, end: i + 1, inline: rest };
        let end = range[1];
        for (let j = i + 1; j < range[1]; j++) {
            if (/^  [^\s]/.test(lines[j]!)) { end = j; break; }
        }
        return { start: i, end, inline: undefined };
    }
    return undefined;
}

function versionDistance(a: string, b: string): number {
    const num = (v: string): number => {
        const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
        if (m === null) return Number.NaN;
        return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
    };
    const na = num(a);
    const nb = num(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) return Number.POSITIVE_INFINITY;
    return Math.abs(na - nb);
}

/** Pick the existing billion-context store entry to clone for `targetKey`:
 *  prefer the same peer suffix, then the closest major.minor.patch. Returns
 *  the entry's span plus its inline value (block entries have inline=undefined). */
function pickSourceBlock(lines: string[], range: readonly [number, number], targetKey: string): { start: number; end: number; key: string; inline: string | undefined } | undefined {
    const targetM = targetKey.match(/@?\/?(\d+\.\d+\.\d+)/);
    const targetSuffix = targetKey.includes("(") ? targetKey.slice(targetKey.indexOf("(")) : "";
    let best: { start: number; end: number; key: string; dist: number; sameSuffix: boolean; inline: string | undefined } | undefined;
    for (let i = range[0] + 1; i < range[1]; i++) {
        const m = lines[i]!.match(/^  (billion-context@[^\s:]+|\/billion-context\/[^\s:]+):([ \t]*.*)$/);
        if (m === null) continue;
        const rest = m[2].trim();
        const inline = rest !== "" ? rest : undefined;
        let end = range[1];
        if (inline === undefined) {
            for (let j = i + 1; j < range[1]; j++) {
                if (/^  [^\s]/.test(lines[j]!)) { end = j; break; }
            }
        } else {
            end = i + 1;
        }
        const keyM = m[1].match(/@?\/?(\d+\.\d+\.\d+)/);
        const dist = targetM !== null && keyM !== null ? versionDistance(targetM[1], keyM[1]) : Number.POSITIVE_INFINITY;
        const sameSuffix = targetSuffix !== "" && m[1].endsWith(targetSuffix);
        if (best === undefined || (sameSuffix && !best.sameSuffix) || (sameSuffix === best.sameSuffix && dist < best.dist)) {
            best = { start: i, end, key: m[1], dist, sameSuffix, inline };
        }
    }
    return best;
}

/** Rewrite the cloned store block's integrity to the NEW version's hash. The
 *  source's hash is NEVER carried to the new key (a wrong hash makes pnpm
 *  hard-fail verification). When the source carries an integrity and the new
 *  one is unknown, fail — a zero-write is strictly better than a broken
 *  lockfile. */
function applyIntegrity(block: string[], integrity: string | undefined): { kind: "ok"; lines: string[] } | { kind: "fail"; reason: string } {
    let resIdx = -1;
    let resHead = "";
    let resRest = "";
    for (let i = 0; i < block.length; i++) {
        const m = block[i]!.match(/^([ \t]+)resolution:[ \t]*(.*)$/);
        if (m !== null) { resIdx = i; resHead = m[1]; resRest = m[2].trim(); break; }
    }
    const missingNewHash = (): { kind: "fail"; reason: string } => ({ kind: "fail", reason: "the source store entry carries an integrity the new version cannot reuse, and the new integrity is unknown — refusing to write a wrong hash (rerun with registry access, or let pnpm repair the lockfile)" });
    if (resIdx === -1) {
        if (integrity === undefined) return { kind: "ok", lines: block };
        // No resolution line yet — add one at the entry's child indent (match
        // an existing child, else the default 4 spaces under a 2-space key).
        const firstChild = block.find((l) => l.trim() !== "");
        const ind = firstChild !== undefined ? firstChild.length - firstChild.trimStart().length : 4;
        return { kind: "ok", lines: [`${" ".repeat(ind)}resolution: {integrity: ${yamlScalar(integrity)}}`, ...block] };
    }
    if (resRest !== "") {
        // Inline form: resolution: {integrity: "…"}
        if (integrity === undefined) {
            if (/integrity[ \t]*:/.test(resRest)) return missingNewHash();
            return { kind: "ok", lines: block };
        }
        const replaced = resRest.replace(/integrity[ \t]*:[ \t]*("[^"]*"|'[^']*'|[^\s,}]+)/, `integrity: ${yamlScalar(integrity)}`);
        if (replaced === resRest) return { kind: "fail", reason: "could not locate the integrity field in the cloned resolution line" };
        block[resIdx] = `${resHead}resolution: ${replaced}`;
        return { kind: "ok", lines: block };
    }
    // Block form: integrity: is a child of resolution:
    const resInd = resHead.length;
    let integIdx = -1;
    for (let i = resIdx + 1; i < block.length; i++) {
        const l = block[i]!;
        if (l.trim() === "") continue;
        const ind = l.length - l.trimStart().length;
        if (ind <= resInd) break;
        if (/^[ \t]*integrity:[ \t]*/.test(l)) { integIdx = i; break; }
    }
    if (integIdx === -1) {
        if (integrity === undefined) return { kind: "ok", lines: block };
        block.splice(resIdx + 1, 0, `${resHead}  integrity: ${yamlScalar(integrity)}`);
        return { kind: "ok", lines: block };
    }
    if (integrity === undefined) return missingNewHash();
    block[integIdx] = block[integIdx]!.replace(/integrity:[ \t]*.*$/, `integrity: ${yamlScalar(integrity)}`);
    return { kind: "ok", lines: block };
}

/** Resolve a direct dep's version from the lockfile's store section: exactly
 *  one candidate → that version (peer suffix included); 0 or >1 → undefined
 *  (the caller fails soft). */
function resolveDepFromStore(lines: string[], section: "packages" | "snapshots", name: string): string | undefined {
    const sections = topLevelSections(lines);
    const range = sections.get(section);
    if (range === undefined) return undefined;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match BOTH store-entry forms: a block header (`  name@v:`) and an inline
    // value (`  name@v: {}`) — a dep with no deps of its own is written inline,
    // and its version still lives in the key.
    const keyRe = section === "snapshots"
        ? new RegExp(`^  ${esc}@([^\\s:]+):([ \\t].*)?$`)
        : new RegExp(`^  /${esc}/([^\\s:]+):([ \\t].*)?$`);
    const found: string[] = [];
    for (let i = range[0] + 1; i < range[1]; i++) {
        const m = lines[i]!.match(keyRe);
        if (m !== null) found.push(m[1]);
    }
    return found.length === 1 ? found[0] : undefined;
}

/** Does the store entry's resolved version satisfy the spec the on-disk copy
 *  declares for that dep? A cloned store block carries the SOURCE version's
 *  resolution data — when the dependency's DECLARED spec changed between
 *  versions (zod 4.1.8 → exact 4.6.7, #7125), the clone would record a
 *  resolution the new manifest contradicts, and a frozen install would
 *  faithfully install the wrong dep. undefined = unjudgeable (dist-tag / URL
 *  / workspace spec, non-semver value) — the caller stays silent, same
 *  "err on fewer false positives" discipline as specAdmits; false = a proven
 *  contradiction → the patch fails soft. */
function depResolutionAdmits(spec: string, resolved: string): boolean | undefined {
    if (semver.valid(resolved) === null) return undefined;
    if (semver.validRange(spec) === null) return undefined;
    return semver.satisfies(resolved, spec);
}

/** Cross-check the cloned store block's dep map against the on-disk copy's
 *  direct deps (the NEW version's authoritative declaration): declared deps
 *  missing from the map are resolved from the store (exactly one candidate —
 *  ambiguity fails soft); names no longer declared are dropped; a surviving
 *  entry whose recorded resolution contradicts the new declaration fails soft
 *  (the resolution data predates a dependency change). */
function crossCheckDepMaps(lines: string[], block: string[], section: "packages" | "snapshots", deps: PnpmLockPatchOpts["deps"]): { kind: "ok"; lines: string[] } | { kind: "fail"; reason: string } {
    if (deps === undefined) return { kind: "ok", lines: block };
    const declared: Record<string, "dependencies" | "optionalDependencies"> = {};
    for (const name of Object.keys(deps.dependencies ?? {})) declared[name] = "dependencies";
    for (const name of Object.keys(deps.optionalDependencies ?? {})) declared[name] = "optionalDependencies";
    const headerIdx: Record<string, number> = {};
    const entryIdx: Record<string, Record<string, number>> = {};
    let current: string | undefined;
    let headerIndent = 0;
    for (let i = 0; i < block.length; i++) {
        const l = block[i]!;
        if (l.trim() === "") continue;
        const ind = l.length - l.trimStart().length;
        const hm = l.match(/^([ \t]+)(dependencies|optionalDependencies):[ \t]*$/);
        if (hm !== null) {
            current = hm[2];
            headerIndent = hm[1].length;
            headerIdx[current] = i;
            entryIdx[current] = entryIdx[current] ?? {};
            continue;
        }
        if (current === undefined) continue;
        if (ind <= headerIndent) { current = undefined; continue; }
        const em = l.match(/^([ \t]+)([^\s:][^:]*):[ \t]*\S.*$/);
        if (em !== null) entryIdx[current][em[2]] = i;
    }
    const out = block.slice();
    const surviving: Record<string, string> = {};
    const drop: number[] = [];
    for (const bucket of Object.keys(headerIdx)) {
        for (const [name, idx] of Object.entries(entryIdx[bucket]!)) {
            if (declared[name] === undefined || declared[name] !== bucket) {
                drop.push(idx);
                continue;
            }
            const spec = (bucket === "dependencies" ? deps.dependencies : deps.optionalDependencies)![name];
            const vm = block[idx]!.match(/^[ \t]+[^\s:][^:]*:[ \t]*(\S.*)$/);
            if (vm !== null) {
                const resolved = unquote(splitPeerSuffix(vm[1])[0]);
                if (depResolutionAdmits(spec, resolved) === false) {
                    return { kind: "fail", reason: `the cloned ${section} entry carries '${name}: ${resolved}' but the on-disk copy declares '${name}: ${spec}' — the store's resolution data predates the dependency change; let pnpm record the new resolution (install) and rerun` };
                }
            }
            surviving[name] = bucket;
        }
    }
    for (const idx of drop.sort((a, b) => b - a)) out.splice(idx, 1);
    for (const [name, bucket] of Object.entries(declared)) {
        if (surviving[name] !== undefined) continue;
        // Only fill a bucket the entry already carries — a store entry that
        // has no dep map at all (v9 packages:) must not grow one; a dep a
        // missing bucket would hold is left to pnpm's install-time repair.
        const hIdx = out.findIndex((l) => new RegExp(`^[ \\t]+${bucket}:[ \\t]*$`).test(l));
        if (hIdx === -1) continue;
        const value = resolveDepFromStore(lines, section, name);
        if (value === undefined) {
            return { kind: "fail", reason: `cannot resolve '${name}' for the cloned store entry — the lockfile's ${section} section has no unique entry for it; let pnpm repair the lockfile (install --fix-lockfile) and rerun` };
        }
        const hInd = out[hIdx]!.length - out[hIdx]!.trimStart().length;
        out.splice(hIdx + 1, 0, `${" ".repeat(hInd + 2)}${name}: ${value}`);
    }
    return { kind: "ok", lines: out };
}

/** Read the patched importer's version value VERBATIM (peer suffix included)
 *  from the first nested billion-context entry — the key the suffixed store
 *  entry (snapshots:) carries. */
function readNestedVersionValue(lines: string[]): string | undefined {
    const sections = topLevelSections(lines);
    const candidates: string[] = [];
    if (sections.has("importers")) candidates.push("importers");
    if (sections.has("dependencies")) candidates.push("dependencies");
    if (sections.has("devDependencies")) candidates.push("devDependencies");
    for (const sec of candidates) {
        const range = sections.get(sec)!;
        for (let i = range[0] + 1; i < range[1]; i++) {
            const m = lines[i]!.match(PKG_ENTRY_RE);
            if (m === null || m[3] !== undefined) continue;
            const indent = m[1].length;
            for (let j = i + 1; j < range[1]; j++) {
                const inner = lines[j]!;
                if (inner.trim() === "") continue;
                const innerIndent = inner.match(/^[ \t]*/)?.[0].length ?? 0;
                if (innerIndent <= indent) break;
                const vm = inner.match(/^\s*version:\s*(\S+)/);
                if (vm !== null) return unquote(vm[1]);
            }
        }
    }
    return undefined;
}

/** Sync ONE store section so it holds an entry for `targetKey`: a present
 *  entry is left alone (zero writes); a missing one is cloned from the
 *  closest existing billion-context entry. `applyInt` rewrites the clone's
 *  integrity to the new version's hash (packages: only — snapshots: entries
 *  carry the dep map, not the hash); the dep map is cross-checked either way. */
function syncStoreSection(lines: string[], section: "packages" | "snapshots", targetKey: string, opts: PnpmLockPatchOpts | undefined, applyInt: boolean): StoreSync {
    const sections = topLevelSections(lines);
    const range = sections.get(section);
    if (range === undefined) return { kind: "ok", details: [] };
    if (findStoreEntry(lines, range, targetKey) !== undefined) return { kind: "ok", details: [] };
    const source = pickSourceBlock(lines, range, targetKey);
    if (source === undefined) {
        return { kind: "fail", reason: `pnpm-lock.yaml ${section}: has no billion-context entry to clone for ${targetKey} — let pnpm record the resolution (install) and rerun` };
    }
    let newLines: string[];
    if (source.inline !== undefined) {
        // An inline source (`key: {}`) has no children to rewrite — clone it
        // verbatim under the new key.
        newLines = [`  ${targetKey}: ${source.inline}`];
    } else {
        let block = lines.slice(source.start + 1, source.end);
        if (applyInt) {
            const integ = applyIntegrity(block, opts?.integrity);
            if (integ.kind === "fail") return integ;
            block = integ.lines;
        }
        const deps = crossCheckDepMaps(lines, block, section, opts?.deps);
        if (deps.kind === "fail") return deps;
        newLines = [`  ${targetKey}:`, ...deps.lines];
    }
    lines.splice(source.end, 0, ...newLines);
    return { kind: "ok", details: [{ file: "pnpm-lock.yaml", field: `${section}: ${targetKey}`, before: "(missing)", after: `cloned from ${source.key}` }] };
}

/** #7125: after the importer record moves to `version`, the store sections
 *  must hold that version's entries too — an importer pointing at a version
 *  with no packages:/snapshots: entry is an internally inconsistent lockfile
 *  (pnpm 11 `remove` hard-fails, pnpm ≥12 dangles a symlink — #3570). */
function syncPnpmStoreEntries(lines: string[], version: string, versionRaw: string | undefined, opts: PnpmLockPatchOpts | undefined): StoreSync {
    const details: LedgerChangeDetail[] = [];
    const raw = versionRaw ?? version;
    // snapshots: carry the dep map, NOT the integrity (it lives in packages:).
    const snap = syncStoreSection(lines, "snapshots", `billion-context@${raw}`, opts, false);
    if (snap.kind === "fail") return snap;
    details.push(...snap.details);
    const pkg = syncStoreSection(lines, "packages", `billion-context@${version}`, opts, true);
    if (pkg.kind === "fail") return pkg;
    details.push(...pkg.details);
    return { kind: "ok", details };
}

function syncPnpmStoreEntriesV6(lines: string[], version: string, versionRaw: string | undefined, opts: PnpmLockPatchOpts | undefined): StoreSync {
    const raw = versionRaw ?? version;
    return syncStoreSection(lines, "packages", `/billion-context/${raw}`, opts, true);
}

/** Rewrite the pnpm lockfile so it records (spec, version). When `opts` is
 *  given, the store sections (packages:/snapshots:) are synced to hold that
 *  version's entries too (#7125) — the importer record and its resolution
 *  data move together; without them the lockfile is internally inconsistent
 *  and package-manager operations on it hard-fail. Pure: returns the new text
 *  or a reason; never touches disk. */
export function patchPnpmLock(text: string, spec: string, version: string, opts?: PnpmLockPatchOpts): PnpmPatch {
    const lines = text.split("\n");
    const sections = topLevelSections(lines);
    if (sections.has("importers")) {
        const range = sections.get("importers")!;
        const r = patchNestedEntries(lines, range[0], range[1], spec, version);
        if (r.kind === "fail") return r;
        if (opts !== undefined) {
            const store = syncPnpmStoreEntries(lines, version, readNestedVersionValue(lines), opts);
            if (store.kind === "fail") return store;
            return { kind: "ok", next: lines.join("\n"), details: [...r.details, ...store.details] };
        }
        return r;
    }
    if (sections.has("specifiers")) {
        return patchFlatEntries(lines, spec, version);
    }
    // v6–v8: no importers, no specifiers — nested entries live under the
    // top-level dependencies:/devDependencies: maps.
    const candidates = ["dependencies", "devDependencies"].filter((k) => sections.has(k));
    if (candidates.length > 0) {
        const details: LedgerChangeDetail[] = [];
        let patched = 0;
        for (const key of candidates) {
            const range = sections.get(key)!;
            const sub = patchNestedEntries(lines.slice(range[0], range[1]), 0, range[1] - range[0], spec, version);
            if (sub.kind === "fail") {
                // an entry-less section is fine when another section holds the entry
                if (!sub.reason.startsWith("no billion-context entry")) return sub;
                continue;
            }
            lines.splice(range[0], range[1] - range[0], ...sub.next.split("\n"));
            details.push(...sub.details);
            patched++;
        }
        if (patched === 0) return { kind: "fail", reason: "no billion-context entry found in the lockfile — run 'dsh plugin --profile <name> add billion-context' once so the package manager records the resolution, then retry" };
        if (opts !== undefined) {
            const store = syncPnpmStoreEntriesV6(lines, version, readNestedVersionValue(lines), opts);
            if (store.kind === "fail") return store;
            return { kind: "ok", next: lines.join("\n"), details: [...details, ...store.details] };
        }
        return { kind: "ok", next: lines.join("\n"), details };
    }
    return { kind: "fail", reason: "lockfile shape not recognized (no importers/specifiers/dependencies sections)" };
}

/** Rewrite an npm package-lock.json so it records (spec, version). Pure. The
 *  stale integrity hash of the displaced version cannot be recomputed offline,
 *  so it is DROPPED when the version moves — npm re-fetches metadata on the
 *  next install instead of hard-failing verification against the old bytes. */
export function patchNpmLock(raw: string, spec: string, version: string): PnpmPatch {
    let doc: { packages?: Record<string, Record<string, unknown>> };
    try {
        doc = JSON.parse(raw) as { packages?: Record<string, Record<string, unknown>> };
    } catch {
        return { kind: "fail", reason: "malformed package-lock.json — manual repair needed" };
    }
    if (doc.packages === undefined) return { kind: "fail", reason: "package-lock.json has no packages map" };
    const details: LedgerChangeDetail[] = [];
    const root = doc.packages[""];
    if (root === undefined) return { kind: "fail", reason: "package-lock.json has no root (\"\") package entry" };
    const deps = (typeof root.dependencies === "object" && root.dependencies !== null ? root.dependencies : {}) as Record<string, unknown>;
    if (typeof deps[DSH_PACKAGE] === "string" && deps[DSH_PACKAGE] !== spec) {
        details.push({ file: "package-lock.json", field: "root dependencies[billion-context]", before: String(deps[DSH_PACKAGE]), after: spec });
    }
    deps[DSH_PACKAGE] = spec;
    root.dependencies = deps;
    const entry = doc.packages[`node_modules/${DSH_PACKAGE}`];
    if (entry === undefined) return { kind: "fail", reason: `package-lock.json has no node_modules/${DSH_PACKAGE} entry — manual repair needed` };
    if (typeof entry.version === "string" && entry.version !== version) {
        details.push({ file: "package-lock.json", field: "version", before: entry.version, after: version });
        entry.version = version;
        if (typeof entry.resolved === "string" && entry.resolved.includes(`/${DSH_PACKAGE}/-/${DSH_PACKAGE}-`)) {
            const nextResolved = entry.resolved.replace(new RegExp(`${PKG_ESCAPED}-[^/"]*\\.tgz$`), `${DSH_PACKAGE}-${version}.tgz`);
            if (nextResolved !== entry.resolved) details.push({ file: "package-lock.json", field: "resolved", before: entry.resolved, after: nextResolved });
            entry.resolved = nextResolved;
        }
        if (entry.integrity !== undefined) {
            details.push({ file: "package-lock.json", field: "integrity", before: "stale hash dropped", after: "(removed — re-fetched on next install)" });
            delete entry.integrity;
        }
    }
    return { kind: "ok", next: JSON.stringify(doc, null, 2) + "\n", details };
}

/** Atomic text write with the #2972-M1/#3157 discipline (tmp sibling + fsync
 *  + rename): a crash mid-write leaves the host-owned file byte-identical. */
function atomicWriteText(file: string, content: string): string | undefined {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        const fd = fs.openSync(tmp, "w");
        try {
            fs.writeFileSync(fd, content);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (e) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            /* best-effort cleanup */
        }
        return e instanceof Error ? e.message : String(e);
    }
    return undefined;
}

/**
 * Converge a profile's three ledgers to `targetVersion` (the on-disk copy's
 * version — the caller verifies copy === target before calling; this function
 * re-checks as a guard against racing writers). Single transaction: EVERY
 * planned write is computed and validated BEFORE anything is touched; a
 * healthy profile produces ZERO writes. Never throws — failures carry a
 * reason and leave all files untouched (a partially-written state is worse
 * than an untouched wedge, which detection still reports).
 *
 * Authority boundary: bili only rewrites the manifest spec in the forms
 * #2894 owns (^x.y.z / x.y.z). A spec that does not admit the copy but lies
 * outside that authority (tilde, dist-tag, range, local pin) is REFUSED, not
 * papered over — syncing the lockfile to the copy under such a spec would
 * produce a record pnpm itself calls unsatisfiable, i.e. a wedge wearing a
 * green badge. The finding stays visible; the user aligns the declaration.
 *
 * `opts.integrity` (#7125): the target version's registry SRI hash. When
 * given, the pnpm store sections are synced so the new importer record has
 * its resolution data; a version move that CANNOT be completed safely (new
 * hash unknown while the old entry carries one) fails with a reason and
 * ZERO writes instead of leaving an inconsistent lockfile behind.
 */
export function convergeDshLedger(profileDir: string, targetVersion: string, opts?: { integrity?: string }): LedgerConvergenceResult {
    const notes: string[] = [];
    const state = readDshLedgerState(profileDir);
    // A failed convergence leaves every ledger that EXISTS still recording the
    // old version while the copy moved — that divergence is what keeps the
    // displaced copy alive as the rollback source (the caller reads it).
    const ledgersPresent = state.spec !== undefined || state.lockKind !== "none";
    const fail = (error: string): LedgerConvergenceResult => ({ changed: [], details: [], notes, error, divergent: ledgersPresent });

    const spec = state.spec;
    if (spec === undefined) return fail("no billion-context dependency declared in the profile manifest — nothing to converge");
    if (!isRegistryDepSpec(spec)) {
        notes.push(`local pin ${spec} respected — nothing written`);
        return { changed: [], details: [], notes };
    }
    if (state.copyVersion === undefined) return fail("no readable bundle copy under node_modules — converge needs the on-disk version as the meeting point (reinstall through the host channel first)");
    if (state.copyVersion !== targetVersion) {
        return fail(`on-disk copy is v${state.copyVersion}, not v${targetVersion} — refusing to converge against a moving target`);
    }

    // Manifest half — the exact #2894 rules, shared with the self-heal hook.
    const plan = planDshProfileManifestSpec(profileDir, targetVersion);
    let finalSpec = spec;
    if (plan.action === "rewrite") {
        finalSpec = plan.nextSpec ?? spec;
    } else if (plan.reason !== undefined && plan.reason.startsWith("non-version spec")) {
        // dist-tag / range / tilde: bili may not rewrite it. Admitting (or
        // unjudgeable) specs can still ride along — the lockfile converges and
        // the declaration stays the user's.
        if (specAdmits(spec, targetVersion) === false) {
            return fail(`manifest spec ${spec} does not admit the on-disk v${targetVersion} and is outside bili's rewrite authority (only ^x.y.z / x.y.z forms are converged) — align the declaration yourself, or reinstall through the host channel`);
        }
        notes.push(`spec ${spec} kept as declared (not a convergable form)`);
    } else if (plan.reason !== undefined) {
        // Defensive: spec was readable above, so plan's remaining reasons
        // ("no readable/malformed package.json") are unreachable here — but a
        // racing writer could change that between the two reads; fail clean.
        return fail(plan.reason);
    }

    // Lockfile half — planned in memory before any disk touch.
    let lockNext: string | undefined;
    let lockDetails: LedgerChangeDetail[] = [];
    if (state.lockKind === "none") {
        notes.push("no lockfile present — manifest/copy agreement is the whole story");
    } else {
        const lockFile = state.lockKind === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
        let raw: string;
        try {
            raw = fs.readFileSync(path.join(profileDir, lockFile), "utf8");
        } catch {
            return fail(`lockfile ${lockFile} vanished between read and patch — retry`);
        }
        const patch = state.lockKind === "pnpm"
            ? patchPnpmLock(raw, finalSpec, targetVersion, { integrity: opts?.integrity, deps: state.copyDeps })
            : patchNpmLock(raw, finalSpec, targetVersion);
        if (patch.kind === "fail") return fail(patch.reason);
        // Zero-writes contract: an already-in-step record produces NO write —
        // not even a byte-identical re-serialization (mtime churn on a
        // host-owned file is a write the user did not ask for).
        if (patch.details.length > 0) {
            lockNext = patch.next;
            lockDetails = patch.details;
        }
    }

    // Execute — both plans validated; each write is atomic on its own.
    const changed: string[] = [];
    const details: LedgerChangeDetail[] = [];
    if (plan.action === "rewrite") {
        const err = atomicWriteText(path.join(profileDir, "package.json"), plan.nextRaw ?? "");
        if (err !== undefined) return { changed, details, notes, error: `manifest write failed: ${err}`, divergent: ledgersPresent };
        changed.push("package.json");
        details.push({ file: "package.json", field: "dependencies[billion-context]", before: spec, after: finalSpec });
    }
    if (lockNext !== undefined) {
        const lockFile = state.lockKind === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
        const err = atomicWriteText(path.join(profileDir, lockFile), lockNext);
        if (err !== undefined) return { changed, details, notes, error: `lockfile write failed: ${err}${changed.length > 0 ? ` (package.json already updated — rerun to finish)` : ""}`, divergent: ledgersPresent };
        changed.push(lockFile);
        details.push(...lockDetails);
    }
    return { changed, details, notes };
}
