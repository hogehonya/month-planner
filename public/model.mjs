export const FIELDS = ['slot1', 'slot2', 'note'];
export const LIMITS = { slot1: 1200, slot2: 1200, note: 3000 };
export const SLOTS = ['slot1', 'slot2'];
export const SLOT_LIMITS = { title: 120, content: 3000 };
export function validateSlot(slot, title, content) {
  if (!SLOTS.includes(slot)) throw new Error('編集対象のコマを確認してください。');
  return { [slot + '_title']: textLimit(title, SLOT_LIMITS.title, '見出し'), [slot + '_content']: textLimit(content, SLOT_LIMITS.content, '内容') };
}
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DEFAULT_BASE = { slots: [{ label: '1コマ目', time: '' }, { label: '2コマ目', time: '' }], weekdays: {}, dates: {} };

export function parseDate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw new Error('日付はYYYY-MM-DDで指定してください。');
  const date = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('存在する日付を指定してください。');
  return date;
}

export function dateRange(start, end) {
  const first = parseDate(start), last = parseDate(end);
  const count = Math.round((last - first) / 86400000) + 1;
  if (count < 1 || count > 31) throw new Error('期間は1〜31日で指定してください。');
  return Array.from({ length: count }, (_, i) => new Date(first.getTime() + i * 86400000).toISOString().slice(0, 10));
}

export function monthRange(month) {
  if (typeof month !== 'string' || !/^[1-9]\d{3}-\d{2}$/.test(month)) throw new Error('年月を指定してください。');
  const first = parseDate(month + '-01');
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
  return dateRange(month + '-01', last.toISOString().slice(0, 10));
}

export function shiftDate(value, days) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function fortnightRange(value) {
  const day = parseDate(value).getUTCDay();
  const start = shiftDate(value, -day);
  return dateRange(start, shiftDate(start, 13));
}

export function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function textLimit(value, max, label, required = false) {
  if (typeof value !== 'string' || [...value].length > max || (required && !value.trim())) throw new Error(`${label}は${required ? '1〜' : ''}${max}文字以内で指定してください。`);
  return value;
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label}の項目または形式が正しくありません。`);
}

function schedule(value) {
  object(value, FIELDS, '予定');
  const clean = {};
  for (const field of FIELDS) if (Object.hasOwn(value, field)) clean[field] = textLimit(value[field], LIMITS[field], field);
  return clean;
}

export function validateBase(value) {
  object(value, ['slots', 'weekdays', 'dates'], '時間割');
  if (!Array.isArray(value.slots) || value.slots.length !== 2) throw new Error('slotsは2コマ分を指定してください。');
  const slots = value.slots.map(slot => {
    object(slot, ['label', 'time'], 'コマ');
    return { label: textLimit(slot.label, 20, 'コマ名', true), time: textLimit(slot.time ?? '', 40, '時間') };
  });
  const weekdays = {}, dates = {};
  object(value.weekdays ?? {}, WEEKDAYS, '曜日');
  for (const [key, row] of Object.entries(value.weekdays ?? {})) weekdays[key] = schedule(row);
  const rawDates = value.dates ?? {};
  if (!rawDates || typeof rawDates !== 'object' || Array.isArray(rawDates) || Object.keys(rawDates).length > 366) throw new Error('datesは366日以内のオブジェクトで指定してください。');
  for (const [key, row] of Object.entries(rawDates)) { parseDate(key); dates[key] = schedule(row); }
  return { slots, weekdays, dates };
}

export function effectiveEntry(date, raw, base = DEFAULT_BASE) {
  const weekday = WEEKDAYS[parseDate(date).getUTCDay()];
  const fields = { slot1: '', slot2: '', note: '', ...base.weekdays[weekday], ...base.dates[date] };
  for (const field of FIELDS) if (raw && Object.hasOwn(raw, field)) fields[field] = raw[field];
  const details = {};
  for (const slot of SLOTS) for (const field of ['title', 'content']) details[slot + '_' + field] = raw?.[slot + '_' + field] ?? '';
  return { entry_date: date, ...fields, ...details, last_editor: raw?.last_editor ?? '', updated_at: raw?.updated_at ?? '', overridden_fields: FIELDS.filter(field => raw && Object.hasOwn(raw, field)) };
}

export const IMPORT_FIELDS = ['slot1_title', 'slot1_content', 'slot2_title', 'slot2_content', 'note'];
export function validateImport(value) {
  object(value, ['entries'], '追加予定JSON');
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 31) throw new Error('追加予定は1〜31日で指定してください。');
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144) throw new Error('JSONは256KiB以内にしてください。');
  const seen = new Set();
  return value.entries.map(row => {
    object(row, ['entry_date', ...IMPORT_FIELDS], '追加予定'); parseDate(row.entry_date);
    if (seen.has(row.entry_date)) throw new Error('同じ日付を重複して指定できません。');
    seen.add(row.entry_date);
    const clean = { entry_date: row.entry_date };
    for (const field of IMPORT_FIELDS) if (Object.hasOwn(row, field)) clean[field] = textLimit(row[field], field.endsWith('_title') ? SLOT_LIMITS.title : SLOT_LIMITS.content, field);
    if (Object.keys(clean).length === 1) throw new Error('各日の更新項目を1つ以上指定してください。');
    return clean;
  });
}

export function calendarWeeks(dates) {
  const weeks = [];
  for (const date of dates) {
    if (!weeks.length || parseDate(date).getUTCDay() === 0) weeks.push([]);
    weeks.at(-1).push(date);
  }
  return weeks;
}

export function calendarWeekWindows(dates) {
  const weeks = calendarWeeks(dates);
  return weeks.map((week, index) => [...week, ...(weeks[index + 1] ?? [])]);
}
