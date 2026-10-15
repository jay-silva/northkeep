/**
 * Which public origins this connector will answer for.
 *
 * The product host is mcp.northkeep.ai. Connections that already use the
 * Vercel host keep working: a token is accepted when its audience is either
 * origin's /mcp resource. Discovery metadata follows the request host when
 * that host is on the list, so each host advertises itself as the issuer.
 * Any other Host header is ignored and the configured PUBLIC_URL is used.
 */

export const CANONICAL_CONNECTOR_ORIGIN = 'https://mcp.northkeep.ai';
export const LEGACY_CONNECTOR_ORIGIN = 'https://northkeep-connector-server.vercel.app';

/** Scheme plus host, no path. Throws if `raw` is not an absolute URL. */
export function originOf(raw: string): string {
  return new URL(raw).origin;
}

/**
 * Origins whose /mcp resource is a valid token audience, and whose discovery
 * documents may name that origin as the issuer. `publicUrl` is always included.
 * `aliasList` is the optional comma-separated PUBLIC_URL_ALIASES value.
 */
export function acceptedConnectorOrigins(publicUrl: string, aliasList?: string): string[] {
  const out = new Set<string>();
  out.add(originOf(publicUrl));
  out.add(CANONICAL_CONNECTOR_ORIGIN);
  out.add(LEGACY_CONNECTOR_ORIGIN);
  if (aliasList) {
    for (const part of aliasList.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.add(originOf(trimmed));
    }
  }
  return [...out];
}

export function resourceForOrigin(origin: string): string {
  return `${originOf(origin)}/mcp`;
}

function hostWithoutDefaultPort(protocol: string, host: string): string {
  if (protocol === 'https' && host.endsWith(':443')) return host.slice(0, -4);
  if (protocol === 'http' && host.endsWith(':80')) return host.slice(0, -3);
  return host;
}

/**
 * The origin this request may advertise. A host that is not on the list, or
 * a header that is not a single host, returns `fallback` (the configured
 * PUBLIC_URL origin). This is what stops a caller from choosing the issuer.
 */
export function selectRequestOrigin(
  input: { host: string | undefined; protocol: string },
  accepted: readonly string[],
  fallback: string,
): string {
  const raw = input.host?.trim() ?? '';
  if (!raw || /[\s,/@\\]/.test(raw)) return fallback;
  const protocol = input.protocol === 'https' || input.protocol === 'http' ? input.protocol : '';
  if (!protocol) return fallback;
  const origin = `${protocol}://${hostWithoutDefaultPort(protocol, raw)}`;
  return accepted.includes(origin) ? origin : fallback;
}
