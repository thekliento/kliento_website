(function () {
  const $ = (id) => document.getElementById(id);
  const views = ["vEmail", "vPassword", "vSent", "vVerify"];
  let email = "";

  function show(id) {
    views.forEach((v) => { $(v).hidden = v !== id; });
    const first = $(id).querySelector("input:not([type=checkbox]):not([hidden]), button.primary");
    if (first) first.focus();
  }
  function err(id, msg) { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; }

  // /verify#t=... : the emailed link. The token rides in the #fragment so it never reaches a server log.
  if (location.pathname === "/verify") {
    const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
    history.replaceState(null, "", "/verify");
    show("vVerify");
    (async () => {
      if (!token) { $("vfTitle").textContent = "That link is incomplete"; err("vfErr", "Open the link straight from the email."); $("vfAlt").hidden = false; return; }
      const r = await KP.post("/api/auth/verify", { token });
      if (!r.ok) { $("vfTitle").textContent = "That link didn't work"; err("vfErr", r.body.error || "Try signing in."); $("vfAlt").hidden = false; return; }
      location.replace("/app");
    })();
    return;
  }

  $("emForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err("emErr");
    email = $("email").value.trim();
    if (!email) { err("emErr", "Enter your email."); return; }
    $("emBtn").disabled = true;
    const r = await KP.post("/api/auth/join/check", { email });
    $("emBtn").disabled = false;
    if (r.body.signIn) { location.href = "/login"; return; }
    if (!r.ok) { err("emErr", r.body.error || "That didn't work. Try again."); return; }
    $("pwHi").textContent = r.body.name ? "Hi " + r.body.name + ", make a password" : "Make a password";
    $("pwUser").value = email;
    show("vPassword");
  });

  $("pwForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err("pwErr");
    if ($("pw1").value !== $("pw2").value) { err("pwErr", "The two passwords don't match."); return; }
    $("pwBtn").disabled = true;
    const r = await KP.post("/api/auth/join", { email, password: $("pw1").value, remember: $("remember").checked });
    $("pwBtn").disabled = false;
    if (r.body.signIn) { location.href = "/login"; return; }
    if (!r.ok) { err("pwErr", r.body.error || "That didn't work. Try again."); return; }
    $("pw1").value = ""; $("pw2").value = "";
    $("sentTo").textContent = r.body.to || email;
    show("vSent");
  });

  show("vEmail");
})();
