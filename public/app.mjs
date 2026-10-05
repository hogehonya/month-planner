import { FIELDS, LIMITS, DEFAULT_BASE, monthRange, fortnightRange, shiftDate, localDate, validateSlot, textLimit } from './model.mjs';
const $ = id => document.getElementById(id);
const API = '/.netlify/functions/planner';
const editingRequested = new URLSearchParams(location.search).get('edit') === '1';
let month = localDate().slice(0, 7), pin = '', editor = '', authenticated = false, base = DEFAULT_BASE;
let pendingSync = null, writeEpoch = 0, activeSlot = null, dialogBusy = false, dialogDirty = false, dialogComposing = false, dialogReturnFocus = null;
let loadSequence = 0, polling = false, lastSync = '';
const slots = new Map();
const cells = new Map();
let view = 'month', anchor = localDate(), selectedDate = localDate();
const dayButtons = new Map();
const dates = () => view === 'month' ? monthRange(month) : fortnightRange(anchor);
const formatTime = value => value ? new Date(value).toLocaleString('ja-JP') : '';
const fieldLabel = field => field === 'base' ? '時間割' : field === 'note' ? '備考' : base.slots[field.startsWith('slot1') ? 0 : 1].label;
async function request(body, query = '') {
  const response = await fetch(API + query, body ? { signal: AbortSignal.timeout(10000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, pin }) } : { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  let result; try { result = await response.json(); } catch { throw new Error('サーバーの応答を確認できません。再試行してください。'); }
  if (!response.ok) throw Object.assign(new Error(result.error || '通信に失敗しました。'), { status: response.status });
  return result;
}
function unsaved() { return !!activeSlot || dialogDirty || dialogBusy || [...cells.values()].some(cell => cell.dirty || cell.inflight || cell.composing); }
function status() {
  const list = [...cells.values()], failed = list.filter(cell => cell.error).length, waiting = list.filter(cell => cell.dirty || cell.inflight).length;
  $('status').textContent = failed ? `${failed}件を保存できませんでした。入力は保持しています。` : waiting ? `${waiting}件が未保存・保存中です。` : lastSync ? `同期済み · ${lastSync}` : '読み込み中…';
  $('retry').hidden = !list.some(cell => cell.dirty && !cell.inflight && !cell.composing);
}
function cellStatus(cell, message = '', state = '') { cell.message.textContent = message; cell.message.dataset.state = state; status(); }
function setMode() {
  $('auth').hidden = !editingRequested || authenticated;
  $('edit-link').hidden = editingRequested;
  $('logout').hidden = !authenticated;
  $('mode').textContent = authenticated ? `${editor}として編集中 · コマは保存ボタン、備考は自動保存` : '閲覧専用 · 3秒ごとに同期';
  for (const slot of slots.values()) slot.button.textContent = authenticated ? '見出し・内容を編集' : '編集する';
  for (const cell of cells.values()) { cell.input.hidden = !editingRequested; cell.input.readOnly = !authenticated; cell.display.hidden = editingRequested; }
}
function authExpired() { authenticated = false; pin = ''; $('pin').value = ''; $('auth-message').textContent = '認証が切れました。入力を保持しています。PINを入力し直してください。'; setMode(); if (activeSlot) { $('dialog-auth').hidden = false; $('dialog-save').disabled = true; } }
function buildMonth() {
  cells.clear(); slots.clear(); $('days').replaceChildren();
  const range = dates();
  if (!range.includes(selectedDate)) selectedDate = range[0];
  const [year, number] = month.split('-'); $('month-title').textContent = view === 'month' ? `${year}年${Number(number)}月` : `${range[0]} 〜 ${range.at(-1)}`;
  $('prev').textContent = view === 'month' ? '← 前月' : '← 前の2週間';
  $('next').textContent = view === 'month' ? '翌月 →' : '次の2週間 →';
  for (const mode of ['month', 'fortnight']) $(`view-${mode}`).setAttribute('aria-pressed', String(view === mode));
  dayButtons.clear(); $('calendar').replaceChildren();
  const blanks = new Date(`${range[0]}T12:00:00Z`).getUTCDay();
  for (let i = 0; i < blanks; i++) $('calendar').append(document.createElement('span'));
  for (const date of dates()) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const button = document.createElement('button'); button.type = 'button'; button.className = 'calendar-day';
    if (day === 0 || day === 6) button.classList.add('weekend');
    if (date === localDate()) { button.classList.add('is-today'); button.setAttribute('aria-current', 'date'); }
    const dayHeading = document.createElement('span'), number = document.createElement('span'), timetable = document.createElement('span'), summary = document.createElement('span');
    dayHeading.className = 'day-heading'; timetable.className = 'day-timetable';
    number.className = 'day-number'; number.textContent = Number(date.slice(-2)); summary.className = 'day-summary';
    dayHeading.append(number, timetable); button.append(dayHeading, summary); button.setAttribute('aria-label', date); button.onclick = () => selectDay(date);
    dayButtons.set(date, { button, timetable, summary }); $('calendar').append(button);
    const row = document.createElement('tr'); row.dataset.date = date; if (day === 0 || day === 6) row.classList.add('weekend'); if (date === localDate()) row.classList.add('is-today');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = `${Number(date.slice(-2))}日（${'日月火水木金土'[day]}）`;
    if (date === localDate()) { const badge = document.createElement('span'); badge.className = 'today-badge'; badge.textContent = '今日'; heading.append(badge); }
    const meta = document.createElement('div'); meta.className = 'meta'; heading.append(meta); row.append(heading);
    for (const field of FIELDS) {
      if (field !== 'note') {
        const td = document.createElement('td'), timetable = document.createElement('div'), title = document.createElement('div'), content = document.createElement('div'), button = document.createElement('button');
        td.dataset.label = fieldLabel(field); timetable.className = 'timetable'; title.className = 'slot-title'; content.className = 'slot-content'; button.type = 'button'; button.textContent = '編集する';
        const slot = { date, field, td, timetable, title, content, button, meta, titleValue: '', contentValue: '' };
        button.onclick = () => openSlot(slot); slots.set(`${date}:${field}`, slot); td.append(timetable, title, content, button); row.append(td); continue;
      }
      const td = document.createElement('td'), display = document.createElement('div'), input = document.createElement('textarea'), message = document.createElement('div');
      td.dataset.label = fieldLabel(field); display.className = 'cell-value'; message.className = 'cell-status'; input.rows = 3; input.setAttribute('aria-label', `${date} ${fieldLabel(field)}`); input.maxLength = LIMITS[field] * 2;
      const cell = { date, field, input, display, message, meta, version: 0, dirty: false, inflight: false, composing: false, error: '', timer: null };
      input.addEventListener('input', () => { cell.version++; cell.dirty = true; cell.error = ''; clearTimeout(cell.timer); cellStatus(cell, '未保存'); if (!cell.composing) schedule(cell); });
      input.addEventListener('compositionstart', () => { cell.composing = true; clearTimeout(cell.timer); });
      input.addEventListener('compositionend', () => { cell.composing = false; schedule(cell); });
      input.addEventListener('blur', () => { if (cell.dirty && !cell.error) schedule(cell); });
      cells.set(`${date}:${field}`, cell); td.append(display, input, message); row.append(td);
    }
    $('days').append(row);
  }
  for (let i = 0; i < (7 - (blanks + range.length) % 7) % 7; i++) $('calendar').append(document.createElement('span'));
  setMode(); selectDay(selectedDate, true);
}
function selectDay(date, initial = false) {
  if (!initial && unsaved()) { $('status').textContent = '未保存の入力があります。保存・再試行してから日付を移動してください。'; return; }
  selectedDate = date; $('detail-title').textContent = `${date} の予定`;
  for (const row of $('days').children) row.hidden = row.dataset.date !== date;
  for (const [key, day] of dayButtons) { day.button.setAttribute('aria-pressed', String(key === date)); }
}
function schedule(cell) { clearTimeout(cell.timer); if (!cell.error) cell.timer = setTimeout(() => save(cell), 500); }
async function save(cell) {
  if (!cell.dirty || cell.inflight || cell.composing || cell.error || !authenticated) return;
  const version = cell.version, value = cell.input.value;
  try { textLimit(value, LIMITS[cell.field], fieldLabel(cell.field)); } catch (error) { cell.error = error.message; cellStatus(cell, error.message, 'error'); return; }
  writeEpoch++; cell.inflight = true; cellStatus(cell, '保存中…');
  let succeeded = false;
  try {
    const result = await request({ action: 'save', editor_name: editor, entry_date: cell.date, field: cell.field, value });
    succeeded = true;
    if (cell.version === version) { cell.dirty = false; cell.display.textContent = value; paintDay(result.row); cellStatus(cell, result.history_saved === false ? '保存済み · 履歴同期待ち' : '保存済み', 'saved'); }
    cell.meta.textContent = `${result.row.last_editor} · ${formatTime(result.row.updated_at)}`;
  } catch (error) { cell.error = error.message; cellStatus(cell, error.message, 'error'); if (error.status === 401) authExpired(); }
  finally { writeEpoch++; cell.inflight = false; status(); if (succeeded && cell.dirty && !cell.composing) schedule(cell); }
}
function paintDay(row) {
  const day = dayButtons.get(row.entry_date);
  if (!day) return;
  const fixed = ['slot1', 'slot2'].map(field => row[field]).filter(Boolean);
  const parts = ['slot1', 'slot2'].map(field => row[field + '_title']).filter(Boolean);
  day.timetable.textContent = fixed.join(' / ');
  if (row.note) parts.push(row.note);
  day.summary.textContent = parts.join(' / ');
  day.button.setAttribute('aria-label', `${row.entry_date} ${[...fixed, ...parts].join(' / ') || '予定なし'}`);
}
function paint(data) {
  base = data.base;
  for (let i = 0; i < 2; i++) { const heading = $(`slot${i + 1}-heading`); heading.replaceChildren(document.createTextNode(base.slots[i].label)); const time = document.createElement('span'); time.className = 'slot-time'; time.textContent = base.slots[i].time; heading.append(time); }
  for (const row of data.entries) {
    paintDay(row);
    for (const field of FIELDS) {
      if (field !== 'note') { updateSlot(slots.get(`${row.entry_date}:${field}`), row); continue; }
      const cell = cells.get(`${row.entry_date}:${field}`); if (!cell) continue;
      cell.input.setAttribute('aria-label', `${row.entry_date} ${fieldLabel(field)}`);
      cell.input.parentElement.dataset.label = fieldLabel(field);
      if (!cell.dirty && !cell.inflight && !cell.composing && document.activeElement !== cell.input) { cell.input.value = row[field]; cell.display.textContent = row[field]; }
      cell.meta.textContent = row.last_editor ? `${row.last_editor} · ${formatTime(row.updated_at)}` : '';
    }
  }
  $('history').replaceChildren();
  for (const event of data.history) { const li = document.createElement('li'); li.textContent = `${formatTime(event.changed_at)} · ${event.editor_name} · ${event.entry_date || '共有設定'} · ${fieldLabel(event.field_name)}`; $('history').append(li); }
  if (!data.history.length) { const li = document.createElement('li'); li.textContent = 'まだ変更履歴はありません。'; $('history').append(li); }
  lastSync = new Date().toLocaleTimeString('ja-JP'); status();
}
async function sync() {
  if (pendingSync) return false;
  pendingSync = runSync();
  try { return await pendingSync; } finally { pendingSync = null; }
}
async function runSync() {
  polling = true; const sequence = loadSequence, epoch = writeEpoch; const range = dates();
  try { const data = await request(null, `?start=${range[0]}&end=${range.at(-1)}`); if (sequence === loadSequence && epoch === writeEpoch) paint(data); return sequence === loadSequence && epoch === writeEpoch; }
  catch (error) { if (sequence === loadSequence) $('status').textContent = `同期できません：${error.message}`; return false; }
  finally { polling = false; }
}
function changePeriod(offset, mode = view) {
  if (unsaved()) { $('status').textContent = '未保存の入力があります。保存・再試行してから表示を切り替えてください。'; return; }
  if (polling) return;
  if (mode !== view) { anchor = selectedDate; month = selectedDate.slice(0, 7); view = mode; }
  else if (offset === null) { anchor = localDate(); month = anchor.slice(0, 7); selectedDate = anchor; }
  else if (view === 'fortnight') anchor = shiftDate(dates()[0], offset * 14);
  else { const [year, number] = month.split('-').map(Number); month = localDate(new Date(year, number - 1 + offset, 1)).slice(0, 7); }
  loadSequence++; lastSync = ''; buildMonth(); sync();
}
$('prev').onclick = () => changePeriod(-1); $('next').onclick = () => changePeriod(1); $('today').onclick = () => changePeriod(null);
$('view-month').onclick = () => changePeriod(0, 'month'); $('view-fortnight').onclick = () => changePeriod(0, 'fortnight');
$('auth-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { editor = textLimit($('editor').value, 40, '編集者名', true).trim(); pin = $('pin').value; await request({ action: 'verify' }); authenticated = true; $('pin').value = ''; $('auth-message').textContent = ''; setMode(); status(); if ([...cells.values()].some(cell => cell.dirty)) $('status').textContent = '入力を保持しています。「未保存の予定を再試行」で保存できます。'; }
  catch (error) { pin = ''; $('auth-message').textContent = error.message; }
  finally { button.disabled = false; }
};
$('logout').onclick = () => { if (unsaved()) { $('status').textContent = '未保存の入力があります。保存・再試行してから編集を終了してください。'; return; } authenticated = false; pin = ''; setMode(); };
$('retry').onclick = () => { if (!authenticated) { $('auth-message').textContent = 'PINを入力し直してから再試行してください。'; $('auth').hidden = false; return; } for (const cell of cells.values()) if (cell.dirty && !cell.inflight) { cell.error = ''; save(cell); } };
function updateSlot(slot, row) {
  if (!slot) return;
  const info = base.slots[slot.field === 'slot1' ? 0 : 1];
  slot.td.dataset.label = info.label + (info.time ? `（${info.time}）` : '');
  slot.timetable.textContent = row[slot.field] || '時間割なし';
  slot.titleValue = row[slot.field + '_title']; slot.contentValue = row[slot.field + '_content'];
  slot.title.textContent = slot.titleValue; slot.content.textContent = slot.contentValue;
  slot.button.setAttribute('aria-label', `${slot.date} ${info.label}の見出し・内容を編集`);
  slot.meta.textContent = row.last_editor ? `${row.last_editor} · ${formatTime(row.updated_at)}` : '';
}
function openSlot(slot) {
  if (!authenticated) {
    if (!editingRequested) { location.href = '?edit=1'; return; }
    $('auth').hidden = false; $('auth-message').textContent = '編集するには編集者名とPINを入力してください。'; $('editor').focus(); return;
  }
  if (activeSlot) return;
  activeSlot = slot; dialogReturnFocus = slot.button; dialogDirty = false; dialogComposing = false;
  const info = base.slots[slot.field === 'slot1' ? 0 : 1];
  const period = slot.field === 'slot1' ? '午前' : '午後';
  $('dialog-heading').textContent = `${slot.date} ${period}${info.label === period ? '' : `（${info.label}）`}を編集`;
  $('dialog-timetable').textContent = `時間割：${slot.timetable.textContent}${info.time ? `（${info.time}）` : ''}`;
  $('slot-title').value = slot.titleValue; $('slot-content').value = slot.contentValue;
  $('dialog-message').textContent = ''; $('dialog-auth-message').textContent = ''; $('dialog-auth').hidden = true; $('dialog-pin').value = ''; $('dialog-save').disabled = false;
  $('slot-dialog').showModal(); $('slot-title').focus();
}
function cancelDialog() { if (!dialogBusy) $('slot-dialog').close(); }
$('dialog-close').onclick = cancelDialog; $('dialog-cancel').onclick = cancelDialog;
$('slot-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelDialog(); });
$('slot-dialog').addEventListener('close', () => { activeSlot = null; dialogDirty = false; dialogComposing = false; $('dialog-pin').value = ''; dialogReturnFocus?.focus(); dialogReturnFocus = null; });
for (const id of ['slot-title', 'slot-content']) {
  $(id).addEventListener('input', () => { dialogDirty = true; });
  $(id).addEventListener('compositionstart', () => { dialogComposing = true; });
  $(id).addEventListener('compositionend', () => { dialogComposing = false; });
}
function setDialogBusy(busy) {
  dialogBusy = busy;
  for (const id of ['slot-title', 'slot-content', 'dialog-close', 'dialog-cancel', 'dialog-verify', 'dialog-pin']) $(id).disabled = busy;
  $('dialog-save').disabled = busy || !authenticated;
}
$('slot-form').onsubmit = async event => {
  event.preventDefault(); if (!activeSlot || dialogBusy || dialogComposing || !authenticated) return;
  const slot = activeSlot, title = $('slot-title').value, content = $('slot-content').value;
  try { validateSlot(slot.field, title, content); } catch (error) { $('dialog-message').textContent = error.message; return; }
  writeEpoch++; setDialogBusy(true); $('dialog-message').textContent = '保存中…';
  try {
    const result = await request({ action: 'save_slot', editor_name: editor, entry_date: slot.date, slot: slot.field, title, content });
    updateSlot(slot, result.row); paintDay(result.row); dialogDirty = false; $('slot-dialog').close();
    $('status').textContent = result.history_saved === false ? 'コマを保存しました。履歴は同期待ちです。' : 'コマを保存しました。';
  } catch (error) { $('dialog-message').textContent = `${error.message} 入力は保持しています。`; if (error.status === 401) authExpired(); }
  finally { writeEpoch++; setDialogBusy(false); }
};
$('dialog-verify').onclick = async () => {
  if (dialogBusy) return;
  pin = $('dialog-pin').value; setDialogBusy(true); $('dialog-auth-message').textContent = '認証中…';
  try { await request({ action: 'verify' }); authenticated = true; $('dialog-pin').value = ''; $('dialog-auth').hidden = true; setMode(); $('dialog-message').textContent = '再認証しました。「保存」を押してください。'; }
  catch (error) { pin = ''; $('dialog-auth-message').textContent = error.message; }
  finally { setDialogBusy(false); }
};
window.addEventListener('beforeunload', event => { if (unsaved()) { event.preventDefault(); event.returnValue = ''; } });
buildMonth(); sync(); setInterval(() => sync(), 3000);
