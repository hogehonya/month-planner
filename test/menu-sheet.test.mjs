import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSheet, validateSheet } from '../public/packaging-model.mjs';
import { setupMenu, visibleMenuRows } from '../public/menu-sheet.mjs';
const row = {item_id:'item-14',sku_id:'real-001',price_yen:100,planned_quantity:10,prepared_quantity:null};
class Element {
  constructor(tag='') {this.tag=tag;this.children=[];this.listeners={};this.value='';}
  append(...children){for(const child of children){this.children=this.children.filter(existing=>existing!==child);this.children.push(child);}}
  setAttribute(name,value){this[name]=value;}
  replaceChildren(...children){this.children=children;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  setCustomValidity(value){this.validation=value;}
  reportValidity(){return !this.validation && this.children.every(child=>child.reportValidity());}
}
function setup(failure=null) {
  const elements = new Map(), requests=[], edits=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let sheets=[{date:'2026-10-17',rows:[{...row}],etag:'v1'}];
  let saveFailure=failure;
  const api=async body=>{
    if (!body) return {sheets};
    requests.push(body);
    if(saveFailure)throw Object.assign(new Error('保存失敗'),{status:saveFailure});
    const sheet={date:body.date,rows:body.rows,etag:'v2'};
    sheets=[...sheets.filter(s=>s.date!==body.date),sheet];return {ok:true,sheet};
  };
  get('menu-form').append(get('menu-rows'));
  const menu=setupMenu({getElementById:get,createElement:tag=>new Element(tag)},api,(item,sku)=>edits.push({item,sku}));
  const source={items:[{id:'item-14',name:'ダイコン'}],skus:[{item_id:'item-14',id:'real-001',name:'大根',price_yen:100},{item_id:'item-01',id:'sample',name:'サンプル',price_yen:200}],sheets};
  menu.receive(source);
  return {get,menu,requests,edits,setFailure:value=>{saveFailure=value;},source};
}
const submit=()=>({preventDefault(){}});
const input=(ui,index)=>ui.get('menu-rows').children[0].children[2].children[index].children[0];

test('数量と売価はnullと0を分け、安全整数を超える合計も正確に表示する',()=> {
  const summary=summarizeSheet([row,{...row,planned_quantity:0,prepared_quantity:0,price_yen:null}]);
  assert.deepEqual(summary.planned_quantity,{total:'10',unknown:0});
  assert.deepEqual(summary.prepared_quantity,{total:'0',unknown:1});
  assert.deepEqual(summary.planned_amount,{total:'1000',unknown:1});
  assert.deepEqual(summary.prepared_amount,{total:'0',unknown:2});
  const max=Number.MAX_SAFE_INTEGER;
  assert.equal(summarizeSheet([{...row,price_yen:max,planned_quantity:max}]).planned_amount.total,(BigInt(max)*BigInt(max)).toString());
  assert.equal(validateSheet({date:'2028-02-29',rows:[]}).date,'2028-02-29');
  assert.throws(()=>validateSheet({date:'2026-02-29',rows:[]}));
});

test('日付追加はSKU・単価をコピーし数量を空欄へ戻す。重複日付とサンプル自動混入を防ぐ',async()=> {
  const ui=setup();
  ui.get('menu-new-date').value='2026-10-18';ui.get('menu-copy').checked=true;
  await ui.get('menu-add-date').listeners.submit(submit());
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].etag,null);
  assert.deepEqual(ui.requests[0].rows,[{...row,planned_quantity:null,prepared_quantity:null}]);
  assert.equal(ui.get('menu-date').value,'2026-10-18');
  await ui.get('menu-add-date').listeners.submit(submit());assert.equal(ui.requests.length,1);
  ui.get('menu-sku').value='item-01/sample';ui.get('menu-add-sku').listeners.submit(submit());
  await ui.get('menu-form').listeners.submit(submit());
  assert.equal(ui.requests[1].rows.length,2);assert.equal(ui.requests[1].rows[1].price_yen,200);
  assert.equal(ui.requests[1].rows[1].planned_quantity,null);
});

test('数量編集で完了状態・小計を表示、失敗・日付切替・再読込で入力を保持する',async()=> {
  const ui=setup(500), prepared=input(ui,2);
  assert.equal(ui.get('menu-rows').children[0].children[3].textContent,'数量未入力');
  prepared.value='12';prepared.listeners.input();
  assert.equal(ui.get('menu-rows').children[0].children[3].textContent,'準備完了');
  assert.match(ui.get('menu-summary').children[3].textContent,/1,200円/);
  ui.get('menu-date').value='2026-10-18';ui.get('menu-date').listeners.change();
  assert.equal(ui.get('menu-date').value,'2026-10-17');assert.equal(ui.menu.canLeave(),false);
  ui.menu.receive(ui.source);assert.equal(input(ui,2).value,'12');
  await ui.get('menu-form').listeners.submit(submit());
  assert.match(ui.get('menu-status').textContent,/入力は保持/);assert.equal(input(ui,2).value,'12');
  ui.setFailure(409);await ui.get('menu-form').listeners.submit(submit());
  assert.equal(ui.get('menu-save').disabled,true);
  await ui.get('menu-latest').listeners.click();assert.equal(input(ui,2).value,'12');
  assert.equal(ui.get('menu-conflict-view').hidden,false);
  ui.setFailure(null);await ui.get('menu-form').listeners.submit(submit());
  assert.equal(ui.requests.at(-1).rows[0].prepared_quantity,12);
  assert.match(ui.get('menu-status').textContent,/保存しました/);assert.equal(ui.menu.canLeave(),true);
});


test('無効な数量を入力中のSKU追加を拒否し、値と検証エラーを保持する',()=> {
  const ui=setup(), planned=input(ui,1);
  planned.value='1.5'; planned.listeners.input();
  assert.ok(planned.validation);
  ui.get('menu-sku').value='item-01/sample'; ui.get('menu-add-sku').listeners.submit(submit());
  assert.equal(ui.get('menu-rows').children.length,1);
  assert.equal(input(ui,1),planned); assert.equal(planned.value,'1.5'); assert.ok(planned.validation);
  assert.equal(ui.requests.length,0);
  planned.value='11';planned.listeners.input();
  ui.get('menu-add-sku').listeners.submit(submit());
  assert.equal(ui.get('menu-rows').children.length,2);
  assert.equal(input(ui,1).value,'11');
});

test('全件未入力の数量・金額は0合計と表示しない',()=> {
  const ui=setup();
  assert.equal(ui.get('menu-summary').children[1].textContent,'準備数: 未入力（1件）');
  assert.equal(ui.get('menu-summary').children[3].textContent,'準備済み売価: 未入力（1件）');
  assert.match(ui.get('menu-summary').children[0].textContent,/10/);
});


test('おしながきに対応SKUの写真を表示し、未登録から編集できる',()=> {
  const ui=setup(), card=ui.get('menu-rows').children[0];
  assert.equal(card.children.find(child=>child.className==='menu-card-tags').children[0].textContent,'ダイコン');
  const media=card.children.find(child=>child.className==='menu-row-photo');
  assert.equal(media.children[0].textContent,'写真未登録');
  media.children[1].listeners.click();
  assert.equal(ui.edits[0].sku.id,'real-001'); assert.equal(ui.edits[0].item.id,'item-14');
  ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>({...sku,photo_id:sku.id==='real-001'?'real-photo':'sample-photo'}))});
  const updated=ui.get('menu-rows').children[0].children.find(child=>child.className==='menu-row-photo');
  assert.equal(updated.children[0].src,'/.netlify/functions/packaging?photo=real-photo');
  assert.match(updated.children[0].alt,/ダイコン.*大根/); assert.equal(updated.children[0].loading,'lazy');
  assert.equal(updated.children[1].textContent,'写真を変更');
});

test('写真更新は未保存の単価・数量原文と不正値を保持し、おしながきを保存しない',async()=> {
  const ui=setup(), planned=input(ui,1), price=input(ui,0), prepared=input(ui,2);
  planned.value='1.5';planned.listeners.input();price.value='00150';price.listeners.input();prepared.value='012';prepared.listeners.input();
  const next={...ui.source,skus:ui.source.skus.map(sku=>sku.id==='real-001'?{...sku,photo_id:'new-photo',price_yen:999}:sku)};
  ui.menu.receive(next);
  assert.equal(input(ui,1),planned);assert.equal(planned.value,'1.5');assert.ok(planned.validation);
  assert.equal(price.value,'00150');assert.equal(prepared.value,'012');assert.equal(ui.requests.length,0);
  const media=ui.get('menu-rows').children[0].children.find(child=>child.className==='menu-row-photo');
  assert.match(media.children[0].src,/new-photo/);
  assert.equal(ui.menu.canLeave(),false);
  planned.value='11';planned.listeners.input();
  await ui.get('menu-form').listeners.submit(submit());
  assert.equal(ui.requests[0].rows[0].price_yen,150);
  assert.equal(ui.requests[0].rows[0].prepared_quantity,12);
  assert.equal(ui.requests[0].etag,'v1');
});

test('タグは同群OR・群間AND、価格両端と未定を区別し、数値nullは常に末尾',()=> {
  const skus=[{item_id:'item-01',id:'a',cultivation_method:'organic'},{item_id:'item-14',id:'b',cultivation_method:'conventional'},{item_id:'item-14',id:'c',cultivation_method:'unknown'}];
  const rows=[{...row,item_id:'item-01',sku_id:'a',price_yen:200},{...row,sku_id:'b',price_yen:500},{...row,sku_id:'c',price_yen:null},{...row,item_id:'item-01',sku_id:'a2',price_yen:199}];
  const filters={item:new Set(['item-01','item-14']),cultivation:new Set(['organic','conventional']),price:new Set(['range'])};
  assert.deepEqual(visibleMenuRows(rows,skus,[],filters,'registered').map(row=>row.sku_id),['a','b']);
  filters.cultivation.clear();filters.price.add('unknown');
  assert.deepEqual(visibleMenuRows(rows,skus,[],filters,'price-desc').map(row=>row.sku_id),['b','a','c']);
  filters.price.clear();
  assert.deepEqual(visibleMenuRows(rows,skus,[],filters,'price-asc').map(row=>row.sku_id),['a2','a','b','c']);
  assert.deepEqual(visibleMenuRows(rows.map(row=>({...row,price_yen:300})),skus,[],filters,'price-desc').map(row=>row.sku_id),['a','b','c','a2']);
});

test('絞り込み・ソートは無効入力と数量原文を保持し、非表示行も元順で保存する',async()=> {
  const ui=setup();
  const other={...row,item_id:'item-01',sku_id:'sample',price_yen:500,planned_quantity:null};
  const source={...ui.source,items:[...ui.source.items,{id:'item-01',name:'タマネギ'}],sheets:[{date:'2026-10-17',rows:[{...row,price_yen:200},other],etag:'v1'}]};
  ui.menu.receive(source);
  const first=ui.get('menu-rows').children[0], planned=first.children[2].children[1].children[0], price=first.children[2].children[0].children[0];
  planned.value='1.5';planned.listeners.input();price.value='00200';price.listeners.input();
  const tag=ui.get('menu-item-tags').children.find(button=>button.textContent==='タマネギ');tag.listeners.click();
  assert.equal(first.hidden,true);assert.equal(planned.value,'1.5');assert.ok(planned.validation);assert.equal(price.value,'00200');
  ui.get('menu-sort').value='price-desc';ui.get('menu-sort').listeners.change();
  assert.equal(first.children[2].children[1].children[0],planned);
  ui.get('menu-clear-filters').listeners.click();assert.equal(first.hidden,false);
  planned.value='11';planned.listeners.input();
  const range=ui.get('menu-price-tags').children.find(button=>button.textContent==='200〜500円');range.listeners.click();
  price.value='00600';price.listeners.input();assert.equal(first.hidden,false);
  ui.get('menu-reapply').listeners.click();assert.equal(first.hidden,true);assert.equal(price.value,'00600');
  await ui.get('menu-form').listeners.submit(submit());
  assert.equal(ui.requests[0].rows.length,2);
  assert.equal(ui.requests[0].rows[0].sku_id,'real-001');assert.equal(ui.requests[0].rows[0].price_yen,600);
  assert.equal(ui.requests[0].rows[1].sku_id,'sample');
});

test('品目ソートは日本語名・同値元順を使い、予定数nullは末尾',()=> {
  const filters={item:new Set(),cultivation:new Set(),price:new Set()};
  const rows=[{...row,sku_id:'a',item_id:'item-01',planned_quantity:null},{...row,sku_id:'b',planned_quantity:20},{...row,sku_id:'c',planned_quantity:20}];
  assert.deepEqual(visibleMenuRows(rows,[],[{id:'item-01',name:'タマネギ'},{id:'item-14',name:'ダイコン'}],filters,'item').map(row=>row.sku_id),['b','c','a']);
  assert.deepEqual(visibleMenuRows(rows,[],[],filters,'planned-desc').map(row=>row.sku_id),['b','c','a']);
});
