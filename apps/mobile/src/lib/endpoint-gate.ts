// Deep dist import on purpose (repo convention, see local-provider.ts /
// converse-run.ts): the package barrel re-exports node-only modules
// (settings.ts child_process, the Anthropic SDK) that must stay out of the
// Metro bundle. Unlike the type-only imports elsewhere, this one is a RUNTIME
// call; it works on device because shims/node-net.js implements a real isIP
// for exactly this call path.
import { classifyEndpoint } from '@northkeep/converse/dist/provider.js';

/**
 * Mobile-side gate for user-entered model endpoint URLs (providers.tsx).
 *
 * Rule: https is accepted for any host; plain http is accepted ONLY for
 * endpoints the shared converse classifier already calls 'private' (loopback,
 * RFC-1918 LAN ranges, link-local, .local mDNS names, IPv6 ULA/link-local).
 * This is the JS twin of the app's iOS ATS posture (NSAllowsLocalNetworking
 * without NSAllowsArbitraryLoads, app.config.ts): LAN Ollama over plain http
 * works; plain http to a public host stays rejected at input time instead of
 * failing opaquely at request time.
 *
 * Tier classification itself is NOT duplicated or weakened here: we reuse
 * @northkeep/converse classifyEndpoint (fail-closed: anything not provably
 * local/LAN is 'bounded'), the same classifier that drives the PRIVATE badge
 * in the converse audit view and the desktop CLI.
 */

const URL_HELP =
  'Enter a full URL, like https://api.openai.com/v1 or http://192.168.1.5:11434/v1.';

/**
 * Validate a user-entered endpoint base URL. Returns the trimmed URL, or
 * throws with a user-facing message (no em dashes; shown verbatim in the UI).
 */
export function assertMobileEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(URL_HELP);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`The endpoint must start with https:// or http://. ${URL_HELP}`);
  }
  if (url.protocol === 'http:') {
    // classifyEndpoint fail-closes: only provably local/LAN hosts are 'private'.
    const { tier } = classifyEndpoint(trimmed);
    if (tier !== 'private') {
      throw new Error(
        'Plain http is only allowed for addresses on your own network, like http://192.168.1.5:11434/v1 or http://my-mac.local:11434/v1. For anything on the internet, use https.',
      );
    }
  }
  return trimmed;
}
