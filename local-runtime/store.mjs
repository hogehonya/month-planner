import { mkdir, readFile, readdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// One Node process owns a data directory. Serialize CAS across adapter instances.
const queues = new Map();
function validKey(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid storage key');
}
export function createDiskStore(dataDir, namespace) {
  if (!/^[a-z0-9-]+$/.test(namespace)) throw new Error('Invalid store namespace');
  const directory = join(resolve(dataDir), namespace);
  const ready = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Store must be a private directory');
  };
  const filename = key => { validKey(key); return join(directory, createHash('sha256').update(key).digest('hex') + '.json'); };
  async function read(key) {
    await ready();
    let file;
    try { file = await open(filename(key), constants.O_RDONLY | constants.O_NOFOLLOW); return JSON.parse(await file.readFile('utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await file?.close(); }
  }
  async function set(key, value, options = {}) {
    validKey(key);
    const previous = queues.get(directory) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await read(key);
      if (options.onlyIfNew && current || options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) return { modified: false, etag: current?.etag };
      const etag = randomUUID();
      const envelope = { key, etag, metadata: options.metadata ?? {}, data: Buffer.from(value).toString('base64') };
      const temporary = join(directory, '.' + randomUUID() + '.tmp');
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(JSON.stringify(envelope)); await file.sync(); await file.close(); file = null;
        await rename(temporary, filename(key));
        const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); }
        return { modified: true, etag };
      } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    queues.set(directory, operation);
    try { return await operation; } finally { if (queues.get(directory) === operation) queues.delete(directory); }
  }
  return {
    set,
    setJSON: (key, value, options) => set(key, JSON.stringify(value), options),
    async getWithMetadata(key, { type = 'text' } = {}) {
      const saved = await read(key); if (!saved) return null;
      const bytes = Buffer.from(saved.data, 'base64');
      const data = type === 'json' ? JSON.parse(bytes.toString('utf8')) : type === 'arrayBuffer' ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes.toString('utf8');
      return { data, etag: saved.etag, metadata: saved.metadata };
    },
    async get(key, options) { return (await this.getWithMetadata(key, options))?.data ?? null; },
    async list({ prefix = '' } = {}) {
      await ready(); const blobs = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const saved = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
        if (saved.key.startsWith(prefix)) blobs.push({ key: saved.key, etag: saved.etag });
      }
      return { blobs: blobs.sort((a, b) => a.key.localeCompare(b.key)) };
    }
  };
}
