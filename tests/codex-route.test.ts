import assert from "node:assert/strict";
import test from "node:test";
import {
    codexRouteValue,
    planCodexRoute,
    readCodexRoute,
    restoreCodexRoute,
    type CodexRouteRecord,
} from "../src/codex-integration/route.ts";
import {
    findTableScalar,
    findTopLevelScalar,
    removeTopLevelScalar,
    setTableScalar,
    setTopLevelScalar,
} from "../src/codex-integration/toml-field.ts";

const origin = "http://127.0.0.1:18787";

test("top-level scalar edits preserve tables and unrelated text", () => {
    const original =
        '# user\nmodel = "gpt-test"\n\n[sandbox]\nmode = "workspace-write"\n';
    const inserted = setTopLevelScalar(
        original,
        "openai_base_url",
        "http://127.0.0.1:18787/bili/https://api.openai.com/v1",
    );
    assert.equal(
        findTopLevelScalar(inserted, "openai_base_url")?.value,
        "http://127.0.0.1:18787/bili/https://api.openai.com/v1",
    );
    assert.match(inserted, /\[sandbox\]\nmode = "workspace-write"/);
    assert.equal(removeTopLevelScalar(inserted, "openai_base_url"), original);
    assert.equal(
        findTopLevelScalar(
            '[model_providers.openai]\nopenai_base_url = "nested"\n',
            "openai_base_url",
        ),
        undefined,
    );
});

test("route planner owns only a sidecar-recorded value and detects provider shadowing", () => {
    const empty = 'model = "gpt-test"\n[sandbox]\nmode = "workspace-write"\n';
    const first = planCodexRoute(empty, { origin });
    assert.equal(first.action, "install");
    assert.equal(
        first.value,
        codexRouteValue(origin, "https://api.openai.com/v1"),
    );
    assert.equal(
        planCodexRoute(first.text, { origin }).action,
        "conflict",
        "a loopback-looking URL without ownership evidence is foreign",
    );
    assert.equal(
        planCodexRoute(first.text, { origin, ownedValue: first.value }).action,
        "keep",
    );
    const moved = planCodexRoute(first.text, {
        origin: "http://127.0.0.1:18788",
        ownedValue: first.value,
    });
    assert.equal(moved.action, "refresh");
    assert.equal(
        planCodexRoute('openai_base_url = "https://relay.example/v1"\n', { origin })
            .action,
        "conflict",
    );
    const shadowed = planCodexRoute(
        'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.example/v1"\n',
        { origin },
    );
    assert.equal(shadowed.conflict?.kind, "shadowed-by-provider");
    assert.equal(readCodexRoute(first.text).routed, false);
    assert.equal(readCodexRoute(first.text, first.value).routed, true);
});

test("uninstall restores only the exact route value from the ownership record", () => {
    const original = 'model = "gpt-test"\n[sandbox]\nmode = "workspace-write"\n';
    const plan = planCodexRoute(original, { origin });
    const record: CodexRouteRecord = {
        schemaVersion: 1,
        writtenValue: plan.value!,
        previousValue: null,
        upstream: "https://api.openai.com/v1",
    };
    assert.deepEqual(restoreCodexRoute(plan.text, record), {
        text: original,
        restored: true,
        stillOwned: true,
    });
    const userEdited = plan.text.replace(plan.value!, "https://user.example/v1");
    assert.deepEqual(restoreCodexRoute(userEdited, record), {
        text: userEdited,
        restored: false,
        stillOwned: false,
    });
});

test("CC Switch Direct routes only its active provider base_url with reversible ownership", () => {
    const original = [
        'model_provider = "custom"',
        'openai_base_url = "https://root.example/v1"',
        "",
        "[model_providers.custom]",
        'base_url = "https://api.kourichat.com/v1" # CC Switch Direct',
        'model = "test-model"',
        "",
        "[sandbox]",
        'mode = "workspace-write"',
        "",
    ].join("\n");
    const unsupported = planCodexRoute(original, { origin });
    assert.equal(unsupported.action, "conflict");
    const installed = planCodexRoute(original, { origin, ccSwitchMode: "direct" });
    assert.equal(installed.action, "install");
    assert.deepEqual(installed.target, { kind: "provider", provider: "custom" });
    assert.equal(
        findTableScalar(installed.text, "model_providers.custom", "base_url")?.value,
        codexRouteValue(origin, "https://api.kourichat.com/v1"),
    );
    assert.match(installed.text, /openai_base_url = "https:\/\/root\.example\/v1"/);
    assert.match(installed.text, /base_url = .* # CC Switch Direct/);
    const record: CodexRouteRecord = {
        schemaVersion: 1,
        writtenValue: installed.value!,
        previousValue: "https://api.kourichat.com/v1",
        upstream: "https://api.kourichat.com/v1",
        target: installed.target,
    };
    assert.equal(readCodexRoute(installed.text, record).routed, true);
    assert.equal(
        planCodexRoute(installed.text, { origin, ccSwitchMode: "direct", ownedRecord: record }).action,
        "keep",
    );
    assert.equal(
        planCodexRoute(original, { origin, ccSwitchMode: "routing" }).action,
        "conflict",
    );
    assert.deepEqual(restoreCodexRoute(installed.text, record), {
        text: original,
        restored: true,
        stillOwned: true,
    });
    const changedBySwitch = original.replace(
        'base_url = "https://api.kourichat.com/v1" # CC Switch Direct',
        'base_url = "https://other-provider.example/v1" # CC Switch Direct',
    );
    assert.equal(
        planCodexRoute(changedBySwitch, { origin, ccSwitchMode: "direct", ownedRecord: record }).action,
        "conflict",
        "a CC Switch rewrite after install must not be fought or adopted as a new backup",
    );
});
