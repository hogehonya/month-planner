import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDiskStore } from '../local-runtime/store.mjs';
import { createApplication } from '../local-runtime/server.mjs';
const origin = 'http://planner.test';
async function fixture(t) {
 const dir = await mkdtemp(join(tmpdir(),'planner-runtime-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
const post = body => new Request(origin+'/.netlify/functions/packaging',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('disk persistence: restart, binary metadata, namespace separation and simultaneous CAS',async t=> {
 const dir=await fixture(t),store=createDiskStore(dir,'planner');
 const first=await store.setJSON('entries/a.json',{value:1},{onlyIfNew:true});assert.equal(first.modified,true);
 const reopened=createDiskStore(dir,'planner');assert.deepEqual(await reopened.get('entries/a.json',{type:'json'}),{value:1});
 const results=await Promise.all(Array.from({length:12},(_,value)=>createDiskStore(dir,'planner').setJSON('entries/a.json',{value},{onlyIfMatch:first.etag})));
 assert.equal(results.filter(r=>r.modified).length,1);
 assert.equal((await reopened.setJSON('entries/a.json',{}, {onlyIfNew:true})).modified,false);
 assert.equal(await createDiskStore(dir,'packaging').get('entries/a.json'),null);
 const bytes=Buffer.from([0,255,137,3]);await store.set('photos/a',bytes,{metadata:{type:'image/png'}});
 const photo=await reopened.getWithMetadata('photos/a',{type:'arrayBuffer'});assert.deepEqual(Buffer.from(photo.data),bytes);assert.equal(photo.metadata.type,'image/png');
 assert.deepEqual((await reopened.list({prefix:'entries/'})).blobs.map(x=>x.key),['entries/a.json']);
 assert.equal((await stat(join(dir,'planner'))).mode & 0o777,0o700);
 await assert.rejects(store.setJSON('../escape',{}));await assert.rejects(store.get('/etc/passwd'));assert.throws(()=>createDiskStore(dir,'../escape'));
});
test('shared packaging API persists photo/SKU/sheet and rejects stale ETag after restart',async t=> {
 const dir=await fixture(t);let app=await createApplication({dataDir:dir,origin,revision:'test-revision'});
 let data=await (await app(new Request(origin+'/.netlify/functions/packaging'))).json();assert.deepEqual(data.skus,[]);assert.deepEqual(data.sheets,[]);
 const photo=Buffer.from([137,80,78,71,13,10,26,10,0]);
 const sku={action:'save_sku',item_id:data.items[0].id,id:'local-1',name:'Local',type:'',note:'',photo:{type:'image/png',data:photo.toString('base64')}};
 assert.equal((await app(post(sku))).status,200);
 app=await createApplication({dataDir:dir,origin});data=await (await app(new Request(origin+'/.netlify/functions/packaging'))).json();assert.equal(data.skus.length,1);
 const saved=data.skus[0];assert.ok(saved.etag);
 const response=await app(new Request(origin+'/.netlify/functions/packaging?photo='+saved.photo_id));assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),photo);
 const sheet={action:'save_sheet',date:'2026-10-17',rows:[{item_id:saved.item_id,sku_id:saved.id,price_yen:200,planned_quantity:4,prepared_quantity:null}]};
 assert.equal((await app(post(sheet))).status,200);assert.equal((await app(post(sheet))).status,409);
 const other=await createApplication({dataDir:join(dir,'independent'),origin});assert.deepEqual((await (await other(new Request(origin+'/.netlify/functions/packaging'))).json()).skus,[]);
});
test('HTTP application: origin/method/body/path protection, headers, health and absent PIN',async t=> {
 const dir=await fixture(t),app=await createApplication({dataDir:dir,origin,revision:'abc',getPin:()=>undefined});
 assert.deepEqual(await (await app(new Request(origin+'/healthz'))).json(),{ok:true,revision:'abc'});
 const html=await app(new Request(origin+'/'));assert.equal(html.status,200);assert.match(html.headers.get('content-type'),/text\/html/);assert.equal(html.headers.get('x-frame-options'),'DENY');assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await app(new Request(origin+'/',{method:'HEAD'}))).body,null);
 for(const path of ['/.env','/%2e%2e%2fpackage.json','/local-runtime/server.mjs','/missing']) assert.equal((await app(new Request(origin+path))).status,404,path);
 await mkdir(join(dir,'static'));await writeFile(join(dir,'static','index.html'),'test');await symlink(resolve('package.json'),join(dir,'static','leak'));
 const staticApp=await createApplication({dataDir:join(dir,'private'),publicDir:join(dir,'static'),origin});assert.equal((await staticApp(new Request(origin+'/leak'))).status,404);
 for(const method of ['PUT','DELETE','OPTIONS']) assert.equal((await app(new Request(origin+'/.netlify/functions/packaging',{method}))).status,405);
 for(const foreign of [null,'http://evil.test']) {
  const headers={'Content-Type':'application/json'};if(foreign)headers.Origin=foreign;
  assert.equal((await app(new Request(origin+'/.netlify/functions/packaging',{method:'POST',headers,body:'{}'}))).status,403);
 }
 assert.equal((await app(new Request('http://evil.test/healthz'))).status,403);
 assert.equal((await app(new Request(origin+'/.netlify/functions/packaging',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:' '.repeat(4400001)}))).status,413);
 const pinRequest=new Request(origin+'/.netlify/functions/planner',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:'verify',pin:'not-configured'})});assert.equal((await app(pinRequest)).status,503);
 await assert.rejects(createApplication({dataDir:resolve('public'),origin}));
});
test('planner handler contract writes and reads notes/history using durable store',async t=> {
 const dir=await fixture(t),app=await createApplication({dataDir:dir,origin,getPin:()=> 'test-only-pin'});
 const response=await app(new Request(origin+'/.netlify/functions/planner',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:'save',entry_date:'2026-10-17',editor_name:'Test',pin:'test-only-pin',field:'note',value:'persistent note'})}));assert.equal(response.status,200);
 const reopened=await createApplication({dataDir:dir,origin});const data=await (await reopened(new Request(origin+'/.netlify/functions/planner?start=2026-10-17&end=2026-10-17'))).json();assert.equal(data.entries[0].note,'persistent note');assert.equal(data.history.length,1);
});
