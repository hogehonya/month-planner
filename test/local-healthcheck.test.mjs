import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApplication, createHttpServer } from '../local-runtime/server.mjs';

const run = promisify(execFile);
const healthcheck = fileURLToPath(new URL('../local-runtime/healthcheck.mjs', import.meta.url));

test('container healthcheck sends canonical Host and checks deployed revision over real HTTP', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'planner-healthcheck-'));
  const origin = 'https://month-planner.honya.dev';
  const revision = 'healthcheck-regression';
  const application = await createApplication({ dataDir, origin, revision });
  const server = createHttpServer(application, origin);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, APP_ORIGIN: origin, APP_REVISION: revision, PORT: String(server.address().port) };
  const check = (args = [], overrides = {}) => run(process.execPath, [healthcheck, ...args], { env: { ...env, ...overrides }, timeout: 6000 });

  assert.match((await check()).stdout, /Healthy revision healthcheck-regression/);
  assert.match((await check([revision], { APP_REVISION: 'different-environment' })).stdout, /Healthy revision/);
  await assert.rejects(check(['wrong-revision']), error => error.code === 1);
  await assert.rejects(check([], { APP_ORIGIN: 'https://wrong-host.test' }), error => error.code === 1);
  await assert.rejects(check([], { APP_REVISION: '' }), error => error.code === 1);
});
