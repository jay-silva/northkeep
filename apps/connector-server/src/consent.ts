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

function hidden(name: string, value: string | undefined): string {
  if (value === undefined) return '';
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

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
    <p style="color:#8a8477;font-size:.85rem;margin-top:.5rem">Get a code with <code>northkeep share code</code> or the Sharing tab. Codes are single-use and expire after 10 minutes.</p>
    <button type="submit"
      style="margin-top:1rem;width:100%;font-size:1rem;font-weight:600;padding:.75rem;border:0;border-radius:8px;background:#24221c;color:#f6f4ef;cursor:pointer">Allow access</button>
  </form>
</body>`;
}
