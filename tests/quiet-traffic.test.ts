import { test } from "node:test";
import assert from "node:assert/strict";
import { isQuietPollPath, noteQuietPoll, noteMitmTunnel, _resetQuietTrafficForTest } from "../src/quiet-traffic.js";

const HOUR = 3_600_000;

test("Remote Control's work poll is quiet, with or without a query", () => {
  assert.equal(isQuietPollPath("/v1/environments/env_01XjZRYJW5dfMM26gHMv7EWJ/work/poll"), true);
  assert.equal(isQuietPollPath("/v1/environments/env_01XjZRYJW5dfMM26gHMv7EWJ/work/poll?wait=30"), true);
});

test("NEG: model calls and other Remote Control paths are not quiet", () => {
  for (const p of ["/v1/messages", "/v1/messages?beta=true", "/v1/environments/bridge", "/v1/environments/env_1/bridge/reconnect", "/v1/environments/env_1/work/poll/extra", "/v1/code/sessions/cse_1/worker/events/stream", "/api/oauth/usage", "", "/x/v1/environments/env_1/work/poll"]) {
    assert.equal(isQuietPollPath(p), false, p);
  }
});

test("polls are counted and summarised once an hour, never per request", () => {
  _resetQuietTrafficForTest();
  const t0 = 1_000_000;
  assert.equal(noteQuietPoll(t0), null);
  for (let i = 1; i < 500; i++) assert.equal(noteQuietPoll(t0 + i * 1000), null);
  const line = noteQuietPoll(t0 + HOUR);
  assert.match(line ?? "", /^\[quiet\] 501 Remote Control work polls in the last 60 min/);
  assert.equal(noteQuietPoll(t0 + HOUR + 1000), null);
});

test("the first tunnel per host logs, later ones log once an hour with the count", () => {
  _resetQuietTrafficForTest();
  const t0 = 5_000_000;
  assert.equal(noteMitmTunnel("api.anthropic.com:443", "api.anthropic.com:443", t0), "mitm api.anthropic.com:443 tunnel established (TLS terminated locally)");
  for (let i = 1; i < 100; i++) assert.equal(noteMitmTunnel("api.anthropic.com:443", "api.anthropic.com:443", t0 + i * 1000), null);
  assert.equal(noteMitmTunnel("api.anthropic.com:443", "api.anthropic.com:443", t0 + HOUR), "mitm api.anthropic.com:443 tunnel established (TLS terminated locally); 100 tunnels to this host in the last 60 min");
  assert.equal(noteMitmTunnel("api.anthropic.com:443", "api.anthropic.com:443", t0 + HOUR + 1), null);
});

test("NEG: a new host is a first sighting and logs at once", () => {
  _resetQuietTrafficForTest();
  assert.notEqual(noteMitmTunnel("api.anthropic.com:443", "api.anthropic.com:443", 1), null);
  assert.notEqual(noteMitmTunnel("chatgpt.com:443", "chatgpt.com:443", 2), null);
});

test("two private hosts behind the same masked label each log their first tunnel", () => {
  _resetQuietTrafficForTest();
  assert.equal(noteMitmTunnel("relay-a.internal:443", "<private-host>:443", 1), "mitm <private-host>:443 tunnel established (TLS terminated locally)");
  assert.equal(noteMitmTunnel("relay-b.internal:443", "<private-host>:443", 2), "mitm <private-host>:443 tunnel established (TLS terminated locally)");
});
