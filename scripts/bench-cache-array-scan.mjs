import { performance } from "node:perf_hooks";
import { getCacheLedger, noteForwardedBody, settleUsageReport } from "../src/cache-ledger.ts";

const counts = process.argv.slice(2).map(Number);
for (const count of counts.length ? counts : [1000, 4000, 8000]) {
    const messages = Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Turn ${i}: ${"Conversation text with ordinary words. ".repeat(10)}`,
    }));
    const first = JSON.stringify({ model: "m", messages, max_tokens: 16384, stop: ["end-of-turn", "stop-marker-one", "stop-marker-two", "presence-padding-field"] });
    const next = JSON.stringify({ model: "m", messages: [...messages, { role: "user", content: "Continue the conversation." }], max_tokens: 16384, stop: ["end-of-turn", "stop-marker-one", "stop-marker-two", "presence-padding-field"] });
    const times = [];
    for (let run = 0; run < 4; run++) {
        const session = { id: `array-scan-${count}-${run}`, metadata: {}, stats: {}, state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} } };
        const report = { total: 100_000, reportedCached: 99_000, output: 0, protocol: "openai", upstream: "http://fixture" };
        noteForwardedBody(session, first, count);
        settleUsageReport(session, report);
        const start = performance.now();
        noteForwardedBody(session, next, count + 1);
        settleUsageReport(session, report);
        const elapsed = performance.now() - start;
        const bodyClass = getCacheLedger(session).lines.at(-1)?.bs;
        if (bodyClass !== "tail") throw new Error(`unexpected body class: ${bodyClass}`);
        if (run > 0) times.push(elapsed);
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ count, bytes: Buffer.byteLength(first), medianMs: times[1], samplesMs: times }));
}
