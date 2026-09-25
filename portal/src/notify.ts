import { auditStmt, type Ctx } from "./auth";
import { DAY, MIN, NOW } from "./lib";
import { sendMail } from "./mail";

// Email alerts about a task. Who gets one:
//  - the person who added the task, when someone else comments on it or changes its status;
//  - Camilo (REQUEST_TO), when anyone who is not an admin comments, so staff messages never go unseen.
// Never the person who did the action. Each person gets at most one alert a task every 5 minutes.
// Recipients only ever come from the database and REQUEST_TO, never from the request.
// Runs after the response (waitUntil); a failed email is logged and never blocks the action.

export const NOTIFY_DOMAINS = ["buffaloriverworks.com", "pearlstreetgrill.com", "thekliento.com"];
const THROTTLE_S = 5 * MIN;
const ALL_PER_DAY = 300; // leaves the mail quota free for sign-up emails and requests
const PER_ACTOR_PER_DAY = 100; // one busy person can't use up everyone's alerts

const STATUS_LABEL: Record<string, string> = { new: "New requests", todo: "To do", doing: "In progress", waiting: "Waiting on RiverWorks", done: "Done" };

export type NotifyTask = { id: number; client: string; title: string; requested_by: string | null };
export type Actor = { id: string; name: string; email: string; role: string };
export type NotifyEvent = { kind: "comment"; comment: string } | { kind: "status"; status: string };

const firstName = (n: string | null | undefined) => (n || "").trim().split(/\s+/)[0] || "";

export async function notifyTask(c: Ctx, t: NotifyTask, actor: Actor, ev: NotifyEvent): Promise<void> {
  try {
    const to = new Map<string, { name: string; creator: boolean }>();
    if (t.requested_by && t.requested_by !== actor.id) {
      const u = await c.env.DB.prepare("SELECT email, name, status FROM users WHERE id = ?").bind(t.requested_by)
        .first<{ email: string; name: string; status: string }>();
      if (u && u.status === "active") to.set(u.email.trim().toLowerCase(), { name: firstName(u.name), creator: true });
    }
    if (ev.kind === "comment" && actor.role !== "admin" && c.env.REQUEST_TO) {
      const camilo = c.env.REQUEST_TO.trim().toLowerCase();
      if (!to.has(camilo)) to.set(camilo, { name: "Camilo", creator: false });
    }
    to.delete(actor.email.trim().toLowerCase());
    await Promise.all([...to].map(([email, r]) => sendOne(c, t, actor, ev, email, r)));
  } catch (e) {
    console.error(JSON.stringify({ msg: "notify failed", task: t.id, error: e instanceof Error ? e.message : String(e) }));
  }
}

async function sendOne(c: Ctx, t: NotifyTask, actor: Actor, ev: NotifyEvent, email: string, r: { name: string; creator: boolean }): Promise<void> {
  const dom = email.split("@")[1] || "";
  if (!NOTIFY_DOMAINS.includes(dom)) {
    await auditStmt(c, actor.id, "notify.skipped", 400, `#${t.id} ${email} not a client domain`).run();
    return;
  }
  const now = NOW();
  // One statement claims the slot, so two quick comments can't both send.
  const claim = await c.env.DB.prepare(
    `INSERT INTO notify_log (client, task_id, recipient, kind, ok, created_at, actor)
     SELECT ?, ?, ?, ?, 0, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM notify_log WHERE recipient = ? AND task_id = ? AND created_at > ?)
       AND (SELECT COUNT(*) FROM notify_log WHERE created_at > ?) < ?
       AND (SELECT COUNT(*) FROM notify_log WHERE actor = ? AND created_at > ?) < ?
     RETURNING id`,
  ).bind(t.client, t.id, email, ev.kind, now, actor.id, email, t.id, now - THROTTLE_S, now - DAY, ALL_PER_DAY, actor.id, now - DAY, PER_ACTOR_PER_DAY)
    .first<{ id: number }>();
  if (!claim) {
    await auditStmt(c, actor.id, "notify.throttled", 429, `#${t.id} ${email} (one alert a task every 5 minutes, or a daily cap)`).run();
    return;
  }

  const who = actor.name || "Someone";
  const title = t.title.length > 120 ? t.title.slice(0, 117) + "..." : t.title;
  const your = r.creator ? "your task " : "";
  let subject: string;
  let text: string;
  if (ev.kind === "comment") {
    subject = `${firstName(who) || who} commented on #${t.id}: ${title}`;
    text = `${who} commented on ${your}#${t.id}, "${title}".`;
  } else {
    const label = STATUS_LABEL[ev.status] || ev.status;
    subject = `#${t.id} is now ${label}: ${title}`;
    text = `${who} moved ${your}#${t.id}, "${title}", to ${label}.`;
  }
  const mail = await sendMail(c.env, {
    type: "notify",
    to: email,
    name: r.name,
    subject: subject.slice(0, 200),
    text,
    comment: ev.kind === "comment" ? ev.comment : "",
    link: `https://${c.env.PROD_HOST}/app/tasks?t=${t.id}`,
  });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE notify_log SET ok = ?, error = ? WHERE id = ?").bind(mail.ok ? 1 : 0, mail.ok ? null : (mail.error || "failed").slice(0, 200), claim.id),
    auditStmt(c, actor.id, mail.ok ? "notify.sent" : "notify.failed", mail.ok ? 200 : 502, `#${t.id} ${ev.kind} to ${email}${mail.ok ? "" : ": " + (mail.error || "failed")}`),
  ]);
}
