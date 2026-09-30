import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AutoSync, AutoSyncClock } from '../src/auto.js';

/**
 * A fake ciphertext-only sync server (same wire contract as apps/sync-server)
 * and a manual clock for the AutoSync engine, shared by the ADR 0044 and ADR
 * 0063 suites.
 */

export type Mode = 'ok' | 'subscription' | 'crash' | 'slow-blob' | 'garbage-blob' | 'slow-put' | 'slow-fail-put';

export function fakeServer(): {
  server: Server;
  url: () => string;
  version: () => number;
  mode: (m: Mode) => void;
  omitSha: (v: boolean) => void;
  conflictOnce: () => void;
  parked: () => Promise<void>;
  release: () => void;
} {
  let blob: Buffer | null = null;
  let version = 0;
  let mode: Mode = 'ok';
  let noSha = false;
  /** Answer exactly one PUT with a 409 at the current version, then behave. */
  let conflictNext = false;
  /** Responses a slow mode is holding back, and waiters for the next one to be held. */
  const held: (() => void)[] = [];
  const parkWaiters: (() => void)[] = [];
  const park = (respond: () => void) => {
    held.push(respond);
    for (const w of parkWaiters.splice(0)) w();
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (mode === 'crash') {
        res.writeHead(500).end();
        return;
      }
      if (mode === 'subscription') {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'subscribe', subscribe: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        if (blob === null) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const junkStatus = mode === 'garbage-blob';
        const junk = Buffer.concat([Buffer.from('NKV1'), Buffer.alloc(200, 9)]);
        const statusBody: Record<string, unknown> = {
          version: junkStatus ? version + 5 : version,
          size: blob.length,
          updatedAt: new Date().toISOString(),
        };
        if (!noSha) statusBody.sha256 = junkStatus ? sha(junk) : sha(blob);
        res.end(JSON.stringify(statusBody));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/blob') {
        if (blob === null) {
          res.writeHead(404).end();
          return;
        }
        if (mode === 'garbage-blob') {
          const junk = Buffer.concat([Buffer.from('NKV1'), Buffer.alloc(200, 9)]);
          res.writeHead(200, { 'x-version': String(version + 5), 'x-sha256': sha(junk) });
          res.end(junk);
          return;
        }
        const send = () => {
          res.writeHead(200, noSha ? { 'x-version': String(version) } : { 'x-version': String(version), 'x-sha256': sha(blob!) });
          res.end(blob);
        };
        if (mode === 'slow-blob') park(send);
        else send();
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/blob') {
        // A PUT that is parked and then fails: status and blob keep working,
        // so a write can land while a manual push is in flight and losing.
        if (mode === 'slow-fail-put') {
          park(() => res.writeHead(500).end());
          return;
        }
        const base = Number(req.headers['x-base-version'] ?? '0');
        if (conflictNext) {
          conflictNext = false;
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version }));
          return;
        }
        if (base !== version) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version }));
          return;
        }
        const accept = () => {
          blob = Buffer.concat(chunks);
          version += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version }));
        };
        if (mode === 'slow-put') park(accept);
        else accept();
        return;
      }
      res.writeHead(404).end();
    });
  });
  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    version: () => version,
    mode: (m) => {
      mode = m;
    },
    omitSha: (v) => {
      noSha = v;
    },
    conflictOnce: () => {
      conflictNext = true;
    },
    /** Resolves once a slow mode is holding a request. */
    parked: () => (held.length > 0 ? Promise.resolve() : new Promise<void>((r) => parkWaiters.push(r))),
    /** Sends every held response. */
    release: () => {
      for (const respond of held.splice(0)) respond();
    },
  };
}

export function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The engine's clock. Nothing fires until advance(), which fires each timer
 * that falls due in time order and waits for the engine to finish the work
 * that timer queued (real disk and HTTP) before firing the next.
 */
export class ManualClock implements AutoSyncClock {
  private t = Date.now();
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Timers still waiting to fire. */
  pending(): number {
    return this.timers.size;
  }
  /** Fires the timers due within ms without waiting for what they start (for a request the server holds). */
  fire(ms: number): void {
    const end = this.t + ms;
    for (let next = this.nextDue(end); next; next = this.nextDue(end)) this.run(next);
    this.t = end;
  }
  async advance(ms: number, auto: AutoSync): Promise<void> {
    const end = this.t + ms;
    await auto.whenIdle();
    for (let next = this.nextDue(end); next; next = this.nextDue(end)) {
      this.run(next);
      await auto.whenIdle();
    }
    this.t = end;
  }
  private nextDue(end: number): [number, { at: number; fn: () => void }] | undefined {
    return [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  }
  private run([id, timer]: [number, { at: number; fn: () => void }]): void {
    this.timers.delete(id);
    this.t = Math.max(this.t, timer.at);
    timer.fn();
  }
}
