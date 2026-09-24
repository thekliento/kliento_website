import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  DAY, HOUR, MIN, NOW, b64url, breachedCount, cookie, getCookie, hashPassword, hmac, isEmail, json, passwordProblem,
  randomId, randomToken, safeEqual, sha256, sixDigitCode, unb64url, verifyPassword,
} from "./lib";
import { sendMail } from "./mail";

export const SESSION_COOKIE = "__Host-kp_s";
const STEP_COOKIE = "__Host-kp_p";
const REMEMBER_S = 30 * DAY;
const SHORT_IDLE_S = 12 * HOUR;
const SHORT_MAX_S = DAY;
const CODE_TTL_S = 10 * MIN;
const CODE_TRIES = 5;
const PW_TRIES = 5;
const LOCK_S = 15 * MIN;

export type User = {
  id: string; client: string; email: string; name: string; role: "admin" | "member"; modules: string;
  pw_hash: string | null; status: string; email_verified_at: number | null; failed_pw: number; locked_until: number;
};
export type Session = { user: User; stage: "enroll" | "full"; idHash: string; remember: number };

export type Ctx = { req: Request; env: Env; exec: ExecutionContext; ip: string };

export function audit(c: Ctx, userId: string | null, action: string, status: number, detail = ""): void {
  const u = new URL(c.req.url);
  c.exec.waitUntil(
    c.env.DB.prepare("INSERT INTO audit (ts,user_id,ip,method,path,action,status,detail) VALUES (?,?,?,?,?,?,?,?)")
      .bind(NOW(), userId, c.ip, c.req.method, u.pathname, action, status, detail.slice(0, 500))
      .run()
      .then(() => undefined),
  );
}

export function rp(req: Request, env: Env): { rpID: string; origin: string } | null {
  const host = new URL(req.url).hostname;
  if (host === env.PROD_HOST || (host.startsWith("thekliento.") && host.endsWith(".workers.dev"))) {
    return { rpID: host, origin: `https://${host}` };
  }
  return null;
}

export async function getSession(c: Ctx): Promise<Session | null> {
  const tok = getCookie(c.req, SESSION_COOKIE);
  if (!tok || tok.length > 100) return null;
  const idHash = await sha256(tok);
  const row = await c.env.DB.prepare(
    `SELECT s.stage, s.remember, s.created_at, s.last_seen, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
  ).bind(idHash).first<User & { stage: "enroll" | "full"; remember: number; created_at: number; last_seen: number; expires_at: number }>();
  if (!row) return null;
  const now = NOW();
  const idleDead = !row.remember && row.last_seen + SHORT_IDLE_S < now;
  if (row.expires_at < now || idleDead || row.status !== "active") {
    c.exec.waitUntil(c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run().then(() => undefined));
    return null;
  }
  if (now - row.last_seen > 5 * MIN) {
    c.exec.waitUntil(c.env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").bind(now, idHash).run().then(() => undefined));
  }
  return { user: row, stage: row.stage, idHash, remember: row.remember };
}

async function startSession(c: Ctx, userId: string, stage: "enroll" | "full", remember: boolean): Promise<string> {
  const tok = randomToken(32);
  const now = NOW();
  const expires = stage === "enroll" ? now + 30 * MIN : remember ? now + REMEMBER_S : now + SHORT_MAX_S;
  await c.env.DB.prepare(
    "INSERT INTO sessions (id_hash,user_id,stage,remember,created_at,last_seen,expires_at,ip,ua) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(await sha256(tok), userId, stage, remember ? 1 : 0, now, now, expires, c.ip, (c.req.headers.get("User-Agent") || "").slice(0, 200)).run();
  return cookie(SESSION_COOKIE, tok, remember && stage === "full" ? REMEMBER_S : null);
}

async function newStep(c: Ctx, kind: string, userId: string | null, fields: { secret?: string; challenge?: string; data?: string }, ttl: number): Promise<string> {
  const tok = randomToken(24);
  await c.env.DB.prepare(
    "INSERT INTO pending (id_hash,kind,user_id,secret_hash,challenge,data,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(await sha256(tok), kind, userId, fields.secret ?? null, fields.challenge ?? null, fields.data ?? null, NOW(), NOW() + ttl).run();
  return cookie(STEP_COOKIE, tok, ttl);
}

type Step = { id_hash: string; kind: string; user_id: string | null; secret_hash: string | null; challenge: string | null; attempts: number; data: string | null; expires_at: number };

async function readStep(c: Ctx, kind: string): Promise<Step | null> {
  const tok = getCookie(c.req, STEP_COOKIE);
  if (!tok || tok.length > 100) return null;
  const row = await c.env.DB.prepare("SELECT * FROM pending WHERE id_hash = ? AND kind = ?").bind(await sha256(tok), kind).first<Step>();
  if (!row || row.expires_at < NOW()) return null;
  return row;
}

const clearStep = cookie(STEP_COOKIE, "", 0);

async function body<T>(req: Request): Promise<T | null> {
  const len = Number(req.headers.get("Content-Length") || "0");
  if (len > 64 * 1024) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function userByEmail(env: Env, email: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.trim().toLowerCase()).first<User>();
}

async function passkeyCount(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

async function sendCode(c: Ctx, user: User): Promise<{ ok: boolean; cookie?: string }> {
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pending WHERE kind = 'email_code' AND user_id = ? AND created_at > ?")
    .bind(user.id, NOW() - 15 * MIN).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 3) return { ok: false };
  const code = sixDigitCode();
  const mail = await sendMail(c.env, { type: "code", to: user.email, name: user.name, code });
  if (!mail.ok) {
    audit(c, user.id, "code.mail_failed", 502, mail.error || "");
    return { ok: false };
  }
  const setCookie = await newStep(c, "email_code", user.id, { secret: await hmac(c.env.CODE_KEY, code) }, CODE_TTL_S);
  return { ok: true, cookie: setCookie };
}

const GENERIC = "That email and password don't match an active account.";

// Step 1 of the email path. First sign-in, a new device, or after 3 failed passkey tries.
export async function passwordStep(c: Ctx): Promise<Response> {
  const b = await body<{ email?: string; password?: string; passkeyFails?: number }>(c.req);
  const email = String(b?.email || "").trim().toLowerCase();
  const password = String(b?.password || "");
  if (!isEmail(email) || !password || password.length > 200) return json({ error: GENERIC }, 400);

  const user = await userByEmail(c.env, email);
  const ok = await verifyPassword(password, user?.pw_hash ?? null, c.env.PEPPER);
  if (!user || user.status !== "active") {
    audit(c, null, "password.unknown", 401, email);
    return json({ error: GENERIC }, 401);
  }
  if (user.locked_until > NOW()) {
    audit(c, user.id, "password.locked", 423);
    return json({ error: "Too many tries. This account is locked for 15 minutes." }, 423);
  }
  if (!ok) {
    const fails = user.failed_pw + 1;
    const lock = fails >= PW_TRIES;
    await c.env.DB.prepare("UPDATE users SET failed_pw = ?, locked_until = ? WHERE id = ?")
      .bind(lock ? 0 : fails, lock ? NOW() + LOCK_S : 0, user.id).run();
    audit(c, user.id, lock ? "password.lockout" : "password.wrong", 401);
    if (lock) c.exec.waitUntil(sendMail(c.env, { type: "alert", subject: `Portal lockout: ${user.email}`, text: `${PW_TRIES} wrong passwords for ${user.email} from ${c.ip}. Locked for 15 minutes.` }).then(() => undefined));
    return json({ error: lock ? "Too many tries. This account is locked for 15 minutes." : GENERIC }, lock ? 423 : 401);
  }
  await c.env.DB.prepare("UPDATE users SET failed_pw = 0 WHERE id = ?").bind(user.id).run();

  // The email code is only for the first sign-in or after 3 failed passkey tries (Camilo's rule).
  const keys = await passkeyCount(c.env, user.id);
  if (keys > 0 && user.email_verified_at && Number(b?.passkeyFails || 0) < 3) {
    audit(c, user.id, "password.use_passkey", 409);
    return json({ error: "You already have a passkey. Use Sign in with passkey.", usePasskey: true }, 409);
  }
  const sent = await sendCode(c, user);
  if (!sent.ok) return json({ error: "We couldn't send a code right now. Wait a few minutes and try again." }, 429);
  audit(c, user.id, "code.sent", 200);
  return json({ next: "code", to: maskEmail(user.email) }, 200, { "Set-Cookie": sent.cookie as string });
}

function maskEmail(e: string): string {
  const [n, d] = e.split("@");
  return `${n.slice(0, 2)}${"*".repeat(Math.max(1, n.length - 2))}@${d}`;
}

// Step 2 of the email path: the 6-digit code.
export async function codeStep(c: Ctx): Promise<Response> {
  const b = await body<{ code?: string; remember?: boolean }>(c.req);
  const step = await readStep(c, "email_code");
  if (!step || !step.user_id) return json({ error: "That code expired. Start again." }, 400, { "Set-Cookie": clearStep });
  const code = String(b?.code || "").replace(/\D/g, "");
  const good = code.length === 6 && safeEqual(await hmac(c.env.CODE_KEY, code), step.secret_hash || "");
  if (!good) {
    const tries = step.attempts + 1;
    if (tries >= CODE_TRIES) {
      await c.env.DB.prepare("DELETE FROM pending WHERE id_hash = ?").bind(step.id_hash).run();
      audit(c, step.user_id, "code.burned", 401);
      return json({ error: "Too many wrong codes. Start again." }, 401, { "Set-Cookie": clearStep });
    }
    await c.env.DB.prepare("UPDATE pending SET attempts = ? WHERE id_hash = ?").bind(tries, step.id_hash).run();
    audit(c, step.user_id, "code.wrong", 401);
    return json({ error: `That code is wrong. ${CODE_TRIES - tries} tries left.` }, 401);
  }
  await c.env.DB.prepare("DELETE FROM pending WHERE id_hash = ?").bind(step.id_hash).run();
  await c.env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").bind(NOW(), step.user_id).run();
  const keys = await passkeyCount(c.env, step.user_id);
  // No passkey yet: a 30-minute session that can only add one. Otherwise, signed in.
  const stage = keys === 0 ? "enroll" : "full";
  const setCookie = await startSession(c, step.user_id, stage, !!b?.remember);
  audit(c, step.user_id, `code.ok.${stage}`, 200);
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", setCookie);
  headers.append("Set-Cookie", clearStep);
  return new Response(JSON.stringify({ next: stage === "enroll" ? "passkey" : "app", offerPasskey: stage === "full" }), { status: 200, headers });
}

export async function passkeyLoginOptions(c: Ctx): Promise<Response> {
  const r = rp(c.req, c.env);
  if (!r) return json({ error: "Wrong site." }, 400);
  const opts = await generateAuthenticationOptions({ rpID: r.rpID, userVerification: "required", timeout: 60_000 });
  const setCookie = await newStep(c, "passkey_auth", null, { challenge: opts.challenge }, 5 * MIN);
  return json(opts, 200, { "Set-Cookie": setCookie });
}

export async function passkeyLoginVerify(c: Ctx): Promise<Response> {
  const r = rp(c.req, c.env);
  const b = await body<{ response?: AuthenticationResponseJSON; remember?: boolean }>(c.req);
  const step = await readStep(c, "passkey_auth");
  if (!r || !step?.challenge || !b?.response?.id) return json({ error: "That took too long. Try again." }, 400);
  await c.env.DB.prepare("DELETE FROM pending WHERE id_hash = ?").bind(step.id_hash).run();
  const key = await c.env.DB.prepare(
    "SELECT p.*, u.status FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?",
  ).bind(b.response.id).first<{ id: string; user_id: string; public_key: string; counter: number; transports: string | null; status: string }>();
  if (!key || key.status !== "active") {
    audit(c, key?.user_id ?? null, "passkey.unknown", 401);
    return json({ error: "That passkey isn't on an active account." }, 401, { "Set-Cookie": clearStep });
  }
  let verified = false;
  let newCounter = key.counter;
  try {
    const v = await verifyAuthenticationResponse({
      response: b.response,
      expectedChallenge: step.challenge,
      expectedOrigin: r.origin,
      expectedRPID: r.rpID,
      requireUserVerification: true,
      credential: { id: key.id, publicKey: unb64url(key.public_key), counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined },
    });
    verified = v.verified;
    newCounter = v.authenticationInfo.newCounter;
  } catch {
    verified = false;
  }
  if (!verified) {
    audit(c, key.user_id, "passkey.failed", 401);
    return json({ error: "That passkey didn't check out. Try again." }, 401, { "Set-Cookie": clearStep });
  }
  await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(newCounter, NOW(), key.id).run();
  const setCookie = await startSession(c, key.user_id, "full", !!b.remember);
  audit(c, key.user_id, "passkey.ok", 200);
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", setCookie);
  headers.append("Set-Cookie", clearStep);
  return new Response(JSON.stringify({ next: "app" }), { status: 200, headers });
}

export async function passkeyRegisterOptions(c: Ctx, s: Session): Promise<Response> {
  const r = rp(c.req, c.env);
  if (!r) return json({ error: "Wrong site." }, 400);
  const existing = await c.env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").bind(s.user.id).all<{ id: string; transports: string | null }>();
  const opts = await generateRegistrationOptions({
    rpName: c.env.RP_NAME,
    rpID: r.rpID,
    userName: s.user.email,
    userDisplayName: s.user.name,
    userID: new Uint8Array(new TextEncoder().encode(s.user.id)),
    attestationType: "none",
    timeout: 120_000,
    excludeCredentials: existing.results.map((k) => ({ id: k.id, transports: k.transports ? JSON.parse(k.transports) : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const setCookie = await newStep(c, "passkey_reg", s.user.id, { challenge: opts.challenge }, 5 * MIN);
  return json(opts, 200, { "Set-Cookie": setCookie });
}

export async function passkeyRegisterVerify(c: Ctx, s: Session): Promise<Response> {
  const r = rp(c.req, c.env);
  const b = await body<{ response?: RegistrationResponseJSON; label?: string }>(c.req);
  const step = await readStep(c, "passkey_reg");
  if (!r || !step?.challenge || step.user_id !== s.user.id || !b?.response) return json({ error: "That took too long. Try again." }, 400);
  await c.env.DB.prepare("DELETE FROM pending WHERE id_hash = ?").bind(step.id_hash).run();
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: b.response, expectedChallenge: step.challenge, expectedOrigin: r.origin, expectedRPID: r.rpID, requireUserVerification: true,
    });
    if (!v.verified) throw new Error("not verified");
    info = v.registrationInfo;
  } catch {
    audit(c, s.user.id, "passkey.register_failed", 400);
    return json({ error: "Your device didn't save the passkey. Try again." }, 400);
  }
  const cred = info.credential;
  await c.env.DB.prepare("INSERT INTO passkeys (id,user_id,public_key,counter,transports,label,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(cred.id, s.user.id, b64url(cred.publicKey), cred.counter, JSON.stringify(cred.transports || []), String(b.label || "").slice(0, 60) || null, NOW()).run();
  audit(c, s.user.id, "passkey.registered", 200);
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", clearStep);
  if (s.stage === "enroll") {
    // Swap the enroll session for a full one; the "keep me signed in" choice was made at the code step.
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(s.idHash).run();
    headers.append("Set-Cookie", await startSession(c, s.user.id, "full", !!s.remember));
  }
  return new Response(JSON.stringify({ next: "app" }), { status: 200, headers });
}

export async function logout(c: Ctx, s: Session | null): Promise<Response> {
  if (s) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(s.idHash).run();
    audit(c, s.user.id, "logout", 200);
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
}

// Bootstrap and admin-issued password resets: a one-time link lets the owner set the password.
export async function setupStep(c: Ctx): Promise<Response> {
  const b = await body<{ token?: string; password?: string }>(c.req);
  const tok = String(b?.token || "");
  if (tok.length < 20 || tok.length > 100) return json({ error: "This setup link isn't valid." }, 400);
  const row = await c.env.DB.prepare("SELECT * FROM pending WHERE id_hash = ? AND kind = 'setup'").bind(await sha256(tok)).first<Step>();
  if (!row || row.expires_at < NOW() || !row.user_id) return json({ error: "This setup link expired. Ask Camilo for a new one." }, 400);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first<User>();
  if (!user || user.status !== "active") return json({ error: "This account is not active." }, 400);
  const pw = String(b?.password || "");
  const problem = passwordProblem(pw, user.email);
  if (problem) return json({ error: problem }, 400);
  if ((await breachedCount(pw)) > 0) return json({ error: "That password shows up in known data breaches. Pick another." }, 400);
  await c.env.DB.prepare("UPDATE users SET pw_hash = ?, failed_pw = 0, locked_until = 0 WHERE id = ?").bind(await hashPassword(pw, c.env.PEPPER), user.id).run();
  await c.env.DB.prepare("DELETE FROM pending WHERE id_hash = ?").bind(row.id_hash).run();
  audit(c, user.id, "setup.password_set", 200);
  return json({ ok: true, email: user.email });
}

export { randomId };
