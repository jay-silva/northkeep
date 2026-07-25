import type { PrivacyTier } from '../provider.js';

/**
 * The permission gate seam (M10b). The REAL policy engine — remembered
 * per-(tool, host) decisions with fail-closed evaluation — is ADR 0029 and
 * lives in policy.ts (createPermissionEngine, M10c). `placeholderGate` below
 * remains the inert fallback: EVERY call answers 'ask', so nothing executes
 * without the user seeing the exact restored arguments and saying yes. Fail
 * closed per invariant #6: the placeholder never auto-allows and never
 * silently denies.
 */

export interface PermissionRequest {
  /** Tool name (our identifier, never model-invented free text). */
  tool: string;
  /** RESTORED plaintext arguments — exactly what would execute (ADR 0027). */
  argsPlain: string;
  /** Gate hint from the ToolDefinition. */
  risk: 'safe-read' | 'consequential';
  /** Privacy tier of the MODEL endpoint driving this call. */
  modelTier: PrivacyTier;
  /** Where the tool call's arguments would egress to; null = no egress. */
  toolEgress: { host: string; tier: PrivacyTier } | null;
  /**
   * For an MCP tool, the configured server id this call belongs to (M11, ADR
   * 0033 Decision 1). Grants for such a tool key on (server, tool), because a
   * stdio server has no host to key on. Derived by the loop from our own
   * config — never from model-supplied text.
   */
  server?: string;
  /**
   * True when the loop's exfiltration screens flagged this call (the loop
   * computes and passes this; the gate never does). A screened call must
   * reach human eyes — the ADR-0029 engine answers 'ask' for it regardless
   * of any remembered grant.
   */
  screened?: boolean;
}

export interface PermissionGate {
  evaluate(req: PermissionRequest): Promise<'auto-allow' | 'ask' | 'deny'>;
}

/**
 * M10b placeholder: everything asks. Replaced by the ADR-0029 engine in
 * M10c; keep this dumb — any cleverness belongs in the reviewed engine.
 */
export const placeholderGate: PermissionGate = {
  evaluate: () => Promise.resolve('ask'),
};
