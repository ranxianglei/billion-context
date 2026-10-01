// #1689: a port handed out by listen(0)+close can be rebound by any parallel
// process before the consumer acts. assertPortDead probes-connect until the
// OS refuses, so call it as LATE as possible — immediately before the spawn /
// request that consumes the port; an early probe shrinks nothing. Residual
// risk: a squatter can still land in the final gap (RFC5737 targets rejected
// per #1689: unroutable packets hang until connect-timeout).

import net from "node:net";

export function canConnect(port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host });
        const done = (ok: boolean): void => {
            if (!sock.destroyed) sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
    });
}

export async function assertPortDead(
    port: number,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const intervalMs = opts.intervalMs ?? 50;
    const label = opts.label ?? `port ${port}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (!(await canConnect(port))) return;
        if (Date.now() >= deadline) {
            throw new Error(`assertPortDead: ${label} still accepting connections after ${timeoutMs}ms — squatted between freePort() and use (#1689)`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
