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
    async set(key, value, options = {}) {
      if (store.failPhoto) throw new Error('photo failed');
      const etag = String(++version); data.set(key, { data: value, metadata: options.metadata, etag }); return { modified: true, etag };
    },
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
  const get = (commentDate = '2026-10-05') => handler(new Request('https://planner.example/.netlify/functions/planner?start=2026-10-01&end=2026-10-31' + (commentDate === null ? '' : '&comment_date=' + commentDate)));
  const save = (field, value) => post(field === 'note' ? { action: 'save', editor_name: 'テスト編集者', entry_date: '2026-10-05', field, value } : { action: 'save_slot', editor_name: 'テスト編集者', entry_date: '2026-10-05', slot: field, title: value, content: value + '内容' });
  const photo = (bytes, mime = 'image/png', patch = {}, slot = 'slot1', date = '2026-10-05') => handler(new Request(`https://planner.example/.netlify/functions/planner?action=upload_photo&entry_date=${date}&slot=${slot}`, { method: 'POST', headers: { 'Content-Type': mime, 'X-Edit-Pin': pin, 'X-Editor-Name': encodeURIComponent('写真編集者'), ...patch }, body: bytes }));
  return { store, data, handler, post, get, save, photo };
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

test('追加予定取込は全件検証後に指定項目だけ保存し、同値再送の履歴を増やさない', async () => {
  const { post, data, get } = setup();
  data.set('entries/2026-10-06.json', { data: { slot1: '固定予定', slot1_content: '保持', slot2_title: '午後保持', note: '旧備考' }, etag: 'initial' });
  const body = { action: 'import_entries', editor_name: '取込者', entries: [{ entry_date: '2026-10-06', slot1_title: '新見出し', note: '' }, { entry_date: '2026-10-07', slot2_content: '午後内容' }] };
  assert.equal((await post({ ...body, entries: [...body.entries, { entry_date: '2026-02-30', note: '不正' }] })).status, 400);
  assert.equal(data.size, 1);
  assert.equal((await post({ ...body, pin: 'wrong' })).status, 401);
  const response = await post(body); assert.equal(response.status, 200);
  const result = await response.json(); assert.ok(result.results.every(row => row.saved));
  const row = data.get('entries/2026-10-06.json').data;
  assert.equal(row.slot1, '固定予定'); assert.equal(row.slot1_title, '新見出し'); assert.equal(row.slot1_content, '保持'); assert.equal(row.slot2_title, '午後保持'); assert.equal(row.note, '');
  const before = (await (await get()).json()).history.length;
  await post(body); assert.equal((await (await get()).json()).history.length, before);
  assert.equal((await post({ ...body, entries: [{ entry_date: '2026-10-06', slot1: '変更' }] })).status, 400);
});

test('追加予定取込の部分失敗と履歴転記失敗は日ごとの結果で再試行できる', async () => {
  const { post, data, store } = setup();
  data.set('entries/2026-10-07.json', { data: { note: '保持' } });
  store.failHistory = true;
  const body = { action: 'import_entries', editor_name: '取込者', entries: [{ entry_date: '2026-10-06', note: '保存' }, { entry_date: '2026-10-07', note: '失敗' }] };
  const result = await (await post(body)).json();
  assert.equal(result.results[0].saved, true); assert.equal(result.results[0].history_saved, false);
  assert.equal(result.results[1].saved, false); assert.match(result.results[1].error, /保存状態/);
  assert.equal(data.get('entries/2026-10-07.json').data.note, '保持');
  data.get('entries/2026-10-07.json').etag = 'recovered'; store.failHistory = false;
  const retry = await (await post(body)).json(); assert.ok(retry.results.every(row => row.saved));
  assert.equal([...data.keys()].filter(key => key.startsWith('history/')).length, 2);
});

test('追加予定取込は日数・重複・項目制限とリクエストサイズを拒否する', async () => {
  const { post, data } = setup();
  const body = { action: 'import_entries', editor_name: '取込者' };
  const entry = { entry_date: '2026-10-06', note: '備考' };
  for (const entries of [[], [entry, entry], [{ ...entry, note: 'x'.repeat(3001) }], [{ ...entry, slot1_content: null }], [{ ...entry, extra: 'x' }], Array.from({ length: 32 }, () => entry)]) {
    assert.equal((await post({ ...body, entries })).status, 400); assert.equal(data.size, 0);
  }
  assert.equal((await post({ ...body, entries: [{ ...entry, note: 'x'.repeat(262144) }] })).status, 413); assert.equal(data.size, 0);
});

const pngPhoto = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
const jpegPhoto = Buffer.from('ffd8ffe00001ffd9', 'hex');
const webpPhoto = Buffer.from('524946461000000057454250565038200400000000000000', 'hex');
test('午前午後の写真を保存・公開し、差替えと同値再送で予定を保持する', async () => {
  const { photo, handler, data, get, post } = setup();
  await post({ action: 'save_slot', editor_name: '名前', entry_date: '2026-10-05', slot: 'slot1', title: '見出し', content: '内容' });
  const first = await photo(pngPhoto); assert.equal(first.status, 200);
  const result = await first.json(); assert.match(result.row.slot1_photo.id, /^[a-f0-9]{64}$/);
  assert.equal(result.row.slot1_title, '見出し'); assert.equal(result.row.slot1_content, '内容'); assert.equal(result.row.slot2_photo, null);
  const response = await handler(new Request('https://planner.example' + result.row.slot1_photo.url));
  assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngPhoto);
  const before = (await (await get()).json()).history.length;
  await photo(pngPhoto); assert.equal((await (await get()).json()).history.length, before);
  assert.equal((await photo(jpegPhoto, 'image/jpeg')).status, 200);
  const row = (await (await get()).json()).entries.find(row => row.entry_date === '2026-10-05');
  assert.notEqual(row.slot1_photo.id, result.row.slot1_photo.id); assert.equal(row.slot1_title, '見出し');
  assert.equal((await photo(webpPhoto, 'image/webp', {}, 'slot2')).status, 200);
  const both = (await (await get()).json()).entries.find(row => row.entry_date === '2026-10-05');
  assert.equal(both.slot1_photo.mime, 'image/jpeg'); assert.equal(both.slot2_photo.mime, 'image/webp');
  await post({ action: 'import_entries', editor_name: '名前', entries: [{ entry_date: '2026-10-05', note: '新備考' }] });
  const imported = (await (await get()).json()).entries.find(row => row.entry_date === '2026-10-05');
  assert.deepEqual(imported.slot1_photo, both.slot1_photo); assert.deepEqual(imported.slot2_photo, both.slot2_photo);
  assert.equal((await handler(new Request('https://planner.example/.netlify/functions/planner?photo=invalid'))).status, 400);
  assert.equal((await handler(new Request('https://planner.example/.netlify/functions/planner?photo=' + '0'.repeat(64)))).status, 404);
  assert.ok(data.size > 0);
});
test('写真のMIME・signature・上限・認証を検証し、失敗で前画像と予定を保持する', async () => {
  const { photo, data, store } = setup();
  await photo(pngPhoto); const previous = structuredClone(data.get('entries/2026-10-05.json'));
  for (const [bytes, mime, status] of [[pngPhoto, 'image/svg+xml', 415], [pngPhoto, 'image/jpeg', 400], [Buffer.from('not an image'), 'image/png', 400], [Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png', 413], [Buffer.alloc(0), 'image/png', 400]]) {
    assert.equal((await photo(bytes, mime)).status, status); assert.deepEqual(data.get('entries/2026-10-05.json'), previous);
  }
  assert.equal((await photo(pngPhoto, 'image/png', { 'X-Edit-Pin': 'wrong' })).status, 401);
  assert.equal((await photo(pngPhoto, 'image/png', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await photo(pngPhoto, 'image/png', {}, 'slot3')).status, 400);
  assert.equal((await photo(pngPhoto, 'image/png', {}, 'slot1', '2026-02-30')).status, 400);
  store.failPhoto = true; assert.equal((await photo(jpegPhoto, 'image/jpeg')).status, 503);
  assert.deepEqual(data.get('entries/2026-10-05.json'), previous);
  store.failPhoto = false; store.forceConflict = true;
  assert.equal((await photo(jpegPhoto, 'image/jpeg')).status, 409); assert.deepEqual(data.get('entries/2026-10-05.json'), previous);
});

test('写真保存の履歴転記失敗でも保存済みを返し、PIN未設定は書込拒否する', async () => {
  const { photo, store, get, data } = setup(); store.failHistory = true;
  const result = await (await photo(pngPhoto)).json(); assert.equal(result.ok, true); assert.equal(result.history_saved, false);
  store.failHistory = false; await get();
  const history = [...data.keys()].filter(key => key.startsWith('history/')); assert.equal(history.length, 1);
  await photo(pngPhoto); assert.equal([...data.keys()].filter(key => key.startsWith('history/')).length, 1);
  const handler = createHandler({ getPin: () => '', getStore: () => { throw new Error('not reached'); } });
  assert.equal((await handler(new Request('https://planner.example/?action=upload_photo', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Edit-Pin': 'unused' }, body: pngPhoto }))).status, 503);
});

test('コメントは公開閲覧・PIN投稿・追記のみで予定を保持し、再送は重複しない', async () => {
  const { post, get, save, data } = setup();
  await save('note', '保持する備考');
  const before = structuredClone(data.get('entries/2026-10-05.json'));
  const body = { action: 'add_comment', editor_name: '投稿者', entry_date: '2026-10-05', id: randomUUID(), content: '<script>本文</script>\n連絡' };
  assert.equal((await post({ ...body, pin: 'wrong' })).status, 401);
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200);
  assert.equal((await post({ ...body, content: '変更' })).status, 409);
  const view = await (await get()).json();
  const row = view.entries.find(row => row.entry_date === body.entry_date);
  assert.equal(row.comments.length, 1);
  assert.equal(row.comments[0].content, body.content);
  assert.equal(row.comments[0].editor_name, '投稿者');
  assert.ok(row.comments[0].created_at);
  assert.deepEqual(data.get('entries/2026-10-05.json'), before);
  assert.equal(Object.hasOwn(view.entries.find(row => row.entry_date === '2026-10-06'), 'comments'), false);
});

test('コメントは不正な日付・ID・本文を拒否し、別投稿を失わない', async () => {
  const { post, get, data } = setup();
  const body = { action: 'add_comment', editor_name: '投稿者', entry_date: '2026-10-05', id: randomUUID(), content: '連絡' };
  for (const patch of [{ id: '../bad' }, { id: null }, { entry_date: '2026-02-30' }, { content: ' ' }, { content: 1 }, { content: '文'.repeat(3001) }, { editor_name: '' }]) {
    assert.equal((await post({ ...body, ...patch })).status, 400);
    assert.equal(data.size, 0);
  }
  const results = await Promise.all([post(body), post({ ...body, id: randomUUID(), content: '別の連絡' })]);
  assert.ok(results.every(response => response.status === 200));
  const row = (await (await get()).json()).entries.find(row => row.entry_date === body.entry_date);
  assert.equal(row.comments.length, 2);
});


test('コメント取得は選択日だけ1回一覧取得し、範囲外の日付を拒否する', async () => {
  const { get, store } = setup();
  const prefixes = []; const list = store.list;
  store.list = options => { prefixes.push(options.prefix); return list(options); };
  let view = await (await get()).json();
  assert.deepEqual(prefixes.filter(prefix => prefix.startsWith('comments/')), ['comments/2026-10-05/']);
  assert.deepEqual(view.entries.find(row => row.entry_date === '2026-10-05').comments, []);
  prefixes.length = 0; view = await (await get(null)).json();
  assert.equal(prefixes.filter(prefix => prefix.startsWith('comments/')).length, 0);
  assert.ok(view.entries.every(row => !Object.hasOwn(row, 'comments')));
  assert.equal((await get('2026-11-01')).status, 400);
  assert.equal((await get('not-a-date')).status, 400);
});


test('月間全週の56日GETは隣接月の保存値・時間割・コメントを返し57日は拒否する', async () => {
  const { handler, post, data } = setup();
  data.set('settings/base.json', { data: { base: { ...DEFAULT_BASE, dates: { '2026-07-19': { slot1: '隣接月の時間割' } } } }, etag: 'base' });
  assert.equal((await post({ action: 'save', editor_name: '編集者', entry_date: '2026-09-12', field: 'note', value: '隣接月の予定' })).status, 200);
  const read = end => handler(new Request(`https://planner.example/.netlify/functions/planner?start=2026-07-19&end=${end}&comment_date=2026-09-12`));
  const response = await read('2026-09-12');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.entries.length, 56);
  assert.equal(body.entries[0].slot1, '隣接月の時間割');
  assert.equal(body.entries.at(-1).note, '隣接月の予定');
  assert.deepEqual(body.entries.at(-1).comments, []);
  assert.equal((await read('2026-09-13')).status, 400);
});
