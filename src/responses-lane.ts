import type * as http from "node:http";
import { Readable } from "node:stream";
import { ResponsesInputError, ResponsesInputHistory } from "./responses-input.js";

const history = new ResponsesInputHistory();
export function resetResponsesInputLane(): void { history.clear(); }

function reject(res: http.ServerResponse, status: number, error: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error }));
}

/** Re-enter the ordinary Responses pipeline with the actual caller's socket,
 * credentials and current parameters. Neither input items nor response SSE are
 * translated through the Anthropic codec. Caller has parsed/validated identity. */
export async function handleResponsesInputTurn(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    payload: Record<string, unknown>,
    conversationId: string,
    path: string,
    busy: Set<string>,
    forward: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>,
): Promise<void> {
    if (path.startsWith("//") || /[\r\n#]/.test(path) || !path.split("?")[0].endsWith("/responses"))
        return reject(res, 400, "Responses item lane requires a Responses model path");
    if (payload.msgIds !== undefined || payload.retouch !== undefined || payload.system !== undefined)
        return reject(res, 400, "Anthropic lane extensions cannot ride the Responses item lane");
    if (busy.has(conversationId)) return reject(res, 409, "turn-in-flight");
    busy.add(conversationId);
    try {
        const prepared = history.prepare(`${conversationId}\0${path}`, payload);
        const headers: http.IncomingHttpHeaders = { ...req.headers };
        delete headers["x-bili-plugin-turn"];
        delete headers["content-encoding"];
        headers["content-type"] = "application/json";
        headers["content-length"] = String(prepared.body.length);
        headers["x-bili-plugin-conversation"] = conversationId;
        const synthetic = Readable.from([prepared.body]) as unknown as http.IncomingMessage;
        Object.assign(synthetic, { method: "POST", url: path, headers, socket: req.socket });
        const writeHead = res.writeHead;
        let committed = false;
        // Preserve BOTH Node overloads (status, headers) and (status, text, headers).
        (res as { writeHead: unknown }).writeHead = (...args: unknown[]) => {
            const status = typeof args[0] === "number" ? args[0] : 0;
            if (status >= 200 && status < 300 && !committed) {
                prepared.commit();
                committed = true;
                res.setHeader("x-bili-applied-seq", String(prepared.appliedSeq));
            }
            return Reflect.apply(writeHead, res, args);
        };
        try {
            await forward(synthetic, res);
        } finally {
            res.writeHead = writeHead;
        }
    } catch (error) {
        if (error instanceof ResponsesInputError && !res.headersSent)
            return reject(res, error.status, error.message);
        throw error;
    } finally {
        busy.delete(conversationId);
    }
}
