import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSheet, validateSheet } from '../public/packaging-model.mjs';
import { setupMenu } from '../public/menu-sheet.mjs';
const row = {item_id:'item-14',sku_id:'real-001',price_yen:100,planned_quantity:10,prepared_quantity:null};
class Element {
  constructor(tag='') {this.tag=tag;this.children=[];this.listeners={};this.value='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  setCustomValidity(value){this.validation=value;}
  reportValidity(){return !this.validation && this.children.every(child=>child.reportValidity());}
}
function setup(failure=null) {
  const elements = new Map(), requests=[];
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
  const menu=setupMenu({getElementById:get,createElement:tag=>new Element(tag)},api);
  const source={items:[],skus:[{item_id:'item-14',id:'real-001',name:'大根',price_yen:100},{item_id:'item-01',id:'sample',name:'サンプル',price_yen:200}],sheets};
  menu.receive(source);
  return {get,menu,requests,setFailure:value=>{saveFailure=value;},source};
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
