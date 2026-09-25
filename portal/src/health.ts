import { audit, type Ctx, type Session } from "./auth";
import { DAY, HOUR, NOW, hmac, json, safeEqual } from "./lib";

// Website health: the morning check on Camilo's Mac (verify-live-tracking.sh) posts its result
// here, signed with HEALTH_KEY over "<timestamp>.<body>". No session; the signature is the key.
// A request older than 5 minutes is refused, and the same run sent twice is stored once.

const KEYS = ["site_up", "click_tracking", "tags_on", "old_tags_gone", "old_files_hidden"] as const;
const MAX_BODY = 16 * 1024;
const TZ = "America/New_York";

type Check = { key: string; ok: boolean | null; detail: string };

async function readText(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("Content-Length") || "0") > max) return null;
  if (!req.body) return "";
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
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(out); } catch { return null; }
}

const clean = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

export async function healthReport(c: Ctx): Promise<Response> {
  if (!c.env.HEALTH_KEY) return json({ error: "Not set up." }, 503);
  const ts = Number(c.req.headers.get("X-Health-Ts") || "");
  const sig = c.req.headers.get("X-Health-Sig") || "";
  const raw = await readText(c.req, MAX_BODY);
  if (raw === null) {
    audit(c, null, "health.denied", 413, "body too big or not text");
    return json({ error: "Too big." }, 413);
  }
  const now = NOW();
  if (!Number.isInteger(ts) || Math.abs(now - ts) > 300 || !sig || sig.length > 100) {
    audit(c, null, "health.denied", 401, "missing or old timestamp");
    return json({ error: "Blocked." }, 401);
  }
  if (!safeEqual(await hmac(c.env.HEALTH_KEY, `${ts}.${raw}`), sig)) {
    audit(c, null, "health.denied", 401, "bad signature");
    return json({ error: "Blocked." }, 401);
  }

  let b: { ran_at?: unknown; ok?: unknown; checks?: unknown };
  try { b = JSON.parse(raw); } catch { return json({ error: "Not JSON." }, 400); }
  const ranAt = Number(b?.ran_at);
  if (!Number.isInteger(ranAt) || ranAt < now - 6 * HOUR || ranAt > now + 300 || typeof b.ok !== "boolean" || !Array.isArray(b.checks) || b.checks.length > 20) {
    return json({ error: "Wrong shape." }, 400);
  }
  const got = new Map<string, Check>();
  for (const x of b.checks as { key?: unknown; ok?: unknown; detail?: unknown }[]) {
    const key = String(x?.key ?? "");
    if (!(KEYS as readonly string[]).includes(key) || got.has(key)) return json({ error: "Wrong shape." }, 400);
    if (x.ok !== true && x.ok !== false && x.ok !== null) return json({ error: "Wrong shape." }, 400);
    got.set(key, { key, ok: x.ok, detail: clean(x.detail, 300) });
  }
  const checks = KEYS.map((k) => got.get(k) ?? { key: k, ok: null, detail: "" });
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO health_reports (client, ran_at, ok, checks, created_at) VALUES ('riverworks', ?, ?, ?, ?)")
    .bind(ranAt, b.ok ? 1 : 0, JSON.stringify(checks), now).run();
  const stored = (r.meta.changes ?? 0) > 0;
  audit(c, null, stored ? "health.reported" : "health.duplicate", 200, `${b.ok ? "pass" : "fail"} ran ${ranAt}`);
  return json({ ok: true, stored });
}

// YYYY-MM-DD in Buffalo time.
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const localDay = (unix: number) => dayFmt.format(new Date(unix * 1000));

export async function getHealth(c: Ctx, s: Session): Promise<Response> {
  const q = new URL(c.req.url).searchParams.get("client") || "riverworks";
  const client = s.user.role !== "admin" ? s.user.client : ["riverworks", "kliento"].includes(q) ? q : "riverworks";
  const now = NOW();
  const rows = (await c.env.DB.prepare("SELECT ran_at, ok, checks FROM health_reports WHERE client = ? AND ran_at > ? ORDER BY ran_at DESC LIMIT 200")
    .bind(client, now - 16 * DAY).all<{ ran_at: number; ok: number; checks: string }>()).results;
  const byDay = new Map<string, boolean>();
  for (const r of rows) {
    const d = localDay(r.ran_at);
    if (!byDay.has(d)) byDay.set(d, r.ok === 1); // rows are newest first, so the day's last run wins
  }
  const [y, m, d] = localDay(now).split("-").map(Number);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
    days.push({ date, ok: byDay.has(date) ? byDay.get(date) : null });
  }
  const top = rows[0];
  let latest = null;
  if (top) {
    let checks: Check[] = [];
    try { checks = JSON.parse(top.checks); } catch { checks = []; }
    latest = { ran_at: top.ran_at, ok: top.ok === 1, checks };
  }
  return json({ site: "buffaloriverworks.com", latest, days, now });
}
