import { summarizeSheet } from './packaging-model.mjs';
const cloneRows = rows=>rows.map(row=>({...row}));
const numberValue = input=>input.value.trim() === '' ? null : Number(input.value);
const format = value=>BigInt(value).toLocaleString('ja-JP');
export function setupMenu(document,api) {
  const $ = id=>document.getElementById(id);
  const node = (tag,text)=> { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  let source = {items:[],skus:[],sheets:[]}, selected = '', rows = [], etag = null, dirty = false, busy = false, conflict = false;
  const status = text=> { $('menu-status').textContent = text; };
  const canLeave = ()=> { if (dirty || busy) { status('未保存のおしながきがあります。保存してから移動・再読込してください。'); return false; } return true; };
  const skuName = row=>source.skus.find(sku=>sku.item_id === row.item_id && sku.id === row.sku_id)?.name ?? row.sku_id;
  function controls() {
    $('menu-save').disabled = !selected || busy || conflict;
    $('menu-date').disabled = busy;
    $('menu-new-date').disabled = busy;
    $('menu-copy').disabled = busy;
    $('menu-sku').disabled = busy || !selected;
  }
  function summary() {
    $('menu-summary').replaceChildren();
    const totals = summarizeSheet(rows);
    for (const [key,label,unit] of [['planned_quantity','予定数',''],['prepared_quantity','準備数',''],['planned_amount','予定売価','円'],['prepared_amount','準備済み売価','円']]) {
      const value = totals[key];
      $('menu-summary').append(node('p',`${label}${value.unknown ? '（既知分小計）' : '合計'}: ${format(value.total)}${unit}${value.unknown ? ` ／未入力 ${value.unknown}件` : ''}`));
    }
  }
  function renderRows() {
    $('menu-rows').replaceChildren();
    for (const row of rows) {
      const card = node('article'); card.className = 'menu-row'; card.append(node('h3',skuName(row)));
      const sku = source.skus.find(sku=>sku.item_id === row.item_id && sku.id === row.sku_id);
      card.append(node('p',`${sku?.type || '品種未確認'} ／ ${({organic:'有機',conventional:'慣行'})[sku?.cultivation_method] || '栽培方法未確認'}${sku?.packaging_condition ? ` ／ ${sku.packaging_condition}` : ''}`));
      const state = node('p'); state.className = 'menu-row-state';
      const updateState = ()=> { state.textContent = row.planned_quantity === null || row.prepared_quantity === null ? '数量未入力' : row.prepared_quantity >= row.planned_quantity ? '準備完了' : `あと${row.planned_quantity-row.prepared_quantity}`; };
      const fields = node('div'); fields.className = 'menu-row-fields';
      for (const [key,label] of [['price_yen','単価（円）'],['planned_quantity','予定数'],['prepared_quantity','準備数']]) {
        const wrapper = node('label',label), input = node('input'); input.type = 'number'; input.min = '0'; input.step = '1'; input.max = String(Number.MAX_SAFE_INTEGER); input.value = row[key] === null ? '' : String(row[key]); input.disabled = busy;
        input.addEventListener('input',()=> {
          dirty = true; status('未保存の変更があります。');
          const value = numberValue(input);
          if (value !== null && (!Number.isSafeInteger(value) || value < 0)) { input.setCustomValidity('0以上の安全な整数を入力してください。'); return; }
          input.setCustomValidity(''); row[key] = value; dirty = true; status('未保存の変更があります。'); summary(); updateState();
        }); wrapper.append(input); fields.append(wrapper);
      }
      updateState(); card.append(fields,state); $('menu-rows').append(card);
    }
    if (!rows.length) $('menu-rows').append(node('p',selected ? '登録済みSKUを選んで追加してください。' : '日付を追加してください。'));
    summary(); controls();
  }
  function renderDates() {
    $('menu-date').replaceChildren();
    if (!source.sheets.length) { const option = node('option','日付未登録'); option.value = ''; $('menu-date').append(option); }
    for (const sheet of source.sheets) { const option = node('option',sheet.date); option.value = sheet.date; $('menu-date').append(option); }
    $('menu-date').value = selected;
    $('menu-sku').replaceChildren();
    for (const sku of source.skus) { const option = node('option',`${sku.name}（${sku.id}）`); option.value = `${sku.item_id}/${sku.id}`; $('menu-sku').append(option); }
  }
  function select(date) {
    selected = date; const sheet = source.sheets.find(sheet=>sheet.date === date);
    rows = cloneRows(sheet?.rows ?? []); etag = sheet?.etag ?? null; dirty = false; conflict = false;
    $('menu-latest').hidden = true; $('menu-conflict-view').hidden = true; renderDates(); renderRows();
    status(selected ? `${selected}のおしながき` : '日付を追加しておしながきを作成します。');
  }
  function receive(next) {
    source = {...next,sheets:next.sheets ?? []};
    if (!dirty && !busy) select(source.sheets.some(sheet=>sheet.date === selected) ? selected : source.sheets.find(sheet=>sheet.date === '2026-10-17')?.date ?? source.sheets.at(-1)?.date ?? '');
  }
  $('menu-date').addEventListener('change',()=> { const next = $('menu-date').value; if (canLeave()) select(next); else $('menu-date').value = selected; });
  async function persist(date,nextRows,currentEtag,isNew = false) {
    busy = true; controls(); renderRows(); status('おしながきを保存中…');
    try {
      const result = await api({action:'save_sheet',date,rows:nextRows,etag:currentEtag});
      source.sheets = [...source.sheets.filter(sheet=>sheet.date !== date),result.sheet].sort((a,b)=>a.date.localeCompare(b.date));
      select(date); status('おしながきを保存しました。');
    } catch(e) {
      if (!isNew) { dirty = true; conflict = e.status === 409; $('menu-latest').hidden = !conflict; }
      status(`${e.message} 入力は保持しています。${conflict ? '最新状態を確認してください。' : '保存を再試行できます。'}`);
    } finally { busy = false; renderRows(); }
  }
  $('menu-form').addEventListener('submit',event=> { event.preventDefault(); if (!selected || busy || conflict) return; return persist(selected,cloneRows(rows),etag); });
  $('menu-add-date').addEventListener('submit',event=> {
    event.preventDefault(); if (!canLeave()) return;
    const date = $('menu-new-date').value;
    if (source.sheets.some(sheet=>sheet.date === date)) { status('その日付は登録済みです。予定日から選んでください。'); return; }
    const nextRows = $('menu-copy').checked ? rows.map(row=>({...row,planned_quantity:null,prepared_quantity:null})) : [];
    return persist(date,nextRows,null,true);
  });
  $('menu-add-sku').addEventListener('submit',event=> {
    event.preventDefault(); if (!selected || busy) return;
    const sku = source.skus.find(sku=>`${sku.item_id}/${sku.id}` === $('menu-sku').value); if (!sku) return;
    if (rows.some(row=>row.item_id === sku.item_id && row.sku_id === sku.id)) { status('このSKUは追加済みです。'); return; }
    rows.push({item_id:sku.item_id,sku_id:sku.id,price_yen:sku.price_yen ?? null,planned_quantity:null,prepared_quantity:null}); dirty = true; renderRows(); status('SKUを追加しました。おしながきを保存してください。');
  });
  $('menu-latest').addEventListener('click',async()=> {
    if (busy) return; busy = true; controls();
    try {
      const next = await api(), latest = next.sheets.find(sheet=>sheet.date === selected);
      if (!latest) throw new Error('対象の日付を読み込めませんでした。');
      etag = latest.etag; $('menu-latest-rows').replaceChildren();
      for (const row of latest.rows) $('menu-latest-rows').append(node('p',`${skuName(row)}：単価 ${row.price_yen ?? '未入力'}円 ／予定 ${row.planned_quantity ?? '未入力'} ／準備 ${row.prepared_quantity ?? '未入力'}`));
      $('menu-conflict-view').hidden = false; $('menu-conflict-view').open = true;
      conflict = false; $('menu-latest').hidden = true; status('最新状態を表示しました。入力は保持しています。比較・確認して保存すると入力内容で上書きします。');
    } catch(e) { status(`${e.message} 入力は保持しています。最新状態の確認を再試行してください。`); }
    finally { busy = false; controls(); }
  });
  return {receive,canLeave};
}
