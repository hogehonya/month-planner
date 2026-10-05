import test from 'node:test';
import assert from 'node:assert/strict';
import { monthRange, validateBase, effectiveEntry, DEFAULT_BASE, dateRange, fortnightRange, shiftDate } from '../public/model.mjs';

test('月の日数・うるう年・年末を正しく生成する', () => {
  assert.equal(monthRange('2026-02').length, 28);
  assert.equal(monthRange('2028-02').length, 29);
  assert.equal(monthRange('2026-10').length, 31);
  assert.equal(monthRange('2026-12').at(-1), '2026-12-31');
  assert.throws(() => dateRange('2026-02-30', '2026-03-01'));
  assert.throws(() => dateRange('2026-01-01', '2026-03-01'));
});

test('個別編集、日付例外、曜日の順に合成し、明示的な空欄を守る', () => {
  const base = validateBase({ ...DEFAULT_BASE, weekdays: { mon: { slot1: '定例', slot2: '午後' } }, dates: { '2026-10-05': { slot1: '例外' } } });
  const row = effectiveEntry('2026-10-05', { slot1: '', note: '個別' }, base);
  assert.equal(row.slot1, '');
  assert.equal(row.slot2, '午後');
  assert.equal(row.note, '個別');
  assert.equal(effectiveEntry('2026-10-05', null, base).slot1, '例外');
  assert.equal(effectiveEntry('2026-10-12', null, base).slot1, '定例');
});

test('不正な時間割・未知のキー・型・過大入力を拒否する', () => {
  for (const patch of [
    { slots: [] }, { weekdays: { monday: {} } }, { weekdays: { mon: { slot3: 'x' } } },
    { dates: { '2026-02-30': {} } }, { weekdays: { mon: { slot1: 'a'.repeat(1201) } } },
    { weekdays: [] }, { unknown: true }, { slots: [{ label: '' }, { label: 'x' }] },
  ]) assert.throws(() => validateBase({ ...DEFAULT_BASE, ...patch }));
  assert.throws(() => validateBase(JSON.parse('{"slots":[{"label":"a"},{"label":"b"}],"weekdays":{"__proto__":{}}}')));
});

test('時間割と追加見出し・内容を独立して返し、既存データを移行せず読む', () => {
  const raw = { slot1: '既存', slot1_title: '見出し', slot1_content: '内容', note: '備考' };
  const row = effectiveEntry('2026-10-05', raw, DEFAULT_BASE);
  assert.equal(row.slot1, '既存'); assert.equal(row.slot1_title, '見出し'); assert.equal(row.slot1_content, '内容');
  assert.equal(row.slot2_title, ''); assert.equal(row.slot2_content, '');
  assert.deepEqual(raw, { slot1: '既存', slot1_title: '見出し', slot1_content: '内容', note: '備考' });
});

test('2週間は月曜から日曜まで14日で、月年と閏日をまたぐ', () => {
  assert.equal(fortnightRange('2026-10-11')[0], '2026-10-05');
  assert.equal(fortnightRange('2026-10-05').at(-1), '2026-10-18');
  assert.equal(fortnightRange('2027-01-01')[0], '2026-12-28');
  assert.equal(fortnightRange('2028-02-29').length, 14);
  assert.equal(shiftDate('2026-12-28', 14), '2027-01-11');
  assert.equal(shiftDate('2027-01-11', -14), '2026-12-28');
  assert.throws(() => fortnightRange('2026-02-30'));
});
