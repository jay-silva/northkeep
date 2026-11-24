/**
 * The OAuth consent page. Unlike the C0 spike (which auto-approved), the user
 * must enter the 8-character pairing code they got from `northkeep share code`
 * (or the GUI Sharing tab). A correct, unconsumed, unexpired code binds this
 * OAuth grant to that account; a wrong or expired code is refused.
 *
 * The page is a plain self-submitting form: every OAuth param the SDK validated
 * is carried as a hidden field, plus the pairing-code input, POSTing to
 * /consent (which the server owns — see server.ts). No JS, no external assets.
 */

export interface ConsentParams {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  resource: string;
}

function esc(s: string | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** No framing (clickjacking), no scripts or remote assets; inline styles only. */
export const CONSENT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function redirectHost(uri: string): string {
  try {
    return new URL(uri).host || uri;
  } catch {
    return uri;
  }
}

function hidden(name: string, value: string | undefined): string {
  if (value === undefined) return '';
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

/**
 * ADR 0084 D2. Some apps never show NorthKeep's connect-time instruction to
 * their model; this sentence, pasted once into the app's own instructions,
 * took one such app from 17 to 24 of 25 on the owner's test.
 */
export const LOOK_FIRST_SENTENCE =
  'Before you answer a question about me, or about a person, organization, property or project in my life, search NorthKeep first, even when your own notes seem to answer. It is my own record and it outranks what you remember about me.';

export function renderConsentPage(p: ConsentParams, opts: { error?: string } = {}): string {
  const who = p.clientName ? esc(p.clientName) : 'An AI app';
  const errorBanner = opts.error
    ? `<p style="background:#fbeaea;color:#8a1f1f;border:1px solid #e6c3c3;padding:.75rem 1rem;border-radius:8px">${esc(opts.error)}</p>`
    : '';
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to NorthKeep</title>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:30rem;margin:8vh auto;padding:0 1.5rem;color:#24221c;background:#f6f4ef;line-height:1.5">
  <h1 style="font-weight:600;font-size:1.4rem">Connect ${who} to NorthKeep</h1>
  <p style="color:#6b665a">${who} wants to read the memory scopes you have marked <b>Shared</b>. Enter the pairing code from NorthKeep to allow it. It never sees your private scopes.</p>
  <p style="color:#6b665a">After you allow it, NorthKeep sends you to <b>${esc(redirectHost(p.redirectUri))}</b>. If that is not the app you meant to connect, stop here. The name above comes from the app and is not verified.</p>
  <p style="color:#8a8477;font-size:.85rem">App ID <code>${esc(p.clientId)}</code></p>
  ${errorBanner}
  <form method="POST" action="/consent">
    ${hidden('client_id', p.clientId)}
    ${hidden('redirect_uri', p.redirectUri)}
    ${hidden('code_challenge', p.codeChallenge)}
    ${hidden('state', p.state)}
    ${hidden('scope', p.scope)}
    ${hidden('resource', p.resource)}
    <label style="display:block;margin:1.25rem 0 .4rem;font-weight:600">Pairing code</label>
    <input name="pairing_code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false"
      placeholder="8 characters" required
      style="width:100%;box-sizing:border-box;font-size:1.25rem;letter-spacing:.15em;text-transform:uppercase;padding:.7rem .8rem;border:1px solid #cfc9ba;border-radius:8px;background:#fff">
    <p style="color:#8a8477;font-size:.85rem;margin-top:.5rem">Get a code with <code>northkeep share code</code> or the Sharing tab. A code from the app is single-use and expires after 10 minutes.</p>
    <div style="margin-top:1.5rem;border-top:1px solid #e6e0d4;padding-top:1rem">
      <h2 style="font-size:1rem;font-weight:700;margin:0 0 .4rem">Before you allow it, copy this</h2>
      <p style="color:#6b665a;margin:0 0 .6rem">Some apps do not look in NorthKeep unless you ask them to. Paste this into the app's instructions once and it will. Tap the sentence to select it, then copy.</p>
      <p style="background:#fffdf8;border:1px solid #e6e0d4;border-radius:8px;padding:.75rem;margin:0 0 .6rem;-webkit-user-select:all;user-select:all">${esc(LOOK_FIRST_SENTENCE)}</p>
      <ul style="color:#6b665a;font-size:.85rem;margin:0;padding-left:1.1rem">
        <li><b style="color:#24221c">Grok Bot, Muse:</b> tell it in the chat, "Add this to your instructions," and paste.</li>
        <li><b style="color:#24221c">ChatGPT:</b> Settings, Personalization, Custom instructions.</li>
        <li><b style="color:#24221c">Claude:</b> not needed. It looks on its own.</li>
      </ul>
    </div>
    <button type="submit"
      style="margin-top:1rem;width:100%;min-height:44px;font-size:1rem;font-weight:600;padding:.75rem;border:0;border-radius:8px;background:#24221c;color:#f6f4ef;cursor:pointer">Allow access</button>
  </form>
</body>`;
}
