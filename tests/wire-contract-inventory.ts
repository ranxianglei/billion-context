// Golden-snapshot inventory for the wire-contract gate (#1304 item 2).
// Builds the canonical object trees whose byte-exact JSON snapshots live in
// tests/golden/wire-contract/. Shared by tests/wire-contract-golden.test.ts
// (asserts byte equality) and scripts/update-wire-contract-goldens.ts
// (regenerates them). A schema change turns the golden test red; regenerating
// without justification in the PR is how silent schema drift would slip back in.

import http from "node:http";
import * as K from "acp-kernel";
import { defaultConfig } from "acp-kernel";
import { handlePluginManifest } from "../src/plugin.ts";
import {
    ABSORB_TOOL_RESPONSES,
    BILI_ACP_READONLY_TOOLS_RESPONSES,
    BILI_ACP_TOOLS_ANTHROPIC,
    BILI_ACP_TOOLS_GOOGLE,
    BILI_ACP_TOOLS_OPENAI,
    BILI_ACP_TOOLS_RESPONSES,
    BILI_DECOMPRESS_TOOL,
    BILI_DECOMPRESS_TOOL_GOOGLE,
    BILI_DECOMPRESS_TOOL_OPENAI,
    BILI_DECOMPRESS_TOOL_RESPONSES,
    BILI_SEARCH_CONTEXT_TOOL,
    BILI_SEARCH_CONTEXT_TOOL_GOOGLE,
    BILI_SEARCH_CONTEXT_TOOL_OPENAI,
    BILI_SEARCH_CONTEXT_TOOL_RESPONSES,
    IMAGE_FULL_TOOL_GOOGLE,
    RULE_TOOL,
    RULE_TOOL_GOOGLE,
    RULE_TOOL_OPENAI,
    RULE_TOOL_RESPONSES,
    retrieveToolsFor,
} from "../src/compress-tool.ts";

export function canonicalize(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export interface GoldenSpec {
    readonly name: string;
    readonly layer: string;
    build(): unknown;
}

function buildKernelGolden(): Record<string, unknown> {
    return {
        arrays: {
            ACP_TOOLS_ANTHROPIC: K.ACP_TOOLS_ANTHROPIC,
            ACP_TOOLS_OPENAI: K.ACP_TOOLS_OPENAI,
            ACP_TOOLS_RESPONSES: K.ACP_TOOLS_RESPONSES,
            ACP_READONLY_TOOLS_RESPONSES: K.ACP_READONLY_TOOLS_RESPONSES,
            ACP_TOOLS_GOOGLE: K.ACP_TOOLS_GOOGLE,
        },
        individual: {
            COMPRESS_TOOL: K.COMPRESS_TOOL,
            COMPRESS_TOOL_OPENAI: K.COMPRESS_TOOL_OPENAI,
            COMPRESS_TOOL_RESPONSES: K.COMPRESS_TOOL_RESPONSES,
            COMPRESS_TOOL_GOOGLE: K.COMPRESS_TOOL_GOOGLE,
            DECOMPRESS_TOOL: K.DECOMPRESS_TOOL,
            DECOMPRESS_TOOL_OPENAI: K.DECOMPRESS_TOOL_OPENAI,
            DECOMPRESS_TOOL_RESPONSES: K.DECOMPRESS_TOOL_RESPONSES,
            DECOMPRESS_TOOL_GOOGLE: K.DECOMPRESS_TOOL_GOOGLE,
            SEARCH_CONTEXT_TOOL: K.SEARCH_CONTEXT_TOOL,
            SEARCH_CONTEXT_TOOL_OPENAI: K.SEARCH_CONTEXT_TOOL_OPENAI,
            SEARCH_CONTEXT_TOOL_RESPONSES: K.SEARCH_CONTEXT_TOOL_RESPONSES,
            SEARCH_CONTEXT_TOOL_GOOGLE: K.SEARCH_CONTEXT_TOOL_GOOGLE,
            ACP_STATUS_TOOL: K.ACP_STATUS_TOOL,
            ACP_STATUS_TOOL_OPENAI: K.ACP_STATUS_TOOL_OPENAI,
            ACP_STATUS_TOOL_RESPONSES: K.ACP_STATUS_TOOL_RESPONSES,
            ACP_STATUS_TOOL_GOOGLE: K.ACP_STATUS_TOOL_GOOGLE,
            ACP_CACHE_TOOL: K.ACP_CACHE_TOOL,
            ACP_CACHE_TOOL_OPENAI: K.ACP_CACHE_TOOL_OPENAI,
            ACP_CACHE_TOOL_RESPONSES: K.ACP_CACHE_TOOL_RESPONSES,
        },
        optional: {
            ABSORB_TOOL: K.ABSORB_TOOL,
            ABSORB_TOOL_OPENAI: K.ABSORB_TOOL_OPENAI,
            ABSORB_TOOL_GOOGLE: K.ABSORB_TOOL_GOOGLE,
            IMAGE_FULL_TOOL: K.IMAGE_FULL_TOOL,
            IMAGE_FULL_TOOL_OPENAI: K.IMAGE_FULL_TOOL_OPENAI,
            IMAGE_FULL_TOOL_RESPONSES: K.IMAGE_FULL_TOOL_RESPONSES,
            RETRIEVE_TOOL: K.RETRIEVE_TOOL,
            RETRIEVE_TOOL_OPENAI: K.RETRIEVE_TOOL_OPENAI,
            RETRIEVE_TOOL_RESPONSES: K.RETRIEVE_TOOL_RESPONSES,
        },
    };
}

function buildBiliGolden(): Record<string, unknown> {
    return {
        base: {
            anthropic: BILI_ACP_TOOLS_ANTHROPIC,
            openai: BILI_ACP_TOOLS_OPENAI,
            responses: BILI_ACP_TOOLS_RESPONSES,
            google: BILI_ACP_TOOLS_GOOGLE,
            responsesReadOnly: BILI_ACP_READONLY_TOOLS_RESPONSES,
        },
        extended: {
            searchContextAnthropic: BILI_SEARCH_CONTEXT_TOOL,
            searchContextOpenAi: BILI_SEARCH_CONTEXT_TOOL_OPENAI,
            searchContextResponses: BILI_SEARCH_CONTEXT_TOOL_RESPONSES,
            searchContextGoogle: BILI_SEARCH_CONTEXT_TOOL_GOOGLE,
            decompressAnthropic: BILI_DECOMPRESS_TOOL,
            decompressOpenAi: BILI_DECOMPRESS_TOOL_OPENAI,
            decompressResponses: BILI_DECOMPRESS_TOOL_RESPONSES,
            decompressGoogle: BILI_DECOMPRESS_TOOL_GOOGLE,
        },
        synthesized: {
            absorbResponses: ABSORB_TOOL_RESPONSES,
            ruleAnthropic: RULE_TOOL,
            ruleOpenAi: RULE_TOOL_OPENAI,
            ruleResponses: RULE_TOOL_RESPONSES,
            ruleGoogle: RULE_TOOL_GOOGLE,
            retrieveAcpRetrieve: retrieveToolsFor("acp_retrieve"),
            imageFullGoogle: IMAGE_FULL_TOOL_GOOGLE,
        },
    };
}

function captureManifest(config: Parameters<typeof handlePluginManifest>[1]): Record<string, unknown> {
    let raw: unknown;
    const res = {
        writeHead(): void { /* noop */ },
        end(b: unknown): void { raw = b; },
    } as unknown as http.ServerResponse;
    handlePluginManifest(res, config);
    const doc = JSON.parse(String(raw)) as Record<string, unknown>;
    // package.json version changes on every release commit; pin it so the
    // golden only tracks schema content, not the release counter.
    doc.version = "<VERSION>";
    return doc;
}

export function buildGoldens(): GoldenSpec[] {
    return [
        { name: "kernel.json", layer: "acp-kernel exports (pinned)", build: buildKernelGolden },
        { name: "bili.json", layer: "bili-built surfaces (compress-tool.ts)", build: buildBiliGolden },
        { name: "manifest-default.json", layer: "plugin manifest, default config", build: () => captureManifest(defaultConfig(100_000)) },
        { name: "manifest-optin.json", layer: "plugin manifest, absorb+rules+ccr enabled", build: () => captureManifest({ ...defaultConfig(100_000), absorb: { ...K.DEFAULT_ABSORB_CONFIG, enabled: true }, rules: { enabled: true }, ccr: { ...K.DEFAULT_CCR_CONFIG, enabled: true } }) },
    ];
}
