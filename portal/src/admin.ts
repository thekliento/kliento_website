import { audit, type Ctx, type Session } from "./auth";
import { NOW, breachedCount, hashPassword, isEmail, json, passwordProblem, randomId } from "./lib";

const CLIENTS = ["riverworks", "kliento"];

async function readJson<T>(req: Request): Promise<T | null> {
  if (Number(req.headers.get("Content-Length") || "0") > 16 * 1024) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function checkPassword(pw: string, email: string): Promise<string | null> {
  const problem = passwordProblem(pw, email);
  if (problem) return problem;
  if ((await breachedCount(pw)) > 0) return "That password shows up in known data breaches. Pick another.";
  return null;
}

export async function adminRoute(c: Ctx, s: Session, path: string): Promise<Response> {
  if (s.user.role !== "admin") {
    audit(c, s.user.id, "admin.denied", 403);
    return json({ error: "Only Camilo can do that." }, 403);
  }

  if (path === "/api/admin/users" && c.req.method === "GET") {
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.client, u.email, u.name, u.role, u.status, u.email_verified_at, u.locked_until, u.created_at,
        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
        (SELECT MAX(last_seen) FROM sessions x WHERE x.user_id = u.id) AS last_seen,
        (SELECT COUNT(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > ?) AS sessions
       FROM users u ORDER BY u.created_at`,
    ).bind(NOW()).all();
    const allowed = await c.env.DB.prepare(
      "SELECT a.email, a.name FROM allowed_emails a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.email = a.email) ORDER BY a.name",
    ).all();
    return json({ users: rows.results, available: allowed.results });
  }

  if (path === "/api/admin/users" && c.req.method === "POST") {
    const b = await readJson<{ email?: string; name?: string; role?: string; client?: string; password?: string }>(c.req);
    const email = String(b?.email || "").trim().toLowerCase();
    const name = String(b?.name || "").trim().slice(0, 80);
    const role = b?.role === "admin" ? "admin" : "member";
    const client = CLIENTS.includes(String(b?.client)) ? String(b?.client) : "riverworks";
    const pw = String(b?.password || "");
    if (!isEmail(email)) return json({ error: "Enter a real email address." }, 400);
    if (!name) return json({ error: "Enter the person's name." }, 400);
    const bad = await checkPassword(pw, email);
    if (bad) return json({ error: bad }, 400);
    // Core rule: only emails on the allowed list can ever have an account (also enforced by a DB trigger).
    const allowed = await c.env.DB.prepare("SELECT 1 FROM allowed_emails WHERE email = ?").bind(email).first();
    if (!allowed) {
      audit(c, s.user.id, "admin.user_blocked", 403, email);
      return json({ error: "That email isn't on the allowed list, so it can't have an account." }, 403);
    }
    const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
    if (exists) return json({ error: "Someone already has that email." }, 409);
    const id = randomId();
    await c.env.DB.prepare(
      "INSERT INTO users (id,client,email,name,role,pw_hash,status,created_at,created_by) VALUES (?,?,?,?,?,?,'active',?,?)",
    ).bind(id, client, email, name, role, await hashPassword(pw, c.env.PEPPER), NOW(), s.user.id).run();
    audit(c, s.user.id, "admin.user_created", 200, `${email} ${role} ${client}`);
    return json({ ok: true, id });
  }

  const m = path.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/);
  if (m && c.req.method === "POST") {
    const id = m[1];
    const b = await readJson<{ action?: string; password?: string }>(c.req);
    const user = await c.env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(id).first<{ id: string; email: string }>();
    if (!user) return json({ error: "No such person." }, 404);
    const self = id === s.user.id;
    switch (b?.action) {
      case "disable":
        if (self) return json({ error: "You can't turn off your own account." }, 400);
        await c.env.DB.batch([
          c.env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(id),
          c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
        ]);
        break;
      case "enable":
        await c.env.DB.prepare("UPDATE users SET status = 'active', failed_pw = 0, locked_until = 0 WHERE id = ?").bind(id).run();
        break;
      case "end_sessions":
        await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(id, s.idHash).run();
        break;
      case "reset_passkeys":
        // Next sign-in goes through email + password + code, then a new passkey.
        await c.env.DB.batch([
          c.env.DB.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(id),
          c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(id, s.idHash),
        ]);
        break;
      case "set_password": {
        const pw = String(b?.password || "");
        const bad = await checkPassword(pw, user.email);
        if (bad) return json({ error: bad }, 400);
        await c.env.DB.prepare("UPDATE users SET pw_hash = ?, failed_pw = 0, locked_until = 0 WHERE id = ?").bind(await hashPassword(pw, c.env.PEPPER), id).run();
        break;
      }
      default:
        return json({ error: "Unknown action." }, 400);
    }
    audit(c, s.user.id, `admin.${b.action}`, 200, user.email);
    return json({ ok: true });
  }

  if (path === "/api/admin/audit" && c.req.method === "GET") {
    const rows = await c.env.DB.prepare(
      `SELECT a.ts, a.ip, a.method, a.path, a.action, a.status, a.detail, u.email
       FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`,
    ).all();
    return json({ events: rows.results });
  }

  return json({ error: "Not found." }, 404);
}
