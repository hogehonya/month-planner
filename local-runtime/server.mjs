import { createServer } from 'node:http';
import { readFile, realpath, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler as planner } from '../netlify/functions/planner.mjs';
import { createHandler as packaging } from '../netlify/functions/packaging.mjs';
import { createDiskStore } from './store.mjs';
import { createOnlineSync } from './online-sync.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export async function createApplication({ dataDir, publicDir = resolve(root, 'public'), origin, revision = 'unknown', getPin = () => process.env.EDIT_PIN, onlineSource = process.env.ONLINE_SOURCE_ORIGIN, fetchRemote = fetch, now = Date.now } = {}) {
  if (!dataDir) throw new Error('DATA_DIR is required');
  const canonicalOrigin = new URL(origin).origin;
  if (canonicalOrigin !== origin || !/^https?:/.test(origin)) throw new Error('APP_ORIGIN must be an HTTP(S) origin');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const publicRoot = await realpath(publicDir), storageRoot = await realpath(dataDir);
  if (inside(publicRoot, storageRoot) || inside(storageRoot, publicRoot)) throw new Error('DATA_DIR must be separate from public');
  // Read the same configured response headers used by Netlify, without a second policy copy.
  const config = await readFile(resolve(root, 'netlify.toml'), 'utf8');
  const headerBlock = config.split('[headers.values]')[1]?.split('\n[')[0];
  if (!headerBlock) throw new Error('Netlify security headers are missing');
  const security = Object.fromEntries([...headerBlock.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/gm)].map(match => [match[1], match[2]]));
  const sync = await createOnlineSync({dataDir:storageRoot,source:onlineSource,fetchRemote,now});
  const routes = new Map([
    ['/.netlify/functions/planner', planner({ getStore: () => createDiskStore(storageRoot, 'shared-planner'), getPin })],
    ['/api/online-sync', request=>sync.handle(request)],
    ['/.netlify/functions/packaging', request=>sync.withStore(async store=> {
      const response = await packaging({getStore:()=>store})(request);
      if (request.method === 'GET' && !new URL(request.url).search && response.ok) {
        const data = await response.json();
        return Response.json({...data,online_sync:{enabled:true,source:sync.source}},{status:response.status,headers:response.headers});
      }
      return response;
    })]
  ]);
  return async request => {
    let response;
    try {
      const url = new URL(request.url), handler = routes.get(url.pathname);
      if (url.origin !== canonicalOrigin) response = Response.json({ error: 'Invalid host' }, { status: 403 });
      else if (handler) {
        if (!['GET', 'POST'].includes(request.method)) response = new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
        else if (request.method === 'POST' && request.headers.get('origin') !== canonicalOrigin) response = Response.json({ error: 'Same-origin request required' }, { status: 403 });
        else response = await handler(request);
      } else if (!['GET', 'HEAD'].includes(request.method)) response = new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      else if (url.pathname === '/healthz') response = Response.json({ ok: true, revision }, { headers: { 'Cache-Control': 'no-store' } });
      else {
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); } catch { pathname = ''; }
        if (!pathname || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) response = new Response('Not found', { status: 404 });
        else {
          const file = await realpath(resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname)));
          if (!inside(publicRoot, file)) response = new Response('Not found', { status: 404 });
          else response = new Response(await readFile(file), { headers: { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' } });
        }
      }
    } catch (error) {
      response = new Response(error.code === 'ENOENT' || error.code === 'EISDIR' ? 'Not found' : 'Service unavailable', { status: ['ENOENT', 'EISDIR'].includes(error.code) ? 404 : 503 });
    }
    for (const [key, value] of Object.entries(security)) response.headers.set(key, value);
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  };
}
export function createHttpServer(application, origin) {
  return createServer({ requestTimeout: 30000, headersTimeout: 15000, maxHeaderSize: 16384 }, async (incoming, outgoing) => {
    try {
      const base = new URL(origin);
      if (incoming.headers.host !== base.host) { outgoing.writeHead(403); outgoing.end('Invalid host'); incoming.resume(); return; }
      const url = new URL(incoming.url, base);
      if (url.origin !== base.origin) { outgoing.writeHead(403); outgoing.end(); incoming.resume(); return; }
      const limit = url.pathname === '/.netlify/functions/packaging' ? 4400000
        : url.pathname === '/.netlify/functions/planner' && url.searchParams.get('action') === 'upload_photo' ? 2 * 1024 * 1024 : 262144;
      let size = 0; const chunks = [];
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > limit) { outgoing.writeHead(413, { Connection: 'close' }); outgoing.end('Request too large'); return; }
        chunks.push(chunk);
      }
      const method = incoming.method;
      const request = new Request(url, { method, headers: incoming.headers, ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await application(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.headersSent) outgoing.writeHead(400); outgoing.end('Invalid request'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.APP_ORIGIN;
  const application = await createApplication({ dataDir: process.env.DATA_DIR, origin, revision: process.env.APP_REVISION });
  const server = createHttpServer(application, origin);
  server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
