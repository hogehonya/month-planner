import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function load({ stored = null, failRead = false, failWrite = false } = {}) {
  const buttons = ['standard', 'large', 'extra-large'].map(size => ({
    dataset: { fontSize: size }, pressed: '',
    setAttribute(name, value) { assert.equal(name, 'aria-pressed'); this.pressed = value; },
    addEventListener(type, handler) { assert.equal(type, 'click'); this.click = handler; },
  }));
  let scale, saved;
  const draft = { note: '保持する入力' };
  const document = { draft, querySelectorAll() { return buttons; }, documentElement: { style: { setProperty(name, value) { assert.equal(name, '--font-scale'); scale = value; } } } };
  const localStorage = {
    getItem(key) { assert.equal(key, 'month-planner-font-size'); if (failRead) throw new Error('unavailable'); return stored; },
    setItem(key, value) { assert.equal(key, 'month-planner-font-size'); if (failWrite) throw new Error('unavailable'); saved = value; },
  };
  runInNewContext(readFileSync(new URL('../public/font-size.mjs', import.meta.url), 'utf8'), { document, localStorage });
  return { buttons, scale: () => scale, saved: () => saved, document, draft };
}

test('文字サイズを復元・切替・保存し、既存入力を保持する', () => {
  const app = load({ stored: 'large' });
  assert.equal(app.scale(), '1.15'); assert.equal(app.buttons[1].pressed, 'true');
  app.buttons[2].click(); assert.equal(app.scale(), '1.3'); assert.equal(app.saved(), 'extra-large');
  assert.deepEqual(app.buttons.map(button => button.pressed), ['false', 'false', 'true']);
  app.buttons[0].click(); assert.equal(app.scale(), '1'); assert.equal(app.saved(), 'standard');
  assert.equal(app.document.draft, app.draft); assert.equal(app.draft.note, '保持する入力');
});

test('保存値が不正・未設定・読込不能なら標準、保存不能でも当ページで切替できる', () => {
  for (const stored of [null, 'unknown', '__proto__']) assert.equal(load({ stored }).scale(), '1');
  const app = load({ failRead: true, failWrite: true });
  assert.equal(app.scale(), '1'); assert.doesNotThrow(() => app.buttons[2].click());
  assert.equal(app.scale(), '1.3'); assert.equal(app.buttons[2].pressed, 'true');
});
