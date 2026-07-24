import type { PrivacyTier } from '../provider.js';

/**
 * The permission gate seam (M10b). The REAL policy engine — per-tool,
 * per-conversation consent, name screens over restored arguments, remembered
 * scopes — is ADR 0029 and lands in M10c. Until it does, `placeholderGate`
 * below is deliberately maximal: EVERY call answers 'ask', so nothing
 * executes without the user seeing the exact restored arguments and saying
 * yes. Fail closed per invariant #6: the placeholder never auto-allows and
 * never silently denies.
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
