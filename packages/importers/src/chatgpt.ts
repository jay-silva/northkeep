import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ImportedConversation, ImportedMessage } from './types.js';

/**
 * Parser for the ChatGPT data-export ZIP (Settings → Data Controls → Export).
 * The archive contains conversations.json: an array of conversations, each a
 * tree of "mapping" nodes (branches from edits/regenerations); the live
 * thread is the path from current_node back to the root.
 *
 * ZIP handling shells out to the OS `unzip` (present on macOS/Linux) — zero
 * dependencies, and the export is user-supplied local data. `-p` streams a
 * single member to stdout without extracting anything to disk.
 */

interface ChatgptNode {
  id?: string;
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number | null;
  } | null;
  parent?: string | null;
  children?: string[];
}

interface ChatgptConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  mapping?: Record<string, ChatgptNode>;
  current_node?: string | null;
}

export function parseChatgptExport(zipPath: string): ImportedConversation[] {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`No file at ${zipPath}.`);
  }
  let raw: string;
  if (zipPath.endsWith('.json')) {
    raw = fs.readFileSync(zipPath, 'utf8'); // already-extracted conversations.json
  } else {
    try {
      // path.resolve: a filename starting with "-" must never parse as a flag
      raw = execFileSync('unzip', ['-p', path.resolve(zipPath), 'conversations.json'], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024, // hard cap; a bomb inflating past this fails cleanly
      });
    } catch {
      throw new Error(
        `Could not read conversations.json from ${zipPath}. ` +
          'Is this the ZIP from ChatGPT Settings → Data Controls → Export Data?',
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('conversations.json is not valid JSON — the export may be corrupted.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected ChatGPT export format (expected an array of conversations).');
  }
  const conversations: ImportedConversation[] = [];
  for (const item of parsed as ChatgptConversation[]) {
    const conv = toConversation(item);
    if (conv && conv.messages.length > 0) conversations.push(conv);
  }
  return conversations;
}

function toConversation(conv: ChatgptConversation): ImportedConversation | null {
  if (!conv.mapping) return null;
  const messages: ImportedMessage[] = [];
  // Walk current_node → root via parent links, then reverse into thread order.
  const chain: ChatgptNode[] = [];
  const seen = new Set<string>();
  let cursor = conv.current_node ?? undefined;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = conv.mapping[cursor];
    if (!node) break;
    chain.push(node);
    cursor = node.parent ?? undefined;
  }
  chain.reverse();
  for (const node of chain) {
    const message = node.message;
    const role = message?.author?.role;
    if (!message || (role !== 'user' && role !== 'assistant')) continue;
    const contentType = message.content?.content_type;
    if (contentType !== 'text' && contentType !== 'multimodal_text') continue;
    const text = (message.content?.parts ?? [])
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
      .trim();
    if (text.length === 0) continue;
    messages.push({
      role,
      text,
      created_at: typeof message.create_time === 'number'
        ? new Date(message.create_time * 1000).toISOString()
        : null,
    });
  }
  return {
    id: conv.conversation_id ?? conv.id ?? 'unknown',
    title: conv.title?.trim() || 'Untitled',
    source: 'chatgpt',
    created_at: typeof conv.create_time === 'number'
      ? new Date(conv.create_time * 1000).toISOString()
      : null,
    messages,
  };
}
