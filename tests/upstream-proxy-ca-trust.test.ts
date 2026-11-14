import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRootCA, mintHostCert, rootCaPath, _resetForTest as resetCa } from "../src/ca.ts";
import { _resetUpstreamCaForTest } from "../src/upstream-ca.ts";
import { connectThroughProxy, proxyDispatcher, resetProxyCache } from "../src/upstream-proxy.ts";

const directory = mkdtempSync(join(tmpdir(), "bili-proxy-ca-"));
let caFile: string;
let leaf: { keyPem: string; certPem: string };
let wrongHost: { keyPem: string; certPem: string };

before(() => {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = directory;
    try {
        resetCa();
        ensureRootCA();
        caFile = rootCaPath();
        leaf = mintHostCert("localhost");
        wrongHost = mintHostCert("different.example.test");
    } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
        resetCa();
    }
});

after(() => rmSync(directory, { recursive: true, force: true }));

async function scenario(options: {
    targetTls: boolean;
    proxyTls: boolean;
    trust: boolean;
    raw?: boolean;
    wrongTarget?: boolean;
    wrongProxy?: boolean;
}): Promise<string> {
    const previous = process.env.BILI_CA_FILE;
    if (options.trust) process.env.BILI_CA_FILE = caFile;
    else delete process.env.BILI_CA_FILE;
    _resetUpstreamCaForTest();
    resetProxyCache();
    const sockets = new Set<net.Socket>();
    const track = (socket: net.Socket): void => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
    };
    const targetLeaf = options.wrongTarget ? wrongHost : leaf;
    const proxyLeaf = options.wrongProxy ? wrongHost : leaf;
    const handler: http.RequestListener = (_req, res) => res.end("verified tunnel");
    const target = options.targetTls
        ? https.createServer({ key: targetLeaf.keyPem, cert: targetLeaf.certPem }, handler)
        : http.createServer(handler);
    const proxy = options.proxyTls
        ? https.createServer({ key: proxyLeaf.keyPem, cert: proxyLeaf.certPem })
        : http.createServer();
    target.on("connection", track);
    proxy.on("connection", track);
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetPort = (target.address() as net.AddressInfo).port;
    proxy.on("connect", (_req, client, head) => {
        const upstream = net.connect(targetPort, "127.0.0.1");
        track(upstream);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        upstream.once("connect", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            client.pipe(upstream).pipe(client);
        });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as net.AddressInfo).port;
    const proxyUrl = `${options.proxyTls ? "https" : "http"}://localhost:${proxyPort}`;
    try {
        if (options.raw) {
            const socket = await connectThroughProxy("localhost", targetPort, proxyUrl);
            socket.setTimeout(3_000, () => socket.destroy(new Error("test tunnel stalled")));
            socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
            const chunks: Buffer[] = [];
            for await (const chunk of socket) chunks.push(Buffer.from(chunk));
            return Buffer.concat(chunks).toString("utf8");
        }
        const response = await fetch(`${options.targetTls ? "https" : "http"}://localhost:${targetPort}`, {
            dispatcher: proxyDispatcher(proxyUrl, 3_000),
            signal: AbortSignal.timeout(3_000),
        } as RequestInit);
        assert.equal(response.status, 200);
        return await response.text();
    } finally {
        resetProxyCache();
        for (const socket of sockets) socket.destroy();
        await Promise.all([target, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
        if (previous === undefined) delete process.env.BILI_CA_FILE;
        else process.env.BILI_CA_FILE = previous;
        _resetUpstreamCaForTest();
    }
}

for (const [targetTls, proxyTls] of [[true, false], [false, true], [true, true]] as const) {
    test(`configured CA reaches target TLS=${targetTls} through proxy TLS=${proxyTls}`, async () => {
        assert.equal(await scenario({ targetTls, proxyTls, trust: true }), "verified tunnel");
    });
}

test("raw CONNECT uses the configured CA for an HTTPS proxy", async () => {
    assert.match(await scenario({ targetTls: false, proxyTls: true, trust: true, raw: true }), /verified tunnel/);
});

function tlsFailure(error: unknown): boolean {
    const codes: string[] = [];
    for (let current = error; current instanceof Error; current = current.cause) {
        if ("code" in current) codes.push(String(current.code));
    }
    assert.match(codes.join(" "), /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_ALTNAME|PRX_TLS/);
    return true;
}

for (const options of [
    { targetTls: true, proxyTls: false, trust: false },
    { targetTls: false, proxyTls: true, trust: false },
    { targetTls: false, proxyTls: true, trust: false, raw: true },
    { targetTls: true, proxyTls: false, trust: true, wrongTarget: true },
    { targetTls: false, proxyTls: true, trust: true, wrongProxy: true },
]) {
    test(`TLS still rejects untrusted or wrong-host certificates: ${JSON.stringify(options)}`, async () => {
        await assert.rejects(scenario(options), tlsFailure);
    });
}
