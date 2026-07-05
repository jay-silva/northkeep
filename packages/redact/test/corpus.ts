import type { SecretKind } from '../src/types.js';

/**
 * The leak-test corpus: 50 seeded secrets embedded in realistic sentences.
 * Every `secret` MUST be gone from the Tier-1 output — zero misses allowed
 * (CLAUDE.md engineering standard; runs in CI on every commit).
 *
 * ALL values here are synthetic/reserved (555-line numbers, example.com,
 * documented test card numbers). No real personal data — this file is public.
 */
export interface SeededSecret {
  kind: SecretKind;
  secret: string;
  sentence: string;
}

export const LEAK_CORPUS: SeededSecret[] = [
  // emails (8) — all @example.* (reserved for documentation, RFC 2606)
  { kind: 'email', secret: 'user1@example.com', sentence: 'Reach me at user1@example.com anytime.' },
  { kind: 'email', secret: 'k.test+str@example.com', sentence: 'CC k.test+str@example.com on the listing.' },
  { kind: 'email', secret: 'ops@example.org', sentence: 'Forward to ops@example.org for dispatch.' },
  { kind: 'email', secret: 'r.person@example.co.uk', sentence: 'Contact is r.person@example.co.uk now.' },
  { kind: 'email', secret: 'billing_dept@example.io', sentence: 'Invoices go to billing_dept@example.io.' },
  { kind: 'email', secret: 'first.last@sub.example.museum', sentence: 'Odd TLD: first.last@sub.example.museum works.' },
  { kind: 'email', secret: 'admin@example.net', sentence: 'Temp inbox admin@example.net.' },
  { kind: 'email', secret: 'jane.doe99@example.edu', sentence: 'Student jane.doe99@example.edu applied.' },
  // phones (8) — 555-01xx is the reserved fictional range
  { kind: 'phone', secret: '617-555-0182', sentence: 'My cell is 617-555-0182.' },
  { kind: 'phone', secret: '(508) 555-0143', sentence: 'Station line: (508) 555-0143.' },
  { kind: 'phone', secret: '+1 617 555 0100', sentence: 'International: +1 617 555 0100.' },
  { kind: 'phone', secret: '555.555.0167', sentence: 'Dot format 555.555.0167 too.' },
  { kind: 'phone', secret: '+44 20 7946 0958', sentence: 'London office +44 20 7946 0958.' },
  { kind: 'phone', secret: '(212) 555-0188', sentence: 'NYC desk (212) 555-0188.' },
  { kind: 'phone', secret: '901-555-0139', sentence: 'Reception at 901-555-0139.' },
  { kind: 'phone', secret: '+1 (774) 555-0121', sentence: 'Backup +1 (774) 555-0121.' },
  // SSNs (7)
  { kind: 'ssn', secret: '123-45-6789', sentence: 'SSN on file: 123-45-6789.' },
  { kind: 'ssn', secret: '078-05-1120', sentence: 'The famous 078-05-1120 case.' },
  { kind: 'ssn', secret: '219 09 9999', sentence: 'Space-separated 219 09 9999.' },
  { kind: 'ssn', secret: '457-55-5462', sentence: 'Applicant SSN 457-55-5462.' },
  { kind: 'ssn', secret: '536-90-4399', sentence: 'Dependent 536-90-4399 listed.' },
  { kind: 'ssn', secret: '602-11-8888', sentence: 'New hire 602-11-8888.' },
  { kind: 'ssn', secret: '772-01-4455', sentence: 'Retiree 772-01-4455.' },
  // credit cards (Luhn-valid) (7)
  { kind: 'credit_card', secret: '4111 1111 1111 1111', sentence: 'Visa 4111 1111 1111 1111 declined.' },
  { kind: 'credit_card', secret: '5500-0000-0000-0004', sentence: 'MC 5500-0000-0000-0004 on file.' },
  { kind: 'credit_card', secret: '340000000000009', sentence: 'Amex 340000000000009 charged.' },
  { kind: 'credit_card', secret: '6011000000000004', sentence: 'Discover 6011000000000004 used.' },
  { kind: 'credit_card', secret: '3530111333300000', sentence: 'JCB 3530111333300000 tested.' },
  { kind: 'credit_card', secret: '4012 8888 8888 1881', sentence: 'Test card 4012 8888 8888 1881.' },
  { kind: 'credit_card', secret: '5105105105105100', sentence: 'Card 5105105105105100 saved.' },
  // IPs (5)
  { kind: 'ip', secret: '192.168.1.100', sentence: 'Router at 192.168.1.100.' },
  { kind: 'ip', secret: '10.0.0.42', sentence: 'Host 10.0.0.42 pinged.' },
  { kind: 'ip', secret: '172.16.254.1', sentence: 'Gateway 172.16.254.1.' },
  { kind: 'ip', secret: '8.8.8.8', sentence: 'DNS 8.8.8.8 resolves.' },
  { kind: 'ip', secret: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', sentence: 'IPv6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 assigned.' },
  // API keys / secrets (6)
  { kind: 'api_key', secret: 'sk-abc123DEF456ghi789JKL012', sentence: 'Key sk-abc123DEF456ghi789JKL012 leaked.' },
  { kind: 'api_key', secret: 'AKIAIOSFODNN7EXAMPLE', sentence: 'AWS AKIAIOSFODNN7EXAMPLE rotated.' },
  { kind: 'api_key', secret: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz', sentence: 'Token ghp_1234567890abcdefghijklmnopqrstuvwxyz.' },
  { kind: 'api_key', secret: 'xoxb-123456789012-abcdefABCDEF', sentence: 'Slack xoxb-123456789012-abcdefABCDEF.' },
  { kind: 'api_key', secret: 'AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI', sentence: 'GCP AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI.' },
  { kind: 'api_key', secret: 'sk-proj-Xy9Zabc123DEFghi456JKLmno', sentence: 'Project sk-proj-Xy9Zabc123DEFghi456JKLmno.' },
  // IBANs (2)
  { kind: 'iban', secret: 'GB82 WEST 1234 5698 7654 32', sentence: 'Wire to GB82 WEST 1234 5698 7654 32.' },
  { kind: 'iban', secret: 'DE89370400440532013000', sentence: 'German IBAN DE89370400440532013000.' },
];
