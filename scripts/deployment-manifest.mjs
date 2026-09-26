import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identity } from './rolling-identity.mjs';

const vocabulary = {
  apiVersion: 'frontend-api', uiVersion: 'ui', uiSurfaceVersion: 'uiSurface',
  chatWindowVersion: 'chatWindow', composerInputVersion: 'composerInput',
  draftLifecycleVersion: 'draftLifecycle', draftSubmissionVersion: 'draftSubmission',
};

export async function moduleProduct(root) {
  const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  assert.equal(manifest.id, 'cockpit-speech');
  assert.equal(manifest.apiVersion, 1, 'Review changed host API compatibility');
  const frontend = await readFile(join(root, 'src/web/index.ts'), 'utf8');
  const guards = [...frontend.matchAll(/context\.(\w+Version)\s*!==\s*(\d+)/g)];
  assert.equal(guards.length, Object.keys(vocabulary).length, 'Review changed frontend capabilities');
  const requiresCapabilities = ['module-api.v1', ...guards.map(([, field, version]) => {
    assert.ok(vocabulary[field], `Unknown host capability: ${field}`);
    return `${vocabulary[field]}.v${version}`;
  })].sort();
  assert.equal(new Set(requiresCapabilities).size, requiresCapabilities.length);
  // This backend reads only azure-openai.json; it calls no host intents and owns no DB.
  const backend = await readFile(join(root, 'src/server/index.ts'), 'utf8');
  const config = await readFile(join(root, 'src/server/config.ts'), 'utf8');
  assert.doesNotMatch(backend + config, /context\.host|sqlite|Database|migrat/i, 'Review new backend persistence or intents');
  assert.match(config, /azure-openai\.json/);
  return { kind: 'module', id: manifest.id, hostApi: { min: manifest.apiVersion, max: manifest.apiVersion },
    requiresCapabilities, requiredIntents: [], databases: [], migrations: [] };
}

export async function deploymentManifest(root, sha, sequence) {
  const value = identity(sha, sequence);
  return { format: 2, channel: 'rolling', ...value,
    archive: { name: `cockpit-speech-${value.version}.tgz` }, product: await moduleProduct(root) };
}
