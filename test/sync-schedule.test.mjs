import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function setup(visibilityState = 'visible') {
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const timers = new Map();
  let nextId = 0, syncs = 0, builds = 0, listener;
  const document = { visibilityState, addEventListener(name, callback) { assert.equal(name, 'visibilitychange'); listener = callback; } };
  runInNewContext(source.slice(source.indexOf('let syncTimer = null;')), {
    document, buildMonth: () => builds++, sync: () => syncs++,
    setInterval(callback, delay) { timers.set(++nextId, { callback, delay }); return nextId; },
    clearInterval(id) { timers.delete(id); },
  });
  return { timers, get syncs() { return syncs; }, get builds() { return builds; },
    visibility(value) { document.visibilityState = value; listener(); } };
}

test('初回取得を維持し、表示中30秒同期・非表示停止・復帰即同期を行う', () => {
  const app = setup();
  assert.equal(app.builds, 1);
  assert.equal(app.syncs, 1);
  assert.equal(app.timers.size, 1);
  const timer = [...app.timers.values()][0];
  assert.equal(timer.delay, 30_000);
  timer.callback();
  assert.equal(app.syncs, 2);
  app.visibility('hidden');
  assert.equal(app.timers.size, 0);
  timer.callback(); // 解除と競合したキュー済みcallbackも取得しない
  assert.equal(app.syncs, 2);
  app.visibility('visible');
  assert.equal(app.syncs, 3);
  assert.equal(app.timers.size, 1);
  app.visibility('visible');
  assert.equal(app.timers.size, 1);
});

test('非表示で開いた場合も初回取得は行い定期同期は表示復帰まで待つ', () => {
  const app = setup('hidden');
  assert.equal(app.syncs, 1);
  assert.equal(app.timers.size, 0);
  app.visibility('visible');
  assert.equal(app.syncs, 2);
  assert.equal([...app.timers.values()][0].delay, 30_000);
});
