// #5354: entryScriptFingerprint() cached a script's digest by path for the
// life of the process. The omp plugin lives inside the long-running agent
// host, so after an in-place update (`npm i -g` renames the new dist over the
// old path) the host kept the FIRST build's digest — and #4125 then stamped
// every child it respawned with it (BILI_SPAWN_FINGERPRINT). Children running
// the same new code registered different fingerprints, could not attach to
// one another (code-fingerprint-mismatch), and each respawn laddered onto the
// next lane port. The digest must follow the file on disk, not the process.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";
import { entryScriptFingerprint } from "../src/instance.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5354-fp-"));
after(() => rmrf(DIR));

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function script(name: string, text: string): string {
    const file = path.join(DIR, name);
    fs.writeFileSync(file, text);
    assert.equal(entryScriptFingerprint(file), sha256(text), "first read hashes the bytes on disk");
    return file;
}

test("a script replaced by rename — how npm installs an update — yields the new build's digest", () => {
    const file = script("rename.js", "// build A\n");
    const staged = `${file}.new`;
    fs.writeFileSync(staged, "// build B\n");
    fs.renameSync(staged, file);
    assert.equal(entryScriptFingerprint(file), sha256("// build B\n"));
});

test("a script rewritten in place yields the new build's digest", () => {
    const file = script("in-place.js", "// build A\n");
    fs.writeFileSync(file, "// build B, a longer one\n");
    assert.equal(entryScriptFingerprint(file), sha256("// build B, a longer one\n"));
});

test("a script removed after it was fingerprinted is unreadable → undefined, never the old digest", () => {
    const file = script("removed.js", "// build A\n");
    fs.rmSync(file);
    assert.equal(entryScriptFingerprint(file), undefined);
});
