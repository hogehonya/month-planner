import { open, rename, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDiskStore } from './store.mjs';
import { canonical, digest, UUID, EXPORT_LIMITS, validateManifest, validatePhoto } from '../netlify/lib/packaging-export.mjs';
export const DEFAULT_ONLINE_SOURCE = 'https://month-planner-13f9a0.netlify.app';
const TTL = 10 * 60 * 1000;
const error = (status,message) => Object.assign(new Error(message),{status});
const json = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export function mutex() {
  let queue = Promise.resolve();
  return async operation => { const result = queue.then(operation); queue = result.catch(()=>{}); return result; };
}
function sourceOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) throw new Error('ONLINE_SOURCE_ORIGIN must be an HTTPS origin without credentials, path, query or fragment');
  return parsed.origin;
}
async function snapshot(store) {
  const {blobs} = await store.list({prefix:''});
  if (blobs.length > EXPORT_LIMITS.records) throw error(413,'ローカルの件数が同期上限を超えています。');
  const entries = [];
  let total = 0;
  for (const {key} of blobs.sort((a,b)=>a.key.localeCompare(b.key))) {
    const saved = await store.getWithMetadata(key,{type:'arrayBuffer'});
    if (!saved) throw error(409,'ローカルの状態が変わりました。差分を再確認してください。');
    const bytes = Buffer.from(saved.data); total += bytes.length;
    if (total > EXPORT_LIMITS.total) throw error(413,'ローカルの容量が同期上限を超えています。');
    const content = key.startsWith('photos/') ? {id:key.slice(7),type:saved.metadata.type,size:bytes.length,sha256:digest(bytes),references:0} : JSON.parse(bytes.toString('utf8'));
    entries.push({key,etag:saved.etag,metadata:saved.metadata,hash:digest(bytes),content});
  }
  for (const entry of entries) if (entry.key.startsWith('photos/')) entry.content.references = entries.filter(row=>row.key.startsWith('skus/') && row.content.photo_id === entry.content.id).length;
  return {fingerprint:digest(canonical(entries.map(({content,...entry})=>entry))),entries};
}
function differences(local,manifest) {
  const before = new Map(local.entries.map(entry=>[entry.key,entry.content]));
  const after = new Map(manifest.records.map(record=>[record.key,record.data]));
  for (const {etag,...photo} of manifest.photos) after.set(`photos/${photo.id}`,photo);
  const summary = Object.fromEntries(['skus','sheets','comments','photos'].map(kind=>[kind,{added:0,changed:0,removed:0}]));
  const changes = [];
  for (const key of [...new Set([...before.keys(),...after.keys()])].sort()) {
    const kind = key.startsWith('skus/') ? 'skus' : key.startsWith('menu-sheets/') ? 'sheets' : key.startsWith('sku-comments/') ? 'comments' : key.startsWith('photos/') ? 'photos' : null;
    if (!kind) throw error(409,'未対応のローカルデータがあります。同期できません。');
    const old = before.get(key) ?? null, next = after.get(key) ?? null;
    if (canonical(old) === canonical(next)) continue;
    const change = old === null ? 'added' : next === null ? 'removed' : 'changed'; summary[kind][change]++;
    const parts = key.split('/');
    const sku = after.get(`skus/${parts[2]}/${parts[3]}.json`) ?? before.get(`skus/${parts[2]}/${parts[3]}.json`);
    const label = kind === 'comments' ? `${parts[1]}・${sku?.name ?? parts[3]}・コメント` : next?.name ?? old?.name ?? next?.date ?? old?.date ?? key;
    changes.push({kind,key,label,change,before:old,after:next});
  }
  return {summary,changes};
}
export async function createOnlineSync({dataDir,source=DEFAULT_ONLINE_SOURCE,fetchRemote=fetch,now=Date.now}) {
  source = sourceOrigin(source);
  const pointer = join(dataDir,'packaging-current.json');
  let namespace = 'packaging-master';
  try {
    const file = await open(pointer,constants.O_RDONLY | constants.O_NOFOLLOW);
    let manifest; try { manifest = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    if (!manifest || manifest.version !== 1 || !UUID.test(manifest.generation) || Object.keys(manifest).some(key=>!['version','generation'].includes(key))) throw new Error('Invalid packaging generation pointer');
    namespace = `packaging-generation-${manifest.generation}`;
    const directory = await lstat(join(dataDir,namespace));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid packaging generation directory');
  } catch (cause) { if (cause.code !== 'ENOENT' || namespace !== 'packaging-master') throw cause; }
  let active = createDiskStore(dataDir,namespace), pending = null, running = false;
  const exclusive = mutex();
  async function remote(path,limit,budget,signal,type) {
    const url = source+'/.netlify/functions/packaging'+path;
    const response = await fetchRemote(url,{method:'GET',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Accept:type}});
    if (!response.ok || response.redirected || response.url && response.url !== url || response.headers.get('content-type')?.split(';')[0] !== type) throw error(502,'オンラインのデータを取得できません。公開版と接続を確認してください。');
    const length = response.headers.get('content-length');
    if (length && Number(length) > limit) throw error(413,'オンラインのデータが同期上限を超えています。');
    const reader = response.body?.getReader(); if (!reader) throw error(502,'オンラインの応答が空です。');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        size += value.length; budget.bytes += value.length;
        if (size > limit || budget.bytes > EXPORT_LIMITS.total) throw error(413,'オンラインのデータが同期上限を超えています。');
        chunks.push(value);
      }
    } catch (cause) { await reader.cancel().catch(()=>{}); throw cause; }
    return Buffer.concat(chunks);
  }
  async function manifest(budget,signal) {
    const bytes = await remote('?export=1',EXPORT_LIMITS.manifest,budget,signal,'application/json');
    try { return validateManifest(JSON.parse(bytes.toString('utf8'))); }
    catch { throw error(502,'オンラインの同期データが不完全、または未対応の形式です。'); }
  }
  async function preview() {
    pending = null;
    const local = await exclusive(()=>snapshot(active));
    const signal = AbortSignal.timeout(60000), budget = {bytes:0};
    const data = await manifest(budget,signal), fingerprint = digest(canonical(data));
    const generation = randomUUID(), staged = createDiskStore(dataDir,`packaging-generation-${generation}`);
    // An empty import must also create a durable generation directory.
    await staged.list({prefix:''});
    for (const record of data.records) await staged.setJSON(record.key,record.data);
    for (const photo of data.photos) {
      const bytes = await remote('?photo='+photo.id,photo.size,budget,signal,photo.type);
      try { validatePhoto(bytes,photo.type); } catch { throw error(502,'荷姿写真の形式を確認できません。'); }
      if (bytes.length !== photo.size || digest(bytes) !== photo.sha256) throw error(409,'オンラインの写真が変わりました。差分を再確認してください。');
      await staged.set(`photos/${photo.id}`,bytes,{metadata:{type:photo.type}});
    }
    if (digest(canonical(await manifest(budget,signal))) !== fingerprint) throw error(409,'オンラインのデータが変わりました。差分を再確認してください。');
    const diff = differences(local,data);
    pending = {token:randomUUID(),generation,staged,remote:fingerprint,local:local.fingerprint,expires:now()+TTL};
    return {token:pending.token,source,expires_at:new Date(pending.expires).toISOString(),...diff};
  }
  async function apply(token) {
    const plan = pending;
    if (!plan || token !== plan.token || now() >= plan.expires) throw error(409,'差分が期限切れ、または反映済みです。再読込して差分を確認してください。');
    if (digest(canonical(await manifest({bytes:0},AbortSignal.timeout(60000)))) !== plan.remote) { pending = null; throw error(409,'オンラインのデータが変わりました。差分を再確認してください。'); }
    return exclusive(async()=> {
      if (pending !== plan || now() >= plan.expires || (await snapshot(active)).fingerprint !== plan.local) { pending = null; throw error(409,'ローカルのデータが変わったか期限切れです。差分を再確認してください。'); }
      pending = null;
      const temporary = join(dataDir,`packaging-current-${randomUUID()}.tmp`);
      const file = await open(temporary,'wx',0o600);
      try { await file.writeFile(JSON.stringify({version:1,generation:plan.generation})); await file.sync(); } finally { await file.close(); }
      await rename(temporary,pointer);
      active = plan.staged;
      const directory = await open(dataDir,'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return {ok:true};
    });
  }
  return {
    source,
    // Hold the generation stable through every read/write in one packaging request.
    withStore: operation => exclusive(()=>operation(active)),
    async handle(request) {
      if (request.method !== 'POST') return json({error:'POSTを使用してください。'},405);
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({error:'application/jsonを指定してください。'},415);
      if (running) return json({error:'同期処理中です。完了後に再試行してください。'},409);
      running = true;
      try {
        const reader = request.body?.getReader(); let size = 0; const chunks = [];
        if (!reader) throw error(400,'操作を指定してください。');
        while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw error(413,'リクエストが大きすぎます。'); } chunks.push(value); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error(400,'JSONを確認してください。'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key=>!['action','token'].includes(key))) throw error(400,'操作を確認してください。');
        if (body.action === 'preview') return json(await preview());
        if (body.action === 'apply' && typeof body.token === 'string') return json(await apply(body.token));
        throw error(400,'操作を確認してください。');
      } catch (cause) { return json({error:cause.status ? cause.message : '同期できませんでした。再読込して状態を確認してください。'},cause.status ?? 502); }
      finally { running = false; }
    }
  };
}
