// #321 PR-C: terminal-state observer for native-compaction responses. The
// rebase marker may only fire on "completed": a failed/incomplete/truncated
// stream means the client kept its history, and rebasing on a compaction that
// never happened discards valid blocks (#249). "unknown" is the safe default
// (no rebase; the next request self-heals via kernel message-id deactivation).

type TerminalState = "completed" | "failed" | "unknown";

const SUCCEEDED = "response.completed";
const FAILED_EVENTS = new Set(["response.failed", "response.incomplete"]);
const MAX_JSON_BYTES = 16 << 20;

export async function observeResponsesTerminalState(stream: ReadableStream<Uint8Array>, isStream: boolean): Promise<TerminalState> {
    return isStream ? observeSseTerminalState(stream) : observeJsonTerminalState(stream);
}

function terminalFromSseFrame(frame: string): TerminalState | null {
    let event = "";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.charAt(5) === " " ? line.slice(6) : line.slice(5));
    }
    if (data.length === 0) return null;
    let body: unknown;
    try {
        body = JSON.parse(data.join("\n"));
    } catch {
        return null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const type = (body as { type?: unknown }).type;
    if (FAILED_EVENTS.has(event) || (typeof type === "string" && FAILED_EVENTS.has(type))) return "failed";
    if (event === SUCCEEDED || type === SUCCEEDED) return "completed";
    return null;
}

async function observeSseTerminalState(stream: ReadableStream<Uint8Array>): Promise<TerminalState> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let lineParts: string[] = [];
    let frameLines: string[] = [];
    let skipLeadingLf = false;
    let state: TerminalState = "unknown";
    // A response.completed event can contain the entire compacted response.
    // Scan each decoded chunk once and join each line/frame once, rather than
    // re-normalizing and searching an ever-growing multi-MiB prefix per chunk.
    const consumeText = (text: string) => {
        let start = 0;
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (skipLeadingLf) {
                skipLeadingLf = false;
                if (code === 10) { start = index + 1; continue; }
            }
            if (code !== 10 && code !== 13) continue;
            lineParts.push(text.slice(start, index));
            const line = lineParts.join("");
            lineParts = [];
            if (line.length === 0) {
                const next = terminalFromSseFrame(frameLines.join("\n"));
                frameLines = [];
                if (next !== null) { state = next; return; }
            } else frameLines.push(line);
            skipLeadingLf = code === 13;
            start = index + 1;
        }
        if (start < text.length) lineParts.push(text.slice(start));
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                consumeText(decoder.decode());
                break;
            }
            consumeText(decoder.decode(value, { stream: true }));
            if (state !== "unknown") {
                // Release this tee branch; the client branch keeps draining the source.
                await reader.cancel().catch(() => {});
                break;
            }
        }
    } catch {
        return "unknown";
    } finally {
        reader.releaseLock();
    }
    return state;
}

async function observeJsonTerminalState(stream: ReadableStream<Uint8Array>): Promise<TerminalState> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!overflow) {
                size += value.length;
                if (size <= MAX_JSON_BYTES) {
                    chunks.push(Buffer.from(value));
                } else {
                    overflow = true;
                }
            }
        }
    } catch {
        return "unknown";
    } finally {
        reader.releaseLock();
    }
    if (overflow) return "unknown";
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return "unknown";
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return "unknown";
    }
    if (typeof body !== "object" || body === null) return "unknown";
    const rec = body as Record<string, unknown>;
    if (rec.error !== undefined && rec.error !== null) return "failed";
    if (rec.status === "failed" || rec.status === "incomplete" || rec.status === "cancelled") return "failed";
    if (rec.status !== undefined && rec.status !== "completed") return "unknown";
    if (Array.isArray(rec.output)) return "completed";
    return "unknown";
}
