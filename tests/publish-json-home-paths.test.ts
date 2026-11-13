import assert from "node:assert/strict";
import { test } from "node:test";
import { maskPathsForPublish, redactForPublish } from "../src/log-mask.js";

function withProfile(profile: string, run: () => void): void {
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = profile;
    try {
        run();
    } finally {
        if (previous === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previous;
    }
}

test("publish redaction removes Windows homes from serialized configuration values", () => {
    withProfile(String.raw`C:\Users\ExampleUser`, () => {
        const config = JSON.stringify({ network: { caFile: String.raw`C:\Users\ExampleUser\certs\relay.pem` } });
        const masked = redactForPublish(config);
        assert.equal(masked.includes("ExampleUser"), false);
        assert.deepEqual(JSON.parse(masked), { network: { caFile: String.raw`~\certs\relay.pem` } });
    });
});

test("raw and JSON-escaped home spellings can occur in the same report", () => {
    withProfile(String.raw`C:\Users\ExampleUser`, () => {
        const raw = String.raw`C:\Users\ExampleUser\cache\index.db`;
        const serialized = JSON.stringify({ file: raw });
        assert.equal(maskPathsForPublish(`open ${raw}\n${serialized}`), `open ~\\cache\\index.db\n${JSON.stringify({ file: String.raw`~\cache\index.db` })}`);
    });
});

test("JSON-escaped quotes in a home name do not escape the publish boundary", () => {
    withProfile('/srv/users/example"user', () => {
        const serialized = JSON.stringify({ file: '/srv/users/example"user/cache/index.db' });
        const masked = maskPathsForPublish(serialized);
        assert.deepEqual(JSON.parse(masked), { file: "~/cache/index.db" });
    });
});

test("escaped home matching retains sibling and relative path boundaries", () => {
    withProfile(String.raw`C:\Users\ExampleUser`, () => {
        const siblings = JSON.stringify({
            sibling: String.raw`C:\Users\ExampleUserOther\index.db`,
            relative: String.raw`prefixC:\Users\ExampleUser\index.db`,
            other: String.raw`D:\Users\ExampleUser\index.db`,
        });
        assert.equal(maskPathsForPublish(siblings), siblings);
    });
});

test("publish path redaction remains idempotent and keeps ordinary URL paths", () => {
    withProfile("/home/exampleuser", () => {
        const text = 'https://api.openai.com/home/exampleuser/file.json {"file":"/home/exampleuser/cache/index.db"}';
        const masked = maskPathsForPublish(text);
        assert.equal(masked, 'https://api.openai.com/home/exampleuser/file.json {"file":"~/cache/index.db"}');
        assert.equal(maskPathsForPublish(masked), masked);
    });
});
