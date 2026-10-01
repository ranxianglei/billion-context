import { rmSync } from "node:fs";

// #1646: bare recursive rmSync throws ENOTEMPTY on loaded CI runners when a
// spawned child recreates entries between readdir and rmdir; Node's rimraf
// only retries transient errors (ENOTEMPTY/EACCES/EPERM/EMFILE/EBUSY) when
// maxRetries is set. Do not simplify these options away.
export function rmrf(target: string | URL): void {
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
