import { getStore } from '@netlify/blobs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dateRange, parseDate, textLimit, validateSlot, effectiveEntry, DEFAULT_BASE, LIMITS, validateImport, PHOTO_LIMIT, PHOTO_MIMES, SLOTS } from '../../public/model.mjs';

const BASE_KEY = 'settings/base.json';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const error = (status, message) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(value).digest();

async function readJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw error(400, 'JSONを指定してください。');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 262144) { await reader.cancel(); throw error(413, 'JSONは256KiB以内にしてください。'); }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw error(400, 'JSONの形式を確認してください。'); }
}

async function readPhoto(request, mime) {
  if (!PHOTO_MIMES.includes(mime)) throw error(415, '写真はJPEG・PNG・WebPで指定してください。');
  if (Number(request.headers.get('Content-Length')) > PHOTO_LIMIT) throw error(413, '写真は2MiB以内にしてください。');
  const reader = request.body?.getReader();
  if (!reader) throw error(400, '写真を選んでください。');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > PHOTO_LIMIT) { await reader.cancel(); throw error(413, '写真は2MiB以内にしてください。'); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  const valid = mime === 'image/jpeg' ? bytes.length >= 5 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && bytes.subarray(-2).equals(Buffer.from([255, 217]))
    : mime === 'image/png' ? bytes.length >= 20 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))
    : bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) && bytes.readUInt32LE(4) === bytes.length - 8;
  if (!valid) throw error(400, '写真の形式と内容を確認してください。');
  return bytes;
}

async function verifyPin(value, getPin, sleep) {
  const pin = getPin();
  if (typeof pin !== 'string' || !pin) throw error(503, '編集用PINが設定されていません。');
  if (typeof value !== 'string' || !timingSafeEqual(hash(value), hash(pin))) { await sleep(300); throw error(401, 'PINを確認してください。'); }
}

async function update(store, key, mutate) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await store.getWithMetadata(key, { type: 'json' });
    if (current && !current.etag) throw error(503, '保存状態を確認できません。入力を残して再試行してください。');
    const next = mutate(current?.data ?? null, current?.etag ?? null);
    if (next === null) return current.data;
    const result = await store.setJSON(key, next, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (result.modified) return next;
  }
  throw error(409, '更新が重なりました。入力を残しているので再試行してください。');
}

async function flushHistory(store, key) {
  try {
    const current = await store.getWithMetadata(key, { type: 'json' });
    const pending = current?.data?._pending_history ?? [];
    if (!pending.length) return true;
    for (const event of pending) await store.setJSON(`history/${event.id}.json`, event, { onlyIfNew: true });
    const ids = new Set(pending.map(event => event.id));
    await update(store, key, row => ({ ...row, _pending_history: (row._pending_history ?? []).filter(event => !ids.has(event.id)) }));
    return true;
  } catch { return false; }
}

function eventFor(date, field, editor) {
  const now = new Date();
  return { id: `${now.getTime()}-${randomUUID()}`, entry_date: date, editor_name: editor, field_name: field, changed_at: now.toISOString() };
}

async function savePatch(store, date, patch, editor, base, fields) {
  const key = `entries/${date}.json`;
  const events = fields.map(field => eventFor(date, field, editor));
  const row = await update(store, key, current => {
    const changed = Object.keys(patch).filter(field => !current || !Object.hasOwn(current, field) || current[field] !== patch[field]);
    if (!changed.length) return null;
    const pending = events.filter(event => changed.some(field => field === event.field_name || field.startsWith(event.field_name.replace('_details', '_'))));
    return { ...current, entry_date: date, ...patch, last_editor: editor, updated_at: events[0].changed_at, _pending_history: [...(current?._pending_history ?? []), ...pending] };
  });
  return { row: effectiveEntry(date, row, base), history_saved: await flushHistory(store, key) };
}

export function createHandler({ getStore: openStore = () => getStore({ name: 'shared-planner', consistency: 'strong' }), getPin = () => process.env.EDIT_PIN, sleep = delay } = {}) {
  return async request => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        if (url.searchParams.has('photo')) {
          const id = url.searchParams.get('photo');
          if (!/^[a-f0-9]{64}$/.test(id)) throw error(400, '写真を確認してください。');
          const photo = await openStore().getWithMetadata(`photos/${id}`, { type: 'arrayBuffer' });
          if (!photo || !PHOTO_MIMES.includes(photo.metadata?.mime)) throw error(404, '写真が見つかりません。');
          return new Response(photo.data, { headers: { 'Content-Type': photo.metadata.mime, 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'" } });
        }
        let dates;
        try { dates = dateRange(url.searchParams.get('start'), url.searchParams.get('end'), 56); }
        catch (e) { throw error(400, e.message); }
        const commentDate = url.searchParams.get('comment_date');
        if (commentDate !== null && !dates.includes(commentDate)) throw error(400, 'コメントの日付は表示期間内で指定してください。');
        const store = openStore();
        const keys = [BASE_KEY, ...dates.map(date => `entries/${date}.json`)];
        const snapshots = await Promise.all(keys.map(key => store.getWithMetadata(key, { type: 'json' })));
        const pending = snapshots.flatMap(snapshot => snapshot?.data?._pending_history ?? []);
        let historySaved = true;
        for (let i = 0; i < keys.length; i++) {
          if (snapshots[i]?.data?._pending_history?.length && !await flushHistory(store, keys[i])) historySaved = false;
        }
        const { blobs } = await store.list({ prefix: 'history/' });
        const latestKeys = blobs.map(blob => blob.key).sort().reverse().slice(0, 30);
        const recorded = await Promise.all(latestKeys.map(key => store.get(key, { type: 'json' })));
        const history = [...new Map([...recorded.filter(Boolean), ...pending].map(event => [event.id, event])).values()]
          .sort((a, b) => b.changed_at.localeCompare(a.changed_at) || b.id.localeCompare(a.id)).slice(0, 30);
        const comments = new Map(await Promise.all((commentDate === null ? [] : [commentDate]).map(async date => {
          const { blobs } = await store.list({ prefix: `comments/${date}/` });
          const rows = (await Promise.all(blobs.map(blob => store.get(blob.key, { type: 'json' })))).filter(Boolean);
          rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
          return [date, rows];
        })));
        const freshBase = await store.getWithMetadata(BASE_KEY, { type: 'json' });
        const base = freshBase?.data?.base ?? DEFAULT_BASE;
        return json({ entries: dates.map((date, i) => ({ ...effectiveEntry(date, snapshots[i + 1]?.data, base), ...(comments.has(date) ? { comments: comments.get(date) } : {}) })), history, history_saved: historySaved, base, base_etag: freshBase?.etag ?? null });
      }
      if (request.method !== 'POST') return json({ error: 'GETまたはPOSTを使用してください。' }, 405);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) throw error(403, 'このページから操作してください。');
      if (url.searchParams.get('action') === 'upload_photo') {
        await verifyPin(request.headers.get('X-Edit-Pin'), getPin, sleep);
        let date, slot, editor;
        try {
          date = url.searchParams.get('entry_date'); parseDate(date);
          slot = url.searchParams.get('slot'); if (!SLOTS.includes(slot)) throw new Error('編集対象のコマを確認してください。');
          editor = textLimit(decodeURIComponent(request.headers.get('X-Editor-Name') ?? ''), 40, '編集者名', true).trim();
        } catch (e) { throw error(400, e instanceof URIError ? '編集者名を確認してください。' : e.message); }
        const mime = request.headers.get('Content-Type')?.split(';')[0].trim();
        const bytes = await readPhoto(request, mime);
        const id = createHash('sha256').update(bytes).digest('hex');
        const photo = { id, mime, size: bytes.length }, store = openStore();
        const base = (await store.get(BASE_KEY, { type: 'json' }))?.base ?? DEFAULT_BASE;
        await store.set(`photos/${id}`, bytes, { onlyIfNew: true, metadata: { mime, size: bytes.length } });
        const key = `entries/${date}.json`, field = slot + '_photo', event = eventFor(date, field, editor);
        const row = await update(store, key, current => current?.[field]?.id === id ? null : ({ ...current, entry_date: date, [field]: photo, last_editor: editor, updated_at: event.changed_at, _pending_history: [...(current?._pending_history ?? []), event] }));
        return json({ ok: true, row: effectiveEntry(date, row, base), history_saved: await flushHistory(store, key) });
      }
      if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw error(415, 'application/jsonを指定してください。');
      const body = await readJSON(request);
      await verifyPin(body.pin, getPin, sleep);
      if (body.action === 'verify') return json({ ok: true });
      let editor;
      try { editor = textLimit(body.editor_name, 40, '編集者名', true).trim(); }
      catch (e) { throw error(400, e.message); }
      if (body.action === 'base') throw error(403, '取り込んだ基本予定は変更できません。');
      const store = openStore();
      if (body.action === 'add_comment') {
        let content;
        try {
          parseDate(body.entry_date);
          if (typeof body.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)) throw new Error('投稿IDを確認してください。');
          content = textLimit(body.content, 3000, 'コメント', true);
        } catch (e) { throw error(400, e.message); }
        const key = `comments/${body.entry_date}/${body.id.toLowerCase()}.json`;
        const comment = { id: body.id.toLowerCase(), entry_date: body.entry_date, editor_name: editor, content, created_at: new Date().toISOString() };
        const result = await store.setJSON(key, comment, { onlyIfNew: true });
        if (!result.modified) {
          const saved = await store.get(key, { type: 'json' });
          if (!saved || saved.content !== content || saved.editor_name !== editor) throw error(409, '投稿IDが重複しています。投稿内容を確認してください。');
          return json({ ok: true, comment: saved });
        }
        return json({ ok: true, comment });
      }
      if (body.action === 'import_entries') {
        let entries;
        try { entries = validateImport({ entries: body.entries }); } catch (e) { throw error(400, e.message); }
        const base = (await store.get(BASE_KEY, { type: 'json' }))?.base ?? DEFAULT_BASE;
        const results = [];
        for (const { entry_date: date, ...patch } of entries) {
          const fields = [...new Set(Object.keys(patch).map(field => field === 'note' ? 'note' : field.slice(0, 5) + '_details'))];
          try { results.push({ entry_date: date, saved: true, ...await savePatch(store, date, patch, editor, base, fields) }); }
          catch (e) { results.push({ entry_date: date, saved: false, error: e.status ? e.message : '保存できませんでした。再試行してください。' }); }
        }
        return json({ ok: results.every(result => result.saved), results });
      }
      if (body.action === 'save' || body.action === 'save_slot') {
        let patch;
        try {
          parseDate(body.entry_date);
          if (body.action === 'save_slot') patch = validateSlot(body.slot, body.title, body.content);
          else {
            if (body.field !== 'note') throw new Error('基本予定は変更できません。備考またはコマの見出し・内容を編集してください。');
            patch = { note: textLimit(body.value, LIMITS.note, '備考') };
          }
        } catch (e) { throw error(400, e.message); }
        // Read shared defaults before committing so a later read failure cannot mask a successful save.
        const base = (await store.get(BASE_KEY, { type: 'json' }))?.base ?? DEFAULT_BASE;
        const result = await savePatch(store, body.entry_date, patch, editor, base, [body.action === 'save_slot' ? body.slot + '_details' : 'note']);
        return json({ ok: true, ...result });
      }
      throw error(400, '操作を確認してください。');
    } catch (e) {
      return json({ error: e.status ? e.message : 'サーバーに接続できません。しばらくしてから再試行してください。' }, e.status ?? 503);
    }
  };
}

export default createHandler();
