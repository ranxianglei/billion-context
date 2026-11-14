import test from "node:test";
import assert from "node:assert/strict";
import { applyCompatDropFields, dropCompatFieldsJson, parseCompatDropFields } from "../src/compat-drop.ts";

test("a missing JSON path cannot delete an inherited prototype property", () => {
    const marker = "biliCompatDropOwnPathMarker";
    const original = Object.getOwnPropertyDescriptor(Object.prototype, marker);
    assert.equal(original, undefined);
    Object.defineProperty(Object.prototype, marker, { value: "keep", configurable: true });
    try {
        const body = '{ "model": "test", "input": [] }';
        const paths = parseCompatDropFields([`__proto__.${marker}`])!;
        const result = applyCompatDropFields(body, paths);
        assert.deepEqual(result, { body, dropped: 0 });
        assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, marker)?.value, "keep");
    } finally {
        Reflect.deleteProperty(Object.prototype, marker);
    }
});

test("an inherited nested object is outside the deletion path", () => {
    const inherited = { leaf: "keep" };
    const parsed = { nested: Object.create({ options: inherited }) };
    assert.equal(dropCompatFieldsJson(parsed, ["nested.options.leaf"]), 0);
    assert.deepEqual(inherited, { leaf: "keep" });
});

test("an inherited getter is not evaluated while resolving missing paths", () => {
    let calls = 0;
    const parent = Object.defineProperty({}, "options", {
        get() { calls++; return { leaf: "keep" }; },
    });
    assert.equal(dropCompatFieldsJson(Object.create(parent), ["options.leaf"]), 0);
    assert.equal(calls, 0);
});

test("own prototype-named JSON keys still support ordinary structural deletion", () => {
    const body = '{"__proto__":{"remove":1,"keep":2},"constructor":{"remove":3},"hasOwnProperty":{"remove":4}}';
    const result = applyCompatDropFields(body, ["__proto__.remove", "constructor.remove", "hasOwnProperty.remove"]);
    assert.equal(result.dropped, 3);
    const parsed = JSON.parse(result.body);
    assert.ok(Object.hasOwn(parsed, "__proto__"));
    assert.deepEqual(parsed.__proto__, { keep: 2 });
    assert.deepEqual(parsed.constructor, {});
    assert.deepEqual(parsed.hasOwnProperty, {});
});

test("own null-prototype objects work while missing paths remain no-ops", () => {
    const parsed = Object.assign(Object.create(null), {
        options: Object.assign(Object.create(null), { remove: 1, keep: 2 }),
    });
    assert.equal(dropCompatFieldsJson(parsed, ["missing.remove", "options.remove"]), 1);
    assert.equal(parsed.options.keep, 2);
    assert.equal(Object.hasOwn(parsed.options, "remove"), false);
});
