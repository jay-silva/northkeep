/**
 * Rate-limit key for a client address, grouped the way express-rate-limit's
 * ipKeyGenerator (8.7+, the SDK's limiter) groups it: IPv4 as is, an
 * IPv4-mapped IPv6 address (::ffff:a.b.c.d, in either notation) or one written
 * in the deprecated IPv4-compatible dotted form (::a.b.c.d) as that IPv4, any
 * other IPv6 (NAT64 64:ff9b::a.b.c.d included) masked to its /56. One end
 * user holds at least a /64, so keying on the full IPv6 address let them
 * rotate past the limit (ADR 0061 code review F1).
 */

import { isIPv6 } from 'node:net';

export const IPV6_SUBNET_BITS = 56;

/** Eight 16-bit groups of an IPv6 address, or null if it will not parse. */
export function hextets(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

export function ipRateLimitKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const bare = ip.split('%')[0] ?? ip;
  if (!isIPv6(bare)) return ip;
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  let hex = bare.toLowerCase();
  if (v4) {
    const o = v4[1]!.split('.').map(Number);
    hex = `${hex.slice(0, v4.index + 1)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const h = hextets(hex);
  if (!h) return bare.toLowerCase();
  const zero5 = h.slice(0, 5).every((n) => n === 0);
  if (zero5 && (h[5] === 0xffff || (v4 && h[5] === 0))) {
    return [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff].join('.');
  }
  const masked = [h[0]!, h[1]!, h[2]!, h[3]! & 0xff00].map((n) => n.toString(16)).join(':');
  return `${masked}::/${IPV6_SUBNET_BITS}`;
}
