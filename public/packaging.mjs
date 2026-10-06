import { PHOTO_LIMIT } from './packaging-model.mjs';
const $ = id => document.getElementById(id), endpoint = '/.netlify/functions/packaging';
let pin = '', data = { items: [], skus: [] }, editing = null, busy = false;
function node(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
async function api(body) {
  const response = await fetch(endpoint, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, pin }) } : {});
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) { pin = ''; $('auth').hidden = false; $('logout').hidden = true; $('reauth-label').hidden = false; render(); } throw new Error(result.error || '通信に失敗しました。'); }
  return result;
}
function render() {
  const selected = $('filter').value;
  $('items').replaceChildren();
  for (const item of data.items.filter(item => !selected || item.id === selected)) {
    const section = node('section'); section.className = 'packaging-item';
    section.append(node('h2', item.name), node('p', `品目ID: ${item.id}`));
    const skus = data.skus.filter(sku => sku.item_id === item.id).sort((a,b) => a.id.localeCompare(b.id));
    if (!skus.length) section.append(node('p', 'SKU未登録・写真未登録'));
    for (const sku of skus) {
      const card = node('article'); card.className = 'sku-card'; card.append(node('h3', sku.name));
      const list = node('dl');
      for (const [label,value] of [['SKU ID',sku.id],['品種・種類',sku.type || '未確認']]) list.append(node('dt',label),node('dd',value));
      card.append(list);
      if (sku.photo_id) { const img = node('img'); img.src = `${endpoint}?photo=${encodeURIComponent(sku.photo_id)}`; img.alt = `${item.name}・${sku.name}の包装写真`; img.loading = 'lazy'; card.append(img); }
      else card.append(node('p','写真未登録'));
      if (sku.note) card.append(node('p',sku.note));
      if (pin) { const button = node('button','SKUを編集'); button.type = 'button'; button.addEventListener('click',()=> open(item,sku)); card.append(button); }
      section.append(card);
    }
    if (pin) { const button = node('button','SKUを追加'); button.type = 'button'; button.addEventListener('click',()=>open(item)); section.append(button); }
    $('items').append(section);
  }
}
async function load() {
  try { const next = await api(); data = next; const value = $('filter').value; $('filter').replaceChildren(new Option('全品目',''),...data.items.map(item=>new Option(item.name,item.id))); $('filter').value = value; render(); $('status').textContent = '読み込みました。'; }
  catch(e) { $('status').textContent = e.message; }
}
function open(item,sku = null) {
  editing = { item,sku }; $('sku-form').reset(); $('item-name').value = item.name;
  $('sku-id').value = sku?.id ?? ''; $('sku-id').readOnly = !!sku;
  $('sku-name').value = sku?.name ?? ''; $('sku-type').value = sku?.type ?? ''; $('sku-note').value = sku?.note ?? '';
  $('reauth-label').hidden = true; $('reauth-pin').value = ''; $('sku-title').textContent = `${item.name}のSKU${sku ? '編集' : '追加'}`; $('form-status').textContent = ''; $('sku-dialog').showModal();
}
$('edit').addEventListener('click',()=> { $('auth').hidden = false; $('pin').focus(); });
$('logout').addEventListener('click',()=> { pin = ''; $('pin').value = ''; $('logout').hidden = true; $('auth').hidden = true; render(); });
$('auth').addEventListener('submit',async event=> {
  event.preventDefault(); pin = $('pin').value;
  try { await api({action:'verify'}); $('pin').value = ''; $('auth').hidden = true; $('logout').hidden = false; $('status').textContent = '編集できます。PINはこのページを閉じると消去されます。'; render(); }
  catch(e) { pin = ''; $('status').textContent = e.message; render(); }
});
$('filter').addEventListener('change',render); $('reload').addEventListener('click',load);
$('cancel').addEventListener('click',()=> { if (!busy) $('sku-dialog').close(); });
$('sku-dialog').addEventListener('cancel',event=> { if (busy) event.preventDefault(); });
$('sku-form').addEventListener('submit',async event=> {
  event.preventDefault(); if (busy) return;
  busy = true; $('save').disabled = true; $('cancel').disabled = true;
  try {
    if (!pin) { pin = $('reauth-pin').value; await api({ action:'verify' }); $('reauth-pin').value = ''; $('reauth-label').hidden = true; $('logout').hidden = false; $('auth').hidden = true; }
    const file = $('photo').files[0]; let photo = null;
    if (file) {
      if (file.size > PHOTO_LIMIT) throw new Error('写真は3MiB以内にしてください。');
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('JPEG・PNG・WebPを選んでください。');
      const base64 = await new Promise((resolve,reject)=> { const reader = new FileReader(); reader.onload = ()=>resolve(reader.result.split(',')[1]); reader.onerror = ()=>reject(new Error('写真を読み込めませんでした。')); reader.readAsDataURL(file); });
      photo = { type:file.type,data:base64 };
    }
    await api({ action:'save_sku',item_id:editing.item.id,id:$('sku-id').value,name:$('sku-name').value,type:$('sku-type').value,note:$('sku-note').value,etag:editing.sku?.etag ?? null,photo });
    $('sku-dialog').close(); await load(); $('status').textContent = '保存しました。';
  } catch(e) { $('form-status').textContent = `${e.message} 入力は保持しています。`; }
  finally { busy = false; $('save').disabled = false; $('cancel').disabled = false; }
});
load();
