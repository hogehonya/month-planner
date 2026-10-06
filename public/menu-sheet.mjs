import { summarizeSheet } from './packaging-model.mjs';
const cloneRows = rows=>rows.map(row=>({...row}));
const numberValue = input=>input.value.trim() === '' ? null : Number(input.value);
const format = value=>BigInt(value).toLocaleString('ja-JP');
export function visibleMenuRows(rows,skus,items,filters,sort) {
  const skuMap = new Map(skus.map(sku=>[`${sku.item_id}/${sku.id}`,sku]));
  const itemMap = new Map(items.map(item=>[item.id,item.name]));
  return rows.map((row,index)=>({row,index})).filter(({row})=> {
    const cultivation = skuMap.get(`${row.item_id}/${row.sku_id}`)?.cultivation_method ?? 'unknown';
    return (!filters.item.size || filters.item.has(row.item_id)) && (!filters.cultivation.size || filters.cultivation.has(cultivation)) && (!filters.price.size || filters.price.has('unknown') && row.price_yen === null || filters.price.has('range') && row.price_yen !== null && row.price_yen >= 200 && row.price_yen <= 500);
  }).sort((a,b)=> {
    if (sort === 'item') return (itemMap.get(a.row.item_id) ?? a.row.item_id).localeCompare(itemMap.get(b.row.item_id) ?? b.row.item_id,'ja') || a.index-b.index;
    const field = sort === 'planned-desc' ? 'planned_quantity' : 'price_yen';
    if (['price-asc','price-desc','planned-desc'].includes(sort)) {
      const left = a.row[field], right = b.row[field];
      if (left === null || right === null) return left === right ? a.index-b.index : left === null ? 1 : -1;
      return (sort === 'price-asc' ? left-right : right-left) || a.index-b.index;
    }
    return a.index-b.index;
  }).map(({row})=>row);
}
export function setupMenu(document,api,editSKU = ()=>{}) {
  const $ = id=>document.getElementById(id);
  const node = (tag,text)=> { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  let source = {items:[],skus:[],sheets:[]}, selected = '', rows = [], etag = null, dirty = false, busy = false, conflict = false;
  const cards = new Map(), filters = {item:new Set(),cultivation:new Set(),price:new Set()};
  let sort = 'registered';
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
      if (rows.length && value.unknown === rows.length) { $('menu-summary').append(node('p',`${label}: 未入力（${value.unknown}件）`)); continue; }
      $('menu-summary').append(node('p',`${label}${value.unknown ? '（既知分小計）' : '合計'}: ${format(value.total)}${unit}${value.unknown ? ` ／未入力 ${value.unknown}件` : ''}`));
    }
  }
  function updateCard(row,refs) {
    const sku = source.skus.find(sku=>sku.item_id === row.item_id && sku.id === row.sku_id);
    const item = source.items.find(item=>item.id === row.item_id);
    refs.title.textContent = skuName(row);
    refs.tags.replaceChildren(node('span',item?.name ?? row.item_id),node('span',({organic:'有機',conventional:'慣行'})[sku?.cultivation_method] ?? '未確認'));
    refs.info.textContent = `${sku?.type || '品種未確認'}${sku?.packaging_condition ? ` ／ ${sku.packaging_condition}` : ''}`;
    refs.media.replaceChildren();
    if (sku?.photo_id) {
      const image = node('img'); image.src = `/.netlify/functions/packaging?photo=${encodeURIComponent(sku.photo_id)}`; image.alt = `${item?.name ?? row.item_id}・${skuName(row)}の荷姿写真`; image.loading = 'lazy'; refs.media.append(image);
    } else refs.media.append(node('p','写真未登録'));
    if (sku && item) {
      const button = node('button',sku.photo_id ? '写真を変更' : '写真を登録'); button.type = 'button'; button.disabled = busy;
      button.addEventListener('click',()=>editSKU(item,sku)); refs.media.append(button);
    }
  }
  function renderRows() {
    $('menu-rows').replaceChildren(); cards.clear();
    for (const row of rows) {
      const card = node('article'); card.className = 'menu-row';
      const title = node('h3'), info = node('p'), media = node('div'), tags = node('div'); tags.className = 'menu-card-tags'; media.className = 'menu-row-photo';
      card.append(title,info);
      const refs = {title,info,media,tags,card}; cards.set(`${row.item_id}/${row.sku_id}`,refs); updateCard(row,refs);
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
      updateState(); card.append(fields,state,media,tags); $('menu-rows').append(card);
    }
    if (!rows.length) $('menu-rows').append(node('p',selected ? '登録済みSKUを選んで追加してください。' : '日付を追加してください。'));
    summary(); controls(); renderTags(); applyView();
  }
  function applyView() {
    const visible = visibleMenuRows(rows,source.skus,source.items,filters,sort);
    const shown = new Set(visible);
    for (const row of rows) cards.get(`${row.item_id}/${row.sku_id}`).card.hidden = !shown.has(row);
    const ordered = [...visible,...rows.filter(row=>!shown.has(row))];
    for (const row of ordered) $('menu-rows').append(cards.get(`${row.item_id}/${row.sku_id}`).card);
    $('menu-count').textContent = `${visible.length}件表示 ／全${rows.length}件（日付全体の合計）`;
    $('menu-no-match').hidden = visible.length > 0 || !rows.length;
  }
  function renderTags() {
    const present = new Set(rows.map(row=>row.item_id));
    const groups = {item:source.items.filter(item=>present.has(item.id)).map(item=>[item.id,item.name]),cultivation:[['organic','有機'],['conventional','慣行'],['unknown','未確認']],price:[['range','200〜500円'],['unknown','価格未定']]};
    for (const [group,choices] of Object.entries(groups)) {
      const container = $(`menu-${group}-tags`); container.replaceChildren();
      for (const [key,label] of choices) {
        const button = node('button',label); button.type = 'button'; button.setAttribute('aria-pressed',String(filters[group].has(key)));
        button.addEventListener('click',()=> { if (filters[group].has(key)) filters[group].delete(key); else filters[group].add(key); button.setAttribute('aria-pressed',String(filters[group].has(key))); applyView(); });
        container.append(button);
      }
    }
  }
  function clearFilters() { for (const values of Object.values(filters)) values.clear(); renderTags(); applyView(); }
  $('menu-clear-filters').addEventListener('click',clearFilters);
  $('menu-sort').addEventListener('change',()=> { sort = $('menu-sort').value; applyView(); });
  $('menu-reapply').addEventListener('click',applyView);
  $('menu-form').addEventListener('invalid',clearFilters,true);
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
    if (dirty || busy) {
      for (const row of rows) { const refs = cards.get(`${row.item_id}/${row.sku_id}`); if (refs) updateCard(row,refs); }
      return;
    }
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
  $('menu-form').addEventListener('submit',event=> { event.preventDefault(); if (!selected || busy || conflict) return; if (!$('menu-form').reportValidity()) return; return persist(selected,cloneRows(rows),etag); });
  $('menu-add-date').addEventListener('submit',event=> {
    event.preventDefault(); if (!canLeave()) return;
    const date = $('menu-new-date').value;
    if (source.sheets.some(sheet=>sheet.date === date)) { status('その日付は登録済みです。予定日から選んでください。'); return; }
    const nextRows = $('menu-copy').checked ? rows.map(row=>({...row,planned_quantity:null,prepared_quantity:null})) : [];
    return persist(date,nextRows,null,true);
  });
  $('menu-add-sku').addEventListener('submit',event=> {
    event.preventDefault(); if (!selected || busy) return;
    if (!$('menu-form').reportValidity()) { status('単価・数量の入力を確認してください。入力は保持しています。'); return; }
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
