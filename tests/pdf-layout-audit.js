'use strict';

/**
 * BodyBank — PDF LAYOUT AUDIT.  Run: node tests/pdf-layout-audit.js
 *
 * The rule under test, for every PDF BodyBank produces:
 *
 *   (a) not one glyph may sit outside the page's safe area,
 *   (b) not one line of text may cross the border of the card it sits in,
 *   (c) no two runs of text may be printed on top of each other,
 *   (d) not one page may be blank (a page carrying only header/footer counts),
 *   (e) branding must appear on every page.
 *
 * This does not read the renderers' intentions — it opens the finished PDF with
 * pdfjs, walks every text item on every page, and converts each item's text
 * matrix into page coordinates. What it asserts is what a client actually sees.
 *
 * Each report is rendered three times, because overflow is a function of the
 * DATA, not the template:
 *
 *   EMPTY    every optional field missing      -> catches blank pages
 *   NORMAL   a realistic client                -> catches everyday drift
 *   EXTREME  pathological values: 400-character marker names, 60-character
 *            unbroken tokens, 8,000-character narratives, 40 panels
 *                                              -> catches the real overflows
 *
 * NO NETWORK. NO DATABASE. Everything below is synthetic.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = path.join(os.tmpdir(), 'bodybank-pdf-audit');
fs.mkdirSync(OUT_DIR, { recursive: true });

const failures = [];
const notes = [];
let checks = 0;

function fail(msg) { failures.push(msg); }
function section(name) { console.log('\n=== ' + name + ' ==='); }

// ---------------------------------------------------------------------------
// pdfjs loader (the dist ships both ESM and legacy CJS builds)
// ---------------------------------------------------------------------------

async function loadPdfjs() {
  const candidates = [
    'pdfjs-dist/legacy/build/pdf.js',
    'pdfjs-dist/legacy/build/pdf.mjs',
    'pdfjs-dist/build/pdf.js',
    'pdfjs-dist/build/pdf.mjs',
    'pdfjs-dist'
  ];
  for (const c of candidates) {
    try {
      let m = require(c);
      if (m && m.getDocument) return m;
      if (m && m.default && m.default.getDocument) return m.default;
    } catch (_) { /* try the next build */ }
    try {
      const url = require.resolve(c);
      const m = await import('file://' + url.replace(/\\/g, '/'));
      if (m && m.getDocument) return m;
      if (m && m.default && m.default.getDocument) return m.default;
    } catch (_) { /* try the next build */ }
  }
  throw new Error('pdfjs-dist could not be loaded');
}

// ---------------------------------------------------------------------------
// Geometry extraction
// ---------------------------------------------------------------------------

/**
 * Every text item AND every drawn box on a page, in PDF user space with y
 * measured DOWN from the page top (which is how all our renderers think).
 *
 * The boxes matter as much as the text: "a field overflowing" is text that
 * crosses the border of the card it was drawn into, and that is invisible to a
 * page-level check because the text is still on the page.
 */
async function readPages(pdfjs, file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data: data, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = [];
    content.items.forEach(function (it) {
      const s = String(it.str == null ? '' : it.str);
      if (!s.trim()) return;
      const t = it.transform;                  // [a, b, c, d, e, f]
      const x = t[4];
      const yUp = t[5];                        // baseline origin, y measured UP
      const h = Math.abs(it.height || Math.hypot(t[2], t[3])) || 8;
      const w = it.width || 0;
      // A rotated run is decoration (the diagonal CONFIDENTIAL ghosting), not a
      // field, so it is marked and skipped by the box-crossing test. Its real
      // bounds still have to be computed from the transform, though: taking
      // `x + width` for a rotated run reports a box that does not exist.
      const rotated = Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01;
      const bl = Math.hypot(t[0], t[1]) || 1;  // baseline direction
      const ux = t[0] / bl;
      const uy = t[1] / bl;
      const asc = Math.hypot(t[2], t[3]) || 1; // ascender direction
      const vx = t[2] / asc;
      const vy = t[3] / asc;
      const desc = h * 0.25;
      const corners = [];
      [[0, -desc], [w, -desc], [0, h], [w, h]].forEach(function (c) {
        const px = x + ux * c[0] + vx * c[1];
        const py = yUp + uy * c[0] + vy * c[1];
        corners.push([px, vp.height - py]);    // convert to y measured DOWN
      });
      const xsAll = corners.map(function (c) { return c[0]; });
      const ysAll = corners.map(function (c) { return c[1]; });
      items.push({
        str: s,
        rotated: rotated,
        x: Math.min.apply(null, xsAll),
        right: Math.max.apply(null, xsAll),
        baseline: vp.height - yUp,
        top: Math.min.apply(null, ysAll),
        bottom: Math.max.apply(null, ysAll)
      });
    });

    // Path bounding boxes. PDFKit emits `1 0 0 -1 0 H cm`, so the coordinates
    // pdfjs reports for a path are already top-down — the same space the text
    // items were converted into above.
    const boxes = [];
    try {
      const ol = await page.getOperatorList();
      for (let i = 0; i < ol.fnArray.length; i += 1) {
        if (ol.fnArray[i] !== pdfjs.OPS.constructPath) continue;
        const mm = ol.argsArray[i] && ol.argsArray[i][2];
        if (!mm) continue;
        const x0 = mm[0]; const y0 = mm[1]; const x1 = mm[2]; const y1 = mm[3];
        if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
        boxes.push({ left: Math.min(x0, x1), right: Math.max(x0, x1), top: Math.min(y0, y1), bottom: Math.max(y0, y1) });
      }
    } catch (_) { /* a page we cannot read paths on simply skips the box check */ }

    pages.push({ index: p, width: vp.width, height: vp.height, items: items, boxes: boxes });
  }
  await doc.destroy();
  return pages;
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

/**
 * @param {object} safe {left, right, top, bottom} — the rectangle inside which
 *   every glyph of every page must live. Chrome (the brand lockup and the
 *   footer band) is drawn deliberately outside the content box, so the audit
 *   is given the full printable area plus the exemptions it needs.
 */
function auditPages(label, pages, safe, opts) {
  const o = opts || {};
  const tol = o.tolerance == null ? 1.0 : o.tolerance;
  // Chrome (running header, footer band) is text, but a page carrying only
  // chrome is a blank page to the reader. `content` marks the band in which
  // real content must appear for the page to count as used.
  const cTop = o.contentTop == null ? safe.top + 24 : o.contentTop;
  const cBottom = o.contentBottom == null ? safe.bottom - 40 : o.contentBottom;
  let violations = 0;
  const blanks = [];

  pages.forEach(function (page) {
    const content = page.items.filter(function (i) {
      return i.baseline > cTop && i.baseline < cBottom;
    });
    if (!content.length) { blanks.push(page.index); }

    page.items.forEach(function (it) {
      // Content must stay inside the safe area. A rotated run is a watermark:
      // it is MEANT to sweep the page, so the requirement for it is only that
      // it stays on the paper — none of it may be cut off at the edge.
      const bound = it.rotated
        ? { left: 0, right: page.width, top: 0, bottom: page.height }
        : safe;
      const problems = [];
      if (it.x < bound.left - tol) problems.push('left edge ' + it.x.toFixed(1) + ' < ' + bound.left);
      if (it.right > bound.right + tol) problems.push('right edge ' + it.right.toFixed(1) + ' > ' + bound.right);
      if (it.top < bound.top - tol) problems.push('top ' + it.top.toFixed(1) + ' < ' + bound.top);
      if (it.bottom > bound.bottom + tol) problems.push('bottom ' + it.bottom.toFixed(1) + ' > ' + bound.bottom);
      if (problems.length) {
        violations += 1;
        if (violations <= 8) {
          fail('[' + label + '] p' + page.index + ' OVERFLOW ' + problems.join('; ')
            + '  text="' + it.str.slice(0, 58).replace(/\s+/g, ' ') + '"');
        }
      }
    });
  });

  checks += 1;
  if (violations > 8) fail('[' + label + '] ... and ' + (violations - 8) + ' more overflowing text runs');
  checks += 1;
  if (blanks.length) {
    fail('[' + label + '] BLANK PAGE(S) (nothing but chrome): '
      + blanks.slice(0, 20).join(', ') + (blanks.length > 20 ? ', …' : '') + ' of ' + pages.length);
  }

  const escapes = auditBoxes(label, pages, o);
  const collisions = auditCollisions(label, pages, o);
  const status = (violations || blanks.length || escapes || collisions) ? 'FAIL' : 'ok  ';
  console.log('  ' + status + '  ' + label
    + '  (' + pages.length + ' pages, ' + violations + ' off-page, ' + escapes + ' out-of-box, '
    + collisions + ' collisions, ' + blanks.length + ' blank)');
  return { violations: violations, blanks: blanks, escapes: escapes, collisions: collisions };
}

/**
 * Two runs of text printed on top of each other — what "misalignment" looks
 * like when a value grows past the slot a fixed layout reserved for it and
 * lands on the label beneath.
 *
 * Only a substantial overlap counts. pdfjs splits a single visual line into
 * several runs whose boxes abut and sometimes graze each other by a fraction of
 * a point, and glyph boxes are generous at the top, so a strict test would be
 * all noise. Runs sharing a baseline are the same line of text and are skipped.
 */
function auditCollisions(label, pages, opts) {
  const o = opts || {};
  const share = o.overlapShare == null ? 0.45 : o.overlapShare;
  let hits = 0;
  const seen = [];

  pages.forEach(function (page) {
    const runs = page.items.filter(function (i) { return !i.rotated; });
    for (let a = 0; a < runs.length; a += 1) {
      for (let b = a + 1; b < runs.length; b += 1) {
        const A = runs[a];
        const B = runs[b];
        const ox = Math.min(A.right, B.right) - Math.max(A.x, B.x);
        const oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
        if (ox <= 0.5 || oy <= 0.5) continue;
        if (Math.abs(A.baseline - B.baseline) < 0.5) {
          // Same line. pdfjs splits one drawn string into several runs wherever
          // the PDF applies a kerning adjustment, and it reports each run's
          // width without that adjustment — so "7.2 h" in 17pt bold comes back
          // as "7" and ".2 h" overlapping by the size of the 7-period kern.
          // A kern is never more than about a quarter of an em; two strings
          // genuinely printed over each other on one line (a left label and a
          // right-aligned value meeting in the middle) overlap by more.
          const em = Math.max(A.bottom - A.top, B.bottom - B.top) / 1.25;
          if (ox <= Math.max(2, em * 0.3)) continue;
        } else {
          const areaA = Math.max(1, (A.right - A.x) * (A.bottom - A.top));
          const areaB = Math.max(1, (B.right - B.x) * (B.bottom - B.top));
          if ((ox * oy) / Math.min(areaA, areaB) < share) continue;
        }
        hits += 1;
        if (seen.length < 6) {
          seen.push('[' + label + '] p' + page.index + ' COLLISION "'
            + A.str.slice(0, 26).replace(/\s+/g, ' ') + '" over "'
            + B.str.slice(0, 26).replace(/\s+/g, ' ') + '"');
        }
      }
    }
  });

  checks += 1;
  seen.forEach(fail);
  if (hits > seen.length) fail('[' + label + '] ... and ' + (hits - seen.length) + ' more overlapping runs');
  return hits;
}

/**
 * Text that crosses the border of the card it belongs to — the actual
 * complaint: "data overspreading from the field".
 *
 * A run is a violation when it sits inside a card horizontally and vertically
 * enough to belong to it, yet extends past one of that card's edges. Text that
 * lies entirely outside a card is not its business, and text entirely within is
 * correct — only a crossing counts.
 */
function auditBoxes(label, pages, opts) {
  const o = opts || {};
  const tol = o.boxTolerance == null ? 1.5 : o.boxTolerance;
  let escapes = 0;
  const seen = [];

  pages.forEach(function (page) {
    // Only real containers: wide and tall enough to be a card or a table row,
    // and not the full-page background. Accent bars (3pt wide) and hairline
    // rules (under 6pt tall) are decoration, not containers.
    const pageArea = page.width * page.height;
    const cards = page.boxes.filter(function (b) {
      const w = b.right - b.left;
      const h = b.bottom - b.top;
      if (w < 70 || h < 14) return false;
      if (w * h > pageArea * 0.75) return false;
      return true;
    });
    if (!cards.length) return;

    page.items.forEach(function (it) {
      if (it.rotated) return;             // decoration, deliberately across the page
      const mid = (it.top + it.bottom) / 2;
      for (let i = 0; i < cards.length; i += 1) {
        const c = cards[i];
        // Does this run belong to this card? Its vertical centre must be inside
        // and it must start inside the card horizontally.
        if (mid <= c.top + tol || mid >= c.bottom - tol) continue;
        if (it.x < c.left - tol || it.x > c.right - tol) continue;
        const over = [];
        if (it.right > c.right + tol) over.push('right by ' + (it.right - c.right).toFixed(1) + 'pt');
        if (it.bottom > c.bottom + tol) over.push('below by ' + (it.bottom - c.bottom).toFixed(1) + 'pt');
        if (over.length) {
          escapes += 1;
          if (seen.length < 6) {
            seen.push('[' + label + '] p' + page.index + ' OUT-OF-BOX ' + over.join(', ')
              + '  (card ' + (c.right - c.left).toFixed(0) + 'x' + (c.bottom - c.top).toFixed(0) + ')'
              + '  text="' + it.str.slice(0, 48).replace(/\s+/g, ' ') + '"');
          }
          return;                // one report per run is enough
        }
      }
    });
  });

  checks += 1;
  seen.forEach(fail);
  if (escapes > seen.length) fail('[' + label + '] ... and ' + (escapes - seen.length) + ' more out-of-box runs');
  return escapes;
}

/** Branding: the wordmark must be present on every page of a client-facing report. */
function auditBranding(label, pages, needle) {
  const missing = [];
  pages.forEach(function (page) {
    const joined = page.items.map(function (i) { return i.str; }).join(' ').toLowerCase();
    if (joined.indexOf(needle.toLowerCase()) === -1) missing.push(page.index);
  });
  checks += 1;
  if (missing.length) {
    fail('[' + label + '] BRANDING missing "' + needle + '" on page(s): ' + missing.join(', '));
    console.log('  FAIL  ' + label + ' branding — missing on ' + missing.length + ' page(s)');
  } else {
    console.log('  ok    ' + label + ' branding on all ' + pages.length + ' pages');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Payload generators — EMPTY / NORMAL / EXTREME
// ---------------------------------------------------------------------------

const LOREM = ('Sustained elevation across the inflammatory markers is consistent with the training load '
  + 'reported this cycle and does not by itself indicate pathology. ');
function longText(n) {
  let s = '';
  while (s.length < n) s += LOREM;
  return s.slice(0, n);
}
/** A token no wrapping algorithm can break on whitespace. */
const UNBREAKABLE = 'Hydroxycholecalciferol25OHVitaminDTotalImmunoassayLCMSMSConfirmatoryPanel';
const LONG_NAME = 'Thiruvananthapuram Venkataraghavan Chandrasekharan Subramanian Balasubramaniam';
const LONG_MARKER = 'Anti-Mullerian Hormone with Reflex to Free Androgen Index and SHBG-adjusted '
  + 'Bioavailable Testosterone Calculation (LC-MS/MS, fasting, serum) ' + UNBREAKABLE;

module.exports = {
  OUT_DIR: OUT_DIR,
  loadPdfjs: loadPdfjs,
  readPages: readPages,
  auditPages: auditPages,
  auditBranding: auditBranding,
  longText: longText,
  UNBREAKABLE: UNBREAKABLE,
  LONG_NAME: LONG_NAME,
  LONG_MARKER: LONG_MARKER,
  failures: failures,
  notes: notes,
  fail: fail,
  section: section,
  getChecks: function () { return checks; }
};

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

function bloodPayload(profile) {
  if (profile === 'empty') {
    return { reportId: 1, user: { name: '' }, blood_analysis: {}, nutrition_analysis: {}, ai_report: {} };
  }
  const extreme = profile === 'extreme';
  const n = extreme ? 26 : 6;
  const markers = [];
  for (let i = 0; i < n; i += 1) {
    markers.push({
      name: extreme ? LONG_MARKER + ' #' + i : 'Haemoglobin ' + i,
      value: extreme ? '123456789.0123456789' : 13.4 + i,
      unit: extreme ? 'x10^9/L per 1.73m2 body surface area' : 'g/dL',
      reference: extreme ? longText(90) : '13.0 - 17.0',
      status: ['Normal', 'Low', 'High', 'Critical', 'Deficient', 'Elevated'][i % 6]
    });
  }
  const panels = [];
  for (let p = 0; p < (extreme ? 5 : 2); p += 1) {
    panels.push({ name: extreme ? longText(120) : 'Complete Blood Count', markers: markers });
  }
  const mk = function (k, v) { const o = {}; o[k] = v; return o; };
  return {
    reportId: 2,
    user: {
      name: extreme ? LONG_NAME : 'Rohan Mehta',
      age: extreme ? '000000000000' : 34,
      gender: extreme ? 'Prefers not to disclose at this time' : 'Male',
      goal: extreme ? longText(160) : 'Fat loss'
    },
    blood_analysis: { panels: panels },
    nutrition_analysis: {
      averages: { calories: extreme ? 1234567890 : 2180, protein: extreme ? 99999 : 128, carbs: 210, fat: 74 },
      meal_quality_score: 6,
      quality_interpretation: extreme ? longText(900) : 'Protein is adequate; fibre is low.',
      top_meals: [
        { name: extreme ? LONG_MARKER : 'Chicken rice bowl', frequency: 4, avg_calories: 640, assessment: 'Good' },
        { name: extreme ? UNBREAKABLE : 'Masala dosa', frequency: 3, avg_calories: 480, assessment: 'Fair' }
      ]
    },
    ai_report: {
      overall_status: extreme ? 'Requires Immediate Clinical Attention' : 'Fair',
      overall_summary_short: extreme ? longText(1200) : 'Most markers sit in range.',
      clinical_interpretation: extreme ? longText(6000) : longText(700),
      key_findings: [
        { title: extreme ? LONG_MARKER : 'Vitamin D low', detail: extreme ? longText(1400) : 'Supplement for 12 weeks.', severity: 'critical' },
        { title: 'Lipids in range', detail: extreme ? longText(600) : 'No action.', severity: 'good' }
      ],
      risks: [
        { area: extreme ? LONG_MARKER : 'Cardiometabolic', level: 'High', factors: extreme ? longText(1000) : 'ApoB elevated.' },
        { area: 'Bone health', level: 'Medium', factors: extreme ? UNBREAKABLE : 'Low vitamin D.' }
      ],
      foods_include_intro: extreme ? longText(500) : 'Add these foods.',
      foods_include: [
        { name: extreme ? LONG_MARKER : 'Fatty fish', reason: extreme ? longText(900) : 'Omega-3.' },
        { name: 'Leafy greens', reason: extreme ? UNBREAKABLE : 'Folate.' }
      ],
      foods_avoid: [{ name: extreme ? UNBREAKABLE : 'Fried snacks', reason: extreme ? longText(800) : 'Trans fat.' }],
      weekly_meal_plan: [{
        day: extreme ? longText(60) : 'Monday',
        total_calories: extreme ? 1234567 : 2100,
        total_protein: 140,
        meals: [
          { type: extreme ? 'Pre-workout second breakfast' : 'Breakfast', meal: extreme ? longText(400) : 'Oats + whey', calories: 480 },
          { type: 'Lunch', meal: extreme ? UNBREAKABLE : 'Dal, rice, salad', calories: 620 }
        ]
      }],
      supplement_intro: extreme ? longText(400) : 'Twelve-week protocol.',
      supplements: [
        { name: extreme ? LONG_MARKER : 'Vitamin D3', dose: extreme ? longText(60) : '2000 IU', timing: extreme ? longText(60) : 'Morning', reason: extreme ? longText(700) : 'Deficiency.' }
      ],
      lifestyle: {
        sleep: extreme ? longText(1200) : 'Seven to nine hours.',
        stress: extreme ? UNBREAKABLE : 'Breath work.',
        exercise: extreme ? longText(900) : 'Four sessions weekly.',
        hydration: 'Three litres.',
        recovery: extreme ? longText(600) : 'One rest day.'
      },
      progress_intro: extreme ? longText(400) : 'Retest schedule below.',
      retest_schedule: [
        { test: extreme ? LONG_MARKER : 'Vitamin D', when: extreme ? longText(40) : '12 weeks', reason: extreme ? longText(800) : 'Confirm repletion.' }
      ]
    }
  };
}

async function auditBlood(pdfjs) {
  section('Blood / health report  (services/healthReportPdfKit.js)');
  const { buildHealthReportPdf } = require('../services/healthReportPdfKit');
  const profiles = ['empty', 'normal', 'extreme'];
  for (const profile of profiles) {
    const out = path.join(OUT_DIR, 'blood-' + profile + '.pdf');
    await buildHealthReportPdf(bloodPayload(profile), out);
    const pages = await readPages(pdfjs, out);
    auditPages('blood/' + profile, pages, { left: 45, right: 551, top: 18, bottom: 824 });
    auditBranding('blood/' + profile, pages, 'BodyBank');
  }
}

function whoopPayload(profile) {
  if (profile === 'empty') {
    return { member: { name: '' }, stats: {}, report: null, validation: null };
  }
  const extreme = profile === 'extreme';
  const metric = function (u) {
    return {
      mean: extreme ? '123456.789' : 61, median: 60, min: 22, max: 95,
      stdDev: 12, latest: 58, latestDate: extreme ? longText(40) : '2026-09-01',
      n: 28, unit: extreme ? 'per 1.73m2 body surface area' : u
    };
  };
  const weekly = [];
  for (let i = 0; i < (extreme ? 40 : 4); i += 1) {
    weekly.push({
      week: extreme ? longText(30) : '2026-W3' + i, dateFrom: '2026-08-0' + (i % 9), dateTo: '2026-08-1' + (i % 9),
      days: 7, recovery: 61, hrv: 74, restingHr: 52, sleepHours: 7.2, sleepEfficiency: 88, strain: 13.4
    });
  }
  return {
    member: { name: extreme ? LONG_NAME : 'Aditi Rao' },
    stats: {
      coverage: { dateFrom: '2026-08-01', dateTo: '2026-08-31', daysWithData: 28, daysTotal: 31, completenessPct: 90 },
      metrics: { recovery: metric('%'), hrv: metric('ms'), restingHr: metric('bpm'), sleepHours: metric('h'), strain: metric(null) },
      trends: {
        recovery: { firstHalfMean: 58, secondHalfMean: 64, deltaAbs: 6, deltaPct: 10, direction: 'improving', changeDirection: 'up', n: 28, unit: '%' },
        hrv: { firstHalfMean: 70, secondHalfMean: 78, deltaAbs: 8, deltaPct: 11, direction: 'improving', changeDirection: 'up', n: 28, unit: 'ms' }
      },
      sleepDebt: { totalMin: extreme ? '999999999999' : 640, avgPerNightMin: 23, nights: 28, worstDate: extreme ? longText(30) : '2026-08-14', worstMin: 190, nightsUnder6h: 4, nightsOver8h: 6 },
      strainRecoveryBalance: {
        interpretationKey: 'overreaching', daysConsidered: extreme ? '1234567890123' : 26,
        daysHighStrainLowRecovery: 7, daysLowStrainHighRecovery: 3, avgStrainOnLowRecoveryDays: 14.2,
        highStrainThreshold: 14, lowStrainThreshold: 8, lowRecoveryThreshold: 34, highRecoveryThreshold: 67
      },
      notableDays: {
        bestRecovery: { value: 96, date: extreme ? longText(40) : '2026-08-03' },
        worstRecovery: { value: 18, date: '2026-08-21' },
        longestSleep: { value: 9.4, date: '2026-08-11' },
        shortestSleep: { value: 3.9, date: '2026-08-20' }
      },
      correlations: {
        sleepHoursToNextDayRecovery: { r: 0.54, n: 27, lagDays: 1, strength: 'moderate', direction: 'positive' },
        strainToNextDayRecovery: { r: -0.41, n: 26, lagDays: 1, strength: 'moderate', direction: 'negative' }
      },
      flags: [
        { key: 'chronic_sleep_debt', severity: 'critical', avgPerNightMin: 23, totalMin: 640, nights: 28, thresholdMin: 20 },
        { key: extreme ? UNBREAKABLE : 'overreaching', severity: 'warn', daysHighStrainLowRecovery: 7, daysConsidered: 26, note: extreme ? longText(900) : 'x' }
      ],
      weekly: weekly,
      thresholds: { trendMinDays: 10, shortNightHours: 6, longNightHours: 8, sleepDebtWarnMin: 20, sleepDebtCriticalMin: 45, correlationMinPairs: 10, correlationStrong: 0.6, correlationModerate: 0.4, correlationWeak: 0.2 }
    },
    report: {
      headline: extreme ? longText(600) : 'Recovery improved while sleep debt grew.',
      summary: extreme ? longText(5000) : longText(600),
      sections: [{ title: extreme ? LONG_MARKER : 'Sleep', body: extreme ? longText(3000) : longText(500) }],
      sleepAnalysis: extreme ? longText(2500) : longText(400),
      recoveryAnalysis: extreme ? longText(2500) : longText(400),
      trainingLoadAnalysis: extreme ? UNBREAKABLE : longText(300),
      correlationInsights: extreme ? longText(1500) : longText(300),
      actions: [
        { rank: 1, action: extreme ? longText(400) : 'Add 45 minutes of sleep.', rationale: extreme ? longText(1200) : 'Debt is the largest lever.' },
        { rank: extreme ? '9999999' : 2, action: extreme ? UNBREAKABLE : 'Cut one hard session.', rationale: longText(200) }
      ],
      coachNotes: extreme ? longText(2000) : longText(300)
    },
    validation: {
      passed: profile === 'extreme' ? false : true,
      orphanNumbers: extreme ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] : [],
      occurrences: extreme ? [{ field: longText(60), number: 42 }, { field: 'summary', number: 7 }] : [],
      semantic: extreme ? { contradictions: [{ quote: longText(300), why: longText(300) }], unsupportedClaims: [{ quote: UNBREAKABLE, why: longText(200) }] } : null
    }
  };
}

async function auditWhoop(pdfjs) {
  section('Recovery & readiness report  (services/wearables/whoopReportPdfKit.js)');
  const { buildWhoopReportPdf } = require('../services/wearables/whoopReportPdfKit');
  for (const profile of ['empty', 'normal', 'extreme']) {
    const out = path.join(OUT_DIR, 'whoop-' + profile + '.pdf');
    await buildWhoopReportPdf(whoopPayload(profile), out, { compress: false });
    const pages = await readPages(pdfjs, out);
    auditPages('whoop/' + profile, pages, { left: 45, right: 551, top: 18, bottom: 830 });
    auditBranding('whoop/' + profile, pages, 'BodyBank');
  }
}

function comparisonPayload(profile) {
  const extreme = profile === 'extreme';
  if (profile === 'empty') {
    return { doc: { cover: { show: true, fields: {} }, sections: [] } };
  }
  const markers = [];
  for (let i = 0; i < (extreme ? 30 : 8); i += 1) {
    markers.push({
      name: extreme ? LONG_MARKER + ' ' + i : 'Marker ' + i,
      reference: extreme ? longText(70) : '10 - 20',
      values: [
        { text: extreme ? '1234567890.12345' : '14.2', status: 'Normal' },
        { text: extreme ? UNBREAKABLE : '15.1', status: 'High' }
      ],
      trend: { dir: 'improving', arrow: 'up', text: extreme ? longText(40) : '+6%' }
    });
  }
  return {
    doc: {
      cover: {
        show: true,
        brandTitle: extreme ? longText(120) : 'Blood Report Progress Review',
        brandSubtitle: extreme ? longText(200) : 'Two tests compared',
        fields: {
          patientName: extreme ? LONG_NAME : 'Rohan Mehta',
          reportDate: extreme ? longText(60) : '11 September 2026',
          reportType: extreme ? longText(60) : 'Progress',
          ageGender: extreme ? longText(50) : '34 / Male',
          goal: extreme ? longText(200) : 'Fat loss',
          testsCompared: extreme ? longText(300) : '2'
        },
        trajectory: { label: extreme ? longText(60) : 'Improving', summary: extreme ? longText(1200) : longText(300) },
        stats: { items: [
          { label: extreme ? longText(60) : 'Improved', value: extreme ? '1234567890' : '12', tone: 'green' },
          { label: 'Worsened', value: extreme ? UNBREAKABLE : '3', tone: 'red' },
          { label: 'Stable', value: '9', tone: 'blue' }
        ] },
        footnote: { text: extreme ? longText(800) : 'Discuss with your physician.' }
      },
      sections: [
        { type: 'trend', title: extreme ? longText(100) : 'Marker trends', subtitle: extreme ? longText(150) : 'All panels',
          intro: extreme ? longText(900) : 'Reading the table.',
          columns: [{ label: extreme ? longText(40) : 'Mar 2026' }, { label: extreme ? longText(40) : 'Sep 2026' }],
          panels: [{ name: extreme ? longText(120) : 'CBC', markers: markers }] },
        { type: 'text', title: 'Interpretation', subtitle: extreme ? longText(120) : '',
          badge: { show: true, label: extreme ? longText(40) : 'Verdict', text: extreme ? longText(200) : 'On track' },
          body: extreme ? longText(6000) : longText(800) },
        { type: 'cards', title: 'Changes', groups: [
          { title: extreme ? longText(90) : 'Improvements', tone: 'good', items: [
            { marker: extreme ? LONG_MARKER : 'Vitamin D', from: extreme ? longText(50) : '18', to: extreme ? UNBREAKABLE : '42', meaning: extreme ? longText(1200) : 'Repleted.', level: 'High' }
          ] },
          { title: 'Concerns', tone: 'bad', items: [
            { marker: extreme ? UNBREAKABLE : 'ApoB', from: '92', to: '118', meaning: extreme ? longText(900) : 'Rising.', level: 'Medium' }
          ] }
        ] },
        { type: 'table', title: 'Supplements',
          columns: [
            { id: 'a', header: extreme ? longText(50) : 'Supplement', width: 0.3, style: 'strong' },
            { id: 'b', header: 'Action', width: 0.2, style: 'action' },
            { id: 'c', header: extreme ? longText(60) : 'Reason', width: 0.5, style: 'muted' }
          ],
          rows: [
            { cells: { a: extreme ? LONG_MARKER : 'Vitamin D3', b: 'stop', c: extreme ? longText(1400) : 'Repleted.' } },
            { cells: { a: extreme ? UNBREAKABLE : 'Omega-3', b: 'start', c: extreme ? longText(700) : 'Triglycerides.' } }
          ] },
        { type: 'callout', title: 'Next step', label: extreme ? longText(60) : 'Action',
          text: extreme ? longText(2500) : 'Retest in twelve weeks.', tone: 'gold' },
        { type: 'disclaimer', title: 'Disclaimer', label: extreme ? longText(80) : 'Medical Disclaimer: ',
          text: extreme ? longText(1800) : 'Not a diagnosis.' }
      ]
    }
  };
}

async function auditComparison(pdfjs) {
  section('Blood progress / comparison report  (services/comparisonReportPdfKit.js)');
  const { buildComparisonReportPdf } = require('../services/comparisonReportPdfKit');
  for (const profile of ['empty', 'normal', 'extreme']) {
    const out = path.join(OUT_DIR, 'comparison-' + profile + '.pdf');
    await buildComparisonReportPdf(comparisonPayload(profile), out);
    const pages = await readPages(pdfjs, out);
    auditPages('comparison/' + profile, pages, { left: 45, right: 551, top: 18, bottom: 824 });
    auditBranding('comparison/' + profile, pages, 'BodyBank');
  }
}

function gradedPayload(profile) {
  const extreme = profile === 'extreme';
  if (profile === 'empty') {
    return { cover: { title: 'Health Map', clientName: '', stats: [] }, sections: [] };
  }
  const markers = [];
  for (let i = 0; i < (extreme ? 40 : 10); i += 1) {
    markers.push({
      label: extreme ? LONG_MARKER + ' ' + i : 'Marker ' + i,
      result: extreme ? '1234567890.1234 mg/dL' : '14.2 g/dL',
      range: extreme ? longText(80) : '13 - 17',
      status: extreme ? longText(40) : 'Within range',
      trend: 'NO_SIGNIFICANT_CHANGE',
      trendLabel: extreme ? longText(50) : 'No Significant Change',
      rangeSource: 'BODYBANK_PREFERRED'
    });
  }
  const areas = [];
  for (let i = 0; i < (extreme ? 12 : 6); i += 1) {
    areas.push({ label: extreme ? LONG_MARKER : 'Metabolic', grade: ['A', 'B', 'C', 'D'][i % 4], gradeLabel: extreme ? longText(60) : 'Monitor', previousGrade: 'C' });
  }
  return {
    cover: {
      title: extreme ? longText(150) : 'Health Map Report',
      clientName: extreme ? LONG_NAME : 'Rohan Mehta',
      clientMeta: extreme ? longText(200) : '34 / Male',
      screeningDateLabel: extreme ? longText(80) : '11 September 2026',
      stats: [
        { label: extreme ? longText(50) : 'Areas', value: extreme ? '1234567890' : '9' },
        { label: 'Priorities', value: extreme ? UNBREAKABLE : '3' },
        { label: 'Markers', value: '41' }
      ]
    },
    sections: [
      { type: 'healthmap', title: extreme ? longText(120) : 'Your health map', subtitle: extreme ? longText(300) : 'Nine areas graded', areas: areas,
        notAssessed: [{ label: extreme ? LONG_MARKER : 'Thyroid', needs: extreme ? longText(80) : 'TSH' }] },
      { type: 'text', variant: 'lead', body: extreme ? longText(2000) : longText(300) },
      { type: 'priorities', title: 'Priorities', subtitle: extreme ? longText(200) : '', items: [
        { rank: 1, title: extreme ? LONG_MARKER : 'Vitamin D deficiency', areaLabel: extreme ? longText(80) : 'Bone', grade: 'D',
          result: extreme ? longText(90) : '18 ng/mL', status: extreme ? longText(50) : 'Low',
          whyItMatters: extreme ? longText(2500) : longText(400), nextStep: extreme ? longText(1800) : longText(300),
          requiresProfessional: true, professionalNote: extreme ? longText(200) : 'Discuss with your doctor.' }
      ] },
      { type: 'areacards', title: 'Detail', cards: [
        { label: extreme ? LONG_MARKER : 'Metabolic', grade: 'B', gradeLabel: extreme ? longText(60) : 'Monitor',
          summary: extreme ? longText(1500) : longText(300), trendLine: extreme ? longText(300) : 'Stable', requiresProfessional: true,
          findings: [
            { label: extreme ? LONG_MARKER : 'HbA1c', result: extreme ? longText(40) : '5.6 %', range: extreme ? longText(60) : '< 5.7',
              status: extreme ? longText(40) : 'Within range', insight: extreme ? longText(900) : 'Stable.' }
          ],
          focus: extreme ? longText(1200) : 'Keep steps above 8,000.' }
      ] },
      { type: 'markers', title: 'All markers', groups: [{ label: extreme ? longText(120) : 'CBC', markers: markers }] },
      { type: 'progress', title: 'Progress', caution: extreme ? longText(800) : 'Different labs.', groups: [
        { key: 'improved', title: extreme ? longText(90) : 'Improved', items: [{ label: extreme ? LONG_MARKER : 'Vitamin D', previous: extreme ? longText(40) : '18', current: extreme ? UNBREAKABLE : '42' }] },
        { key: 'stable', title: 'Stable', items: markers.map(function (m) { return { label: m.label }; }) }
      ] },
      { type: 'list', title: 'Next steps', style: 'numbered', items: [
        { text: extreme ? longText(1500) : 'Book a follow-up.', requiresProfessional: true },
        { text: extreme ? UNBREAKABLE : 'Retest in 12 weeks.' }
      ] },
      { type: 'callout', title: extreme ? longText(120) : 'Discuss with a doctor', tone: 'review',
        body: extreme ? longText(1500) : longText(200), items: [
          { label: extreme ? LONG_MARKER : 'Vitamin D', result: extreme ? longText(50) : '18 ng/mL', range: extreme ? longText(60) : '30-100', note: extreme ? longText(700) : 'Low.' }
        ] },
      { type: 'disclaimer', title: 'Medical Disclaimer', body: extreme ? longText(2000) : 'Not a diagnosis.' }
    ]
  };
}

async function auditGraded(pdfjs) {
  section('Health Map (graded) report  (services/gradedReportPdfKit.js)');
  const { buildGradedReportPdf } = require('../services/gradedReportPdfKit');
  for (const profile of ['empty', 'normal', 'extreme']) {
    const out = path.join(OUT_DIR, 'graded-' + profile + '.pdf');
    await buildGradedReportPdf(gradedPayload(profile), out);
    const pages = await readPages(pdfjs, out);
    auditPages('graded/' + profile, pages, { left: 45, right: 551, top: 18, bottom: 824 });
    auditBranding('graded/' + profile, pages, 'BodyBank');
  }
}

function weeklyPayload(profile) {
  const extreme = profile === 'extreme';
  const days = [];
  for (let i = 0; i < 7; i += 1) days.push({ label: 'MTWTFSS'[i], value: extreme ? 987654321 : 8000 + i * 500 });
  const metric = function () {
    return {
      actual: extreme ? 987654321 : 56000, target: extreme ? 123456789 : 70000, achievementPct: extreme ? 999 : 80,
      dailyAvg: extreme ? 987654321 : 8000, bestDay: { value: extreme ? 987654321 : 12000 },
      vsPrevPct: extreme ? -99999 : 12, dailyGoal: extreme ? 123456789 : 10000, days: days
    };
  };
  return {
    report: {
      user: profile === 'empty' ? { email: 'x@y.z' }
        : { first_name: extreme ? LONG_NAME : 'Rohan', last_name: extreme ? LONG_NAME : 'Mehta', email: 'r@m.com' },
      weekStart: '2026-09-01', weekEnd: '2026-09-07',
      overallScore: extreme ? 100 : 78,
      goalsHit: extreme ? 999999 : 3, goalsTotal: extreme ? 999999 : 4, streak: extreme ? 999999 : 12,
      totalProgress: { vsPrevPct: extreme ? -99999 : 8 },
      metrics: { steps: metric(), water: metric(), protein: metric(), sleep: metric() },
      highlights: { mostConsistentDays: extreme ? [longText(120), longText(120)] : ['Tuesday', 'Thursday'] }
    }
  };
}

async function auditWeekly(pdfjs) {
  section('Weekly performance report  (services/weeklyReportPdf.js)');
  const { generateWeeklyReportPdf } = require('../services/weeklyReportPdf');
  for (const profile of ['empty', 'normal', 'extreme']) {
    const out = path.join(OUT_DIR, 'weekly-' + profile + '.pdf');
    await generateWeeklyReportPdf({ outputPath: out, report: weeklyPayload(profile).report, logoPath: null });
    const pages = await readPages(pdfjs, out);
    auditPages('weekly/' + profile, pages, { left: 34, right: 562, top: 18, bottom: 824 });
    auditBranding('weekly/' + profile, pages, 'BodyBank');
  }
}

function formRecord(profile) {
  const extreme = profile === 'extreme';
  const v = function (normal) {
    if (profile === 'empty') return '';
    return extreme ? longText(2500) : normal;
  };
  return {
    full_name: profile === 'empty' ? '' : (extreme ? LONG_NAME : 'Rohan Mehta'),
    name: profile === 'empty' ? '' : (extreme ? LONG_NAME : 'Rohan Mehta'),
    reply_email: extreme ? UNBREAKABLE + '@example.com' : 'r@m.com',
    email: extreme ? UNBREAKABLE + '@example.com' : 'r@m.com',
    created_at: '2026-09-07T10:00:00Z',
    plan: v('Plan A'), body_fat_percent: extreme ? '123456789' : 18,
    current_weight_waist_week: v('82 kg / 92 cm'), last_week_weight_waist: v('83 kg / 93 cm'),
    total_weight_loss: v('-6 kg'), training_go: v('Good'), nutrition_go: v('Fair'),
    sleep: v('7h'), occupation_stress: v('Moderate'), other_stress: v('None'),
    differences_felt: v('Stronger'), achievements: v('First pull-up'),
    improve_next_week: v('Sleep'), questions: v('None'),
    mobile: extreme ? UNBREAKABLE : '+91 90000 00000', activity_level: v('Moderate'),
    height_cm: 178, bodyweight_kg: 82, workouts_per_week: v('4'), sleep_hours: 7, stress_level: 5,
    smoking: v('No'), alcohol: v('Occasional'), sports_history: v('Cricket'),
    injuries: v('None'), mental_health: v('Stable'), gym_experience: v('3 years'),
    food_choices: v('Vegetarian'), vices_addictions: v('None'),
    goals: v('Fat loss'), what_compelled: v('Health scare')
  };
}

async function auditForms(pdfjs) {
  section('Form dossiers  (services/formPdfService.js)');
  const { writeSundayCheckinPdf, writePart2Pdf } = require('../services/formPdfService');
  for (const profile of ['empty', 'normal', 'extreme']) {
    const a = path.join(OUT_DIR, 'sunday-' + profile + '.pdf');
    await writeSundayCheckinPdf({ outputPath: a, record: formRecord(profile), logoPath: null });
    const pa = await readPages(pdfjs, a);
    auditPages('sunday/' + profile, pa, { left: 30, right: 566, top: 18, bottom: 828 });
    auditBranding('sunday/' + profile, pa, 'bodybank');

    const b = path.join(OUT_DIR, 'part2-' + profile + '.pdf');
    await writePart2Pdf({ outputPath: b, record: formRecord(profile), logoPath: null });
    const pb = await readPages(pdfjs, b);
    auditPages('part2/' + profile, pb, { left: 30, right: 566, top: 18, bottom: 828 });
    auditBranding('part2/' + profile, pb, 'bodybank');
  }
}

function monthlyPayload(profile) {
  const extreme = profile === 'extreme';
  const nDaily = profile === 'empty' ? 0 : (extreme ? 31 : 20);
  const dailyCheckins = [];
  for (let i = 0; i < nDaily; i += 1) {
    dailyCheckins.push({
      checkin_date: '2026-08-' + String((i % 28) + 1).padStart(2, '0'),
      steps: extreme ? 987654321 : 8000 + i * 40,
      water_ml: 2500, protein_g: 130, sleep_hours: 7.2,
      created_at: '2026-08-0' + ((i % 9) + 1) + 'T06:00:00Z'
    });
  }
  const progressLogs = [];
  for (let i = 0; i < (profile === 'empty' ? 0 : (extreme ? 8 : 3)); i += 1) {
    progressLogs.push({
      id: i, user_id: 1, created_at: '2026-08-1' + i + 'T06:00:00Z',
      weight: 82 - i * 0.4, body_fat: 18 - i * 0.2,
      notes: extreme ? longText(3000) : 'Feeling good.',
      photos: extreme ? { front: UNBREAKABLE, side: UNBREAKABLE, back: UNBREAKABLE } : null
    });
  }
  const sundayCheckins = [];
  for (let i = 0; i < (profile === 'empty' ? 0 : (extreme ? 5 : 2)); i += 1) {
    sundayCheckins.push(Object.assign({ id: i }, formRecord(profile)));
  }
  const workouts = [];
  for (let i = 0; i < (profile === 'empty' ? 0 : (extreme ? 12 : 4)); i += 1) {
    workouts.push({
      id: i, user_id: 1, created_at: '2026-08-0' + ((i % 9) + 1) + 'T18:00:00Z',
      session_date: '2026-08-0' + ((i % 9) + 1),
      // Uppercase W/M are the widest glyphs: the harshest test for a 74pt chart gutter.
      workout_type: extreme ? (i % 2 ? 'WMWMWMWMWMWMWMWMWMWMWMWM ' + i : longText(200)) : 'Push',
      duration_min: 62, notes: extreme ? longText(3500) : 'Solid session.',
      session_lifts: extreme ? longText(4000) : 'Bench 80x5'
    });
  }
  return {
    monthKey: '2026-08',
    user: { name: profile === 'empty' ? '' : (extreme ? LONG_NAME : 'Rohan Mehta'), email: extreme ? UNBREAKABLE + '@x.com' : 'r@m.com' },
    data: {
      dailyCheckins: dailyCheckins,
      progressLogs: progressLogs,
      sundayCheckins: sundayCheckins,
      workouts: workouts,
      programs: profile === 'empty' ? [] : [{ program_name: extreme ? longText(300) : 'Hypertrophy 12', assigned_at: '2026-07-01' }],
      tribeMember: profile === 'empty' ? null : { status: 'active', phase: 2, start_date: '2026-01-01', activity_per_week: 4, starting_weight: 92, current_weight: 82, target_weight: 78, next_checkin: '2026-09-15', notes: extreme ? longText(2000) : 'On track.' },
      audit: profile === 'empty' ? null : { id: 1, goal: extreme ? longText(3000) : 'Fat loss', history: extreme ? longText(3000) : 'None' },
      part2: profile === 'empty' ? null : formRecord(profile),
      userGoals: profile === 'empty' ? [] : [{ target_weight: 78, target_body_fat: 14, weekly_workout_target: 4, created_at: '2026-07-01' }],
      hydrationLogs: profile === 'empty' ? [] : [{ created_at: '2026-08-01', amount_ml: 2500, glasses: 10 }],
      weightLogs: profile === 'empty' ? [] : [{ created_at: '2026-08-01', weight_kg: 82 }],
      meetings: profile === 'empty' ? [] : [{ meeting_date: '2026-08-12', time_slot: '18:00', status: 'done', notes: extreme ? longText(1500) : 'Reviewed.' }],
      previousMonth: null
    },
    insights: profile === 'empty' ? null : {
      performance: extreme ? [longText(600), longText(600)] : ['Consistent logging'],
      insightTags: extreme ? [UNBREAKABLE, longText(400)] : ['consistent']
    },
    aiNarrative: profile === 'empty' ? null : {
      executive_summary: extreme ? longText(9000) : longText(900),
      sections: {
        onboarding_audit: { pros: extreme ? [longText(700), UNBREAKABLE] : ['Complete'], cons: extreme ? [longText(700)] : ['Missing sleep data'], note: extreme ? longText(2500) : 'Good baseline.' },
        part2_intake: { pros: [extreme ? longText(800) : 'Detailed'], cons: [extreme ? UNBREAKABLE : 'Sparse'], note: extreme ? longText(2000) : 'ok' },
        tribe_programs: { pros: ['Assigned'], cons: ['Phase lag'], note: extreme ? longText(1800) : 'ok' },
        daily_checkins: { pros: [extreme ? longText(900) : 'High adherence'], cons: ['Weekend gaps'], note: extreme ? longText(2200) : 'ok' },
        progress_logs: { pros: ['Regular'], cons: [extreme ? longText(900) : 'Photos missing'], note: extreme ? longText(1500) : 'ok' },
        sunday_checkins: { pros: ['Submitted'], cons: ['Short answers'], note: extreme ? longText(1500) : 'ok' },
        workouts: { pros: ['4/week'], cons: [extreme ? UNBREAKABLE : 'No deload'], note: extreme ? longText(1500) : 'ok' },
        hydration_weight_goals: { pros: ['Hydration on target'], cons: ['Weight plateau'], note: extreme ? longText(1500) : 'ok' },
        meetings: { pros: ['Attended'], cons: ['Late'], note: extreme ? longText(1500) : 'ok' }
      }
    }
  };
}

async function auditMonthly(pdfjs) {
  section('Monthly performance report  (services/monthlyReportService.js + monthlyReportPdfDetail.js)');
  const { generateMonthlyClientReport } = require('../services/monthlyReportService');
  for (const profile of ['empty', 'normal', 'extreme']) {
    const p = monthlyPayload(profile);
    const out = path.join(OUT_DIR, 'monthly-' + profile + '.pdf');
    await generateMonthlyClientReport({
      outputPath: out, monthKey: p.monthKey, user: p.user, data: p.data,
      insights: p.insights, logoPath: null, aiNarrative: p.aiNarrative
    });
    const pages = await readPages(pdfjs, out);
    auditPages('monthly/' + profile, pages, { left: 30, right: 566, top: 14, bottom: 832 });
    auditBranding('monthly/' + profile, pages, 'BODYBANK');
  }
}

async function auditCompliance(pdfjs) {
  section('Admin daily compliance report  (services/emailScheduler.js)');
  const { buildAdminReportPdf } = require('../services/emailScheduler');
  for (const profile of ['empty', 'normal', 'extreme']) {
    const n = profile === 'empty' ? 0 : (profile === 'extreme' ? 140 : 25);
    const statuses = ['Yes', 'Missed'];
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      rows.push({
        name: profile === 'extreme' ? LONG_NAME + ' ' + i : 'Member ' + i,
        daily_status: statuses[i % 2], progress_status: statuses[(i + 1) % 2],
        sunday_status: statuses[i % 2], workout_status: statuses[(i + 1) % 2]
      });
    }
    const summary = {
      totalUsers: profile === 'extreme' ? 123456789012 : n,
      dailyYes: Math.ceil(n / 2), dailyMissed: Math.floor(n / 2)
    };
    const buf = await buildAdminReportPdf({
      rows, summary,
      windowLabel: profile === 'extreme' ? longText(400) : '10 Sep 2026, 12:00 am to 11 Sep 2026, 12:00 am IST'
    });
    const out = path.join(OUT_DIR, 'compliance-' + profile + '.pdf');
    fs.writeFileSync(out, buf);
    const pages = await readPages(pdfjs, out);
    auditPages('compliance/' + profile, pages, { left: 30, right: 566, top: 18, bottom: 828 });
    auditBranding('compliance/' + profile, pages, 'BodyBank');
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const only = process.argv.slice(2).filter(function (a) { return a.charAt(0) !== '-'; });
  const want = function (name) { return !only.length || only.indexOf(name) !== -1; };
  const pdfjs = await loadPdfjs();
  console.log('Rendering audit PDFs into ' + OUT_DIR);

  if (want('blood')) await auditBlood(pdfjs);
  if (want('whoop')) await auditWhoop(pdfjs);
  if (want('comparison')) await auditComparison(pdfjs);
  if (want('graded')) await auditGraded(pdfjs);
  if (want('weekly')) await auditWeekly(pdfjs);
  if (want('forms')) await auditForms(pdfjs);
  if (want('monthly')) await auditMonthly(pdfjs);
  if (want('compliance')) await auditCompliance(pdfjs);

  console.log('\n' + '-'.repeat(72));
  if (failures.length) {
    console.log('FAILED — ' + failures.length + ' problem(s) across ' + checks + ' checks:\n');
    failures.forEach(function (f) { console.log('  * ' + f); });
    process.exitCode = 1;
  } else {
    console.log('PASS — ' + checks + ' checks, no overflow, no blank pages, branding on every page.');
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  });
}
