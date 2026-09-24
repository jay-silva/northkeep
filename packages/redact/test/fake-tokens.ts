/**
 * Synthetic issuer-prefixed tokens for ADR 0059, one or more per family in
 * TOKEN_PREFIX_PATTERNS. Every value is assembled at runtime by concatenation
 * so no complete token-shaped literal sits in the source for a secret scanner
 * (or a reader) to mistake for a real key. Bodies are repeated "FakeTest"
 * filler, include `-`/`_` wherever the issuer's alphabet allows them, and
 * deliberately miss the strict issuer shapes (Anthropic's trailing `AA`,
 * OpenAI's `T3BlbkFJ` marker, GitHub/npm CRC32 checksums; see the checksum
 * test in redact.test.ts).
 */

function fill(n: number, alphabet: 'alnum' | 'hex' | 'upper' | 'b64' = 'alnum'): string {
  const seed = {
    alnum: 'FakeTest0Key9',
    hex: 'fa4e7e570000',
    upper: 'FAKETESTKEY0',
    b64: 'FakeTest+Key/9',
  }[alphabet];
  return seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
}

export interface FakeToken {
  /** TOKEN_PREFIX_PATTERNS name, or a legacy family name for older branches. */
  family: string;
  token: string;
}

export const FAKE_TOKENS: FakeToken[] = [
  { family: 'anthropic', token: 'sk-ant-' + 'api03-' + fill(40) + '_' + fill(20) + '-' + fill(31) },
  { family: 'anthropic', token: 'sk-ant-' + 'admin01-' + fill(50) + '-' + fill(40) },
  { family: 'openai-named', token: 'sk-' + 'proj-' + fill(30) + '_' + fill(20) + '-' + fill(30) },
  { family: 'openai-named', token: 'sk-' + 'svcacct-' + fill(12) + '-' + fill(60) },
  { family: 'openai-named', token: 'sk-' + 'admin-' + fill(40) + '_' + fill(20) },
  { family: 'openrouter', token: 'sk-or-' + 'v1-' + fill(64, 'hex') },
  { family: 'github', token: 'gh' + 'p_' + fill(36) },
  { family: 'github', token: 'gh' + 'o_' + fill(36) },
  { family: 'github', token: 'gh' + 'u_' + fill(36) },
  { family: 'github', token: 'gh' + 's_' + fill(36) },
  { family: 'github', token: 'gh' + 'r_' + fill(36) },
  { family: 'github-fine-grained', token: 'github_' + 'pat_' + fill(22) + '_' + fill(59) },
  { family: 'gitlab', token: 'gl' + 'pat-' + fill(10) + '_' + fill(8) + '-' + fill(2) },
  { family: 'gitlab', token: 'gl' + 'pat-' + fill(30) + '.01.' + fill(8, 'hex') },
  { family: 'gitlab', token: 'gl' + 'dt-' + fill(20) },
  { family: 'gitlab', token: 'gl' + 'rt-' + fill(12) + '_' + fill(12) },
  { family: 'gitlab-runner-registration', token: 'GR1348' + '941' + fill(20) },
  { family: 'slack-app', token: 'xapp-' + '1-' + 'A0FAKE0TEST-1234567890-' + fill(24, 'hex') },
  { family: 'slack', token: 'xoxe-' + '1-' + fill(60) },
  { family: 'slack', token: 'xox' + 'b-' + '1234567890-' + fill(24) },
  { family: 'npm', token: 'npm' + '_' + fill(36) },
  { family: 'pypi', token: 'pypi-' + 'AgE' + 'IcHlwaS5vcmc' + fill(30) + '-' + fill(30) },
  { family: 'huggingface', token: 'hf' + '_' + fill(34) },
  { family: 'huggingface', token: 'api_' + 'org_' + fill(34) },
  { family: 'xai', token: 'xai' + '-' + fill(40) + '_' + fill(39) },
  { family: 'groq', token: 'gsk' + '_' + fill(52) },
  { family: 'replicate', token: 'r8' + '_' + fill(20) + '-' + fill(16) },
  { family: 'perplexity', token: 'pplx' + '-' + fill(48) },
  { family: 'aws-bedrock', token: 'AB' + 'SK' + fill(120, 'b64') },
  { family: 'sendgrid', token: 'SG' + '.' + fill(22) + '.' + fill(20) + '-' + fill(22) },
  { family: 'digitalocean', token: 'dop' + '_v1_' + fill(64, 'hex') },
  { family: 'shopify', token: 'shp' + 'at_' + fill(32, 'hex') },
  { family: 'linear', token: 'lin_' + 'api_' + fill(40) },
  { family: 'notion', token: 'ntn' + '_' + fill(46) },
  { family: 'notion', token: 'secret' + '_' + fill(43) },
  { family: 'databricks', token: 'da' + 'pi' + fill(32, 'hex') },
  { family: 'sentry', token: 'sntry' + 'u_' + fill(64, 'hex') },
  { family: 'doppler', token: 'dp.' + 'pt.' + fill(43) },
  { family: 'planetscale', token: 'pscale_' + 'tkn_' + fill(20) + '.' + fill(20) },
  { family: 'pulumi', token: 'pul' + '-' + fill(40, 'hex') },
  { family: 'postman', token: 'PM' + 'AK-' + fill(24, 'hex') + '-' + fill(34, 'hex') },
  { family: 'heroku', token: 'HRKU' + '-AA' + fill(30) + '_' + fill(28) },
  { family: 'onepassword-service', token: 'ops_' + 'eyJ' + fill(120, 'b64') },
  { family: 'age', token: 'AGE-SECRET-' + 'KEY-1' + fill(58, 'upper') },
  { family: 'atlassian', token: 'ATA' + 'TT3' + fill(100) + '-' + fill(80) },
  { family: 'flyio', token: 'fo1' + '_' + fill(43) },
  { family: 'flyio', token: 'fm2' + '_' + fill(120, 'b64') },
  { family: 'telegram-bot', token: '123456789' + ':AA' + fill(20) + '_' + fill(13) },
  { family: 'aws-access-key', token: 'AS' + 'IA' + fill(16, 'upper') },
  { family: 'stripe', token: 'sk' + '_prod_' + fill(24) },
  { family: 'stripe', token: 'rk' + '_live_' + fill(40) },
];

/** Prose and identifiers that share a prefix with a token family and must stay unmasked. */
export const NEAR_MISSES: string[] = [
  'Fine-grained tokens start with the github_pat_ prefix.',
  'A github_pat_short_123 is not a token.',
  'OAuth tokens look like gh' + 'o_' + fill(12) + ' but longer.',
  'Set npm_config_registry and npm_package_version in CI.',
  'Enable hf_transfer, set HF_HOME, then call hf_hub_download.',
  'Use the xai-grok-4 model through xai-sdk.',
  'GitLab tokens begin with glpat- and a glpat-short one is invalid.',
  'Anthropic keys start with sk-ant-api03- followed by the secret.',
  'The sk-proj-demo label is a placeholder.',
  'OpenRouter keys start sk-or-v1- in their docs.',
  'Rails reads secret_key_base and a secret_token value.',
  'Lorem ipsum dapibus sed.',
  'Replicate r8_short and pplx-api and gsk_test are too short.',
  'Firmware SG.1.2.3 shipped to ASIA PACIFIC and ASIAN markets.',
  'The pul-request template and PMAK-docs page.',
  'Meet at 12345678:AA or 10:30.',
  'Glued prefix x' + 'gh' + 'p_ stays prose, and ops_eyJ alone is nothing.',
];

// CRC32 (IEEE) for the checksum test; GitHub and npm tokens end in six base62
// chars of CRC32 over the random part, so a fixture must NOT satisfy it.
function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i += 1) {
    c ^= s.charCodeAt(i);
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function base62(n: number): string {
  let out = '';
  do {
    out = B62[n % 62] + out;
    n = Math.floor(n / 62);
  } while (n > 0);
  return out.padStart(6, '0');
}

/** True when a 36-char checksummed body would pass the issuer's checksum under either known reading. */
export function passesIssuerChecksum(prefix: string, body: string): boolean {
  const random = body.slice(0, 30);
  const check = body.slice(30);
  return check === base62(crc32(random)) || check === base62(crc32(prefix + random));
}
