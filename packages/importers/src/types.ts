export type ImportSource = 'chatgpt' | 'claude' | 'paste' | 'converse';

/**
 * Strips C0/C1 control characters (incl. ANSI/OSC escape sequences' lead
 * bytes) from candidate content. The human review step is the product's
 * core control - content must not be able to render differently in the
 * terminal than what actually gets stored.
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export interface ImportedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** ISO 8601, when the source provides it. */
  created_at: string | null;
}

export interface ImportedConversation {
  id: string;
  title: string;
  source: ImportSource;
  created_at: string | null;
  messages: ImportedMessage[];
}

/**
 * A memory candidate produced by parsing/extraction — NOT yet in the vault.
 * Candidates exist only in memory until the user approves them (the review
 * step is a product feature, not an implementation detail).
 */
export interface MemoryCandidate {
  type: 'episodic' | 'semantic' | 'procedural' | 'working' | 'identity';
  content: string;
  confidence: number;
  /** Where this came from, for provenance metadata. */
  origin: {
    source: ImportSource;
    conversation_id?: string;
    conversation_title?: string;
  };
}
