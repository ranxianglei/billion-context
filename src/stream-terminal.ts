// #321 PR-C: terminal-state observer for native-compaction responses. The
// rebase marker may only fire on "completed": a failed/incomplete/truncated
// stream means the client kept its history, and rebasing on a compaction that
// never happened discards valid blocks (#249). "unknown" is the safe default
// (no rebase; the next request self-heals via kernel message-id deactivation).

export type TerminalState = "completed" | "failed" | "unknown";

const SUCCEEDED = "response.completed";
const FAILED_EVENTS = new Set(["response.failed", "response.incomplete"]);
const MAX_JSON_BYTES = 16 << 20;

export async function observeResponsesTerminalState(stream: ReadableStream<Uint8Array>, isStream: boolean): Promise<TerminalState> {
    return isStream ? observeSseTerminalState(stream) : observeJsonTerminalState(stream);
}

function terminalFromSseLine(line: string): TerminalState | null {
    if (line.startsWith("event:")) {
        const name = line.slice(6).trim();
        if (name === SUCCEEDED) return "completed";
        if (FAILED_EVENTS.has(name)) return "failed";
        return null;
    }
    if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (!data.startsWith("{")) return null;
        try {
            const type = (JSON.parse(data) as { type?: unknown }).type;
            if (type === SUCCEEDED) return "completed";
            if (type === "response.failed" || type === "response.incomplete") return "failed";
        } catch {
            return null;
        }
    }
    return null;
}

async function observeSseTerminalState(stream: ReadableStream<Uint8Array>): Promise<TerminalState> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let state: TerminalState = "unknown";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, "");
                buf = buf.slice(nl + 1);
                const next = terminalFromSseLine(line);
                if (next !== null) {
                    state = next;
                    break;
                }
            }
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
    if (rec.error !== undefined) return "failed";
    if (Array.isArray(rec.output)) return "completed";
    return "unknown";
}
