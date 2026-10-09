import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { monthWeekWindows, monthCalendarRange } from '../public/model.mjs';

function load(range) {
  const picker = { children: [], hidden: false, replaceChildren() { this.children = []; }, append(button) { this.children.push(button); } };
  const heading = {};
  const dayButtons = new Map(range.map(date => [date, { button: { classList: { toggle(name, hidden) { this.hidden = hidden; } } } }]));
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function buildWeeks()'), source.indexOf('function renderComments()'));
  const context = {
    month: '2026-08', monthWeekWindows, dates: () => range, activeWeekStart: null, dayButtons,
    $: id => id === 'week-picker' ? picker : heading,
    document: { createElement: () => ({ dataset: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }) },
  };
  context.selectDay = (date, initial, start) => { context.activeWeekStart = start; context.showWeek(date); };
  runInNewContext(functions, context);
  return { context, picker, heading, visible: () => [...dayButtons].filter(([, day]) => !day.button.classList.hidden).map(([date]) => date) };
}

test('月初からの週番号を表示し、翌週の日付選択では表示を維持する', () => {
  const range = monthCalendarRange('2026-08');
  const app = load(range);
  app.context.buildWeeks();
  assert.equal(app.picker.hidden, false);
  assert.deepEqual(app.picker.children.map(button => button.textContent), ['7月4週', '1週', '2週', '3週', '4週', '5週', '6週']);
  assert.equal(app.picker.children[0].attributes['aria-label'], '7月4週/8月1週 2026-07-19 〜 2026-08-01');
  assert.equal(app.picker.children[1].attributes['aria-label'], '8月1週/8月2週 2026-07-26 〜 2026-08-08');
  app.picker.children[0].onclick();
  app.context.showWeek('2026-07-30');
  assert.deepEqual(app.visible(), range.slice(0, 14));
  assert.equal(app.picker.children[0].attributes['aria-pressed'], 'true');
  app.picker.children[6].onclick();
  assert.deepEqual(app.visible(), range.slice(-14));
  app.context.buildWeeks();
  assert.equal(app.picker.hidden, false);
  assert.equal(app.picker.children.length, 7);
});


test('前後月は重複日を保持せず対象月の1日を選び、未送信入力は移動を止める', () => {
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const navigation = source.slice(source.indexOf('function changePeriod('), source.indexOf("$('prev').onclick"));
  let dirty = false, builds = 0, syncs = 0;
  const status = {};
  const context = {
    month: '2026-10', selectedDate: '2026-09-30',
    polling: false, loadSequence: 0, lastSync: '', unsaved: () => dirty,
    $: () => status, localDate: date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'),
    buildMonth: () => builds++, sync: () => syncs++,
  };
  runInNewContext(navigation, context);
  context.changePeriod(-1);
  assert.equal(context.month, '2026-09');
  assert.equal(context.selectedDate, '2026-09-01');
  context.changePeriod(1);
  assert.equal(context.selectedDate, '2026-10-01');
  dirty = true;
  context.changePeriod(1);
  assert.equal(context.month, '2026-10');
  assert.equal(builds, 2);
  assert.equal(syncs, 2);
  assert.match(status.textContent, /未保存/);
});


test('前提・現状・一手は共有予定の一般的な案内を表示する',()=> {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="view-(?:month|fortnight)"/);
  for(const value of ['前提','現状','一手','基本予定と追加予定を共有','日付を選ぶと予定','見出し・内容・備考を記録']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /農業祭|1,117|228,100/);
  const source=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/view-fortnight|view-month/);
});
