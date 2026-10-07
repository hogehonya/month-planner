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
    async setJSON(key,value,options) { const old = data.get(key); if (options.onlyIfNew && old || options.onlyIfMatch && old?.etag !== options.onlyIfMatch) return {modified:false}; data.set(key,{data:value,etag:String(++version)}); return {modified:true,etag:String(version)}; }
  };
  const handler = createHandler({getStore:()=>store});
  const get = query => handler(new Request('https://planner.example/.netlify/functions/packaging'+(query ?? '')));
  const post = body => handler(new Request('https://planner.example/.netlify/functions/packaging',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_sku',item_id:'item-14',id:'real-001',name:'実際のSKU',type:'',note:'包装の備考',...body})}));
  return {data,store,get,post,handler};
}
test('公開24品目と空のSKU、既存20品目のIDを保持し架空の品種・写真なし',async()=> {
  const {get} = setup(); const view = await (await get()).json();
  assert.deepEqual(view.items,ITEMS); assert.equal(view.items.length,24); assert.deepEqual(view.skus,[]);
  assert.deepEqual(view.items.slice(0,20).map(x=>x.name),['タマネギ','ニンニク','ネギ','カボチャ','ジャガイモ','サツマイモ','サトイモ','ラッカセイ','ミニチンゲンサイ','ハクサイ','シュンギク','ホウレンソウ','コマツナ','ダイコン','カブ','ニンジン','ビーツ','インゲン','レタス','ブロッコリー']);
  assert.deepEqual(view.items.slice(0,20).map(x=>x.id),Array.from({length:20},(_,i)=>`item-${String(i+1).padStart(2,'0')}`));
  assert.deepEqual(view.items.slice(20),[{id:'item-21',name:'エダマメ'},{id:'item-22',name:'トマト（大玉）'},{id:'item-23',name:'キャベツ'},{id:'item-24',name:'ショウガ'}]);
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

test('任意SKU項目を共有保存し、未入力価格と0円を区別する', async () => {
  const {post,get} = setup();
  assert.equal((await post({})).status,200);
  const blank = (await (await get()).json()).skus[0];
  assert.equal(blank.cultivation_method,'unknown'); assert.equal(blank.price_yen,null); assert.equal(blank.packaging_condition,'');
  assert.equal((await post({etag:blank.etag,cultivation_method:'organic',price_yen:0,packaging_condition:'袋に2本'})).status,200);
  const saved = (await (await get()).json()).skus[0];
  assert.equal(saved.cultivation_method,'organic'); assert.equal(saved.price_yen,0); assert.equal(saved.packaging_condition,'袋に2本');
  assert.equal((await post({etag:saved.etag,note:'通常の編集'})).status,200);
  const preserved = (await (await get()).json()).skus[0];
  assert.equal(preserved.cultivation_method,'organic'); assert.equal(preserved.price_yen,0); assert.equal(preserved.packaging_condition,'袋に2本');
  assert.equal((await post({etag:preserved.etag,cultivation_method:'conventional',price_yen:null,packaging_condition:''})).status,200);
  const cleared = (await (await get()).json()).skus[0];
  assert.equal(cleared.cultivation_method,'conventional'); assert.equal(cleared.price_yen,null); assert.equal(cleared.packaging_condition,'');
});
test('栽培方法・価格・荷姿条件の不正な値を拒否する', async () => {
  const {post,data} = setup();
  for (const patch of [{cultivation_method:'other'},{price_yen:''},{price_yen:'100'},{price_yen:-1},{price_yen:1.5},{price_yen:Number.MAX_SAFE_INTEGER+1},{packaging_condition:42},{packaging_condition:'x'.repeat(3001)}]) {
    assert.equal((await post(patch)).status,400);
  }
  assert.equal(data.size,0);
});

test('追加4品目へSKUを保存・取得し、有機・慣行・未確認を保持する',async()=> {
  const {post,get} = setup();
  const methods = ['organic','conventional','unknown','conventional'];
  for (let i = 0; i < 4; i++) {
    assert.equal((await post({item_id:`item-${21+i}`,id:`added-${i}`,cultivation_method:methods[i]})).status,200);
  }
  const rows = (await (await get()).json()).skus;
  assert.equal(rows.length,4);
  for (let i = 0; i < 4; i++) {
    const row = rows.find(row=>row.id===`added-${i}`);
    assert.equal(row.item_id,`item-${21+i}`);
    assert.equal(row.cultivation_method,methods[i]);
    assert.equal(row.type,''); assert.equal(row.price_yen,null);
    assert.equal(row.packaging_condition,''); assert.equal(row.photo_id,null);
  }
});

test('日付別おしながきは独立保存し、未入力・0・超過準備を保持して古ETagを拒否する',async()=> {
  const {get,post,handler,data} = setup();
  await post({price_yen:100});
  const skuBefore = [...data.entries()];
  const save = body=>handler(new Request('https://planner.example/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_sheet',...body})}));
  assert.deepEqual((await (await get()).json()).sheets,[]);
  const rows = [{item_id:'item-14',sku_id:'real-001',price_yen:100,planned_quantity:0,prepared_quantity:10}];
  let response = await save({date:'2026-10-17',rows,etag:null}); assert.equal(response.status,200);
  const first = (await response.json()).sheet; assert.ok(first.etag);
  assert.deepEqual((await (await get()).json()).sheets,[first]);
  assert.equal((await save({date:'2026-10-17',rows:[],etag:null})).status,409);
  assert.equal((await save({date:'2026-10-18',rows:rows.map(row=>({...row,planned_quantity:null,prepared_quantity:null})),etag:null})).status,200);
  assert.deepEqual([...data.entries()].filter(([key])=>key.startsWith('skus/')),skuBefore);
  assert.equal((await save({date:first.date,rows:[],etag:first.etag})).status,200);
  assert.equal((await save({date:first.date,rows,etag:first.etag})).status,409);
});

test('日付・参照・数量・単価・重複行の不正値はおしながきに保存しない',async()=> {
  const {post,handler,data} = setup(); await post({});
  const row = {item_id:'item-14',sku_id:'real-001',price_yen:null,planned_quantity:null,prepared_quantity:null};
  const invalid = [{date:'2026-02-30'},{date:'2026-1-1'},{rows:[{...row,sku_id:'absent'}]},{rows:[{...row,item_id:'item-01'}]},{rows:[row,row]},{rows:[{...row,planned_quantity:-1}]},{rows:[{...row,prepared_quantity:1.5}]},{rows:[{...row,price_yen:Number.MAX_SAFE_INTEGER+1}]},{rows:[{...row,price_yen:'100'}]}];
  for (const patch of invalid) {
    const response = await handler(new Request('https://planner.example/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_sheet',date:'2026-10-17',rows:[row],etag:null,...patch})}));
    assert.equal(response.status,400);
  }
  assert.equal(data.size,1);
});


test('日付の確定bitsは既知値だけ確定でき、写真bitを拒否し保存再取得する',async()=> {
 const {post,get,handler}=setup();await post({packaging_condition:'2本袋'});
 const row={item_id:'item-14',sku_id:'real-001',price_yen:0,planned_quantity:0,prepared_quantity:null,status_bits:7};
 const save=rows=>handler(new Request('https://planner.example/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_sheet',date:'2026-10-17',rows,etag:null})}));
 for(const bits of [-1,8,15,1.5,null,'7']) assert.equal((await save([{...row,status_bits:bits}])).status,400);
 for(const patch of [{price_yen:null},{planned_quantity:null}]) assert.equal((await save([{...row,...patch}])).status,400);
 assert.equal((await save([row])).status,200);
 assert.equal((await (await get()).json()).sheets[0].rows[0].status_bits,7);
 const other=setup();await other.post({});
 const invalid=await other.handler(new Request('https://planner.example/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_sheet',date:'2026-10-17',rows:[row],etag:null})}));
 assert.equal(invalid.status,400);
});


test('旧日付データのbit無しはGETで0になり、保存データを一括書換えしない',async()=> {
 const {data,get}=setup();const old={date:'2026-10-17',rows:[{item_id:'item-14',sku_id:'real-001',price_yen:null,planned_quantity:null,prepared_quantity:null}]};
 data.set('menu-sheets/2026-10-17.json',{data:old,etag:'legacy'});
 assert.equal((await (await get()).json()).sheets[0].rows[0].status_bits,0);
 assert.equal(Object.hasOwn(data.get('menu-sheets/2026-10-17.json').data.rows[0],'status_bits'),false);
});


test('出荷なし16は未入力値も保持して保存再取得でき、写真bit8などは拒否する',async()=> {
 const {post,get,handler}=setup();await post({});
 const row={item_id:'item-14',sku_id:'real-001',price_yen:null,planned_quantity:null,prepared_quantity:null,status_bits:16};
 const save=rows=>handler(new Request('https://planner.example/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_sheet',date:'2026-10-17',rows,etag:null})}));
 for(const bits of [24,31,32,2147483648]) assert.equal((await save([{...row,status_bits:bits}])).status,400);
 assert.equal((await save([row])).status,200);
 assert.deepEqual((await (await get()).json()).sheets[0].rows[0],row);
 assert.equal(Object.hasOwn((await (await get()).json()).sheets[0].rows[0],'decision_bits'),false);
});
