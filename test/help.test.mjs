import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('取説直リンクと戻る進むで編集URL・既存入力・カレンダーDOMを保持する', () => {
  const nodes = new Map(['planner-view', 'help-view', 'help-link', 'help-heading'].map(id => [id, {
    hidden: id === 'help-view', attributes: {}, focus() {},
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
  }]));
  const planner = nodes.get('planner-view');
  planner.draft = { note: '保存前の入力', json: '{"entries":[]}', selectedDate: '2026-10-06' };
  const draft = planner.draft;
  const location = { hash: '#help', search: '?edit=1' };
  let hashchange;
  const window = { scrollY: 120, scrollTo(x, y) { this.scrollY = y; }, addEventListener(type, handler) { assert.equal(type, 'hashchange'); hashchange = handler; } };
  const document = { getElementById(id) { return nodes.get(id); }, title: '' };
  runInNewContext(readFileSync(new URL('../public/help.mjs', import.meta.url), 'utf8'), { document, window, location });
  assert.equal(planner.hidden, true); assert.equal(nodes.get('help-view').hidden, false);
  assert.match(document.title, /取説/);
  location.hash = '#planner'; hashchange();
  assert.equal(planner.hidden, false); assert.equal(nodes.get('help-view').hidden, true);
  window.scrollY = 300; location.hash = '#help'; hashchange();
  assert.equal(nodes.get('help-link').attributes['aria-current'], 'page');
  location.hash = '#planner'; hashchange();
  assert.equal(window.scrollY, 300);
  assert.equal(nodes.get('planner-view'), planner); assert.equal(planner.draft, draft);
  assert.deepEqual(draft, { note: '保存前の入力', json: '{"entries":[]}', selectedDate: '2026-10-06' });
  assert.equal(location.search, '?edit=1');
});
