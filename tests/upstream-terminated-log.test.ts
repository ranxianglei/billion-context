import { test } from "node:test";
import assert from "node:assert/strict";
import { isUpstreamTerminated, describeUpstreamTerminated } from "../src/logger.js";

const sock = Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });

test("undici 'terminated' with a socket cause is classified and described on one line", () => {
  const err = new TypeError("terminated", { cause: sock });
  assert.equal(isUpstreamTerminated(err), true);
  assert.equal(describeUpstreamTerminated(err), "upstream closed the connection mid-response (UND_ERR_SOCKET)");
});

test("NEG: other TypeErrors, other messages and non-errors are not classified", () => {
  assert.equal(isUpstreamTerminated(new TypeError("fetch failed", { cause: sock })), false);
  assert.equal(isUpstreamTerminated(new TypeError("terminated")), false);
  assert.equal(isUpstreamTerminated(new Error("terminated", { cause: sock })), false);
  assert.equal(isUpstreamTerminated("terminated"), false);
  assert.equal(isUpstreamTerminated(undefined), false);
});
