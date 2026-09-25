(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const next = /^\/app(\/[a-z0-9/_-]*)?$/i.test(params.get("next") || "") ? params.get("next") : "/app";
  function err(id, msg) { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; }
  function go() { location.replace(next); }

  $("emForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err("emErr"); err("pkErr");
    const email = $("email").value.trim(), password = $("password").value;
    if (!email || !password) { err("emErr", "Enter your email and password."); return; }
    $("emBtn").disabled = true;
    const r = await KP.post("/api/auth/password", { email, password, remember: $("remember").checked });
    $("emBtn").disabled = false;
    if (!r.ok) { err("emErr", r.body.error || "That didn't work. Try again."); return; }
    $("password").value = "";
    go();
  });

  // Optional: people who saved a passkey on this device can use it instead of the password.
  $("pkBtn").addEventListener("click", async () => {
    err("pkErr"); err("emErr");
    if (!KP.supported) { err("pkErr", "This browser can't use passkeys. Use your email and password."); return; }
    $("pkBtn").disabled = true;
    try {
      const o = await KP.post("/api/auth/passkey/options");
      if (!o.ok) throw new Error(o.body.error || "Try again.");
      let response;
      try { response = await KP.get(o.body); } catch (_) { throw new Error("The passkey was cancelled or didn't work. Use your email and password."); }
      const v = await KP.post("/api/auth/passkey/verify", { response, remember: $("remember").checked });
      if (!v.ok) throw new Error(v.body.error || "That passkey didn't check out.");
      go();
    } catch (e) { err("pkErr", e.message); } finally { $("pkBtn").disabled = false; }
  });

  (async function boot() {
    try {
      const r = await fetch("/api/me", { credentials: "same-origin" });
      if (r.ok && (await r.json()).stage === "full") { go(); return; }
    } catch (_) { /* offline */ }
    $("email").focus();
  })();
})();
