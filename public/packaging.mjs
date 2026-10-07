import { PHOTO_LIMIT } from './packaging-model.mjs';
import { setupMenu } from './menu-sheet.mjs';
const $ = id => document.getElementById(id), endpoint = '/.netlify/functions/packaging';
let data = { items: [], skus: [] }, editing = null, busy = false;
function node(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
async function api(body) {
  const response = await fetch(endpoint, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '通信に失敗しました。'),{status:response.status});
  return result;
}
const menu = setupMenu(document,api,(item,sku)=>open(item,sku),next=> { data = next; render(); });
function render() {
  const selected = $('filter').value;
  $('items').replaceChildren();
  for (const item of data.items.filter(item => !selected || item.id === selected)) {
    const section = node('section'); section.className = 'packaging-item';
    section.append(node('h2', item.name), node('p', `品目ID: ${item.id}`));
    const skus = data.skus.filter(sku => sku.item_id === item.id).sort((a,b) => a.id.localeCompare(b.id));
    if (skus.length) section.className += ' has-skus';
    if (!skus.length) section.append(node('p', 'SKU未登録・写真未登録'));
    for (const sku of skus) {
      const card = node('article'); card.className = 'sku-card'; card.append(node('h3', sku.name));
      const list = node('dl');
      for (const [label,value] of [['SKU ID',sku.id],['品種・種類',sku.type || '未確認'],['栽培方法',({organic:'有機',conventional:'慣行'})[sku.cultivation_method] || '未確認'],['価格',sku.price_yen == null ? '未確認' : `${sku.price_yen.toLocaleString('ja-JP')}円`],['荷姿条件',sku.packaging_condition || '未確認']]) list.append(node('dt',label),node('dd',value));
      card.append(list);
      if (sku.photo_id) { const img = node('img'); img.src = `${endpoint}?photo=${encodeURIComponent(sku.photo_id)}`; img.alt = `${item.name}・${sku.name}の荷姿写真`; img.loading = 'lazy'; card.append(img); }
      else card.append(node('p','写真未登録'));
      if (sku.note) card.append(node('p',sku.note));
      const editButton = node('button','SKUを編集'); editButton.type = 'button'; editButton.addEventListener('click',()=> open(item,sku)); card.append(editButton);
      section.append(card);
    }
    const button = node('button','登録'); button.type = 'button'; button.className = 'register-sku'; button.setAttribute('aria-label', `${item.name}にSKU・写真を登録`); button.addEventListener('click',()=>open(item)); section.insertBefore(button, section.children[2] ?? null);
    $('items').append(section);
  }
}
async function load() {
  try { const next = await api(); data = next; menu.receive(next); const value = $('filter').value; $('filter').replaceChildren(new Option('全品目',''),...data.items.map(item=>new Option(item.name,item.id))); $('filter').value = value; render(); $('status').textContent = '読み込みました。'; }
  catch(e) { $('status').textContent = e.message; }
}
function setCultivation(method) {
  const toggle = $('sku-cultivation');
  toggle.checked = method === 'organic'; toggle.indeterminate = method === 'unknown';
  $('cultivation-status').textContent = ({organic:'ON 有機', conventional:'OFF 慣行', unknown:'未確認'})[method];
}
$('sku-cultivation').addEventListener('change',()=>setCultivation($('sku-cultivation').checked ? 'organic' : 'conventional'));
$('cultivation-reset').addEventListener('click',()=>setCultivation('unknown'));
function open(item,sku = null) {
  editing = { item,sku }; $('sku-form').reset(); $('item-name').value = item.name;
  $('sku-id').value = sku?.id ?? ''; $('sku-id').readOnly = !!sku;
  $('sku-name').value = sku?.name ?? ''; $('sku-type').value = sku?.type ?? ''; $('sku-note').value = sku?.note ?? '';
  setCultivation(sku?.cultivation_method ?? 'unknown'); $('sku-price').value = sku?.price_yen ?? ''; $('sku-condition').value = sku?.packaging_condition ?? '';
  $('sku-title').textContent = `${item.name}のSKU${sku ? '編集' : '追加'}`; $('form-status').textContent = ''; $('sku-dialog').showModal();
}
$('filter').addEventListener('change',render); $('reload').addEventListener('click',()=> { if (menu.canLeave()) return load(); });
$('cancel').addEventListener('click',()=> { if (!busy) $('sku-dialog').close(); });
$('sku-dialog').addEventListener('cancel',event=> { if (busy) event.preventDefault(); });
$('sku-form').addEventListener('submit',async event=> {
  event.preventDefault(); if (busy) return;
  busy = true; $('save').disabled = true; $('cancel').disabled = true;
  try {
    const file = $('photo').files[0]; let photo = null;
    if (file) {
      if (file.size > PHOTO_LIMIT) throw new Error('写真は3MiB以内にしてください。');
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('JPEG・PNG・WebPを選んでください。');
      const base64 = await new Promise((resolve,reject)=> { const reader = new FileReader(); reader.onload = ()=>resolve(reader.result.split(',')[1]); reader.onerror = ()=>reject(new Error('写真を読み込めませんでした。')); reader.readAsDataURL(file); });
      photo = { type:file.type,data:base64 };
    }
    await api({ action:'save_sku',item_id:editing.item.id,id:$('sku-id').value,name:$('sku-name').value,type:$('sku-type').value,note:$('sku-note').value,cultivation_method:$('sku-cultivation').indeterminate ? 'unknown' : $('sku-cultivation').checked ? 'organic' : 'conventional',price_yen:$('sku-price').value.trim() === '' ? null : Number($('sku-price').value),packaging_condition:$('sku-condition').value,etag:editing.sku?.etag ?? null,photo });
    $('sku-dialog').close(); await load(); $('status').textContent = '保存しました。';
  } catch(e) { $('form-status').textContent = `${e.message} 入力は保持しています。`; }
  finally { busy = false; $('save').disabled = false; $('cancel').disabled = false; }
});
load();
