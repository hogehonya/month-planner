import test from 'node:test';
import assert from 'node:assert/strict';
import { setupOnlineSync } from '../public/online-sync.mjs';

class Element {
  constructor() { this.children = []; this.listeners = {}; this.hidden = false; this.open = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const snapshot = () => ({ token: 'preview-token', source: 'https://online.example', expires_at: new Date(Date.now() + 60000).toISOString(), summary: Object.fromEntries(['skus', 'sheets', 'comments', 'photos'].map(kind => [kind, { added: 1, changed: 0, removed: 0 }])), changes: [{ kind: 'skus', key: 'skus/item-01/sku-01.json', label: 'タマネギ・商品', change: 'changed', before: { id: 'sku-01', name: '旧商品', price_yen: null }, after: { id: 'sku-01', name: '<script>商品</script>', price_yen: 0 } }, { kind: 'sheets', key: 'menu-sheets/2026-10-17.json', label: '2026-10-17', change: 'added', before: null, after: { date: '2026-10-17', rows: [{ item_id: 'item-01', sku_id: 'sku-01', price_yen: 200, planned_quantity: 4, prepared_quantity: 2, status_bits: 7 }] } }] });
const text = el => [el.textContent ?? '', ...el.children.map(text)].join(' ');
function setup(request = async body => body.action === 'preview' ? snapshot() : { ok: true }, refresh = async () => {}) {
  const elements = new Map(), events = {};
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let allowed = true;
  const ui = setupOnlineSync({ getElementById: get, createElement: () => new Element(), defaultView: { addEventListener: (type, handler) => { events[type] = handler; } } }, { canStart: () => allowed, refresh, request });
  return { ui, get, events, allow: value => { allowed = value; }, click: id => get(id).listeners.click() };
}
const capability = { online_sync: { enabled: true, source: 'https://online.example' } };

test('同期機能を通知したローカルだけに表示し、未保存状態ではプレビューしない', async () => {
  let requests = 0;
  const h = setup(async () => { requests++; return snapshot(); });
  assert.equal(h.get('online-sync').hidden, true);
  h.ui.receive({}); await h.click('online-sync'); assert.equal(requests, 0);
  h.ui.receive(capability); assert.equal(h.get('online-sync').hidden, false);
  h.allow(false); await h.click('online-sync'); assert.equal(requests, 0);
  assert.match(h.get('online-sync-status').textContent, /未保存/);
  assert.doesNotThrow(() => setupOnlineSync({ getElementById: () => null }, {}));
});

test('差分の実値をテキスト表示し、プレビューだけでは適用せずキャンセルできる', async () => {
  const requests = [], h = setup(async body => { requests.push(body); return snapshot(); });
  h.ui.receive(capability); await h.click('online-sync');
  assert.equal(h.get('online-sync-dialog').open, true);
  assert.deepEqual(requests, [{ action: 'preview' }]);
  const diff = text(h.get('online-sync-changes'));
  for (const value of ['旧商品', '<script>商品</script>', '単価（円）', '未入力', '0', '必要数', '4', '準備済み', '2', '荷姿確定']) assert.ok(diff.includes(value), value);
  assert.ok(!diff.includes('skus/item-01/sku-01.json'));
  assert.equal(h.get('online-sync-changes').innerHTML, undefined);
  await h.click('online-sync-cancel'); assert.equal(h.get('online-sync-dialog').open, false);
  await h.click('online-sync-apply'); assert.equal(requests.length, 1);
});

test('適用直前の未保存・期限切れを拒否し、二重適用と適用中Escapeを防ぐ', async () => {
  let resolveApply, applies = 0, refreshes = 0;
  const h = setup(body => body.action === 'preview' ? Promise.resolve(snapshot()) : (applies++, new Promise(resolve => { resolveApply = resolve; })), async () => { refreshes++; });
  h.ui.receive(capability); await h.click('online-sync');
  h.allow(false); await h.click('online-sync-apply'); assert.equal(applies, 0);
  h.allow(true); const pending = h.click('online-sync-apply');
  await h.click('online-sync-apply'); assert.equal(applies, 1);
  let prevented = false; h.get('online-sync-dialog').listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.get('online-sync-dialog').open, true);
  prevented = false; h.events.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  resolveApply({ ok: true }); await pending;
  assert.equal(refreshes, 1); assert.equal(h.get('online-sync-dialog').open, false);
  assert.match(h.get('online-sync-status').textContent, /置き換えました/);
  const expired = setup(async () => ({ ...snapshot(), expires_at: '2000-01-01T00:00:00Z' }));
  expired.ui.receive(capability); await expired.click('online-sync'); await expired.click('online-sync-apply');
  assert.match(expired.get('online-sync-message').textContent, /有効期限/); assert.equal(expired.get('online-sync-apply').disabled, true);
});

test('失敗時は再確認でき、適用後の読込失敗と適用失敗を区別する', async () => {
  let previews = 0, applies = 0, refreshed = 0;
  const h = setup(async body => { if (body.action === 'preview') { previews++; return snapshot(); } applies++; throw new Error('期限切れ'); }, async () => { refreshed++; });
  h.ui.receive(capability); await h.click('online-sync'); await h.click('online-sync-apply');
  assert.equal(refreshed, 0); assert.equal(h.get('online-sync-dialog').open, true);
  assert.match(h.get('online-sync-message').textContent, /入力は保持/);
  await h.click('online-sync-apply'); assert.equal(applies, 1);
  await h.click('online-sync-retry'); assert.equal(previews, 2);
  const loaded = setup(undefined, async () => { throw new Error('通信失敗'); });
  loaded.ui.receive(capability); await loaded.click('online-sync'); await loaded.click('online-sync-apply');
  assert.match(loaded.get('online-sync-message').textContent, /置き換えは完了.*再読込に失敗/);
});

test('プレビューの二重要求とキャンセル後の古い応答を防ぐ', async () => {
  let finish, requests = 0;
  const h = setup(() => { requests++; return new Promise(resolve => { finish = resolve; }); });
  h.ui.receive(capability); const pending = h.click('online-sync'); await h.click('online-sync');
  assert.equal(requests, 1); await h.click('online-sync-cancel');
  finish(snapshot()); await pending;
  assert.equal(h.get('online-sync-dialog').open, false); assert.equal(h.get('online-sync-apply').disabled, true);
});
