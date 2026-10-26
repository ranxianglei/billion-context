import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { resolveModulePath } from "../verif/symbolic.js";

/**
 * win32 doubled-drive-letter pin (#4195): windows CI rendered
 *
 *     error: ENOENT: no such file or directory, open
 *     'D:\D:\a\billion-context\billion-context\verif\drivers\responses-ingress-driver.ts'
 *
 * when the loader received a path whose root got re-joined onto an
 * already-absolute workspace path (URL `.pathname` shapes carry `/D:/...`,
 * and node resolves the leading `/` against the cwd drive root → `D:\D:\...`).
 * The loader's path seam must use already-absolute inputs as-is — this pin
 * runs on every host (no solver needed) so the win32 shapes are asserted on
 * linux/CI too.
 */

test("resolveModulePath: already-absolute win32 driver path is used as-is (no doubled drive)", () => {
  const winAbs = "D:\\a\\billion-context\\billion-context\\verif\\drivers\\x.ts";
  assert.equal(resolveModulePath(winAbs), winAbs);
  assert.ok(!resolveModulePath(winAbs).includes("D:\\D:\\"));

  const winFwd = "D:/a/billion-context/billion-context/verif/drivers/x.ts";
  assert.equal(resolveModulePath(winFwd), winFwd);
  assert.ok(!resolveModulePath(winFwd).includes("D:\\D:\\"));
});

test("resolveModulePath: URL pathname shape `/D:/a/...` is de-mangled, not drive-doubled", () => {
  const mangled = "/D:/a/billion-context/billion-context/verif/drivers/x.ts";
  const resolved = resolveModulePath(mangled);
  assert.equal(resolved, "D:/a/billion-context/billion-context/verif/drivers/x.ts");
  assert.ok(!resolved.includes("D:\\D:\\"));
  // idempotent: resolving the cleaned form again never re-roots it
  assert.equal(resolveModulePath(resolved), resolved);
});

test("resolveModulePath: POSIX absolute stays as-is; relative joins the repo root", () => {
  const posix = "/home/u/billion-context/verif/drivers/x.ts";
  assert.equal(resolveModulePath(posix), posix);

  const rel = resolveModulePath("verif/drivers/x.ts");
  assert.ok(isAbsolute(rel), `expected an absolute path, got ${rel}`);
  assert.ok(!rel.includes("D:\\D:\\"));
});
