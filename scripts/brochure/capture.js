#!/usr/bin/env node
/* Captures member screens from the local app at an iPhone viewport.
 *   node capture.js <repoRoot> [sceneName ...]
 */
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(process.argv[2]);
const only = process.argv.slice(3);
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer'));
const demo = require('./.work/demo.json');
const BASE = 'http://localhost:3088';
const OUT = path.join(__dirname, '.work', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 390, H = 800;

const QUIET = `
  *, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; }
  ::-webkit-scrollbar { display: none !important; }
  #bbnCard, #bbBodyHomePromptCard, #bb-update-modal, .user-top, .user-current-section-wrap, #userHomePwaRow { display: none !important; }
  #userTabContentWrap { padding-top: 10px !important; }
`;

// Each scene: go(page) sets the screen up; into = selector scrolled to the top of the viewport.
const SCENES = [
  { name: 'home', go: async () => {} },
  { name: 'home-goals', into: '#mhGoals', offset: -70 },
  { name: 'home-score', into: '#mhSlotScore', offset: -60 },
  { name: 'home-week', into: '#mhSlotWeek', offset: -60 },
  { name: 'home-readiness', into: '#mhSlotBody', offset: -60 },
  { name: 'home-reports', into: '#mhSlotReports', offset: -60 },
  { name: 'assessment', into: '#mhNaTile', offset: -24 },
  { name: 'home-nav', into: '#mhNav', offset: -70 },
  { name: 'checkin-hub', go: (p) => p.evaluate(() => { switchUserTab('checkin'); }) },
  { name: 'checkin-daily', go: (p) => p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('daily'); }), wait: 2500 },
  { name: 'checkin-insights', go: (p) => p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('daily'); }), wait: 2500, into: '#weeklyInsights', offset: -60 },
  { name: 'checkin-lastweek', go: (p) => p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('daily'); }), wait: 3000, into: '#bbLastWeekReport', offset: -60 },
  { name: 'streak', go: (p) => p.evaluate(() => bbxOpenStreak()), wait: 2500 },
  { name: 'food', go: (p) => p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('nutrition'); }), wait: 3500 },
  { name: 'food-meal', go: async (p) => { await p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('nutrition'); }); await sleep(3000); await p.evaluate(() => { const h = document.querySelector('#mslot-lunch'); if (h) (h.querySelector('[onclick]') || h).click(); }); }, wait: 1200, into: '#mslot-lunch', offset: -70 },
  { name: 'food-totals', go: (p) => p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('nutrition'); }), wait: 3500, into: '#dailyNutritionSummary', offset: -80 },
  { name: 'energy', go: async (p) => { await p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('nutrition'); }); await sleep(3500); await p.evaluate(() => openNutritionShareCard('lunch')); }, wait: 2500 },
  { name: 'sunday', go: async (p) => {
    await p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('sunday'); });
    await sleep(1500);
    await p.evaluate(() => {
      const set = (id, v) => { const e = document.getElementById(id); if (!e) return; if (e.tagName === 'SELECT') { const o = [...e.options].find((x) => x.text.toLowerCase().includes(String(v).toLowerCase())); if (o) e.value = o.value; } else e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
      set('scCurrentWeight', '81.6 kg / 86.5 cm'); set('scTotalLoss', '4.8 kg'); set('scBodyFat', '19.4');
      set('scTraining', '4 of 4 sessions done. Squat went up 2.5 kg.'); set('scNutrition', 'On plan. One meal out on Saturday.');
      set('scSleep', '7.4 h average, in bed by 11.'); set('scOccupationStress', 'Moderate'); set('scOtherStress', 'Low');
      set('scDifferences', 'Clothes fit looser around the waist. Energy is steadier in the afternoon.');
      set('scAchievements', 'Protein target on all seven days.'); set('scImprove', 'Add a second Zone 2 walk.'); set('scQuestions', 'Can we move protein to 150 g?');
    });
  } },
  { name: 'sunday-2', go: async (p) => { await SCENES.find((s) => s.name === 'sunday').go(p); }, into: '#scTraining', offset: -120 },
  { name: 'scorecard', go: (p) => p.evaluate(() => openScorecardBreakdownModal()), wait: 2000 },
  { name: 'muscle', go: (p) => p.evaluate(() => switchUserTab('muscle')), wait: 3500 },
  { name: 'body', go: (p) => p.evaluate(() => switchUserTab('body')), wait: 3000 },
  { name: 'blood', go: async (p) => { const id = await p.evaluate(async () => { const r = await apiCall('GET', '/api/blood/my-reports'); const a = (r && (r.reports || r)) || []; return a[0] && a[0].id; }); await p.evaluate((i) => bbxOpenBlood(i), id); }, wait: 3000 },
  { name: 'blood-areas', go: async (p) => { await SCENES.find((s) => s.name === 'blood').go(p); await sleep(2500); await p.evaluate(() => { const s = document.getElementById('bbxScroll'); if (s) s.scrollTop = 620; }); } },
  { name: 'blood-low', go: async (p) => { await SCENES.find((s) => s.name === 'blood').go(p); await sleep(2500); await p.evaluate(() => { const s = document.getElementById('bbxScroll'); if (s) s.scrollTop = s.scrollHeight; }); } },
  { name: 'programs', go: (p) => p.evaluate(() => switchUserTab('programs')), wait: 2500 },
  { name: 'workout', go: (p) => p.evaluate(() => switchUserTab('workout')), wait: 2500 },
  { name: 'workout-history', go: (p) => p.evaluate(() => switchUserTab('workout')), wait: 2500, into: '#wkHistory', offset: -110 },
  { name: 'coach-list', go: (p) => p.evaluate(() => switchUserTab('messages')), wait: 3000 },
  { name: 'coach-dm', go: async (p) => { await p.evaluate(() => switchUserTab('messages')); await sleep(2500); await p.evaluate(() => BBGroupChat.openConversation(BBGroupChat.state.conversations.find((c) => c.type === 'direct'))); }, wait: 2500 },
  { name: 'care-group', go: async (p) => { await p.evaluate(() => switchUserTab('messages')); await sleep(2500); await p.evaluate((g) => BBGroupChat.openGroup(g), demo.groupId); }, wait: 2500 },
  { name: 'readiness', go: (p) => p.evaluate(() => bbOpenReadiness()), wait: 3500 },
  { name: 'readiness-2', go: async (p) => { await p.evaluate(() => bbOpenReadiness()); await sleep(3500); await p.evaluate(() => { const m = document.getElementById('bbReadinessModal'); const sc = [m, ...m.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (sc) sc.scrollTop = 640; }); } },
  { name: 'wearable-devices', go: (p) => p.evaluate(() => bbOpenWhoop()), wait: 2500 },
  { name: 'report', go: (p) => p.evaluate(() => bbxOpenReport()), wait: 3500 },
  { name: 'report-2', go: async (p) => { await p.evaluate(() => bbxOpenReport()); await sleep(3500); await p.evaluate(() => { document.getElementById('bbxScroll').scrollTop = 700; }); } },
  { name: 'report-3', go: async (p) => { await p.evaluate(() => bbxOpenReport()); await sleep(3500); await p.evaluate(() => { document.getElementById('bbxScroll').scrollTop = 1450; }); } },
  { name: 'report-4', go: async (p) => { await p.evaluate(() => bbxOpenReport()); await sleep(3500); await p.evaluate(() => { const s = document.getElementById('bbxScroll'); s.scrollTop = s.scrollHeight; }); } },
  { name: 'mind', go: (p) => p.evaluate(() => { switchUserTab('checkin'); showCheckinSubView('daily'); switchDailyPane('mind'); if (window.bbxRenderMind) bbxRenderMind(); }), wait: 3000 },
  { name: 'membership', go: (p) => p.evaluate(() => bbxOpenMembership()), wait: 3000 },
  { name: 'membership-2', go: async (p) => { await p.evaluate(() => bbxOpenMembership()); await sleep(3000); await p.evaluate(() => { document.getElementById('bbxScroll').scrollTop = 560; }); } },
  { name: 'membership-3', go: async (p) => { await p.evaluate(() => bbxOpenMembership()); await sleep(3000); await p.evaluate(() => { const s = document.getElementById('bbxScroll'); s.scrollTop = s.scrollHeight; }); } },
  { name: 'consult', go: (p) => p.evaluate(() => switchUserTab('contact')), wait: 3000 },
  { name: 'consult-2', go: async (p) => { await p.evaluate(() => switchUserTab('contact')); await sleep(2500); await p.evaluate(() => { const e = document.getElementById('mtgDate'); const d = new Date(Date.now() + 86400000); e.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); onMeetingDateChange(); }); await sleep(2000); await p.evaluate(() => { const b = [...document.querySelectorAll('button, .time-slot, [onclick]')].find((x) => /11:00s*AM/.test(x.textContent) && x.offsetParent && x.textContent.trim().length < 30); if (b) b.click(); }); }, wait: 1200 },
  { name: 'profile', go: (p) => p.evaluate(() => switchUserTab('profile')), wait: 2500 },
  { name: 'ai-trainer', url: '/ai-trainer.html?v=2', wait: 5000 },
  { name: 'ai-trainer-pose', url: '/ai-trainer.html?v=2', wait: 5000, go: (p) => p.evaluate(() => { const b = document.getElementById('poseBtn'); if (b) b.click(); }) }
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--lang=en-IN']
  });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(BASE, ['notifications']);
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e.message).slice(0, 160)));

  const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: demo.email, password: demo.password }) });
  const session = await res.json();
  if (!session.token) throw new Error('login failed: ' + JSON.stringify(session));

  await page.goto(BASE + '/signin.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate((s) => {
    const ymdUtc = new Date().toISOString().slice(0, 10);
    const d = new Date(); const ymdLocal = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    localStorage.setItem('bodybank_session', JSON.stringify(s));
    localStorage.setItem('bb_profile_photo_prompt_last_ymd', ymdUtc);
    localStorage.setItem('bbBodyOnboardingShownDate', ymdLocal);
    localStorage.setItem('bbBodyPromptDismissedAt', String(Date.now()));
    localStorage.setItem('bb_notify_card_dismissed_at', String(Date.now()));
  }, session);

  const list = only.length ? SCENES.filter((s) => only.includes(s.name)) : SCENES;
  for (const sc of list) {
    try {
      await page.goto(BASE + (sc.url || '/index.html'), { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
      await page.addStyleTag({ content: QUIET });
      await sleep(sc.url ? 1500 : 5200); // mhSequence finishes moving cards at ~4s
      await page.evaluate(() => { document.querySelectorAll('.modal-overlay.open, .popup-overlay.show').forEach((m) => m.classList.remove('open', 'show')); });
      if (sc.go) await sc.go(page);
      await sleep(sc.wait || 1500);
      if (sc.into) {
        const ok = await page.evaluate((sel, off) => {
          const el = document.querySelector(sel); if (!el) return 'missing';
          let n = el.parentElement, sc = null;
          while (n) { const cs = getComputedStyle(n); if (/auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) { sc = n; break; } n = n.parentElement; }
          if (!sc) { el.scrollIntoView({ block: 'start' }); return 'window'; }
          sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top + (off || 0);
          return sc.id || sc.className;
        }, sc.into, sc.offset || 0);
        if (ok === 'missing') console.log('  [missing]', sc.into);
        await sleep(900);
      }
      await page.screenshot({ path: path.join(OUT, sc.name + '.png') });
      console.log('ok', sc.name);
    } catch (e) { console.log('FAIL', sc.name, String(e.message).slice(0, 200)); }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
