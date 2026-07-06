import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseChatgptExport } from '../src/chatgpt.js';
import { PASTE_PROMPT, parseClaudeExport, parsePasteFile } from '../src/claude.js';
import { chatgptConversationsFixture, claudeConversationsFixture } from './fixtures.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-import-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseChatgptExport', () => {
  it('parses a real-shaped ZIP, following only the live branch', () => {
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, JSON.stringify(chatgptConversationsFixture()));
    const zipPath = path.join(dir, 'export.zip');
    execFileSync('zip', ['-j', '-q', zipPath, jsonPath]);

    const conversations = parseChatgptExport(zipPath);
    expect(conversations).toHaveLength(2);
    const [str, coffee] = conversations;
    expect(str!.title).toBe('STR shopping');
    expect(str!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The abandoned regeneration branch must not appear.
    expect(str!.messages.some((m) => m.text.includes('abandoned'))).toBe(false);
    expect(str!.messages[0]!.text).toContain('short-term rental in Dartmouth');
    expect(coffee!.messages[0]!.text).toContain('coffee black');
  });

  it('accepts an already-extracted conversations.json directly', () => {
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, JSON.stringify(chatgptConversationsFixture()));
    expect(parseChatgptExport(jsonPath)).toHaveLength(2);
  });

  it('accepts an unzipped export FOLDER with sharded conversations-NNN.json', () => {
    const fixture = chatgptConversationsFixture(); // 2 conversations
    const folder = path.join(dir, 'chatgpt-export');
    fs.mkdirSync(folder);
    // Split across two shards, the way large real exports arrive.
    fs.writeFileSync(path.join(folder, 'conversations-000.json'), JSON.stringify([fixture[0]]));
    fs.writeFileSync(path.join(folder, 'conversations-001.json'), JSON.stringify([fixture[1]]));
    fs.writeFileSync(path.join(folder, 'chat.html'), '<html>ignored</html>');
    fs.writeFileSync(path.join(folder, 'user.json'), '{"ignored":true}');
    const convos = parseChatgptExport(folder);
    expect(convos).toHaveLength(2);
    expect(convos.map((c) => c.title).sort()).toEqual(['Coffee chat', 'STR shopping']);
  });

  it('reads sharded conversations-NNN.json out of a ZIP', () => {
    const fixture = chatgptConversationsFixture();
    const s0 = path.join(dir, 'conversations-000.json');
    const s1 = path.join(dir, 'conversations-001.json');
    fs.writeFileSync(s0, JSON.stringify([fixture[0]]));
    fs.writeFileSync(s1, JSON.stringify([fixture[1]]));
    const zipPath = path.join(dir, 'export.zip');
    execFileSync('zip', ['-j', '-q', zipPath, s0, s1]);
    expect(parseChatgptExport(zipPath)).toHaveLength(2);
  });

  it('fails with a helpful error on a non-export file', () => {
    const bogus = path.join(dir, 'bogus.zip');
    fs.writeFileSync(bogus, 'not a zip');
    expect(() => parseChatgptExport(bogus)).toThrow(/Data Controls/);
  });
});

describe('parseClaudeExport', () => {
  it('parses the claude.ai conversations JSON', () => {
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, JSON.stringify(claudeConversationsFixture()));
    const conversations = parseClaudeExport(jsonPath);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.messages[0]).toMatchObject({
      role: 'user',
      text: 'I am a paramedic and EMS coordinator in Massachusetts.',
    });
  });
});

describe('parsePasteFile', () => {
  it('parses bracketed memory lines and ignores everything else', () => {
    const file = path.join(dir, 'paste.md');
    fs.writeFileSync(
      file,
      [
        'Here is what I know about you:',
        '- [identity] The user is a paramedic in Massachusetts.',
        '* [semantic] The user owns a short-term rental.',
        '- [made-up-type] should be ignored',
        '- no bracket, ignored',
        '- [procedural] The user prefers short, direct answers.',
      ].join('\n'),
    );
    const candidates = parsePasteFile(file);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.type)).toEqual(['identity', 'semantic', 'procedural']);
    expect(candidates[0]!.origin.source).toBe('paste');
  });

  it('the paste prompt teaches the exact format the parser reads', () => {
    // The prompt's own examples must round-trip through the parser.
    const file = path.join(dir, 'prompt-examples.md');
    fs.writeFileSync(file, PASTE_PROMPT);
    expect(parsePasteFile(file).length).toBeGreaterThanOrEqual(4);
  });
});
