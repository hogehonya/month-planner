import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSheet, validateSheet } from '../public/packaging-model.mjs';
import { setupMenu, visibleMenuRows } from '../public/menu-sheet.mjs';
const row = {item_id:'item-14',sku_id:'real-001',price_yen:100,planned_quantity:10,prepared_quantity:null,status_bits:0};
class Element {
  constructor(tag='') {this.tag=tag;this.children=[];this.listeners={};this.value='';this.dataset={};}
  append(...children){for(const child of children){this.children=this.children.filter(existing=>existing!==child);this.children.push(child);}}
  click(){this.listeners.click?.();}
  focus(){this.focused=true;}
  setAttribute(name,value){this[name]=value;}
  replaceChildren(...children){this.children=children;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  setCustomValidity(value){this.validation=value;}
  reportValidity(){return !this.validation && this.children.every(child=>child.reportValidity());}
}
function setup(failure=null,view=null) {
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
  const menu=setupMenu({defaultView:view,getElementById:get,createElement:tag=>new Element(tag)},api,(item,sku)=>edits.push({item,sku}));
  const source={items:[{id:'item-14',name:'ダイコン'}],skus:[{item_id:'item-14',id:'real-001',name:'大根',price_yen:100},{item_id:'item-01',id:'sample',name:'サンプル',price_yen:200}],sheets};
  menu.receive(source);
  return {get,menu,requests,edits,setFailure:value=>{saveFailure=value;},source};
}
const submit=()=>({preventDefault(){}});
const find=(el,predicate)=>predicate(el) ? el : el.children.map(child=>find(child,predicate)).find(Boolean);
const inputIn=(card,index)=>find(card,el=>el.dataset.field===['price_yen','planned_quantity','prepared_quantity'][index]);
const input=(ui,index)=>inputIn(ui.get('menu-rows').children[0],index);
const state=ui=>find(ui.get('menu-rows').children[0],el=>el.className==='menu-row-state');

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
  assert.equal(state(ui).textContent,'残り 未確認');
  prepared.value='12';prepared.listeners.input();
  assert.equal(state(ui).textContent,'残り 0・準備完了');
  assert.match(ui.get('menu-amount-summary').children[1].textContent,/1,200円/);
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
  assert.equal(ui.get('menu-summary').children[1].textContent,'準備済み: 未入力（1件）');
  assert.equal(ui.get('menu-amount-summary').children[1].textContent,'準備済み売価: 未入力（1件）');
  assert.match(ui.get('menu-summary').children[0].textContent,/10/);
});


test('おしながきに対応SKUの写真を表示し、未登録から編集できる',()=> {
  const ui=setup(), card=ui.get('menu-rows').children[0];
  assert.equal(find(card,child=>child.className==='menu-card-tags').children[0].textContent,'ダイコン');
  const media=find(card,child=>child.className==='menu-row-photo');
  assert.equal(media.children[0].textContent,'写真未登録');
  media.children[1].listeners.click();
  assert.equal(ui.edits[0].sku.id,'real-001'); assert.equal(ui.edits[0].item.id,'item-14');
  ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>({...sku,photo_id:sku.id==='real-001'?'real-photo':'sample-photo'}))});
  const updated=find(ui.get('menu-rows').children[0],child=>child.className==='menu-row-photo');
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
  const media=find(ui.get('menu-rows').children[0],child=>child.className==='menu-row-photo');
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
  const first=ui.get('menu-rows').children[0], planned=inputIn(first,1), price=inputIn(first,0);
  planned.value='1.5';planned.listeners.input();price.value='00200';price.listeners.input();
  const tag=ui.get('menu-item-tags').children.find(button=>button.textContent==='タマネギ');tag.listeners.click();
  assert.equal(first.hidden,true);assert.equal(planned.value,'1.5');assert.ok(planned.validation);assert.equal(price.value,'00200');
  ui.get('menu-sort').value='price-desc';ui.get('menu-sort').listeners.change();
  assert.equal(inputIn(first,1),planned);
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


test('残りは有効数量のみ計算し、未入力・不正値を未確認、詳細のinvalid時は開いて保持する',()=> {
 const ui=setup(), needed=input(ui,1), prepared=input(ui,2), price=input(ui,0);
 const detail=find(ui.get('menu-rows').children[0],el=>el.tag==='details');
 assert.ok(!detail.open);prepared.value='3';prepared.listeners.input();assert.equal(state(ui).textContent,'残り 7');
 prepared.value='1.5';prepared.listeners.input();assert.equal(state(ui).textContent,'残り 未確認');
 prepared.value='12';prepared.listeners.input();assert.equal(state(ui).textContent,'残り 0・準備完了');
 needed.value='';needed.listeners.input();assert.equal(state(ui).textContent,'残り 未確認');
 price.value='1.5';price.listeners.input();
 ui.get('menu-price-tags').children.find(button=>button.textContent==='200〜500円').listeners.click();
 assert.equal(ui.get('menu-rows').children[0].hidden,true);
 ui.get('menu-form').listeners.invalid({target:price});
 assert.equal(ui.get('menu-rows').children[0].hidden,false);
 assert.equal(detail.open,true);assert.equal(price.value,'1.5');assert.ok(price.validation);
});


test('閉じた絞り込みsummaryに件数を表示し、商品名にある品種を重複しない',()=> {
 const ui=setup();
 ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>sku.id==='real-001'?{...sku,name:'大根 青首 慣行',type:'青首',packaging_condition:'2本袋'}:sku)});
 assert.equal(find(ui.get('menu-rows').children[0],el=>el.className==='menu-row-info').textContent,'2本袋');
 assert.match(ui.get('menu-filter-summary').textContent,/1\/1件/);
 ui.get('menu-price-tags').children.find(button=>button.textContent==='200〜500円').listeners.click();
 assert.match(ui.get('menu-filter-summary').textContent,/0\/1件/);assert.equal(ui.get('menu-no-match').hidden,false);
 ui.get('menu-clear-filters').listeners.click();
 ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>sku.id==='real-001'?{...sku,type:'青首',packaging_condition:'2本袋'}:sku)});
 assert.equal(find(ui.get('menu-rows').children[0],el=>el.className==='menu-row-info').textContent,'青首 ／ 2本袋');
});


test('栽培タブ・表カード・独立詳細往復は不正値と原文、フィルタ・ソートを保持する',()=> {
  const ui=setup();
  const source={...ui.source,skus:ui.source.skus.map(sku=>({...sku,cultivation_method:sku.id==='real-001'?'organic':'conventional'})),sheets:[{date:'2026-10-17',etag:'v1',rows:[{...row},{...row,item_id:'item-01',sku_id:'sample'}]}]};
  ui.menu.receive(source);
  const first=ui.get('menu-rows').children[0], planned=inputIn(first,1), price=inputIn(first,0);
  planned.value='1.5';planned.listeners.input();price.value='00100';price.listeners.input();
  ui.get('menu-sort').value='price-desc';ui.get('menu-sort').listeners.change();
  ui.get('menu-cultivation-tabs').children.find(tab=>tab.textContent==='慣行').click();
  assert.equal(first.hidden,true);
  ui.get('menu-layout-table').click();assert.equal(ui.get('menu-rows').dataset.layout,'table');
  ui.get('menu-layout-card').click();assert.equal(ui.get('menu-rows').dataset.layout,'card');
  ui.get('menu-cultivation-tabs').children.find(tab=>tab.textContent==='有機').click();
  assert.equal(first.hidden,false);
  const link=find(first,el=>el.className==='menu-detail-link');link.click();
  assert.equal(ui.get('menu-list-controls').hidden,true);assert.equal(ui.get('menu-master').hidden,true);
  assert.equal(ui.get('menu-detail-row').children[0],first);assert.equal(ui.get('menu-detail-title').textContent,'大根');
  assert.equal(find(first,el=>el.tag==='details').open,true);
  ui.get('menu-detail-back').click();
  assert.equal(ui.get('menu-list-controls').hidden,false);assert.equal(ui.get('menu-detail-view').hidden,true);
  assert.equal(planned.value,'1.5');assert.ok(planned.validation);assert.equal(price.value,'00100');
  assert.equal(ui.get('menu-sort').value,'price-desc');
  assert.equal(ui.get('menu-cultivation-tabs').children.find(tab=>tab.textContent==='有機')['aria-selected'],'true');
  assert.equal(ui.requests.length,0);
});

test('栽培タブは矢印・Home・Endで選択し、未確認もアクセスできる',()=> {
  const ui=setup(), tabs=()=>ui.get('menu-cultivation-tabs').children;
  const key=(tab,value)=>tab.listeners.keydown({key:value,preventDefault(){}});
  key(tabs()[0],'ArrowRight');assert.equal(tabs()[1]['aria-selected'],'true');
  key(tabs()[1],'End');assert.equal(tabs()[3]['aria-selected'],'true');
  assert.equal(ui.get('menu-rows').children[0].hidden,false);
  key(tabs()[3],'Home');assert.equal(tabs()[0]['aria-selected'],'true');
  key(tabs()[0],'ArrowLeft');assert.equal(tabs()[3]['aria-selected'],'true');
});


test('表は列見出し・行・セルを持ち、詳細とカードでは表の意味を外す',()=> {
 const ui=setup(), card=ui.get('menu-rows').children[0];
 ui.get('menu-layout-table').click();
 assert.equal(ui.get('menu-table').role,'table'); assert.equal(ui.get('menu-table-head').hidden,false);
 assert.equal(card.role,'row');assert.equal(find(card,el=>el.className==='menu-row-identity').role,'cell');
 find(card,el=>el.className==='menu-detail-link').click();assert.equal(card.role,'article');
 ui.get('menu-detail-back').click();assert.equal(card.role,'row');
 ui.get('menu-layout-card').click();assert.equal(card.role,'article');assert.equal(ui.get('menu-table-head').hidden,true);
});

test('不正入力で詳細を閉じると履歴も一覧へ戻り、再描画で詳細を再開しない',()=> {
 const listeners={}, location={hash:'',pathname:'/packaging.html',search:''};
 const view={location,addEventListener:(name,fn)=>{listeners[name]=fn;},history:{state:null,
 pushState(state,title,url){this.state=state;location.hash=url;},
 replaceState(state,title,url){this.state=state;location.hash=url.includes('#')?url.slice(url.indexOf('#')):'';}}};
 const ui=setup(null,view),card=ui.get('menu-rows').children[0],price=inputIn(card,0);
 find(card,el=>el.className==='menu-detail-link').click();assert.match(location.hash,/#sku=/);
 price.value='1.5';price.listeners.input();ui.get('menu-form').listeners.invalid({target:price});
 assert.equal(location.hash,'');assert.equal(view.history.state,null);assert.equal(ui.get('menu-detail-view').hidden,true);
 listeners.popstate();listeners.hashchange();assert.equal(ui.get('menu-detail-view').hidden,true);assert.equal(price.value,'1.5');
});


test('区分は商品名から推測せず、未確認と編集後の区分をタブ・商品枠へ割り当てる',()=> {
 const ui=setup();
 const card=ui.get('menu-rows').children[0];
 assert.equal(card.dataset.cultivation,'unknown');
 for(const key of ['organic','conventional','unknown']) {
  const tab=ui.get('menu-cultivation-tabs').children.find(tab=>tab.dataset.cultivation===key);
  assert.ok(tab);assert.equal(tab.children[0]['aria-hidden'],'true');
 }
 const planned=inputIn(card,1);planned.value='1.5';planned.listeners.input();
 for(const [method,name] of [['organic','慣行と書いてある商品'],['conventional','有機と書いてある商品'],['unexpected','有機商品']]) {
  ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>sku.id==='real-001'?{...sku,name,cultivation_method:method}:sku)});
  const expected=method==='unexpected'?'unknown':method;
  assert.equal(card.dataset.cultivation,expected);
  const badge=find(card,el=>el.className==='cultivation-badge');
  assert.equal(badge.dataset.cultivation,expected);assert.equal(badge.children[0]['aria-hidden'],'true');
  assert.equal(inputIn(card,1),planned);assert.equal(planned.value,'1.5');
 }
});


test('確定は明示操作のみで0値を許可し、入力変更で対応bit解除・写真は独立する',async()=> {
 const ui=setup();ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>sku.id==='real-001'?{...sku,packaging_condition:'2本袋'}:sku)});
 const card=ui.get('menu-rows').children[0],check=bit=>find(card,el=>el.dataset.bit===String(bit));
 assert.equal(check(2).checked,false);assert.equal(check(4).checked,false);
 inputIn(card,0).value='0';inputIn(card,0).listeners.input();inputIn(card,1).value='0';inputIn(card,1).listeners.input();
 for(const bit of [1,2,4]) {assert.equal(check(bit).disabled,false);check(bit).checked=true;check(bit).listeners.change();}
 assert.equal(find(card,el=>el.className==='menu-row-decision').textContent,'決定・写真なし');
 ui.get('menu-decision-filter').value='decided';ui.get('menu-decision-filter').listeners.change();assert.equal(card.hidden,false);
 ui.get('menu-decision-filter').value='no-photo';ui.get('menu-decision-filter').listeners.change();assert.equal(card.hidden,false);
 const next={...ui.source,skus:ui.source.skus.map(sku=>sku.id==='real-001'?{...sku,photo_id:'photo',packaging_condition:'2本袋'}:sku)};
 ui.menu.receive(next);assert.equal(find(card,el=>el.className==='menu-row-decision').textContent,'決定');
 assert.equal(check(1).checked,true);assert.equal(check(2).checked,true);assert.equal(check(4).checked,true);
 inputIn(card,0).value='1.5';inputIn(card,0).listeners.input();assert.equal(check(2).checked,false);assert.equal(check(2).disabled,true);
 inputIn(card,0).value='0';inputIn(card,0).listeners.input();check(2).checked=true;check(2).listeners.change();
 ui.menu.receive({...next,skus:next.skus.map(sku=>sku.id==='real-001'?{...sku,packaging_condition:''}:sku)});
 assert.equal(check(1).checked,false);assert.equal(check(1).disabled,true);
 assert.equal(find(card,el=>el.className==='menu-row-decision').textContent,'未決定');
 await ui.get('menu-form').listeners.submit(submit());assert.equal(ui.requests[0].rows[0].status_bits,6);
});

test('決定と写真なしは独立して絞れ、コピーした日付の確定は0になる',async()=> {
 const filters={item:new Set(),cultivation:new Set(),price:new Set(),status:'decided'};
 const rows=[{...row,status_bits:7},{...row,sku_id:'other',status_bits:6}];
 assert.equal(visibleMenuRows(rows,[],[],filters,'registered').length,1);
 filters.status='no-photo';assert.equal(visibleMenuRows(rows,[{item_id:'item-14',id:'other',photo_id:'photo'}],[],filters,'registered')[0].status_bits,7);
 filters.status='undecided';assert.equal(visibleMenuRows(rows,[],[],filters,'registered')[0].status_bits,6);
 const ui=setup();ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>({...sku,packaging_condition:'2本袋'})),sheets:[{date:'2026-10-17',rows:[{...row,status_bits:7}],etag:'v1'}]});
 ui.get('menu-new-date').value='2026-10-18';ui.get('menu-copy').checked=true;await ui.get('menu-add-date').listeners.submit(submit());
 assert.equal(ui.requests[0].rows[0].status_bits,0);assert.equal(ui.requests[0].rows[0].planned_quantity,null);
});


test('競合比較は同じ数量でも他者の各確定bitを表示し、入力側のbitを保持する',async()=> {
 const ui=setup(409);
 ui.menu.receive({...ui.source,skus:ui.source.skus.map(sku=>({...sku,packaging_condition:'2本袋'})),sheets:[{date:'2026-10-17',rows:[{...row,status_bits:1}],etag:'v1'}]});
 await ui.get('menu-form').listeners.submit(submit());
 await ui.get('menu-latest').listeners.click();
 const text=ui.get('menu-latest-rows').children[0].textContent;
 assert.match(text,/荷姿: 未確定/);assert.match(text,/単価: 未確定/);assert.match(text,/必要数: 未確定/);
 const card=ui.get('menu-rows').children[0];
 assert.equal(find(card,el=>el.dataset.bit==='1').checked,true);
});

test('出荷なしは元値を保持して合計から除外し、解除で戻り独立して絞れる',async()=> {
 const ui=setup(),card=ui.get('menu-rows').children[0],check=find(card,el=>el.dataset.bit==='16');
 assert.equal(check.disabled,false);check.checked=true;check.listeners.change();
 assert.match(find(card,el=>el.className==='menu-row-decision').textContent,/出荷なし/);
 assert.match(ui.get('menu-total-scope').textContent,/出荷対象 0件/);
 assert.match(ui.get('menu-summary').children[0].textContent,/合計: 0/);
 assert.match(ui.get('menu-amount-summary').children[0].textContent,/合計: 0円/);
 ui.get('menu-decision-filter').value='no-shipment';ui.get('menu-decision-filter').listeners.change();assert.equal(card.hidden,false);
 check.checked=false;check.listeners.change();assert.match(ui.get('menu-summary').children[0].textContent,/10/);
 check.checked=true;check.listeners.change();await ui.get('menu-form').listeners.submit(submit());
 assert.equal(ui.requests[0].rows[0].status_bits,16);assert.equal(ui.requests[0].rows[0].planned_quantity,10);assert.equal(ui.requests[0].rows[0].price_yen,100);
});
