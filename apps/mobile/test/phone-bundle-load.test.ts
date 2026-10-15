import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Build 31 crashed on launch because a shared package read process.platform at
// module load. This loads every NorthKeep module the phone imports the way the
// phone does: no Node platform, and Node built-ins replaced by the app's shims.

const appDir = join(__dirname, '..');
const requireShim = createRequire(join(appDir, 'metro.config.js'));

// Same map as metro.config.js NODE_SHIMS, minus `buffer` (Node's own is equivalent).
const SHIMS: Record<string, string> = {
  fs: 'node-fs.js',
  os: 'node-os.js',
  path: 'node-path.js',
  crypto: 'node-crypto.js',
  child_process: 'node-child_process.js',
  net: 'node-net.js',
};

// The phone's own package needs React Native itself, which cannot load under Node.
const NATIVE_ONLY = /^@northkeep\/platform-mobile(\/|$)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Every @northkeep module the app imports, read from its source so a new import is covered too. */
function phoneImports(): string[] {
  const found = new Set<string>();
  for (const file of [...sourceFiles(join(appDir, 'app')), ...sourceFiles(join(appDir, 'src'))]) {
    for (const m of readFileSync(file, 'utf8').matchAll(/from '(@northkeep\/[^']+)'/g)) {
      if (!NATIVE_ONLY.test(m[1]!)) found.add(m[1]!);
    }
  }
  return [...found].sort();
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let platform: NodeJS.Platform | undefined;

function loadLikeThePhone(): void {
  platform = undefined;
  Object.defineProperty(process, 'platform', { configurable: true, get: () => platform });
  vi.resetModules();
  for (const [name, file] of Object.entries(SHIMS)) {
    const shim = requireShim(`./shims/${file}`) as Record<string, unknown>;
    const factory = () => ({ ...shim, default: shim });
    vi.doMock(name, factory);
    vi.doMock(`node:${name}`, factory);
  }
  vi.doMock('@northkeep/mcp-server', () => requireShim('./shims/mcp-server.js') as object);
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const name of Object.keys(SHIMS)) {
    vi.doUnmock(name);
    vi.doUnmock(`node:${name}`);
  }
  vi.doUnmock('@northkeep/mcp-server');
  vi.resetModules();
});

describe('NorthKeep packages load on the phone', () => {
  it('finds the phone imports to check', () => {
    expect(phoneImports()).toEqual(expect.arrayContaining(['@northkeep/core', '@northkeep/sync', '@northkeep/redact']));
  });

  it('imports every module the phone uses with no platform and only the phone shims', async () => {
    loadLikeThePhone();
    const os = await import('node:os');
    expect(() => os.homedir()).toThrow(/not available on mobile/);
    const failures: string[] = [];
    for (const spec of phoneImports()) {
      try {
        await import(/* @vite-ignore */ spec);
      } catch (err) {
        failures.push(`${spec}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('names the device when a message is built, not when the module loads', async () => {
    loadLikeThePhone();
    const sync = await import('@northkeep/sync');
    expect(sync.connectorAutoPushMessage('behind')).toMatch(/^This device is behind/);
    expect(new sync.ConnectorStalePushError(null).message).toContain('Sync this device first');
    platform = 'darwin';
    expect(sync.connectorAutoPushMessage('behind')).toMatch(/^This Mac is behind/);
  });
});
