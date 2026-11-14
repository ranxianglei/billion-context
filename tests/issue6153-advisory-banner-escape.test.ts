// #6153: the defect-advisory banner interpolates `id` and `reason` — strings
// parsed verbatim from the remote billion-context-advisories npm feed
// (src/advisory.ts parseAdvisoryDoc checks non-emptiness only) — directly
// into innerHTML. Every other dynamic string in the panel goes through
// escapeHtml first; this banner was the one remote-string sink left raw.
// A compromised advisories package (or stolen NPM_TOKEN for it) therefore
// gets script execution inside the admin panel — same-origin with the config
// editor and update-install actions.
//
// The banner code lives inside the WEB_CLIENT template literal (browser
// context, no module boundary to import), so this test slices the block out
// of WEB_CLIENT and executes it under stubbed globals — the same seam
// discipline as tests/issue2645-pck-banner-escape.test.ts (#2645).
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { WEB_CLIENT } from "../src/web/client.ts";
import { MESSAGES } from "../src/web/i18n.ts";

const BLOCK_START = 'const ab = $("advisory-banner");';
const BLOCK_END = "// #5221 phase 2";

function bannerBlock(): string {
    const s = WEB_CLIENT.indexOf(BLOCK_START);
    assert.ok(s >= 0, "advisory banner block start seam missing from WEB_CLIENT");
    const e = WEB_CLIENT.indexOf(BLOCK_END, s);
    assert.ok(e > s, "advisory banner block end seam missing from WEB_CLIENT");
    return WEB_CLIENT.slice(s, e);
}

interface AbStub {
    hidden: boolean;
    innerHTML: string;
    classes: string[];
}

function runBanner(block: string, escapeHtml: (v: unknown) => string, d: unknown): AbStub {
    const ab: AbStub = { hidden: true, innerHTML: "", classes: [] };
    const $ = () => ({
        get hidden() { return ab.hidden; },
        set hidden(v: boolean) { ab.hidden = v; },
        set innerHTML(v: string) { ab.innerHTML = v; },
        classList: { add: (c: string) => void ab.classes.push(c), remove: () => {} },
    });
    const t = (key: string, vars?: Record<string, unknown>): string => {
        let text: string = MESSAGES["zh-CN"][key] ?? key;
        if (vars) for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]));
        return text;
    };
    // The sliced block declares `const ab = $("advisory-banner")` itself.
    const fn = new Function("$", "t", "escapeHtml", "d", `"use strict";\n${block}\nreturn ab;`);
    fn($, t, escapeHtml, d);
    return ab;
}

const POISON_ID = `bc-2026-001<img src=x onerror="alert(1)">`;
const POISON_REASON = `fixed in 0.1.214<script>window.xss=1<\/script>`;
const REAL_ESCAPE = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

for (const pendingRestart of [true, false]) {
    test(`advisory banner (${pendingRestart ? "pendingRestart" : "active"}): id/reason/target pass through escapeHtml before innerHTML`, () => {
        const block = bannerBlock();
        const payload = { advisory: { id: POISON_ID, reason: POISON_REASON, target: "0.1.214", pendingRestart } };

        // Probe 1 — marker escape: proves every remote field went THROUGH an
        // escapeHtml call (any regression back to raw interpolation drops the markers).
        let escaped: string[] = [];
        const kb1 = runBanner(block, (v) => (escaped.push(String(v)), `[esc:${String(v)}]`), payload);
        assert.ok(kb1.innerHTML.includes("[esc:"), "banner markup must carry escapeHtml output");
        assert.ok(escaped.some((v) => v === POISON_ID), `id must be escapeHtml()-ed (got ${JSON.stringify(escaped)})`);
        assert.ok(escaped.some((v) => v === POISON_REASON), `reason must be escapeHtml()-ed (got ${JSON.stringify(escaped)})`);
        if (!pendingRestart) {
            assert.ok(escaped.some((v) => v === "0.1.214"), `target must be escapeHtml()-ed (got ${JSON.stringify(escaped)})`);
        }

        // Probe 2 — real algorithm: no raw HTML metacharacters survive.
        const kb2 = runBanner(block, REAL_ESCAPE, payload);
        assert.ok(!kb2.innerHTML.includes("<img"), "raw <img must not survive into the banner markup");
        assert.ok(!kb2.innerHTML.includes("<script"), "raw <script must not survive into the banner markup");
        assert.ok(kb2.innerHTML.includes("&lt;img"), "poison id must render escaped");
        assert.ok(kb2.innerHTML.includes("&lt;script"), "poison reason must render escaped");
    });
}

test("advisory banner: clean values stay readable (no over-escaping)", () => {
    const kb = runBanner(bannerBlock(), REAL_ESCAPE, {
        advisory: { id: "bc-2026-001", reason: "corrupts tool-call arguments", target: "0.1.157", pendingRestart: false },
    });
    assert.equal(kb.hidden, false);
    assert.ok(kb.innerHTML.includes("[bc-2026-001]"), "clean id renders verbatim");
    assert.ok(kb.innerHTML.includes("corrupts tool-call arguments"), "clean reason renders verbatim");
    assert.ok(kb.innerHTML.includes("npm install -g billion-context@0.1.157"), "install hint keeps the exact command");
});

test("advisory banner: targetFailed falls back to latest, escaped", () => {
    const kb = runBanner(bannerBlock(), REAL_ESCAPE, {
        advisory: { id: "bc-2026-002", reason: "r", target: "0.1.157", targetFailed: true, pendingRestart: false },
    });
    assert.ok(kb.innerHTML.includes("npm install -g billion-context@latest"), "targetFailed falls back to latest");
});

test("advisory banner: no active advisory keeps the banner hidden", () => {
    const kb = runBanner(bannerBlock(), (v) => String(v), { advisory: null });
    assert.equal(kb.hidden, true);
    assert.equal(kb.innerHTML, "");
});

test("advisory banner: the unescaped interpolations must not return", () => {
    // Static pin so a future refactor cannot silently drop the escape even if
    // the seam markers move: the raw forms below are exactly the historic bug.
    assert.ok(
        !WEB_CLIENT.includes('class="mono">[\' + a.id + "]</span>'),
        "advisory id must go through escapeHtml, not raw concatenation",
    );
    assert.ok(
        !WEB_CLIENT.includes('<span>" + (a.reason || "") + "</span>'),
        "advisory reason must go through escapeHtml, not raw concatenation",
    );
});
