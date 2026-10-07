import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSKUComments } from '../public/sku-comments.mjs';
class Element {
 constructor(){this.value='';this.children=[];this.listeners={};}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 addEventListener(type,fn){this.listeners[type]=fn;}
}
function setup(api){const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};const comments=setupSKUComments({getElementById:get,createElement:()=>new Element()},api,()=> '12345678-1234-4234-8234-123456789012');return {get,comments};}
const target={date:'2026-10-17',item_id:'item-14',sku_id:'real-001'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('失敗入力とUUIDを保持して再試行し、未送信・送信中の移動を防ぐ',async()=>{
 let fail=true;const requests=[];
 const ui=setup(async body=>{if(!body)return {comments:[]};requests.push(body);if(fail)throw new Error('通信失敗');return {comment:{id:body.comment_id,content:body.content,created_at:'2026-10-08T00:00:00Z'}};});
 ui.comments.show(target);await tick();ui.get('sku-comment-content').value='連絡';ui.get('sku-comment-content').listeners.input();
 assert.equal(ui.comments.show(null),false);
 await ui.get('sku-comment-submit').listeners.click();assert.equal(ui.get('sku-comment-content').value,'連絡');assert.match(ui.get('sku-comment-message').textContent,/通信失敗/);
 fail=false;await ui.get('sku-comment-submit').listeners.click();assert.equal(requests[0].comment_id,requests[1].comment_id);assert.equal(ui.get('sku-comment-content').value,'');assert.equal(ui.comments.show(null),true);
});
test('対象変更後の古い応答を破棄し、本文はHTMLとして解釈しない',async()=>{
 const resolvers=[];const ui=setup(()=>new Promise(resolve=>resolvers.push(resolve)));
 ui.comments.show(target);ui.comments.show({...target,date:'2026-10-18'});
 resolvers[1]({comments:[{id:'new',content:'<script>安全</script>',created_at:'2026-10-08T00:00:00Z'}]});await tick();
 resolvers[0]({comments:[{id:'old',content:'古い日',created_at:'2026-10-08T00:00:00Z'}]});await tick();
 const list=ui.get('sku-comment-list');assert.equal(list.children.length,1);assert.equal(list.children[0].children[1].textContent,'<script>安全</script>');assert.equal(list.children[0].children[1].innerHTML,undefined);
});


test('送信中は二重投稿と移動を拒否し、空白・過大本文を送らない',async()=>{
 let resolve;let writes=0;const ui=setup(body=>body ? (writes++,new Promise(done=>{resolve=done;})) : Promise.resolve({comments:[]}));
 ui.comments.show(target);await tick();
 for(const value of [' ','文'.repeat(3001)]){ui.get('sku-comment-content').value=value;await ui.get('sku-comment-submit').listeners.click();}assert.equal(writes,0);
 ui.get('sku-comment-content').value='送信';const saving=ui.get('sku-comment-submit').listeners.click();assert.equal(ui.comments.show(null),false);
 await ui.get('sku-comment-submit').listeners.click();assert.equal(writes,1);assert.equal(ui.get('sku-comment-content').readOnly,true);
 resolve({comment:{id:'id',content:'送信',created_at:'2026-10-08T00:00:00Z'}});await saving;assert.equal(ui.get('sku-comment-content').value,'');assert.equal(ui.get('sku-comment-submit').disabled,false);
});
