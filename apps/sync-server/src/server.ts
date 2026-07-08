#!/usr/bin/env node
import http from 'node:http';
import { handleSync, MAX_BLOB_BYTES, type SyncRequest } from './handler.js';
import type { Storage } from './storage.js';

/**
 * A plain node:http wrapper around the sync handler — used for self-hosting,
 * local dev, and the e2e harness (which injects InMemoryStorage). Production
 * on Vercel uses the thin function adapters in `api/` instead, over the same
 * `handleSync` logic. No web framework (repo convention).
 */

export function createSyncServer(storage: Storage): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      // Never leak internals: status-only error, no body echoing.
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const baseHeader = req.headers['x-base-version'];
    const baseVersion = typeof baseHeader === 'string' ? Number(baseHeader) : null;

    const body = req.method === 'PUT' ? await readBody(req) : null;

    const request: SyncRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      token,
      baseVersion: baseVersion === null || Number.isNaN(baseVersion) ? null : baseVersion,
      body,
    };
    const result = await handleSync(request, storage);
    const isBuffer = result.body instanceof Buffer;
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      ...(result.headers ?? {}),
      ...(!isBuffer && result.body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    res.writeHead(result.status, headers);
    if (isBuffer) res.end(result.body as Buffer);
    else if (result.body !== undefined) res.end(JSON.stringify(result.body));
    else res.end();
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BLOB_BYTES + 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Run directly (self-host / local): Neon-backed, announces its URL on stdout.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const { NeonStorage } = await import('./neon-storage.js');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const storage = new NeonStorage(databaseUrl);
  await storage.ensureSchema();
  const port = Number(process.env.PORT ?? 8787);
  createSyncServer(storage).listen(port, () => {
    console.log(`NORTHKEEP_SYNC_URL=http://127.0.0.1:${port}`);
  });
}
