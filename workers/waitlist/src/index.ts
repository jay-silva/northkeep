const FROM = "NorthKeep <support@northkeep.ai>";
const TO = "support@northkeep.ai";
const EMAIL_MAX = 254;
const MIN_SUBMIT_MS = 3000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_URL = "https://api.resend.com/emails";

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  RESEND_API_KEY: string;
  WAITLIST_RATE: RateLimitBinding;
}

interface FormFields {
  email: string;
  website: string;
  rendered_at: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const wantsJson = prefersJson(request);
    const fields = await parseFields(request);
    const email = fields.email.trim();

    if (!isValidEmail(email)) {
      return errorResponse(wantsJson, 400, "Enter a valid email address.");
    }

    if (fields.website.trim().length > 0 || isTooFast(fields.rendered_at)) {
      return successResponse(wantsJson);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.WAITLIST_RATE.limit({ key: ip });
    if (!success) {
      return errorResponse(wantsJson, 429, "Too many requests. Try again shortly.");
    }

    if (!env.RESEND_API_KEY) {
      console.error("waitlist send failed", "RESEND_API_KEY missing");
      return errorResponse(wantsJson, 502, "Could not send. Write support@northkeep.ai.");
    }

    const isoUtc = new Date().toISOString();
    try {
      await sendWaitlistEmail(env, email, isoUtc);
    } catch (err) {
      const message = err instanceof Error ? err.message : "send failed";
      console.error("waitlist send failed", message);
      return errorResponse(wantsJson, 502, "Could not send. Write support@northkeep.ai.");
    }

    return successResponse(wantsJson);
  },
};

function prefersJson(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  if (accept.includes("application/json")) return true;
  if (request.headers.get("X-Requested-With")) return true;
  return false;
}

async function parseFields(request: Request): Promise<FormFields> {
  try {
    const form = await request.formData();
    return {
      email: String(form.get("email") ?? ""),
      website: String(form.get("website") ?? ""),
      rendered_at: String(form.get("rendered_at") ?? ""),
    };
  } catch {
    return { email: "", website: "", rendered_at: "" };
  }
}

function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= EMAIL_MAX && EMAIL_RE.test(email);
}

function isTooFast(renderedAt: string): boolean {
  const trimmed = renderedAt.trim();
  if (!trimmed) return false;
  const ts = parseRenderedAt(trimmed);
  if (ts === null) return false;
  return Date.now() - ts < MIN_SUBMIT_MS;
}

function parseRenderedAt(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function sendWaitlistEmail(env: Env, submittedEmail: string, isoUtc: string): Promise<void> {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      reply_to: submittedEmail,
      subject: "NorthKeep waitlist signup",
      text: `Waitlist signup\nEmail: ${submittedEmail}\nReceived: ${isoUtc}\n`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`resend ${response.status}: ${detail.slice(0, 200)}`);
  }
}

function successResponse(wantsJson: boolean): Response {
  if (wantsJson) {
    return json({ ok: true });
  }
  return html(page("You're on the list", "We'll write when there's something worth sending."), 200);
}

function errorResponse(wantsJson: boolean, status: number, message: string): Response {
  if (wantsJson) {
    return json({ ok: false, error: message }, status);
  }
  return html(page("Could not sign up", message), status);
}

function json(body: { ok: true } | { ok: false; error: string }, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;background:#f6f4ef;color:#24221c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:48px 24px}
  h1{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;font-weight:600}
  a{color:#2f6a54}
  @media (prefers-color-scheme:dark){body{background:#16140f;color:#ece7db}a{color:#79b394}}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to NorthKeep</a></p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
