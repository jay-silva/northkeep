import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripControlChars } from './types.js';
import type { ImportedConversation, ImportedMessage, MemoryCandidate } from './types.js';

/**
 * Claude import handles two shapes:
 *  - the claude.ai data export (ZIP containing conversations.json, or the
 *    JSON itself): conversations with chat_messages → runs through the same
 *    extraction pipeline as ChatGPT;
 *  - a memory export / "what do you know about me" text file (.md/.txt):
 *    already-distilled statements, parsed directly into candidates (still
 *    subject to user review — nothing skips that).
 */

interface ClaudeMessage {
  sender?: string;
  text?: string;
  created_at?: string;
}

interface ClaudeConversation {
  uuid?: string;
  name?: string | null;
  created_at?: string | null;
  chat_messages?: ClaudeMessage[];
}

export function parseClaudeExport(filePath: string): ImportedConversation[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No file at ${filePath}.`);
  }
  let raw: string;
  if (filePath.endsWith('.zip')) {
    const resolved = path.resolve(filePath); // a name starting with "-" must not parse as a flag
    let member: string | undefined;
    try {
      // Claude's export nests conversations.json inside a dated folder, so we
      // can't assume it's at the ZIP root — list the members and find it
      // wherever it lives (same robust approach as the ChatGPT importer).
      member = execFileSync('unzip', ['-Z1', resolved], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        .split('\n')
        .map((n) => n.trim())
        .find((n) => path.basename(n) === 'conversations.json');
    } catch {
      throw new Error(
        `Could not read ${filePath}. Is this the export ZIP from claude.ai Settings → Privacy → Export data?`,
      );
    }
    if (!member) {
      throw new Error(
        `No conversations.json found inside ${filePath}. Is this the claude.ai data export ZIP?`,
      );
    }
    raw = execFileSync('unzip', ['-p', resolved, member], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
  } else {
    raw = fs.readFileSync(filePath, 'utf8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Not valid JSON — for a memory-export text file, use "northkeep import paste".');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected Claude export format (expected an array of conversations).');
  }
  const conversations: ImportedConversation[] = [];
  for (const item of parsed as ClaudeConversation[]) {
    const messages: ImportedMessage[] = [];
    for (const message of item.chat_messages ?? []) {
      const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
      const text = message.text?.trim();
      if (!role || !text) continue;
      messages.push({ role, text, created_at: message.created_at ?? null });
    }
    if (messages.length === 0) continue;
    conversations.push({
      id: item.uuid ?? 'unknown',
      title: item.name?.trim() || 'Untitled',
      source: 'claude',
      created_at: item.created_at ?? null,
      messages,
    });
  }
  return conversations;
}

/**
 * The paste-prompt to run in ANY chatbot (Gemini, ChatGPT, Claude, …) whose
 * memory you want to carry over. Its output is what `northkeep import paste`
 * parses.
 */
export const PASTE_PROMPT = `Please summarize everything you know or remember about me as a list of
self-contained factual statements, one per line, each starting with a dash
and a bracketed category, exactly like this:

- [identity] The user is a paramedic in Massachusetts.
- [semantic] The user owns a short-term rental property.
- [procedural] The user prefers short, direct answers.
- [episodic] In March 2026 the user planned a kitchen renovation.

Categories: identity (stable profile), semantic (durable facts), procedural
(how I like things done), episodic (dated events). Write the facts in third
person ("The user …"), include only things you are confident about, and
output nothing but the list.`;

const PASTE_LINE = /^\s*[-*•]\s*\[(identity|semantic|procedural|episodic|working)\]\s*(.+)$/i;

export function parsePasteFile(filePath: string): MemoryCandidate[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const candidates: MemoryCandidate[] = [];
  for (const line of raw.split('\n')) {
    const match = PASTE_LINE.exec(line);
    if (!match) continue;
    const content = stripControlChars(match[2]!);
    if (content.length === 0 || content.length > 2000) continue;
    candidates.push({
      type: match[1]!.toLowerCase() as MemoryCandidate['type'],
      content,
      confidence: 0.7, // model-recalled, unverified by the user yet
      origin: { source: 'paste' },
    });
  }
  return candidates;
}
