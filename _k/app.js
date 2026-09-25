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
  const first = (n) => (n || "").trim().split(/\s+/)[0] || "";
  const when = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
  function ago(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return "just now";
    if (s < 3600) { const m = Math.floor(s / 60); return m + (m === 1 ? " minute ago" : " minutes ago"); }
    if (s < 86400) { const hr = Math.floor(s / 3600); return hr + (hr === 1 ? " hour ago" : " hours ago"); }
    return when(ts);
  }
  function toast(msg) { const t = h("div", { class: "toast", role: "status" }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }
  async function getJ(path) {
    const r = await fetch(path, { credentials: "same-origin" });
    if (r.status === 401) { location.replace("/login?next=" + encodeURIComponent(location.pathname)); throw new Error("signed out"); }
    return r.json();
  }

  let me = null;
  let pageTimer = null;
  const PAGES = {
    "/app": { title: "Home", crumb: "Home", render: renderHome },
    "/app/tasks": { title: "Web & IT Tasks", crumb: "Web & IT / Tasks", render: renderTasks },
    "/app/health": { title: "Website health", crumb: "Website / Health", render: renderHealth },
    "/app/people": { title: "People & access", crumb: "Settings / People & access", render: renderPeople, admin: true },
    "/app/activity": { title: "Activity log", crumb: "Settings / Activity log", render: renderActivity, admin: true },
  };
  const curPath = () => location.pathname.replace(/\/+$/, "") || "/app";
  const canTasks = () => (me.user.modules || []).includes("tasks") || me.user.role === "admin";

  function nav() {
    const cur = curPath();
    const link = (href, label) => h("a", { class: "nv" + (cur === href ? " on" : ""), href, "data-link": "", "aria-current": cur === href ? "page" : null }, label);
    $("navMain").replaceChildren(link("/app", "Home"), link("/app/tasks", "Web & IT"), link("/app/health", "Website health"));
    if (me.user.role === "admin") {
      $("navAdmin").hidden = false;
      $("navAdmin").replaceChildren(link("/app/people", "People & access"), link("/app/activity", "Activity log"));
    }
  }

  function render() {
    let path = curPath();
    if (!PAGES[path] || (PAGES[path].admin && me.user.role !== "admin")) { history.replaceState(null, "", "/app"); path = "/app"; }
    const p = PAGES[path];
    document.title = p.title + " · Kliento Portal";
    $("crumb").textContent = p.crumb;
    nav();
    $("openReq").hidden = !canTasks();
    if ($("drawer").classList.contains("on")) closeTask(true);
    clearInterval(pageTimer); pageTimer = null;
    const view = $("view");
    view.replaceChildren(h("div", { class: "ptitle" }, h("h2", {}, p.title)));
    p.render(view);
  }
  // Reloads whatever the current page shows, after a change in the drawer.
  async function afterChange() {
    const p = curPath();
    if (p === "/app/tasks") await loadTasks();
    else if (p === "/app") await loadHome();
  }
  const openFromUrl = () => { const t = Number(new URLSearchParams(location.search).get("t")); if (t) openTask(t); };
  function everyMinute(path, fn) {
    clearInterval(pageTimer);
    pageTimer = setInterval(() => {
      if (curPath() !== path) { clearInterval(pageTimer); return; }
      if (!document.hidden && !$("modal").classList.contains("on")) fn();
    }, 60000);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); history.pushState(null, "", a.getAttribute("href")); render();
  });
  window.addEventListener("popstate", render);
  $("signOut").addEventListener("click", async (e) => { e.preventDefault(); await KP.post("/api/auth/logout"); location.replace("/login"); });

  // ── shared bits ──────────────────────────────────────────────────────────
  const ST = [["new", "New requests", "#3957EA"], ["todo", "To do", "#495057"], ["doing", "In progress", "#E0730B"], ["waiting", "Waiting on RiverWorks", "#7E4FD9"], ["done", "Done", "#2E9E44"]];
  const STL = Object.fromEntries(ST.map((s) => [s[0], s[1]]));
  const STC = Object.fromEntries(ST.map((s) => [s[0], s[2]]));
  STC.doneweek = STC.done;
  const STF = [["all", "All statuses"], ...ST.map((s) => [s[0], s[1]]), ["doneweek", "Done this week"]];
  const PL = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
  const PRANK = { urgent: 0, high: 1, normal: 2, low: 3 };
  const FIELD = { status: "status", priority: "priority", owner_id: "owner", due_date: "due date", title: "name" };
  const TS = { data: null, view: "list", q: "", owner: "all", pri: "all", due: "all", st: "all", sortKey: "due_date", sortDir: 1, openId: null, fresh: null, client: "riverworks", loadedAt: 0 };
  const HS = { data: null };
  const svg = (w, d, extra) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("width", w); s.setAttribute("height", w); s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.7"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("aria-hidden", "true"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); if (extra) extra(s); return s; };
  const CLIPD = "M13 7.5l-5.3 5.3a3.2 3.2 0 01-4.5-4.5L8.9 2.6a2.1 2.1 0 013 3L6.2 11.3a1 1 0 01-1.5-1.5L10 4.6";
  const CHATD = "M2.5 3.5h11v7.5h-6.2L4.5 13.5V11h-2z";
  function lockIcon(label) {
    const s = svg(13, "M5 7.2V5.2a3 3 0 016 0v2", (x) => { const r = document.createElementNS("http://www.w3.org/2000/svg", "rect"); r.setAttribute("x", "3"); r.setAttribute("y", "7.2"); r.setAttribute("width", "10"); r.setAttribute("height", "6.8"); r.setAttribute("rx", "1.4"); x.append(r); });
    s.removeAttribute("aria-hidden"); s.setAttribute("role", "img"); s.setAttribute("aria-label", label || "Locked"); s.setAttribute("class", "lk");
    const t = document.createElementNS("http://www.w3.org/2000/svg", "title"); t.textContent = label || "Locked"; s.prepend(t);
    return s;
  }
  const qs = (extra) => { const p = new URLSearchParams(extra || {}); if (me.user.role === "admin") p.set("client", TS.client); const s = p.toString(); return s ? "?" + s : ""; };
  const kb = (n) => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB";
  const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const dday = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  function dueInfo(t) {
    if (!t.due_date) return ["", "No date"];
    const d = dday(t.due_date), n = Math.round((d - today0()) / 864e5);
    const lab = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    if (t.status === "done") return ["", lab];
    if (n < 0) return ["late", lab + " (late)"];
    if (n <= 2) return ["soon", lab];
    return ["", lab];
  }
  function sq(color, cls) { const e = h("span", { class: cls || "sq" }); e.style.background = color; return e; }
  const pr = (p) => h("span", { class: "pr " + p }, h("i"), PL[p]);
  const own = (name) => name ? h("span", { class: "own" }, h("span", { class: "av" }, initials(name)), name) : h("span", { class: "own none" }, "Nobody yet");
  const count = (n, d, one, many) => n ? h("span", { class: "files" }, svg(13, d), " " + n, h("span", { class: "sr" }, n === 1 ? one : many)) : h("span", { class: "files zero" }, "·");
  const clip = (n) => count(n, CLIPD, " file", " files");
  const chats = (n) => count(n, CHATD, " message", " messages");
  const byl = (name, from) => name ? h("span", { class: "byl", title: "Added by " + name }, from ? "from " : h("span", { class: "fromw" }, "from "), first(name)) : null;
  const clientPicker = (onchange) => h("select", { class: "dd", "aria-label": "Client", onchange: (e) => { TS.client = e.target.value; TS.owner = "all"; TS.data = null; HS.data = null; onchange(); } },
    [["riverworks", "Buffalo RiverWorks"], ["kliento", "Kliento"]].map(([v, l]) => h("option", { value: v, selected: TS.client === v }, l)));

  // ── Home ─────────────────────────────────────────────────────────────────
  const HOME_EMPTY = { new: "No new requests.", waiting: "Nothing is waiting on RiverWorks.", doing: "Nothing in progress.", doneweek: "Nothing done yet this week." };
  async function loadHome() {
    const data = await getJ("/api/home" + qs());
    const box = $("hbody");
    if (data.error) { if (box) box.replaceChildren(h("p", { class: "empty" }, data.error)); return; }
    HS.data = data;
    if (curPath() === "/app") drawHome();
  }
  function renderHome(view) {
    if (me.user.role === "admin") view.querySelector(".ptitle").append(clientPicker(() => loadHome()));
    view.append(h("div", { class: "home", id: "hbody" }, h("p", { class: "empty" }, "Loading")));
    if (!canTasks()) { $("hbody").replaceChildren(h("p", { class: "empty" }, "Nothing to show yet. Website health is in the menu.")); return; }
    if (HS.data) drawHome();
    loadHome().then(openFromUrl);
    everyMinute("/app", loadHome);
  }
  function drawHome() {
    const d = HS.data, box = $("hbody"); if (!box || !d) return;
    const cards = h("div", { class: "hcards" }, d.cards.map((c) => h("a", { class: "hcard", href: "/app/tasks?s=" + c.key, "data-link": "" },
      h("span", { class: "hlab" }, sq(STC[c.key]), c.label),
      h("b", { class: "hnum" }, String(c.count)),
      h("span", { class: "hsee" }, c.count ? "See the list" : "Open the list"))));
    const lists = h("div", { class: "hlists" }, d.cards.map((c) => h("section", { class: "hlist", "aria-label": c.label },
      h("h3", {}, sq(STC[c.key]), c.label),
      c.items.length ? h("ul", {}, c.items.map((t) => {
        const [dc, dl] = dueInfo(t);
        return h("li", {}, h("button", { type: "button", class: "hitem", onclick: () => openTask(t.id) },
          h("span", { class: "tl" }, t.locked ? lockIcon() : null, t.title),
          h("span", { class: "hmeta" }, pr(t.priority), byl(t.by_name, true), h("span", { class: "due " + dc }, dl), t.comments ? chats(t.comments) : null)));
      })) : h("p", { class: "gempty" }, HOME_EMPTY[c.key]),
      c.count > c.items.length ? h("a", { class: "lnk more", href: "/app/tasks?s=" + c.key, "data-link": "" }, "See all " + c.count) : null)));
    const feed = h("section", { class: "feed", "aria-label": "Recent activity" }, h("h3", {}, "Recent activity"),
      d.activity.length ? h("ul", {}, d.activity.map((e) => h("li", {}, h("button", { type: "button", class: "fitem", onclick: () => openTask(e.task_id) },
        h("span", { class: "av sm" }, initials(e.who || "?")),
        h("span", { class: "ftext" },
          h("span", {}, h("b", {}, e.who || "Someone"), e.kind === "comment" ? " commented on " : " moved ", h("span", { class: "tl" }, e.title), e.kind === "status" ? " to " + (STL[e.to_val] || e.to_val) : ""),
          e.kind === "comment" && e.excerpt ? h("span", { class: "fx" }, e.excerpt) : null),
        h("time", { datetime: new Date(e.ts * 1000).toISOString(), title: when(e.ts) }, ago(e.ts))))))
        : h("p", { class: "gempty" }, "Nothing yet. Messages and status changes show up here."));
    box.replaceChildren(cards, lists, feed);
  }

  // ── Web & IT tasks (rw task-6b) ──────────────────────────────────────────
  function stOk(t) {
    if (TS.st === "all") return true;
    if (TS.st === "doneweek") return t.status === "done" && (t.done_at || 0) >= (TS.data.week_start || 0);
    return t.status === TS.st;
  }
  function filtered() {
    const q = TS.q.trim().toLowerCase();
    return TS.data.tasks.filter((t) => stOk(t) && (TS.owner === "all" || (t.owner_id || "") === TS.owner) && (TS.pri === "all" || t.priority === TS.pri)
      && (!q || t.title.toLowerCase().includes(q) || String(t.id) === q.replace("#", ""))
      && (TS.due === "all" || (TS.due === "late" ? dueInfo(t)[0] === "late" : t.due_date && t.status !== "done" && (dday(t.due_date) - today0()) / 864e5 <= 7)));
  }
  function sorted(a) {
    const k = TS.sortKey;
    return a.slice().sort((x, y) => {
      let A = x[k], B = y[k];
      if (k === "priority") { A = PRANK[A]; B = PRANK[B]; }
      if (k === "due_date") { A = A || "9999"; B = B || "9999"; }
      if (k === "title" || k === "owner_name") { A = (A || "").toLowerCase(); B = (B || "").toLowerCase(); }
      return (A > B ? 1 : A < B ? -1 : 0) * TS.sortDir || y.id - x.id;
    });
  }
  function th(k, label) {
    const on = TS.sortKey === k;
    return h("th", { class: on ? "sorted" : "", "aria-sort": on ? (TS.sortDir > 0 ? "ascending" : "descending") : null },
      h("button", { type: "button", onclick: () => { TS.sortDir = TS.sortKey === k ? -TS.sortDir : 1; TS.sortKey = k; drawTasks(); } }, label, h("span", { "aria-hidden": "true" }, on ? (TS.sortDir > 0 ? " ↑" : " ↓") : " ⇅")));
  }

  async function loadTasks() {
    const data = await getJ("/api/tasks" + qs());
    if (data.error) { toast(data.error); return; }
    TS.data = data; TS.loadedAt = Date.now();
    if (curPath() === "/app/tasks") drawTasks();
  }

  function renderTasks(view) {
    const sp = new URLSearchParams(location.search).get("s");
    TS.st = STF.some(([v]) => v === sp) ? sp : "all";
    const title = view.querySelector(".ptitle");
    const search = h("input", { type: "search", placeholder: "Search", "aria-label": "Search tasks", value: TS.q, oninput: (e) => { TS.q = e.target.value; drawTasks(); } });
    title.append(h("label", { class: "search" }, svg(16, "M11 11l4 4", (s) => { const c = document.createElementNS("http://www.w3.org/2000/svg", "circle"); c.setAttribute("cx", "7"); c.setAttribute("cy", "7"); c.setAttribute("r", "4.5"); s.append(c); }), search));
    const sel = (id, label, opts, key, after) => h("select", { class: "dd", id, "aria-label": label, onchange: (e) => { TS[key] = e.target.value; if (after) after(); drawTasks(); } },
      opts.map(([v, l]) => h("option", { value: v, selected: TS[key] === v }, l)));
    const bar = h("div", { class: "tbar" });
    if (me.user.role === "admin") bar.append(clientPicker(() => render()));
    bar.append(sel("fSt", "Status", STF, "st", () => {
      const u = new URL(location.href); if (TS.st === "all") u.searchParams.delete("s"); else u.searchParams.set("s", TS.st);
      history.replaceState(null, "", u.pathname + u.search);
    }), h("span", { id: "ownerSlot" }),
      sel("fPri", "Priority", [["all", "All priorities"], ["urgent", "Urgent"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]], "pri"),
      sel("fDue", "Due", [["all", "Any due date"], ["late", "Late"], ["week", "Due this week"]], "due"),
      h("span", { class: "refresh", id: "fresh" }, "Loading"));
    const tabs = h("div", { class: "tabs", role: "tablist" }, [["list", "List"], ["board", "Board"]].map(([v, l]) =>
      h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(TS.view === v), onclick: () => { TS.view = v; view.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.textContent === l))); drawTasks(); } }, l)));
    const qadd = h("form", { class: "qadd", hidden: true }, h("input", { class: "inp", "aria-label": "New task name", placeholder: "New task name", maxlength: "140" }), h("button", { class: "btn primary", type: "submit" }, "Add"), h("button", { class: "btn plain", type: "button", onclick: () => { qadd.hidden = true; addBtn.hidden = false; } }, "Cancel"));
    const addBtn = h("button", { class: "lnk", type: "button", onclick: () => { addBtn.hidden = true; qadd.hidden = false; qadd.querySelector("input").focus(); } },
      svg(15, "M8 5v6M5 8h6", (s) => { const r = document.createElementNS("http://www.w3.org/2000/svg", "rect"); r.setAttribute("x", "2"); r.setAttribute("y", "2"); r.setAttribute("width", "12"); r.setAttribute("height", "12"); r.setAttribute("rx", "2"); s.append(r); }), "Add a task");
    qadd.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = qadd.querySelector("input").value.trim(); if (!name) return;
      const r = await KP.post("/api/tasks" + qs(), { title: name, status: "todo", priority: "normal", owner_id: me.id || null });
      if (!r.ok) { toast(r.body.error || "That didn't save."); return; }
      qadd.querySelector("input").value = ""; qadd.hidden = true; addBtn.hidden = false;
      TS.fresh = r.body.id; await loadTasks(); openTask(r.body.id);
    });
    view.append(bar, tabs, h("div", { class: "totals" }, addBtn, qadd, h("span", { class: "sum", id: "sum" })), h("div", { class: "tview", id: "tview" }));
    if (TS.data) drawTasks();
    loadTasks().then(openFromUrl);
    everyMinute("/app/tasks", () => { loadTasks(); });
    clearInterval(TS.tick);
    TS.tick = setInterval(() => { const f = $("fresh"); if (f && TS.loadedAt) f.textContent = freshText(); else if (!f) clearInterval(TS.tick); }, 30000);
  }
  function freshText() {
    const m = Math.floor((Date.now() - TS.loadedAt) / 60000);
    return m < 1 ? "Updated less than a minute ago" : "Updated " + m + (m === 1 ? " minute ago" : " minutes ago");
  }

  function drawTasks() {
    const v = $("tview"); if (!v || !TS.data) return;
    const d = TS.data;
    me.id = d.me;
    const slot = $("ownerSlot");
    if (slot) slot.replaceChildren(h("select", { class: "dd", "aria-label": "Owner", onchange: (e) => { TS.owner = e.target.value; drawTasks(); } },
      h("option", { value: "all" }, "All owners"), h("option", { value: "", selected: TS.owner === "" }, "Nobody yet"),
      d.owners.map((o) => h("option", { value: o.id, selected: TS.owner === o.id }, o.name))));
    $("fresh").textContent = freshText();
    const rows = filtered();
    const open = rows.filter((x) => x.status !== "done").length, late = rows.filter((x) => dueInfo(x)[0] === "late").length;
    $("sum").replaceChildren("Open: ", h("b", {}, open + (open === 1 ? " task" : " tasks")), " · Late: ", h("b", { class: late ? "red" : "" }, String(late)));
    const groups = TS.st === "all" ? ST : ST.filter(([k]) => k === (TS.st === "doneweek" ? "done" : TS.st));
    if (TS.view === "list") {
      const out = [];
      for (const [k, label0, color] of groups) {
        const label = TS.st === "doneweek" ? "Done this week" : label0;
        const g = sorted(rows.filter((x) => x.status === k));
        out.push(h("div", { class: "grp" }, sq(color), h("b", {}, label), h("span", { class: "cnt" }, g.length + (g.length === 1 ? " task" : " tasks"))));
        if (!g.length) { out.push(h("div", { class: "gempty" }, "Nothing here.")); continue; }
        out.push(h("table", { class: "m tasks" }, h("colgroup", {}, ["c-st", "c-t", "c-p", "c-o", "c-d", "c-by", "c-f", "c-c"].map((c) => h("col", { class: c }))), h("thead", {}, h("tr", {}, h("th", {}, "Status"), th("title", "Task"), th("priority", "Priority"), th("owner_name", "Owner"), th("due_date", "Due"), h("th", {}, "From"), h("th", {}, "Files"), h("th", {}, "Chat"))),
          h("tbody", {}, g.map((t) => {
            const [dc, dl] = dueInfo(t);
            return h("tr", { class: "r" + (t.id === TS.fresh ? " fresh" : ""), tabindex: "0", "data-id": t.id, onclick: () => openTask(t.id), onkeydown: (e) => { if (e.key === "Enter") openTask(t.id); } },
              h("td", { class: "c1" }, h("div", { class: "st" }, sq(color, "dot"), h("div", {}, label0, h("small", {}, "#" + t.id)))),
              h("td", { class: "c2" }, h("span", { class: "tl" }, t.locked ? lockIcon() : null, t.title), h("small", { class: "pid" }, "#" + t.id), t.mail_status === "failed" ? h("span", { class: "mailbad" }, "Email not sent") : null),
              h("td", { class: "c3" }, pr(t.priority)), h("td", { class: "c4" }, own(t.owner_name)), h("td", { class: "c5" }, h("span", { class: "due " + dc }, dl)),
              h("td", { class: "c6" }, byl(t.by_name)), h("td", { class: "c7" }, clip(t.files)), h("td", { class: "c8" }, chats(t.comments)));
          }))));
      }
      v.replaceChildren(...out);
    } else {
      const cols = groups.map(([k, label, color]) => {
        const g = sorted(rows.filter((x) => x.status === k));
        const col = h("div", { class: "bcol", "data-s": k },
          h("h4", {}, sq(color), label, h("span", { class: "n" }, String(g.length))),
          g.map((t) => {
            const [dc, dl] = dueInfo(t);
            const frozen = !!t.locked && !d.admin;
            const card = h("div", { class: "bcard " + t.priority + (frozen ? " frozen" : ""), draggable: frozen ? "false" : "true", tabindex: "0", role: "button", "aria-label": t.title + ", " + label + (t.locked ? ", locked" : ""), onclick: () => openTask(t.id), onkeydown: (e) => { if (e.key === "Enter") openTask(t.id); } },
              h("div", { class: "bmeta" }, h("span", {}, "#" + t.id), byl(t.by_name, true), t.locked ? lockIcon() : null),
              h("span", { class: "tl" }, t.title),
              h("div", { class: "row2" }, pr(t.priority), h("span", { class: "due " + dc }, dl.replace(/^\w+, /, ""))),
              h("div", { class: "row2" }, own(t.owner_name), h("span", { class: "cnts" }, t.files ? clip(t.files) : null, t.comments ? chats(t.comments) : null)));
            if (!frozen) card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", String(t.id)));
            return card;
          }));
        col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
        col.addEventListener("dragleave", () => col.classList.remove("over"));
        col.addEventListener("drop", async (e) => {
          e.preventDefault(); col.classList.remove("over");
          const id = Number(e.dataTransfer.getData("text/plain")); const t = d.tasks.find((x) => x.id === id);
          if (!t || t.status === k) return;
          if (t.locked && !d.admin) { toast("Camilo locked this task."); return; }
          const before = t.status; t.status = k; drawTasks();
          const r = await KP.post("/api/tasks/" + id + qs(), { status: k });
          if (!r.ok) { t.status = before; drawTasks(); toast(r.body.error || "That didn't save."); }
          else if (TS.openId === id) openTask(id);
        });
        return col;
      });
      v.replaceChildren(h("div", { class: "board" }, cols));
    }
    TS.fresh = null;
  }

  // Rebuilds the message from the allowlist again in the browser, on top of the server clean.
  function safeRich(html) {
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    const OK = new Set(["B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "P", "DIV", "BR", "A"]);
    const walk = (node, into) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { into.append(n.nodeValue); continue; }
        if (n.nodeType !== 1) continue;
        if (!OK.has(n.tagName)) { walk(n, into); continue; }
        let el;
        if (n.tagName === "A") {
          let href = null; try { const u = new URL(n.getAttribute("href") || ""); if (u.protocol === "https:") href = u.href; } catch (_) { /* dropped */ }
          if (!href) { walk(n, into); continue; }
          el = h("a", { href, rel: "noopener noreferrer nofollow", target: "_blank" });
        } else el = document.createElement(n.tagName.toLowerCase());
        walk(n, el); into.append(el);
      }
    };
    const box = h("div", { class: "msg" }); walk(doc.body.firstChild || doc.body, box); return box;
  }

  // Chat text: plain text, line breaks kept by CSS, and only https links become links.
  function linkify(text) {
    const box = h("div", { class: "cmb" });
    const re = /https:\/\/[^\s<>"'`]+/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      let url = m[0];
      const trail = url.match(/[.,;:!?)\]}]+$/);
      if (trail) url = url.slice(0, url.length - trail[0].length);
      box.append(text.slice(last, m.index));
      let href = null; try { const u = new URL(url); if (u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password) href = u.href; } catch (_) { /* stays text */ }
      box.append(href ? h("a", { href, rel: "noopener noreferrer nofollow", target: "_blank" }, url) : url);
      last = m.index + url.length; re.lastIndex = last;
    }
    box.append(text.slice(last));
    return box;
  }

  const EVT = (e, owners) => {
    const who = e.who || "Portal";
    switch (e.kind) {
      case "created": return who + " added this";
      case "requested": return who + " sent this request";
      case "mail_sent": return "Emailed to Camilo";
      case "mail_failed": return "Email to Camilo didn't go";
      case "file_added": return who + " added " + (e.to_val || "a file");
      case "comment": return who + " commented";
      case "locked": return who + " locked it";
      case "unlocked": return who + " unlocked it";
      case "status": return who + " moved it to " + (STL[e.to_val] || e.to_val);
      case "priority": return who + " set priority to " + (PL[e.to_val] || e.to_val);
      case "owner_id": { const o = (owners || []).find((x) => x.id === e.to_val); return who + " set owner to " + (o ? o.name : "nobody"); }
      case "due_date": return who + " set due date to " + (e.to_val || "none");
      case "title": return who + " renamed it";
      default: return who + " changed " + (FIELD[e.kind] || e.kind);
    }
  };

  const DRAFT = {};
  let drawerFrom = null;
  async function openTask(id, opts) {
    const dr = $("drawer");
    const data = await getJ("/api/tasks/" + id + qs());
    if (data.error) { toast(data.error); return; }
    TS.openId = id;
    const t = data.task, admin = !!data.admin, frozen = !!t.locked && !admin;
    const save = async (patch) => {
      const r = await KP.post("/api/tasks/" + id + qs(), patch);
      if (!r.ok) { toast(r.body.error || "That didn't save."); openTask(id); return; }
      await afterChange(); openTask(id);
    };
    const select = (label, opts2, val, field) => [h("label", { for: "d_" + field }, label), h("select", { id: "d_" + field, disabled: frozen, onchange: (e) => save({ [field]: e.target.value }) }, opts2.map(([v, l]) => h("option", { value: v, selected: v === val }, l)))];
    const ttl = h("textarea", { class: "ttl", id: "d_title", rows: "1", maxlength: "140", "aria-label": "Task name", readonly: frozen });
    ttl.value = t.title;
    const fit = () => { ttl.style.height = "auto"; ttl.style.height = ttl.scrollHeight + "px"; };
    ttl.addEventListener("input", fit);
    ttl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ttl.blur(); } });
    ttl.addEventListener("change", () => { if (!frozen && ttl.value.trim() && ttl.value.trim() !== t.title) save({ title: ttl.value }); else ttl.value = t.title; });
    const due = h("input", { type: "date", id: "d_due", value: t.due_date || "", disabled: frozen });
    due.addEventListener("change", () => save({ due_date: due.value || null }));
    const fileIn = h("input", { type: "file", multiple: true, hidden: true, accept: ACCEPT });
    fileIn.addEventListener("change", async () => {
      const ids = []; const bad = [];
      for (const f of fileIn.files) { const pre = fileProblem(f, 0); if (pre) { bad.push(pre); continue; } const r = await uploadOne(f); if (r.ok) ids.push(r.body.id); else bad.push(f.name + ": " + (r.body.error || "didn't upload")); }
      if (bad.length) toast(bad.join(" "));
      if (ids.length) { const r = await KP.post("/api/tasks/" + id + "/files" + qs(), { fileIds: ids }); if (!r.ok) toast(r.body.error || "That didn't save."); await afterChange(); openTask(id); }
    });
    const mail = t.source === "request" ? h("div", { class: "mailrow" },
      t.mail_status === "sent" ? h("span", { class: "pill green" }, h("i"), "Emailed to Camilo")
        : t.mail_status === "failed" ? [h("span", { class: "pill red" }, h("i"), "Email not sent yet"), h("button", { class: "btn plain", type: "button", onclick: async (e) => { e.currentTarget.disabled = true; const r = await KP.post("/api/tasks/" + id + "/resend" + qs()); toast(r.ok ? "Emailed to Camilo." : (r.body.error || "Still didn't go.")); await afterChange(); openTask(id); } }, "Retry email")]
        : h("span", { class: "pill orange" }, h("i"), "Sending email")) : null;
    const lockBy = t.locked_by_name ? first(t.locked_by_name) : "Camilo";
    const lockRow = admin
      ? h("div", { class: "lockrow" + (t.locked ? " on" : "") }, t.locked ? lockIcon() : null,
        h("span", {}, t.locked ? "Locked by " + lockBy + (t.locked_at ? " on " + when(t.locked_at) : "") + ". Staff can still chat and add files." : "Anyone on the team can change this task."),
        h("button", { class: "btn plain", type: "button", onclick: async (e) => {
          e.currentTarget.disabled = true;
          const r = await KP.post("/api/tasks/" + id + "/lock" + qs(), { locked: !t.locked });
          toast(r.ok ? (t.locked ? "Unlocked." : "Locked. Only you can change it now.") : (r.body.error || "That didn't save."));
          await afterChange(); openTask(id);
        } }, t.locked ? "Unlock" : "Lock task"))
      : t.locked ? h("div", { class: "lockrow on" }, lockIcon(), h("span", {}, "Camilo locked this task. You can still chat and add files.")) : null;

    // Chat. A half-written message survives the drawer redrawing after any other change.
    const key = String(id);
    const ta = h("textarea", { class: "inp", id: "d_msg", rows: "3", maxlength: "4000", placeholder: "Write a message", "aria-label": "Write a message" });
    ta.value = DRAFT[key] || "";
    const left = h("span", { class: "cnt", "aria-live": "polite" });
    const sendB = h("button", { class: "btn primary", type: "submit" }, "Send");
    const names = [];
    if (t.requested_by && t.requested_by !== data.me && t.by_name) names.push(first(t.by_name));
    if (!admin && !names.includes("Camilo")) names.push("Camilo");
    const form = h("form", { class: "composer" }, ta, h("div", { class: "crow" }, h("span", { class: "note" }, names.length ? "Emails " + names.join(" and ") : ""), left, sendB));
    const upd = () => { DRAFT[key] = ta.value; const n = ta.value.length; left.textContent = n > 3600 ? (4000 - n) + " characters left" : ""; sendB.disabled = !ta.value.trim(); };
    ta.addEventListener("input", upd);
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!ta.value.trim() || sendB.disabled) return;
      sendB.disabled = true; sendB.textContent = "Sending";
      const r = await KP.post("/api/tasks/" + id + "/comments" + qs(), { body: ta.value });
      if (!r.ok) { toast(r.body.error || "That didn't send. Try again."); sendB.textContent = "Send"; sendB.disabled = false; return; }
      delete DRAFT[key];
      await afterChange(); openTask(id, { chat: true });
    });
    upd();
    const thread = data.comments.length
      ? h("div", { class: "thread", "aria-label": "Messages" }, data.comments.map((m) => h("div", { class: "cm" + (m.user_id === data.me ? " mine" : "") },
        h("div", { class: "cmh" }, h("span", { class: "av sm" }, initials(m.who)), h("b", {}, m.who || "Someone"), h("time", { datetime: new Date(m.created_at * 1000).toISOString() }, when(m.created_at))),
        linkify(m.body))))
      : h("p", { class: "cempty" }, "No messages yet. Ask a question or post an update here.");

    const wasOpen = dr.classList.contains("on"), keep = document.activeElement && dr.contains(document.activeElement) ? document.activeElement.id : "";
    if (!wasOpen) drawerFrom = document.activeElement;
    dr.replaceChildren(
      h("div", { class: "dh" }, h("div", { class: "grow" }, h("span", { class: "id" }, "#" + t.id, t.by_name ? [" · ", byl(t.by_name, true)] : null, t.locked ? lockIcon() : null), ttl),
        h("button", { class: "ib", type: "button", "aria-label": "Close", onclick: () => closeTask() }, svg(14, "M3.5 3.5l9 9M12.5 3.5l-9 9"))),
      h("div", { class: "db" },
        h("div", { class: "kv" },
          select("Status", ST.map((s) => [s[0], s[1]]), t.status, "status"),
          select("Priority", Object.entries(PL), t.priority, "priority"),
          select("Owner", [["", "Nobody yet"]].concat(data.owners.map((o) => [o.id, o.name])), t.owner_id || "", "owner_id"),
          h("label", { for: "d_due" }, "Due"), due,
          t.cc && t.cc.length ? [h("label", {}, "Cc"), h("span", {}, t.cc.join(", "))] : null),
        lockRow,
        mail,
        t.body_html ? safeRich(t.body_html) : null,
        h("div", { class: "dsec" }, h("h4", {}, "Files"),
          h("div", { class: "att" }, data.files.map((f) => h("a", { href: "/api/files/" + f.id + qs(), download: "" }, svg(14, CLIPD), f.name, h("small", {}, kb(f.size))))),
          h("button", { class: "lnk", type: "button", onclick: () => fileIn.click() }, "Add files"), fileIn),
        h("div", { class: "dsec chat", id: "chat" }, h("h4", {}, "Chat", data.comments.length ? h("span", { class: "n" }, " " + data.comments.length) : null), thread, form),
        h("div", { class: "dsec" }, h("h4", {}, "History"),
          h("div", { class: "log" }, data.events.slice().reverse().map((e) => h("div", {}, h("time", {}, when(e.ts)), h("span", {}, EVT(e, data.owners))))))));
    dr.inert = false; dr.classList.add("on"); dr.setAttribute("aria-hidden", "false");
    fit();
    if (opts && opts.chat) {
      const lastMsg = dr.querySelector(".thread .cm:last-child");
      if (lastMsg) { lastMsg.classList.add("fresh"); lastMsg.scrollIntoView({ block: "center" }); }
      ta.focus({ preventScroll: true });
    }
    else { const f = keep && document.getElementById(keep); if (f) f.focus(); else if (!wasOpen) dr.querySelector(".dh .ib").focus(); }
    const u = new URL(location.href); u.searchParams.set("t", id); history.replaceState(null, "", u.pathname + u.search);
  }
  function closeTask(keepUrl) {
    const dr = $("drawer"); if (dr.contains(document.activeElement)) document.activeElement.blur();
    dr.classList.remove("on"); dr.setAttribute("aria-hidden", "true"); dr.inert = true; TS.openId = null;
    if (!keepUrl) {
      const u = new URL(location.href); u.searchParams.delete("t"); history.replaceState(null, "", u.pathname + u.search);
      if (drawerFrom && document.body.contains(drawerFrom)) drawerFrom.focus({ preventScroll: true });
    }
    drawerFrom = null;
  }

  // ── Send a request ────────────────────────────────────────────────────────
  const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv";
  const OKX = /\.(pdf|png|jpe?g|gif|webp|hei[cf]|docx?|xlsx?|pptx?|txt|csv)$/i, MAX = 10 * 1048576, TOTAL = 25 * 1048576;
  function fileProblem(f, used) {
    if (!OKX.test(f.name)) return f.name + " is not an allowed file type.";
    if (f.size > MAX) return f.name + " is over 10 MB.";
    if (used + f.size > TOTAL) return f.name + " would go over 25 MB total.";
    return null;
  }
  async function uploadOne(f) {
    const res = await fetch("/api/files" + qs(), { method: "POST", credentials: "same-origin", body: f,
      headers: { "Content-Type": "application/octet-stream", "X-Kliento": "1", "X-File-Name": encodeURIComponent(f.name) } });
    let body = {}; try { body = await res.json(); } catch (_) { /* empty */ }
    return { ok: res.ok, body };
  }
  const RQ = { files: [], lastFocus: null, range: null };
  function setupRequest() {
    const modal = $("modal"), scrim = $("scrim"), ed = $("ed"), sub = $("rqSub"), csend = $("csend"), ferr = $("ferr"), drop = $("drop"), fileIn = $("fileIn");
    const busy = () => RQ.files.some((x) => x.state === "up");
    const canSend = () => { csend.disabled = !(sub.value.trim() && ed.textContent.trim()) || busy(); };
    const openM = () => { RQ.lastFocus = document.activeElement; modal.inert = false; modal.classList.add("on"); scrim.classList.add("on"); modal.setAttribute("aria-hidden", "false"); setTimeout(() => sub.focus(), 60); };
    const closeM = () => { (RQ.lastFocus && document.body.contains(RQ.lastFocus) ? RQ.lastFocus : $("openReq")).focus(); modal.classList.remove("on"); scrim.classList.remove("on"); modal.setAttribute("aria-hidden", "true"); modal.inert = true; $("linkpop").classList.remove("on"); };
    $("openReq").addEventListener("click", openM);
    $("mX").addEventListener("click", closeM); $("mCancel").addEventListener("click", closeM); scrim.addEventListener("click", closeM);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (modal.classList.contains("on")) closeM(); else if ($("drawer").classList.contains("on")) closeTask();
    });
    modal.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const f = [...modal.querySelectorAll("button:not([disabled]),input:not([type=file]),[contenteditable]")].filter((x) => x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    sub.addEventListener("input", canSend); ed.addEventListener("input", canSend);
    // Pasted content comes in as plain text, so nothing foreign lands in the message.
    ed.addEventListener("paste", (e) => { e.preventDefault(); document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain")); });
    ed.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    modal.querySelectorAll(".tbb[data-cmd]").forEach((b) => b.addEventListener("mousedown", (e) => { e.preventDefault(); document.execCommand(b.dataset.cmd); ed.focus(); canSend(); }));
    $("lnkBtn").addEventListener("mousedown", (e) => {
      e.preventDefault(); const s = getSelection();
      RQ.range = s.rangeCount && ed.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
      $("linkpop").classList.toggle("on"); setTimeout(() => $("lnkUrl").focus(), 30);
    });
    const addLink = () => {
      const u = $("lnkUrl").value.trim();
      let ok = null; try { const x = new URL(u); if (x.protocol === "https:" && x.hostname.includes(".")) ok = x.href; } catch (_) { /* bad */ }
      if (!ok) { toast("Links must start with https://"); $("lnkUrl").focus(); return; }
      ed.focus(); const s = getSelection(); s.removeAllRanges();
      if (RQ.range && !RQ.range.collapsed) { s.addRange(RQ.range); document.execCommand("createLink", false, ok); }
      else {
        if (RQ.range) s.addRange(RQ.range); else { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); s.addRange(r); }
        const r = s.getRangeAt(0); const a = h("a", { href: ok }, ok); r.insertNode(a); r.setStartAfter(a); r.collapse(true); r.insertNode(document.createTextNode(" ")); s.removeAllRanges();
      }
      $("lnkUrl").value = ""; $("linkpop").classList.remove("on"); canSend();
    };
    $("lnkAdd").addEventListener("click", addLink);
    $("lnkUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } });

    const drawFiles = () => {
      $("flist").replaceChildren(...RQ.files.map((x) => h("div", { class: "fi" }, h("span", {}, svg(13, CLIPD), " " + x.file.name),
        h("small", { class: x.state === "bad" ? "bad" : "" }, x.state === "up" ? "Uploading" : x.state === "bad" ? x.err : kb(x.file.size)),
        h("button", { type: "button", "aria-label": "Remove " + x.file.name, onclick: () => { RQ.files = RQ.files.filter((y) => y !== x); drawFiles(); canSend(); } }, "×"))));
    };
    const addFiles = (list) => {
      const bad = [];
      for (const f of list) {
        const used = RQ.files.filter((x) => x.state !== "bad").reduce((a, x) => a + x.file.size, 0);
        const p = fileProblem(f, used); if (p) { bad.push(p); continue; }
        const item = { file: f, state: "up", id: null, err: "" }; RQ.files.push(item);
        uploadOne(f).then((r) => { if (r.ok) { item.state = "ok"; item.id = r.body.id; } else { item.state = "bad"; item.err = r.body.error || "Didn't upload"; } drawFiles(); canSend(); })
          .catch(() => { item.state = "bad"; item.err = "Didn't upload"; drawFiles(); canSend(); });
      }
      ferr.textContent = bad.join(" "); ferr.classList.toggle("on", bad.length > 0); drawFiles(); canSend();
    };
    $("browse").addEventListener("click", (e) => { e.stopPropagation(); fileIn.click(); }); $("clipBtn").addEventListener("click", () => fileIn.click());
    // The whole drop zone opens the file picker, so it is an easy target on a phone.
    drop.addEventListener("click", () => fileIn.click());
    fileIn.addEventListener("change", () => { addFiles(fileIn.files); fileIn.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

    csend.addEventListener("click", async () => {
      if (csend.disabled) return;
      const errBox = $("rqErr"); errBox.hidden = true;
      if (RQ.files.some((x) => x.state === "bad")) { errBox.textContent = "Remove the files that didn't upload first."; errBox.hidden = false; return; }
      csend.disabled = true; const label = csend.textContent; csend.textContent = "Sending";
      const priority = modal.querySelector('input[name="urg"]:checked').value;
      const r = await KP.post("/api/requests" + qs(), { subject: sub.value, html: ed.innerHTML, cc: $("rqCc").value, priority, fileIds: RQ.files.map((x) => x.id) });
      csend.textContent = label;
      if (!r.ok) { errBox.textContent = r.body.error || "That didn't send. Try again."; errBox.hidden = false; canSend(); return; }
      closeM();
      sub.value = ""; ed.replaceChildren(); $("rqCc").value = ""; RQ.files = []; drawFiles(); ferr.classList.remove("on"); canSend();
      modal.querySelector('input[name="urg"][value="normal"]').checked = true;
      TS.q = ""; TS.owner = "all"; TS.pri = "all"; TS.due = "all"; TS.st = "all"; TS.fresh = r.body.id;
      const after = () => {
        if (curPath() !== "/app/tasks" || location.search) { history.pushState(null, "", "/app/tasks"); render(); } else loadTasks();
        if (r.body.mail !== "sent") toast("Saved as #" + r.body.id + ". The email to Camilo didn't go yet; open the task to retry.");
      };
      if (r.body.mail === "sent") playSend(after); else after();
    });
  }

  // The send, same moment as the RiverWorks analytics studio.
  function playSend(done) {
    const fx = $("sendfx"), tt = $("sendtt"), msg = "Sent! Camilo will answer shortly...";
    fx.classList.add("on");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { tt.textContent = msg; setTimeout(() => { fx.classList.remove("on"); done(); }, 1400); return; }
    tt.textContent = ""; let i = 0;
    const tick = () => { tt.textContent = msg.slice(0, ++i); if (i < msg.length) setTimeout(tick, msg[i - 1] === "." ? 110 : 26); else setTimeout(() => { fx.classList.remove("on"); done(); }, 1150); };
    setTimeout(tick, 120);
  }

  // ── Website health: the morning check of buffaloriverworks.com ───────────
  const HEALTH_ROWS = [
    ["site_up", "Website is up"],
    ["click_tracking", "Booking and ticket click tracking works"],
    ["tags_on", "Google Analytics, Clarity and Meta pixel are on the site"],
    ["old_tags_gone", "Old ad and tracking code is gone"],
    ["old_files_hidden", "Old backup files are hidden"],
  ];
  const tone = (ok) => ok === true ? "good" : ok === false ? "bad" : "none";
  const dayLab = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  async function renderHealth(view) {
    const box = h("div", { class: "health" }, h("p", { class: "empty" }, "Loading"));
    view.append(box);
    const d = await getJ("/api/health" + qs());
    if (d.error) { box.replaceChildren(h("p", { class: "empty" }, d.error)); return; }
    const intro = h("p", { class: "note hint2" }, "We check " + d.site + " every morning, the way a visitor sees it.");
    const strip = h("div", { class: "strip" }, h("h3", {}, "Last 14 days"),
      h("ol", { class: "dots" }, d.days.map((x) => {
        const said = dayLab(x.date) + ": " + (x.ok === true ? "passed" : x.ok === false ? "failed" : "no check");
        return h("li", { class: tone(x.ok), title: said }, h("span", { class: "sr" }, said));
      })),
      h("div", { class: "strip-ax", "aria-hidden": "true" }, h("span", {}, dayLab(d.days[0].date)), h("span", {}, "Today")),
      h("div", { class: "legend", "aria-hidden": "true" }, h("span", {}, h("i", { class: "good" }), "Passed"), h("span", {}, h("i", { class: "bad" }), "Failed"), h("span", {}, h("i", { class: "none" }), "No check")));
    const L = d.latest;
    if (!L) { box.replaceChildren(intro, h("p", { class: "empty" }, "No checks yet. The first one shows up after the next morning check."), strip); return; }
    const byKey = Object.fromEntries((L.checks || []).map((c) => [c.key, c]));
    const bad = (L.checks || []).filter((c) => c.ok === false).length;
    const stale = d.now - L.ran_at > 36 * 3600;
    const head = h("div", { class: "hsum " + (L.ok ? "good" : "bad") },
      h("span", { class: "big" }, h("span", { class: "hdot " + (L.ok ? "good" : "bad") }), L.ok ? "Everything is working" : bad === 1 ? "1 thing needs a look" : bad + " things need a look"),
      h("span", { class: "note" }, "Last check " + when(L.ran_at) + " (" + ago(L.ran_at) + ")"));
    const rows = h("ul", { class: "hrows" }, HEALTH_ROWS.map(([k, label]) => {
      const c = byKey[k] || { ok: null, detail: "" };
      return h("li", { class: "hrow " + tone(c.ok) }, h("span", { class: "hdot " + tone(c.ok) }), h("span", { class: "hl" }, label),
        h("span", { class: "hr" }, c.ok === true ? "Working" : c.ok === false ? "Problem" : "Not checked"),
        c.ok === false && c.detail ? h("span", { class: "hd" }, c.detail) : null);
    }));
    const staleNote = stale ? h("p", { class: "stale" }, "No new check since " + when(L.ran_at) + ". If this stays, tell Camilo.") : null;
    box.replaceChildren(...[intro, head, staleNote, rows, strip].filter(Boolean));
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
      h("p", { class: "note" }, "Only the people on the allowed list can get an account. They sign in with this password; the first time, we email them a link to confirm their email."),
      h("button", { class: "btn primary", type: "submit" }, "Add person"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); errBox.hidden = true;
      const r = await KP.post("/api/admin/users", { name: $("nname").value, email: $("nemail").value, client: $("nclient").value, role: $("nrole").value, password: pw.value });
      if (!r.ok) { errBox.textContent = r.body.error || "That didn't work."; errBox.hidden = false; return; }
      toast("Added. Hand them the email and password."); render();
    });

    const table = h("tbody");
    const wrap = h("div", { class: "tw" }, h("table", { class: "m stack" },
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
        h("td", { "data-label": "Client" }, u.client === "riverworks" ? "Buffalo RiverWorks" : "Kliento"),
        h("td", { "data-label": "Access" }, u.role === "admin" ? "Admin" : "Member"),
        h("td", { "data-label": "Status" }, status),
        h("td", { "data-label": "Passkeys" }, String(u.passkeys)),
        h("td", { class: "note", "data-label": "Last active" }, when(u.last_seen)),
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
      h("div", { class: "tw" }, h("table", { class: "m stack" }, h("thead", {}, h("tr", {}, ["When", "Who", "What", "Result", "From"].map((t) => h("th", {}, t)))), body)));
    const data = await getJ("/api/admin/audit");
    for (const e of data.events) {
      const good = e.status < 400;
      body.append(h("tr", {}, h("td", { class: "note" }, when(e.ts)), h("td", { "data-label": "Who" }, e.email || "not signed in"),
        h("td", {}, e.action + (e.detail ? " · " + e.detail : "")),
        h("td", { "data-label": "Result" }, h("span", { class: "pill " + (good ? "green" : "red") }, h("i"), String(e.status))), h("td", { class: "note", "data-label": "From" }, e.ip)));
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
    setupRequest();
    render();
  })();
})();
