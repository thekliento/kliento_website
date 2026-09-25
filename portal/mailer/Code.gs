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
// Verify links only ever point at the portal's own /verify page.
var VERIFY_PREFIX = 'https://thekliento.com/verify#t=';
// Task alerts (type notify) only go to one address on these domains, and only link into the portal.
var NOTIFY_DOMAINS = ['buffaloriverworks.com', 'pearlstreetgrill.com', 'thekliento.com'];
var APP_PREFIX = 'https://thekliento.com/app/';

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

    if (m.type === 'verify') {
      var link = String(m.link || '');
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(m.to) || link.indexOf(VERIFY_PREFIX) !== 0 ||
          !/^[A-Za-z0-9_-]{20,80}$/.test(link.slice(VERIFY_PREFIX.length))) return out_({ ok: false, error: 'bad verify mail' });
      var vname = String(m.name || '').slice(0, 80);
      MailApp.sendEmail({
        to: m.to,
        name: FROM_NAME,
        subject: 'Verify your email for the Kliento Portal',
        body: 'Hi ' + vname + ',\n\nClick this link to verify your email and finish your Kliento Portal account:\n' + link +
              '\n\nIt works for 24 hours. If you did not just make an account, ignore this email and tell Camilo.\n\nKliento',
        htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#212529">' +
                  '<p>Hi ' + esc_(vname) + ',</p><p>Click the button to verify your email and finish your Kliento Portal account.</p>' +
                  '<p style="margin:20px 0"><a href="' + esc_(link) + '" style="background:#3957EA;color:#ffffff;text-decoration:none;' +
                  'padding:12px 22px;border-radius:6px;font-weight:700;display:inline-block">Verify my email</a></p>' +
                  '<p>It works for 24 hours. If you did not just make an account, ignore this email and tell Camilo.</p>' +
                  '<p style="color:#6c757d">Kliento</p></div>'
      });
      return out_({ ok: true });
    }

    if (m.type === 'notify') {
      var to = String(m.to || '').trim().toLowerCase();
      var nlink = String(m.link || '');
      // One plain address (no commas, spaces or brackets), on a client domain, and a portal link.
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(to) || NOTIFY_DOMAINS.indexOf(to.slice(to.lastIndexOf('@') + 1)) < 0 ||
          nlink.indexOf(APP_PREFIX) !== 0 || !/^[A-Za-z0-9\/?=&._-]{0,200}$/.test(nlink.slice(APP_PREFIX.length))) return out_({ ok: false, error: 'bad notify mail' });
      var nname = String(m.name || '').slice(0, 80);
      var what = String(m.text || '').slice(0, 500);
      var said = String(m.comment || '').slice(0, 4000);
      var nopts = {
        to: to,
        name: FROM_NAME,
        subject: String(m.subject || 'Kliento Portal update').replace(/[\r\n]+/g, ' ').slice(0, 200),
        body: 'Hi ' + (nname || 'there') + ',\n\n' + what + (said ? '\n\n' + said : '') +
              '\n\nOpen the task: ' + nlink + '\n\nAnswer in the portal so everyone sees it.\n\nKliento',
        htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#212529;line-height:1.5">' +
                  '<p>Hi ' + esc_(nname || 'there') + ',</p><p>' + esc_(what) + '</p>' +
                  (said ? '<div style="border-left:3px solid #3957EA;padding:2px 0 2px 12px;margin:0 0 14px">' +
                          esc_(said).replace(/\n/g, '<br>') + '</div>' : '') +
                  '<p style="margin:20px 0"><a href="' + esc_(nlink) + '" style="background:#3957EA;color:#ffffff;text-decoration:none;' +
                  'padding:12px 22px;border-radius:6px;font-weight:700;display:inline-block">Open the task</a></p>' +
                  '<p style="color:#6c757d">Answer in the portal so everyone sees it.<br>Kliento</p></div>'
      };
      // A reply by email reaches Camilo instead of this mailer's inbox.
      if (to !== REQUEST_TO) nopts.replyTo = REQUEST_TO;
      MailApp.sendEmail(nopts);
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
