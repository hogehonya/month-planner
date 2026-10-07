import { summarizeSheet, decisionState } from './packaging-model.mjs';
const cloneRows = rows=>rows.map(row=>({...row,decision_bits:row.decision_bits ?? 0}));
const numberValue = input=>input.value.trim() === '' ? null : Number(input.value);
const format = value=>BigInt(value).toLocaleString('ja-JP');
export function visibleMenuRows(rows,skus,items,filters,sort) {
  const skuMap = new Map(skus.map(sku=>[`${sku.item_id}/${sku.id}`,sku]));
  const itemMap = new Map(items.map(item=>[item.id,item.name]));
  return rows.map((row,index)=>({row,index})).filter(({row})=> {
    const cultivation = skuMap.get(`${row.item_id}/${row.sku_id}`)?.cultivation_method ?? 'unknown';
    const bits = decisionState(row,skuMap.get(`${row.item_id}/${row.sku_id}`));
    const matchesStatus = !filters.status || filters.status === 'undecided' && (bits & 7) !== 7 || filters.status === 'decided' && (bits & 7) === 7 || filters.status === 'no-photo' && !(bits & 8);
    return matchesStatus && (!filters.item.size || filters.item.has(row.item_id)) && (!filters.cultivation.size || filters.cultivation.has(cultivation)) && (!filters.price.size || filters.price.has('unknown') && row.price_yen === null || filters.price.has('range') && row.price_yen !== null && row.price_yen >= 200 && row.price_yen <= 500);
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
  let sort = 'registered', layout = 'card', detailKey = null, detailOrigin = null;
  const view = document.defaultView;
  const rowKey = row=>`${row.item_id}/${row.sku_id}`;
  function showDetail(key,focus = true) {
    if (detailKey && cards.has(detailKey)) { const previous = cards.get(detailKey); previous.detail.open = previous.wasOpen; previous.link.hidden = false; $('menu-rows').append(previous.card); }
    detailKey = cards.has(key) ? key : null;
    $('menu-detail-view').hidden = !detailKey;
    $('menu-master').hidden = Boolean(detailKey);
    $('menu-list-controls').hidden = Boolean(detailKey);
    $('menu-panel').hidden = Boolean(detailKey);
    if (detailKey) {
      const refs = cards.get(detailKey);
      refs.card.hidden = false; refs.wasOpen = refs.detail.open; refs.detail.open = true;
      $('menu-detail-row').append(refs.card);
      $('menu-detail-title').textContent = refs.title.textContent;
      refs.link.hidden = true;
      if (focus) $('menu-detail-title').focus?.();
    } else {
      for (const refs of cards.values()) refs.link.hidden = false;
      applyView();
      if (focus) detailOrigin?.focus?.();
    }
    applyLayout();
  }
  function routeDetail() {
    const hash = view?.location.hash ?? '';
    let key = null;
    if (hash.startsWith('#sku=')) { try { key = decodeURIComponent(hash.slice(5)); } catch {} }
    showDetail(key);
  }
  function openDetail(key,link) {
    detailOrigin = link;
    if (view) { view.history.pushState({menuDetail:true},'',`#sku=${encodeURIComponent(key)}`); }
    showDetail(key);
  }
  $('menu-detail-back').addEventListener('click',()=> {
    if (view?.history.state?.menuDetail) view.history.back();
    else { if (view) view.history.replaceState(null,'',view.location.pathname+view.location.search); showDetail(null); }
  });
  view?.addEventListener('popstate',routeDetail);
  view?.addEventListener('hashchange',routeDetail);
  for (const mode of ['table','card']) $('menu-layout-'+mode).addEventListener('click',()=> {
    layout = mode; applyLayout();
    for (const value of ['table','card']) $('menu-layout-'+value).setAttribute('aria-pressed',String(value === mode));
  });
  function applyLayout() {
    const table = layout === 'table';
    $('menu-rows').dataset.layout = layout;
    $('menu-table').setAttribute('role',table ? 'table' : 'presentation');
    $('menu-table').setAttribute('aria-label','販売準備表');
    $('menu-table-head').hidden = !table;
    $('menu-table-head').setAttribute('role','row');
    $('menu-rows').setAttribute('role',table ? 'rowgroup' : 'presentation');
    for (const refs of cards.values()) {
      const inTable = table && rowKey(refs.row) !== detailKey;
      refs.card.setAttribute('role',inTable ? 'row' : 'article');
      for (const cell of refs.cells) cell.setAttribute('role',inTable ? 'cell' : 'presentation');
    }
  }
  function cultivationVisual(el,method) {
    const key = ['organic','conventional'].includes(method) ? method : 'unknown';
    el.dataset.cultivation = key;
    const mark = node('span'); mark.className = 'cultivation-mark'; mark.setAttribute('aria-hidden','true'); el.append(mark);
    return key;
  }
  function renderTabs() {
    const container = $('menu-cultivation-tabs'); container.replaceChildren();
    for (const [key,label] of [['','全件'],['organic','有機'],['conventional','慣行'],['unknown','未確認']]) {
      const button = node('button',label); button.type = 'button'; button.setAttribute('role','tab'); if (key) cultivationVisual(button,key);
      const active = key ? filters.cultivation.has(key) : !filters.cultivation.size;
      button.setAttribute('aria-selected',String(active)); button.setAttribute('aria-controls','menu-panel'); button.tabIndex = active ? 0 : -1;
      button.addEventListener('click',()=> { filters.cultivation.clear(); if (key) filters.cultivation.add(key); renderTabs(); applyView(); [...container.children].find(tab=>tab.textContent === label)?.focus?.(); });
      button.addEventListener('keydown',event=> {
        const tabs = [...container.children], index = tabs.indexOf(button);
        const next = event.key === 'ArrowRight' ? (index+1)%tabs.length : event.key === 'ArrowLeft' ? (index+tabs.length-1)%tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : null;
        if (next !== null) { event.preventDefault(); tabs[next].click(); }
      });
      container.append(button);
    }
  }
  const status = text=> { $('menu-status').textContent = text; };
  const canLeave = ()=> { if (dirty || busy) { status('未保存の販売準備表があります。保存してから移動・再読込してください。'); return false; } return true; };
  const skuName = row=>source.skus.find(sku=>sku.item_id === row.item_id && sku.id === row.sku_id)?.name ?? row.sku_id;
  function controls() {
    $('menu-save').disabled = !selected || busy || conflict;
    $('menu-date').disabled = busy;
    $('menu-new-date').disabled = busy;
    $('menu-copy').disabled = busy;
    $('menu-sku').disabled = busy || !selected;
  }
  function summary() {
    $('menu-summary').replaceChildren(); $('menu-amount-summary').replaceChildren();
    const totals = summarizeSheet(rows);
    for (const [key,label,unit] of [['planned_quantity','必要数',''],['prepared_quantity','準備済み',''],['planned_amount','予定売価','円'],['prepared_amount','準備済み売価','円']]) {
      const value = totals[key], target = $(key.endsWith('amount') ? 'menu-amount-summary' : 'menu-summary');
      if (rows.length && value.unknown === rows.length) { target.append(node('p',`${label}: 未入力（${value.unknown}件）`)); continue; }
      target.append(node('p',`${label}${value.unknown ? '（既知分小計）' : '合計'}: ${format(value.total)}${unit}${value.unknown ? ` ／未入力 ${value.unknown}件` : ''}`));
    }
  }
  function confirmable(row,sku,bit) { return bit === 1 ? !!sku?.packaging_condition?.trim() : row[bit === 2 ? 'price_yen' : 'planned_quantity'] !== null; }
  function updateCard(row,refs) {
    const sku = source.skus.find(sku=>sku.item_id === row.item_id && sku.id === row.sku_id);
    const item = source.items.find(item=>item.id === row.item_id);
    refs.title.textContent = skuName(row);
    const badge = node('span',({organic:'有機',conventional:'慣行'})[sku?.cultivation_method] ?? '未確認'); badge.className = 'cultivation-badge';
    refs.card.dataset.cultivation = cultivationVisual(badge,sku?.cultivation_method);
    refs.tags.replaceChildren(node('span',item?.name ?? row.item_id),badge);
    if (row.decision_bits & 1 && !sku?.packaging_condition?.trim()) { row.decision_bits &= ~1; dirty = true; status('荷姿が未入力のため確定を解除しました。販売準備表を保存してください。'); }
    const bits = decisionState(row,sku);
    refs.decision.textContent = `${(bits & 7) === 7 ? '決定' : '未決定'}${!(bits & 8) ? '・写真なし' : ''}`;
    for (const [bit,check] of refs.checks) { check.checked = !!(bits & bit); check.disabled = busy || !confirmable(row,sku,bit); }
    const condition = sku?.packaging_condition || '荷姿未確認';
    const type = sku?.type && !skuName(row).includes(sku.type) ? `${sku.type} ／ ` : '';
    refs.info.textContent = `${type}${condition.length > 36 ? condition.slice(0,36)+'…' : condition}`;
    refs.condition.textContent = `荷姿：${condition}`;
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
    $('menu-rows').replaceChildren(); $('menu-detail-row').replaceChildren(); detailKey = null; cards.clear();
    for (const row of rows) {
      const card = node('article'); card.className = 'menu-row';
      const title = node('h3'), info = node('p'), media = node('div'), tags = node('div'), detail = node('details'), condition = node('p');
      detail.className = 'menu-row-detail'; detail.append(node('summary','写真・単価・荷姿詳細')); tags.className = 'menu-card-tags'; media.className = 'menu-row-photo';
      info.className = 'menu-row-info'; const identity = node('div'); identity.className = 'menu-row-identity'; identity.append(title,info); card.append(identity);
      const link = node('button','詳細を開く'); link.type = 'button'; link.className = 'menu-detail-link'; link.addEventListener('click',()=>openDetail(rowKey(row),link)); identity.append(tags,link);
      const decision = node('p'); decision.className = 'menu-row-decision'; identity.append(decision);
      const refs = {title,info,media,tags,card,detail,condition,link,row,decision,checks:[],cells:[identity,detail],inputs:[]}; cards.set(`${row.item_id}/${row.sku_id}`,refs); updateCard(row,refs);
      const state = node('p'); state.className = 'menu-row-state';
      const updateState = ()=> { state.textContent = row.planned_quantity === null || row.prepared_quantity === null ? '残り 未確認' : row.prepared_quantity >= row.planned_quantity ? '残り 0・準備完了' : `残り ${row.planned_quantity-row.prepared_quantity}`; };
      const fields = node('div'); fields.className = 'menu-row-fields';
      for (const [key,label] of [['price_yen','単価（円）'],['planned_quantity','必要数'],['prepared_quantity','準備済み']]) {
        const wrapper = node('label',label), input = node('input'); input.dataset.field = key; refs.inputs.push(input); input.type = 'number'; input.min = '0'; input.step = '1'; input.max = String(Number.MAX_SAFE_INTEGER); input.value = row[key] === null ? '' : String(row[key]); input.disabled = busy;
        input.addEventListener('input',()=> {
          if (key === 'price_yen' || key === 'planned_quantity') row.decision_bits &= ~(key === 'price_yen' ? 2 : 4);
          dirty = true; status('未保存の変更があります。');
          const value = numberValue(input);
          if (input.validity?.badInput || value !== null && (!Number.isSafeInteger(value) || value < 0)) { input.setCustomValidity('0以上の安全な整数を入力してください。'); row[key] = null; updateDecision(); summary(); updateState(); return; }
          input.setCustomValidity(''); row[key] = value; updateDecision(); dirty = true; status('未保存の変更があります。'); summary(); updateState();
        }); wrapper.append(input); if (key === 'price_yen') detail.append(wrapper); else { fields.append(wrapper); refs.cells.push(wrapper); }
      }
      function updateDecision() {
        const sku = source.skus.find(sku=>sku.item_id === row.item_id && sku.id === row.sku_id), bits = decisionState(row,sku);
        decision.textContent = `${(bits & 7) === 7 ? '決定' : '未決定'}${!(bits & 8) ? '・写真なし' : ''}`;
        for (const [bit,check] of refs.checks) { check.checked = !!(bits & bit); check.disabled = busy || !confirmable(row,sku,bit); }
      }
      const confirmations = node('fieldset'); confirmations.className = 'menu-confirmations'; confirmations.append(node('legend','計画の確定'));
      for (const [bit,label] of [[1,'荷姿を確定'],[2,'単価を確定'],[4,'必要数を確定']]) {
        const wrapper = node('label'), check = node('input'); check.type = 'checkbox'; check.dataset.bit = String(bit); refs.checks.push([bit,check]);
        check.addEventListener('change',()=> {
          const sku = source.skus.find(sku=>sku.item_id === row.item_id && sku.id === row.sku_id);
          if (!confirmable(row,sku,bit)) { check.checked = false; return; }
          row.decision_bits = check.checked ? row.decision_bits | bit : row.decision_bits & ~bit;
          dirty = true; updateDecision(); status('未保存の確定変更があります。');
        }); wrapper.append(check,node('span',label)); confirmations.append(wrapper);
      }
      updateDecision(); updateState(); detail.append(condition,confirmations,media); refs.cells.push(state); card.append(fields,state,detail); $('menu-rows').append(card);
    }
    if (!rows.length) $('menu-rows').append(node('p',selected ? '登録済みSKUを選んで追加してください。' : '日付を追加してください。'));
    summary(); controls(); renderTags(); renderTabs(); applyView(); applyLayout();
    if (view?.location.hash.startsWith('#sku=')) routeDetail();
  }
  function applyView() {
    const visible = visibleMenuRows(rows,source.skus,source.items,filters,sort);
    const shown = new Set(visible);
    for (const row of rows) cards.get(`${row.item_id}/${row.sku_id}`).card.hidden = !shown.has(row);
    const ordered = [...visible,...rows.filter(row=>!shown.has(row))];
    for (const row of ordered) if (rowKey(row) !== detailKey) $('menu-rows').append(cards.get(rowKey(row)).card);
    if (detailKey && cards.has(detailKey)) cards.get(detailKey).card.hidden = false;
    const labels = [...filters.item].map(id=>source.items.find(item=>item.id===id)?.name ?? id).concat([...filters.cultivation].map(key=>({organic:'有機',conventional:'慣行',unknown:'未確認'})[key]),[...filters.price].map(key=>key === 'range' ? '200〜500円' : '価格未定'));
    if (filters.status) labels.push(({undecided:'未決定',decided:'決定','no-photo':'写真なし'})[filters.status]);
    $('menu-filter-summary').textContent = `絞り込み・並び替え：${visible.length}/${rows.length}件・${labels.join('・') || '全件'} ／ ${({'registered':'登録順',item:'品目順','price-asc':'安い順','price-desc':'高い順','planned-desc':'必要数が多い順'})[sort]}`;
    $('menu-count').textContent = `${visible.length}件表示 ／全${rows.length}件（日付全体の合計）`;
    $('menu-no-match').hidden = visible.length > 0 || !rows.length;
  }
  function renderTags() {
    const present = new Set(rows.map(row=>row.item_id));
    const groups = {item:source.items.filter(item=>present.has(item.id)).map(item=>[item.id,item.name]),price:[['range','200〜500円'],['unknown','価格未定']]};
    for (const [group,choices] of Object.entries(groups)) {
      const container = $(`menu-${group}-tags`); container.replaceChildren();
      for (const [key,label] of choices) {
        const button = node('button',label); button.type = 'button'; button.setAttribute('aria-pressed',String(filters[group].has(key)));
        button.addEventListener('click',()=> { if (filters[group].has(key)) filters[group].delete(key); else filters[group].add(key); button.setAttribute('aria-pressed',String(filters[group].has(key))); applyView(); });
        container.append(button);
      }
    }
  }
  function clearFilters() { for (const values of [filters.item,filters.cultivation,filters.price]) values.clear(); filters.status = ''; $('menu-decision-filter').value = ''; renderTags(); renderTabs(); applyView(); }
  $('menu-clear-filters').addEventListener('click',clearFilters);
  $('menu-sort').addEventListener('change',()=> { sort = $('menu-sort').value; applyView(); });
  $('menu-reapply').addEventListener('click',applyView);
  $('menu-decision-filter').addEventListener('change',()=> { filters.status = $('menu-decision-filter').value; applyView(); });
  $('menu-form').addEventListener('invalid',event=> { clearFilters(); for (const refs of cards.values()) if (refs.inputs.includes(event.target)) { if (detailKey) { if (view) view.history.replaceState(null,'',view.location.pathname+view.location.search); showDetail(null,false); } refs.detail.open = true; } },true);
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
    status(selected ? `${selected}の販売準備表${dirty ? '：荷姿の確定を解除しました。保存してください。' : ''}` : '日付を追加して販売準備表を作成します。');
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
    busy = true; controls(); renderRows(); status('販売準備表を保存中…');
    try {
      const result = await api({action:'save_sheet',date,rows:nextRows,etag:currentEtag});
      source.sheets = [...source.sheets.filter(sheet=>sheet.date !== date),result.sheet].sort((a,b)=>a.date.localeCompare(b.date));
      select(date); status('販売準備表を保存しました。');
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
    const nextRows = $('menu-copy').checked ? rows.map(row=>({...row,planned_quantity:null,prepared_quantity:null,decision_bits:0})) : [];
    return persist(date,nextRows,null,true);
  });
  $('menu-add-sku').addEventListener('submit',event=> {
    event.preventDefault(); if (!selected || busy) return;
    if (!$('menu-form').reportValidity()) { status('単価・数量の入力を確認してください。入力は保持しています。'); return; }
    const sku = source.skus.find(sku=>`${sku.item_id}/${sku.id}` === $('menu-sku').value); if (!sku) return;
    if (rows.some(row=>row.item_id === sku.item_id && row.sku_id === sku.id)) { status('このSKUは追加済みです。'); return; }
    rows.push({item_id:sku.item_id,sku_id:sku.id,price_yen:sku.price_yen ?? null,planned_quantity:null,prepared_quantity:null,decision_bits:0}); dirty = true; renderRows(); status('SKUを追加しました。販売準備表を保存してください。');
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
