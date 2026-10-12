import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { listProjectOverview } from '../src/project-handoff.js';
import {
  PROJECT_WORKING_MEMORY_MESSAGE,
  ProjectWorkingMemoryError,
  projectWorkingMemoryMessage,
} from '../src/project-doc.js';
import { Vault } from '../src/vault.js';

const PASS = 'synthetic project working memory passphrase';
let directory: string;
let vaultPath: string;
let secret: Buffer;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-project-working-'));
  vaultPath = path.join(directory, 'vault.nkv');
  secret = generateDeviceSecret();
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function open(): Vault {
  return Vault.create({ path: vaultPath, passphrase: PASS, deviceSecret: secret, kdf: KDF_INTERACTIVE });
}

describe('a working memory in a project scope', () => {
  it('is the project document, so only that combination is refused', () => {
    expect(projectWorkingMemoryMessage('working', 'project:lantern')).toBe(PROJECT_WORKING_MEMORY_MESSAGE);
    expect(projectWorkingMemoryMessage('working', '  project:lantern ')).toBe(PROJECT_WORKING_MEMORY_MESSAGE);
    expect(projectWorkingMemoryMessage('semantic', 'project:lantern')).toBeNull();
    expect(projectWorkingMemoryMessage('episodic', 'project:lantern')).toBeNull();
    expect(projectWorkingMemoryMessage('working', 'personal')).toBeNull();
    expect(projectWorkingMemoryMessage('working', 'project:Not_A_Slug')).toBeNull();
  });

  it('blocks a new working row in the project and still lets the document itself be edited', () => {
    const vault = open();
    const created = vault.updateProject({
      project: 'lantern',
      expected_revision: null,
      title: 'Lantern Gazette',
      status: 'Printing.',
      next_actions: '- [ ] Fold',
    });
    const note = vault.remember({
      content: 'This week I am on the pear festival.',
      type: 'working',
      scope: 'personal',
    });
    expect(() => vault.rescope(note.id, 'project:lantern')).toThrow(ProjectWorkingMemoryError);
    expect(() => vault.editMemory(note.id, { scope: 'project:lantern' })).toThrow(ProjectWorkingMemoryError);

    const detail = vault.remember({
      content: 'The notice ran on page two.',
      type: 'episodic',
      scope: 'project:lantern',
    });
    expect(() => vault.editMemory(detail.id, { type: 'working' })).toThrow(ProjectWorkingMemoryError);

    const edited = vault.editMemory(created.revision, {
      content: '# Lantern Gazette\n\n## Current Status\n\nStill printing.',
    });
    expect(edited.type).toBe('working');
    expect(edited.scope).toBe('project:lantern');
    expect(listProjectOverview(vault)).toEqual([
      expect.objectContaining({ project: 'lantern', title: 'Lantern Gazette', conflict: false }),
    ]);

    const moved = vault.rescope(edited.id, 'project:orchard');
    expect(moved).toMatchObject({ type: 'working', scope: 'project:orchard' });
    expect(listProjectOverview(vault)).toEqual([
      expect.objectContaining({ project: 'orchard', title: 'Lantern Gazette', conflict: false }),
    ]);

    // Fixtures plant a project document with remember(). That path stays open,
    // and a second working row is what makes the project a title-less conflict.
    vault.remember({ content: 'A second head.', type: 'working', scope: 'project:orchard' });
    expect(listProjectOverview(vault)).toEqual([
      expect.objectContaining({ project: 'orchard', title: null, conflict: true }),
    ]);
    vault.close();
  });
});
