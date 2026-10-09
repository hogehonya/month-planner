import { FIELDS, LIMITS, DEFAULT_BASE, monthCalendarRange, monthWeekWindows, localDate, validateSlot, textLimit, validateImport, PHOTO_LIMIT, PHOTO_MIMES } from './model.mjs';
const $ = id => document.getElementById(id);
const API = '/.netlify/functions/planner';
const editingRequested = new URLSearchParams(location.search).get('edit') === '1';
let month = localDate().slice(0, 7), pin = '', editor = '', authenticated = false, base = DEFAULT_BASE;
let pendingSync = null, writeEpoch = 0, activeSlot = null, dialogBusy = false, dialogDirty = false, dialogComposing = false, dialogReturnFocus = null;
let loadSequence = 0, polling = false, lastSync = '';
let photoFile = null;
let importBusy = false, importPreview = null, importVersion = 0, importComposing = false, importReading = false;
const slots = new Map();
const cells = new Map();
let selectedDate = localDate(), activeWeekStart = null;
const dayButtons = new Map();
const commentsByDate = new Map();
let commentBusy = false, commentComposing = false, commentId = null, commentAttempt = null;
const dates = () => monthCalendarRange(month);
const formatTime = value => value ? new Date(value).toLocaleString('ja-JP') : '';
const fieldLabel = field => field === 'base' ? '時間割' : field === 'note' ? '備考' : base.slots[field.startsWith('slot1') ? 0 : 1].label;
async function request(body, query = '') {
  let options;
  if (body?.action === 'upload_photo') {
    query = '?' + new URLSearchParams({ action: 'upload_photo', entry_date: body.entry_date, slot: body.slot });
    options = { signal: AbortSignal.timeout(60000), method: 'POST', headers: { 'Content-Type': body.file.type, 'X-Edit-Pin': pin, 'X-Editor-Name': encodeURIComponent(editor) }, body: body.file };
  } else options = body ? { signal: AbortSignal.timeout(body.action === 'import_entries' ? 60000 : 10000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, pin }) } : { cache: 'no-store', signal: AbortSignal.timeout(10000) };
  const response = await fetch(API + query, options);
  let result; try { result = await response.json(); } catch { throw new Error('サーバーの応答を確認できません。再試行してください。'); }
  if (!response.ok) throw Object.assign(new Error(result.error || '通信に失敗しました。'), { status: response.status });
  return result;
}
function unsaved() { return commentBusy || commentComposing || !!$('comment-content').value || importBusy || !!activeSlot || dialogDirty || dialogBusy || [...cells.values()].some(cell => cell.dirty || cell.inflight || cell.composing); }
function status() {
  const list = [...cells.values()], failed = list.filter(cell => cell.error).length, waiting = list.filter(cell => cell.dirty || cell.inflight).length;
  $('status').textContent = failed ? `${failed}件を保存できませんでした。入力は保持しています。` : waiting ? `${waiting}件が未保存・保存中です。` : lastSync ? `同期済み · ${lastSync}` : '読み込み中…';
  $('retry').hidden = !list.some(cell => cell.dirty && !cell.inflight && !cell.composing);
}
function cellStatus(cell, message = '', state = '') { cell.message.textContent = message; cell.message.dataset.state = state; status(); }
function setMode() {
  $('comment-form').hidden = !editingRequested;
  $('comment-content').readOnly = !authenticated || commentBusy || importBusy;
  $('comment-submit').disabled = !authenticated || commentBusy || importBusy;
  $('import-panel').hidden = !editingRequested;
  setImportControls();
  $('auth').hidden = !editingRequested || authenticated;
  $('edit-link').hidden = editingRequested;
  $('logout').hidden = !authenticated;
  $('mode').textContent = authenticated ? `${editor}として編集中 · コマは保存ボタン、備考は自動保存` : '閲覧専用 · 3秒ごとに同期';
  for (const slot of slots.values()) { slot.button.textContent = authenticated ? '見出し・内容を編集' : '編集する'; slot.button.disabled = importBusy; }
  for (const cell of cells.values()) { cell.input.hidden = !editingRequested; cell.input.readOnly = !authenticated || importBusy; cell.display.hidden = editingRequested; }
}
function authExpired() { authenticated = false; pin = ''; $('pin').value = ''; $('auth-message').textContent = '認証が切れました。入力を保持しています。PINを入力し直してください。'; setMode(); if (activeSlot) { $('dialog-auth').hidden = false; $('dialog-save').disabled = true; $('photo-save').disabled = true; } }
function buildMonth() {
  cells.clear(); slots.clear(); $('days').replaceChildren();
  const range = dates();
  if (!range.includes(selectedDate)) selectedDate = month + '-01';
  commentsByDate.clear();
  const [year, number] = month.split('-'); $('month-title').textContent = `${year}年${Number(number)}月`;
  dayButtons.clear(); $('calendar').replaceChildren();
  const blanks = new Date(`${range[0]}T12:00:00Z`).getUTCDay();
  for (let i = 0; i < blanks; i++) $('calendar').append(document.createElement('span'));
  for (const date of dates()) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const button = document.createElement('button'); button.type = 'button'; button.className = 'calendar-day';
    if (day === 0 || day === 6) button.classList.add('weekend');
    const outsideMonth = date.slice(0, 7) !== month;
    if (outsideMonth) button.classList.add('outside-month');
    if (date === localDate()) { button.classList.add('is-today'); button.setAttribute('aria-current', 'date'); }
    const dayHeading = document.createElement('span'), number = document.createElement('span'), timetable = document.createElement('span'), summary = document.createElement('span');
    dayHeading.className = 'day-heading'; timetable.className = 'day-timetable';
    number.className = 'day-number'; number.textContent = outsideMonth ? `${Number(date.slice(5, 7))}/${Number(date.slice(-2))}` : Number(date.slice(-2));
    const weekday = document.createElement('span'); weekday.className = 'day-weekday'; weekday.textContent = `（${'日月火水木金土'[day]}）`; number.append(weekday);
    summary.className = 'day-summary';
    dayHeading.append(number, timetable); button.append(dayHeading, summary); button.setAttribute('aria-label', date); button.onclick = () => { if (selectDay(date) && matchMedia('(max-width:600px)').matches) $('detail-title').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    dayButtons.set(date, { button, timetable, summary }); $('calendar').append(button);
    const row = document.createElement('tr'); row.dataset.date = date; if (day === 0 || day === 6) row.classList.add('weekend'); if (date === localDate()) row.classList.add('is-today');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = `${Number(date.slice(-2))}日（${'日月火水木金土'[day]}）`;
    if (date === localDate()) { const badge = document.createElement('span'); badge.className = 'today-badge'; badge.textContent = '今日'; heading.append(badge); }
    const meta = document.createElement('div'); meta.className = 'meta'; heading.append(meta); row.append(heading);
    for (const field of FIELDS) {
      if (field !== 'note') {
        const td = document.createElement('td'), timetable = document.createElement('div'), title = document.createElement('div'), content = document.createElement('div'), image = document.createElement('img'), button = document.createElement('button');
        image.className = 'slot-photo'; image.hidden = true; image.loading = 'lazy';
        td.dataset.label = fieldLabel(field); timetable.className = 'timetable'; title.className = 'slot-title'; content.className = 'slot-content'; button.type = 'button'; button.textContent = '編集する';
        const slot = { date, field, td, timetable, title, content, image, button, meta, titleValue: '', contentValue: '' };
        button.onclick = () => openSlot(slot); slots.set(`${date}:${field}`, slot); td.append(timetable, title, content, image, button); row.append(td); continue;
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
  activeWeekStart = null; buildWeeks(); setMode(); selectDay(selectedDate, true);
}
function selectDay(date, initial = false, weekStart = null) {
  if (!initial && unsaved()) { $('status').textContent = '未保存の入力があります。保存・再試行してから日付を移動してください。'; return; }
  const changed = date !== selectedDate;
  if (changed) { loadSequence++; commentsByDate.delete(date); $('comment-message').textContent = ''; }
  if (weekStart) activeWeekStart = weekStart;
  selectedDate = date; showWeek(date); renderComments(); $('detail-title').textContent = `${date} の予定`;
  for (const row of $('days').children) row.hidden = row.dataset.date !== date;
  for (const [key, day] of dayButtons) { day.button.setAttribute('aria-pressed', String(key === date)); }
  if (!initial && changed) sync();
  return true;
}
function schedule(cell) { clearTimeout(cell.timer); if (!cell.error) cell.timer = setTimeout(() => save(cell), 500); }
async function save(cell) {
  if (importBusy || !cell.dirty || cell.inflight || cell.composing || cell.error || !authenticated) return;
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
    if (Object.hasOwn(row, 'comments')) commentsByDate.set(row.entry_date, row.comments);
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
  renderComments();
  $('history').replaceChildren();
  for (const event of data.history) { const li = document.createElement('li'); li.textContent = `${formatTime(event.changed_at)} · ${event.editor_name} · ${event.entry_date || '共有設定'} · ${fieldLabel(event.field_name)}`; $('history').append(li); }
  if (!data.history.length) { const li = document.createElement('li'); li.textContent = 'まだ変更履歴はありません。'; $('history').append(li); }
  lastSync = new Date().toLocaleTimeString('ja-JP'); status();
}
async function sync() {
  if (importBusy || pendingSync) return false;
  const syncedSelection = selectedDate;
  pendingSync = runSync();
  try { return await pendingSync; } finally { pendingSync = null; if (syncedSelection !== selectedDate) sync(); }
}
async function runSync() {
  polling = true; const sequence = loadSequence, epoch = writeEpoch; const range = dates();
  try { const data = await request(null, `?start=${range[0]}&end=${range.at(-1)}&comment_date=${selectedDate}`); if (sequence === loadSequence && epoch === writeEpoch) paint(data); return sequence === loadSequence && epoch === writeEpoch; }
  catch (error) { if (sequence === loadSequence) $('status').textContent = `同期できません：${error.message}`; return false; }
  finally { polling = false; }
}
function changePeriod(offset) {
  if (unsaved()) { $('status').textContent = '未保存の入力があります。保存・再試行してから表示を切り替えてください。'; return; }
  if (polling) return;
  if (offset === null) { selectedDate = localDate(); month = selectedDate.slice(0, 7); }
  else { const [year, number] = month.split('-').map(Number); month = localDate(new Date(year, number - 1 + offset, 1)).slice(0, 7); selectedDate = month + '-01'; }
  loadSequence++; lastSync = ''; buildMonth(); sync();
}
$('prev').onclick = () => changePeriod(-1); $('next').onclick = () => changePeriod(1); $('today').onclick = () => changePeriod(null);
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
  slot.photo = row[slot.field + '_photo'];
  showPhoto(slot.image, slot.photo, `${slot.date} ${slot.field === 'slot1' ? '午前' : '午後'}の写真`);
  slot.button.setAttribute('aria-label', `${slot.date} ${info.label}の見出し・内容を編集`);
  slot.meta.textContent = row.last_editor ? `${row.last_editor} · ${formatTime(row.updated_at)}` : '';
}
function openSlot(slot) {
  if (importBusy) return;
  if (!authenticated) {
    if (!editingRequested) { location.href = '?edit=1'; return; }
    $('auth').hidden = false; $('auth-message').textContent = '編集するには編集者名とPINを入力してください。'; $('editor').focus(); return;
  }
  if (activeSlot) return;
  activeSlot = slot; dialogReturnFocus = slot.button; dialogDirty = false; dialogComposing = false; photoFile = null; $('slot-photo-file').value = ''; $('photo-message').textContent = '';
  showPhoto($('dialog-photo'), slot.photo, `${slot.date} ${slot.field === 'slot1' ? '午前' : '午後'}の写真`); $('photo-save').disabled = true;
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
$('slot-dialog').addEventListener('close', () => { activeSlot = null; photoFile = null; $('slot-photo-file').value = ''; dialogDirty = false; dialogComposing = false; $('dialog-pin').value = ''; dialogReturnFocus?.focus(); dialogReturnFocus = null; });
for (const id of ['slot-title', 'slot-content']) {
  $(id).addEventListener('input', () => { dialogDirty = true; });
  $(id).addEventListener('compositionstart', () => { dialogComposing = true; });
  $(id).addEventListener('compositionend', () => { dialogComposing = false; });
}
function setDialogBusy(busy) {
  dialogBusy = busy;
  for (const id of ['slot-title', 'slot-content', 'dialog-close', 'dialog-cancel', 'dialog-verify', 'dialog-pin', 'slot-photo-file']) $(id).disabled = busy;
  $('dialog-save').disabled = busy || !authenticated;
  $('photo-save').disabled = busy || !authenticated || !photoFile;
}
$('slot-form').onsubmit = async event => {
  event.preventDefault(); if (!activeSlot || dialogBusy || dialogComposing || !authenticated) return;
  if (photoFile) { $('dialog-message').textContent = '選択した写真を「写真を保存」で保存してから見出し・内容を保存してください。'; return; }
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
function showPhoto(image, photo, alt) {
  image.hidden = !photo; image.alt = alt;
  if (photo) { if (image.getAttribute('src') !== photo.url) image.src = photo.url; }
  else image.removeAttribute('src');
}
$('slot-photo-file').onchange = () => {
  if (dialogBusy) return;
  const file = $('slot-photo-file').files[0]; photoFile = null;
  if (file) {
    if (!PHOTO_MIMES.includes(file.type) || !file.size || file.size > PHOTO_LIMIT) {
      $('photo-message').textContent = 'JPEG・PNG・WebP、1枚2MiB以内の写真を選んでください。'; $('slot-photo-file').value = '';
    } else { photoFile = file; dialogDirty = true; $('photo-message').textContent = `${file.name}を選択しました。「写真を保存」で共有します。`; }
  }
  $('photo-save').disabled = !photoFile || !authenticated;
};
$('photo-save').onclick = async () => {
  if (!activeSlot || !photoFile || dialogBusy || dialogComposing || !authenticated) return;
  const slot = activeSlot, file = photoFile;
  writeEpoch++; setDialogBusy(true); $('photo-message').textContent = '写真を保存中…';
  try {
    const result = await request({ action: 'upload_photo', entry_date: slot.date, slot: slot.field, file });
    updateSlot(slot, result.row); showPhoto($('dialog-photo'), slot.photo, `${slot.date} ${slot.field === 'slot1' ? '午前' : '午後'}の写真`);
    photoFile = null; $('slot-photo-file').value = '';
    $('photo-message').textContent = result.history_saved === false ? '写真は保存済みです。履歴は同期待ちです。' : '写真を保存しました。見出し・内容の入力は保持しています。';
  } catch (error) {
    $('photo-message').textContent = `${error.message} 画面の写真と選択ファイルを保持しています。通信が途切れた場合は保存結果が未確認です。同じ写真を再送できます。`;
    if (error.status === 401) authExpired();
  } finally { writeEpoch++; setDialogBusy(false); }
};
const importLabels = { slot1_title: '午前の見出し', slot1_content: '午前の内容', slot2_title: '午後の見出し', slot2_content: '午後の内容', note: '備考' };
function setImportControls() {
  for (const id of ['import-json', 'import-file', 'import-preview-button']) $(id).disabled = importBusy || importReading;
  $('import-submit').disabled = importBusy || importReading || importComposing || !authenticated || !importPreview;
}
function invalidateImport() {
  importVersion++; importPreview = null; $('import-preview').replaceChildren(); $('import-results').replaceChildren();
  $('import-message').textContent = '入力を検証して更新値を確認してください。'; setImportControls();
}
$('import-json').addEventListener('input', invalidateImport);
$('import-json').addEventListener('compositionstart', () => { importComposing = true; invalidateImport(); });
$('import-json').addEventListener('compositionend', () => { importComposing = false; setImportControls(); });
$('import-file').onchange = async () => {
  const file = $('import-file').files[0]; if (!file || importBusy) return;
  invalidateImport(); const version = importVersion; importReading = true; setImportControls();
  try {
    if (file.size > 262144) throw new Error('JSONは256KiB以内にしてください。');
    const text = await file.text(); if (version !== importVersion) return;
    $('import-json').value = text; $('import-message').textContent = 'ファイルを読み込みました。「検証・プレビュー」を押してください。';
  } catch (error) { if (version === importVersion) $('import-message').textContent = error.message; }
  finally { importReading = false; $('import-file').value = ''; setImportControls(); }
};
$('import-preview-button').onclick = () => {
  if (importBusy || importReading || importComposing) return;
  invalidateImport();
  try {
    const source = $('import-json').value;
    if (new TextEncoder().encode(source).length > 262144) throw new Error('JSONは256KiB以内にしてください。');
    let value; try { value = JSON.parse(source); } catch { throw new Error('JSONの形式を確認してください。'); }
    const entries = validateImport(value);
    importPreview = { source, entries };
    for (const row of entries) {
      const list = document.createElement('dl'), heading = document.createElement('dt'); heading.textContent = row.entry_date; list.append(heading);
      for (const [field, value] of Object.entries(row)) {
        if (field === 'entry_date') continue;
        const label = document.createElement('dt'), content = document.createElement('dd');
        label.textContent = importLabels[field]; content.textContent = value === '' ? '（空欄に更新）' : value; list.append(label, content);
      }
      $('import-preview').append(list);
    }
    $('import-message').textContent = `${entries.length}日分を検証しました。表示された項目の既存値をこの内容で更新します。`;
  } catch (error) { $('import-message').textContent = error.message; }
  setImportControls();
};
$('import-submit').onclick = async () => {
  if (importBusy || importReading || importComposing || !importPreview) return;
  if (!authenticated) { $('auth-message').textContent = 'PINを入力し直してください。'; $('auth').hidden = false; return; }
  if (unsaved()) { $('import-message').textContent = '未保存の日別入力を保存し、コマのダイアログを閉じてから取り込んでください。'; return; }
  if (importPreview.source !== $('import-json').value) { invalidateImport(); return; }
  const body = { action: 'import_entries', editor_name: editor, entries: importPreview.entries };
  if (new TextEncoder().encode(JSON.stringify({ ...body, pin })).length > 262144) { $('import-message').textContent = '送信するJSONは256KiB以内にしてください。項目を減らしてください。'; return; }
  importBusy = true; writeEpoch++; setMode(); $('import-message').textContent = '取り込み中…'; $('import-results').replaceChildren();
  try {
    if (pendingSync) await pendingSync;
    const result = await request(body);
    let saved = 0;
    for (const row of result.results) {
      const item = document.createElement('li');
      item.textContent = `${row.entry_date}：${row.saved ? row.history_saved === false ? '保存済み（履歴同期待ち）' : '保存済み' : `未保存 · ${row.error}`}`;
      $('import-results').append(item); if (row.saved) saved++;
    }
    $('import-message').textContent = saved === result.results.length ? `${saved}日分を取り込みました。同じ値を再送しても履歴は増えません。` : `${saved}日保存済み、${result.results.length - saved}日未保存です。入力を保持しています。再試行できます。`;
  } catch (error) {
    $('import-message').textContent = `${error.message} 入力を保持しています。通信失敗時は保存済みか確認できないため、再試行してください。同じ値の再送で履歴は増えません。`;
    if (error.status === 401) authExpired();
  } finally { writeEpoch++; importBusy = false; setMode(); sync(); }
};
window.addEventListener('beforeunload', event => { if (unsaved()) { event.preventDefault(); event.returnValue = ''; } });

function buildWeeks() {
  $('week-picker').replaceChildren();
  $('week-picker').hidden = false;
  monthWeekWindows(month).forEach(({ dates: week, label }, index) => {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = index === 0 ? label.split('/')[0] : `${index}週`; button.dataset.start = week[0];
    button.setAttribute('aria-label', `${label} ${week[0]} 〜 ${week.at(-1)}`);
    button.onclick = () => selectDay(week[0], false, week[0]); $('week-picker').append(button);
  });
}
function showWeek(date) {
  const windows = monthWeekWindows(month).map(window => window.dates);
  const week = windows.find(week => week[0] === activeWeekStart && week.includes(date))
    ?? windows.findLast(week => week.includes(date));
  activeWeekStart = week[0];
  $('week-heading').textContent = `${week[0]} 〜 ${week.at(-1)}`;
  for (const button of $('week-picker').children) button.setAttribute('aria-pressed', String(button.dataset.start === week[0]));
  for (const [date, day] of dayButtons) day.button.classList.toggle('outside-week', !week.includes(date));
}
function renderComments() {
  const comments = commentsByDate.get(selectedDate) ?? [];
  $('comments-title').textContent = `${selectedDate} のコメント`;
  $('comment-list').replaceChildren(); $('comment-empty').hidden = comments.length > 0;
  $('comment-empty').textContent = commentsByDate.has(selectedDate) ? 'まだコメントはありません。' : 'コメントを読み込み中…';
  for (const comment of comments) {
    const li = document.createElement('li'), meta = document.createElement('p'), content = document.createElement('p');
    meta.className = 'meta'; meta.textContent = `${comment.editor_name} · ${formatTime(comment.created_at)}`;
    content.className = 'comment-content'; content.textContent = comment.content;
    li.append(meta, content); $('comment-list').append(li);
  }
}
$('comment-content').addEventListener('input', () => {
  commentId = null; commentAttempt = null; $('comment-message').textContent = $('comment-content').value ? '未送信' : '';
});
$('comment-content').addEventListener('compositionstart', () => { commentComposing = true; });
$('comment-content').addEventListener('compositionend', () => { commentComposing = false; });
$('comment-form').onsubmit = async event => {
  event.preventDefault(); if (commentBusy || commentComposing || importBusy || !authenticated) return;
  const content = $('comment-content').value;
  try { textLimit(content, 3000, 'コメント', true); } catch (error) { $('comment-message').textContent = error.message; return; }
  commentId ??= crypto.randomUUID();
  commentAttempt ??= { action: 'add_comment', editor_name: editor, entry_date: selectedDate, id: commentId, content };
  commentBusy = true; writeEpoch++; setMode(); $('comment-message').textContent = '投稿中…';
  try {
    const result = await request(commentAttempt);
    const comments = commentsByDate.get(selectedDate) ?? [];
    if (!comments.some(comment => comment.id === result.comment.id)) comments.push(result.comment);
    comments.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    commentsByDate.set(selectedDate, comments); renderComments();
    $('comment-content').value = ''; commentId = null; commentAttempt = null; $('comment-message').textContent = '投稿しました。';
  } catch (error) { $('comment-message').textContent = `${error.message} 入力を保持しています。「投稿する」で再試行できます。`; if (error.status === 401) authExpired(); }
  finally { commentBusy = false; writeEpoch++; setMode(); }
};

buildMonth(); sync(); setInterval(() => sync(), 3000);
