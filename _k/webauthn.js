// Tiny WebAuthn JSON helpers (same wire format as @simplewebauthn/browser), plus the shared POST helper.
(function () {
  const b2u = (buf) => {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const u2b = (s) => {
    const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(p); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };

  async function create(opts) {
    const publicKey = {
      ...opts,
      challenge: u2b(opts.challenge),
      user: { ...opts.user, id: u2b(opts.user.id) },
      excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: u2b(c.id) })),
    };
    const cred = await navigator.credentials.create({ publicKey });
    const r = cred.response;
    return {
      id: cred.id, rawId: b2u(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: b2u(r.clientDataJSON),
        attestationObject: b2u(r.attestationObject),
        transports: typeof r.getTransports === "function" ? r.getTransports() : [],
      },
    };
  }

  async function get(opts) {
    const publicKey = {
      ...opts,
      challenge: u2b(opts.challenge),
      allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: u2b(c.id) })),
    };
    const cred = await navigator.credentials.get({ publicKey });
    const r = cred.response;
    return {
      id: cred.id, rawId: b2u(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: b2u(r.clientDataJSON),
        authenticatorData: b2u(r.authenticatorData),
        signature: b2u(r.signature),
        userHandle: r.userHandle ? b2u(r.userHandle) : undefined,
      },
    };
  }

  async function post(path, data) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kliento": "1" },
      body: JSON.stringify(data || {}),
      credentials: "same-origin",
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* empty */ }
    return { ok: res.ok, status: res.status, body };
  }

  window.KP = { create, get, post, supported: !!(window.PublicKeyCredential && navigator.credentials) };
})();
