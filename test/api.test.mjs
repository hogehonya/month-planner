import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../netlify/functions/planner.mjs';
import { DEFAULT_BASE } from '../public/model.mjs';

function setup() {
  const data = new Map(); let version = 0;
  const store = {
    failHistory: false, forceConflict: false,
    async getWithMetadata(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
    async get(key) { return structuredClone(data.get(key)?.data ?? null); },
    async setJSON(key, value, options = {}) {
      if (store.failHistory && key.startsWith('history/')) throw new Error('unavailable');
      const old = data.get(key);
      if (store.forceConflict || (options.onlyIfNew && old) || (options.onlyIfMatch && old?.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = String(++version); data.set(key, { data: structuredClone(value), etag });
      return { modified: true, etag };
    },
    async list({ prefix }) { return { blobs: [...data.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
  };
  const pin = randomUUID();
  const handler = createHandler({ getStore: () => store, getPin: () => pin, sleep: async () => {} });
  const post = body => handler(new Request('https://planner.example/.netlify/functions/planner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, ...body }) }));
  const get = () => handler(new Request('https://planner.example/.netlify/functions/planner?start=2026-10-01&end=2026-10-31'));
  const save = (field, value) => post(field === 'note' ? { action: 'save', editor_name: 'テスト編集者', entry_date: '2026-10-05', field, value } : { action: 'save_slot', editor_name: 'テスト編集者', entry_date: '2026-10-05', slot: field, title: value, content: value + '内容' });
  return { store, data, handler, post, get, save };
}

test('閲覧は公開・キャッシュ禁止、PINは検証して応答へ含めない', async () => {
  const { get, post } = setup();
  const view = await get();
  assert.equal(view.status, 200); assert.match(view.headers.get('Cache-Control'), /no-store/);
  assert.equal((await view.json()).entries.length, 31);
  assert.deepEqual(await (await post({ action: 'verify' })).json(), { ok: true });
  assert.equal((await post({ action: 'verify', pin: 'wrong' })).status, 401);
});

test('PIN未設定はfail closed、型・文字数・日付・フィールドを検証する', async () => {
  const { post } = setup();
  for (const patch of [{ field: '__proto__' }, { value: 'x'.repeat(3001) }, { entry_date: '2026-02-30' }, { editor_name: '' }, { editor_name: '名'.repeat(41) }, { value: 42 }]) {
    assert.equal((await post({ action: 'save', editor_name: '名前', entry_date: '2026-10-05', field: 'note', value: '予定', ...patch })).status, 400);
  }
  const noPin = createHandler({ getPin: () => '', getStore: () => { throw new Error('not reached'); } });
  assert.equal((await noPin(new Request('https://planner.example/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"verify","pin":""}' }))).status, 503);
});

test('新規同時更新と既存同時更新で別セルの内容が消えない', async () => {
  const { save, get } = setup();
  let responses = await Promise.all([save('slot1', '朝'), save('note', '雨具')]);
  assert.ok(responses.every(r => r.status === 200));
  responses = await Promise.all([save('slot2', '昼'), save('note', '長靴')]);
  assert.ok(responses.every(r => r.status === 200));
  const view = await (await get()).json(), row = view.entries.find(r => r.entry_date === '2026-10-05');
  assert.equal(row.slot1_title, '朝'); assert.equal(row.slot1_content, '朝内容'); assert.equal(row.slot2_title, '昼'); assert.equal(row.slot2_content, '昼内容'); assert.equal(row.note, '長靴');
  assert.equal(view.history.length, 4);
  assert.ok(view.history.every(h => !('value' in h) && !('before' in h)));
});

test('6回競合したら409、履歴を追加しない', async () => {
  const { store, save, data } = setup(); store.forceConflict = true;
  assert.equal((await save('slot1', '競合')).status, 409);
  assert.equal(data.size, 0);
});

test('既存データのETagが取得できない場合は無条件書込せず503を返す', async () => {
  const { data, save } = setup();
  data.set('entries/2026-10-05.json', { data: { entry_date: '2026-10-05', slot1: '保持する予定' } });
  assert.equal((await save('note', '新しい備考')).status, 503);
  assert.equal(data.get('entries/2026-10-05.json').data.slot1, '保持する予定');
  assert.equal(Object.hasOwn(data.get('entries/2026-10-05.json').data, 'note'), false);
});

test('履歴転記失敗でも予定と履歴メタデータを保持し、再読込で回復する', async () => {
  const { store, save, get, data } = setup(); store.failHistory = true;
  const result = await (await save('slot1', '保存済み')).json();
  assert.equal(result.ok, true); assert.equal(result.history_saved, false);
  let view = await (await get()).json();
  assert.equal(view.history.length, 1);
  store.failHistory = false; view = await (await get()).json();
  assert.equal(view.history.length, 1);
  assert.equal([...data.keys()].filter(k => k.startsWith('history/')).length, 1);
});

test('時間割はPIN編集から変更不可、追加内容だけ保存し既存予定を保持する', async () => {
  const { post, get, data } = setup();
  const base = { ...DEFAULT_BASE, weekdays: { mon: { slot1: '定例', slot2: '午後' } } };
  data.set('settings/base.json', { data: { base }, etag: 'base-initial' });
  data.set('entries/2026-10-05.json', { data: { slot1: '既存予定', note: '備考' }, etag: 'entry-initial' });
  assert.equal((await post({ action: 'base', editor_name: '設定者', base, expected_etag: 'base-initial' })).status, 403);
  assert.equal((await post({ action: 'save', editor_name: '名前', entry_date: '2026-10-05', field: 'slot1', value: '変更' })).status, 400);
  assert.equal((await post({ action: 'save', editor_name: '名前', entry_date: '2026-10-05', field: 'slot2', value: '変更' })).status, 400);
  const result = await post({ action: 'save_slot', editor_name: '名前', entry_date: '2026-10-05', slot: 'slot1', title: '見出し', content: '内容' });
  assert.equal(result.status, 200);
  const view = await (await get()).json(), row = view.entries.find(r => r.entry_date === '2026-10-05');
  assert.equal(row.slot1, '既存予定'); assert.equal(row.slot2, '午後'); assert.equal(row.note, '備考');
  assert.equal(row.slot1_title, '見出し'); assert.equal(row.slot1_content, '内容');
  assert.equal(row.slot2_title, ''); assert.equal(row.slot2_content, '');
  assert.deepEqual(data.get('settings/base.json'), { data: { base }, etag: 'base-initial' });
});

test('コマの見出しと内容を一緒に検証し、過大・型不正・認証不正を保存しない', async () => {
  const { post, data } = setup();
  const body = { action: 'save_slot', editor_name: '名前', entry_date: '2026-10-05', slot: 'slot1', title: '題', content: '本文' };
  for (const patch of [{ slot: 'slot3' }, { title: '題'.repeat(121) }, { content: '文'.repeat(3001) }, { title: null }, { content: 42 }, { entry_date: '2026-02-30' }]) {
    assert.equal((await post({ ...body, ...patch })).status, 400); assert.equal(data.size, 0);
  }
  assert.equal((await post({ ...body, pin: 'wrong' })).status, 401); assert.equal(data.size, 0);
  assert.equal((await post({ ...body, title: '題'.repeat(120), content: '文'.repeat(3000) })).status, 200);
  assert.equal((await post({ ...body, title: '', content: '' })).status, 200);
  const entry = data.get('entries/2026-10-05.json').data;
  assert.equal(entry.slot1_title, ''); assert.equal(entry.slot1_content, '');
});

test('JSON以外・外部origin・不正な期間を拒否する', async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request('https://planner.example/', { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await handler(new Request('https://planner.example/', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' }))).status, 403);
  assert.equal((await handler(new Request('https://planner.example/?start=2026-01-01&end=2026-03-01'))).status, 400);
});
