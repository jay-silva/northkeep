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
  // One more fixture per remaining alternation branch, so every sub-prefix
  // the ADR and KNOWN-LIMITS name is exercised, not only the first.
  ...['ptt', 'cbt', 'ft', 'ffct', 'imt', 'agent', 'oas', 'soat'].map((p) => ({
    family: 'gitlab',
    token: 'gl' + p + '-' + fill(14) + '_' + fill(10),
  })),
  ...['a', 'p', 'r', 's'].map((c) => ({ family: 'slack', token: 'xox' + c + '-' + fill(30) })),
  ...['o', 'r'].map((c) => ({ family: 'digitalocean', token: 'do' + c + '_v1_' + fill(64, 'hex') })),
  ...['ca', 'pa', 'ss'].map((p) => ({ family: 'shopify', token: 'shp' + p + '_' + fill(32, 'hex') })),
  { family: 'sentry', token: 'sntry' + 's_' + 'eyJ' + fill(60, 'b64') + '_' + fill(43) },
  ...['oauth', 'pw'].map((p) => ({ family: 'planetscale', token: 'pscale_' + p + '_' + fill(40) })),
  ...['fm1a', 'fm1r'].map((p) => ({ family: 'flyio', token: p + '_' + fill(120, 'b64') })),
  ...['AB', 'AC'].map((p) => ({ family: 'aws-access-key', token: p + (p === 'AB' ? 'IA' : 'CA') + fill(16, 'upper') })),
  { family: 'stripe', token: 'sk' + '_test_' + fill(30) },
  { family: 'huggingface', token: 'hf' + '_' + fill(20) + fill(14, 'upper') },
];

/** A Telegram bot token in the spellings its own API uses (ADR 0059 fix round). */
export const TELEGRAM_SECRET = '7012345678' + ':AA' + fill(20) + '_' + fill(12);
export const TELEGRAM_FORMS: string[] = [
  `https://api.telegram.org/bot${TELEGRAM_SECRET}/sendMessage?chat_id=42&text=hi`,
  `curl -s "https://api.telegram.org/bot${TELEGRAM_SECRET}/getMe"`,
  `https://api.telegram.org/bot${TELEGRAM_SECRET}/setWebhook?url=https://hooks.example.com/tg`,
  `TELEGRAM_BOT_TOKEN=${TELEGRAM_SECRET}`,
  `Bot token ${TELEGRAM_SECRET} set.`,
];

/** The `bot`-anchored arm takes gitleaks' wider shape: 5-16 digits, `:A`, 34+ chars. */
export const TELEGRAM_WIDE_SECRET = '12345' + ':A' + fill(20) + '-' + fill(13);
export const TELEGRAM_WIDE_FORM = `https://api.telegram.org/bot${TELEGRAM_WIDE_SECRET}/getMe`;

/**
 * ADR 0059 options B and C (Jay, 2026-09-23): placeholder values, near-length
 * branch names, repeated-character bodies, and the recheck's over-match
 * strings. None may produce an api_key span (so none hard-denies a tool call).
 */
export const RELEASED_BY_B_AND_C: string[] = [
  'STRIPE_SECRET_KEY=sk_test_yourkeyhere',
  'sk_test_placeholder and sk_live_changeme123',
  'ANTHROPIC_API_KEY=sk-ant-api03-your-api-key-goes-here-xxxx',
  'OPENAI_API_KEY=sk-proj-your_openai_project_key_here_123',
  'git checkout -b sk-admin-dashboard-redesign-for-q4-launch',
  'git checkout -b sk-proj-management-tool-refactor-phase-two',
  'kubectl get pods -n sk-ant-dev01-cluster-monitoring-stack',
  'GITHUB_TOKEN=gh' + 'p_' + 'x'.repeat(36),
  'GITHUB_TOKEN=gh' + 'p_' + 'x'.repeat(30),
  'GROQ_API_KEY=gsk' + '_' + 'x'.repeat(40),
  'HF_TOKEN=hf' + '_' + 'x'.repeat(34),
  'NPM_TOKEN=npm' + '_' + '0'.repeat(36),
  'Replicate r8' + '_' + fill(34) + ' is one short.',
  'Hugging Face hf' + '_' + fill(33) + ' is one short.',
];

/** Identifiers the recheck showed the widened Telegram and Fly shapes catching. */
export const RECHECK_OVERMATCH: string[] = [
  'HGETALL order:123456:AwaitingFulfillment-warehouse-east-coast-2',
  '[worker 48213:AssertionError_in_module_payments_reconcile_v3]',
  'main.js:104233:AbstractFactoryBeanRegistrationProcessor',
  'trace=12345:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1',
  'user 1234567:A1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'rsync fm1' + '_recordings/2026-09-23/station_4/unit-12/' + 'archive_'.repeat(10) + 'ecg_12lead_full_disclosure.pdf',
  'def fm2' + '_compute_weighted_moving_average_' + 'over_window_'.repeat(8) + 'v2():',
  'fm1a' + '_' + 'config-key-'.repeat(12) + 'end: true',
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
  'Build 20260923:Alpha and port 8080:A' + 'b'.repeat(40) + ' are not tokens.',
  'A bot1234:Ab' + 'c'.repeat(40) + ' id is under five digits.',
  'PlanetScale tokens start pscale_tkn_ and end there.',
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
