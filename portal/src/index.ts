import loginPage from "./pages/login.html";
import setupPage from "./pages/setup.html";
import joinPage from "./pages/join.html";
import appPage from "./pages/app.html";
import {
  audit, getSession, joinCheck, joinStep, logout, passkeyLoginOptions, passkeyLoginVerify, passkeyRegisterOptions,
  passkeyRegisterVerify, passwordStep, setupStep, verifyStep, type Ctx,
} from "./auth";
import { adminRoute } from "./admin";
import { mailFile, tasksCron, tasksRoute } from "./tasks";
import { DAY, NOW, clientIp, html, json, secure } from "./lib";

// Sarah's two JSON mirrors are read straight from the repo, so a bot commit is live within
// two minutes with no redeploy. If GitHub is unreachable, the copy bundled at deploy answers.
async function dataFile(req: Request, env: Env, exec: ExecutionContext, path: string): Promise<Response> {
  const name = path.slice("/data/".length);
  if (!/^[a-z0-9-]+\.json$/.test(name)) return env.ASSETS.fetch(req);
  const cache = caches.default;
  const key = new Request(new URL(req.url).origin + path);
  const hit = await cache.match(key);
  if (hit) return hit;
  let res: Response;
  try {
    const upstream = await fetch(env.DATA_ORIGIN + name, { cf: { cacheTtl: 60 } });
    if (!upstream.ok) throw new Error(String(upstream.status));
    res = new Response(upstream.body, { status: 200 });
  } catch {
    const fallback = await env.ASSETS.fetch(req);
    if (!fallback.ok) return fallback;
    res = new Response(fallback.body, { status: 200 });
  }
  res.headers.set("Content-Type", "application/json; charset=utf-8");
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Cache-Control", "public, max-age=120");
  exec.waitUntil(cache.put(key, res.clone()));
  return res;
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  const host = new URL(req.url).origin;
  return origin === host && req.headers.get("X-Kliento") === "1";
}

function safeNext(raw: string | null): string {
  return raw && /^\/app(\/[a-z0-9/_-]*)?$/i.test(raw) ? raw : "/app";
}

async function api(c: Ctx, path: string): Promise<Response> {
  const method = c.req.method;
  if (method !== "GET" && !sameOrigin(c.req)) {
    audit(c, null, "csrf.blocked", 403);
    return json({ error: "Blocked." }, 403);
  }
  const limiter = path.startsWith("/api/auth/") || path === "/api/setup" ? c.env.RL_AUTH : c.env.RL_API;
  const { success } = await limiter.limit({ key: c.ip });
  if (!success) {
    audit(c, null, "ratelimited", 429, path);
    return json({ error: "Too many tries. Wait a minute and try again." }, 429, { "Retry-After": "60" });
  }

  if (method === "POST") {
    if (path === "/api/auth/password") return passwordStep(c);
    if (path === "/api/auth/join/check") return joinCheck(c);
    if (path === "/api/auth/join") return joinStep(c);
    if (path === "/api/auth/verify") return verifyStep(c);
    if (path === "/api/auth/passkey/options") return passkeyLoginOptions(c);
    if (path === "/api/auth/passkey/verify") return passkeyLoginVerify(c);
    if (path === "/api/setup") return setupStep(c);
  }

  // The mailer's signed attachment links: no session, the HMAC signature is the only key.
  const mf = path.match(/^\/api\/mailfile\/([^/]{1,64})$/);
  if (mf && method === "GET") return mailFile(c, mf[1]);

  const s = await getSession(c);
  if (path === "/api/auth/logout" && method === "POST") return logout(c, s);
  if (!s) {
    audit(c, null, "api.unauthenticated", 401, path);
    return json({ error: "Sign in first." }, 401);
  }
  if (method === "POST" && path === "/api/auth/passkey/register/options") return passkeyRegisterOptions(c, s);
  if (method === "POST" && path === "/api/auth/passkey/register/verify") return passkeyRegisterVerify(c, s);
  if (method === "GET" && path === "/api/me") {
    return json({
      stage: s.stage,
      user: { name: s.user.name, email: s.user.email, role: s.user.role, client: s.user.client, modules: JSON.parse(s.user.modules || "[]") },
    });
  }
  if (s.stage !== "full") return json({ error: "Add your passkey first." }, 403);
  audit(c, s.user.id, "api", 200, `${method} ${path}`);
  if (path.startsWith("/api/admin/")) return adminRoute(c, s, path);
  if (path === "/api/tasks" || path.startsWith("/api/tasks/") || path === "/api/requests" || path === "/api/files" || path.startsWith("/api/files/")) {
    return tasksRoute(c, s, path);
  }
  return json({ error: "Not found." }, 404);
}

async function route(c: Ctx): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;

  if (path.startsWith("/data/")) return dataFile(c.req, c.env, c.exec, path);

  if (path.startsWith("/api/")) return secure(await api(c, path));

  if (c.req.method !== "GET" && c.req.method !== "HEAD") return secure(json({ error: "Method not allowed." }, 405));

  if (path === "/login" || path === "/login/") return secure(html(loginPage));
  if (path === "/setup") return secure(html(setupPage));
  if (path === "/join" || path === "/join/" || path === "/verify") return secure(html(joinPage));

  if (path === "/app" || path.startsWith("/app/")) {
    const s = await getSession(c);
    if (!s || s.stage !== "full") {
      audit(c, s?.user.id ?? null, "page.redirect_login", 302, path);
      return secure(new Response(null, { status: 302, headers: { Location: `/login?next=${encodeURIComponent(safeNext(path))}` } }));
    }
    return secure(html(appPage));
  }
  return secure(new Response("Not found", { status: 404 }));
}

export default {
  async fetch(req, env, exec): Promise<Response> {
    const c: Ctx = { req, env, exec, ip: clientIp(req) };
    try {
      return await route(c);
    } catch (e) {
      console.error(JSON.stringify({ msg: "unhandled", path: new URL(req.url).pathname, error: e instanceof Error ? e.message : String(e) }));
      return secure(json({ error: "Something broke on our side. Try again." }, 500));
    }
  },

  async scheduled(_event, env, exec): Promise<void> {
    const now = NOW();
    exec.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM pending WHERE expires_at < ?").bind(now),
        env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
        env.DB.prepare("DELETE FROM audit WHERE ts < ?").bind(now - 365 * DAY),
      ]).then(() => undefined),
    );
    exec.waitUntil(tasksCron(env, exec));
  },
} satisfies ExportedHandler<Env>;
