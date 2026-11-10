/** Codex cloud-compaction checkpoint signal.
 *
 *  The DSH codex adapter (dsh-codex-subscription) is the only component that
 *  knows when OpenAI's server-side compaction produced a checkpoint and
 *  whether the request it is about to send installs it for the first time or
 *  merely reuses it. It stamps that fact on the model request; bili consumes
 *  it as the AUTHORITATIVE compaction boundary instead of guessing from
 *  message text or counting missing ids.
 *
 *  Everything here is optional: a request without the headers (real Codex
 *  CLI, other clients) keeps the existing structural detection. */

const CODEX_CHECKPOINT_HEADER = "x-bili-codex-checkpoint";
const CODEX_CHECKPOINT_SEQ_HEADER = "x-bili-codex-checkpoint-seq";
const CODEX_CHECKPOINT_STATE_HEADER = "x-bili-codex-checkpoint-state";
const CODEX_CHECKPOINT_COVERED_HEADER = "x-bili-codex-checkpoint-covered";
const CODEX_CHECKPOINT_DIGEST_HEADER = "x-bili-codex-checkpoint-digest";

export const CODEX_CHECKPOINT_METADATA_KEY = "codexCloudCheckpoint";

type CodexCheckpointState = "fresh" | "reuse";

type CodexCheckpointSignal = {
    checkpointId: string;
    seq: number;
    state: CodexCheckpointState;
    covered: number;
    digest?: string;
};

type CodexCheckpointRecord = {
    id: string;
    seq: number;
    at: number;
    covered: number;
    digest?: string;
};

const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST_RE = /^[a-f0-9]{16,128}$/;

function headerValue(headers: Record<string, unknown>, name: string): string {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value.trim() : "";
}

/** The checkpoint headers are stamped by dsh-codex-subscription inside DSH,
 *  where the envelope lane is `dsh` (not `codex`). A well-formed checkpoint
 *  header is the authoritative marker of the codex-cloud lane, so accept it
 *  from either declared plugin lane. */
export function codexCheckpointLane(headers: Record<string, string | string[] | undefined> | undefined): boolean {
    const raw = headers?.["x-bili-plugin"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") return false;
    const agent = value.trim().toLowerCase();
    return agent === "codex" || agent === "dsh";
}

export function parseCodexCheckpointSignal(headers: Record<string, unknown> | undefined): CodexCheckpointSignal | null {
    if (!headers) return null;
    const checkpointId = headerValue(headers, CODEX_CHECKPOINT_HEADER);
    const stateRaw = headerValue(headers, CODEX_CHECKPOINT_STATE_HEADER);
    if (!checkpointId || !ID_RE.test(checkpointId)) return null;
    if (stateRaw !== "fresh" && stateRaw !== "reuse") return null;
    const seq = Number(headerValue(headers, CODEX_CHECKPOINT_SEQ_HEADER));
    if (!Number.isInteger(seq) || seq < 1 || seq > 1_000_000_000) return null;
    const coveredRaw = headerValue(headers, CODEX_CHECKPOINT_COVERED_HEADER);
    const covered = coveredRaw === "" ? 0 : Number(coveredRaw);
    if (!Number.isInteger(covered) || covered < 0 || covered > 10_000_000) return null;
    const digest = headerValue(headers, CODEX_CHECKPOINT_DIGEST_HEADER);
    if (digest && !DIGEST_RE.test(digest)) return null;
    return { checkpointId, seq, state: stateRaw, covered, digest: digest || undefined };
}

/** True when this signal announces a remote compaction checkpoint the proxy
 *  has not rebased for yet. Identity, not the client's local "fresh" flag, is
 *  authoritative: a client that loses a request (or restarts) re-announces an
 *  already created checkpoint as `reuse`, and that must still close the
 *  generation. The same checkpoint id with the same seq (retry, duplicate
 *  delivery, plugin restart) never resets twice; a higher seq means the same
 *  checkpoint now summarizes a longer prefix. */
export function isNewCodexBoundary(record: CodexCheckpointRecord | null, signal: CodexCheckpointSignal): boolean {
    if (!record) return true;
    if (record.id !== signal.checkpointId) return true;
    return signal.seq > record.seq;
}

export function readCodexCheckpoint(session: { metadata: Record<string, unknown> }): CodexCheckpointRecord | null {
    const raw = session.metadata[CODEX_CHECKPOINT_METADATA_KEY];
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.seq !== "number") return null;
    return {
        id: value.id,
        seq: value.seq,
        at: typeof value.at === "number" ? value.at : 0,
        covered: typeof value.covered === "number" ? value.covered : 0,
        digest: typeof value.digest === "string" ? value.digest : undefined,
    };
}

export function codexCheckpointRecord(signal: CodexCheckpointSignal, at: number): CodexCheckpointRecord {
    return { id: signal.checkpointId, seq: signal.seq, at, covered: signal.covered, digest: signal.digest };
}
