(function () {
  const $ = (id) => document.getElementById(id);
  // The token rides in the #fragment so it never reaches a server log.
  const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
  history.replaceState(null, "", "/setup");
  const err = (m) => { $("stErr").textContent = m || ""; $("stErr").hidden = !m; };
  if (!token) err("This setup link is missing its code. Ask Camilo for a new one.");
  $("stForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err();
    if ($("pw1").value !== $("pw2").value) { err("The two passwords don't match."); return; }
    $("stBtn").disabled = true;
    const r = await KP.post("/api/setup", { token, password: $("pw1").value });
    $("stBtn").disabled = false;
    if (!r.ok) { err(r.body.error || "That didn't work."); return; }
    $("pw1").value = ""; $("pw2").value = "";
    $("vSet").hidden = true; $("vDone").hidden = false;
  });
})();
