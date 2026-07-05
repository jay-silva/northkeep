import { MEMORY_TYPES } from '@northkeep/core';
import { stripControlChars } from '@northkeep/importers';
import type { ImportedConversation, MemoryCandidate } from '@northkeep/importers';
import type { OllamaClient } from './ollama.js';
import { EXTRACT_MODEL } from './ollama.js';

const MAX_CANDIDATES_PER_CONVERSATION = 8;
const MAX_INPUT_CHARS = 6000;
const MAX_CONTENT_CHARS = 2000;

export interface ExtractionResult {
  candidates: MemoryCandidate[];
  /** 'llm' or 'heuristic' — the CLI surfaces degradation loudly (invariant #6). */
  mode: 'llm' | 'heuristic';
  model: string;
}

export async function extractFromConversation(
  conversation: ImportedConversation,
  ollama: OllamaClient | null,
): Promise<ExtractionResult> {
  if (ollama !== null) {
    try {
      const candidates = await llmExtract(conversation, ollama);
      return { candidates, mode: 'llm', model: EXTRACT_MODEL };
    } catch {
      // A single flaky generation must not kill a 400-conversation import —
      // fall through to the conservative path for this conversation only.
    }
  }
  return { candidates: heuristicExtract(conversation), mode: 'heuristic', model: 'heuristic' };
}

async function llmExtract(
  conversation: ImportedConversation,
  ollama: OllamaClient,
): Promise<MemoryCandidate[]> {
  const userText = conversation.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
    .join('\n---\n')
    .slice(0, MAX_INPUT_CHARS);
  if (userText.trim().length === 0) return [];

  const prompt = `You extract durable personal memory from a user's chat messages.

Respond with JSON only, in exactly this shape:
{"memories":[{"type":"semantic","content":"...","confidence":0.8}]}

Types: identity (stable profile: role, family, expertise), semantic (durable
facts and preferences), procedural (how the user likes things done),
episodic (dated events that may matter later).

Rules:
- Only facts about the USER that stay true or will matter later.
- One self-contained statement per memory, third person ("The user ...").
- Skip trivia, one-off tasks, questions, and anything about the assistant.
- confidence between 0 and 1 reflecting how clearly the user stated it.
- At most ${MAX_CANDIDATES_PER_CONVERSATION} memories. {"memories":[]} if nothing qualifies.

Conversation title: ${conversation.title}
User messages:
${userText}`;

  const raw = await ollama.generateJson(prompt);
  return sanitizeCandidates(raw, conversation);
}

/** Defensive parse: a 3B model's JSON is a suggestion, not a contract. */
export function sanitizeCandidates(
  raw: string,
  conversation: ImportedConversation,
): MemoryCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(list)) return [];
  const candidates: MemoryCandidate[] = [];
  for (const item of list.slice(0, MAX_CANDIDATES_PER_CONVERSATION)) {
    const record = item as { type?: unknown; content?: unknown; confidence?: unknown };
    if (typeof record.content !== 'string') continue;
    const content = stripControlChars(record.content);
    if (content.length < 8 || content.length > MAX_CONTENT_CHARS) continue;
    const type =
      typeof record.type === 'string' && (MEMORY_TYPES as readonly string[]).includes(record.type)
        ? (record.type as MemoryCandidate['type'])
        : 'semantic';
    const confidence =
      typeof record.confidence === 'number' && record.confidence >= 0 && record.confidence <= 1
        ? record.confidence
        : 0.5;
    candidates.push({
      type,
      content,
      confidence,
      origin: {
        source: conversation.source,
        conversation_id: conversation.id,
        conversation_title: conversation.title,
      },
    });
  }
  return candidates;
}

/**
 * No-Ollama fallback: conservative first-person pattern matching over user
 * messages. Low confidence by design; the CLI banners the degradation.
 */
const FACT_PATTERN =
  /\b(i am|i'm|my name is|i work|i live|i own|i have a|i have an|i have two|i prefer|i always|i never|i like|i love|i hate|my wife|my husband|my son|my daughter|my kids|my job|my company|my business)\b/i;

export function heuristicExtract(conversation: ImportedConversation): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const message of conversation.messages) {
    if (message.role !== 'user') continue;
    for (const sentence of splitSentences(message.text)) {
      if (!FACT_PATTERN.test(sentence)) continue;
      const content = sentence.trim();
      if (content.length < 12 || content.length > 300) continue;
      const key = content.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        type: 'semantic',
        content,
        confidence: 0.4,
        origin: {
          source: conversation.source,
          conversation_id: conversation.id,
          conversation_title: conversation.title,
        },
      });
      if (candidates.length >= MAX_CANDIDATES_PER_CONVERSATION) return candidates;
    }
  }
  return candidates;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
