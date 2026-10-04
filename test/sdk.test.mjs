import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStore } from '@netlify/blobs';
import { BlobsServer } from '@netlify/blobs/server';
import { createHandler } from '../netlify/functions/planner.mjs';
import { DEFAULT_BASE } from '../public/model.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'planner-sdk-'));
  const token = randomUUID();
  const server = new BlobsServer({ directory, token });
  t.after(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });
  const { address } = await server.start();
  const store = getStore({ name: 'shared-planner', siteID: randomUUID(), token, apiURL: address, consistency: 'strong' });
  const pin = randomUUID();
  const handler = createHandler({ getStore: () => store, getPin: () => pin });
  const post = body => handler(new Request('https://planner.example/api/planner', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, editor_name: 'SDK検証者', ...body }),
  }));
  const get = () => handler(new Request('https://planner.example/api/planner?start=2026-10-01&end=2026-10-31'));
  return { store, post, get };
}

test('実SDKの条件付き書込はETagとmodifiedを返し、不一致・新規重複を拒否する', async t => {
  const { store } = await fixture(t);
  const first = await store.setJSON('contract.json', { value: 1 }, { onlyIfNew: true });
  assert.equal(first.modified, true);
  const snapshot = await store.getWithMetadata('contract.json', { type: 'json' });
  // BlobsServer 11.1.3 omits ETag on GET; use the write response for CAS.
  // This emulator cannot validate the production getWithMetadata ETag contract.
  assert.equal(snapshot.etag, undefined);
  assert.equal(typeof first.etag, 'string');
  assert.deepEqual(snapshot.data, { value: 1 });
  assert.equal((await store.setJSON('contract.json', { value: 2 }, { onlyIfNew: true })).modified, false);
  assert.equal((await store.setJSON('contract.json', { value: 2 }, { onlyIfMatch: 'stale-etag' })).modified, false);
  assert.equal((await store.setJSON('contract.json', { value: 2 }, { onlyIfMatch: first.etag })).modified, true);
  assert.deepEqual(await store.get('contract.json', { type: 'json' }), { value: 2 });
});

test('実SDKで時間割のETag競合、個別空欄と履歴を保持する', async t => {
  const { store, post, get } = await fixture(t);
  let view = await (await get()).json();
  assert.equal(view.base_etag, null);
  const base = { ...DEFAULT_BASE, weekdays: { mon: { slot1: '定例', slot2: '午後' } } };
  const initial = await post({ action: 'base', base, expected_etag: null });
  assert.equal(initial.status, 200);
  const snapshot = await store.getWithMetadata('settings/base.json', { type: 'json' });
  if (!snapshot.etag) {
    t.skip('BlobsServer 11.1.3 GET lacks ETag; API CAS/history requires production verification');
    return;
  }
  view = await (await get()).json();
  assert.equal(typeof view.base_etag, 'string');
  assert.equal((await post({ action: 'base', base, expected_etag: null })).status, 409);
  assert.equal((await post({ action: 'base', base, expected_etag: 'stale-etag' })).status, 409);
  assert.equal((await post({ action: 'save', entry_date: '2026-10-05', field: 'slot1', value: '' })).status, 200);
  assert.equal((await post({ action: 'save', entry_date: '2026-10-05', field: 'note', value: '長靴' })).status, 200);
  view = await (await get()).json();
  const row = view.entries.find(entry => entry.entry_date === '2026-10-05');
  assert.equal(row.slot1, ''); assert.equal(row.slot2, '午後'); assert.equal(row.note, '長靴');
  assert.deepEqual(row.overridden_fields, ['slot1', 'note']);
  assert.equal(view.history_saved, true);
  assert.equal(view.history.length, 3);
  assert.equal(new Set(view.history.map(event => event.id)).size, 3);
  assert.ok(view.history.every(event => event.editor_name === 'SDK検証者' && !('value' in event) && !('pin' in event)));
  assert.equal((await store.list({ prefix: 'history/' })).blobs.length, 3);
  assert.deepEqual((await store.get('entries/2026-10-05.json', { type: 'json' }))._pending_history, []);
  assert.deepEqual((await store.get('settings/base.json', { type: 'json' }))._pending_history, []);
  assert.equal((await (await get()).json()).history.length, 3);
});
