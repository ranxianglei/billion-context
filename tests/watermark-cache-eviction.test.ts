import assert from "node:assert/strict";
import test from "node:test";
import { pfCaptureIds, pfLearnStamp, pfRequestHeaders } from "../src/agent/pf-channel.ts";

const CONVERSATION = "x-bili-plugin-conversation";
function incoming(index: number): Record<string, string> {
    return { [CONVERSATION]: `cache-eviction-${index}` };
}
function learn(index: number): void {
    pfLearnStamp(incoming(index), 200, new Headers({ "x-bili-pf-seq": "2" }));
}

test("watermark capacity evicts one least recently used conversation and keeps other handshakes", () => {
    for (let i = 0; i < 1024; i++) {
        learn(i);
        pfCaptureIds(incoming(i)[CONVERSATION]!, [`a-${i}`, `b-${i}`, `c-${i}`]);
    }
    assert.equal(pfRequestHeaders(incoming(0))["x-bili-pf-count"], "2");
    for (let i = 2000; i < 4000; i++) assert.deepEqual(pfRequestHeaders(incoming(i)), {});
    learn(1024);
    assert.deepEqual(pfRequestHeaders(incoming(1)), {}, "the oldest unused conversation is evicted");

    let retained = 0;
    for (let i = 0; i <= 1024; i++) {
        const headers = pfRequestHeaders(incoming(i));
        if (i === 1) continue;
        assert.equal(headers["x-bili-pf-count"], "2", `stamp lost for ${i}`);
        if (i < 1024) assert.equal(headers["x-bili-pf-tail-ids"], `b-${i},c-${i}`);
        retained++;
    }
    assert.equal(retained, 1024);

    pfCaptureIds(incoming(0)[CONVERSATION]!, ["first", "updated"]);
    learn(1025);
    assert.deepEqual(pfRequestHeaders(incoming(2)), {}, "capture refreshes recency without losing the stamp");
    assert.deepEqual(pfRequestHeaders(incoming(0)), { "x-bili-pf-count": "2", "x-bili-pf-tail-ids": "updated" });
    learn(3);
    learn(1026);
    assert.deepEqual(pfRequestHeaders(incoming(4)), {}, "learning a stamp refreshes its existing slot");
    assert.equal(pfRequestHeaders(incoming(3))["x-bili-pf-count"], "2");
});
