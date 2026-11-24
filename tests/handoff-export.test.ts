import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffRevealEnabled } from "../src/config.ts";
import { handoffExportName, revealCommand, uniqueHandoffPath, writeHandoffExport } from "../src/handoff-export.ts";

test("#7233 keeps the browser handoff filename scheme and sanitizes the id", () => {
    assert.equal(
        handoffExportName("ses_abc/../def"),
        "billion-context-handoff-ses_abc_.._def.md",
    );
});

test("#7233 picks a free name without overwriting an earlier export", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-handoff-"));
    try {
        assert.equal(uniqueHandoffPath(dir, "abc"), join(dir, "billion-context-handoff-abc.md"));
        assert.equal(
            uniqueHandoffPath(dir, "abc", (candidate) => candidate.endsWith("billion-context-handoff-abc.md")),
            join(dir, "billion-context-handoff-abc (1).md"),
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7233 writes the markdown to the requested directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-handoff-"));
    try {
        const file = writeHandoffExport("abc", "# handoff\n", dir);
        assert.equal(file, join(dir, "billion-context-handoff-abc.md"));
        assert.equal(readFileSync(file, "utf8"), "# handoff\n");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7233 never overwrites an existing export, even under a name race", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-handoff-"));
    const first = join(dir, "billion-context-handoff-abc.md");
    try {
        writeFileSync(first, "keep\n", "utf8");
        const file = writeHandoffExport("abc", "# new\n", dir);
        assert.equal(file, join(dir, "billion-context-handoff-abc (1).md"));
        assert.equal(readFileSync(first, "utf8"), "keep\n");
        assert.equal(readFileSync(file, "utf8"), "# new\n");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7233 reveal is on by default and can be disabled in config", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-handoff-"));
    const previous = process.env.BILI_CONFIG_FILE;
    try {
        process.env.BILI_CONFIG_FILE = join(dir, "missing.json");
        assert.equal(handoffRevealEnabled(), true);

        const config = join(dir, "billion-context.json");
        writeFileSync(config, JSON.stringify({ handoff: { reveal: false } }), "utf8");
        process.env.BILI_CONFIG_FILE = config;
        assert.equal(handoffRevealEnabled(), false);
    } finally {
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7233 reveals the file with the platform file manager", () => {
    assert.deepEqual(revealCommand("C:\\tmp\\h.md", "win32"), {
        command: "explorer.exe",
        args: ["/select,C:\\tmp\\h.md"],
    });
    assert.deepEqual(revealCommand("/tmp/h.md", "darwin"), {
        command: "open",
        args: ["-R", "/tmp/h.md"],
    });
    assert.deepEqual(revealCommand("/tmp/h.md", "linux"), {
        command: "xdg-open",
        args: ["/tmp"],
    });
});
