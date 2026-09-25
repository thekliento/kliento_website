import { audit, type Ctx, type Session } from "./auth";
import { DAY, HOUR, NOW, escapeHtml, hmac, isEmail, json, randomId, safeEqual } from "./lib";
import { sendMail } from "./mail";
import { notifyTask, type Actor } from "./notify";

// Web & IT tasks, the Send a request pop-up, and private files.
// Every query is scoped to one client; members only ever see their own client.

const STATUSES = ["new", "todo", "doing", "waiting", "done"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
const STATUS_LABEL: Record<string, string> = { new: "New requests", todo: "To do", doing: "In progress", waiting: "Waiting on RiverWorks", done: "Done" };
const PRIORITY_LABEL: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const CLIENT_NAME: Record<string, string> = { riverworks: "Buffalo RiverWorks", kliento: "Kliento" };
// Cc goes out from the Kliento mailer, so it may only reach the client's own domains.
const CC_DOMAINS: Record<string, string[]> = {
  riverworks: ["buffaloriverworks.com", "pearlstreetgrill.com", "alesandaxes.com", "thekliento.com"],
  kliento: ["thekliento.com"],
};
const DUE_DAYS: Record<string, number> = { urgent: 1, high: 3, normal: 5, low: 14 };

export const FILE_MAX = 10 * 1024 * 1024;
export const REQUEST_MAX = 25 * 1024 * 1024;
const UPLOADS_PER_DAY = 60;
const UPLOAD_BYTES_PER_DAY = 60 * 1024 * 1024;
const STORAGE_MAX = 800 * 1024 * 1024; // KV free tier is 1 GB for the whole account
const REQUESTS_PER_DAY = 20; // per person
const REQUESTS_ALL_PER_DAY = 100; // everyone together, so login codes always have mail quota
const MAIL_TRIES_MAX = 5;
const MAILFILE_TTL = 30 * 60;
const COMMENT_MAX = 4000;
const COMMENTS_PER_DAY = 300; // per person
const TASKS_PER_DAY = 100; // per person, for "Add a task"
// A locked task: only admins change these. Anyone can still comment and add files.
const LOCKED_FIELDS = ["title", "status", "priority", "owner_id", "due_date"];
const LOCKED_MSG = "Camilo locked this task.";

type Task = {
  id: number; client: string; title: string; body_html: string; body_text: string; status: string; priority: string;
  owner_id: string | null; due_date: string | null; requested_by: string | null; cc: string; source: string;
  mail_status: string; mail_error: string | null; mail_tries: number; created_at: number; updated_at: number;
  locked: number; locked_by: string | null; locked_at: number | null;
};
type FileRow = { id: string; client: string; task_id: number | null; uploaded_by: string; name: string; mime: string; size: number; created_at: number };

// Reads at most max bytes, so a missing or false Content-Length can't push past the cap.
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("Content-Length") || "0") > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

async function readJson<T>(req: Request, max = 256 * 1024): Promise<T | null> {
  const bytes = await readCapped(req, max);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

// Which client's board this request is about. Members: always their own. Kliento admins: any known client.
function clientFor(c: Ctx, s: Session): string | null {
  if (s.user.role !== "admin") return s.user.client;
  const q = new URL(c.req.url).searchParams.get("client") || "riverworks";
  return Object.hasOwn(CLIENT_NAME, q) ? q : null;
}

const actorOf = (s: Session): Actor => ({ id: s.user.id, name: s.user.name, email: s.user.email, role: s.user.role });

// Monday 00:00 this week in Buffalo, as unix seconds ("Done this week").
const weekFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
export function weekStart(now: number): number {
  const p: Record<string, string> = {};
  for (const x of weekFmt.formatToParts(new Date(now * 1000))) p[x.type] = x.value;
  const dow = Math.max(0, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday));
  return now - dow * DAY - Number(p.hour) * HOUR - Number(p.minute) * 60 - Number(p.second);
}

// When a done task was last moved to Done (a task added straight into Done counts from when it was added).
const DONE_AT = "COALESCE((SELECT MAX(e.ts) FROM task_events e WHERE e.task_id = t.id AND e.kind = 'status' AND e.to_val = 'done'), t.created_at)";

function validDate(d: unknown): string | null | undefined {
  if (d === null || d === "") return null;
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = Date.parse(d + "T00:00:00Z");
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) return undefined;
  return d;
}

function cleanTitle(t: unknown): string {
  return String(t ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
}

// ── rich text: server-side allowlist ────────────────────────────────────────
// Only b, strong, i, em, u, ul, ol, li, p, div, br and https links survive. Every attribute
// except a link's href is dropped. Dangerous containers are removed with their contents.
const KEEP = new Set(["b", "strong", "i", "em", "u", "ul", "ol", "li", "p", "div", "br", "a"]);
const DROP = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript", "textarea", "title", "svg", "math", "xmp", "noembed", "noframes", "select", "option", "head", "form", "input", "button", "img", "video", "audio", "picture", "source", "link", "meta", "base", "frame", "frameset", "applet", "canvas", "plaintext"]);

export function safeHttps(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim());
    if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function sanitizeHtml(input: string): Promise<string> {
  // "<!" and "<?" start doctypes, comments and processing instructions, which the rewriter
  // passes through untouched; as text they can't smuggle a tag past either pass.
  const src = input.slice(0, 100_000).replace(/<([!?])/g, "&lt;$1");
  const rw = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROP.has(tag)) { el.remove(); return; }
        if (!KEEP.has(tag)) { el.removeAndKeepContent(); return; }
        const href = tag === "a" ? safeHttps(el.getAttribute("href")) : null;
        for (const [name] of [...el.attributes]) el.removeAttribute(name);
        if (tag === "a") {
          if (!href) { el.removeAndKeepContent(); return; }
          el.setAttribute("href", href);
          el.setAttribute("rel", "noopener noreferrer nofollow");
          el.setAttribute("target", "_blank");
        }
      },
      comments(cm) { cm.remove(); },
    })
    .onDocument({ comments(cm) { cm.remove(); }, doctype() { /* dropped with the wrapper below */ } });
  const out = await rw.transform(new Response(`<div>${src}</div>`, { headers: { "Content-Type": "text/html" } })).text();
  return balance(out.replace(/^<div>/, "").replace(/<\/div>$/, "")).trim().slice(0, 60_000);
}

// Second pass over the rewriter's output: only the exact tag shapes we emit survive, stray or
// misnested end tags are dropped or closed, nesting stops at 24 levels, and any other angle bracket becomes text.
const TAG_OK = /^<(\/?)(b|strong|i|em|u|ul|ol|li|p|div|br|a)( href="https:\/\/[^"<>\s]+" rel="noopener noreferrer nofollow" target="_blank")?>$/;
function balance(src: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  for (const part of src.split(/(<[^<>]*>)/)) {
    if (!part) continue;
    const m = part.startsWith("<") ? part.match(TAG_OK) : null;
    if (!m) { out.push(part.startsWith("<") ? "" : part.replace(/</g, "&lt;").replace(/>/g, "&gt;")); continue; }
    const [, close, tag, attrs] = m;
    if ((tag === "a") !== !!attrs && !close) continue;
    if (close && attrs) continue;
    if (tag === "br") { if (!close) out.push("<br>"); continue; }
    if (!close) { if (stack.length >= 24) continue; stack.push(tag); out.push(part); continue; }
    const at = stack.lastIndexOf(tag);
    if (at < 0) continue;
    while (stack.length > at) out.push(`</${stack.pop()}>`);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<li>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|li)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, h: string, t: string) => `${t} (${h})`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim()
    .slice(0, 20_000);
}

// ── files: type allowlist checked by the bytes, not the name ────────────────
const TYPES: Record<string, { mime: string; magic: (b: Uint8Array) => boolean }> = {};
const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ZIP = (b: Uint8Array) => starts(b, [0x50, 0x4b, 0x03, 0x04]);
const OLE = (b: Uint8Array) => starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const isText = (b: Uint8Array) => {
  const head = b.subarray(0, 256 * 1024);
  if (head.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head, { stream: true }); return true; } catch { return false; }
};
const add = (exts: string[], mime: string, magic: (b: Uint8Array) => boolean) => exts.forEach((e) => (TYPES[e] = { mime, magic }));
add(["pdf"], "application/pdf", (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]));
add(["png"], "image/png", (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
add(["jpg", "jpeg"], "image/jpeg", (b) => starts(b, [0xff, 0xd8, 0xff]));
add(["gif"], "image/gif", (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a");
add(["webp"], "image/webp", (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP");
add(["heic", "heif"], "image/heic", (b) => ascii(b, 4, 4) === "ftyp" && ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(ascii(b, 8, 4)));
add(["docx"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ZIP);
add(["xlsx"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ZIP);
add(["pptx"], "application/vnd.openxmlformats-officedocument.presentationml.presentation", ZIP);
add(["doc"], "application/msword", OLE);
add(["xls"], "application/vnd.ms-excel", OLE);
add(["ppt"], "application/vnd.ms-powerpoint", OLE);
add(["txt"], "text/plain", isText);
add(["csv"], "text/csv", isText);

export function cleanFileName(raw: string): string {
  let n = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, "_").replace(/\s+/g, " ").trim();
  n = n.replace(/^\.+/, "");
  if (n.length > 120) {
    const dot = n.lastIndexOf(".");
    n = dot > 0 ? n.slice(0, 110) + n.slice(dot).slice(0, 10) : n.slice(0, 120);
  }
  return n || "file";
}

export function checkFile(name: string, bytes: Uint8Array): { mime: string } | { error: string } {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const t = name.includes(".") ? TYPES[ext] : undefined;
  if (!t) return { error: "That file type isn't allowed. Use PDF, images, Office, text or CSV." };
  if (bytes.length === 0) return { error: "That file is empty." };
  if (!t.magic(bytes)) return { error: "That file's contents don't match its name." };
  return { mime: t.mime };
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function uploadFile(c: Ctx, s: Session): Promise<Response> {
  const client = clientFor(c, s);
  if (!client) return json({ error: "Unknown client." }, 400);
  const len = Number(c.req.headers.get("Content-Length") || "-1");
  if (len > FILE_MAX) return json({ error: "Each file can be up to 10 MB." }, 413);
  let rawName = "";
  try { rawName = decodeURIComponent(c.req.headers.get("X-File-Name") || ""); } catch { rawName = ""; }
  const name = cleanFileName(rawName);
  const bytes = await readCapped(c.req, FILE_MAX);
  if (!bytes) return json({ error: "Each file can be up to 10 MB." }, 413);
  const size = bytes.byteLength;
  const kind = checkFile(name, bytes);
  if ("error" in kind) {
    audit(c, s.user.id, "file.rejected", 415, name);
    return json({ error: kind.error }, 415);
  }
  // One statement claims the row under every cap, so parallel uploads can't slip past them;
  // the KV write only happens for a claimed row.
  const id = randomId();
  const now = NOW();
  const claimed = await c.env.DB.prepare(
    `INSERT INTO files (id,client,task_id,uploaded_by,name,mime,size,created_at)
     SELECT ?,?,NULL,?,?,?,?,?
     WHERE (SELECT COUNT(*) FROM files WHERE uploaded_by = ? AND created_at > ?) < ?
       AND (SELECT COALESCE(SUM(size),0) FROM files WHERE uploaded_by = ? AND created_at > ?) + ? <= ?
       AND (SELECT COALESCE(SUM(size),0) FROM files) + ? <= ?
     RETURNING id`,
  ).bind(id, client, s.user.id, name, kind.mime, size, now,
    s.user.id, now - DAY, UPLOADS_PER_DAY, s.user.id, now - DAY, size, UPLOAD_BYTES_PER_DAY, size, STORAGE_MAX).first<{ id: string }>();
  if (!claimed) {
    audit(c, s.user.id, "file.capped", 429, `${name} ${size}`);
    return json({ error: "That's more files than one day allows. Try again tomorrow or email Camilo." }, 429);
  }
  try {
    await c.env.FILES.put(`f/${id}`, bytes);
  } catch (e) {
    await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
    console.error(JSON.stringify({ msg: "kv put failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "That file didn't save. Try again in a minute." }, 503);
  }
  audit(c, s.user.id, "file.uploaded", 200, `${name} ${size}`);
  return json({ id, name, size });
}

async function fileResponse(env: Env, f: FileRow): Promise<Response> {
  const body = await env.FILES.get(`f/${f.id}`, "stream");
  if (!body) return json({ error: "That file is gone." }, 404);
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": contentDisposition(f.name),
      "Content-Length": String(f.size),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function downloadFile(c: Ctx, s: Session, id: string): Promise<Response> {
  const f = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
  const allowed = f && (s.user.role === "admin" || f.client === s.user.client) && (f.task_id !== null || f.uploaded_by === s.user.id);
  if (!f || !allowed) {
    audit(c, s.user.id, "file.denied", 404, id);
    return json({ error: "No such file." }, 404);
  }
  audit(c, s.user.id, "file.downloaded", 200, `${f.name} task ${f.task_id ?? "none"}`);
  return fileResponse(c.env, f);
}

// The mailer fetches attachments itself with a short-lived signed link, so the Worker never
// has to base64 25 MB inside its 10 ms CPU budget. No session; the signature is the key.
async function mailFileSig(env: Env, id: string, exp: number): Promise<string> {
  return hmac(env.MAILER_SECRET, `mailfile:${id}:${exp}`);
}

export async function mailFile(c: Ctx, id: string): Promise<Response> {
  const u = new URL(c.req.url);
  const exp = Number(u.searchParams.get("e") || "0");
  const sig = u.searchParams.get("s") || "";
  const good = /^[0-9a-f-]{36}$/.test(id) && exp > NOW() && exp < NOW() + MAILFILE_TTL + 60 && !!c.env.MAILER_SECRET
    && safeEqual(await mailFileSig(c.env, id, exp), sig);
  if (!good) {
    audit(c, null, "mailfile.denied", 403, id.slice(0, 40));
    return json({ error: "Blocked." }, 403);
  }
  const f = await c.env.DB.prepare("SELECT * FROM files WHERE id = ? AND task_id IS NOT NULL").bind(id).first<FileRow>();
  if (!f) return json({ error: "No such file." }, 404);
  audit(c, null, "mailfile.fetched", 200, `${f.name} task ${f.task_id}`);
  return fileResponse(c.env, f);
}

// ── mail ───────────────────────────────────────────────────────────────────
async function mailTask(c: Ctx, taskId: number, actorId: string | null): Promise<{ ok: boolean; error?: string }> {
  const t = await c.env.DB.prepare(
    `SELECT t.*, u.name AS by_name, u.email AS by_email FROM tasks t LEFT JOIN users u ON u.id = t.requested_by WHERE t.id = ?`,
  ).bind(taskId).first<Task & { by_name: string | null; by_email: string | null }>();
  if (!t) return { ok: false, error: "no task" };
  const files = (await c.env.DB.prepare("SELECT * FROM files WHERE task_id = ? ORDER BY created_at").bind(taskId).all<FileRow>()).results;
  await c.env.DB.prepare("UPDATE tasks SET mail_status = 'sending', mail_tries = mail_tries + 1 WHERE id = ?").bind(taskId).run();

  const origin = `https://${c.env.PROD_HOST}`;
  const exp = NOW() + MAILFILE_TTL;
  const fileRefs = await Promise.all(files.map(async (f) => ({
    url: `${origin}/api/mailfile/${f.id}?e=${exp}&s=${await mailFileSig(c.env, f.id, exp)}`,
    filename: f.name, mimeType: f.mime, size: f.size,
  })));
  const link = `${origin}/app/tasks?t=${t.id}`;
  const client = CLIENT_NAME[t.client] || t.client;
  const who = t.by_name ? `${t.by_name} (${t.by_email})` : "someone";
  const fileList = files.map((f) => `<li>${escapeHtml(f.name)} <span style="color:#6c757d">${(f.size / 1048576).toFixed(1)} MB</span></li>`).join("");
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;color:#212529;line-height:1.5">` +
    `<p style="margin:0 0 4px;color:#6c757d;font-size:13px">${escapeHtml(client)} request #${t.id} · ${escapeHtml(PRIORITY_LABEL[t.priority])} · due ${escapeHtml(t.due_date || "not set")}</p>` +
    `<p style="margin:0 0 14px">From ${escapeHtml(who)}</p>` +
    `<div style="border-left:3px solid #3957EA;padding:2px 0 2px 12px;margin:0 0 14px">${t.body_html}</div>` +
    (files.length ? `<p style="margin:0 0 4px"><b>Files</b> (attached when they fit, always in the portal)</p><ul style="margin:0 0 14px">${fileList}</ul>` : "") +
    `<p><a href="${link}" style="color:#3957EA">Open request #${t.id} in the portal</a></p></div>`;
  const text = `${client} request #${t.id} · ${PRIORITY_LABEL[t.priority]} · due ${t.due_date || "not set"}\nFrom ${who}\n\n${t.body_text}\n\n` +
    (files.length ? `Files: ${files.map((f) => f.name).join(", ")}\n\n` : "") + `Open it: ${link}`;

  const r = await sendMail(c.env, {
    type: "request",
    subject: `[${client}] ${t.title}`,
    html, text,
    cc: JSON.parse(t.cc || "[]"),
    replyTo: t.by_email || "",
    attachments: [],
    files: fileRefs,
  });
  const now = NOW();
  if (r.ok) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tasks SET mail_status = 'sent', mail_error = NULL, updated_at = ? WHERE id = ?").bind(now, taskId),
      c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind) VALUES (?,?,?,?,'mail_sent')").bind(t.client, taskId, actorId, now),
    ]);
    audit(c, actorId, "task.mail_sent", 200, `#${taskId}`);
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tasks SET mail_status = 'failed', mail_error = ?, updated_at = ? WHERE id = ?").bind((r.error || "failed").slice(0, 200), now, taskId),
      c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind,to_val) VALUES (?,?,?,?,'mail_failed',?)").bind(t.client, taskId, actorId, now, (r.error || "").slice(0, 200)),
    ]);
    audit(c, actorId, "task.mail_failed", 502, `#${taskId} ${r.error || ""}`);
  }
  return r;
}

// ── tasks ──────────────────────────────────────────────────────────────────
async function owners(env: Env, client: string) {
  return (await env.DB.prepare(
    "SELECT id, name FROM users WHERE status = 'active' AND (client = ? OR client = 'kliento') ORDER BY name",
  ).bind(client).all<{ id: string; name: string }>()).results;
}

async function listTasks(c: Ctx, s: Session, client: string): Promise<Response> {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.status, t.priority, t.owner_id, t.due_date, t.requested_by, t.source, t.mail_status, t.created_at, t.updated_at, t.locked,
       o.name AS owner_name, r.name AS by_name,
       (SELECT COUNT(*) FROM files f WHERE f.task_id = t.id) AS files,
       (SELECT COUNT(*) FROM task_comments m WHERE m.task_id = t.id) AS comments,
       CASE WHEN t.status = 'done' THEN ${DONE_AT} END AS done_at
     FROM tasks t LEFT JOIN users o ON o.id = t.owner_id LEFT JOIN users r ON r.id = t.requested_by
     WHERE t.client = ? AND (t.status != 'done' OR t.updated_at > ?)
     ORDER BY t.id DESC LIMIT 500`,
  ).bind(client, NOW() - 30 * DAY).all();
  return json({
    client, clientName: CLIENT_NAME[client],
    clients: s.user.role === "admin" ? Object.entries(CLIENT_NAME).map(([id, name]) => ({ id, name })) : undefined,
    tasks: rows.results, owners: await owners(c.env, client), me: s.user.id, admin: s.user.role === "admin", now: NOW(), week_start: weekStart(NOW()),
  });
}

async function taskFor(c: Ctx, s: Session, id: number): Promise<Task | null> {
  const t = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>();
  if (!t || (s.user.role !== "admin" && t.client !== s.user.client)) return null;
  return t;
}

async function getTask(c: Ctx, s: Session, id: number): Promise<Response> {
  const t = await taskFor(c, s, id);
  if (!t) return json({ error: "No such task." }, 404);
  const [files, events, people, comments] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, name, size, created_at FROM files WHERE task_id = ? ORDER BY created_at").bind(id),
    c.env.DB.prepare("SELECT e.ts, e.kind, e.from_val, e.to_val, u.name AS who FROM task_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ? ORDER BY e.id DESC LIMIT 300").bind(id),
    c.env.DB.prepare("SELECT (SELECT name FROM users WHERE id = ?) AS owner_name, (SELECT name FROM users WHERE id = ?) AS by_name, (SELECT name FROM users WHERE id = ?) AS locked_by_name")
      .bind(t.owner_id, t.requested_by, t.locked_by),
    // The newest 200 messages, shown oldest first.
    c.env.DB.prepare("SELECT m.id, m.body, m.created_at, m.user_id, u.name AS who FROM task_comments m LEFT JOIN users u ON u.id = m.user_id WHERE m.task_id = ? ORDER BY m.id DESC LIMIT 200").bind(id),
  ]);
  audit(c, s.user.id, "task.viewed", 200, `#${id}`);
  return json({
    task: { ...t, ...(people.results[0] as object), cc: JSON.parse(t.cc || "[]") },
    files: files.results, events: events.results.reverse(), comments: comments.results.reverse(),
    owners: await owners(c.env, t.client), me: s.user.id, admin: s.user.role === "admin",
  });
}

async function ownerOk(env: Env, client: string, ownerId: unknown): Promise<string | null | undefined> {
  if (ownerId === null || ownerId === "") return null;
  if (typeof ownerId !== "string") return undefined;
  const o = (await owners(env, client)).find((x) => x.id === ownerId);
  return o ? o.id : undefined;
}

async function createTask(c: Ctx, s: Session, client: string): Promise<Response> {
  const b = await readJson<{ title?: string; status?: string; priority?: string; owner_id?: string | null; due_date?: string | null }>(c.req);
  if (!b) return json({ error: "Something was off with that. Try again." }, 400);
  const title = cleanTitle(b.title);
  if (!title) return json({ error: "Give the task a name." }, 400);
  const status = STATUSES.includes(b.status as never) ? String(b.status) : "todo";
  const priority = PRIORITIES.includes(b.priority as never) ? String(b.priority) : "normal";
  const due = validDate(b.due_date ?? null);
  if (due === undefined) return json({ error: "That due date isn't a real date." }, 400);
  const owner = await ownerOk(c.env, client, b.owner_id ?? null);
  if (owner === undefined) return json({ error: "Pick an owner from the list." }, 400);
  const now = NOW();
  const row = await c.env.DB.prepare(
    `INSERT INTO tasks (client,title,status,priority,owner_id,due_date,requested_by,source,created_at,updated_at)
     SELECT ?,?,?,?,?,?,?,'manual',?,? WHERE (SELECT COUNT(*) FROM tasks WHERE requested_by = ? AND created_at > ?) < ?
     RETURNING id`,
  ).bind(client, title, status, priority, owner, due, s.user.id, now, now, s.user.id, now - DAY, TASKS_PER_DAY).first<{ id: number }>();
  if (!row) {
    audit(c, s.user.id, "task.create_capped", 429);
    return json({ error: "That's a lot of tasks for one day. Email Camilo instead." }, 429);
  }
  const id = row.id;
  await c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind,to_val) VALUES (?,?,?,?,'created',?)").bind(client, id, s.user.id, now, title).run();
  audit(c, s.user.id, "task.created", 200, `#${id} ${client} ${title}`);
  return json({ ok: true, id });
}

async function updateTask(c: Ctx, s: Session, id: number): Promise<Response> {
  const t = await taskFor(c, s, id);
  if (!t) return json({ error: "No such task." }, 404);
  const b = await readJson<Record<string, unknown>>(c.req);
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Something was off with that. Try again." }, 400);
  const admin = s.user.role === "admin";
  if (t.locked && !admin && LOCKED_FIELDS.some((k) => k in b)) {
    audit(c, s.user.id, "task.locked_refused", 423, `#${id}`);
    return json({ error: LOCKED_MSG }, 423);
  }
  const changes: [string, string | null, string | null][] = [];
  if ("title" in b) {
    const v = cleanTitle(b.title);
    if (!v) return json({ error: "Give the task a name." }, 400);
    if (v !== t.title) changes.push(["title", t.title, v]);
  }
  if ("status" in b) {
    if (!STATUSES.includes(b.status as never)) return json({ error: "Unknown status." }, 400);
    if (b.status !== t.status) changes.push(["status", t.status, String(b.status)]);
  }
  if ("priority" in b) {
    if (!PRIORITIES.includes(b.priority as never)) return json({ error: "Unknown priority." }, 400);
    if (b.priority !== t.priority) changes.push(["priority", t.priority, String(b.priority)]);
  }
  if ("due_date" in b) {
    const v = validDate(b.due_date);
    if (v === undefined) return json({ error: "That due date isn't a real date." }, 400);
    if (v !== t.due_date) changes.push(["due_date", t.due_date, v]);
  }
  if ("owner_id" in b) {
    const v = await ownerOk(c.env, t.client, b.owner_id);
    if (v === undefined) return json({ error: "Pick an owner from the list." }, 400);
    if (v !== t.owner_id) changes.push(["owner_id", t.owner_id, v]);
  }
  if (!changes.length) return json({ ok: true, changed: 0 });
  const now = NOW();
  // For non-admins every statement also requires the task to be unlocked, so a lock that lands
  // between the check above and this batch still wins (the batch is one transaction).
  const guard = admin ? "" : " AND locked = 0";
  const stmts = changes.map(([f, , v]) => c.env.DB.prepare(`UPDATE tasks SET ${f} = ?, updated_at = ? WHERE id = ?${guard}`).bind(v, now, id));
  for (const [f, from, to] of changes) {
    stmts.push(c.env.DB.prepare(`INSERT INTO task_events (client,task_id,user_id,ts,kind,from_val,to_val) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?${guard})`)
      .bind(t.client, id, s.user.id, now, f, from, to, id));
  }
  const res = await c.env.DB.batch(stmts);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    audit(c, s.user.id, "task.locked_refused", 423, `#${id}`);
    return json({ error: LOCKED_MSG }, 423);
  }
  audit(c, s.user.id, "task.updated", 200, `#${id} ` + changes.map(([f, a, b2]) => `${f}: ${a ?? "none"} > ${b2 ?? "none"}`).join("; "));
  const moved = changes.find(([f]) => f === "status");
  if (moved?.[2]) {
    const title = changes.find(([f]) => f === "title")?.[2] ?? t.title;
    c.exec.waitUntil(notifyTask(c, { id, client: t.client, title, requested_by: t.requested_by }, actorOf(s), { kind: "status", status: moved[2] }));
  }
  return json({ ok: true, changed: changes.length });
}

// Claims files this person uploaded for this client and that aren't on a task yet.
async function claimFiles(c: Ctx, s: Session, client: string, ids: unknown, already = 0): Promise<{ rows: FileRow[] } | { error: string }> {
  if (!Array.isArray(ids) || ids.length > 20 || !ids.every((x) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x))) {
    return { error: "Those files didn't upload right. Remove them and add them again." };
  }
  if (!ids.length) return { rows: [] };
  const q = await c.env.DB.prepare(
    `SELECT * FROM files WHERE task_id IS NULL AND uploaded_by = ? AND client = ? AND id IN (${ids.map(() => "?").join(",")})`,
  ).bind(s.user.id, client, ...ids).all<FileRow>();
  if (q.results.length !== new Set(ids).size) return { error: "Those files didn't upload right. Remove them and add them again." };
  const total = q.results.reduce((a, f) => a + f.size, already);
  if (total > REQUEST_MAX) return { error: "Files can add up to 25 MB per request." };
  return { rows: q.results };
}

async function sendRequest(c: Ctx, s: Session, client: string): Promise<Response> {
  const b = await readJson<{ subject?: string; html?: string; cc?: string; priority?: string; fileIds?: string[] }>(c.req);
  if (!b) return json({ error: "Something was off with that. Try again." }, 400);
  const title = cleanTitle(b.subject);
  if (!title) return json({ error: "Add a subject." }, 400);
  const bodyHtml = await sanitizeHtml(String(b.html || ""));
  const bodyText = htmlToText(bodyHtml);
  if (!bodyText) return json({ error: "Write what you need in the message." }, 400);
  const priority = PRIORITIES.includes(b.priority as never) ? String(b.priority) : "normal";
  const cc: string[] = [];
  for (const raw of String(b.cc || "").split(/[,;\s]+/).filter(Boolean)) {
    const e = raw.trim().toLowerCase();
    const dom = e.split("@")[1] || "";
    if (!isEmail(e) || !(CC_DOMAINS[client] || []).includes(dom)) {
      return json({ error: `Cc can only go to ${(CC_DOMAINS[client] || []).map((d) => "@" + d).join(", ")} addresses. Check ${raw.slice(0, 80)}.` }, 400);
    }
    if (!cc.includes(e)) cc.push(e);
  }
  if (cc.length > 5) return json({ error: "Cc up to 5 people." }, 400);
  const claimed = await claimFiles(c, s, client, b.fileIds ?? []);
  if ("error" in claimed) return json({ error: claimed.error }, 400);
  const sent = await c.env.DB.prepare(
    "SELECT SUM(requested_by = ?) AS mine, COUNT(*) AS everyone FROM tasks WHERE source = 'request' AND created_at > ?",
  ).bind(s.user.id, NOW() - DAY).first<{ mine: number | null; everyone: number }>();
  if ((sent?.mine ?? 0) >= REQUESTS_PER_DAY || (sent?.everyone ?? 0) >= REQUESTS_ALL_PER_DAY) {
    audit(c, s.user.id, "request.capped", 429);
    return json({ error: "That's a lot of requests for one day. Add it as a task, or email Camilo." }, 429);
  }

  const now = NOW();
  const due = new Date((now + DUE_DAYS[priority] * DAY) * 1000).toISOString().slice(0, 10);
  const camilo = await c.env.DB.prepare("SELECT id FROM users WHERE client = 'kliento' AND role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1").first<{ id: string }>();
  const row = await c.env.DB.prepare(
    `INSERT INTO tasks (client,title,body_html,body_text,status,priority,owner_id,due_date,requested_by,cc,source,mail_status,created_at,updated_at)
     VALUES (?,?,?,?,'new',?,?,?,?,?,'request','sending',?,?) RETURNING id`,
  ).bind(client, title, bodyHtml, bodyText, priority, camilo?.id ?? null, due, s.user.id, JSON.stringify(cc), now, now).first<{ id: number }>();
  const id = row!.id;
  const stmts = [c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind,to_val) VALUES (?,?,?,?,'requested',?)").bind(client, id, s.user.id, now, title)];
  for (const f of claimed.rows) {
    stmts.push(c.env.DB.prepare("UPDATE files SET task_id = ? WHERE id = ? AND task_id IS NULL").bind(id, f.id));
    stmts.push(c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind,to_val) VALUES (?,?,?,?,'file_added',?)").bind(client, id, s.user.id, now, f.name));
  }
  await c.env.DB.batch(stmts);
  audit(c, s.user.id, "request.created", 200, `#${id} ${client} ${priority} files=${claimed.rows.length} cc=${cc.length}`);
  // The task is saved first; a mail failure only marks it for a retry.
  const mail = await mailTask(c, id, s.user.id);
  return json({ ok: true, id, mail: mail.ok ? "sent" : "failed" });
}

async function resend(c: Ctx, s: Session, id: number): Promise<Response> {
  const t = await taskFor(c, s, id);
  if (!t || t.source !== "request") return json({ error: "No such request." }, 404);
  if (t.mail_status === "sent") return json({ ok: true, mail: "sent" });
  if (t.mail_tries >= MAIL_TRIES_MAX) {
    audit(c, s.user.id, "task.mail_capped", 429, `#${id}`);
    return json({ error: "The email tried 5 times. The request is saved; Camilo sees it here." }, 429);
  }
  const r = await mailTask(c, id, s.user.id);
  return json({ ok: r.ok, mail: r.ok ? "sent" : "failed", error: r.ok ? undefined : "The email still didn't go. The request is saved; try again in a few minutes." }, r.ok ? 200 : 502);
}

async function addFiles(c: Ctx, s: Session, id: number): Promise<Response> {
  const t = await taskFor(c, s, id);
  if (!t) return json({ error: "No such task." }, 404);
  const b = await readJson<{ fileIds?: string[] }>(c.req);
  const have = await c.env.DB.prepare("SELECT COALESCE(SUM(size),0) AS n FROM files WHERE task_id = ?").bind(id).first<{ n: number }>();
  const claimed = await claimFiles(c, s, t.client, b?.fileIds ?? [], have?.n ?? 0);
  if ("error" in claimed) return json({ error: claimed.error.replace("per request", "per task") }, 400);
  const now = NOW();
  const stmts = [c.env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(now, id)];
  for (const f of claimed.rows) {
    stmts.push(c.env.DB.prepare("UPDATE files SET task_id = ? WHERE id = ? AND task_id IS NULL").bind(id, f.id));
    stmts.push(c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind,to_val) VALUES (?,?,?,?,'file_added',?)").bind(t.client, id, s.user.id, now, f.name));
  }
  await c.env.DB.batch(stmts);
  audit(c, s.user.id, "task.files_added", 200, `#${id} files=${claimed.rows.length}`);
  return json({ ok: true });
}

// ── chat on a task ──────────────────────────────────────────────────────────
// Stored as plain text; the page escapes it when it shows it, and the mailer escapes it too.
function cleanComment(v: string): string {
  return v.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .split("\n").map((l) => l.trimEnd()).join("\n")
    .replace(/\n{4,}/g, "\n\n\n").trim();
}

async function addComment(c: Ctx, s: Session, id: number): Promise<Response> {
  const t = await taskFor(c, s, id);
  if (!t) return json({ error: "No such task." }, 404);
  const b = await readJson<{ body?: unknown }>(c.req, 32 * 1024);
  if (typeof b?.body !== "string" || !b.body.trim()) return json({ error: "Write a message first." }, 400);
  // Checked on the raw text before any cleanup, so a huge message costs almost nothing.
  if (b.body.length > COMMENT_MAX * 2) return json({ error: "Keep messages under 4,000 characters." }, 400);
  const text = cleanComment(b.body);
  if (!text) return json({ error: "Write a message first." }, 400);
  if (text.length > COMMENT_MAX) return json({ error: "Keep messages under 4,000 characters." }, 400);
  const now = NOW();
  const row = await c.env.DB.prepare(
    `INSERT INTO task_comments (client, task_id, user_id, body, created_at)
     SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM task_comments WHERE user_id = ? AND created_at > ?) < ?
     RETURNING id`,
  ).bind(t.client, id, s.user.id, text, now, s.user.id, now - DAY, COMMENTS_PER_DAY).first<{ id: number }>();
  if (!row) {
    audit(c, s.user.id, "task.comment_capped", 429, `#${id}`);
    return json({ error: "That's a lot of messages for one day. Email Camilo instead." }, 429);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(now, id),
    c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind,to_val) VALUES (?,?,?,?,'comment',?)").bind(t.client, id, s.user.id, now, String(row.id)),
  ]);
  audit(c, s.user.id, "task.commented", 200, `#${id} message ${row.id}, ${text.length} characters`);
  c.exec.waitUntil(notifyTask(c, t, actorOf(s), { kind: "comment", comment: text }));
  return json({ ok: true, id: row.id });
}

// ── lock: only admins lock or unlock ────────────────────────────────────────
async function setLock(c: Ctx, s: Session, id: number): Promise<Response> {
  if (s.user.role !== "admin") {
    audit(c, s.user.id, "task.lock_denied", 403, `#${id}`);
    return json({ error: "Only Camilo can lock or unlock a task." }, 403);
  }
  const t = await taskFor(c, s, id);
  if (!t) return json({ error: "No such task." }, 404);
  const b = await readJson<{ locked?: unknown }>(c.req, 1024);
  if (typeof b?.locked !== "boolean") return json({ error: "Something was off with that. Try again." }, 400);
  const want = b.locked ? 1 : 0;
  if (t.locked === want) return json({ ok: true, locked: b.locked });
  const now = NOW();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tasks SET locked = ?, locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?").bind(want, want ? s.user.id : null, want ? now : null, now, id),
    c.env.DB.prepare("INSERT INTO task_events (client,task_id,user_id,ts,kind) VALUES (?,?,?,?,?)").bind(t.client, id, s.user.id, now, want ? "locked" : "unlocked"),
  ]);
  audit(c, s.user.id, want ? "task.locked" : "task.unlocked", 200, `#${id}`);
  return json({ ok: true, locked: b.locked });
}

// ── Home: four counts, the top items under each, and recent activity ───────
type HomeItem = { id: number; title: string; status: string; priority: string; due_date: string | null; by_name: string | null; locked: number; comments: number; done_at?: number };
const RANK = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
const HOME_COLS = "t.id, t.title, t.status, t.priority, t.due_date, t.locked, r.name AS by_name";
// Message counts are added only to the few rows that are returned.
const withCounts = (inner: string) => `SELECT x.*, (SELECT COUNT(*) FROM task_comments m WHERE m.task_id = x.id) AS comments FROM (${inner}) x`;
const topOpen = (status: string) => withCounts(
  `SELECT ${HOME_COLS} FROM tasks t LEFT JOIN users r ON r.id = t.requested_by WHERE t.client = ?1 AND t.status = '${status}'
   ORDER BY ${RANK}, COALESCE(t.due_date, '9999'), t.id DESC LIMIT 5`);
const DONE_WEEK = `SELECT ${HOME_COLS}, ${DONE_AT} AS done_at FROM tasks t LEFT JOIN users r ON r.id = t.requested_by
   WHERE t.client = ?1 AND t.status = 'done' AND t.updated_at >= ?2`;

async function homeData(c: Ctx, s: Session, client: string): Promise<Response> {
  const now = NOW();
  const week = weekStart(now);
  const [counts, open, done, doneCount, feed] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE client = ? AND status IN ('new','waiting','doing') GROUP BY status").bind(client),
    c.env.DB.prepare(`${topOpen("new")} UNION ALL ${topOpen("waiting")} UNION ALL ${topOpen("doing")}`).bind(client),
    c.env.DB.prepare(withCounts(`SELECT * FROM (${DONE_WEEK}) WHERE done_at >= ?2 ORDER BY done_at DESC LIMIT 5`)).bind(client, week),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (${DONE_WEEK}) WHERE done_at >= ?2`).bind(client, week),
    c.env.DB.prepare(`SELECT e.id, e.ts, e.kind, e.to_val, e.task_id, t.title, u.name AS who,
        CASE WHEN e.kind = 'comment' THEN (SELECT substr(m.body, 1, 160) FROM task_comments m WHERE m.id = CAST(e.to_val AS INTEGER)) END AS excerpt
      FROM task_events e JOIN tasks t ON t.id = e.task_id LEFT JOIN users u ON u.id = e.user_id
      WHERE e.client = ? AND e.kind IN ('comment','status') ORDER BY e.id DESC LIMIT 15`).bind(client),
  ]);
  const n = Object.fromEntries((counts.results as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const rows = open.results as HomeItem[];
  const card = (key: string, count: number, items: HomeItem[]) => ({ key, label: key === "doneweek" ? "Done this week" : STATUS_LABEL[key], count, items });
  return json({
    client, clientName: CLIENT_NAME[client],
    clients: s.user.role === "admin" ? Object.entries(CLIENT_NAME).map(([id, name]) => ({ id, name })) : undefined,
    cards: [
      card("new", n.new ?? 0, rows.filter((x) => x.status === "new")),
      card("waiting", n.waiting ?? 0, rows.filter((x) => x.status === "waiting")),
      card("doing", n.doing ?? 0, rows.filter((x) => x.status === "doing")),
      card("doneweek", (doneCount.results[0] as { n: number } | undefined)?.n ?? 0, done.results as HomeItem[]),
    ],
    activity: feed.results, week_start: week, now,
  });
}

export async function tasksRoute(c: Ctx, s: Session, path: string): Promise<Response> {
  const mods: string[] = JSON.parse(s.user.modules || "[]");
  if (!mods.includes("tasks") && s.user.role !== "admin") {
    audit(c, s.user.id, "tasks.denied", 403);
    return json({ error: "You don't have the tasks page." }, 403);
  }
  const method = c.req.method;
  const client = clientFor(c, s);
  if (!client) return json({ error: "Unknown client." }, 400);

  if (path === "/api/home" && method === "GET") return homeData(c, s, client);
  if (path === "/api/tasks" && method === "GET") return listTasks(c, s, client);
  if (path === "/api/tasks" && method === "POST") return createTask(c, s, client);
  if (path === "/api/requests" && method === "POST") return sendRequest(c, s, client);
  if (path === "/api/files" && method === "POST") return uploadFile(c, s);

  const fm = path.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (fm && method === "GET") return downloadFile(c, s, fm[1]);

  const tm = path.match(/^\/api\/tasks\/(\d{1,9})(\/resend|\/files|\/comments|\/lock)?$/);
  if (tm) {
    const id = Number(tm[1]);
    if (!tm[2] && method === "GET") return getTask(c, s, id);
    if (!tm[2] && method === "POST") return updateTask(c, s, id);
    if (tm[2] === "/resend" && method === "POST") return resend(c, s, id);
    if (tm[2] === "/files" && method === "POST") return addFiles(c, s, id);
    if (tm[2] === "/comments" && method === "POST") return addComment(c, s, id);
    if (tm[2] === "/lock" && method === "POST") return setLock(c, s, id);
  }
  return json({ error: "Not found." }, 404);
}

// Daily: retry failed request emails (3 tries total) and clear uploads never attached to a task.
export async function tasksCron(env: Env, exec: ExecutionContext): Promise<void> {
  const stray = (await env.DB.prepare("SELECT id FROM files WHERE task_id IS NULL AND created_at < ? LIMIT 200").bind(NOW() - DAY).all<{ id: string }>()).results;
  for (const f of stray) {
    await env.FILES.delete(`f/${f.id}`);
    await env.DB.prepare("DELETE FROM files WHERE id = ? AND task_id IS NULL").bind(f.id).run();
  }
  const failed = (await env.DB.prepare(
    "SELECT id FROM tasks WHERE source = 'request' AND mail_status IN ('failed','sending') AND mail_tries < 3 AND updated_at < ? LIMIT 5",
  ).bind(NOW() - HOUR).all<{ id: number }>()).results;
  const fake: Ctx = { req: new Request(`https://${env.PROD_HOST}/cron`), env, exec, ip: "cron" };
  for (const t of failed) await mailTask(fake, t.id, null);
}

export { STATUS_LABEL };
