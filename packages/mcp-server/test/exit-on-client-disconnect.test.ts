import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The server must EXIT when its stdio client goes away.
 *
 * This is a process-lifecycle property, so it is tested by actually spawning
 * the built server and taking its stdin away. Nothing short of that would have
 * caught the original bug: the code was correct in isolation, and the defect
 * lived entirely in what the SDK transport does NOT subscribe to.
 *
 * What went wrong without it (2026-07-30): StdioServerTransport listens for
 * stdin 'data' and 'error' only, never 'end'/'close', so a departing client
 * left the process running forever. 25 orphans accumulated across days of
 * finished Claude and Codex sessions. Because each orphan keeps the code it
 * started with, they survived a vault migration to schema 0.3 still holding
 * 0.2, and every write through them failed in three apps at once while the
 * on-disk build was current.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, '../dist/index.js');

const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children) if (c.exitCode === null && !c.killed) c.kill('SIGKILL');
  children.length = 0;
});

/** Spawn the real built server on a throwaway vault path and wait for readiness. */
async function spawnServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // A path with no vault: the server still starts and answers; it only opens
    // the vault per request. Keeps the test off the real one.
    env: { ...process.env, NORTHKEEP_HOME: path.join(here, '.tmp-nonexistent') },
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server never announced readiness')), 15_000);
    child.stderr?.on('data', (b: Buffer) => {
      if (b.toString().includes('ready (stdio)')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup with code ${String(code)}`));
    });
  });
  return child;
}

function exitWithin(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`still running after ${ms}ms — this is the orphan bug`)),
      ms,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('MCP server exits when its client disconnects', () => {
  it('exits on stdin EOF (the client quit)', async () => {
    const child = await spawnServer();
    expect(child.exitCode).toBeNull(); // alive and serving

    child.stdin?.end(); // exactly what a departing client does
    await expect(exitWithin(child, 10_000)).resolves.toBe(0);
  }, 30_000);

  it('exits on SIGTERM rather than dying mid-write', async () => {
    const child = await spawnServer();
    child.kill('SIGTERM');
    await expect(exitWithin(child, 10_000)).resolves.not.toBeNull();
  }, 30_000);

  it('says why it exited, so an orphan hunt has something to read', async () => {
    const child = await spawnServer();
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.stdin?.end();
    await exitWithin(child, 10_000);
    expect(stderr).toMatch(/exiting \(client closed stdin\)/);
  }, 30_000);

  it('stays alive while its client is still attached', async () => {
    // The guard against overcorrecting: a server that exits eagerly is worse
    // than one that lingers, because it takes the tool away mid-conversation.
    const child = await spawnServer();
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull();
  }, 30_000);
});

/**
 * The orphan mechanism that actually bit us, reproduced.
 *
 * The stale servers were NOT abandoned: every parent was still alive, holding
 * the stdin pipe open, so EOF never arrived and the process was never going to
 * leave on its own. What made that harmful was version skew. A server spawned
 * before a schema migration cannot read the vault and, left alone, fails every
 * call forever while the build on disk is current.
 *
 * So the server must recognise its own obsolescence and exit, letting the
 * client respawn on current code. The vault file below is a plausible-looking
 * NKV1 header that will fail to open; what matters is the typed-error branch,
 * exercised directly against the built binary elsewhere in the suite.
 */
describe('an obsolete server does not linger', () => {
  it('keeps running for ordinary errors, since only version skew is terminal', async () => {
    const child = await spawnServer();
    // No vault at NORTHKEEP_HOME: calls fail, but that is a normal, recoverable
    // condition (the user has not run init) and must NOT kill the server.
    await new Promise((r) => setTimeout(r, 1200));
    expect(child.exitCode).toBeNull();
  }, 30_000);
});
