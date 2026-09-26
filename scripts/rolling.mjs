import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeIdentity, prepareRolling, repository, rollingTag } from './rolling-identity.mjs';
import { checkRelease } from './check-release.mjs';
import { publishRelease } from './publish-release.mjs';

export const runGh = args => execFileSync('gh', args, { maxBuffer: 40 * 1024 * 1024, timeout: 120_000 });
export function mutation(run, args) {
  try { return run(args); }
  catch (cause) {
    throw new Error('Mutation failed or has an unknown result. Stop and inspect by ID; no write was retried.', { cause });
  }
}
export function checkRemoteTag(run, tag, sha, create = false) {
  assert.match(tag, rollingTag);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const path = `repos/${repository}/git`;
  const refs = JSON.parse(run(['api', `${path}/matching-refs/tags/${tag}`]));
  assert.ok(Array.isArray(refs), 'Invalid ref discovery');
  const exact = refs.filter(ref => ref.ref === `refs/tags/${tag}`);
  assert.ok(exact.length <= 1, 'Duplicate tag');
  if (!exact.length) {
    assert.ok(create, 'Rolling tag is missing');
    mutation(run, ['api', `${path}/refs`, '--method', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
    return checkRemoteTag(run, tag, sha);
  }
  assert.equal(exact[0].object?.type, 'commit', 'Rolling tags must be immutable lightweight refs');
  assert.equal(exact[0].object.sha, sha, 'Rolling tag source changed');
}
export async function releaseNotes(event, value, directory) {
  const archive = `cockpit-speech-${value.version}.tgz`;
  const checksums = await Promise.all([`${archive}.sha256`, 'cockpit-deployment.json.sha256']
    .map(name => readFile(join(directory, name), 'utf8')));
  return `# ${event.pull_request.title}\n\n${event.pull_request.body ?? ''}\n\n`
    + `## Rolling identity\n\nPR: https://github.com/${repository}/pull/${event.pull_request.number}\n`
    + `Source: ${value.sourceSha}\nTag: ${value.tag}\nVersion: ${value.version}\nSequence: ${value.sequence}\n\n`
    + `Assets: ${archive}, ${archive}.sha256, cockpit-deployment.json, cockpit-deployment.json.sha256\n\n`
    + `\`\`\`text\n${checksums.join('')}\`\`\`\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const value = mergeIdentity(event, Number(process.env.GITHUB_RUN_NUMBER));
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), value.sourceSha);
  if (command === 'prepare') {
    await prepareRolling(root, value.sourceSha, value.sequence);
  } else if (command === 'verify') {
    await checkRelease(root, value.tag, value.sourceSha, join(root, 'module-output'));
  } else if (command === 'publish') {
    execFileSync('git', ['merge-base', '--is-ancestor', value.sourceSha, 'origin/main'], { cwd: root });
    const directory = join(root, 'release-artifact');
    await checkRelease(root, value.tag, value.sourceSha, directory);
    checkRemoteTag(runGh, value.tag, value.sourceSha, true);
    await publishRelease({ repository, tag: value.tag, sha: value.sourceSha, directory,
      notes: await releaseNotes(event, value, directory) });
  } else throw new Error('Usage: rolling.mjs prepare|verify|publish');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `${command}: ${value.tag}, source ${value.sourceSha}, sequence ${value.sequence}\n`);
}
