// #3356/#3525: bounded teardown for in-test http servers.
//
// The win22 drain-cancel flake family (#3356): a harness awaits a server's
// 'close' event after close(); if 'close' never fires (connection accounting
// stuck under load), that promise stays pending with ZERO active handles —
// the event loop drains and node:test cancels the whole file with
// "Promise resolution is still pending but the event loop has already
// resolved", before any per-test timeout can even start ticking. Two
// structural gaps this closes:
//   1. once(server, "close") attached AFTER close() can miss an early
//      emission; capturing server.close(cb) synchronously cannot.
//   2. An unbounded await has no backstop; a ref'd guard timer keeps the
//      loop alive for the window, so a residual hang surfaces as a named
//      error instead of a silent drain-cancel cascade.

import type { Server } from "node:http";

const HARNESS_CLOSE_TIMEOUT_MS = 10_000;

export async function closeServers(servers: Server[], label = "harness"): Promise<void> {
    const closings = servers.map((s) => new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
    }));
    // closeAllConnections destroys keep-alive sockets that close() alone
    // would wait on forever (server.close only completes once every
    // connection ends).
    for (const s of servers) {
        s.closeIdleConnections?.();
        s.closeAllConnections?.();
    }
    const all = Promise.all(closings);
    all.catch(() => {}); // the guard may win first; a late rejection must not leak unhandled
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(
                `${label}: server 'close' did not fire within ${HARNESS_CLOSE_TIMEOUT_MS}ms — #3356 win22 teardown-hang class; name the stuck server instead of retrying blindly`,
            )),
            HARNESS_CLOSE_TIMEOUT_MS,
        );
    });
    try {
        await Promise.race([all, guard]);
    } finally {
        clearTimeout(timer);
    }
}
