import { log as loggerLog } from "./logger.js";

// #3456: message-shaped fabrication — the model invents a whole transcript
// continuation inside its own reasoning (fake user turns, fake attachment
// annotations like `Image "x.png" (sha256:…)`, fake follow-ups) and then
// answers them as if they were real input. The tag-echo family
// (#717/#1823/#2190/#2066/#2023) covers render-tag/ref-shaped residue and
// forged receipts; a fabricated ATTACHMENT IDENTIFIER (a sha256 digest or a
// file id that exists nowhere in this session's actual traffic) has no
// detector. Observe-first (#717 route): log only, never rewrite, never block.
// The reasoning channel rides an identity filter (#1960/KDD#10/#2229), so the
// bytes cannot be cleaned — detection is all the proxy can do here.
//
// Ledger semantics: every identifier seen in a REQUEST is "known" (the host
// shipped it — real or previously fabricated). The scan runs over THIS TURN'S
// fresh model output only, so each fabrication warns exactly once at birth;
// on later turns the fabrication re-enters through the request side and joins
// the known set silently. After a process restart the ledger is empty and the
// first request re-primes it.

const SHA256_ID = /sha256:([0-9a-fA-F]{64})\b/g;
// Store-path rendering of the same content-addressed digest — the DSH
// attachment library renders some turns as …objects/<shard>/<digest> with no
// sha256: prefix (both forms appeared in the #3456 session). Windows hosts
// render the path with backslashes — the incident record shows the escaped
// doubled-backslash form — so each separator accepts 1–2 slashes/backslashes.
const OBJECT_PATH_DIGEST = /\bobjects[\\/]{1,2}[0-9a-fA-F]{2}[\\/]{1,2}([0-9a-fA-F]{64})\b/g;
const FILE_API_ID = /\bfile-api-[A-Za-z0-9_-]{4,}/g;
// provider ledgers use camelCase fileId; the wire uses snake_case file_id.
const JSON_FILE_ID = /"(?:file_id|fileId)"\s*:\s*"([^"\s]{4,})"/g;

const MAX_IDS_PER_SESSION = 8192;
const MAX_LEDGERS = 2048;
const MAX_SHOWN_IN_WARN = 5;

interface PhantomLedger { known: Set<string>; }

const ledgers = new Map<string, PhantomLedger>();

function extractIds(text: string, out: Set<string>): void {
    for (const re of [SHA256_ID, OBJECT_PATH_DIGEST, FILE_API_ID, JSON_FILE_ID]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const raw = m[1] ?? m[0];
            // Digests are content-addressed and canonically lowercase —
            // normalize across renderings (sha256: prefix vs store path, any
            // case) so one blob dedupes against whichever form the request
            // shipped.
            const isDigest = re === SHA256_ID || re === OBJECT_PATH_DIGEST;
            out.add(isDigest ? raw.toLowerCase() : raw);
        }
    }
}

function ledgerFor(sessionId: string): PhantomLedger {
    let l = ledgers.get(sessionId);
    if (!l) {
        if (ledgers.size >= MAX_LEDGERS) {
            const oldest = ledgers.keys().next();
            if (!oldest.done) ledgers.delete(oldest.value);
        }
        l = { known: new Set() };
        ledgers.set(sessionId, l);
    }
    return l;
}

/** Request side: every attachment-shaped identifier in the shipped request
 *  text becomes known for this session. Role-agnostic by design — the scan
 *  only ever runs over fresh model output, so anything the host shipped is
 *  legitimately quotable by the model without warning. */
export function noteKnownAttachmentIds(sessionId: string | undefined, text: string): void {
    if (!sessionId || text.length === 0) return;
    const found = new Set<string>();
    extractIds(text, found);
    if (found.size === 0) return;
    const l = ledgerFor(sessionId);
    for (const id of found) {
        if (l.known.size >= MAX_IDS_PER_SESSION) break;
        l.known.add(id);
    }
}

/** Response side: warn once per unique identifier that appears in this turn's
 *  model output but nowhere in the session's request history. Each warned id
 *  joins the known set at warn time, so repeats within the same output or in
 *  later turns do not re-warn. */
export function scanModelOutputForPhantomAttachments(sessionId: string | undefined, text: string): void {
    if (!sessionId || text.length === 0) return;
    const found = new Set<string>();
    extractIds(text, found);
    if (found.size === 0) return;
    const l = ledgerFor(sessionId);
    const phantoms: string[] = [];
    for (const id of found) {
        if (l.known.has(id)) continue;
        l.known.add(id);
        phantoms.push(id);
    }
    if (phantoms.length === 0) return;
    const shown = phantoms.slice(0, MAX_SHOWN_IN_WARN).join(", ");
    loggerLog("warn", `[${sessionId}] [phantom-attachment] model output references ${phantoms.length} attachment id(s) absent from this session's request history (first-seen this turn): ${shown}${phantoms.length > MAX_SHOWN_IN_WARN ? ` …(+${phantoms.length - MAX_SHOWN_IN_WARN} more)` : ""} (#3456 observe-only)`);
}

export function resetPhantomLedgersForTest(): void {
    ledgers.clear();
}
