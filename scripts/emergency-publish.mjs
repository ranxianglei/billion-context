#!/usr/bin/env node
// Emergency one-liner publish for the OWNER'S machine (#5430 follow-up, 2026-11-01).
//
// This is the literal "npm run build && npm publish" button: it does a dependency
// install-free build and publishes straight to npm, then tags v{VERSION}, pushes the
// tag and creates the GitHub Release (when GITHUB_TOKEN is set). No typecheck, no
// tests, nothing else. It works because this machine already has node_modules —
// which is exactly why the GitHub one-click box needs its one-time dependency
// download on the empty cloud container, while this script never installs anything.
//
// Usage:
//   NPM_TOKEN=... GITHUB_TOKEN=... node scripts/emergency-publish.mjs            # real publish
//   node scripts/emergency-publish.mjs --dry-run                                 # build + publish --dry-run only
//
// NPM_TOKEN: required for a real publish (never written to disk; passed as env to npm).
// GITHUB_TOKEN: optional — without it the git tag is still pushed by your git auth,
// but the GitHub Release object is skipped.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dry = process.argv.includes('--dry-run');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ver = pkg.version;
const name = pkg.name;
const gh = process.env.GITHUB_TOKEN || '';

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}
function sh(args) {
  run('sh', ['-c', args]);
}

if (!dry && !process.env.NPM_TOKEN) {
  console.error('[emergency-publish] NPM_TOKEN is required for a real publish. Set it and re-run, or use --dry-run.');
  process.exit(1);
}

console.log(`[emergency-publish] ${name}@${ver} ${dry ? '(dry-run)' : '(REAL PUBLISH)'}`);

const existsCheck = spawnSync('npm', ['view', `${name}@${ver}`, 'version'], { cwd: root, encoding: 'utf8' });
if (!dry && existsCheck.status === 0) {
  console.error(`[emergency-publish] v${ver} already exists on npm — refusing to re-publish.`);
  process.exit(1);
}

run('npm', ['run', 'build']);
if (dry) {
  run('npm', ['publish', '--dry-run', '--provenance=false'], { NPM_CONFIG_PROVENANCE: 'false' });
  console.log(`[emergency-publish] dry-run OK for ${name}@${ver}. Nothing was published.`);
  process.exit(0);
}

run('npm', ['publish'], { NPM_CONFIG_PROVENANCE: 'false', NODE_AUTH_TOKEN: process.env.NPM_TOKEN });
console.log(`[emergency-publish] published ${name}@${ver} to npm.`);

sh(`git tag -f v${ver}`);
sh(`git push origin v${ver}`);

if (gh) {
  const notes = sh(`git log --pretty=format:'- %s' $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~1)..HEAD | head -40`) || '(no prior tag found)';
  const body = `\u{1F6A8} **RAW EMERGENCY PUBLISH** (local \`scripts/emergency-publish.mjs\`, #5430): published straight from \`npm run build\` — no typecheck, no tests, no CI lanes ran, and master was not pushed.\n\n## Changes\n\n${notes}`;
  const payload = JSON.stringify({ tag_name: `v${ver}`, name: `v${ver}`, prerelease: false, body });
  const out = execFileSync('curl', [
    '-sS', '-X', 'POST',
    '-H', `Authorization: Bearer ${gh}`,
    '-H', 'Accept: application/vnd.github+json',
    '-d', payload,
    'https://api.github.com/repos/ranxianglei/billion-context/releases',
  ], { encoding: 'utf8' });
  try {
    const rel = JSON.parse(out);
    if (rel.id) console.log(`[emergency-publish] GitHub Release created: ${rel.html_url}`);
    else console.warn(`[emergency-publish] release create returned: ${out.slice(0, 200)}`);
  } catch {
    console.warn(`[emergency-publish] could not parse release response: ${out.slice(0, 200)}`);
  }
} else {
  console.log('[emergency-publish] GITHUB_TOKEN not set — skipped creating the GitHub Release object (tag v' + ver + ' was pushed).');
}

console.log('[emergency-publish] done. Next one-click Actions release will pause on the drift guard until a version-sync PR merges (by design).');
