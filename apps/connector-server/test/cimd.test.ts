import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearCimdCache,
  fetchClientMetadataDocument,
  isBlockedAddress,
  isCimdClientId,
  type CimdDeps,
} from '../src/cimd.js';

const CLIENT = 'https://reviewer.example/oauth.json';

function deps(partial: Partial<CimdDeps> & Pick<CimdDeps, 'fetch'>): CimdDeps {
  return {
    lookupHost: async () => ['1.1.1.1'],
    now: () => 1_000,
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const validDoc = {
  client_id: CLIENT,
  client_name: 'Directory Reviewer',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:9/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};

describe('client metadata URL checks', () => {
  beforeEach(() => clearCimdCache());

  it('refuses the URLs that must never be fetched', () => {
    const refused = [
      'not a url',
      'http://reviewer.example/oauth.json',
      'https://user:pass@reviewer.example/oauth.json',
      'https://reviewer.example/oauth.json#frag',
      'https://reviewer.example:8443/oauth.json',
      'https://127.0.0.1/oauth.json',
      'https://localhost/oauth.json',
      'https://10.1.2.3/oauth.json',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.1/oauth.json',
      'https://[::1]/oauth.json',
      'https://intranet/oauth.json',
      'https://printer.local/oauth.json',
      'https://metadata.google.internal/oauth.json',
      'file:///etc/passwd',
    ];
    for (const id of refused) expect(isCimdClientId(id), id).toBe(false);
    expect(isCimdClientId(CLIENT)).toBe(true);
  });

  it('treats private, loopback, link-local, and mapped addresses as blocked', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });

  it('accepts a public document and does not follow a redirect', async () => {
    let calls = 0;
    const client = await fetchClientMetadataDocument(
      CLIENT,
      deps({
        fetch: async (input, init) => {
          calls += 1;
          expect(String(input)).toBe(CLIENT);
          expect(init?.redirect).toBe('error');
          return jsonResponse(validDoc);
        },
      }),
    );
    expect(client.client_name).toBe('Directory Reviewer');
    expect(client.token_endpoint_auth_method).toBe('none');
    expect(client.client_secret).toBeUndefined();
    const again = await fetchClientMetadataDocument(CLIENT, deps({ fetch: async () => { calls += 1; return jsonResponse(validDoc); } }));
    expect(again.client_id).toBe(CLIENT);
    expect(calls).toBe(1);
  });

  it('refuses a private DNS answer, a mismatch, a secret, a redirect status, and a huge body', async () => {
    await expect(fetchClientMetadataDocument(CLIENT, deps({
      lookupHost: async () => ['127.0.0.1'],
      fetch: async () => { throw new Error('fetch should not run'); },
    }))).rejects.toThrow(/refused address/);

    clearCimdCache();
    await expect(fetchClientMetadataDocument(CLIENT, deps({
      fetch: async () => jsonResponse({ ...validDoc, client_id: 'https://other.example/oauth.json' }),
    }))).rejects.toThrow(/does not match/);

    clearCimdCache();
    await expect(fetchClientMetadataDocument(CLIENT, deps({
      fetch: async () => jsonResponse({ ...validDoc, client_secret: 'nope' }),
    }))).rejects.toThrow(/secret/);

    clearCimdCache();
    await expect(fetchClientMetadataDocument(CLIENT, deps({
      fetch: async () => jsonResponse({ ...validDoc, client_name: 'Claude\u202e' }),
    }))).rejects.toThrow(/client_name/);

    clearCimdCache();
    await expect(fetchClientMetadataDocument(CLIENT, deps({
      fetch: async () => jsonResponse(validDoc, 302),
    }))).rejects.toThrow(/not available/);

    clearCimdCache();
    await expect(fetchClientMetadataDocument(CLIENT, deps({
      fetch: async () => new Response('x'.repeat(20_000), { status: 200 }),
    }))).rejects.toThrow(/too large/);

    await expect(fetchClientMetadataDocument('https://127.0.0.1/oauth.json', deps({
      fetch: async () => { throw new Error('fetch should not run'); },
    }))).rejects.toThrow(/not a client metadata URL/);
  });
});
