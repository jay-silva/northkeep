#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultVaultPath } from '@northkeep/core';
import { handleApi } from './api.js';
import { handleConverseStream } from './converse.js';
import { UiSession } from './session.js';

/**
 * NorthKeep's local GUI server. Security model (ADR 0004):
 *  - binds 127.0.0.1 only, random port by default
 *  - every /api call requires the per-session token (constant-time compare)
 *  - Host header must be loopback (DNS-rebinding defense)
 *  - strict CSP; the page loads nothing external and connects only to itself
 */

const MAX_BODY = 512 * 1024 * 1024;

export interface UiServerOptions {
  vaultPath?: string;
  port?: number;
  /** Print the ready line (`NORTHKEEP_UI_URL=…`) to stdout — the Tauri shell
   * and `northkeep ui` read it. */
  announce?: boolean;
}

export interface RunningUiServer {
  url: string;
  close(): Promise<void>;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<RunningUiServer> {
  const vaultPath = options.vaultPath ?? defaultVaultPath();
  const session = new UiSession(vaultPath);
  const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
  const indexHtml = fs.readFileSync(path.join(staticDir, 'index.html'));

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'",
    );
    res.setHeader('Cache-Control', 'no-store');

    const url = new URL(req.url ?? '/', `http://${host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(indexHtml);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!session.checkToken(req.headers['x-northkeep-token'] as string | undefined)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Missing or invalid session token.' }));
        return;
      }
      const body = await readBody(req);
      // Converse streams NDJSON as the model answers — it owns the response.
      if (req.method === 'POST' && url.pathname === '/api/converse') {
        await handleConverseStream(session, body, res);
        return;
      }
      const result = await handleApi(
        session,
        req.method ?? 'GET',
        url.pathname,
        url.searchParams,
        body,
      );
      res.statusCode = result.status;
      if (result.contentType) {
        res.setHeader('Content-Type', result.contentType);
        res.end(String(result.body));
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result.body));
      }
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/?token=${session.token}`;
  if (options.announce) {
    console.log(`NORTHKEEP_UI_URL=${url}`);
  }
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        session.lock();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Executed directly (Tauri shell / manual): start and announce.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const portArg = process.argv.indexOf('--port');
  startUiServer({
    announce: true,
    port: portArg !== -1 ? Number(process.argv[portArg + 1]) || 0 : 0,
  })
    .then((running) => {
      // The desktop shell (ADR 0012) sends SIGTERM on quit expecting us to
      // zeroize the vault master key before exiting. `close()` runs
      // session.lock() (which zeroes the key) then shuts the listener.
      // Without this, default SIGTERM would kill the process with the key
      // still resident. Idempotent-guarded so a SIGTERM→SIGKILL race is safe.
      let closing = false;
      const shutdown = (): void => {
        if (closing) return;
        closing = true;
        void running.close().then(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
