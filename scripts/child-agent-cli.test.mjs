import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('child CLI returns the child receipt, not the RPC envelope, and binds its own parent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frizz-child-cli-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const data of request) body += data;
    requests.push({ path: request.url, body: JSON.parse(body) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result: { version: 1, id: 'child', run_dir: '/private/child' } }));
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  t.after(async () => { await new Promise((accept) => server.close(accept)); rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  const lock = join(dir, 'server.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, port }));
  const input = { request: { version: 1, action: 'status', id: 'child' } };
  const output = await new Promise((accept, reject) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL('../cc-worker/bin/frizzctl.mjs', import.meta.url)), 'child', '--input', '-'], { env: { ...process.env, FRIZZ_STATE_DIR: dir, FRIZZ_SERVER_LOCK: lock, FRIZZ_THREAD_SLUG: 'parent', FRIZZ_PROJECT_ID: 'project' } }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : accept(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
  assert.deepEqual(output, { version: 1, id: 'child', run_dir: '/private/child' });
  assert.deepEqual(requests, [{ path: '/_frizz/project/rpc/ownChildAgent', body: { slug: 'parent', request: input.request } }]);
});
