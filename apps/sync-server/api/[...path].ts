import type { IncomingMessage, ServerResponse } from 'node:http';
// Imports the BUILT logic (Vercel runs the package build first — see vercel.json).
import { handleSync, MAX_BLOB_BYTES, type SyncRequest } from '../dist/handler.js';
import { NeonStorage } from '../dist/neon-storage.js';

/**
 * Vercel serverless adapter. Thin glue: parse the request, call the shared
 * `handleSync` logic (same code the node:http server and the e2e suite run),
 * write the response. All the security-critical behavior lives in handler.ts.
 * The DB schema is provisioned once at deploy time (SCHEMA_SQL), not here.
 */

let storage: NeonStorage | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server not configured' }));
      return;
    }
    storage ??= new NeonStorage(databaseUrl);

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
    res.writeHead(result.status, { 'cache-control': 'no-store', ...(result.headers ?? {}) });
    if (result.body instanceof Buffer) {
      res.end(result.body);
    } else if (result.body !== undefined) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result.body));
    } else {
      res.end();
    }
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
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
