import { describe, expect, it } from 'vitest';
import { assertMobileEndpointUrl } from '../src/lib/endpoint-gate';

/**
 * Accept/reject matrix for user-entered endpoint URLs. The private/bounded
 * split itself is @northkeep/converse classifyEndpoint (tested in
 * packages/converse); here we pin the mobile gate's rule on top of it:
 * https anywhere, plain http only to private-tier (LAN/local) hosts.
 */
describe('assertMobileEndpointUrl', () => {
  const ACCEPT_HTTP_PRIVATE = [
    'http://192.168.1.5:11434/v1', // RFC-1918 192.168/16 (typical home LAN Ollama)
    'http://10.0.0.2:11434/v1', // RFC-1918 10/8
    'http://172.16.0.9:11434', // RFC-1918 172.16/12 lower bound
    'http://172.31.255.254:11434', // RFC-1918 172.16/12 upper bound
    'http://my-mac.local:11434/v1', // mDNS .local hostname
    'http://localhost:11434/v1', // loopback name
    'http://127.0.0.1:11434/v1', // loopback IP
    'http://[fe80::1]:11434/v1', // IPv6 link-local
  ];
  it.each(ACCEPT_HTTP_PRIVATE)('accepts LAN/local plain http: %s', (url) => {
    expect(assertMobileEndpointUrl(url)).toBe(url);
  });

  const REJECT_HTTP_PUBLIC = [
    'http://api.openai.com/v1', // public DNS name
    'http://8.8.8.8:11434/v1', // public IPv4
    'http://172.32.0.1:11434', // just OUTSIDE 172.16/12
    'http://192.169.0.1:11434', // just outside 192.168/16
    'http://127.0.0.1.evil.com:11434', // public DNS dressed as loopback
  ];
  it.each(REJECT_HTTP_PUBLIC)('rejects public plain http: %s', (url) => {
    expect(() => assertMobileEndpointUrl(url)).toThrow(/own network/);
  });

  const ACCEPT_HTTPS = [
    'https://api.openai.com/v1', // https public: unaffected
    'https://openrouter.ai/api/v1',
    'https://192.168.1.5:11434/v1', // https private: also fine
  ];
  it.each(ACCEPT_HTTPS)('accepts https regardless of host: %s', (url) => {
    expect(assertMobileEndpointUrl(url)).toBe(url);
  });

  it('trims surrounding whitespace', () => {
    expect(assertMobileEndpointUrl('  https://api.openai.com/v1  ')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('rejects non-URLs and non-http(s) schemes with a user-facing message', () => {
    expect(() => assertMobileEndpointUrl('not a url')).toThrow(/full URL/);
    expect(() => assertMobileEndpointUrl('')).toThrow(/full URL/);
    expect(() => assertMobileEndpointUrl('ftp://192.168.1.5/')).toThrow(/https/);
  });
});
