import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodePlatform } from '../src/platform.js';
import { nodeVaultStorage } from '../src/storage.js';

/** ADR 0097 D3: every Mac entry point runs on nodePlatform, which must leave the save check on. */
describe('the Mac platform and the save check', () => {
  it('does not opt out of the check', () => {
    expect(nodePlatform().checkFileBeforeSave).toBeUndefined();
  });

  it('reads just the head of a file, and a short file comes back short', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-read-head-'));
    try {
      const file = path.join(dir, 'f');
      fs.writeFileSync(file, 'abcdefghij');
      const storage = nodeVaultStorage();
      expect(storage.readHead!(file, 4).toString()).toBe('abcd');
      expect(storage.readHead!(file, 52).toString()).toBe('abcdefghij');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
