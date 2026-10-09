import { createHash } from 'node:crypto';
import { validateSKU, validateSheet, PHOTO_LIMIT } from '../../public/packaging-model.mjs';
import { parseDate, textLimit } from '../../public/model.mjs';
export const EXPORT_LIMITS = { records: 10000, manifest: 16 * 1024 * 1024, total: 128 * 1024 * 1024 };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected export fields');
}
const timestamp = value => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Invalid timestamp'); return value; };
export function validatePhoto(data, type) {
  const bytes = Buffer.from(data);
  if (!bytes.length || bytes.length > PHOTO_LIMIT) throw new Error('Invalid photo size');
  if (!(type === 'image/jpeg' && bytes.subarray(0,3).equals(Buffer.from([255,216,255])) || type === 'image/png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || type === 'image/webp' && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP')) throw new Error('Invalid photo format');
  return bytes;
}
export function validateManifest(input) {
  fields(input, ['version','records','photos']);
  if (input.version !== 1 || !Array.isArray(input.records) || !Array.isArray(input.photos) || input.records.length + input.photos.length > EXPORT_LIMITS.records) throw new Error('Invalid export manifest');
  const keys = new Set(), skuKeys = new Set(), photoReferences = new Map();
  const records = input.records.map(record => {
    fields(record,['key','data','etag']);
    const { key, data, etag } = record;
    if (typeof key !== 'string' || keys.has(key) || typeof etag !== 'string' || !etag || etag.length > 512) throw new Error('Invalid export record');
    keys.add(key);
    let next;
    if (key.startsWith('skus/')) {
      fields(data,['item_id','id','name','type','note','packaging_condition','cultivation_method','price_yen','photo_id','updated_at']);
      next = {...validateSKU(data),photo_id:data.photo_id ?? null,updated_at:timestamp(data.updated_at)};
      if (key !== `skus/${next.item_id}/${next.id}.json` || next.photo_id !== null && !UUID.test(next.photo_id)) throw new Error('Invalid SKU export');
      skuKeys.add(`${next.item_id}/${next.id}`);
      if (next.photo_id) photoReferences.set(next.photo_id,(photoReferences.get(next.photo_id) ?? 0)+1);
    } else if (key.startsWith('menu-sheets/')) {
      fields(data,['date','rows']);
      if (!Array.isArray(data.rows)) throw new Error('Invalid sheet rows');
      for (const row of data.rows) fields(row,['item_id','sku_id','price_yen','planned_quantity','prepared_quantity','status_bits']);
      next = validateSheet(data);
      if (key !== `menu-sheets/${next.date}.json`) throw new Error('Invalid sheet key');
    } else {
      const match = /^sku-comments\/(\d{4}-\d{2}-\d{2})\/(item-\d{2})\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/([^/]+)\.json$/.exec(key);
      if (!match) throw new Error('Invalid comment key');
      parseDate(match[1]); fields(data,['id','content','created_at']);
      if (!UUID.test(data.id) || data.id !== match[4]) throw new Error('Invalid comment ID');
      next = {id:data.id,content:textLimit(data.content,3000,'コメント',true),created_at:timestamp(data.created_at)};
    }
    return {key,data:next,etag};
  }).sort((a,b)=>a.key.localeCompare(b.key));
  for (const record of records) {
    if (record.key.startsWith('menu-sheets/')) for (const row of record.data.rows) { if (!skuKeys.has(`${row.item_id}/${row.sku_id}`)) throw new Error('Missing SKU reference'); }
    if (record.key.startsWith('sku-comments/')) { const parts = record.key.split('/'); if (!skuKeys.has(`${parts[2]}/${parts[3]}`)) throw new Error('Missing comment SKU'); }
  }
  const seenPhotos = new Set();
  const photos = input.photos.map(photo=> {
    fields(photo,['id','type','size','sha256','etag','references']);
    if (!UUID.test(photo.id) || seenPhotos.has(photo.id) || !['image/jpeg','image/png','image/webp'].includes(photo.type) || !Number.isSafeInteger(photo.size) || photo.size < 1 || photo.size > PHOTO_LIMIT || !/^[a-f0-9]{64}$/.test(photo.sha256) || typeof photo.etag !== 'string' || !photo.etag || photo.etag.length > 512 || photo.references !== photoReferences.get(photo.id)) throw new Error('Invalid photo manifest');
    seenPhotos.add(photo.id); return {...photo};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  if (seenPhotos.size !== photoReferences.size) throw new Error('Missing photo manifest');
  const manifest = {version:1,records,photos};
  if (Buffer.byteLength(canonical(manifest)) > EXPORT_LIMITS.manifest || photos.reduce((sum,photo)=>sum+photo.size,0) > EXPORT_LIMITS.total) throw new Error('Export too large');
  return manifest;
}
export async function exportPackaging(store) {
  const {blobs} = await store.list({prefix:''});
  if (blobs.length > EXPORT_LIMITS.records) throw new Error('Export too large');
  const records = [];
  for (const {key} of blobs) {
    if (key.startsWith('photos/')) continue;
    const saved = await store.getWithMetadata(key,{type:'json'});
    if (!saved) throw new Error('Export changed while reading');
    records.push({key,data:saved.data,etag:saved.etag});
  }
  const references = new Map();
  for (const {key,data} of records) if (key.startsWith('skus/') && data.photo_id) references.set(data.photo_id,(references.get(data.photo_id) ?? 0)+1);
  const photos = [];
  for (const [id,count] of references) {
    const saved = await store.getWithMetadata(`photos/${id}`,{type:'arrayBuffer'});
    if (!saved) throw new Error('Missing referenced photo');
    const bytes = validatePhoto(saved.data,saved.metadata.type);
    photos.push({id,type:saved.metadata.type,size:bytes.length,sha256:digest(bytes),etag:saved.etag,references:count});
  }
  return validateManifest({version:1,records,photos});
}
