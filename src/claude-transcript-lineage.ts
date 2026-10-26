import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Explicit resume lineage for Claude Code sessions, read from the client's own
 * transcript (complements #1486's content match).
 *
 * Claude Code (and the Agent SDK's forkSession, used by opencode-claude when it
 * rewinds a failed turn) writes a fresh `<uuid>.jsonl` under
 * `<config>/projects/<encoded-cwd>/` whose copied lines carry
 * `forkedFrom: { sessionId, messageUuid }`. That is the authoritative parent of
 * the new `x-claude-code-session-id`; the byte-exact prefix match cannot see it
 * when the resumed request is not STRICTLY longer than the parent's last one or
 * when its tail was re-decorated (skills delta / session_start re-read
 * reminders) — the prefix resolver then falls back to a far older ancestor and
 * every block folded since is lost, re-folded from scratch.
 *
 * Trust: the transcript is a local file, so the caller only consults it for
 * loopback requests whose identity came from x-claude-code-session-id (main
 * lane, not a `|sub:` split). The parent it names still has to be a session
 * this proxy knows, and inheritance stays content-addressed (refs/blocks are
 * adopted only for raw ids present in the incoming request), so a wrong or
 * stale lineage can at worst inherit nothing.
 *
 * The project directory is not recomputed from the cwd (the SDK's encoding
 * involves realpath, non-alphanumeric replacement and long-path truncation +
 * hash): every `projects/*` directory is probed for `<uuid>.jsonl` instead.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only the head of the transcript is read — the fork marker rides on the
 *  copied history's first lines. */
const MAX_HEAD_BYTES = 256 * 1024;
/** Bound on the projects/* fan-out (one existsSync per directory). */
const MAX_PROJECT_DIRS = 2000;

function isClaudeSessionUuid(id: string): boolean {
    return UUID_RE.test(id);
}

/** Candidate Claude config roots: CLAUDE_CONFIG_DIR (Claude Code's own
 *  override), then ~/.claude. */
function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    const dirs: string[] = [];
    for (const v of [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude")]) {
        if (typeof v !== "string" || v.trim().length === 0) continue;
        const resolved = path.resolve(v.trim());
        if (!dirs.includes(resolved)) dirs.push(resolved);
    }
    return dirs;
}

/** Every `<config>/projects/*\/<id>.jsonl` that resolves (realpath) inside its
 *  projects root. */
function findTranscripts(sessionId: string, configDirs: string[]): string[] {
    const found: string[] = [];
    for (const dir of configDirs) {
        const projects = path.join(dir, "projects");
        let root: string;
        let entries: fs.Dirent[];
        try {
            root = fs.realpathSync(projects);
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        let probed = 0;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (++probed > MAX_PROJECT_DIRS) break;
            const candidate = path.join(root, entry.name, `${sessionId}.jsonl`);
            try {
                const real = fs.realpathSync(candidate);
                if (!real.startsWith(root + path.sep)) continue;
                if (!fs.statSync(real).isFile()) continue;
                if (!found.includes(real)) found.push(real);
            } catch {
                /* absent here: probe the next project directory */
            }
        }
    }
    return found;
}

/** First `forkedFrom.sessionId` (a UUID other than the transcript's own id) in
 *  the transcript head. Partial trailing lines (a transcript being written)
 *  are skipped; unparsable lines are ignored. */
function readForkedFrom(file: string, selfId: string): string | undefined {
    let head: string;
    let complete: boolean;
    try {
        const fd = fs.openSync(file, "r");
        try {
            const buf = Buffer.alloc(MAX_HEAD_BYTES);
            const n = fs.readSync(fd, buf, 0, MAX_HEAD_BYTES, 0);
            head = buf.subarray(0, n).toString("utf8");
            complete = n < MAX_HEAD_BYTES;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return undefined;
    }
    const lines = head.split("\n");
    if (!complete || !head.endsWith("\n")) lines.pop();
    for (const line of lines) {
        if (!line.includes("forkedFrom")) continue;
        let obj: unknown;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        const ff = (obj as { forkedFrom?: { sessionId?: unknown } } | null)?.forkedFrom;
        const parent = ff?.sessionId;
        if (typeof parent === "string" && isClaudeSessionUuid(parent) && parent.toLowerCase() !== selfId.toLowerCase()) return parent;
    }
    return undefined;
}

type TranscriptParentLookup =
    | { kind: "parent"; parentId: string; transcript: string }
    | { kind: "none"; reason: "invalid-id" | "no-transcript" | "no-fork-marker" | "ambiguous" };

/** The direct fork parent recorded in `sessionId`'s transcript. Ambiguous when
 *  transcripts with the same id in different config roots/projects name
 *  different parents — no guess is made then. */
export function claudeTranscriptParent(sessionId: string, configDirs: string[] = claudeConfigDirs()): TranscriptParentLookup {
    if (!isClaudeSessionUuid(sessionId)) return { kind: "none", reason: "invalid-id" };
    const files = findTranscripts(sessionId, configDirs);
    if (files.length === 0) return { kind: "none", reason: "no-transcript" };
    const parents = new Map<string, string>();
    for (const file of files) {
        const parent = readForkedFrom(file, sessionId);
        if (parent && !parents.has(parent)) parents.set(parent, file);
    }
    if (parents.size === 0) return { kind: "none", reason: "no-fork-marker" };
    if (parents.size > 1) return { kind: "none", reason: "ambiguous" };
    const [[parentId, transcript]] = [...parents.entries()];
    return { kind: "parent", parentId, transcript };
}

/** Walk the transcript fork chain upward until `isKnown` accepts an ancestor
 *  (a fork of a fork whose middle never went through this proxy still finds
 *  the nearest tracked ancestor). Depth-capped and cycle-safe. */
export function resolveClaudeTranscriptLineage(
    sessionId: string,
    isKnown: (id: string) => boolean,
    opts?: { configDirs?: string[]; maxDepth?: number },
): { parentId: string; hops: number } | { parentId: undefined; reason: string } {
    const configDirs = opts?.configDirs ?? claudeConfigDirs();
    const maxDepth = opts?.maxDepth ?? 8;
    const seen = new Set<string>([sessionId.toLowerCase()]);
    let current = sessionId;
    for (let hop = 1; hop <= maxDepth; hop++) {
        const step = claudeTranscriptParent(current, configDirs);
        if (step.kind === "none") return { parentId: undefined, reason: hop === 1 ? step.reason : `ancestor ${current}: ${step.reason}` };
        const key = step.parentId.toLowerCase();
        if (seen.has(key)) return { parentId: undefined, reason: "cycle" };
        seen.add(key);
        if (isKnown(step.parentId)) return { parentId: step.parentId, hops: hop };
        current = step.parentId;
    }
    return { parentId: undefined, reason: "depth-cap" };
}
