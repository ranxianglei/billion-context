// #2645 follow-up (found in the #3781 release review): the pck ablation
// banner interpolates conversation ids into kb.innerHTML. Session ids are
// client-supplied verbatim (x-session-id et al. are only trimmed,
// src/session-id.ts), so an untrusted client on a LAN/VPS-exposed proxy can
// park HTML in the operator panel via one A/B-confirmed ablation. The ids
// MUST pass through escapeHtml before t() — t() is raw string substitution,
// not an escaping boundary.
//
// The banner code lives inside the WEB_CLIENT template literal (browser
// context, no module boundary to import), so this test slices the block out
// of WEB_CLIENT and executes it under stubbed globals — the same seam
// discipline as tests/conflict-remediation.test.ts (#2815).
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { WEB_CLIENT } from "../src/web/client.ts";
import { MESSAGES } from "../src/web/i18n.ts";

const BLOCK_START = "// #2645: the key-hostile upstream pairs learned by A/B this process";
const BLOCK_END = "// #2861: host-side metering plugin notice";

function bannerBlock(): string {
    const s = WEB_CLIENT.indexOf(BLOCK_START);
    assert.ok(s >= 0, "pck banner block seam missing from WEB_CLIENT");
    const e = WEB_CLIENT.indexOf(BLOCK_END, s);
    assert.ok(e > s, "pck banner block end seam missing from WEB_CLIENT");
    return WEB_CLIENT.slice(s, e);
}

interface KbStub {
    hidden: boolean;
    innerHTML: string;
    classes: string[];
}

function runBanner(block: string, escapeHtml: (v: unknown) => string, d: unknown): KbStub {
    const kb: KbStub = { hidden: true, innerHTML: "", classes: [] };
    const $ = () => ({
        get hidden() { return kb.hidden; },
        set hidden(v: boolean) { kb.hidden = v; },
        set innerHTML(v: string) { kb.innerHTML = v; },
        classList: { add: (c: string) => void kb.classes.push(c), remove: () => {} },
    });
    const t = (key: string, vars?: Record<string, unknown>): string => {
        let text: string = MESSAGES["zh-CN"][key] ?? key;
        if (vars) for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]));
        return text;
    };
    // The sliced block declares `const kb = $("pck-banner")` itself.
    const fn = new Function("$", "t", "escapeHtml", "d", `"use strict";\n${block}\nreturn kb;`);
    fn($, t, escapeHtml, d);
    return kb;
}

const POISON = `<img src=x onerror="alert(1)">`;
const payload = { pckSuppressions: [{ origin: "https://up.example", model: "gpt-test", sessions: [POISON, "s-clean-2"] }] };

test("pck banner: session ids pass through escapeHtml before innerHTML", () => {
    const block = bannerBlock();
    // Probe 1 — marker escapeHtml: proves the ids value went THROUGH the
    // escapeHtml call (any regression back to raw join() drops the markers).
    let escaped: string[] = [];
    const kb1 = runBanner(block, (v) => (escaped.push(String(v)), `[esc:${String(v)}]`), payload);
    assert.ok(escaped.some((v) => v === `${POISON}, s-clean-2`), `ids must be escapeHtml()-ed as one joined value (got ${JSON.stringify(escaped)})`);
    assert.ok(kb1.innerHTML.includes("[esc:"), "escaped ids must land in the banner markup");

    // Probe 2 — real algorithm: no raw HTML metacharacters survive.
    const realEscape = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
    const kb2 = runBanner(block, realEscape, payload);
    assert.ok(!kb2.innerHTML.includes("<img"), "raw <img must not survive into kb.innerHTML");
    assert.ok(kb2.innerHTML.includes("&lt;img"), "poison id must render escaped");
    assert.ok(kb2.innerHTML.includes("s-clean-2"), "clean ids still readable");
});

test("pck banner: the unescaped ids interpolation must not return", () => {
    // Static pin so a future refactor cannot silently drop the escape even if
    // the seam markers move: the raw form is exactly the historic bug.
    assert.ok(
        !WEB_CLIENT.includes(`t("pck.sessions", { ids: p.sessions.join(", ") })`),
        "pck.sessions ids must go through escapeHtml, not raw join",
    );
});

test("pck banner: empty suppression list keeps the banner hidden", () => {
    const kb = runBanner(bannerBlock(), (v) => String(v), { pckSuppressions: [] });
    assert.equal(kb.hidden, true);
    assert.equal(kb.innerHTML, "");
});
