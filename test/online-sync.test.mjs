import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../local-runtime/server.mjs';
import { createDiskStore } from '../local-runtime/store.mjs';
import { createHandler } from '../netlify/functions/packaging.mjs';
import { exportPackaging, validateManifest } from '../netlify/lib/packaging-export.mjs';
const localOrigin='http://local.test',source='https://online.test';
const photoID='11111111-1111-4111-8111-111111111111',commentID='22222222-2222-4222-8222-222222222222';
const photo=Buffer.from([137,80,78,71,13,10,26,10,1]);
const sku={item_id:'item-01',id:'onion',name:'Online onion',type:'',note:'original note',packaging_condition:'bag',cultivation_method:'organic',price_yen:200,photo_id:photoID,updated_at:'2026-10-08T01:02:03.000Z'};
const sheet={date:'2026-10-17',rows:[{item_id:'item-01',sku_id:'onion',price_yen:200,planned_quantity:10,prepared_quantity:2,status_bits:7}]};
const comment={id:commentID,content:'orphan date comment',created_at:'2026-10-08T02:03:04.000Z'};
const commentKey=`sku-comments/2026-12-31/item-01/onion/${commentID}.json`;
async function setup(t) {
 const root=await mkdtemp(join(tmpdir(),'online-sync-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const remote=createDiskStore(join(root,'remote'),'packaging-master'),local=createDiskStore(join(root,'local'),'packaging-master');
 await remote.setJSON('skus/item-01/onion.json',sku);await remote.setJSON('menu-sheets/2026-10-17.json',sheet);await remote.setJSON(commentKey,comment);await remote.set(`photos/${photoID}`,photo,{metadata:{type:'image/png'}});
 await local.setJSON('skus/item-01/local.json',{...sku,id:'local',name:'Local-only',photo_id:null});
 const handler=createHandler({getStore:()=>remote}),calls=[];let intercept=null,clock=Date.parse('2026-10-08T03:00:00.000Z');
 const fetchRemote=async(url,options)=> {
  calls.push({url,options});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(url.startsWith(source+'/.netlify/functions/packaging?'));
  return await intercept?.(url,options) ?? handler(new Request(url));
 };
 const create=()=>createApplication({dataDir:join(root,'local'),origin:localOrigin,onlineSource:source,fetchRemote,now:()=>clock});
 const app=await create();
 const request=(body,headers={})=>new Request(localOrigin+'/api/online-sync',{method:'POST',headers:{Origin:localOrigin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const sync=body=>app(request(body));
 const snapshot=async(application=app)=> (await application(new Request(localOrigin+'/.netlify/functions/packaging'))).json();
 return {root,remote,local,app,create,calls,request,sync,snapshot,setIntercept:value=>{intercept=value;},advance:()=>{clock+=600001;}};
}
test('read-only complete export includes orphan-date comments and deterministic photo identity/hash',async t=> {
 const ui=await setup(t),handler=createHandler({getStore:()=>ui.remote});
 const data=await (await handler(new Request(source+'/.netlify/functions/packaging?export=1'))).json();
 assert.deepEqual(data,await exportPackaging(ui.remote));assert.ok(data.records.some(row=>row.key===commentKey));assert.equal(data.photos[0].id,photoID);assert.equal(data.photos[0].references,1);assert.equal(data.photos[0].size,photo.length);
 assert.equal((await (await handler(new Request(source+'/.netlify/functions/packaging'))).json()).online_sync,undefined);
 const before=await ui.remote.list({prefix:''});await handler(new Request(source+'/.netlify/functions/packaging?export=1'));assert.deepEqual(await ui.remote.list({prefix:''}),before);
 const unsafe=structuredClone(data);unsafe.records[0].key='../escape';assert.throws(()=>validateManifest(unsafe));
 const incomplete=structuredClone(data);incomplete.photos=[];assert.throws(()=>validateManifest(incomplete));
});
test('preview does not change active data; confirmed replace persists exact IDs/times and restart with prior namespace retained',async t=> {
 const ui=await setup(t),before=await ui.snapshot();assert.deepEqual(before.online_sync,{enabled:true,source});
 const preview=await ui.sync({action:'preview'});assert.equal(preview.status,200);const plan=await preview.json();
 assert.deepEqual(await ui.snapshot(),before);assert.equal(plan.summary.skus.added,1);assert.equal(plan.summary.skus.removed,1);assert.equal(plan.summary.comments.added,1);assert.equal(plan.summary.photos.added,1);assert.match(plan.expires_at,/Z$/);
 const entry=plan.changes.find(row=>row.kind==='comments');assert.deepEqual(entry.after,comment);assert.match(entry.label,/2026-12-31.*Online onion/);
 assert.equal((await ui.sync({action:'apply',token:plan.token})).status,200);
 const result=await ui.snapshot();assert.equal(result.skus.length,1);assert.equal(result.skus[0].id,'onion');assert.equal(result.skus[0].updated_at,sku.updated_at);assert.equal(result.skus[0].photo_id,photoID);assert.deepEqual(result.sheets[0].rows,sheet.rows);
 const fetched=await ui.app(new Request(localOrigin+'/.netlify/functions/packaging?photo='+photoID));assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),photo);
 const comments=await (await ui.app(new Request(localOrigin+'/.netlify/functions/packaging?comments=1&date=2026-12-31&item_id=item-01&sku_id=onion'))).json();assert.deepEqual(comments,{comments:[comment]});
 assert.deepEqual(await ui.snapshot(await ui.create()),result);
 assert.equal((await ui.local.get('skus/item-01/local.json',{type:'json'})).name,'Local-only');
 assert.ok((await readdir(join(ui.root,'local'))).includes('packaging-master'));
 assert.equal((await ui.sync({action:'apply',token:plan.token})).status,409);assert.ok(ui.calls.every(call=>call.options.method==='GET'));
 const exported=await (await ui.app(new Request(localOrigin+'/.netlify/functions/packaging?export=1'))).json();assert.equal(exported.records.find(row=>row.key===commentKey).data.created_at,comment.created_at);assert.equal(exported.online_sync,undefined);
});
test('failed photo, redirects, malformed/incomplete export never replace active namespace',async t=> {
 const ui=await setup(t),before=await ui.snapshot();
 ui.setIntercept(url=>url.includes('?photo=') ? new Response('failed',{status:502}) : null);assert.equal((await ui.sync({action:'preview'})).status,502);assert.deepEqual(await ui.snapshot(),before);
 ui.setIntercept(()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1/'}}));assert.equal((await ui.sync({action:'preview'})).status,502);
 ui.setIntercept(()=>Response.json({version:1,records:[{key:'../../secret',data:{},etag:'x'}],photos:[]}));assert.equal((await ui.sync({action:'preview'})).status,502);
 ui.setIntercept(async()=>{const data=await exportPackaging(ui.remote);data.photos=[];return Response.json(data);});assert.equal((await ui.sync({action:'preview'})).status,502);
 assert.deepEqual(await ui.snapshot(),before);assert.equal((await readdir(join(ui.root,'local'))).includes('packaging-current.json'),false);
});
test('all local namespace writes including comments invalidate preview; remote mutations and TTL reject apply',async t=> {
 const ui=await setup(t);let plan=await (await ui.sync({action:'preview'})).json();
 await ui.local.setJSON(`sku-comments/2027-01-01/item-01/local/${commentID}.json`,comment);
 assert.equal((await ui.sync({action:'apply',token:plan.token})).status,409);assert.equal((await ui.snapshot()).skus[0].id,'local');
 plan=await (await ui.sync({action:'preview'})).json();await ui.remote.setJSON(commentKey,{...comment,content:'changed online'});
 assert.equal((await ui.sync({action:'apply',token:plan.token})).status,409);
 plan=await (await ui.sync({action:'preview'})).json();ui.advance();assert.equal((await ui.sync({action:'apply',token:plan.token})).status,409);
 assert.equal((await ui.sync({action:'apply',token:'unknown'})).status,409);
});
test('photo or manifest changes during preview reject the staged snapshot; repeated preview invalidates old token',async t=> {
 const ui=await setup(t);let exports=0;
 ui.setIntercept(async url=>{if(url.includes('?export=')){exports++;if(exports===2)await ui.remote.setJSON(commentKey,{...comment,content:'during download'});}return null;});
 assert.equal((await ui.sync({action:'preview'})).status,409);ui.setIntercept(null);
 const first=await (await ui.sync({action:'preview'})).json(),second=await (await ui.sync({action:'preview'})).json();assert.notEqual(first.token,second.token);
 assert.equal((await ui.sync({action:'apply',token:first.token})).status,409);assert.equal((await ui.sync({action:'apply',token:second.token})).status,200);
});
test('same-origin JSON action restrictions, body bounds, fixed source and invalid generation fail closed',async t=> {
 const ui=await setup(t);
 assert.equal((await ui.app(ui.request({action:'preview'},{Origin:'https://evil.test'}))).status,403);
 assert.equal((await ui.app(ui.request({action:'preview'},{'Content-Type':'text/plain'}))).status,415);
 assert.equal((await ui.sync({action:'preview',url:'http://127.0.0.1/'})).status,400);
 assert.equal((await ui.sync({action:'apply',token:'x'.repeat(4097)})).status,413);
 assert.equal((await ui.app(new Request(localOrigin+'/api/online-sync'))).status,405);
 for(const onlineSource of ['http://online.test','https://user:pass@online.test','https://online.test/path','https://online.test?x=1']) await assert.rejects(createApplication({dataDir:join(ui.root,'invalid'),origin:localOrigin,onlineSource}));
 await writeFile(join(ui.root,'local','packaging-current.json'),JSON.stringify({version:1,generation:'../../escape'}));await assert.rejects(ui.create());
 await writeFile(join(ui.root,'local','packaging-current.json'),JSON.stringify({version:1,generation:photoID}));await assert.rejects(ui.create());
});
test('local edits while remote apply-check is awaiting response are preserved by fingerprint under request mutex',async t=> {
 const ui=await setup(t),plan=await (await ui.sync({action:'preview'})).json();let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
 ui.setIntercept(async()=>{entered();await gate;return null;});const applying=ui.sync({action:'apply',token:plan.token});await ready;
 const row=(await ui.snapshot()).skus[0];
 const saved=await ui.app(new Request(localOrigin+'/.netlify/functions/packaging',{method:'POST',headers:{Origin:localOrigin,'Content-Type':'application/json'},body:JSON.stringify({...row,action:'save_sku',name:'Concurrent local edit'})}));assert.equal(saved.status,200);
 release();assert.equal((await applying).status,409);assert.equal((await ui.snapshot()).skus[0].name,'Concurrent local edit');
});
