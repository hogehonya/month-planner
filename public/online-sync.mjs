const kinds = { skus: '商品', sheets: '販売準備表', comments: 'コメント', photos: '写真' };
const changes = { added: '追加', changed: '変更', removed: '削除' };
const fields = { item_id: '品目ID', id: '識別番号', sku_id: 'SKU ID', name: '商品名', type: '品種・種類', note: '備考', packaging_condition: '荷姿', cultivation_method: '栽培方法', price_yen: '単価（円）', photo_id: '写真番号', updated_at: '更新日時', date: '予定日', planned_quantity: '必要数', prepared_quantity: '準備済み', status_bits: '確定状態', content: '本文', created_at: '投稿日時', size: '容量（バイト）', references: '参照数' };

export function setupOnlineSync(document, { canStart, refresh, request = requestSync }) {
  const $ = id => document.getElementById(id);
  const button = $('online-sync'), dialog = $('online-sync-dialog');
  if (!button || !dialog) return { receive() {} };
  let enabled = false, source = '', phase = '', preview = null, sequence = 0;
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const message = text => { $('online-sync-message').textContent = text; };
  const status = text => { $('online-sync-status').textContent = text; };
  function controls() {
    button.disabled = Boolean(phase);
    $('online-sync-apply').disabled = Boolean(phase) || !preview;
    $('online-sync-retry').disabled = Boolean(phase);
    $('online-sync-cancel').disabled = phase === 'apply';
    dialog.setAttribute('aria-busy', String(Boolean(phase)));
  }
  function guard() {
    if (canStart()) return true;
    const text = '未保存・送信中の入力、または開いている商品編集があります。保存またはキャンセルしてから同期してください。';
    status(text); message(text); return false;
  }
  function record(value, kind) {
    const section = node('div');
    if (value == null) { section.append(node('p', 'なし')); return section; }
    const list = node('dl');
    for (const [key, label] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) continue;
      let text = value[key];
      if (key === 'cultivation_method') text = ({ organic: '有機', conventional: '慣行', unknown: '未確認' })[text] ?? '未確認';
      if (key === 'status_bits') text = [text & 1 ? '荷姿確定' : '荷姿未確定', text & 2 ? '単価確定' : '単価未確定', text & 4 ? '必要数確定' : '必要数未確定', text & 16 ? '出荷なし' : '出荷対象'].join('・');
      list.append(node('dt', kind === 'photos' && key === 'type' ? '画像形式' : label), node('dd', text == null || text === '' ? '未入力' : String(text)));
    }
    section.append(list);
    if (Array.isArray(value.rows)) {
      if (!value.rows.length) section.append(node('p', '商品行なし'));
      for (const row of value.rows) {
        const entry = node('section');
        entry.append(node('h4', `商品 ${row.item_id} / ${row.sku_id}`), record(row, 'sheets')); section.append(entry);
      }
    }
    return section;
  }
  function render(result) {
    $('online-sync-source').textContent = `オンライン ${result.source} → このローカル版`;
    $('online-sync-summary').replaceChildren();
    for (const [kind, label] of Object.entries(kinds)) {
      const counts = result.summary[kind];
      $('online-sync-summary').append(node('p', `${label}：追加 ${counts.added}・変更 ${counts.changed}・削除 ${counts.removed}`));
    }
    $('online-sync-changes').replaceChildren();
    for (const change of result.changes) {
      const detail = node('details');
      detail.append(node('summary', `${changes[change.change]}・${kinds[change.kind]}：${change.label}`));
      const values = node('div'); values.className = 'online-sync-values';
      for (const [key, label] of [['before', '現在のローカル'], ['after', '置き換え後（オンライン）']]) {
        const section = node('section'); section.append(node('h3', label), record(change[key], change.kind)); values.append(section);
      }
      detail.append(values); $('online-sync-changes').append(detail);
    }
    if (!result.changes.length) $('online-sync-changes').append(node('p', '差分はありません。'));
    message(`内容を確認してください。有効期限：${new Date(result.expires_at).toLocaleString('ja-JP')}。オンラインにないローカルの項目は削除されます。`);
  }
  async function showPreview() {
    if (!enabled || phase || !guard()) return;
    const current = ++sequence; preview = null; phase = 'preview';
    $('online-sync-source').textContent = `オンライン ${source} → このローカル版`;
    $('online-sync-summary').replaceChildren(); $('online-sync-changes').replaceChildren();
    if (!dialog.open) dialog.showModal();
    controls(); message('オンラインとの差分を読み込み中…');
    try {
      const result = await request({ action: 'preview' });
      if (current !== sequence) return;
      preview = result; render(result);
    } catch (error) {
      if (current === sequence) message(`${error.message} ローカルは変更していません。「差分を再確認」で再試行できます。`);
    } finally { if (current === sequence) { phase = ''; controls(); } }
  }
  async function apply() {
    if (phase || !preview || !guard()) return;
    if (!Number.isFinite(Date.parse(preview.expires_at)) || Date.parse(preview.expires_at) <= Date.now()) {
      preview = null; controls(); message('確認の有効期限が切れました。「差分を再確認」してください。'); return;
    }
    const token = preview.token; preview = null; phase = 'apply'; controls(); message('ローカルを置き換えています。この画面を閉じずにお待ちください。');
    let applied = false;
    try {
      const result = await request({ action: 'apply', token });
      if (result.ok !== true) throw new Error('置き換え結果を確認できませんでした。');
      applied = true;
      await refresh();
      status('オンラインの内容でローカルを置き換えました。'); dialog.close();
    } catch (error) {
      message(applied ? `置き換えは完了しましたが、再読込に失敗しました。${error.message} 閉じて再読込してください。` : `${error.message} 入力は保持しています。「差分を再確認」で現在の状態を確認してください。`);
    } finally { phase = ''; controls(); }
  }
  function close() {
    if (phase === 'apply') return;
    sequence++; preview = null; phase = ''; dialog.close(); controls();
  }
  button.addEventListener('click', showPreview);
  $('online-sync-retry').addEventListener('click', showPreview);
  $('online-sync-apply').addEventListener('click', apply);
  $('online-sync-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.defaultView?.addEventListener('beforeunload', event => {
    if (phase === 'apply') { event.preventDefault(); event.returnValue = ''; }
  });
  controls(); button.hidden = true;
  return { receive(data) { enabled = data.online_sync?.enabled === true; source = data.online_sync?.source ?? ''; button.hidden = !enabled; } };
}

async function requestSync(body) {
  const response = await fetch('/api/online-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '通信に失敗しました。');
  return result;
}
