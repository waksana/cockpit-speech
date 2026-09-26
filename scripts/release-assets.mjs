import assert from 'node:assert/strict';

// Download counts and uploader profile metadata are mutable, not asset identity.
export function assetIdentity(assets) {
  return assets.map(({ id, name, size, digest }) => ({ id, name, size, digest }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function publicationNotes(notes, releaseId, tag, sourceSha, assets) {
  const baseline = { format: 1, releaseId, tag, sourceSha, assets: assetIdentity(assets) };
  return `${notes}\n<!-- cockpit-rolling-identity\n${JSON.stringify(baseline)}\n-->\n`;
}
export function publicationIdentity(body) {
  assert.equal(typeof body, 'string');
  const match = body.match(/\n<!-- cockpit-rolling-identity\n([^\n]+)\n-->\n$/);
  assert.ok(match, 'Missing original publication identity');
  const identity = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(identity).sort(), ['assets', 'format', 'releaseId', 'sourceSha', 'tag']);
  assert.equal(identity.format, 1);
  return identity;
}
