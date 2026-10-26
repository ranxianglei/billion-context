// src/vertex.ts — the Vertex port's shared mapping (phase 1) — plus the one
// server-layer helper that has no other home: `vertexAnthropicModelFromPath`
// lives in src/server.ts beside its Gemini sibling, and phase 3's decision A
// puts its table here so that one file holds the port's whole contract rather
// than splitting it across two. Importing src/server.ts is the cost of that
// choice; everything else in this file is pure.
//
// The reference for the derived host shapes is headroom's
// vertex_target_for_location (headroom/providers/vertex/runtime.py:68-91); the
// reference for why the location is validated before interpolation is the SSRF
// that function once carried (a percent-encoded `#` turning the hostname into a
// fragment and the URL into a GCP metadata-endpoint reach).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeVertexModelId,
    stripBiliWrappers,
    vertexBaseUrlForLocation,
    vertexBaseUrlLacksV1,
    vertexEnabled,
    vertexHostForLocation,
} from "../src/vertex.ts";
import { googleModelFromPath, googlePathKind, vertexAnthropicModelFromPath } from "../src/server.ts";

test("vertexHostForLocation: global / multi-region / regional host shapes", () => {
    assert.deepEqual(vertexHostForLocation("global"), { host: "https://aiplatform.googleapis.com", location: "global", source: "derived" });
    assert.deepEqual(vertexHostForLocation("us"), { host: "https://aiplatform.us.rep.googleapis.com", location: "us", source: "derived" });
    assert.deepEqual(vertexHostForLocation("eu"), { host: "https://aiplatform.eu.rep.googleapis.com", location: "eu", source: "derived" });
    // A regional location is a prefix, the opposite of the multi-region form.
    assert.deepEqual(vertexHostForLocation("us-east5"), { host: "https://us-east5-aiplatform.googleapis.com", location: "us-east5", source: "derived" });
    // Case and surrounding whitespace are normalized, not rejected: the value
    // comes from a hand-edited settings file.
    assert.deepEqual(vertexHostForLocation("  GLOBAL "), { host: "https://aiplatform.googleapis.com", location: "global", source: "derived" });
});

test("vertexHostForLocation: an explicit base URL wins outright, region or not", () => {
    const explicit = "https://private-endpoint.example/vertex";
    assert.deepEqual(vertexHostForLocation("global", explicit), { host: explicit, location: null, source: "explicit" });
    assert.deepEqual(vertexHostForLocation(undefined, explicit), { host: explicit, location: null, source: "explicit" });
    assert.deepEqual(vertexHostForLocation("not a location!!", explicit), { host: explicit, location: null, source: "explicit" });
});

test("vertexHostForLocation: nothing derivable returns null (never a guessed region)", () => {
    assert.equal(vertexHostForLocation(undefined), null);
    assert.equal(vertexHostForLocation(""), null);
    assert.equal(vertexHostForLocation("   "), null);
    // This project is global-only; a fabricated region answers 404 everywhere,
    // so the caller warns and leaves the variable unset instead.
    // Validation is syntactic only — a well-formed but nonexistent location still
    // derives a host rather than being guessed at from a hardcoded region list
    // that would go stale against Google's.
    assert.deepEqual(vertexHostForLocation("nowhere-1"), { host: "https://nowhere-1-aiplatform.googleapis.com", location: "nowhere-1", source: "derived" });
});

test("vertexHostForLocation: SSRF- and traversal-shaped locations are rejected", () => {
    // The percent-encoded `#` is the documented one: decoded it becomes a
    // fragment, and `https://169.254.169.254#-aiplatform.googleapis.com` reads
    // as host 169.254.169.254 to an HTTP client.
    assert.equal(vertexHostForLocation("169.254.169.254#"), null);
    assert.equal(vertexHostForLocation("169.254.169.254%23"), null);
    assert.equal(vertexHostForLocation("us-east5#"), null);
    // Dots, slashes and credentials never belong in a location label.
    assert.equal(vertexHostForLocation(".."), null);
    assert.equal(vertexHostForLocation("us-east5/../x"), null);
    assert.equal(vertexHostForLocation("evil.com"), null);
    assert.equal(vertexHostForLocation("us-east5@evil.com"), null);
    // Nor an empty label between hyphens.
    assert.equal(vertexHostForLocation("us--east5"), null);
    assert.equal(vertexHostForLocation("-us-east5"), null);
    assert.equal(vertexHostForLocation("us-east5-"), null);
});

test("vertexBaseUrlForLocation: derived gets /v1, explicit is handed over untouched", () => {
    assert.equal(vertexBaseUrlForLocation("global"), "https://aiplatform.googleapis.com/v1");
    assert.equal(vertexBaseUrlForLocation("us-east5"), "https://us-east5-aiplatform.googleapis.com/v1");
    // The client appends /projects/… to this value verbatim and Vertex 404s the
    // version-less path, hence the segment for derived values only.
    assert.equal(vertexBaseUrlForLocation(undefined, "https://gateway.example/vertex"), "https://gateway.example/vertex");
    assert.equal(vertexBaseUrlForLocation("us-east5", " https://gateway.example/v1 "), "https://gateway.example/v1");
    assert.equal(vertexBaseUrlForLocation(undefined), null);
    assert.equal(vertexBaseUrlForLocation("not a location!!"), null);
});

test("vertexBaseUrlLacksV1: warns on the shape that 404s, not on a trailing slash", () => {
    assert.equal(vertexBaseUrlLacksV1("https://aiplatform.googleapis.com/v1"), false);
    assert.equal(vertexBaseUrlLacksV1("https://aiplatform.googleapis.com/v1/"), false);
    assert.equal(vertexBaseUrlLacksV1(" https://gateway.example/v1 "), false);
    assert.equal(vertexBaseUrlLacksV1("https://aiplatform.googleapis.com"), true);
    assert.equal(vertexBaseUrlLacksV1("https://gateway.example/vertex"), true);
});

test("vertexEnabled: Claude Code's switch, unset/falsey off", () => {
    assert.equal(vertexEnabled({}), false);
    assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: "" }), false);
    assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: "   " }), false);
    for (const off of ["0", "false", "FALSE", "no", "off", " False "]) {
        assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: off }), false, `${JSON.stringify(off)} must be off`);
    }
    for (const on of ["1", "true", "yes", "on", "TRUE"]) {
        assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: on }), true, `${JSON.stringify(on)} must be on`);
    }
});

test("stripBiliWrappers: unwraps our own /bili/ nesting, repeatedly", () => {
    // bili 0.1.197's Vertex managed block wrapped an already-managed value, so a
    // live settings file holds two layers; the outer one points the client at the
    // proxy's own port, which the tunnel guard denies (403 detail:"self").
    const inner = "https://aiplatform.googleapis.com/v1";
    assert.equal(stripBiliWrappers(`http://127.0.0.1:18787/bili/anthropic/${inner}`), inner);
    assert.equal(stripBiliWrappers(`http://127.0.0.1:18787/bili/${inner}`), inner, "unqualified /bili/ form");
    const doubled = `http://127.0.0.1:18787/bili/anthropic/http://127.0.0.1:18787/bili/anthropic/${inner}`;
    assert.equal(stripBiliWrappers(doubled), inner, "nesting collapses to the endpoint");
    assert.equal(stripBiliWrappers(` http://localhost:40000/bili/anthropic/${inner} `), inner);
    assert.equal(stripBiliWrappers(`http://[::1]:40000/bili/anthropic/${inner}`), inner);
    // A user endpoint is returned untouched (whitespace aside).
    assert.equal(stripBiliWrappers(" https://gateway.example/vertex/v1 "), "https://gateway.example/vertex/v1");
    assert.equal(stripBiliWrappers(""), "");
});

test("normalizeVertexModelId: bare ids pass through, date suffixes strip", () => {
    // Verification evidence: `claude-haiku-5-5` is GA and bare on the wire while
    // `claude-haiku-4-5@20251001` carries a date — both callable (live probe).
    assert.equal(normalizeVertexModelId("claude-haiku-5-5"), "claude-haiku-5-5");
    assert.equal(normalizeVertexModelId("claude-haiku-4-5@20251001"), "claude-haiku-4-5");
    assert.equal(normalizeVertexModelId(" claude-sonnet-4-5@20250929 "), "claude-sonnet-4-5");
    // A leading @ is not a suffix; neither is an empty string.
    assert.equal(normalizeVertexModelId("@20251001"), "@20251001");
    assert.equal(normalizeVertexModelId(""), "");
    // Only the first suffix strips (ids may carry several @ segments in theory).
    assert.equal(normalizeVertexModelId("a@b@c"), "a");
});

// ---------------------------------------------------------------------------
// vertexAnthropicModelFromPath (src/server.ts)
//
// The Vertex Messages body carries no `model` at all — `anthropic_version`
// replaces it — so this parser is the only source for every model-keyed
// decision on that wire. It is therefore a gate: a missed match costs a silent
// fallback to the floored window (the phase-2 log line exists for that), while
// a false match would attribute a Gemini request to a Claude model.
// ---------------------------------------------------------------------------

test("vertexAnthropicModelFromPath: both method suffixes, and the path the launcher emits", () => {
    const project = "aolshev-playground";
    assert.equal(
        vertexAnthropicModelFromPath(`/v1/projects/${project}/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict`),
        "claude-opus-5-5",
    );
    assert.equal(
        vertexAnthropicModelFromPath(`/v1/projects/${project}/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict`),
        "claude-opus-5-5",
    );
    // The real shape the launcher's child sends: protocol marker, absolute
    // upstream, then the client's own Vertex path. Pinned because the parser
    // runs against this string, not against a clean `/v1/...` path.
    assert.equal(
        vertexAnthropicModelFromPath(
            `/bili/anthropic/https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict`,
        ),
        "claude-opus-5-5",
    );
});

test("vertexAnthropicModelFromPath: a dated id is returned raw; stripping is normalizeVertexModelId's job", () => {
    // `claude-haiku-4-5@20251001` and bare `claude-haiku-5-5` are both callable
    // on Vertex. If this parser started stripping, the phase-2 normalisation
    // log would go quiet and nothing else would notice — so the two layers are
    // asserted separately rather than through one round trip.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict"), "claude-haiku-4-5@20251001");
    assert.equal(normalizeVertexModelId("claude-haiku-4-5@20251001"), "claude-haiku-4-5");
    assert.equal(normalizeVertexModelId(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict")!), "claude-haiku-4-5");
});

test("vertexAnthropicModelFromPath: unserved methods and non-Anthropic publishers yield no model", () => {
    // Anthropic's `:countTokens` is not served on Vertex (the endpoint 404s for
    // every model id, real or not), so it must not produce a model to key
    // decisions on.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude-opus-5-5:countTokens"), undefined);
    // No method suffix at all — a listing or a mistyped call.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude-opus-5-5"), undefined);
    // A suffix that merely starts with one of ours is not ours.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude-opus-5-5:rawPredictFoo"), undefined);
    // Another publisher's model, on both the Vertex and the Gemini path shape.
    assert.equal(vertexAnthropicModelFromPath("/publishers/google/models/gemini-3.1-flash-lite:rawPredict"), undefined);
    assert.equal(vertexAnthropicModelFromPath("/v1beta/models/gemini-3.8-flash:streamGenerateContent"), undefined);
    assert.equal(vertexAnthropicModelFromPath("/v1/projects/p/locations/global/models/claude-opus-5-5:rawPredict"), undefined);
    // An empty id is not an id.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/:rawPredict"), undefined);
});

test("vertexAnthropicModelFromPath: query, fragment and percent-encoding are handled", () => {
    // The suffix is matched with a word boundary, so a query string or fragment
    // after it does not hide the model.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude-opus-5-5:streamRawPredict?alt=sse"), "claude-opus-5-5");
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude-opus-5-5:rawPredict#top"), "claude-opus-5-5");
    // A percent-encoded id is decoded, matching what the client sent.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude%2Dopus%2D5%2D5:rawPredict"), "claude-opus-5-5");
    // An undecodable escape falls back to the raw match instead of throwing:
    // a malformed path must not take the request down.
    assert.equal(vertexAnthropicModelFromPath("/publishers/anthropic/models/claude%ZZopus:rawPredict"), "claude%ZZopus");
});

test("vertexAnthropicModelFromPath and the Gemini pair stay out of each other's paths", () => {
    const vertexPath = "/v1/projects/p/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict";
    const geminiPath = "/v1beta/models/gemini-3.8-flash:streamGenerateContent";
    // The sibling-not-widening contract behind phase 2's step 1.
    assert.equal(googleModelFromPath(vertexPath), undefined);
    assert.equal(googlePathKind(vertexPath), null);
    assert.equal(vertexAnthropicModelFromPath(geminiPath), undefined);
    assert.equal(googleModelFromPath(geminiPath), "gemini-3.8-flash");
    assert.equal(googlePathKind(geminiPath), "stream-generate");
});
