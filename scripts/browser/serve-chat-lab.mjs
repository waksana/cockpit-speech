import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const host = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, '../..');
const pin = JSON.parse(await readFile(resolve(root, 'tooling/host-sdk.json'), 'utf8'));
if (execFileSync('git', ['-C', host, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pin.commit) {
  throw new Error('Chat Lab must use the exact pinned host commit');
}
process.env.COCKPIT_CHAT_LAB = '1';
const { createServer } = await import(pathToFileURL(resolve(host, 'apps/web/node_modules/vite/dist/node/index.js')).href);
const server = await createServer({
  root: resolve(host, 'apps/web'),
  server: { host: '127.0.0.1', port: 5187, strictPort: true, fs: { allow: [host, root] } },
});
await server.listen();
server.printUrls();
