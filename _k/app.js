(function () {
  const $ = (id) => document.getElementById(id);
  // Every piece of user text goes in through textContent, never innerHTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const initials = (n) => (n || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const when = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
  function toast(msg) { const t = h("div", { class: "toast", role: "status" }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }
  async function getJ(path) {
    const r = await fetch(path, { credentials: "same-origin" });
    if (r.status === 401) { location.replace("/login?next=" + encodeURIComponent(location.pathname)); throw new Error("signed out"); }
    return r.json();
  }

  let me = null;
  const PAGES = {
    "/app/tasks": { title: "Web & IT Tasks", crumb: "Web & IT / Tasks", render: renderTasks },
    "/app/people": { title: "People & access", crumb: "Settings / People & access", render: renderPeople, admin: true },
    "/app/activity": { title: "Activity log", crumb: "Settings / Activity log", render: renderActivity, admin: true },
  };

  function nav() {
    const cur = location.pathname;
    $("navMain").replaceChildren(h("a", { class: "nv" + (cur === "/app/tasks" ? " on" : ""), href: "/app/tasks", "data-link": "" }, "Web & IT"));
    if (me.user.role === "admin") {
      $("navAdmin").hidden = false;
      $("navAdmin").replaceChildren(
        h("a", { class: "nv" + (cur === "/app/people" ? " on" : ""), href: "/app/people", "data-link": "" }, "People & access"),
        h("a", { class: "nv" + (cur === "/app/activity" ? " on" : ""), href: "/app/activity", "data-link": "" }, "Activity log"),
      );
    }
  }

  function render() {
    let path = location.pathname.replace(/\/$/, "");
    if (!PAGES[path] || (PAGES[path].admin && me.user.role !== "admin")) { history.replaceState(null, "", "/app/tasks"); path = "/app/tasks"; }
    const p = PAGES[path];
    document.title = p.title + " · Kliento Portal";
    $("crumb").textContent = p.crumb;
    nav();
    const view = $("view");
    view.replaceChildren(h("div", { class: "ptitle" }, h("h2", {}, p.title)));
    p.render(view);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]");
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); history.pushState(null, "", a.getAttribute("href")); render();
  });
  window.addEventListener("popstate", render);
  $("signOut").addEventListener("click", async (e) => { e.preventDefault(); await KP.post("/api/auth/logout"); location.replace("/login"); });

  function renderTasks(view) {
    view.append(h("div", { class: "tbar" }, h("span", { class: "note" }, "The task list and the Send a request button arrive in the next build.")),
      h("p", { class: "empty" }, "Nothing here yet."));
  }

  async function renderPeople(view) {
    const errBox = h("p", { class: "err", hidden: true, role: "alert" });
    const pw = h("input", { class: "inp", id: "npw", type: "text", autocomplete: "off", spellcheck: "false" });
    const form = h("form", { class: "panel", novalidate: true },
      h("h3", {}, "Add a person"), errBox,
      h("div", { class: "row2" },
        h("div", { class: "fld" }, h("label", { class: "lab", for: "nname" }, "Name"), h("input", { class: "inp", id: "nname", autocomplete: "off" })),
        h("div", { class: "fld" }, h("label", { class: "lab", for: "nemail" }, "Email"), h("select", { class: "inp", id: "nemail" }))),
      h("div", { class: "row2" },
        h("div", { class: "fld" }, h("label", { class: "lab", for: "nclient" }, "Client"),
          h("select", { class: "inp", id: "nclient" }, h("option", { value: "riverworks" }, "Buffalo RiverWorks"), h("option", { value: "kliento" }, "Kliento"))),
        h("div", { class: "fld" }, h("label", { class: "lab", for: "nrole" }, "Access"),
          h("select", { class: "inp", id: "nrole" }, h("option", { value: "member" }, "Member"), h("option", { value: "admin" }, "Admin, like you")))),
      h("div", { class: "fld" }, h("label", { class: "lab", for: "npw" }, "Password you give them"),
        h("div", { class: "pwrow" }, pw, h("button", { class: "btn plain", type: "button", onclick: () => { pw.value = strongPassword(); } }, "Make one"))),
      h("p", { class: "note" }, "Only the people on the allowed list can get an account. They sign in with this password once, confirm a code sent to their email, then save a passkey."),
      h("button", { class: "btn primary", type: "submit" }, "Add person"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); errBox.hidden = true;
      const r = await KP.post("/api/admin/users", { name: $("nname").value, email: $("nemail").value, client: $("nclient").value, role: $("nrole").value, password: pw.value });
      if (!r.ok) { errBox.textContent = r.body.error || "That didn't work."; errBox.hidden = false; return; }
      toast("Added. Hand them the email and password."); render();
    });

    const table = h("tbody");
    const wrap = h("div", { class: "tw" }, h("table", { class: "m" },
      h("thead", {}, h("tr", {}, ["Person", "Client", "Access", "Status", "Passkeys", "Last active", ""].map((t) => h("th", {}, t)))), table));
    view.append(h("div", { class: "tbar" }, h("span", { class: "note" }, "Only you can see this page.")), wrap, form, myPasskeyPanel());

    const data = await getJ("/api/admin/users");
    // Only emails on the allowed list can be picked; the server and database enforce the same rule.
    const sel = $("nemail");
    if (!data.available.length) { sel.append(h("option", { value: "" }, "Everyone on the allowed list has an account")); sel.disabled = true; }
    for (const a of data.available) sel.append(h("option", { value: a.email }, a.name + " (" + a.email + ")"));
    sel.addEventListener("change", () => { const a = data.available.find((x) => x.email === sel.value); if (a && !$("nname").value) $("nname").value = a.name; });
    if (data.available[0] && !$("nname").value) $("nname").value = data.available[0].name;
    for (const u of data.users) {
      const locked = u.locked_until > Date.now() / 1000;
      const status = u.status !== "active" ? h("span", { class: "pill gray" }, h("i"), "Off")
        : locked ? h("span", { class: "pill red" }, h("i"), "Locked")
        : !u.email_verified_at ? h("span", { class: "pill orange" }, h("i"), "Not signed in yet")
        : h("span", { class: "pill green" }, h("i"), "Active");
      const act = (action, label, cls, confirmText) => h("button", { class: "btn " + (cls || "plain"), type: "button", onclick: async (ev) => {
        const b = ev.currentTarget;
        if (confirmText && b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = confirmText; setTimeout(() => { b.dataset.armed = ""; b.textContent = label; }, 4000); return; }
        const r = await KP.post("/api/admin/users/" + u.id, { action });
        toast(r.ok ? "Done." : (r.body.error || "That didn't work.")); render();
      } }, label);
      const setPw = h("button", { class: "btn plain", type: "button", onclick: () => {
        const input = h("input", { class: "inp pwin", type: "text", value: strongPassword() });
        const save = h("button", { class: "btn primary", type: "button", onclick: async () => {
          const r = await KP.post("/api/admin/users/" + u.id, { action: "set_password", password: input.value });
          toast(r.ok ? "New password saved." : (r.body.error || "That didn't work.")); if (r.ok) render();
        } }, "Save");
        setPw.replaceWith(h("span", { class: "acts" }, input, save));
      } }, "New password");
      table.append(h("tr", {},
        h("td", {}, h("div", { class: "who" }, h("span", { class: "av" }, initials(u.name)), h("div", {}, h("div", { class: "bold" }, u.name), h("div", { class: "note" }, u.email)))),
        h("td", {}, u.client === "riverworks" ? "Buffalo RiverWorks" : "Kliento"),
        h("td", {}, u.role === "admin" ? "Admin" : "Member"),
        h("td", {}, status),
        h("td", {}, String(u.passkeys)),
        h("td", { class: "note" }, when(u.last_seen)),
        h("td", {}, h("div", { class: "acts" },
          u.status === "active" ? (u.email === me.user.email ? null : act("disable", "Turn off", "danger", "Click again to turn off")) : act("enable", "Turn on"),
          act("end_sessions", "Sign out everywhere"),
          act("reset_passkeys", "Reset passkeys", "plain", "Click again to reset"),
          setPw))));
    }
  }

  function myPasskeyPanel() {
    const msg = h("p", { class: "note" }, "Add one on each phone or computer you use, so a lost device never locks you out.");
    return h("div", { class: "panel" }, h("h3", {}, "Your passkeys"), msg,
      h("button", { class: "btn tint", type: "button", onclick: async () => {
        try {
          const o = await KP.post("/api/auth/passkey/register/options");
          if (!o.ok) throw new Error(o.body.error);
          const response = await KP.create(o.body);
          const v = await KP.post("/api/auth/passkey/register/verify", { response, label: navigator.platform || "" });
          if (!v.ok) throw new Error(v.body.error);
          toast("Passkey added."); render();
        } catch (e) { toast((e && e.message) || "The passkey wasn't saved."); }
      } }, "Add a passkey on this device"));
  }

  async function renderActivity(view) {
    const body = h("tbody");
    view.append(h("div", { class: "tbar" }, h("span", { class: "note" }, "Every sign-in and action, newest first. Kept for 1 year.")),
      h("div", { class: "tw" }, h("table", { class: "m" }, h("thead", {}, h("tr", {}, ["When", "Who", "What", "Result", "From"].map((t) => h("th", {}, t)))), body)));
    const data = await getJ("/api/admin/audit");
    for (const e of data.events) {
      const good = e.status < 400;
      body.append(h("tr", {}, h("td", { class: "note" }, when(e.ts)), h("td", {}, e.email || "not signed in"),
        h("td", {}, e.action + (e.detail ? " · " + e.detail : "")),
        h("td", {}, h("span", { class: "pill " + (good ? "green" : "red") }, h("i"), String(e.status))), h("td", { class: "note" }, e.ip)));
    }
  }

  function strongPassword() {
    // 20 characters from a 31-letter set without look-alikes, about 99 bits.
    const set = "abcdefghjkmnpqrstuvwxyz23456789";
    const r = crypto.getRandomValues(new Uint32Array(20));
    const s = Array.from(r, (n) => set[n % set.length]).join("");
    return s.match(/.{5}/g).join("-");
  }

  (async function boot() {
    me = await getJ("/api/me");
    if (me.stage !== "full") { location.replace("/login"); return; }
    $("userName").textContent = me.user.name; $("userAv").textContent = initials(me.user.name);
    if (me.user.client !== "riverworks") { $("clientName").textContent = "Kliento"; $("clientAv").textContent = "K"; }
    if (location.pathname === "/app" || location.pathname === "/app/") history.replaceState(null, "", "/app/tasks");
    render();
  })();
})();
