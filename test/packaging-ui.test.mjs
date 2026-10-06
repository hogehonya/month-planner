import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() { this.children = []; this.listeners = {}; this.value = ''; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  insertBefore(child, before) { const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() { this.focused = true; }
  reset() {}
  showModal() { this.modalOpen = true; }
  close() { this.modalOpen = false; }
}

async function setup(skus = []) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const requests = [];
  const source = (await readFile(new URL('../public/packaging.mjs', import.meta.url), 'utf8')).replace("import { PHOTO_LIMIT } from './packaging-model.mjs';", 'const PHOTO_LIMIT = 3145728;');
  const context = vm.createContext({ document: { getElementById: get, createElement: () => new Element() }, Option: class extends Element { constructor(name, value) { super(); this.textContent = name; this.value = value; } }, fetch: async (_url, options) => {
    if (options?.method) { requests.push(JSON.parse(options.body)); return {ok:true,json:async()=>({ok:true})}; }
    return {ok:true,json:async()=>({items:[{id:'item-01',name:'大根'}],skus})};
  } });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('status').textContent, '読み込みました。');
  return { get, requests, elements };
}

test('品目カードからPINなしで登録フォームを直接開き、選択品目に保存する', async () => {
  const ui = await setup();
  const button = ui.get('items').children[0].children.find(child => child.className === 'register-sku');
  assert.equal(button.textContent, '登録');
  assert.equal(button['aria-label'], '大根にSKU・写真を登録');
  assert.equal(ui.get('items').children[0].className, 'packaging-item');
  button.listeners.click();
  assert.equal(ui.get('sku-dialog').modalOpen, true);
  assert.equal(ui.get('item-name').value, '大根');
  assert.equal(ui.get('sku-id').value, '');
  ui.get('sku-id').value = 'daikon-001';
  ui.get('sku-name').value = '大根の袋';
  ui.get('photo').files = [];
  await ui.get('sku-form').listeners.submit({preventDefault(){}});
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].action, 'save_sku');
  assert.equal(ui.requests[0].item_id, 'item-01');
  assert.equal(ui.requests[0].id, 'daikon-001');
  assert.equal(Object.hasOwn(ui.requests[0], 'pin'), false);
  assert.equal(ui.elements.has('auth'), false);
});

test('既存SKUの編集もPINなしで開き、IDと商品情報を保持する', async () => {
  const ui = await setup([{item_id:'item-01',id:'existing-001',name:'既存商品',type:'確認済み品種',note:'備考',etag:'v1'}]);
  assert.equal(ui.get('items').children[0].className, 'packaging-item has-skus');
  const skuCard = ui.get('items').children[0].children.find(child => child.className === 'sku-card');
  skuCard.children.find(child => child.textContent === 'SKUを編集').listeners.click();
  assert.equal(ui.get('sku-dialog').modalOpen, true);
  assert.equal(ui.get('sku-id').value, 'existing-001');
  assert.equal(ui.get('sku-id').readOnly, true);
  assert.equal(ui.get('sku-name').value, '既存商品');
  assert.equal(ui.get('sku-type').value, '確認済み品種');
  assert.equal(ui.get('sku-note').value, '備考');
});
