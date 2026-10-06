import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';
import { ITEMS, PHOTO_LIMIT, validateSKU } from '../../public/packaging-model.mjs';
const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw fail(400, '入力を確認してください。');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 4400000) { await reader.cancel(); throw fail(413, '写真は3MiB以内にしてください。'); }
    chunks.push(value);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
  catch { throw fail(400, '入力形式を確認してください。'); }
}
function photoData(photo) {
  if (!photo || typeof photo.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.data)) throw fail(400, '写真データを確認してください。');
  const data = Buffer.from(photo.data, 'base64');
  if (!data.length || data.length > PHOTO_LIMIT) throw fail(413, '写真は3MiB以内にしてください。');
  const valid = (photo.type === 'image/jpeg' && data[0] === 255 && data[1] === 216 && data[2] === 255)
    || (photo.type === 'image/png' && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    || (photo.type === 'image/webp' && data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP');
  if (!valid) throw fail(415, 'JPEG・PNG・WebPの写真を選んでください。');
  return data;
}
export function createHandler({ getStore: openStore = () => getStore({ name: 'packaging-master', consistency: 'strong' }) } = {}) {
  return async request => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const store = openStore(), photo = url.searchParams.get('photo');
        if (photo !== null) {
          if (!/^[0-9a-f-]{36}$/.test(photo)) throw fail(400, '写真IDを確認してください。');
          const saved = await store.getWithMetadata(`photos/${photo}`, { type: 'arrayBuffer' });
          if (!saved) throw fail(404, '写真がありません。');
          return new Response(saved.data, { headers: { 'Content-Type': saved.metadata.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
        }
        const { blobs } = await store.list({ prefix: 'skus/' });
        const skus = (await Promise.all(blobs.map(async ({ key }) => { const row = await store.getWithMetadata(key, { type: 'json' }); return row ? { ...row.data, etag: row.etag } : null; }))).filter(Boolean);
        return json({ items: ITEMS, skus });
      }
      if (request.method !== 'POST') throw fail(405, 'GETまたはPOSTを使用してください。');
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) throw fail(403, 'このページから操作してください。');
      if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw fail(415, 'application/jsonを指定してください。');
      const body = await readBody(request);
      if (body.action !== 'save_sku') throw fail(400, '操作を確認してください。');
      let row; try { row = validateSKU(body); } catch (e) { throw fail(400, e.message); }
      const photo = body.photo == null ? null : photoData(body.photo);
      const store = openStore(), key = `skus/${row.item_id}/${row.id}.json`;
      const current = await store.getWithMetadata(key, { type: 'json' });
      if (current && (!current.etag || body.etag !== current.etag) || !current && body.etag != null) throw fail(409, '保存内容が変わりました。再読込して確認してください。');
      for (const field of ['cultivation_method', 'price_yen', 'packaging_condition']) {
        if (!Object.hasOwn(body, field) && current && Object.hasOwn(current.data, field)) row[field] = current.data[field];
      }
      row.photo_id = current?.data.photo_id ?? null;
      if (photo) { row.photo_id = randomUUID(); await store.set(`photos/${row.photo_id}`, photo, { metadata: { type: body.photo.type } }); }
      row.updated_at = new Date().toISOString();
      const result = await store.setJSON(key, row, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
      if (!result.modified) throw fail(409, '更新が重なりました。再読込して確認してください。');
      return json({ ok: true });
    } catch (e) { return json({ error: e.status ? e.message : '保存・読込できませんでした。再試行してください。' }, e.status ?? 500); }
  };
}
export default createHandler();
