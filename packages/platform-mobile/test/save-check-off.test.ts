import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0097 D4: the phone opts out of the save check, in one place. The phone
 * platform cannot be built under Node (native modules), so this pins the source.
 */
describe('the phone platform and the save check', () => {
  it('opts out exactly once, in mobilePlatform()', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'platform.ts'), 'utf8');
    expect(src.match(/checkFileBeforeSave: false/g)).toHaveLength(1);
  });
});
