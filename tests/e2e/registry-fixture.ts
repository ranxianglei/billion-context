// Hermetic local npm registry fixture (verdaccio) for the ACP_TEST_REGISTRY
// e2e suite (#1153). Brings its own registry instance on loopback — it never
// depends on any external (even internal) service, so runs are offline,
// deterministic, and secret-free.
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

interface RegistryFixture {
    /** Base URL, e.g. http://127.0.0.1:43210 */
    url: string;
    port: number;
    /** Isolated HOME carrying an .npmrc with the local-registry token */
    homeDir: string;
    /** Working root (config + storage + home); safe to rm -rf on teardown */
    root: string;
    stop(): Promise<void>;
    publish(tarballPath: string): Promise<void>;
    npm(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const PING_TIMEOUT_MS = 30_000;
const NPM_TIMEOUT_MS = 120_000;

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const p = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(p));
        });
        s.on("error", reject);
    });
}

export async function startRegistry(root: string): Promise<RegistryFixture> {
    fs.mkdirSync(path.join(root, "storage"), { recursive: true });
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const cfg = path.join(root, "config.yaml");
    fs.writeFileSync(
        cfg,
        [
            `storage: ${path.join(root, "storage")}`,
            "web:",
            "  enable: false",
            "auth:",
            "  htpasswd:",
            `    file: ${path.join(root, "htpasswd")}`,
            "uplinks: {}",
            "packages:",
            "  '@*/*':",
            "    access: $all",
            // $anonymous here means ANONYMOUS-ONLY publishing — the npm CLI
            // always authenticates, so $all is required (#1153 finding).
            "    publish: $all",
            "  '**':",
            "    access: $all",
            "    publish: $all",
            "listen:",
            `  - ${url}`,
            // The real package tarball is ~13MB (bundled dist), above
            // verdaccio's default 10mb body limit (#1153).
            "max_body_size: 200mb",
            "log: { type: stdout, format: pretty, level: warn }",
            "",
        ].join("\n"),
    );

    const req = createRequire(import.meta.url);
    const bin = path.join(path.dirname(req.resolve("verdaccio/package.json")), "bin", "verdaccio");
    const child = spawn(process.execPath, [bin, "--config", cfg], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    let exitCode: number | null = null;
    child.on("exit", (c) => (exitCode = c ?? -1));

    const stop = async (): Promise<void> => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const t = setTimeout(() => {
                    child.kill("SIGKILL");
                    resolve();
                }, 5_000);
                t.unref?.();
                child.once("exit", () => {
                    clearTimeout(t);
                    resolve();
                });
            });
        }
    };

    try {
        const deadline = Date.now() + PING_TIMEOUT_MS;
        let ready = false;
        while (Date.now() < deadline) {
            if (exitCode !== null) break;
            try {
                if ((await fetch(`${url}/-/ping`)).ok) {
                    ready = true;
                    break;
                }
            } catch {
                // not listening yet
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        if (!ready) throw new Error(`verdaccio did not become ready within ${PING_TIMEOUT_MS}ms\n${output}`);

        const regRes = await fetch(`${url}/-/user/org.couchdb.user:bili-test`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "bili-test", password: "bili-test-local-only" }),
        });
        if (regRes.status !== 201) throw new Error(`local user registration failed (${regRes.status})\n${output}`);
        const body = (await regRes.json()) as { token?: string };
        if (typeof body.token !== "string" || body.token.length === 0) throw new Error(`no token from registration\n${output}`);
        const homeDir = path.join(root, "home");
        fs.mkdirSync(homeDir, { recursive: true });
        fs.writeFileSync(path.join(homeDir, ".npmrc"), `//127.0.0.1:${port}/:_authToken=${body.token}\n`);

        const runNpm = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
            new Promise((resolve, reject) => {
                execFile(
                    "npm",
                    [...args, "--registry", url, "--no-audit", "--no-fund"],
                    { cwd: root, encoding: "utf8", timeout: NPM_TIMEOUT_MS, env: { PATH: process.env.PATH ?? "", HOME: homeDir } },
                    (error, stdout, stderr) => {
                        if (error) reject(new Error(`npm ${args.join(" ")} failed: ${(stderr || error.message).slice(0, 4000)}`));
                        else resolve({ stdout, stderr });
                    },
                );
            });

        return { url, port, homeDir, root, stop, publish: (tgz) => runNpm(["publish", tgz]), npm: runNpm };
    } catch (err) {
        await stop();
        throw err;
    }
}
