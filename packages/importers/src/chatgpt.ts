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

/**
 * Accepts, in order of what ChatGPT hands out:
 *  - the export ZIP (single `conversations.json`, or sharded
 *    `conversations-000.json` … as newer large exports produce);
 *  - the already-extracted export FOLDER (same, unzipped);
 *  - a single `conversations*.json` file.
 * Shards are concatenated into one conversation list.
 */
export function parseChatgptExport(inputPath: string): ImportedConversation[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`No file at ${inputPath}.`);
  }
  const shards = collectShardTexts(inputPath);
  if (shards.length === 0) {
    throw new Error(
      `No conversations file found at ${inputPath}. Point Northkeep at the ChatGPT export ` +
        'ZIP, the folder it unzipped to, or a conversations.json inside it.',
    );
  }
  const conversations: ImportedConversation[] = [];
  for (const raw of shards) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('A conversations file is not valid JSON — the export may be corrupted.');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('Unexpected ChatGPT export format (expected an array of conversations).');
    }
    for (const item of parsed as ChatgptConversation[]) {
      const conv = toConversation(item);
      if (conv && conv.messages.length > 0) conversations.push(conv);
    }
  }
  return conversations;
}

/** Returns the raw text of every conversations shard for the given input. */
function collectShardTexts(inputPath: string): string[] {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);

  if (stat.isDirectory()) {
    return listShardFiles(resolved).map((f) => fs.readFileSync(f, 'utf8'));
  }
  if (resolved.endsWith('.json')) {
    return [fs.readFileSync(resolved, 'utf8')];
  }
  // A ZIP: list its members, read every conversations*.json shard.
  let names: string[];
  try {
    names = execFileSync('unzip', ['-Z1', resolved], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => isShardName(path.basename(n)));
  } catch {
    throw new Error(
      `Could not read ${inputPath}. Is this the ZIP from ChatGPT Settings → Data Controls → Export Data?`,
    );
  }
  names.sort();
  return names.map((member) =>
    execFileSync('unzip', ['-p', resolved, member], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024, // hard cap; a bomb inflating past this fails cleanly
    }),
  );
}

function listShardFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => isShardName(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/** `conversations.json` or `conversations-000.json`, `-001`, … */
function isShardName(base: string): boolean {
  return /^conversations(-\d+)?\.json$/i.test(base);
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
