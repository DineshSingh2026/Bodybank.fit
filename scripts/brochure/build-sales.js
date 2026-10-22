#!/usr/bin/env node
/* Tribe Elite sales brochure. 4:5 pages (150 x 187.5 mm) that read on phone and laptop.
 *   node build-sales.js <repoRoot> <out.pdf>
 * Audit: text inside the page, no overlaps, every [data-max] within its line budget. */
const path = require('path'); const fs = require('fs');
const REPO = path.resolve(process.argv[2]); const OUTPDF = path.resolve(process.argv[3]);
const sharp = require(path.join(REPO, 'node_modules', 'sharp'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer'));
let QR = null; try { QR = require('qrcode'); } catch (e) { /* falls back to assets/whatsapp-qr.png */ }
const PIMG = path.join(REPO, 'public', 'img');
const SHOTS = path.join(__dirname, '.work', 'shots'); const IMG = path.join(__dirname, '.work', 'img'); fs.mkdirSync(IMG, { recursive: true });
const fileUrl = (p) => 'file:///' + p.split(path.sep).join('/').split(' ').join('%20');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rich = (s) => esc(s).replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');
const I = (n, ext) => fileUrl(path.join(IMG, n + (ext || '.jpg')));
const WA = 'https://wa.me/919502575669?text=' + encodeURIComponent('Hi BodyBank, I am interested in Tribe Elite.');

// Results as published on bodybank.fit (tribe-stories.html): name, start, end, weeks, photo.
const STORIES = [
  ['Nisheeth', 120, 70, 27, 'tribe-stories/IMG_5961.webp'],
  ['Prem', 107.7, 86, 19, 'tribe-stories/IMG_5956.jpeg'],
  ['Vikas', 102.6, 87, 14, 'tribe-stories/IMG_5954.jpeg', 'centre'],
  ['Kanshika', 58, 51, 16, 'transformations/6095797176152821202.jpg']
];

async function prep() {
  // Cover: the Tribe Elite member card photo, cropped 4:5, darkened toward the bottom (baked, opaque).
  const W = 1179, H = 1474;
  const ov = Buffer.alloc(W * H * 4);
  const stops = [[0, .5], [.1, .1], [.5, .2], [.6, .85], [.68, 1], [1, 1]];
  const alphaAt = (t) => { for (let k = 1; k < stops.length; k++) if (t <= stops[k][0]) { const [t0, a0] = stops[k - 1], [t1, a1] = stops[k]; return a0 + (a1 - a0) * (t - t0) / (t1 - t0); } return 1; };
  for (let y = 0; y < H; y++) { const al = Math.round(255 * alphaAt(y / (H - 1))); for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; ov[o] = 7; ov[o + 1] = 7; ov[o + 2] = 7; ov[o + 3] = al; } }
  const grad = await sharp(ov, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  await sharp(path.join(PIMG, 'Elite new card.jpeg')).extract({ left: 0, top: 600, width: W, height: H })
    .composite([{ input: grad }]).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(IMG, 'cover.jpg'));
  for (const [n, , , , f, pos] of STORIES) await sharp(path.join(PIMG, f)).resize(760, 540, { fit: 'cover', position: pos || 'north' }).jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(IMG, 's-' + n + '.jpg'));
  for (const n of ['care-group', 'blood', 'report']) await sharp(path.join(SHOTS, n + '.png')).resize(620).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(IMG, n + '.jpg'));
  await sharp(path.join(PIMG, 'Bodybank logo.png')).resize(240, 240).png({ palette: true }).toFile(path.join(IMG, 'logo.png'));
  if (!QR) fs.copyFileSync(path.join(__dirname, 'assets', 'whatsapp-qr.png'), path.join(IMG, 'qr.png'));
  else await QR.toFile(path.join(IMG, 'qr.png'), WA, { width: 600, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0a08', light: '#f4ead0' } });
}

const STATUS = `<div class="sb"><span>9:41</span><i></i><span class="ic">●●●</span></div>`;
const phone = (shot) => `<div class="ph"><div class="scr"><div class="sb"><b>9:41</b><i></i></div><img src="${I(shot)}" alt=""></div></div>`;
let N = 0; const TOTAL = 9;
const chrome = (fine) => { N++; return `<div class="top"><img src="${I('logo', '.png')}" alt=""><span class="wm">BODYBANK</span><span class="chip">Tribe Elite</span></div>
  <div class="foot"><span>${fine || 'bodybank.fit'}</span><span>${String(N).padStart(2, '0')} / ${String(TOTAL).padStart(2, '0')}</span></div>`; };
const head = (eb, h) => `<p class="eyebrow">${esc(eb)}</p><h2 data-max="${h.split('\n').length}">${rich(h)}</h2>`;
const kg = (x) => (Math.round(x * 10) / 10).toString();

function html() {
  N = 0; const P = [];
  // 1 ── Cover
  N++;
  P.push(`<section class="page cover"><img class="bg" src="${I('cover')}" alt="">
    <div class="cv"><p class="eyebrow">Tribe Elite · Private membership</p>
      <h1 data-max="2">Your health,<br>run by a <em>team.</em></h1>
      <p class="lead" data-max="2">A doctor, a sports nutritionist and your own Lifestyle Manager,<br>working with you on one plan for four months.</p></div>
    <div class="cv-foot"><span>bodybank.fit</span><span>By application</span></div></section>`);

  // 2 ── The problem
  const PAIN = [['Generic plans', 'Built for everyone, so they ignore your blood work and your week.'],
    ['Nobody checking in', 'One busy week, a few missed days, and the plan quietly stops.'],
    ['Data nobody reads', 'Your watch and apps collect numbers. Nobody acts on them.']];
  P.push(`<section class="page">${chrome()}<div class="body">
    ${head('Why most plans fail', 'You know what to do.\nDoing it *alone* is the hard part.')}
    <div class="pains">${PAIN.map((p, i) => `<div class="pain"><span class="big">0${i + 1}</span><div><b data-max="1">${p[0]}</b><span data-max="2">${p[1]}</span></div></div>`).join('')}</div>
    <div class="answer"><p class="lbl">The Tribe Elite answer</p><p class="ans" data-max="2">A team of experts around you, every day,<br>so you are never doing it alone.</p></div>
  </div></section>`);

  // 3 ── Proof
  P.push(`<section class="page">${chrome('Individual results vary. Stories as featured on bodybank.fit.')}<div class="body">
    ${head('Real members, real results', 'The numbers *speak.*')}
    <div class="stories">${STORIES.map(([n, a, b, w]) => `<div class="story"><img src="${I('s-' + n)}" alt="">
      <div class="cap"><div><b data-max="1">${n}</b><span data-max="1">${kg(a)} → ${kg(b)} kg</span></div><div class="r"><strong data-max="1">−${kg(a - b)} kg</strong><span data-max="1">in ${w} weeks</span></div></div></div>`).join('')}</div>
  </div></section>`);

  // 4 ── The team
  const TEAM = [['LM', 'Lifestyle Manager', 'Owns your plan day to day. Reads your check-ins and adjusts your week.'],
    ['DR', 'Doctor', 'Reads your blood reports with you on a call and flags what needs attention.'],
    ['SN', 'Sports nutritionist', 'Builds your food around your training, your goal and your blood results.'],
    ['CO', 'Coordinator', 'Watches your logs, sends reminders and makes sure nothing is missed.']];
  P.push(`<section class="page">${chrome()}<div class="body">
    ${head('Your care team', 'Four experts. One plan.\nAll *yours.*')}
    <div class="team">${TEAM.map((t) => `<div class="tm"><i>${t[0]}</i><b data-max="1">${t[1]}</b><span data-max="3">${t[2]}</span></div>`).join('')}</div>
    <div class="band"><span class="dot"></span><p data-max="2"><b>One group chat with all four of them,</b> inside the BodyBank app. Ask anything, any day.</p></div>
  </div></section>`);

  // 5 ── The four months
  const STAGES = [['Month 1', 'Assess and build', 'Your doctor reviews your blood report, you complete the nutrition assessment, connect your watch, and your plan is built.'],
    ['Months 2 – 3', 'Work the plan', 'Daily check-ins and meal snaps. Your team monitors, reminds and adjusts the plan every week.'],
    ['Month 4', 'Retest and compare', 'A new blood report and a full progress review show exactly what changed.']];
  const RHY = [['Daily', 'Check-in and meal snaps'], ['Weekly', 'Sunday review'], ['Every 2 weeks', 'Progress report'], ['Anytime', 'Chat with your team']];
  P.push(`<section class="page">${chrome()}<div class="body">
    ${head('Your four months', 'From first test\nto *retest.*')}
    <div class="tl">${STAGES.map((s, i) => `<div class="st"><div class="rail"><span>${i + 1}</span></div><div><p class="when" data-max="1">${s[0]}</p><b data-max="1">${s[1]}</b><span data-max="3">${s[2]}</span></div></div>`).join('')}</div>
    <p class="lbl rh-lbl">The rhythm</p>
    <div class="rhythm">${RHY.map((r) => `<div><b data-max="1">${r[0]}</b><span data-max="2">${r[1]}</span></div>`).join('')}</div>
  </div></section>`);

  // 6 ── The app (the only screenshot page)
  P.push(`<section class="page">${chrome('Screens show sample data for a fictional member.')}<div class="body">
    ${head('All in one app', 'Your team,\nin your *pocket.*')}
    <div class="phones">${[['care-group', 'Your team chat'], ['blood', 'Blood report, graded'], ['report', 'Progress every 2 weeks']].map((s) => `<figure>${phone(s[0])}<figcaption data-max="1">${s[1]}</figcaption></figure>`).join('')}</div>
    <p class="chips">${['AI meal snap', 'AI Trainer', 'Workout programs', 'Wearables', 'Streaks', 'Mind check-in'].map((c) => `<span>${c}</span>`).join('')}</p>
  </div></section>`);

  // 7 ── What's included
  const NUMS = [['4', 'months of coaching'], ['16+', 'Sunday reviews'], ['8', 'progress reports'], ['3', 'blood report analyses']];
  const INC = ['Dedicated care team', 'Doctor consultations', 'Sports nutritionist', 'Complete lifestyle management', 'Wearable insights', 'Two-week progress reports',
    'Blood report analysis', 'Custom workout program', 'In-depth nutrition plan', 'Unlimited AI meal snaps', 'Unlimited AI Trainer', 'Daily check-ins & streaks'];
  P.push(`<section class="page">${chrome()}<div class="body">
    ${head('What you get', 'Everything,\n*included.*')}
    <div class="nums">${NUMS.map((n) => `<div><strong data-max="1">${n[0]}</strong><span data-max="2">${n[1]}</span></div>`).join('')}</div>
    <ul class="inc">${INC.map((x) => `<li data-max="1">${esc(x)}</li>`).join('')}</ul>
  </div></section>`);

  // 8 ── Investment
  P.push(`<section class="page">${chrome()}<div class="body">
    ${head('Your investment', 'Less than ₹600\n*a day.*')}
    <div class="offer"><div class="best"><span class="tag">Best value</span><p class="lbl">4 months</p><strong>₹72,000</strong>
        <p class="per" data-max="1">Under ₹600 a day · save ₹28,000</p></div>
      <div class="mon"><p class="lbl">Monthly</p><strong>₹25,000</strong><p class="per" data-max="1">per month</p></div></div>
    <div class="promise">${[['7-day refund', 'Full refund if you ask within 7 days.'], ['No auto-renewal', 'You are never charged without paying yourself.'], ['Your data stays', 'History and reports stay with you.']].map((g) => `<div><b data-max="1">${g[0]}</b><span data-max="2">${g[1]}</span></div>`).join('')}</div>
    <p class="lbl fit-lbl">Tribe Elite is for you if</p>
    <ul class="fit">${['You want results, not another app to manage alone.', 'You want experts to read your blood work and act on it.', 'You can give your health four focused months.'].map((x) => `<li data-max="1">${x}</li>`).join('')}</ul>
  </div></section>`);

  // 9 ── Apply
  P.push(`<section class="page close">${chrome('Prices in Indian rupees. BodyBank supports your health goals and does not replace medical care.')}<div class="body">
    ${head('Your next step', 'Apply for\nTribe *Elite.*')}
    <ol class="steps">${[['Message us', 'Tell us your goal on WhatsApp.'], ['Talk to your coach', 'We check Tribe Elite is right for you.'], ['Meet your team', 'Your four months begin.']].map((s, i) => `<li><span>${i + 1}</span><div><b data-max="1">${s[0]}</b><em class="d" data-max="1">${s[1]}</em></div></li>`).join('')}</ol>
    <div class="apply"><div class="qr"><img src="${I('qr', '.png')}" alt=""><span data-max="1">Scan to chat</span></div>
      <div class="go"><p class="lbl">Apply on WhatsApp</p><a class="btn" href="${WA}" data-max="1">+91 95025 75669</a><p class="url" data-max="1">or visit bodybank.fit/pricing</p></div></div>
  </div></section>`);

  return `<!doctype html><html><head><meta charset="utf-8"><title>BodyBank Tribe Elite</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Cormorant+Garamond:ital,wght@1,600&display=swap" rel="stylesheet">
<style>
@page{size:150mm 187.5mm;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
:root{--g:#c8a44e;--gl:#e4c97e;--gx:#f0d995;--tx:#f5f0e4;--mu:#c4beb0;--di:#8f897b;--card:#121009;--line:#2b2516}
html,body{background:#070707;color:var(--tx);font-family:'Outfit',Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:150mm;height:187.5mm;position:relative;overflow:hidden;break-after:page;background:radial-gradient(150mm 95mm at 50% 0,#231c10,#070707 75%)}
.page:last-child{break-after:auto}
.top{position:absolute;top:8mm;left:11mm;right:11mm;display:flex;align-items:center;gap:2.2mm}
.top img{width:6.5mm;height:6.5mm}.top .wm{font-size:7.4pt;letter-spacing:.4em;color:#d9bd72;font-weight:500}
.chip{margin-left:auto;font-size:6.8pt;letter-spacing:.18em;text-transform:uppercase;font-weight:600;color:var(--gl);border:.25mm solid #7a6430;background:#1a160d;padding:.8mm 2.6mm;border-radius:10mm}
.foot{position:absolute;bottom:6.5mm;left:11mm;right:11mm;display:flex;justify-content:space-between;gap:6mm;font-size:6.4pt;color:#6f6a5f;letter-spacing:.06em;border-top:.2mm solid var(--line);padding-top:2.2mm}
.body{position:absolute;top:21mm;bottom:15mm;left:11mm;right:11mm;display:flex;flex-direction:column}
.eyebrow{font-size:7.8pt;letter-spacing:.28em;text-transform:uppercase;color:var(--g);font-weight:600;margin-bottom:2.6mm;white-space:nowrap}
h1,h2{font-weight:700;letter-spacing:-.022em;line-height:1.05}
h2{font-size:25pt}
em{font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-weight:600;color:var(--gl);letter-spacing:0;font-size:1.13em;line-height:.9}
.lbl{font-size:7.2pt;letter-spacing:.24em;text-transform:uppercase;color:var(--g);font-weight:600;white-space:nowrap}

/* cover */
.cover{background:#070707}
.cover .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cv{position:absolute;left:11mm;right:11mm;bottom:22mm}
.cv h1{font-size:38pt;margin-top:1mm}
.cv .lead{font-size:10.4pt;line-height:1.5;color:var(--mu);font-weight:300;margin-top:4mm}
.cv-foot{position:absolute;left:11mm;right:11mm;bottom:8mm;display:flex;justify-content:space-between;font-size:7pt;letter-spacing:.26em;text-transform:uppercase;color:#d6cfbf;border-top:.25mm solid #3a311c;padding-top:2.6mm}

/* problem */
.pains{margin-top:7mm;display:flex;flex-direction:column;gap:3.6mm}
.pain{display:flex;gap:5mm;align-items:center;padding:5.6mm 6mm;border-radius:4mm;background:var(--card);border:.25mm solid var(--line)}
.pain .big{flex:none;font-size:26pt;font-weight:800;color:#5b4a22;letter-spacing:-.02em;width:13mm}
.pain b{display:block;font-size:13.4pt;font-weight:600}.pain div span{display:block;font-size:10.2pt;line-height:1.42;color:var(--mu);font-weight:300;margin-top:.8mm}
.answer{margin-top:auto;border-radius:4.5mm;padding:6mm;background:linear-gradient(150deg,#3b311a,#15120c 75%);border:.3mm solid #8a7135}
.ans{font-size:13.5pt;line-height:1.35;font-weight:500;margin-top:2.4mm}

/* proof */
.stories{margin-top:6mm;display:grid;grid-template-columns:1fr 1fr;gap:3.4mm;flex:1;align-content:start}
.story{border-radius:4mm;overflow:hidden;background:var(--card);border:.25mm solid var(--line)}
.story img{display:block;width:100%;aspect-ratio:760/540;object-fit:cover}
.cap{display:flex;justify-content:space-between;align-items:center;padding:2.6mm 3.4mm}
.cap b{display:block;font-size:10.4pt;font-weight:600}.cap span{display:block;font-size:7.6pt;color:var(--di);margin-top:.3mm;white-space:nowrap}
.cap .r{text-align:right}.cap strong{display:block;font-size:14pt;font-weight:700;color:var(--gx);white-space:nowrap;letter-spacing:-.01em}

/* team */
.team{margin-top:7mm;display:grid;grid-template-columns:1fr 1fr;gap:3.4mm}
.tm{border-radius:4mm;padding:5mm;background:var(--card);border:.25mm solid var(--line)}
.tm i{display:flex;align-items:center;justify-content:center;width:10mm;height:10mm;border-radius:50%;font-style:normal;font-size:8.4pt;font-weight:700;color:#14110a;background:linear-gradient(135deg,#f0d995,#b8963f)}
.tm b{display:block;font-size:12pt;font-weight:600;margin-top:3.4mm}.tm span{display:block;font-size:9pt;line-height:1.45;color:var(--mu);font-weight:300;margin-top:1.2mm}
.band{margin-top:auto;display:flex;gap:4mm;align-items:center;border-radius:4.5mm;padding:5.5mm 6mm;background:linear-gradient(150deg,#3b311a,#15120c 75%);border:.3mm solid #8a7135}
.band .dot{flex:none;width:3.2mm;height:3.2mm;border-radius:50%;background:#58c996;box-shadow:0 0 0 1.2mm #163526}
.band p{font-size:10.6pt;line-height:1.45;color:var(--mu)}.band p b{color:var(--tx);font-weight:600}

/* timeline */
.tl{margin-top:6mm}
.st{display:flex;gap:4.5mm}
.st .rail{flex:none;width:9mm;display:flex;flex-direction:column;align-items:center}
.st .rail span{width:9mm;height:9mm;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10pt;font-weight:700;color:#14110a;background:linear-gradient(135deg,#f0d995,#b8963f)}
.st .rail::after{content:'';flex:1;width:.4mm;background:#4a3d1f;margin:1.2mm 0}
.st:last-child .rail::after{display:none}
.st>div:last-child{padding-bottom:7mm}
.when{font-size:7.4pt;letter-spacing:.2em;text-transform:uppercase;color:var(--g);font-weight:600;padding-top:.4mm}
.st b{display:block;font-size:13.2pt;font-weight:600;margin-top:.6mm}.st span{display:block;font-size:9.8pt;line-height:1.45;color:var(--mu);font-weight:300;margin-top:.8mm}
.rh-lbl{margin-top:auto}
.rhythm{display:grid;grid-template-columns:repeat(4,1fr);gap:2.6mm;margin-top:2.8mm}
.rhythm div{border-radius:3.5mm;padding:5.2mm 3.6mm;background:var(--card);border:.25mm solid var(--line)}
.rhythm b{display:block;font-size:10.4pt;font-weight:600;color:var(--gx);white-space:nowrap}.rhythm span{display:block;font-size:8.8pt;line-height:1.35;color:var(--mu);margin-top:1mm;font-weight:300}

/* app */
.phones{flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;align-items:center;margin-top:4mm}
figure{display:flex;flex-direction:column;align-items:center}
.ph{--w:39.5mm;width:var(--w);padding:calc(var(--w)*.03);border-radius:calc(var(--w)*.165);background:linear-gradient(145deg,#e7cf88,#8d7535 34%,#d9bf74 60%,#7a6429)}
.scr{border-radius:calc(var(--w)*.138);overflow:hidden;background:#050505;border:calc(var(--w)*.013) solid #000;font-size:calc(var(--w)*.036)}
.scr img{display:block;width:100%}
.sb{height:2.7em;display:flex;align-items:center;padding:.4em 1.9em 0;position:relative;color:#fff}.sb b{font-size:1.05em;font-weight:600}
.sb i{position:absolute;left:50%;top:.62em;transform:translateX(-50%);width:6.6em;height:1.75em;border-radius:1em;background:#000}
figcaption{margin-top:3.4mm;font-size:9pt;font-weight:600;text-align:center;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:1.8mm;margin-top:4mm}
.chips span{font-size:8pt;padding:1.1mm 3mm;border-radius:10mm;border:.25mm solid #3a3220;color:#ddd6c6;background:#100e0a}

/* included */
.nums{display:grid;grid-template-columns:repeat(4,1fr);gap:2.6mm;margin-top:6mm}
.nums div{border-radius:4mm;padding:7mm 3.4mm;background:linear-gradient(160deg,#2f2715,#12100b 75%);border:.25mm solid #6b5728;text-align:center}
.nums strong{display:block;font-size:27pt;font-weight:700;color:var(--gx);letter-spacing:-.02em;line-height:1}
.nums span{display:block;font-size:8pt;line-height:1.3;color:var(--mu);margin-top:1.6mm}
.inc{list-style:none;display:grid;grid-template-columns:1fr 1fr;column-gap:5mm;margin-top:auto}
.inc li{position:relative;font-size:10.4pt;padding:3.6mm 0 3.6mm 6.4mm;border-bottom:.25mm solid var(--line);white-space:nowrap}
.inc li::before{content:'';position:absolute;left:0;top:4.2mm;width:3.6mm;height:3.6mm;border-radius:50%;background:#2a2312;border:.3mm solid var(--g)}
.inc li::after{content:'';position:absolute;left:1.05mm;top:5.15mm;width:1.5mm;height:.8mm;border-left:.35mm solid var(--gx);border-bottom:.35mm solid var(--gx);transform:rotate(-45deg)}

/* investment */
.offer{display:grid;grid-template-columns:1.35fr 1fr;gap:3.4mm;margin-top:7mm}
.offer>div{position:relative;border-radius:4.5mm;padding:8.5mm 5.5mm 7mm;background:var(--card);border:.25mm solid var(--line)}
.offer .best{background:linear-gradient(150deg,#41361c,#15120c 78%);border:.35mm solid #a88a42}
.offer .tag{position:absolute;top:-2.6mm;left:5mm;font-size:6.6pt;letter-spacing:.16em;text-transform:uppercase;font-weight:700;padding:.9mm 2.6mm;border-radius:10mm;background:var(--g);color:#0b0a08}
.offer strong{display:block;font-size:28pt;font-weight:700;letter-spacing:-.02em;margin-top:2mm;white-space:nowrap}
.offer .per{font-size:8.8pt;color:var(--mu);margin-top:1mm;white-space:nowrap}.offer .best .per{color:#8fe0bd}
.promise{display:grid;grid-template-columns:repeat(3,1fr);gap:2.6mm;margin-top:3.4mm}
.promise div{border-radius:3.5mm;padding:5mm 3.6mm;background:var(--card);border:.25mm solid var(--line)}
.promise b{display:block;font-size:9.4pt;font-weight:600;color:var(--gx)}.promise span{display:block;font-size:8pt;line-height:1.35;color:var(--mu);margin-top:.8mm;font-weight:300}
.fit-lbl{margin-top:auto}
.fit{list-style:none;margin-top:2.4mm}
.fit li{position:relative;font-size:10.2pt;padding:3.4mm 0 3.4mm 6.4mm;border-bottom:.25mm solid var(--line);white-space:nowrap}
.fit li::before{content:'';position:absolute;left:0;top:4mm;width:3.8mm;height:3.8mm;border-radius:50%;background:#0f241b;border:.3mm solid #3fa77a}
.fit li::after{content:'';position:absolute;left:1.1mm;top:5mm;width:1.6mm;height:.85mm;border-left:.35mm solid #6fdcab;border-bottom:.35mm solid #6fdcab;transform:rotate(-45deg)}

/* apply */
.close{background:radial-gradient(150mm 120mm at 50% 100%,#2e2614,#070707 70%)}
.steps{list-style:none;margin-top:7mm}
.steps li{display:flex;gap:4.4mm;align-items:center;padding:3.6mm 0;border-bottom:.25mm solid var(--line)}
.steps li>span{flex:none;width:9mm;height:9mm;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10pt;font-weight:700;color:#14110a;background:linear-gradient(135deg,#f0d995,#b8963f)}
.steps b{display:block;font-size:12pt;font-weight:600}
.steps .d{display:block;font-family:'Outfit',sans-serif;font-style:normal;font-weight:300;font-size:9.4pt;color:var(--mu);line-height:1.4;margin-top:.4mm}
.apply{margin-top:auto;display:flex;gap:6mm;align-items:center;border-radius:5mm;padding:6mm;background:linear-gradient(150deg,#41361c,#15120c 78%);border:.35mm solid #a88a42}
.qr{flex:none;text-align:center}.qr img{display:block;width:34mm;height:34mm;border-radius:2.5mm}
.qr span{display:block;font-size:7.4pt;color:var(--mu);margin-top:1.6mm;letter-spacing:.06em}
.go{min-width:0}
.btn{display:block;margin-top:3mm;text-align:center;text-decoration:none;font-size:14pt;font-weight:700;color:#0b0a08;background:linear-gradient(135deg,#f0d995,#c8a44e);border-radius:3.5mm;padding:3.6mm 3mm;white-space:nowrap}
.url{font-size:8.8pt;color:var(--mu);margin-top:2.6mm;text-align:center}
</style></head><body>${P.join('\n')}</body></html>`;
}

async function audit(page) {
  return page.evaluate(() => {
    const out = []; const R = (e) => e.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5;
    document.querySelectorAll('.page').forEach((pg, i) => {
      const tag = 'p' + (i + 1); const P = R(pg);
      pg.querySelectorAll('[data-max]').forEach((e) => {
        const cs = getComputedStyle(e); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        const n = Math.round((R(e).height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh);
        if (n > +e.dataset.max) out.push(`${tag} ${n} lines (max ${e.dataset.max}): ${e.textContent.slice(0, 40)}`);
        if (e.scrollWidth > e.clientWidth + 1) out.push(`${tag} clipped: ${e.textContent.slice(0, 40)}`);
      });
      const body = pg.querySelector('.body');
      [...pg.querySelectorAll('.body *')].forEach((e) => { const r = R(e), B = R(body); if (r.height && (r.bottom > B.bottom + .5 || r.right > B.right + .5 || r.left < B.left - .5)) out.push(`${tag} outside content area: ${e.className} ${e.textContent.slice(0, 30)}`); });
      const texts = [...pg.querySelectorAll('*')].filter((e) => !e.closest('.ph') && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      texts.forEach((e) => { const r = R(e); if (r.left < P.left || r.right > P.right || r.top < P.top || r.bottom > P.bottom) out.push(`${tag} outside page: ${e.textContent.slice(0, 30)}`); });
      const boxes = texts.map((e) => { const rg = document.createRange(); rg.selectNodeContents(e); return { e, r: rg.getBoundingClientRect() }; });
      const imgs = [...pg.querySelectorAll('.body img, .ph')].map(R);
      for (let a = 0; a < boxes.length; a++) {
        imgs.forEach((m) => { if (hit(boxes[a].r, m)) out.push(`${tag} text over image: ${boxes[a].e.textContent.slice(0, 30)}`); });
        for (let b = a + 1; b < boxes.length; b++) {
          if (boxes[a].e.contains(boxes[b].e) || boxes[b].e.contains(boxes[a].e)) continue;
          if (hit(boxes[a].r, boxes[b].r)) out.push(`${tag} overlap: ${boxes[a].e.textContent.slice(0, 20)} × ${boxes[b].e.textContent.slice(0, 20)}`);
        }
      }
      // pages must not look empty: largest vertical gap between content blocks inside .body
      if (body) { const kids = [...body.children].map(R).sort((x, y) => x.top - y.top); for (let k = 1; k < kids.length; k++) { const gap = kids[k].top - kids[k - 1].bottom; if (gap > 95) out.push(`${tag} large empty gap ${Math.round(gap)}px`); } }
    });
    return out;
  });
}

(async () => {
  await prep();
  const htmlPath = path.join(__dirname, '.work', 'sales.html'); fs.writeFileSync(htmlPath, html());
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 567, height: 709, deviceScaleFactor: 2 });
  await page.emulateMediaType('print');
  await page.goto(fileUrl(htmlPath), { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))]);
  if (!fonts.some((f) => /Outfit/.test(f)) || !fonts.some((f) => /Cormorant/.test(f))) { console.error('web fonts did not load', fonts); process.exit(3); }
  const problems = await audit(page);
  await page.pdf({ path: OUTPDF, width: '150mm', height: '187.5mm', printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log('pdf', (fs.statSync(OUTPDF).size / 1048576).toFixed(2) + ' MB');
  if (problems.length) { console.log('AUDIT FAILED\n' + problems.join('\n')); process.exit(2); }
  console.log('audit: clean');
})().catch((e) => { console.error(e); process.exit(1); });
