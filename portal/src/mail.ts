import { hmac, randomToken, NOW } from "./lib";

// The mailer is a Google Apps Script web app in systems@thekliento.com. It only accepts
// requests signed with MAILER_SECRET, only within 5 minutes of signing, only once each,
// and only these message types: a login code or a verify link to one address, a request or alert to Camilo,
// and a task alert (notify) to one address on the client's own domains, linking only into the portal.

export type Attachment = { filename: string; mimeType: string; base64: string };
// Files the mailer fetches itself from a signed, 30-minute link (see tasks.ts mailFile).
export type FileRef = { url: string; filename: string; mimeType: string; size: number };

type MailBody =
  | { type: "code"; to: string; name: string; code: string }
  | { type: "verify"; to: string; name: string; link: string }
  | { type: "request"; subject: string; html: string; text: string; cc: string[]; replyTo: string; attachments: Attachment[]; files?: FileRef[] }
  | { type: "alert"; subject: string; text: string }
  | { type: "notify"; to: string; name: string; subject: string; text: string; comment: string; link: string };

export async function sendMail(env: Env, body: MailBody): Promise<{ ok: boolean; error?: string }> {
  if (!env.MAILER_URL || !env.MAILER_SECRET) return { ok: false, error: "mailer not configured" };
  const payload = JSON.stringify({ ...body, ts: NOW(), nonce: randomToken(12) });
  const sig = await hmac(env.MAILER_SECRET, payload);
  try {
    const r = await fetch(env.MAILER_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ payload, sig }),
      redirect: "follow",
    });
    const text = await r.text();
    let data: { ok?: boolean; error?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: `mailer returned ${r.status}` };
    }
    return data.ok ? { ok: true } : { ok: false, error: data.error || "mailer refused" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "mailer unreachable" };
  }
}
