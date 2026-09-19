import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { prepareSdk } from './sdk.mjs';
import { git, sdkIdentity } from './build-identity.mjs';
import { commitFixture, releaseFixture } from './test-support/release-fixture.mjs';

test('SDK export verifies exact clean host SHA, package version and generated inventory', async t => {
  const f = await releaseFixture(t);
  const host = await mkdtemp(new URL('../node_modules/sdk-host-fixture-', import.meta.url));
  t.after(() => rm(host, { recursive: true, force: true }));
  for (const name of ['module-api', 'protocol']) {
    await mkdir(join(host, 'packages', name), { recursive: true });
    await writeFile(join(host, 'packages', name, 'package.json'), '{"version":"0.2.0"}');
  }
  await mkdir(join(host, 'scripts'));
  await writeFile(join(host, 'scripts/export-module-api.mjs'), `
import {mkdir,writeFile} from 'node:fs/promises';
const target=process.argv[2];
await mkdir(target);
for(const name of ['module-api','protocol']){
  await mkdir(target+'/'+name);
  await writeFile(target+'/'+name+'/package.json',JSON.stringify({name:'@cockpit/'+name,version:'0.2.0'}));
}
await writeFile(target+'/LICENSE','Synthetic SDK license');
`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: host, stdio: 'pipe' });
  commitFixture(host);
  const pin = { ...f.pin, commit: git(host, ['rev-parse', 'HEAD']) };
  await writeFile(join(f.root, 'tooling/host-sdk.json'), JSON.stringify(pin));
  assert.deepEqual(await prepareSdk(f.root, host), pin);
  assert.deepEqual(await sdkIdentity(f.root), pin);
  assert.deepEqual(await prepareSdk(f.root, host), pin);
  await writeFile(join(host, 'dirty.txt'), 'Uncommitted host change');
  await assert.rejects(prepareSdk(f.root, host), /clean, exact pinned/);
  await rm(join(host, 'dirty.txt'));
  await writeFile(join(f.root, '.cockpit-sdk/protocol/package.json'), '{"version":"different"}');
  await assert.rejects(prepareSdk(f.root, host), /Existing generated SDK differs/);
});

test('CI uses fixed SDK checkout, frozen dependencies and exact package verification without credentials/deployment', async () => {
  const ci = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  for (const text of ['pull_request:', 'name: Required checks', 'sdk.mjs prepare .host-sdk-source',
    'pnpm install --frozen-lockfile --ignore-scripts', 'pnpm typecheck', 'pnpm test',
    'pnpm build', 'pnpm package', 'verify-package.mjs']) assert.ok(ci.includes(text), text);
  assert.doesNotMatch(ci, /contents: write|pull_request_target|secrets\.|ssh |systemctl|release create/);
  for (const [, use] of ci.matchAll(/uses:\s+([^\s]+)/g)) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
});

test('source icon nodes and shipped notice match lucide-static exactly', async () => {
  const metadata = JSON.parse(await readFile(new URL('../node_modules/lucide-static/package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.version, '1.46.0');
  const icons = await readFile(new URL('../src/web/icons.ts', import.meta.url), 'utf8');
  for (const name of ['mic', 'rotate-ccw']) {
    const svg = await readFile(new URL(`../node_modules/lucide-static/icons/${name}.svg`, import.meta.url), 'utf8');
    for (const [, path] of svg.matchAll(/d="([^"]+)"/g)) assert.ok(icons.includes(path));
  }
  assert.equal(
    await readFile(new URL('../licenses/lucide.txt', import.meta.url), 'utf8'),
    await readFile(new URL('../node_modules/lucide-static/LICENSE', import.meta.url), 'utf8'),
  );
});
