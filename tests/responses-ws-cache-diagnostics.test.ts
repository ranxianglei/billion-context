import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ResponsesWsUpstream } from "../src/responses-ws.ts";

type Item = Record<string, unknown>;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const user = (text: string): Item => ({ type: "message", role: "user", content: text });
const output: Item[] = [{ type: "reasoning", encrypted_content: "private-reasoning" }];
const completed = (id: string, fields: Item = {}): Item => ({
    type: "response.completed", response: { id, status: "completed", output, ...fields },
});

async function fixture(replies: Array<Item | Item[]>) {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const rows: string[] = [];
    const sent: string[] = [];
    const logs: string[] = [];
    server.on("connection", peer => peer.on("message", raw => {
        rows.push(raw.toString());
        const reply = replies.shift() ?? { type: "error", error: { code: "unexpected-request" } };
        for (const item of Array.isArray(reply) ? reply : [reply]) {
            const frame = JSON.stringify(item);
            sent.push(frame);
            peer.send(frame);
        }
    }));
    const transport = new ResponsesWsUpstream((_level, message) => logs.push(message), undefined, undefined, true);
    return {
        rows, sent, logs, transport,
        diagnostics: (): Item[] => logs.filter(line => line.startsWith("upstream cache-diagnostic ")).map(line => JSON.parse(line.slice("upstream cache-diagnostic ".length)) as Item),
        turn: async (body: Item): Promise<string> => {
            const response = await transport.fetch(`http://127.0.0.1:${address.port}/responses?api-key=private-query-key`, {
                method: "POST",
                headers: { authorization: "Bearer private-auth-key", session_id: "private-session-header" },
                body: JSON.stringify(body),
            });
            return response.text();
        },
        close: async (): Promise<void> => {
            transport.close();
            for (const peer of server.clients) peer.terminate();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

for (const stream of [true, false]) {
    test(`WS cache diagnostics: zero and missing usage remain distinct (stream=${stream})`, { timeout: 10000 }, async () => {
        const cases = [
            { fields: { usage: { input_tokens: 2048, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } }, usage: true, details: true, present: true, cached: 0 },
            { fields: {}, usage: false, details: false, present: false, cached: null },
            { fields: { usage: { input_tokens: 2048 } }, usage: true, details: false, present: false, cached: null },
            { fields: { usage: { input_tokens_details: {} } }, usage: true, details: true, present: false, cached: null },
            { fields: { usage: { input_tokens_details: { cached_tokens: 1024 } } }, usage: true, details: true, present: true, cached: 1024 },
            { fields: { usage: { input_tokens_details: { cached_tokens: "private-invalid-usage" } } }, usage: true, details: true, present: true, cached: null },
            { fields: { usage: null }, usage: true, details: false, present: false, cached: null },
        ];
        const f = await fixture(cases.map((row, i) => completed(`resp_${i}`, row.fields)));
        try {
            let input = [user("private-prompt")];
            for (const [i, row] of cases.entries()) {
                const received = await f.turn({ model: "test-model", input, stream });
                if (stream) assert.equal(received, `event: response.completed\ndata: ${f.sent[i]}\n\n`);
                else assert.deepEqual(JSON.parse(received), JSON.parse(f.sent[i]).response);
                const terminal = f.diagnostics().filter(event => event.phase === "terminal").at(-1)!;
                assert.equal(terminal.usage_present, row.usage);
                assert.equal(terminal.input_tokens_details_present, row.details);
                assert.equal(terminal.cached_tokens_present, row.present);
                assert.equal(terminal.cached_tokens, row.cached);
                assert.equal(terminal.input_tokens_present, i === 0 || i === 2);
                assert.equal(terminal.input_tokens, i === 0 || i === 2 ? 2048 : null);
                assert.equal(terminal.output_tokens_present, i === 0);
                assert.equal(terminal.output_tokens, i === 0 ? 5 : null);
                assert.equal(terminal.event, "response.completed");
                assert.equal(terminal.response_id_sha256, hash(`resp_${i}`));
                assert.equal(terminal.connection, 1);
                assert.equal(terminal.send, i + 1);
                input = [...input, ...output, user("private-next-prompt")];
            }
            const log = f.logs.join("\n");
            for (const secret of ["private-prompt", "private-reasoning", "private-auth-key", "private-query-key", "private-session-header", "private-invalid-usage", "resp_0"]) assert.ok(!log.includes(secret), secret);
        } finally { await f.close(); }
    });
}

test("WS cache diagnostics: fingerprints describe exact egress, deltas and reconnects without changing bytes", { timeout: 10000 }, async () => {
    const f = await fixture([completed("resp_first"), completed("resp_second"), completed("resp_third"), completed("resp_fourth")]);
    try {
        const settings = { model: "test-model", instructions: "private-instructions", tools: [{ type: "function", name: "private-tool", parameters: {} }], prompt_cache_key: "private-cache-key" };
        const transportFields = { stream: true, stream_options: { include_usage: true } };
        const firstInput = [user("private-prompt")];
        const secondInput = [...firstInput, ...output, user("private-next-prompt")];
        const thirdInput = [...secondInput, ...output, user("private-third-prompt")];
        await f.turn({ ...settings, input: firstInput, ...transportFields });
        await f.turn({ ...settings, input: secondInput, ...transportFields });
        const changedSettings = { ...settings, instructions: "private-changed-instructions" };
        await f.turn({ ...changedSettings, input: thirdInput, ...transportFields });
        f.transport.close();
        await f.turn({ ...changedSettings, input: thirdInput, ...transportFields });
        assert.deepEqual(f.rows, [
            JSON.stringify({ ...settings, input: firstInput, ...transportFields, type: "response.create" }),
            JSON.stringify({ ...settings, input: [user("private-next-prompt")], previous_response_id: "resp_first", ...transportFields, type: "response.create" }),
            JSON.stringify({ ...changedSettings, input: thirdInput, ...transportFields, type: "response.create" }),
            JSON.stringify({ ...changedSettings, input: thirdInput, ...transportFields, type: "response.create" }),
        ]);
        const sends = f.diagnostics().filter(event => event.phase === "send");
        assert.equal(sends.length, 4);
        for (const [i, row] of sends.entries()) {
            assert.equal(row.frame_sha256, hash(f.rows[i]));
            assert.equal(row.send, i + 1);
            assert.equal(row.connection, i === 3 ? 2 : 1);
        }
        assert.deepEqual(sends.map(row => row.mode), ["full", "delta", "full", "full"]);
        // The send record is an allowlist. A hash of the full effective request is deliberately
        // absent: it costs a second full-body serialization on every send, including deltas.
        for (const row of sends) assert.deepEqual(Object.keys(row).sort(), ["connection", "frame_sha256", "mode", "phase", "previous_response_id_sha256", "send", "settings_sha256"]);
        assert.equal(sends[0].settings_sha256, sends[1].settings_sha256);
        assert.notEqual(sends[1].settings_sha256, sends[2].settings_sha256);
        assert.deepEqual(sends.map(row => row.previous_response_id_sha256), [null, hash("resp_first"), null, null]);
        for (const secret of ["private-prompt", "private-instructions", "private-changed-instructions", "private-tool", "private-cache-key", "private-auth-key", "private-query-key", "private-session-header", "private-reasoning", "resp_first"]) assert.ok(!f.logs.join("\n").includes(secret), secret);
    } finally { await f.close(); }
});

test("WS cache diagnostics: continuation recovery correlates terminal usage with the actual resend", { timeout: 10000 }, async () => {
    const rejection = { type: "error", status: 400, error: { code: "previous_response_not_found", message: "private-error-message" } };
    const f = await fixture([completed("resp_seed"), rejection, completed("resp_recovered", { usage: { input_tokens_details: { cached_tokens: 0 } } })]);
    try {
        const input = [user("seed")];
        await f.turn({ model: "test-model", input, stream: true });
        await f.turn({ model: "test-model", input: [...input, ...output, user("next")], stream: true });
        const rows = f.diagnostics();
        assert.deepEqual(rows.filter(row => row.phase === "send").map(row => [row.send, row.mode, row.connection]), [[1, "full", 1], [2, "delta", 1], [3, "full", 1]]);
        assert.deepEqual(rows.filter(row => row.phase === "terminal").map(row => [row.send, row.event]), [[1, "response.completed"], [2, "error"], [3, "response.completed"]]);
        assert.equal(rows.at(-1)?.cached_tokens, 0);
        assert.ok(!f.logs.join("\n").includes("private-error-message"));
    } finally { await f.close(); }
});

for (const event of ["response.completed", "response.failed", "response.incomplete", "error"]) {
    test(`WS cache diagnostics: only terminal ${event} is recorded`, { timeout: 10000 }, async () => {
        const terminal = event === "error"
            ? { type: event, error: { message: "private-error-message" } }
            : { type: event, response: { id: "private-response-id", status: event.slice("response.".length), output, usage: { input_tokens_details: { cached_tokens: 0 } } } };
        const f = await fixture([[
            { type: "response.created", response: { id: "private-created-id", usage: { input_tokens_details: { cached_tokens: 9999 } } } },
            { type: "response.output_text.delta", delta: "private-text-delta" },
            terminal,
        ]]);
        try {
            const received = await f.turn({ model: "test-model", input: [user("private-prompt")], stream: true });
            assert.equal(received, f.sent.map(frame => `event: ${(JSON.parse(frame) as Item).type}\ndata: ${frame}\n\n`).join(""));
            const rows = f.diagnostics();
            assert.equal(rows.length, 2);
            assert.equal(rows[0].phase, "send");
            assert.equal(rows[1].phase, "terminal");
            assert.equal(rows[1].event, event);
            assert.equal(rows[1].cached_tokens, event === "error" ? null : 0);
            assert.equal(rows[1].response_id_sha256, event === "error" ? null : hash("private-response-id"));
            for (const secret of ["private-text-delta", "private-error-message", "private-created-id", "private-response-id"]) assert.ok(!f.logs.join("\n").includes(secret), secret);
        } finally { await f.close(); }
    });
}
