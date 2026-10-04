import { FIELDS, LIMITS, DEFAULT_BASE, monthRange, localDate, validateBase, textLimit } from './model.mjs';
const $ = id => document.getElementById(id);
const API = '/.netlify/functions/planner';
const editingRequested = new URLSearchParams(location.search).get('edit') === '1';
let month = localDate().slice(0, 7), pin = '', editor = '', authenticated = false, base = DEFAULT_BASE, baseEtag = null;
let pendingSync = null, writeEpoch = 0, baseNeedsReload = false;
let loadSequence = 0, polling = false, lastSync = '', baseStarted = false, baseExpected = null, baseDirty = false, baseBusy = false, preview = null;
const cells = new Map();
const dates = () => monthRange(month);
const formatTime = value => value ? new Date(value).toLocaleString('ja-JP') : '';
const fieldLabel = field => field === 'base' ? '時間割' : field === 'note' ? '備考' : base.slots[field === 'slot1' ? 0 : 1].label;
async function request(body, query = '') {
  const response = await fetch(API + query, body ? { signal: AbortSignal.timeout(10000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, pin }) } : { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  let result; try { result = await response.json(); } catch { throw new Error('サーバーの応答を確認できません。再試行してください。'); }
  if (!response.ok) throw Object.assign(new Error(result.error || '通信に失敗しました。'), { status: response.status });
  return result;
}
function unsaved() { return baseDirty || baseBusy || [...cells.values()].some(cell => cell.dirty || cell.inflight || cell.composing); }
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
  $('base-panel').hidden = !authenticated;
  $('mode').textContent = authenticated ? `${editor}として編集中 · 入力後に自動保存` : '閲覧専用 · 3秒ごとに同期';
  for (const cell of cells.values()) { cell.input.hidden = !editingRequested; cell.input.readOnly = !authenticated; cell.display.hidden = editingRequested; }
}
function authExpired() { authenticated = false; pin = ''; $('pin').value = ''; $('auth-message').textContent = '認証が切れました。入力を保持しています。PINを入力し直してください。'; setMode(); }
function buildMonth() {
  cells.clear(); $('days').replaceChildren();
  const [year, number] = month.split('-'); $('month-title').textContent = `${year}年${Number(number)}月`;
  for (const date of dates()) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const row = document.createElement('tr'); if (day === 0 || day === 6) row.classList.add('weekend'); if (date === localDate()) row.classList.add('is-today');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = `${Number(date.slice(-2))}日（${'日月火水木金土'[day]}）`;
    if (date === localDate()) { const badge = document.createElement('span'); badge.className = 'today-badge'; badge.textContent = '今日'; heading.append(badge); }
    const meta = document.createElement('div'); meta.className = 'meta'; heading.append(meta); row.append(heading);
    for (const field of FIELDS) {
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
  setMode();
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
    if (cell.version === version) { cell.dirty = false; cell.display.textContent = value; cellStatus(cell, result.history_saved === false ? '保存済み · 履歴同期待ち' : '保存済み', 'saved'); }
    cell.meta.textContent = `${result.row.last_editor} · ${formatTime(result.row.updated_at)}`;
  } catch (error) { cell.error = error.message; cellStatus(cell, error.message, 'error'); if (error.status === 401) authExpired(); }
  finally { writeEpoch++; cell.inflight = false; status(); if (succeeded && cell.dirty && !cell.composing) schedule(cell); }
}
function paint(data) {
  base = data.base; baseEtag = data.base_etag;
  for (let i = 0; i < 2; i++) { const heading = $(`slot${i + 1}-heading`); heading.replaceChildren(document.createTextNode(base.slots[i].label)); const time = document.createElement('span'); time.className = 'slot-time'; time.textContent = base.slots[i].time; heading.append(time); }
  for (const row of data.entries) {
    for (const field of FIELDS) {
      const cell = cells.get(`${row.entry_date}:${field}`); if (!cell) continue;
      cell.input.setAttribute('aria-label', `${row.entry_date} ${fieldLabel(field)}`);
      const slot = field === 'note' ? null : base.slots[field === 'slot1' ? 0 : 1];
      cell.input.parentElement.dataset.label = fieldLabel(field) + (slot?.time ? `（${slot.time}）` : '');
      if (!cell.dirty && !cell.inflight && !cell.composing && document.activeElement !== cell.input) { cell.input.value = row[field]; cell.display.textContent = row[field]; }
      cell.meta.textContent = row.last_editor ? `${row.last_editor} · ${formatTime(row.updated_at)}` : '';
    }
  }
  $('history').replaceChildren();
  for (const event of data.history) { const li = document.createElement('li'); li.textContent = `${formatTime(event.changed_at)} · ${event.editor_name} · ${event.entry_date || '共有設定'} · ${fieldLabel(event.field_name)}`; $('history').append(li); }
  if (!data.history.length) { const li = document.createElement('li'); li.textContent = 'まだ変更履歴はありません。'; $('history').append(li); }
  lastSync = new Date().toLocaleTimeString('ja-JP'); status();
}
async function sync(force = false) {
  if (pendingSync) { if (!force) return false; await pendingSync; }
  pendingSync = runSync();
  try { return await pendingSync; } finally { pendingSync = null; }
}
async function runSync() {
  polling = true; const sequence = loadSequence, epoch = writeEpoch; const range = dates();
  try { const data = await request(null, `?start=${range[0]}&end=${range.at(-1)}`); if (sequence === loadSequence && epoch === writeEpoch) paint(data); return sequence === loadSequence && epoch === writeEpoch; }
  catch (error) { if (sequence === loadSequence) $('status').textContent = `同期できません：${error.message}`; return false; }
  finally { polling = false; }
}
function changeMonth(offset) {
  if (unsaved()) { $('status').textContent = '未保存の入力があります。保存・再試行してから月を移動してください。'; return; }
  if (polling) return;
  const [year, number] = month.split('-').map(Number); month = offset === null ? localDate().slice(0, 7) : localDate(new Date(year, number - 1 + offset, 1)).slice(0, 7);
  loadSequence++; lastSync = ''; buildMonth(); sync();
}
$('prev').onclick = () => changeMonth(-1); $('next').onclick = () => changeMonth(1); $('today').onclick = () => changeMonth(null);
$('auth-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { editor = textLimit($('editor').value, 40, '編集者名', true).trim(); pin = $('pin').value; await request({ action: 'verify' }); authenticated = true; $('pin').value = ''; $('auth-message').textContent = ''; setMode(); status(); if ([...cells.values()].some(cell => cell.dirty)) $('status').textContent = '入力を保持しています。「未保存の予定を再試行」で保存できます。'; }
  catch (error) { pin = ''; $('auth-message').textContent = error.message; }
  finally { button.disabled = false; }
};
$('logout').onclick = () => { if (unsaved()) { $('status').textContent = '未保存の入力があります。保存・再試行してから編集を終了してください。'; return; } authenticated = false; pin = ''; setMode(); };
$('retry').onclick = () => { if (!authenticated) { $('auth-message').textContent = 'PINを入力し直してから再試行してください。'; $('auth').hidden = false; return; } for (const cell of cells.values()) if (cell.dirty && !cell.inflight) { cell.error = ''; save(cell); } };
function beginBase() { if (baseNeedsReload) return; if (!baseStarted) { baseStarted = true; baseExpected = baseEtag; } }
function invalidateBase() { beginBase(); baseDirty = true; preview = null; $('base-apply').disabled = true; $('base-result').hidden = true; }
$('base-json').addEventListener('input', invalidateBase);
$('base-panel').addEventListener('toggle', () => { if ($('base-panel').open) beginBase(); });
$('base-load').onclick = async () => {
  if (baseBusy || (baseDirty && !confirm('入力したJSONを現在の共有時間割に置き換えますか？'))) return;
  if (!await sync(true)) { $('base-message').textContent = '現在の時間割を取得できませんでした。'; return; }
  baseNeedsReload = false; baseStarted = true; baseExpected = baseEtag; baseDirty = false; preview = null; $('base-json').value = JSON.stringify(base, null, 2); $('base-apply').disabled = true; $('base-result').hidden = true; $('base-message').textContent = '現在の時間割を読み込みました。';
};
$('base-file').onchange = async event => { const file = event.target.files[0]; if (!file) return; if (file.size > 262144) { $('base-message').textContent = 'JSONは256KiB以内にしてください。'; return; } try { const value = await file.text(); if (baseBusy) return; $('base-json').value = value; invalidateBase(); $('base-message').textContent = 'ファイルを読み込みました。「内容を確認」を押してください。'; } catch { $('base-message').textContent = 'ファイルを読み込めませんでした。'; } };
$('base-preview').onclick = () => {
  if (baseNeedsReload) { $('base-message').textContent = '先に「現在の時間割を読み込む」を押してください。'; return; }
  try { beginBase(); preview = validateBase(JSON.parse($('base-json').value)); $('base-result').textContent = JSON.stringify(preview, null, 2); $('base-result').hidden = false; $('base-apply').disabled = baseBusy; $('base-message').textContent = `${preview.slots.map(slot => slot.label + (slot.time ? `（${slot.time}）` : '')).join(' / ')} · 曜日設定${Object.keys(preview.weekdays).length}件 · 日付例外${Object.keys(preview.dates).length}件`; }
  catch (error) { preview = null; $('base-apply').disabled = true; $('base-result').hidden = true; $('base-message').textContent = `JSONを確認してください：${error.message}`; }
};
$('base-apply').onclick = async () => {
  if (!preview || baseBusy || !authenticated || baseNeedsReload) return;
  writeEpoch++; baseBusy = true; $('base-apply').disabled = true; $('base-json').disabled = true; $('base-file').disabled = true; $('base-preview').disabled = true;
  try {
    const result = await request({ action: 'base', editor_name: editor, base: preview, expected_etag: baseExpected });
    writeEpoch++; baseDirty = false; preview = null;
    if (await sync(true)) { baseExpected = baseEtag; $('base-json').value = JSON.stringify(base, null, 2); $('base-message').textContent = result.history_saved === false ? '時間割を保存しました。履歴は同期待ちです。' : '共有時間割に反映しました。'; }
    else { baseNeedsReload = true; $('base-message').textContent = '時間割は保存済みです。次の編集前に「現在の時間割を読み込む」を押してください。'; }
  } catch (error) { baseDirty = true; $('base-message').textContent = `${error.message} JSONは保持しています。`; if (error.status === 401) authExpired(); }
  finally { writeEpoch++; baseBusy = false; $('base-json').disabled = false; $('base-file').disabled = false; $('base-preview').disabled = false; $('base-apply').disabled = !preview || baseNeedsReload; }
};
window.addEventListener('beforeunload', event => { if (unsaved()) { event.preventDefault(); event.returnValue = ''; } });
buildMonth(); sync(); setInterval(() => sync(), 3000);
