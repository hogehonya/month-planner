import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, createHttpServer } from '../local-runtime/server.mjs';
test('real HTTP transport enforces Host, methods, origin, body limits and health',async t=> {
 const dataDir=await mkdtemp(join(tmpdir(),'planner-http-')),origin='http://planner.test';
 const app=await createApplication({dataDir,origin,revision:'transport'}),server=createHttpServer(app,origin);
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const send=(path,method='GET',body='',headers={})=>new Promise((resolve,reject)=> {
  const req=httpRequest({host:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'planner.test',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);
 });
 assert.deepEqual(JSON.parse((await send('/healthz')).body),{ok:true,revision:'transport'});
 assert.equal((await send('/healthz','GET','',{Host:'evil.test'})).status,403);
 assert.equal((await send('/.netlify/functions/packaging','DELETE')).status,405);
 assert.equal((await send('/.netlify/functions/packaging','POST','{}',{'Content-Type':'application/json'})).status,403);
 assert.equal((await send('/.netlify/functions/planner','POST','x'.repeat(262145),{Origin:origin,'Content-Type':'application/json'})).status,413);
 assert.equal((await send('/')).status,200);
});
test('planner photos up to 2MiB pass HTTP and retain binary bytes after restart', async t => {
 const dataDir = await mkdtemp(join(tmpdir(), 'planner-photo-http-')), origin = 'http://planner.test';
 const server = createHttpServer(await createApplication({ dataDir, origin, getPin: () => 'test-pin' }), origin);
 t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
 server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const bytes = Buffer.alloc(2 * 1024 * 1024); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
 Buffer.from('0000000049454e44ae426082', 'hex').copy(bytes, bytes.length - 12);
 const path = '/.netlify/functions/planner?action=upload_photo&entry_date=2026-10-05&slot=slot1';
 const send = body => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { Host: 'planner.test', Origin: origin, 'Content-Type': 'image/png', 'X-Edit-Pin': 'test-pin', 'X-Editor-Name': encodeURIComponent('写真担当') } }, res => {
   const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  }); req.on('error', reject); req.end(body);
 });
 const uploaded = await send(bytes); assert.equal(uploaded.status, 200);
 const photo = JSON.parse(uploaded.body).row.slot1_photo;
 const reopened = await createApplication({ dataDir, origin, getPin: () => 'test-pin' });
 const response = await reopened(new Request(origin + photo.url));
 assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
 assert.equal((await send(Buffer.alloc(bytes.length + 1))).status, 413);
});
