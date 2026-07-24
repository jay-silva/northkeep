import net from 'node:net';

/**
 * The provider abstraction (ADR 0008). One interface, two implementations:
 * the universal OpenAI-compatible provider (reaches every local runtime and
 * every hosted open-model API) and the optional native Anthropic provider.
 * Swapping models = editing endpoint config; nothing else changes.
 */

/**
 * One tool invocation the model asked for (M10a, ADR 0027). `arguments` is the
 * RAW JSON text exactly as the model emitted it — parsed and validated by the
 * harness (which owns the permission gate and needs the faithful original),
 * never by providers. Providers only transport it.
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON text — parsed/validated by the harness, never by providers. */
  arguments: string;
}

/**
 * A tool offered to the model (M10a, ADR 0027). `inputSchema` is JSON Schema —
 * the same shape MCP's listTools returns, so MCP tools plug in unconverted
 * when a later milestone wires them up.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema — same shape MCP listTools returns. */
  inputSchema: Record<string, unknown>;
}

/**
 * ChatMessage is deliberately widened IN PLACE for tools (ADR 0027) rather
 * than forked into a parallel type: the redaction path in turn.ts iterates
 * ChatMessage[] and must stay single — a second message type would be a
 * second place to forget redaction. The tool fields are internal-only;
 * each provider maps them to its wire format and never sends them verbatim.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool calls the model made — assistant messages only. */
  toolCalls?: ToolCallRequest[];
  /** Which ToolCallRequest this result answers — tool messages only. */
  toolCallId?: string;
}

export interface ChatOptions {
  model: string;
  /** Streamed tokens, in wire space (pseudonyms/masks intact). */
  onToken?: (token: string) => void;
  /**
   * REAL token usage reported by the endpoint, if it exposes any. Providers
   * call this at most once when the response carries usage; runTurn uses it for
   * the local cost estimate and falls back to a chars/token heuristic when it
   * never fires. Purely a count of tokens — no content leaves the machine.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Tools to offer the model (M10a, ADR 0027). Omitted = plain chat. */
  tools?: ToolSpec[];
}

/**
 * Why the model stopped (M10a, ADR 0027), normalized across providers:
 * 'tool_use' = it wants tool results before continuing; 'max_tokens' = it was
 * cut off; 'end' = a normal finish (or an endpoint that reports nothing).
 */
export type StopReason = 'end' | 'tool_use' | 'max_tokens';

/** One provider turn: streamed text plus any tool calls the model made. */
export interface ChatTurnResult {
  text: string;
  toolCalls: ToolCallRequest[];
  stopReason: StopReason;
}

export interface ModelProvider {
  readonly kind: 'openai-compatible' | 'anthropic';
  /** The endpoint base URL this provider talks to (used for tier display). */
  readonly baseUrl: string;
  /**
   * Send a chat and return the complete reply text. Kept for every text-only
   * caller (runTurn); implemented as a thin wrapper over chatTurn so each
   * provider has exactly ONE wire parser (ADR 0027).
   */
  chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
  /**
   * Send a chat and return the full turn result, including tool calls and the
   * stop reason (M10a, ADR 0027). This is what the agent loop calls; plain
   * chat surfaces keep using chat().
   */
  chatTurn(messages: ChatMessage[], options: ChatOptions): Promise<ChatTurnResult>;
  /** Model ids the endpoint offers (for the picker). */
  listModels(): Promise<string[]>;
}

/**
 * Privacy tier, derived from where the endpoint lives — never from what a
 * config claims. 'private' = the request cannot leave the machine/LAN;
 * 'bounded' = it goes to someone else's computer, masked first, provable
 * from the audit log.
 */
export type PrivacyTier = 'private' | 'bounded';

export interface TierClassification {
  tier: PrivacyTier;
  /** Canonical hostname the classification was made on. */
  host: string;
  reason: string;
}

/**
 * Classify an endpoint URL. FAIL CLOSED: anything not provably local or
 * private-LAN is 'bounded'. The WHATWG URL parser canonicalizes tricky
 * forms first (0x7f.1, 2130706433, userinfo@, embedded credentials), so the
 * checks below run on a normalized hostname — `127.0.0.1.evil.com` is a
 * public DNS name and classifies bounded.
 */
export function classifyEndpoint(rawUrl: string): TierClassification {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid endpoint URL: "${rawUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Endpoint must be http(s), got "${url.protocol}"`);
  }
  // WHATWG hostnames are already lowercased; IPv6 arrives bracketed.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { tier: 'private', host, reason: 'localhost' };
  }
  if (host.endsWith('.local')) {
    return { tier: 'private', host, reason: 'mDNS .local name' };
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return classifyIPv4(host);
  if (ipVersion === 6) return classifyIPv6(host);

  return { tier: 'bounded', host, reason: 'public or unrecognized host' };
}

/**
 * Classify a bare IP literal (IPv4 or IPv6, brackets already stripped).
 * Returns null when `host` is not an IP literal at all. This is the
 * refactor-export (M10b, ADR 0028) that lets the web-egress SSRF guard in
 * tools/net.ts reuse the SAME loopback/RFC-1918/link-local/ULA/IPv4-mapped
 * parsing that the endpoint privacy badge uses — one classifier, one place
 * to fix, instead of a second hand-rolled IP parser that could disagree.
 */
export function classifyIpAddress(host: string): TierClassification | null {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return classifyIPv4(host);
  if (ipVersion === 6) return classifyIPv6(host);
  return null;
}

function classifyIPv4(host: string): TierClassification {
  const parts = host.split('.').map(Number);
  const [a = -1, b = -1] = parts;
  // This classifier is shared by two callers with OPPOSITE fail-closed
  // directions: classifyEndpoint (private = plaintext-OK local endpoint) and
  // the web_fetch SSRF guard in tools/net.ts (private = refuse the fetch).
  // Marking a range 'private' is safe for BOTH here: 0.0.0.0/8 and CGNAT are
  // never the public web (SSRF-safe to refuse), and CGNAT 100.64/10 is exactly
  // Tailscale's range, i.e. the user's own private mesh (correct to treat local
  // for the privacy badge). G2 review 2026-07-24 reproduced 100.100.100.200
  // (Alibaba metadata) and 0.x reaching the socket before these were added.
  const priv =
    a === 127
      ? 'loopback'
      : a === 0
        ? '0.0.0.0/8 (this host / resolves to this machine)'
        : a === 10
          ? 'RFC-1918 10/8'
          : a === 100 && b >= 64 && b <= 127
            ? 'CGNAT / shared 100.64/10'
            : a === 172 && b >= 16 && b <= 31
              ? 'RFC-1918 172.16/12'
              : a === 192 && b === 168
                ? 'RFC-1918 192.168/16'
                : a === 169 && b === 254
                  ? 'link-local 169.254/16'
                  : null;
  return priv
    ? { tier: 'private', host, reason: priv }
    : { tier: 'bounded', host, reason: 'public IPv4' };
}

function classifyIPv6(host: string): TierClassification {
  const zoneless = host.split('%')[0] ?? host;
  const expanded = expandIPv6(zoneless);
  if (expanded === null) return { tier: 'bounded', host, reason: 'unparseable IPv6' };

  // IPv4-mapped (::ffff:a.b.c.d) — classify by the embedded IPv4.
  const v4 = ipv4FromMapped(expanded);
  if (v4 !== null) return { ...classifyIPv4(v4), host };

  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return { tier: 'private', host, reason: 'IPv6 loopback' };
  }
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') {
    // :: unspecified — localhost-equivalent on many stacks (G2 review).
    return { tier: 'private', host, reason: 'IPv6 unspecified ::' };
  }
  const firstWord = parseInt(expanded.slice(0, 4), 16);
  if ((firstWord & 0xfe00) === 0xfc00) {
    return { tier: 'private', host, reason: 'IPv6 unique-local fc00::/7' };
  }
  if ((firstWord & 0xffc0) === 0xfe80) {
    return { tier: 'private', host, reason: 'IPv6 link-local fe80::/10' };
  }
  return { tier: 'bounded', host, reason: 'public IPv6' };
}

/** Expand a valid IPv6 address to eight full 4-hex-digit words. */
function expandIPv6(host: string): string | null {
  let head = host;
  let v4Tail: number[] | null = null;
  // Trailing dotted-quad (::ffff:127.0.0.1 and friends).
  const lastColon = head.lastIndexOf(':');
  if (lastColon !== -1 && head.slice(lastColon + 1).includes('.')) {
    const quad = head.slice(lastColon + 1).split('.').map(Number);
    if (quad.length !== 4 || quad.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    v4Tail = quad;
    head = head.slice(0, lastColon + 1) + '0:0'; // placeholder, replaced below
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = (halves[0] ?? '').split(':').filter((s) => s.length > 0);
  const right = halves.length === 2 ? (halves[1] ?? '').split(':').filter((s) => s.length > 0) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  const words = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (words.length !== 8 || words.some((w) => !/^[0-9a-f]{1,4}$/i.test(w))) return null;
  const full = words.map((w) => w.padStart(4, '0').toLowerCase());
  if (v4Tail !== null) {
    const [q0 = 0, q1 = 0, q2 = 0, q3 = 0] = v4Tail;
    full[6] = ((q0 << 8) | q1).toString(16).padStart(4, '0');
    full[7] = ((q2 << 8) | q3).toString(16).padStart(4, '0');
  }
  return full.join(':');
}

/** If `expanded` is IPv4-mapped (::ffff:x.x.x.x), return the dotted quad. */
/**
 * Extract an embedded IPv4 from the IPv6 forms that carry one, so it can be
 * classified as the v4 address it really reaches:
 *  - IPv4-mapped   ::ffff:a.b.c.d   (the common one)
 *  - IPv4-compatible ::a.b.c.d      (deprecated, but ::7f00:1 can hit loopback)
 *  - NAT64         64:ff9b::a.b.c.d (well-known /96)
 * All three are "high 96 bits are a fixed prefix, low 32 bits are the v4".
 * Returns null when the address embeds no v4 (a genuine IPv6 host).
 * G2 review 2026-07-24: ::a.b.c.d and NAT64 previously fell through to the
 * public branch, an SSRF bypass onto embedded private addresses.
 */
function ipv4FromMapped(expanded: string): string | null {
  const embeds =
    expanded.startsWith('0000:0000:0000:0000:0000:ffff:') || // v4-mapped
    expanded.startsWith('0064:ff9b:0000:0000:0000:0000:'); // NAT64 64:ff9b::/96
  // v4-compatible ::a.b.c.d: high 96 bits all zero AND a non-zero low 32 that
  // is not ::1 (loopback, handled by its own branch) — else ::/unspecified and
  // ::1 would be misread as 0.0.0.x here. Those two are caught before this call.
  const v4compat =
    expanded.startsWith('0000:0000:0000:0000:0000:0000:') &&
    expanded.slice(30) !== '0000:0000' &&
    expanded.slice(30) !== '0000:0001';
  if (!embeds && !v4compat) return null;
  const w6 = parseInt(expanded.slice(30, 34), 16);
  const w7 = parseInt(expanded.slice(35, 39), 16);
  return `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
}
