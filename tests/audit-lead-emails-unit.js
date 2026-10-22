/**
 * Unit test: audit lead email sequence (services/auditLeadEmails.js).
 * Run: node tests/audit-lead-emails-unit.js
 *
 * NO NETWORK. NO DATABASE.
 *
 * What this guards:
 *  - all three steps render: every placeholder replaced, subjects per step;
 *  - first name: first word, title case, HTML escaped (<script> input), fallback "there";
 *  - goal: lower cased first letter, acronyms kept, cut at 80 on a word, fallback, and
 *    Email 1 never reads "your goal of your fitness goal";
 *  - WhatsApp link: number from env, name URL encoded, same link in the VML and HTML button;
 *  - brand rules: "Founder, BodyBank", the unsubscribe URL, #B8892B, white body;
 *  - copy rules: no dashes as punctuation, no emoji, no price, no "AI", no personal names;
 *  - Email 1 HTML is the founder's file with only the placeholders filled in;
 *  - unsubscribe token round trips; tampered, swapped or foreign tokens fail;
 *  - schedule: +24h, day 3 from Email 1, quiet hours push to 09:00 IST;
 *  - stop rules and their order; throttle respects batch size and daily cap;
 *  - env config defaults and the enabled flag.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('../services/auditLeadEmails');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const UNSUB = 'https://www.bodybank.fit/api/email/unsubscribe?t=abc.def';
const lead = { first_name: '  priya   sharma ', goals: 'Fat loss & toning.' };

// Visible copy only: HTML comments (MSO conditionals) and tags removed, entities decoded.
function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

// ── render: every step ──────────────────────────────────────────────────────
for (const step of [1, 2, 3]) {
  const r = L.render(step, lead, { unsubscribeUrl: UNSUB });
  const all = r.subject + '\n' + r.html + '\n' + r.text;
  assert(!/\{(first_name|goal|unsubscribe_url)\}/.test(all), `step ${step}: a placeholder is left`);
  assert(r.html.includes('Founder, BodyBank'), `step ${step}: html sign off`);
  assert(r.text.includes('Founder, BodyBank'), `step ${step}: text sign off`);
  assert(r.html.includes('www.bodybank.fit'), `step ${step}: site in sign off`);
  assert(r.html.includes(UNSUB.replace(/&/g, '&amp;')), `step ${step}: unsubscribe URL in html`);
  assert(r.text.includes(UNSUB), `step ${step}: unsubscribe URL in text`);
  assert(r.html.includes('#B8892B'), `step ${step}: gold accent`);
  assert(r.html.includes('bgcolor="#FFFFFF"'), `step ${step}: white card`);
  assert(r.html.includes('https://www.bodybank.fit/img/email/logo_light.png'), `step ${step}: logo`);
  assert(r.html.includes('Say hello on WhatsApp'), `step ${step}: WhatsApp button`);
  assert(r.html.includes('v:roundrect'), `step ${step}: Outlook VML button`);
  assert(r.html.includes('Priya'), `step ${step}: name in html`);
  assert(!r.html.includes('Sharma') && !r.text.includes('Sharma'), `step ${step}: only the first name is used`);

  // Copy rules, over subject + visible html + text.
  const copy = r.subject + '\n' + visibleText(r.html) + '\n' + r.text;
  assert(!/ - /.test(copy), `step ${step}: " - " used as punctuation`);
  assert(!/[–—]/.test(copy), `step ${step}: en or em dash`);
  assert(!/\p{Extended_Pictographic}/u.test(copy), `step ${step}: emoji`);
  assert(!/₹|\bRs\.?\s?\d|\bINR\b|\$\s?\d/.test(copy), `step ${step}: a price`);
  assert(!/\bAI\b/.test(copy), `step ${step}: mentions AI`);
  assert(!/\bscore/i.test(copy), `step ${step}: mentions a score (members never see a meal score)`);
  assert(!/\b(cure|cures|diagnos\w*|treat(s|ment)?|disease|prescri\w*|guarantee\w*)\b/i.test(copy), `step ${step}: medical claim wording`);
  // Personal names: the only person named is the lead. Known staff and founder names must never appear.
  assert(!/\b(Dinesh|Singh|Kaushik|Idris)\b/i.test(copy), `step ${step}: a staff or founder name`);
  const his = copy.match(/\bHi ([A-Z][a-z]+)\b/g) || [];
  assert(his.length > 0 && his.every((h) => h === 'Hi Priya' || h === 'Hi BodyBank'), `step ${step}: greeting names someone else: ${his.join(', ')}`);
}

eq(L.render(1, lead, { unsubscribeUrl: UNSUB }).subject, 'Priya, your BodyBank audit is in. Here is what happens next', 'subject 1');
eq(L.render(2, lead, { unsubscribeUrl: UNSUB }).subject, 'Priya, a quick nudge on your audit', 'subject 2');
eq(L.render(3, lead, { unsubscribeUrl: UNSUB }).subject, 'Last note from me, Priya', 'subject 3');

let threw = false;
try { L.render(4, lead, {}); } catch (_) { threw = true; }
assert(threw, 'unknown step throws');

// ── Email 1 is the founder's file, only placeholders and the wa.me links changed ──
{
  const raw = fs.readFileSync(path.join(__dirname, '..', 'templates', 'email', 'audit_lead_email1.html'), 'utf8');
  const r = L.render(1, lead, { unsubscribeUrl: UNSUB });
  const normalise = (s) => s
    .replace(/https:\/\/wa\.me\/[^"]*/g, 'WA')
    .split('{first_name}').join('Priya')
    .split('{goal}').join('fat loss &amp; toning')
    .split('{unsubscribe_url}').join(UNSUB);
  eq(normalise(r.html), normalise(raw), 'Email 1 html equals the template apart from placeholders');
  assert(r.html.includes('your goal of fat loss &amp; toning is absolutely within reach'), 'Email 1 goal sentence');
  for (const href of ['https://www.bodybank.fit/challenge', 'https://www.bodybank.fit/signup', 'https://www.bodybank.fit/login',
    'https://www.bodybank.fit/schedule-call.html', 'https://apps.apple.com/in/app/bodybank/id6808102656',
    'https://play.google.com/store/apps/details?id=com.bodybank.app']) {
    assert(r.html.includes('href="' + href + '"'), 'Email 1 link: ' + href);
    assert(r.text.includes(href), 'Email 1 text link: ' + href);
  }
  for (const img of ['logo_light.png', 'email_banner_light.jpg', 'feature_checkin_light.jpg', 'feature_meal_light.jpg', 'feature_coach_mode_light.jpg', 'feature_coach_support_light.jpg']) {
    assert(r.html.includes('https://www.bodybank.fit/img/email/' + img), 'Email 1 image: ' + img);
  }
}

// Step 2 and 3 copy and links.
{
  const r2 = L.render(2, lead, { unsubscribeUrl: UNSUB });
  assert(r2.html.includes('Just checking in after your BodyBank audit.'), 'Email 2 opening');
  for (const href of ['/challenge', '/signup', '/login']) assert(r2.html.includes('href="https://www.bodybank.fit' + href + '"'), 'Email 2 link ' + href);
  for (const f of ['Daily check in', 'Snap your meal', 'Coach Mode', '7 Day Challenge', 'Blood reports', 'Watch sync', 'Coins', 'Coach support']) {
    assert(r2.html.includes(f) && r2.text.includes(f), 'Email 2 feature ' + f);
  }
  assert(!/score/i.test(visibleText(r2.html)), 'Email 2 never promises a meal score');
  const r3 = L.render(3, lead, { unsubscribeUrl: UNSUB });
  assert(r3.html.includes('If fat loss &amp; toning still matters to you, one message is all it takes.'), 'Email 3 goal sentence');
  assert(r3.text.includes('If fat loss & toning still matters to you'), 'Email 3 text goal unescaped');
  assert(r3.html.includes('Whenever you are ready, I am here.'), 'Email 3 closing');
  assert(r3.html.includes('href="https://www.bodybank.fit/challenge"'), 'Email 3 challenge link');
}

// ── first name ──────────────────────────────────────────────────────────────
eq(L.firstNameOf('  priya   sharma '), 'Priya', 'first word, title case');
eq(L.firstNameOf('RAHUL'), 'Rahul', 'upper case → title case');
eq(L.firstNameOf(''), 'there', 'empty → there');
eq(L.firstNameOf(null), 'there', 'null → there');
eq(L.firstNameOf('   '), 'there', 'blank → there');
{
  const r = L.render(1, { first_name: '<script>alert(1)</script>', goals: '' }, { unsubscribeUrl: UNSUB });
  assert(!r.html.includes('<script>alert'), 'script tag in name is escaped in html');
  assert(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped name present');
  const r2 = L.render(2, { first_name: '"><img src=x onerror=alert(1)>' }, { unsubscribeUrl: UNSUB });
  assert(!/<img src=x/i.test(r2.html), 'attribute break-out in name is escaped');
  const wa = (r.html.match(/https:\/\/wa\.me\/[^"]*/) || [''])[0];
  assert(!/[<>]/.test(wa), 'name inside the WhatsApp href is URL encoded');
}
{
  const r = L.render(3, { first_name: '', goals: '' }, { unsubscribeUrl: UNSUB });
  eq(r.subject, 'Last note from me, there', 'fallback name in subject');
  assert(r.html.includes('Hi there,'), 'fallback name in body');
}

// ── goal ────────────────────────────────────────────────────────────────────
eq(L.goalOf('Fat loss & toning.'), 'fat loss & toning', 'lower first letter, trailing dot dropped');
eq(L.goalOf('  Muscle   gain  '), 'muscle gain', 'whitespace collapsed');
eq(L.goalOf('PCOS friendly fat loss'), 'PCOS friendly fat loss', 'acronym keeps its case');
eq(L.goalOf("I want more energy"), 'I want more energy', '"I" keeps its case');
eq(L.goalOf(''), null, 'empty → null');
eq(L.goalOf('  .  '), null, 'punctuation only → null');
{
  const long = 'Lose twelve kilos before my wedding in March while keeping my strength and my energy at work every single day';
  const g = L.goalOf(long);
  assert(g.length <= 80, 'goal capped at 80: ' + g.length);
  assert(long.toLowerCase().startsWith(g.toLowerCase()) && !/\s$/.test(g), 'goal cut on a word boundary: ' + g);
  assert(/\b(every|my|at|work|and|energy)$/.test(g) || g.split(' ').every((w) => long.includes(w)), 'cut ends on a whole word');
}
{
  const r1 = L.render(1, { first_name: 'Asha', goals: '' }, { unsubscribeUrl: UNSUB });
  assert(!r1.html.includes('your goal of your fitness goal'), 'Email 1 no double "goal" with the fallback');
  assert(r1.html.includes('and your goal is absolutely within reach'), 'Email 1 fallback sentence');
  assert(r1.text.includes('and your goal is absolutely within reach'), 'Email 1 text fallback sentence');
  const r3 = L.render(3, { first_name: 'Asha' }, { unsubscribeUrl: UNSUB });
  assert(r3.html.includes('If your fitness goal still matters to you'), 'Email 3 goal fallback');
  const rx = L.render(3, { first_name: 'Asha', goals: '<b>tone</b>' }, { unsubscribeUrl: UNSUB });
  assert(rx.html.includes('&lt;b&gt;tone&lt;/b&gt;') && !rx.html.includes('<b>tone'), 'goal is escaped');
}

// ── WhatsApp link ───────────────────────────────────────────────────────────
eq(L.whatsappUrl('Priya'), 'https://wa.me/919502575669?text=Hi%20BodyBank%2C%20I%20filled%20the%20audit%2C%20my%20name%20is%20Priya', 'default WhatsApp URL');
eq(L.whatsappUrl('Zoë'), 'https://wa.me/919502575669?text=' + encodeURIComponent('Hi BodyBank, I filled the audit, my name is Zoë'), 'non ascii name encoded');
{
  const r = L.render(1, lead, { unsubscribeUrl: UNSUB, whatsappNumber: '+91 90000 11111' });
  const links = r.html.match(/https:\/\/wa\.me\/[^"]*/g) || [];
  eq(links.length, 2, 'Email 1 has the VML and the HTML WhatsApp link');
  assert(links.every((u) => u === 'https://wa.me/919000011111?text=Hi%20BodyBank%2C%20I%20filled%20the%20audit%2C%20my%20name%20is%20Priya'), 'both links use the env number and the encoded name');
  assert(r.text.includes('https://wa.me/919000011111?text='), 'text version uses the env number');
  for (const s of [2, 3]) {
    const rs = L.render(s, lead, { unsubscribeUrl: UNSUB });
    eq((rs.html.match(/https:\/\/wa\.me\/919502575669\?text=[^"]*Priya"/g) || []).length, 2, `step ${s}: VML + HTML WhatsApp links`);
  }
}

// ── unsubscribe token ───────────────────────────────────────────────────────
{
  const secret = 'unit-test-secret';
  const t = L.unsubToken('  Priya@Example.COM ', secret);
  eq(L.verifyUnsubToken(t, secret), 'priya@example.com', 'token round trips to the normalised email');
  assert(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t), 'token is base64url email.sig');
  eq(L.verifyUnsubToken(t, 'other-secret'), null, 'wrong secret fails');
  const [e, s] = t.split('.');
  eq(L.verifyUnsubToken(e + '.' + s.slice(0, -2) + (s.slice(-2) === 'AA' ? 'AB' : 'AA'), secret), null, 'tampered signature fails');
  const other = L.unsubToken('someone@else.com', secret).split('.')[0];
  eq(L.verifyUnsubToken(other + '.' + s, secret), null, 'swapped email fails');
  for (const bad of ['', 'abc', 'a.b.c', '.', e + '.', '.' + s, null, undefined]) eq(L.verifyUnsubToken(bad, secret), null, 'malformed token fails: ' + JSON.stringify(bad));
  eq(L.verifyUnsubToken(t, ''), null, 'no secret → nothing verifies');
  const cfg = L.configFromEnv({ EMAIL_UNSUB_SECRET: secret });
  assert(L.unsubUrl('priya@example.com', cfg).startsWith('https://www.bodybank.fit/api/email/unsubscribe?t='), 'unsubscribe URL');
  const h = L.listUnsubscribeHeaders('https://x/u?t=1', 'team@gmail.com');
  eq(h['List-Unsubscribe'], '<https://x/u?t=1>, <mailto:team@gmail.com?subject=unsubscribe>', 'List-Unsubscribe header');
  eq(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', 'List-Unsubscribe-Post header');
}

// ── email validity ──────────────────────────────────────────────────────────
for (const ok of ['a@b.co', ' Priya.S@Gmail.com ', 'x+y@sub.domain.in']) assert(L.isValidEmail(ok), 'valid: ' + ok);
for (const bad of ['', 'no-at', 'a@', '@b.com', 'a@b', 'a@@b.com', 'a b@c.com', 'a@-b.com', null]) assert(!L.isValidEmail(bad), 'invalid: ' + bad);

// ── schedule (IST is UTC+05:30) ─────────────────────────────────────────────
const ist = (y, mo, d, h, mi) => L.istDateAt(y, mo - 1, d, h, mi || 0);
const iso = (d) => d.toISOString();
{
  // Email 1 at 10:00 IST Mon → Email 2 at 10:00 IST Tue → Email 3 at 10:00 IST Thu.
  const s1 = ist(2026, 10, 19, 10, 0);
  const n1 = L.nextAfterSend(1, s1, s1);
  eq(n1.nextStep, 2, 'after 1 → 2');
  eq(iso(n1.nextSendAt), iso(ist(2026, 10, 20, 10, 0)), 'Email 2 is 24h after Email 1');
  const n2 = L.nextAfterSend(2, n1.nextSendAt, s1);
  eq(n2.nextStep, 3, 'after 2 → 3');
  eq(iso(n2.nextSendAt), iso(ist(2026, 10, 22, 10, 0)), 'Email 3 is 72h after Email 1');
  const n3 = L.nextAfterSend(3, n2.nextSendAt, s1);
  eq(n3, { nextStep: 4, nextSendAt: null }, 'after 3 → done');
  // Email 2 ran late (day 3 at 09:00): Email 3 keeps a full day after it.
  const late2 = ist(2026, 10, 22, 9, 0);
  eq(iso(L.nextAfterSend(2, late2, s1).nextSendAt), iso(ist(2026, 10, 23, 9, 0)), 'Email 3 never within 24h of Email 2');
  // Email 1 at 20:30 IST → +24h is 20:30 (inside window) → kept.
  const s1b = ist(2026, 10, 19, 20, 30);
  eq(iso(L.nextAfterSend(1, s1b, s1b).nextSendAt), iso(ist(2026, 10, 20, 20, 30)), '20:30 stays 20:30');
}
eq(iso(L.applyQuietHours(ist(2026, 10, 19, 21, 0))), iso(ist(2026, 10, 20, 9, 0)), '21:00 IST → 09:00 next day');
eq(iso(L.applyQuietHours(ist(2026, 10, 19, 23, 59))), iso(ist(2026, 10, 20, 9, 0)), '23:59 IST → 09:00 next day');
eq(iso(L.applyQuietHours(ist(2026, 10, 19, 2, 15))), iso(ist(2026, 10, 19, 9, 0)), '02:15 IST → 09:00 same day');
eq(iso(L.applyQuietHours(ist(2026, 10, 19, 7, 59))), iso(ist(2026, 10, 19, 9, 0)), '07:59 IST → 09:00 same day');
eq(iso(L.applyQuietHours(ist(2026, 10, 19, 8, 0))), iso(ist(2026, 10, 19, 8, 0)), '08:00 IST is inside');
eq(iso(L.applyQuietHours(ist(2026, 10, 19, 20, 59))), iso(ist(2026, 10, 19, 20, 59)), '20:59 IST is inside');
eq(iso(L.applyQuietHours(ist(2026, 12, 31, 22, 0))), iso(ist(2027, 1, 1, 9, 0)), 'year rollover');
assert(L.inSendWindow(ist(2026, 10, 19, 12, 0)) && !L.inSendWindow(ist(2026, 10, 19, 21, 0)) && !L.inSendWindow(ist(2026, 10, 19, 7, 0)), 'send window');
eq(iso(L.startOfIstDay(ist(2026, 10, 19, 3, 10))), '2026-10-18T18:30:00.000Z', 'start of IST day in UTC');
{
  // Email 1 sent at 20:00 IST, Email 2 due at 20:00 next day, Email 3 at 20:00 day 3.
  const s = ist(2026, 10, 19, 20, 0);
  const n1 = L.nextAfterSend(1, s, s);
  eq(L.istParts(n1.nextSendAt).h, 20, 'Email 2 stays at 20:00 IST');
  // Email 1 sent 20:50, retry pushes Email 2 to 21:50 → quiet → 09:00 the day after.
  const s2 = ist(2026, 10, 19, 21, 30);
  eq(iso(L.nextAfterSend(1, s2, s2).nextSendAt), iso(ist(2026, 10, 21, 9, 0)), '+24h landing at 21:30 → 09:00 next morning');
}

// ── stop rules ──────────────────────────────────────────────────────────────
const started = new Date('2026-10-19T05:00:00Z');
const base = { email: 'a@b.com', stages: ['new_audit'], startedAt: started };
eq(L.stopReason(base), null, 'fresh lead → send');
eq(L.stopReason({ ...base, hasUser: true }), 'stopped_signed_up', 'users row → signed up');
eq(L.stopReason({ ...base, linkedUser: true }), 'stopped_signed_up', 'linked_user_id → signed up');
eq(L.stopReason({ ...base, stages: ['new_audit', 'contacted'] }), 'stopped_replied', 'stage contacted → replied');
for (const st of ['part2', 'call', 'converted', 'lost']) eq(L.stopReason({ ...base, stages: [st] }), 'stopped_replied', 'stage ' + st + ' → replied');
eq(L.stopReason({ ...base, stages: ['', null] }), null, 'blank stage counts as new_audit');
eq(L.stopReason({ ...base, lastContactAt: new Date(started.getTime() + 60000) }), 'stopped_replied', 'contact after start → replied');
eq(L.stopReason({ ...base, lastContactAt: new Date(started.getTime() - 60000) }), null, 'contact before start → still send');
eq(L.stopReason({ ...base, unsubscribed: true }), 'stopped_unsubscribed', 'unsubscribed');
eq(L.stopReason({ ...base, unsubscribed: true, hasUser: true, stages: ['contacted'] }), 'stopped_unsubscribed', 'unsubscribe wins');
eq(L.stopReason({ ...base, hasUser: true, stages: ['contacted'] }), 'stopped_signed_up', 'signed up beats replied');
eq(L.stopReason({ ...base, email: 'nope' }), 'failed', 'invalid email → failed');
eq(L.stopReason({ ...base, email: 'x@' }), 'failed', 'missing domain → failed');

// ── throttle ────────────────────────────────────────────────────────────────
eq(L.batchAllowance({ due: 100, sentToday: 0, batchSize: 20, dailyCap: 400 }), 20, 'batch size caps a run');
eq(L.batchAllowance({ due: 5, sentToday: 0, batchSize: 20, dailyCap: 400 }), 5, 'fewer due than batch');
eq(L.batchAllowance({ due: 100, sentToday: 390, batchSize: 20, dailyCap: 400 }), 10, 'daily cap remainder');
eq(L.batchAllowance({ due: 100, sentToday: 400, batchSize: 20, dailyCap: 400 }), 0, 'daily cap reached');
eq(L.batchAllowance({ due: 100, sentToday: 450, batchSize: 20, dailyCap: 400 }), 0, 'over cap never negative');
{
  // 100 leads queued at once, cap 30: 20 + 10 on day one, the rest wait.
  let sent = 0; let runs = 0; let due = 100;
  while (runs < 10) { const n = L.batchAllowance({ due, sentToday: sent, batchSize: 20, dailyCap: 30 }); sent += n; due -= n; runs += 1; }
  eq(sent, 30, 'cap holds across runs in a day');
}

// ── config ──────────────────────────────────────────────────────────────────
{
  const c = L.configFromEnv({ SMTP_USER: 'team@gmail.com', JWT_SECRET: 'j' });
  eq([c.enabled, c.whatsappNumber, c.cc, c.replyTo, c.batchSize, c.gapMs, c.dailyCap, c.unsubSecret, c.publicUrl],
    [true, '919502575669', 'bodybank.fit369@gmail.com', 'team@gmail.com', 20, 4000, 400, 'j', 'https://www.bodybank.fit'], 'defaults');
  const c2 = L.configFromEnv({ AUDIT_LEAD_EMAILS_ENABLED: 'false', LEAD_EMAIL_BATCH_SIZE: '5', LEAD_EMAIL_GAP_MS: '0', LEAD_EMAIL_DAILY_CAP: 'abc', EMAIL_UNSUB_SECRET: 'u', JWT_SECRET: 'j', LEAD_EMAIL_REPLY_TO: 'r@x.com', LEAD_EMAIL_CC: '' });
  eq([c2.enabled, c2.batchSize, c2.gapMs, c2.dailyCap, c2.unsubSecret, c2.replyTo, c2.cc], [false, 5, 0, 400, 'u', 'r@x.com', ''], 'overrides, bad number → default, empty CC disables it');
  for (const off of ['false', 'FALSE', '0', 'off', 'no']) eq(L.configFromEnv({ AUDIT_LEAD_EMAILS_ENABLED: off }).enabled, false, 'disabled by ' + off);
  for (const on of ['true', '1', '', 'yes']) eq(L.configFromEnv({ AUDIT_LEAD_EMAILS_ENABLED: on }).enabled, true, 'enabled by ' + JSON.stringify(on));
}

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`audit-lead-emails-unit: ${failures.length} of ${checks} checks FAILED`);
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log(`audit-lead-emails-unit: all ${checks} checks passed`);
