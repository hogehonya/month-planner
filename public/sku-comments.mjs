import { textLimit } from './model.mjs';
export function setupSKUComments(document,api,uuid = ()=>crypto.randomUUID()) {
  const $ = id=>document.getElementById(id);
  let target = null, key = '', sequence = 0, busy = false, composing = false, attempt = null, comments = [];
  const message = text=>{ $('sku-comment-message').textContent = text; };
  const pending = ()=>busy || composing || Boolean($('sku-comment-content').value);
  function canLeave() {
    if (!pending()) return true;
    message('未送信のコメントがあります。投稿するか本文を空にしてから移動してください。'); return false;
  }
  function render() {
    $('sku-comment-list').replaceChildren();
    for (const comment of comments) {
      const li = document.createElement('li'), time = document.createElement('p'), text = document.createElement('p');
      time.textContent = new Date(comment.created_at).toLocaleString('ja-JP'); text.textContent = comment.content; text.className = 'sku-comment-text';
      li.append(time,text); $('sku-comment-list').append(li);
    }
  }
  async function load(current) {
    message('コメントを読み込み中…');
    try {
      const result = await api(null,'?comments=1&'+new URLSearchParams(target));
      if (current !== sequence) return;
      comments = result.comments; render(); message(comments.length ? '' : 'まだコメントはありません。');
    } catch(e) { if (current === sequence) message(`${e.message}「コメントを再読込」で再試行できます。`); }
  }
  function show(next) {
    const nextKey = next ? `${next.date}/${next.item_id}/${next.sku_id}` : '';
    if (nextKey === key) return true;
    if (!canLeave()) return false;
    key = nextKey; target = next; sequence++; comments = []; attempt = null; render(); message('');
    $('sku-comments').hidden = !target;
    if (target) { $('sku-comments-title').textContent = `${target.date} のコメント`; load(sequence); }
    return true;
  }
  $('sku-comment-content').addEventListener('input',()=>{ attempt = null; message($('sku-comment-content').value ? '未送信' : ''); });
  $('sku-comment-content').addEventListener('compositionstart',()=>{composing=true;});
  $('sku-comment-content').addEventListener('compositionend',()=>{composing=false;});
  $('sku-comment-reload').addEventListener('click',()=>{if(target && !pending()) return load(++sequence);});
  $('sku-comment-submit').addEventListener('click',async()=>{
    if (!target || busy || composing) return;
    try { textLimit($('sku-comment-content').value,3000,'コメント',true); }
    catch(e) { message(e.message); return; }
    attempt ??= {action:'add_sku_comment',...target,comment_id:uuid(),content:$('sku-comment-content').value};
    busy=true; const current=++sequence;
    $('sku-comment-content').readOnly=true; $('sku-comment-submit').disabled=true; message('投稿中…');
    try {
      const result=await api(attempt); if(current!==sequence)return;
      if(!comments.some(comment=>comment.id===result.comment.id))comments.push(result.comment);
      comments.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)); render();
      $('sku-comment-content').value='';attempt=null;message('投稿しました。');
    } catch(e) { if(current===sequence)message(`${e.message} 本文は保持しています。「投稿する」で再試行してください。`); }
    finally {busy=false;$('sku-comment-content').readOnly=false;$('sku-comment-submit').disabled=false;}
  });
  document.defaultView?.addEventListener('beforeunload',event=>{if(pending()){event.preventDefault();event.returnValue='';}});
  document.addEventListener?.('click',event=>{if(event.target.closest?.('a[href]') && !canLeave())event.preventDefault();},true);
  return {show,canLeave,pending};
}
