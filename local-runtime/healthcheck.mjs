import { get } from 'node:http';

try {
  const host = new URL(process.env.APP_ORIGIN).host;
  const expectedRevision = process.argv[2] || process.env.APP_REVISION;
  if (!expectedRevision) throw new Error('APP_REVISION is required');
  await new Promise((resolve, reject) => {
    const request = get({
      hostname: '127.0.0.1',
      port: process.env.PORT || 3000,
      path: '/healthz',
      headers: { Host: host },
      agent: false,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Unexpected health status');
          const health = JSON.parse(body);
          if (health.ok !== true || health.revision !== expectedRevision) throw new Error('Unexpected health revision');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error('Healthcheck timeout')), 4000);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
  });
  console.log(`Healthy revision ${expectedRevision}`);
} catch {
  console.error('Healthcheck failed');
  process.exitCode = 1;
}
