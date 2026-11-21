import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, test } from "node:test";
import { neutralTurns } from "../src/affinity-neutral.ts";
import { PrefixAffinityResolver, rawChainFingerprint, setSimhashAdoptionEnabled, stableStringify } from "../src/prefix-affinity.ts";

type Wire = "openai" | "anthropic" | "responses" | "google";
const wires: Wire[] = ["openai", "anthropic", "responses", "google"];
const question = "Inspect the JSON setting and report its exact retained value.";
const result = "Inspection completed.";

before(() => setSimhashAdoptionEnabled(false));
after(() => setSimhashAdoptionEnabled(true));

function argumentsWith(value: string): Record<string, unknown> {
    return JSON.parse('{"path":"settings.json","patch":{"__proto__":{"label":"' + value + '"}}}') as Record<string, unknown>;
}

function renders(args: Record<string, unknown>): Record<Wire, unknown[]> {
    return {
        openai: [
            { role: "user", content: question },
            { role: "assistant", content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "inspect_json", arguments: JSON.stringify(args) } }] },
            { role: "tool", tool_call_id: "call1", content: result },
        ],
        anthropic: [
            { role: "user", content: [{ type: "text", text: question }] },
            { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "inspect_json", input: args }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: result }] },
        ],
        responses: [
            { type: "message", role: "user", content: [{ type: "input_text", text: question }] },
            { type: "function_call", call_id: "call1", name: "inspect_json", arguments: JSON.stringify(args) },
            { type: "function_call_output", call_id: "call1", output: result },
        ],
        google: [
            { role: "user", parts: [{ text: question }] },
            { role: "model", parts: [{ functionCall: { name: "inspect_json", args } }] },
            { role: "user", parts: [{ functionResponse: { name: "inspect_json", response: { output: result } } }] },
        ],
    };
}

function note(resolver: PrefixAffinityResolver, history: unknown[]): string {
    const resolved = resolver.resolve(history);
    assert.ok(resolved);
    resolver.note(resolved.sessionId, resolved.incomingDepth, resolved.tailHash,
        resolved.itemHashes, false, resolved.sketches, resolved.userFlags);
    return resolved.sessionId;
}

for (const value of ["null", "false", "0", '"literal"', '{"z":2,"a":1}', '["nested",{"x":3}]']) {
    test(`affinity canonical JSON retains an own __proto__ value: ${value}`, () => {
        const input = JSON.parse('{"z":1,"nested":[{"__proto__":' + value + ',"a":2}]}') as { nested: Array<Record<string, unknown>> };
        const before = JSON.stringify(input);
        const actual = JSON.parse(stableStringify(input)) as { nested: Array<Record<string, unknown>> };
        assert.equal(Object.hasOwn(actual.nested[0]!, "__proto__"), true);
        assert.deepEqual(actual, input);
        assert.equal(JSON.stringify(input), before, "canonicalization does not mutate arguments");
        assert.equal(Object.getPrototypeOf(input.nested[0]), Object.prototype);
        assert.equal(Object.getPrototypeOf(actual.nested[0]), Object.prototype);
    });
}

test("affinity canonical JSON distinguishes omission and different own prototype-named values", () => {
    const values = ["null", "false", "0", '"literal"', '{"label":"alpha"}', '{"label":"beta"}'];
    const canonical = values.map((value) => stableStringify(JSON.parse('{"__proto__":' + value + '}')));
    assert.equal(new Set([...canonical, stableStringify({})]).size, values.length + 1);
});

for (const wire of wires) {
    test(`${wire}: changed own JSON fields cannot reuse an exact-prefix session`, () => {
        const resolver = new PrefixAffinityResolver();
        const first = renders(argumentsWith("alpha"))[wire];
        const changed = renders(argumentsWith("beta"))[wire];
        const sessionId = note(resolver, first);
        const resolved = resolver.resolve(changed);
        assert.ok(resolved);
        assert.notEqual(resolved.sessionId, sessionId);
        assert.equal(resolved.via, "new");
        assert.equal(resolved.matchedDepth, 0);
    });

    test(`${wire}: reordered own JSON fields preserve cross-wire session continuity`, () => {
        const original = argumentsWith("alpha");
        const reordered = JSON.parse('{"patch":{"__proto__":{"label":"alpha"}},"path":"settings.json"}') as Record<string, unknown>;
        const resolver = new PrefixAffinityResolver();
        const sessionId = note(resolver, renders(original).openai);
        const resolved = resolver.resolve(renders(reordered)[wire]);
        assert.ok(resolved);
        assert.equal(resolved.sessionId, sessionId);
        assert.equal(resolved.via, "prefix");
        const calls = neutralTurns(renders(reordered)[wire]).find((turn) => turn.kind === "assistant")!.calls!;
        assert.deepEqual(calls, ['inspect_json\u0000{"patch":{"__proto__":{"label":"alpha"}},"path":"settings.json"}']);
    });

    test(`${wire}: a legacy raw snapshot matches its own JSON but rejects changed arguments`, () => {
        const original = renders(argumentsWith("alpha"))[wire];
        const raw = rawChainFingerprint(original);
        assert.ok(raw);
        const resolver = new PrefixAffinityResolver();
        assert.equal(resolver.importSnapshot([{ sessionId: "pfa-legacy-json-key", ...raw, lastSeen: Date.now() }]), 1);
        const same = resolver.resolve(original);
        assert.ok(same);
        assert.equal(same.sessionId, "pfa-legacy-json-key");
        assert.equal(same.via, "prefix");
        const changed = resolver.resolve(renders(argumentsWith("beta"))[wire]);
        assert.ok(changed);
        assert.notEqual(changed.sessionId, same.sessionId);
        assert.equal(changed.via, "new");
    });
}

test("opaque content and structured tool results retain prototype-named JSON fields", () => {
    for (const role of ["user", "tool"]) {
        const first = [{ role, content: [{ type: "document", data: argumentsWith("alpha") }] }];
        const changed = [{ role, content: [{ type: "document", data: argumentsWith("beta") }] }];
        assert.notDeepEqual(neutralTurns(first), neutralTurns(changed));
    }
});

test("legacy cache hints are still excluded while own content keys contribute", () => {
    const plain = renders(argumentsWith("alpha")).anthropic;
    const withHint = structuredClone(plain) as Array<Record<string, unknown>>;
    withHint[1]!.cache_control = { type: "ephemeral" };
    assert.deepEqual(rawChainFingerprint(plain), rawChainFingerprint(withHint));
    assert.notDeepEqual(rawChainFingerprint(plain), rawChainFingerprint(renders(argumentsWith("beta")).anthropic));
});

test("ordinary JSON keeps its established canonical output and affinity fingerprints", () => {
    assert.equal(stableStringify({ z: 2, constructor: "data", prototype: { toString: "literal", a: 1 }, a: [3, 4] }),
        '{"a":[3,4],"constructor":"data","prototype":{"a":1,"toString":"literal"},"z":2}');
    const ordinary = renders({ path: "settings.json", patch: { label: "alpha" } }).openai;
    assert.equal(rawChainFingerprint(ordinary)!.tailHash, "58f574ee4de7076691a874488960ffbdb7f4e0ab5d6f56fc142989d93dba53f8");
    const resolved = new PrefixAffinityResolver().resolve(ordinary)!;
    assert.equal(resolved.tailHash, "5fac85a550621046cb9580d52c586249e30ea482883a9adea6919afc2998394f");
    assert.equal(resolved.sessionId, "pfa-f1fc8d1a71e03bed");
});

// Captured on 548e396: these snapshots omitted the original own JSON key.
const lossySnapshots = [
    {
        hv: 2 as const,
        tailHash: "cf7f81bf0b56e3bb42884784df9e02f0a54070bec37f0616e1016d51e84b869f",
        itemHashes: [
            "1253c021a11fd1c64abe469fb110e0bad0e48feeb48a730cad1d7daa0609e40f",
            "a0e20066388df753f74fdec00e3fd43140bcbf8be4ddc7764981f3756c0bcccd",
            "d42bf03d7ef0e8782bd520b2834c491c31d5cb29465963c935afb4aeff5ea568",
        ],
    },
    {
        tailHash: "08d14c2a28a75ca317f1263752919eadc90179433b3ef802e57eaaaba2ade370",
        itemHashes: [
            "9e33ce45f62f5906c030b289713c93759b9008643e63d6f1c679e24ac8392423",
            "cce60e5880ba4fc48a1a2755377ab0c303e38d7bc81c5926cd734fd594522543",
            "2f7ad1c96536faac720256ec7a82ffa7177554b27bfa3a34b222fbcb3fdefea8",
        ],
    },
];

for (const snapshot of lossySnapshots) {
    test(`old hash domain ${"hv" in snapshot ? snapshot.hv : 1} snapshots cannot recover discarded JSON fields`, () => {
        const resolver = new PrefixAffinityResolver();
        assert.equal(resolver.importSnapshot([{ sessionId: "old-lossy-key", depth: 3, lastSeen: Date.now(), ...snapshot }]), 1);
        for (const value of ["alpha", "beta"]) {
            const resolved = resolver.resolve(renders(argumentsWith(value)).anthropic)!;
            assert.notEqual(resolved.sessionId, "old-lossy-key");
            assert.equal(resolved.via, "new");
        }
    });
}

test("anonymous HTTP requests retain tool arguments and separate changed own JSON keys", { timeout: 30_000 }, async () => {
    const { startServer } = await import("../src/server.ts");
    const { loadOptions } = await import("../src/config.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { prefixAffinity } = await import("../src/prefix-affinity.ts");
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Acknowledged." } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3 } })}\n\n`);
            res.end("data: [DONE]\n\n");
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const origin = `http://127.0.0.1:${upstreamAddress.port}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer({
            ...loadOptions({}), port: 0, host: "127.0.0.1", upstream: origin,
            routes: { [origin]: { models: { "json-key-probe": { context: 200_000 } } } },
            modelContextLimit: 200_000, compress: { injectTool: true, injectNudge: false },
            promptCache: { routing: "auto" }, passthrough: false, autoUpdate: false,
            autoRestartOnUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] }, log: false, debug: false,
        });
        await once(proxy, "listening");
        const address = proxy.address();
        assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/bili/${origin}/v1/chat/completions`;
        const reordered = JSON.parse('{"patch":{"__proto__":{"label":"beta"}},"path":"settings.json"}') as Record<string, unknown>;
        const argumentsList = [argumentsWith("alpha"), argumentsWith("beta"), reordered];
        const sessionCounts: number[] = [];
        for (const args of argumentsList) {
            const response = await fetch(url, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: "json-key-probe", stream: true, messages: renders(args).openai }),
            });
            const body = await response.text();
            assert.equal(response.status, 200, body);
            sessionCounts.push(prefixAffinity.trackedSessionIds().length);
        }
        assert.deepEqual(sessionCounts, [1, 2, 2], "changed content forks, equivalent key order replays");
        assert.equal(captured.length, argumentsList.length);
        for (const [index, raw] of captured.entries()) {
            const request = JSON.parse(raw) as { messages: Array<{ tool_calls?: Array<{ function: { name: string; arguments: string } }> }> };
            const call = request.messages.flatMap((message) => message.tool_calls ?? []).find((item) => item.function.name === "inspect_json");
            assert.ok(call);
            assert.equal(call.function.arguments, JSON.stringify(argumentsList[index]), "forwarded argument bytes remain exact");
        }
    } finally {
        if (proxy) await new Promise<void>((resolve, reject) => proxy!.close((error) => error ? reject(error) : resolve()));
        await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
});
