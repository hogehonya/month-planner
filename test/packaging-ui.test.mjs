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
}

async function setup() {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let rejectPin = true;
  const source = (await readFile(new URL('../public/packaging.mjs', import.meta.url), 'utf8')).replace("import { PHOTO_LIMIT } from './packaging-model.mjs';", 'const PHOTO_LIMIT = 3145728;');
  const context = vm.createContext({ document: { getElementById: get, createElement: () => new Element() }, Option: class extends Element { constructor(name, value) { super(); this.textContent = name; this.value = value; } }, fetch: async (_url, options) => options?.method ? { ok: !rejectPin, status: rejectPin ? 401 : 200, json: async () => rejectPin ? {error:'PINが違います。'} : {} } : { ok:true, json:async()=>({items:[{id:'item-01',name:'大根'}],skus:[]}) } });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('status').textContent, '読み込みました。');
  return { get, acceptPin() { rejectPin = false; } };
}

test('認証前の品目カードから登録し、PIN失敗後も選択品目を保持してフォームへ進む', async () => {
  const ui = await setup();
  const card = ui.get('items').children[0];
  const button = card.children.find(child => child.className === 'register-sku');
  assert.equal(button.textContent, 'この品目にSKU・写真を登録');
  button.listeners.click();
  assert.equal(ui.get('auth').hidden, false);
  assert.match(ui.get('auth-context').textContent, /大根/);
  assert.equal(ui.get('pin').focused, true);
  ui.get('pin').value = 'wrong';
  await ui.get('auth').listeners.submit({preventDefault(){}});
  assert.equal(ui.get('sku-dialog').modalOpen, undefined);
  ui.acceptPin();
  ui.get('pin').value = 'correct';
  await ui.get('auth').listeners.submit({preventDefault(){}});
  assert.equal(ui.get('sku-dialog').modalOpen, true);
  assert.equal(ui.get('item-name').value, '大根');
  assert.equal(ui.get('sku-id').value, '');
  assert.equal(ui.get('pin').value, '');
});

test('認証済みの品目カードは直接登録フォームを開く', async () => {
  const ui = await setup();
  ui.acceptPin();
  ui.get('pin').value = 'correct';
  await ui.get('auth').listeners.submit({preventDefault(){}});
  ui.get('items').children[0].children.find(child => child.className === 'register-sku').listeners.click();
  assert.equal(ui.get('sku-dialog').modalOpen, true);
  assert.equal(ui.get('item-name').value, '大根');
});
