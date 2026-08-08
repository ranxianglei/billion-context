#!/usr/bin/env node
// Entry point: runs the CLI dispatcher (src/cli.ts).
// Both `bili` and `bili-proxy` bin aliases point here, and `node dist/index.js`
// still works.
import { main } from "./cli.js";
main().catch((err) => {
    console.error("bili: failed to start:", err);
    process.exit(1);
});
