/**
 * Kliento Portal mailer. Runs as systems@thekliento.com. Deploy as a Web app,
 * Execute as: Me, Who has access: Anyone. It refuses anything not signed by the portal.
 *
 * Setup once: Project Settings > Script properties > add MAILER_SECRET (same value as the
 * Worker secret). Nothing else is configurable on purpose: requests always go to REQUEST_TO.
 */
var REQUEST_TO = 'crivas@thekliento.com';
var FROM_NAME = 'Kliento Portal';
var MAX_AGE_S = 300;
// Portal files arrive as signed 30-minute links on the portal itself; nothing else is fetched.
var FILE_PREFIX = 'https://thekliento.com/api/mailfile/';
// Gmail caps a message near 25 MB after encoding, so attach up to 18 MB; the rest stay in the portal.
var ATTACH_MAX = 18 * 1024 * 1024;

function doPost(e) {
  try {
    var outer = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('MAILER_SECRET');
    if (!secret || !outer.payload || !outer.sig) return out_({ ok: false, error: 'bad request' });
    var expected = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(outer.payload, secret, Utilities.Charset.UTF_8)).replace(/=+$/, '');
    if (!same_(expected, String(outer.sig))) return out_({ ok: false, error: 'bad signature' });

    var m = JSON.parse(outer.payload);
    var now = Math.floor(Date.now() / 1000);
    if (!m.ts || Math.abs(now - m.ts) > MAX_AGE_S) return out_({ ok: false, error: 'expired' });
    var cache = CacheService.getScriptCache();
    if (cache.get('n_' + m.nonce)) return out_({ ok: false, error: 'replay' });
    cache.put('n_' + m.nonce, '1', 600);

    if (m.type === 'code') {
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(m.to) || !/^\d{6}$/.test(m.code)) return out_({ ok: false, error: 'bad code mail' });
      var name = String(m.name || '').slice(0, 80);
      MailApp.sendEmail({
        to: m.to,
        name: FROM_NAME,
        subject: 'Your Kliento sign-in code: ' + m.code,
        body: 'Hi ' + name + ',\n\nYour Kliento Portal sign-in code is ' + m.code + '. It works for 10 minutes.\n\n' +
              'If you did not try to sign in, ignore this email and tell Camilo.\n\nKliento',
        htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#212529">' +
                  '<p>Hi ' + esc_(name) + ',</p><p>Your Kliento Portal sign-in code is</p>' +
                  '<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:8px 0">' + m.code + '</p>' +
                  '<p>It works for 10 minutes. If you did not try to sign in, ignore this email and tell Camilo.</p>' +
                  '<p style="color:#6c757d">Kliento</p></div>'
      });
      return out_({ ok: true });
    }

    if (m.type === 'request' || m.type === 'alert') {
      var opts = { to: REQUEST_TO, name: FROM_NAME, subject: String(m.subject).slice(0, 200), body: String(m.text || '') };
      if (m.type === 'request') {
        opts.htmlBody = String(m.html || '');
        if (m.replyTo) opts.replyTo = String(m.replyTo);
        var cc = (m.cc || []).filter(function (a) { return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(a); }).slice(0, 10);
        if (cc.length) opts.cc = cc.join(',');
        opts.attachments = (m.attachments || []).slice(0, 10).map(function (a) {
          return Utilities.newBlob(Utilities.base64Decode(a.base64), a.mimeType, a.filename);
        }).concat(fetchFiles_(m.files || []));
      }
      MailApp.sendEmail(opts);
      return out_({ ok: true });
    }
    return out_({ ok: false, error: 'unknown type' });
  } catch (err) {
    return out_({ ok: false, error: 'mailer error' });
  }
}

function fetchFiles_(files) {
  var out = [], total = 0;
  files.slice(0, 20).forEach(function (f) {
    var url = String(f.url || '');
    if (url.indexOf(FILE_PREFIX) !== 0 || total + Number(f.size || 0) > ATTACH_MAX) return;
    try {
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: false });
      if (r.getResponseCode() !== 200) return;
      var blob = r.getBlob().setName(String(f.filename || 'file').slice(0, 120));
      if (f.mimeType) blob.setContentType(String(f.mimeType));
      total += blob.getBytes().length;
      if (total <= ATTACH_MAX) out.push(blob);
    } catch (e) { /* the email still goes; the file is in the portal */ }
  });
  return out;
}

function same_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to approve the send-mail and fetch permissions. Sends nothing. */
function authorize() {
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch('https://thekliento.com/robots.txt', { muteHttpExceptions: true });
}
