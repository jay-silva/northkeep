import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addGrant,
  clearGrants,
  createPermissionEngine,
  listGrants,
  loadPermissions,
  permissionsPath,
  removeGrant,
  type PermissionRequest,
} from '../src/index.js';

/**
 * M10c — the ADR-0029 permission engine (~/.northkeep/permissions.json).
 * Same file idiom as tools.json: 0600, tolerant loader, strict writer; a
 * grant the loader cannot fully validate does not exist, and no grant means
 * ASK (fail closed — asking always puts a human back in the loop).
 */

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  tool: 'web_fetch',
  argsPlain: '{"url":"https://example.com/"}',
  risk: 'safe-read',
  modelTier: 'bounded',
  toolEgress: { host: 'example.com', tier: 'bounded' },
  ...over,
});

describe('permissions store', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-policy-'));
    priorHome = process.env.NORTHKEEP_HOME;
    process.env.NORTHKEEP_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('defaults to no grants when no file exists', () => {
    expect(loadPermissions()).toEqual({ version: 1, grants: [] });
    expect(listGrants()).toEqual([]);
  });

  it('fails CLOSED on garbage (unparseable file → no grants)', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(permissionsPath(), 'not json {{{');
    expect(loadPermissions().grants).toEqual([]);
  });

  it('drops invalid entries, keeps valid ones (tolerant per-entry read)', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      permissionsPath(),
      JSON.stringify({
        version: 1,
        grants: [
          { tool: 'web_fetch', host: 'good.example', scope: 'always', createdAt: '2026-07-24T00:00:00Z' },
          { tool: 'web_fetch', host: 'bad.example', scope: 'sometimes', createdAt: 'x' }, // unknown scope
          { tool: 'web_fetch', host: 'bad2.example', scope: 'session', createdAt: 'x' }, // session never persists
          { tool: 42, host: 'bad3.example', scope: 'always', createdAt: 'x' }, // wrong type
          { tool: 'web_fetch', scope: 'always', createdAt: 'x' }, // missing host
          'not even an object',
        ],
      }),
    );
    expect(loadPermissions().grants).toEqual([
      { tool: 'web_fetch', host: 'good.example', scope: 'always', createdAt: '2026-07-24T00:00:00Z' },
    ]);
  });

  it('ignores a file with the wrong version entirely (unknown format → no grants)', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      permissionsPath(),
      JSON.stringify({
        version: 2,
        grants: [{ tool: 'web_fetch', host: 'a.example', scope: 'always', createdAt: 'x' }],
      }),
    );
    expect(loadPermissions().grants).toEqual([]);
  });

  it('ignores a partial file with grants that is not an array', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(permissionsPath(), JSON.stringify({ version: 1, grants: { oops: true } }));
    expect(loadPermissions().grants).toEqual([]);
  });

  it('writes 0600 and round-trips, lowercasing the host', () => {
    addGrant('web_fetch', 'Example.COM', 'always');
    const mode = fs.statSync(permissionsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    const grants = listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.host).toBe('example.com');
    expect(grants[0]!.scope).toBe('always');
  });

  it('re-applies 0600 to a PRE-EXISTING loose-permission grants file (G1 review)', () => {
    // writeFileSync's mode only applies on CREATE; an attacker or a loose
    // umask could leave an existing file world-readable. chmod every write.
    fs.writeFileSync(permissionsPath(), '{"version":1,"grants":[]}\n', { mode: 0o644 });
    expect(fs.statSync(permissionsPath()).mode & 0o777).toBe(0o644);
    addGrant('web_fetch', 'example.com', 'always');
    expect(fs.statSync(permissionsPath()).mode & 0o777).toBe(0o600);
  });

  it('upserts on the (tool, host) key, case-insensitively', () => {
    addGrant('web_fetch', 'example.com', 'always');
    addGrant('web_fetch', 'EXAMPLE.com', 'never'); // same key → replace
    const grants = listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scope).toBe('never');
  });

  it('removeGrant reports whether anything was removed', () => {
    addGrant('web_fetch', 'example.com', 'always');
    expect(removeGrant('web_fetch', 'nope.example')).toBe(false);
    expect(removeGrant('web_fetch', 'Example.Com')).toBe(true);
    expect(listGrants()).toEqual([]);
  });

  it('clearGrants returns how many were removed', () => {
    addGrant('web_fetch', 'a.example', 'always');
    addGrant('web_fetch', 'b.example', 'never');
    expect(clearGrants()).toBe(2);
    expect(clearGrants()).toBe(0);
    expect(listGrants()).toEqual([]);
  });
});

describe('permission engine (evaluate decision order)', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-policy-'));
    priorHome = process.env.NORTHKEEP_HOME;
    process.env.NORTHKEEP_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('no grant → ask (fail closed default)', async () => {
    const engine = createPermissionEngine();
    await expect(engine.evaluate(req())).resolves.toBe('ask');
  });

  it("step 1: 'never' beats everything, including a session allow", async () => {
    const engine = createPermissionEngine();
    engine.record('web_fetch', 'example.com', 'session');
    engine.record('web_fetch', 'example.com', 'never');
    await expect(engine.evaluate(req())).resolves.toBe('deny');
  });

  it("step 2: consequential NEVER auto-allows, grants notwithstanding", async () => {
    const engine = createPermissionEngine({ persist: true });
    addGrant('web_fetch', 'example.com', 'always');
    engine.record('web_fetch', 'example.com', 'session');
    await expect(engine.evaluate(req({ risk: 'consequential' }))).resolves.toBe('ask');
  });

  it('step 3: a screened call never auto-allows, grants notwithstanding', async () => {
    const engine = createPermissionEngine({ persist: true });
    addGrant('web_fetch', 'example.com', 'always');
    engine.record('web_fetch', 'example.com', 'session');
    await expect(engine.evaluate(req({ screened: true }))).resolves.toBe('ask');
  });

  it("a screened call with a 'never' grant still denies (step 1 first)", async () => {
    const engine = createPermissionEngine();
    engine.record('web_fetch', 'example.com', 'never');
    await expect(engine.evaluate(req({ screened: true }))).resolves.toBe('deny');
  });

  it('step 4: a session grant auto-allows in this instance only', async () => {
    const engine = createPermissionEngine();
    engine.record('web_fetch', 'example.com', 'session');
    await expect(engine.evaluate(req())).resolves.toBe('auto-allow');
    const fresh = createPermissionEngine();
    await expect(fresh.evaluate(req())).resolves.toBe('ask');
  });

  it("step 4: a persisted 'always' grant survives across engine instances (persist:true)", async () => {
    const a = createPermissionEngine({ persist: true });
    a.record('web_fetch', 'example.com', 'always');
    const b = createPermissionEngine({ persist: true });
    await expect(b.evaluate(req())).resolves.toBe('auto-allow');
  });

  it('persist:false (the default) never reads or writes the file', async () => {
    // Writes: recording 'always'/'never' must not create the file.
    const engine = createPermissionEngine();
    engine.record('web_fetch', 'example.com', 'always');
    engine.record('web_fetch', 'other.example', 'never');
    await expect(engine.evaluate(req())).resolves.toBe('auto-allow'); // in-process only
    expect(fs.existsSync(permissionsPath())).toBe(false);
    // Reads: a pre-seeded file's grants are invisible to a persist:false engine.
    addGrant('web_fetch', 'seeded.example', 'always');
    await expect(
      engine.evaluate(req({ toolEgress: { host: 'seeded.example', tier: 'bounded' } })),
    ).resolves.toBe('ask');
  });

  it("persist:false 'always' degrades to session semantics (lost with the instance)", async () => {
    const engine = createPermissionEngine();
    engine.record('web_fetch', 'example.com', 'always');
    await expect(engine.evaluate(req())).resolves.toBe('auto-allow');
    const restarted = createPermissionEngine();
    await expect(restarted.evaluate(req())).resolves.toBe('ask');
  });

  it('host matching is case-insensitive', async () => {
    const engine = createPermissionEngine({ persist: true });
    engine.record('web_fetch', 'Example.COM', 'always');
    await expect(
      engine.evaluate(req({ toolEgress: { host: 'EXAMPLE.com', tier: 'bounded' } })),
    ).resolves.toBe('auto-allow');
  });

  it('NO subdomain inheritance: example.com does not cover api.example.com', async () => {
    const engine = createPermissionEngine({ persist: true });
    engine.record('web_fetch', 'example.com', 'always');
    await expect(
      engine.evaluate(req({ toolEgress: { host: 'api.example.com', tier: 'bounded' } })),
    ).resolves.toBe('ask');
  });

  it('grants are per-tool: a web_fetch grant does not cover another tool', async () => {
    const engine = createPermissionEngine();
    engine.record('web_fetch', 'example.com', 'session');
    await expect(engine.evaluate(req({ tool: 'web_search' }))).resolves.toBe('ask');
  });

  it('no-egress requests (toolEgress: null) always ask in v1', async () => {
    const engine = createPermissionEngine({ persist: true });
    engine.record('web_fetch', 'example.com', 'always');
    await expect(engine.evaluate(req({ toolEgress: null }))).resolves.toBe('ask');
  });

  it("record('session') never persists, even with persist:true", async () => {
    const engine = createPermissionEngine({ persist: true });
    engine.record('web_fetch', 'example.com', 'session');
    expect(fs.existsSync(permissionsPath())).toBe(false);
    const restarted = createPermissionEngine({ persist: true });
    await expect(restarted.evaluate(req())).resolves.toBe('ask');
  });

  it('revocation takes effect immediately, mid-instance (persist:true)', async () => {
    const engine = createPermissionEngine({ persist: true });
    engine.record('web_fetch', 'example.com', 'always');
    await expect(engine.evaluate(req())).resolves.toBe('auto-allow');
    removeGrant('web_fetch', 'example.com'); // e.g. `northkeep tools revoke`
    await expect(engine.evaluate(req())).resolves.toBe('ask');
  });
});
