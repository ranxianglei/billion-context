import type { WireProtocol } from "./util.js";

/** Append `text` as a trailing user turn on the wire's own request body.
 *
 *  Every post-hoc mutation of an ALREADY assembled body goes through here (the
 *  fake-completion hint and the degenerate-turn continuation nudge): each wire
 *  marks a user turn differently, and back-to-back user turns break the
 *  grouping strict providers apply to the replayed conversation, so the text is
 *  MERGED into the last user turn when there is one and a fresh user turn is
 *  started only when there is not.
 *
 *  Returns null when the body is unparseable or carries no turn array — the
 *  caller skips the mutation rather than sending a body it has mangled. */
export function appendTrailingUserText(protocol: WireProtocol, body: string | Buffer, text: string): string | null {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (protocol === "responses") {
        const input = obj.input;
        if (!Array.isArray(input)) return null;
        const arr = input as Record<string, unknown>[];
        const last = arr[arr.length - 1];
        if (last && typeof last === "object" && last.role === "user") {
            const c = last.content;
            if (typeof c === "string") last.content = `${c}\n\n${text}`;
            else if (Array.isArray(c)) last.content = [...c, { type: "input_text", text }];
            else last.content = text;
        } else {
            arr.push({ role: "user", content: [{ type: "input_text", text }] });
        }
        return JSON.stringify(obj);
    }
    if (protocol === "google") {
        // Gemini has no `messages` array: the conversation is `contents`, and a
        // trailing user turn is `{role:"user", parts:[{text}]}`. Merge into the
        // last user content when there is one (back-to-back user contents break
        // the client's own replay grouping), else start a new one.
        const contents = obj.contents;
        if (!Array.isArray(contents)) return null;
        const arr = contents as Record<string, unknown>[];
        const last = arr[arr.length - 1];
        if (last && typeof last === "object" && last.role === "user" && Array.isArray(last.parts)) {
            last.parts = [...(last.parts as unknown[]), { text }];
        } else {
            arr.push({ role: "user", parts: [{ text }] });
        }
        return JSON.stringify(obj);
    }
    const messages = obj.messages;
    if (!Array.isArray(messages)) return null;
    const arr = messages as Record<string, unknown>[];
    const last = arr[arr.length - 1];
    if (last && typeof last === "object" && last.role === "user") {
        const c = last.content;
        if (typeof c === "string") last.content = `${c}\n\n${text}`;
        else if (Array.isArray(c)) last.content = [...c, { type: "text", text }];
        else last.content = text;
    } else {
        arr.push({ role: "user", content: text });
    }
    return JSON.stringify(obj);
}
