(function () {
  const $ = (id) => document.getElementById(id);
  const views = ["vPasskey", "vEmail", "vCode", "vEnroll"];
  const params = new URLSearchParams(location.search);
  const next = /^\/app(\/[a-z0-9/_-]*)?$/i.test(params.get("next") || "") ? params.get("next") : "/app";
  const FAILS = "kp_passkey_fails";

  function show(id) {
    views.forEach((v) => { $(v).hidden = v !== id; });
    const first = $(id).querySelector("input:not([type=checkbox]), button.primary");
    if (first) first.focus();
  }
  function err(id, msg) { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; }
  function fails() { try { return Number(localStorage.getItem(FAILS) || 0); } catch (_) { return 0; } }
  function setFails(n) { try { localStorage.setItem(FAILS, String(n)); } catch (_) { /* private mode */ } }
  function remember() { return $("vCode").hidden ? $("remember1").checked : $("remember2").checked; }
  function go() { setFails(0); location.replace(next); }

  function refreshFallback() {
    const f = fails();
    $("fallback").hidden = f < 3;
    if (f >= 3) $("firstTime").hidden = true;
  }

  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go)));

  $("pkBtn").addEventListener("click", async () => {
    err("pkErr");
    if (!KP.supported) { err("pkErr", "This browser can't use passkeys. Sign in with email instead."); $("fallback").hidden = false; return; }
    $("pkBtn").disabled = true;
    try {
      const o = await KP.post("/api/auth/passkey/options");
      if (!o.ok) throw new Error(o.body.error || "Try again.");
      let response;
      try { response = await KP.get(o.body); } catch (_) { throw new Error("The passkey was cancelled or didn't work."); }
      const v = await KP.post("/api/auth/passkey/verify", { response, remember: $("remember1").checked });
      if (!v.ok) throw new Error(v.body.error || "That passkey didn't check out.");
      go();
    } catch (e) {
      const n = fails() + 1; setFails(n);
      err("pkErr", n >= 3 ? e.message + " You can sign in with email instead." : e.message);
      refreshFallback();
    } finally { $("pkBtn").disabled = false; }
  });

  $("emForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err("emErr");
    const email = $("email").value.trim(), password = $("password").value;
    if (!email || !password) { err("emErr", "Enter your email and password."); return; }
    $("emBtn").disabled = true;
    const r = await KP.post("/api/auth/password", { email, password, passkeyFails: fails() });
    $("emBtn").disabled = false;
    if (r.body.usePasskey) { show("vPasskey"); err("pkErr", r.body.error); return; }
    if (!r.ok) { err("emErr", r.body.error || "That didn't work. Try again."); return; }
    $("password").value = "";
    $("codeTo").textContent = r.body.to || "your email";
    show("vCode");
  });

  $("code").addEventListener("input", () => {
    $("code").value = $("code").value.replace(/\D/g, "").slice(0, 6);
    if ($("code").value.length === 6) $("cdForm").requestSubmit();
  });

  $("cdForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err("cdErr");
    const code = $("code").value;
    if (code.length !== 6) { err("cdErr", "Enter the 6 digits from the email."); return; }
    $("cdBtn").disabled = true;
    const r = await KP.post("/api/auth/code", { code, remember: $("remember2").checked });
    $("cdBtn").disabled = false;
    if (!r.ok) {
      err("cdErr", r.body.error || "That code didn't work.");
      if (/Start again|expired/.test(r.body.error || "")) setTimeout(() => show("vEmail"), 1500);
      return;
    }
    if (r.body.next === "passkey") { $("enSkip").hidden = true; show("vEnroll"); return; }
    if (r.body.offerPasskey) { $("enSkip").hidden = false; show("vEnroll"); return; }
    go();
  });

  $("enBtn").addEventListener("click", async () => {
    err("enErr");
    if (!KP.supported) { err("enErr", "This browser can't save passkeys. Try Safari or Chrome on your phone or computer."); return; }
    $("enBtn").disabled = true;
    try {
      const o = await KP.post("/api/auth/passkey/register/options");
      if (!o.ok) throw new Error(o.body.error || "Try again.");
      let response;
      try { response = await KP.create(o.body); } catch (_) { throw new Error("Your device didn't save the passkey. Try again."); }
      const v = await KP.post("/api/auth/passkey/register/verify", { response, label: navigator.platform || "" });
      if (!v.ok) throw new Error(v.body.error || "Try again.");
      go();
    } catch (e) { err("enErr", e.message); } finally { $("enBtn").disabled = false; }
  });
  $("skipBtn").addEventListener("click", go);

  (async function boot() {
    refreshFallback();
    try {
      const r = await fetch("/api/me", { credentials: "same-origin" });
      if (r.ok) {
        const me = await r.json();
        if (me.stage === "full") { location.replace(next); return; }
        if (me.stage === "enroll") { show("vEnroll"); return; }
      }
    } catch (_) { /* offline */ }
    show(fails() >= 3 ? "vEmail" : "vPasskey");
  })();
})();
