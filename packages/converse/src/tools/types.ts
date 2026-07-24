/**
 * The harness-side tool interface (M10b, ADR 0028). A ToolDefinition is what
 * the agent loop executes; the model only ever sees the derived ToolSpec
 * (name/description/inputSchema — ADR 0027). Everything else here exists for
 * the HARNESS: the permission gate, the egress-tier seam, and the audit log.
 */

export interface ToolContext {
  /** Cancels the task; a well-behaved tool aborts in-flight work. */
  signal?: AbortSignal;
  /** The loop truncates results past this; tools may pre-truncate smartly. */
  maxResultChars: number;
}

export interface ToolResult {
  /** What the model gets back (the loop fences external content around it). */
  content: string;
  /** Content-free execution facts — these feed the audit row and the UI. */
  meta: {
    /** Hostname actually contacted, when the tool egressed. */
    host?: string;
    bytes: number;
    truncated: boolean;
    ok: boolean;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, the shape offered to the model (ADR 0027 / MCP-compatible). */
  inputSchema: Record<string, unknown>;
  /**
   * Gate hint: 'safe-read' = read-only egress (a fetch); 'consequential' =
   * changes state somewhere. The M10c policy engine keys on this; the M10b
   * placeholder gate asks regardless (fail closed, invariant #6).
   */
  risk: 'safe-read' | 'consequential';
  /**
   * Where this call's arguments will EGRESS to, derived from the parsed
   * plaintext arguments — or null when the call leaves nothing (or the
   * arguments are malformed). The loop classifies this URL to pick the
   * tool-egress redaction tier (ADR 0027 decision 1: arguments bound for a
   * tool are redacted at THAT tool's egress tier, not the model's).
   */
  egress(args: unknown): { url: string } | null;
  /** Approximate per-call cost, for future budget display; absent = free. */
  costPerCallUsd?: number;
  /**
   * Execute with PLAINTEXT-restored, egress-tier-redacted arguments. Must
   * NEVER throw for expected failures — return structured
   * `{error, guidance}` JSON content with meta.ok:false so the model can
   * recover (a throw would abort the whole task, invariant #6 prefers loud
   * per-call errors the user can see in the transcript).
   */
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
