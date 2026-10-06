import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { calendarWeekWindows, fortnightRange, monthRange } from '../public/model.mjs';

function load(view, range) {
  const picker = { children: [], hidden: false, replaceChildren() { this.children = []; }, append(button) { this.children.push(button); } };
  const heading = {};
  const dayButtons = new Map(range.map(date => [date, { button: { classList: { toggle(name, hidden) { this.hidden = hidden; } } } }]));
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function buildWeeks()'), source.indexOf('function renderComments()'));
  const context = {
    view, dates: () => range, calendarWeekWindows, activeWeekStart: null, dayButtons,
    $: id => id === 'week-picker' ? picker : heading,
    document: { createElement: () => ({ dataset: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }) },
  };
  context.selectDay = (date, initial, start) => { context.activeWeekStart = start; context.showWeek(date); };
  runInNewContext(functions, context);
  return { context, picker, heading, visible: () => [...dayButtons].filter(([, day]) => !day.button.classList.hidden).map(([date]) => date) };
}

test('2週間表示は週ボタンを隠し、後半の日付を選んでも年をまたぐ14日間を保つ', () => {
  const range = fortnightRange('2027-01-01');
  const app = load('fortnight', range);
  app.context.buildWeeks();
  assert.equal(app.picker.hidden, true);
  assert.equal(app.picker.children.length, 0);
  for (const date of range) {
    app.context.showWeek(date);
    assert.deepEqual(app.visible(), range);
    assert.equal(app.heading.textContent, `${range[0]} 〜 ${range.at(-1)}`);
  }
});

test('月間へ戻ると月初からの週番号を復元し、翌週の日付選択では表示を維持する', () => {
  const range = monthRange('2026-08');
  const app = load('month', range);
  app.context.buildWeeks();
  assert.equal(app.picker.hidden, false);
  assert.deepEqual(app.picker.children.map(button => button.textContent), ['1週', '2週', '3週', '4週', '5週', '6週']);
  app.picker.children[0].onclick();
  app.context.showWeek('2026-08-07');
  assert.deepEqual(app.visible(), range.slice(0, 8));
  assert.equal(app.picker.children[0].attributes['aria-pressed'], 'true');
  app.picker.children[5].onclick();
  assert.deepEqual(app.visible(), range.slice(-2));
  app.context.view = 'fortnight';
  app.context.buildWeeks();
  app.context.view = 'month';
  app.context.buildWeeks();
  assert.equal(app.picker.hidden, false);
  assert.equal(app.picker.children.length, 6);
});
