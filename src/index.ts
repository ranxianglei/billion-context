#!/usr/bin/env node
import { loadOptions } from "./config.js";
import { startServer } from "./server.js";

const opts = loadOptions();
startServer(opts).catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
});
