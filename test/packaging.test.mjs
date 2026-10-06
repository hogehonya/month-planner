import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../netlify/functions/packaging.mjs';
import { ITEMS, PHOTO_LIMIT } from '../public/packaging-model.mjs';
function setup() {
  const data = new Map(); let version = 0;
  const store = {
    async getWithMetadata(key) { return data.get(key) ?? null; },
    async list({prefix}) { return {blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))}; },
    async set(key,value,{metadata}) { data.set(key,{data:value,metadata}); },
    async setJSON(key,value,options) { const old = data.get(key); if (options.onlyIfNew && old || options.onlyIfMatch && old?.etag !== options.onlyIfMatch) return {modified:false}; data.set(key,{data:value,etag:String(++version)}); return {modified:true}; }
  };
  const handler = createHandler({getStore:()=>store});
  const get = query => handler(new Request('https://planner.example/.netlify/functions/packaging'+(query ?? '')));
  const post = body => handler(new Request('https://planner.example/.netlify/functions/packaging',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_sku',item_id:'item-14',id:'real-001',name:'実際のSKU',type:'',note:'包装の備考',...body})}));
  return {data,store,get,post,handler};
}
test('公開20品目と空のSKU、架空の品種・写真なし',async()=> {
  const {get} = setup(); const view = await (await get()).json();
  assert.deepEqual(view.items,ITEMS); assert.equal(view.items.length,20); assert.deepEqual(view.skus,[]);
  assert.deepEqual(view.items.map(x=>x.name),['タマネギ','ニンニク','ネギ','カボチャ','ジャガイモ','サツマイモ','サトイモ','ラッカセイ','ミニチンゲンサイ','ハクサイ','シュンギク','ホウレンソウ','コマツナ','ダイコン','カブ','ニンジン','ビーツ','インゲン','レタス','ブロッコリー']);
});
test('PINなしで保存・入力検証・予定のキーに書き込まない',async()=> {
  const {post,data,handler} = setup();
  for (const patch of [{item_id:'unknown'},{id:'../bad'},{name:''},{type:'x'.repeat(121)},{note:'x'.repeat(3001)}]) assert.equal((await post(patch)).status,400);
  assert.equal(data.size,0);
  assert.equal((await post({})).status,200); assert.ok([...data.keys()].every(key=>key.startsWith('skus/')));
  assert.equal((await handler(new Request('https://planner.example/',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.example'},body:'{}'}))).status,403);
});
test('SKUごとの写真保存・公開配信・再編集保持と別SKUの独立',async()=> {
  const {post,get} = setup(); const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  assert.equal((await post({photo:{type:'image/png',data:png.toString('base64')}})).status,200);
  const first = (await (await get()).json()).skus[0];
  const photo = await get('?photo='+first.photo_id); assert.equal(photo.headers.get('Content-Type'),'image/png'); assert.deepEqual(Buffer.from(await photo.arrayBuffer()),png);
  assert.equal((await post({etag:first.etag,note:'新備考'})).status,200);
  assert.equal((await post({id:'real-002',type:'確認済みの別品種'})).status,200);
  const rows = (await (await get()).json()).skus;
  assert.equal(rows.length,2); assert.equal(rows.find(x=>x.id===first.id).photo_id,first.photo_id);
  assert.equal((await post({etag:first.etag,note:'古い更新'})).status,409);
});
test('写真の過大・偽形式・SVGを保存しない',async()=> {
  const {post,data} = setup();
  assert.equal((await post({photo:{type:'image/png',data:Buffer.alloc(PHOTO_LIMIT+1).toString('base64')}})).status,413);
  for (const photo of [{type:'image/png',data:Buffer.from('fake').toString('base64')},{type:'image/svg+xml',data:Buffer.from('<svg/>').toString('base64')},{type:'image/png',data:'!!!'}]) assert.ok([400,415].includes((await post({photo})).status));
  assert.equal(data.size,0);
});
