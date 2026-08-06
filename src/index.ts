#!/usr/bin/env node
import { loadOptions } from "./config.js";
import { startServer } from "./server.js";

const opts = loadOptions();
const server = startServer(opts);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
        server.close(() => process.exit(0));
    });
}
