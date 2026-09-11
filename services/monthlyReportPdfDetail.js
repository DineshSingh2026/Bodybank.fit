'use strict';

/**
 * Paginated luxury appendix for monthly PDF — every field + pros/cons blocks.
 *
 * ===========================================================================
 * WHY THIS FILE WAS REWRITTEN: THE EMPTY PAGES CAME FROM HERE
 * ===========================================================================
 * The previous paginator handed a `y` value back to its caller and trusted the
 * caller to use it. Two helpers — `addBulletList` and the wrapped-text writer —
 * could break a page in the middle of their own work, and the callers that
 * invoked them (`drawProsConsBlock`, the engine-snapshot box) then carried on
 * from the y they had BEFORE the break. The cursor and the real page had
 * diverged, so:
 *
 *   - the next `ensure()` saw a large stale y, decided there was no room, and
 *     opened a page that nothing was ever drawn on — one blank page per
 *     desynced section, which is the "many empty pages" in a monthly report;
 *   - the pros column could land on page N+1 while the cons column was still
 *     being drawn against page N coordinates, so the two overlapped;
 *   - a record taller than a sheet of paper hit the anti-chaining branch, which
 *     returned y unchanged and let the block draw straight off the bottom.
 *
 * The paginator now OWNS the cursor (`pg.y`). Nothing returns a y for a caller
 * to get wrong. And every block is emitted as line-sized pieces packed into
 * panels page by page, so a record longer than a page splits across panels
 * instead of overflowing one.
 */

const PL = require('./pdfLayout');

const C = {
  pageBg: '#E8ECF4',
  bg: '#07070A',
  panel: '#FFFFFF',
  panelSoft: '#E2E6EF',
  gold: '#D4AF37',
  goldMid: '#B8922E',
  goldDark: '#7A6220',
  text: '#0E1118',
  muted: '#5A6278',
  violet: '#6B4FC9',
  emerald: '#0D7A5F',
  danger: '#B03A32',
  grid: '#D0D6E4'
};

function F(doc, role) {
  const custom = doc._bbCustomFonts === true;
  if (!custom) {
    if (role === 'display' || role === 'semi') return 'Helvetica-Bold';
    return 'Helvetica';
  }
  if (role === 'display') return 'BBDisplay';
  if (role === 'semi') return 'BBSemi';
  return 'BBBody';
}

function num(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatVal(v, maxLen = 2400) {
  if (v == null) return '—';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v, null, 0);
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    } catch (_) {
      return String(v);
    }
  }
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function drawWatermark(doc) {
  // Placed by the kernel: the rotated bounding box is derived from the real
  // string metrics, so no repetition leaves the sheet, and it is drawn with no
  // width so PDFKit can neither wrap it nor paginate on it.
  PL.diagonalWatermark(doc, { text: 'CONFIDENTIAL', font: F(doc, 'display'), size: 52, color: C.gold, opacity: 0.035, count: 4 });
}

function sectionTitle(doc, text, y, contentW, margin) {
  doc.roundedRect(margin, y, contentW, 22, 5).fillAndStroke(C.panelSoft, '#BFC8D8');
  PL.drawFit(doc, String(text).toUpperCase(), margin + 10, y + 7, contentW - 20,
    { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.goldDark });
}

function pageTextBottom(doc, margin) {
  return doc.page.height - margin - 22;
}

function measureBulletsHeight(doc, items, width, fontSize = 8) {
  const list = Array.isArray(items) ? items.map((v) => String(v || '').trim()).filter(Boolean) : [];
  if (!list.length) return 14;
  let h = 0;
  list.forEach((item) => {
    h += PL.measure(doc, item, { font: F(doc, 'body'), size: fontSize, width: width - 10, lineGap: 2 }) + 4;
  });
  return h;
}

// ---------------------------------------------------------------------------
// The paginator — the single cursor for this whole appendix
// ---------------------------------------------------------------------------

/**
 * @param {PDFDocument} doc
 * @returns a cursor that owns `y`. Callers move it with `ensure`/`advance` and
 *   never track a y of their own, which is what went wrong before.
 */
function createPaginator(doc, margin, contentW, docId) {
  const contentTop = margin + 58;
  let pageNum = 1;

  function drawFooter() {
    PL.drawFit(doc, `BODYBANK · Page ${pageNum} · ${docId} · CONFIDENTIAL`,
      margin, doc.page.height - margin - 8, contentW,
      { font: F(doc, 'body'), size: 7.2, color: C.muted, align: 'center' });
  }

  const pg = {
    doc,
    margin,
    contentW,
    get pageNum() { return pageNum; },

    /** Lowest y a block may occupy. */
    bottom() { return doc.page.height - margin - 18; },
    /** Room left on this page. */
    room() { return pg.bottom() - pg.y; },
    /** Nothing has been drawn on this page yet. */
    isFresh() { return pg.y <= contentTop + 0.5; },
    /** Height of a completely empty page. */
    pageHeight() { return pg.bottom() - contentTop; },

    y: contentTop,

    /** Begin the appendix at `y` on the page that is already open. */
    start(y) { pg.y = y; return pg; },

    newPage() {
      drawFooter();
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
      drawWatermark(doc);
      doc.rect(0, 0, doc.page.width, 52).fill(C.bg);
      doc.rect(0, 50, doc.page.width, 2).fill(C.gold);
      PL.drawFit(doc, 'BODYBANK · MONTHLY DOSSIER · CONTINUED', margin, 18, contentW,
        { font: F(doc, 'semi'), size: 8, color: C.goldMid });
      pageNum += 1;
      doc.x = margin;
      doc.y = contentTop;
      pg.y = contentTop;
      return pg;
    },

    /**
     * Guarantee `need` points of room.
     *
     * A page nothing has been drawn on is never broken: that is the move that
     * produced a blank page and then tried again on the next one. A block too
     * tall for any page is not pushed either — callers split instead, using
     * `room()` to see what they actually have.
     */
    ensure(need) {
      if (pg.y + (need || 0) <= pg.bottom()) return false;
      if (pg.isFresh()) return false;
      pg.newPage();
      return true;
    },

    advance(h) { pg.y += h; return pg; },

    drawFooter
  };

  return pg;
}

// ---------------------------------------------------------------------------
// Emitting content that is larger than a page
// ---------------------------------------------------------------------------

/**
 * Turn a layout into one drawable per LINE.
 *
 * Line granularity is what makes splitting always possible: whatever room is
 * left on a page, at least one line fits, so no block can ever be stuck and
 * forced to overflow.
 */
function linePieces(doc, L, opts) {
  const o = opts || {};
  const pieces = [];
  L.lines.forEach((line, i) => {
    pieces.push({
      h: L.lineHeight,
      indent: o.indent || 0,
      draw: (x, y) => {
        if (o.bullet && i === 0) {
          PL.drawFit(doc, '•', x, y, 10, { font: F(doc, 'semi'), size: L.size, color: C.goldMid });
        }
        const single = {
          lines: [line], lineHeight: L.lineHeight, height: L.lineHeight,
          font: L.font, size: L.size, lineGap: L.lineGap, width: L.width, align: L.align
        };
        PL.drawLayout(doc, single, x + (o.indent || 0), y, { color: o.color || C.text });
      }
    });
  });
  return pieces;
}

/**
 * Pack pieces into panels, one panel per page, splitting wherever the page
 * runs out. Returns nothing: the paginator's cursor is the only state.
 *
 * @param {object} style {fill, stroke, radius, pad}
 * @param {function} [caption] either `(isContinuation) => string`, or
 *        `(isContinuation, x, y, w) => void` to draw the band itself. Either
 *        way it gets its own 14pt band at the top of EVERY panel the block
 *        occupies, so a record continued onto a second page still says whose
 *        record it is.
 */
function emitPanel(pg, pieces, style, caption) {
  const doc = pg.doc;
  const s = style || {};
  const pad = s.pad == null ? 10 : s.pad;
  const x = pg.margin;
  const w = pg.contentW;
  let i = 0;
  let first = true;

  while (i < pieces.length) {
    // Enough room for the panel chrome plus at least one line, or start a page.
    pg.ensure(pad * 2 + (caption ? 14 : 0) + pieces[i].h);
    const capH = caption ? 14 : 0;
    const avail = pg.bottom() - pg.y - pad * 2 - capH;
    let take = 0;
    let used = 0;
    while (i + take < pieces.length && used + pieces[i + take].h <= avail) {
      used += pieces[i + take].h;
      take += 1;
    }
    // Always make progress: a line taller than the page still gets drawn once.
    if (take === 0) { take = 1; used = pieces[i].h; }

    const h = used + pad * 2 + capH;
    const top = pg.y;
    if (s.fill || s.stroke) {
      doc.save();
      const shape = doc.roundedRect(x, top, w, h, s.radius == null ? 7 : s.radius);
      if (s.fill && s.stroke) shape.fillAndStroke(s.fill, s.stroke);
      else if (s.fill) shape.fill(s.fill);
      else shape.stroke(s.stroke);
      doc.restore();
    }
    if (caption) {
      const out = caption(!first, x + pad, top + pad - 2, w - pad * 2);
      if (typeof out === 'string' && out) {
        PL.drawFit(doc, out, x + pad, top + pad - 2, w - pad * 2,
          { font: F(doc, 'semi'), size: 8, minSize: 6, color: C.goldDark });
      }
    }
    let cy = top + pad + capH;
    for (let k = 0; k < take; k += 1) {
      pieces[i + k].draw(x + pad, cy);
      cy += pieces[i + k].h;
    }
    pg.y = top + h + 8;
    i += take;
    first = false;
  }
}

/** Pieces for a run of bullet points. */
function bulletPieces(doc, items, width, fontSize, color) {
  const list = Array.isArray(items) ? items.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const out = [];
  list.forEach((item) => {
    const L = PL.layout(doc, item, { font: F(doc, 'body'), size: fontSize, width: width - 10, lineGap: 2 });
    linePieces(doc, L, { bullet: true, indent: 10, color: color || C.text }).forEach((p) => out.push(p));
    out.push({ h: 4, draw: () => {} });
  });
  if (!out.length) {
    const L = PL.layout(doc, '—', { font: F(doc, 'body'), size: fontSize, width: width - 10 });
    linePieces(doc, L, { indent: 10, color: C.muted }).forEach((p) => out.push(p));
  }
  return out;
}

/** Pieces for a "label / value" pair stacked vertically. */
function fieldPieces(doc, label, value, width, opts) {
  const o = opts || {};
  const out = [];
  const labelL = PL.layout(doc, String(label || '').replace(/_/g, ' '), {
    font: F(doc, 'semi'), size: o.labelSize || 7, width, maxLines: 2
  });
  linePieces(doc, labelL, { color: C.goldDark }).forEach((p) => out.push(p));
  const valL = PL.layout(doc, value, {
    font: F(doc, 'body'), size: o.valueSize || 7.6, width, lineGap: o.lineGap == null ? 2 : o.lineGap
  });
  linePieces(doc, valL, { color: o.color || C.text }).forEach((p) => out.push(p));
  out.push({ h: 6, draw: () => {} });
  return out;
}

/**
 * Wrapped text written straight onto the page (no panel), splitting at page
 * boundaries. Kept for the note that trails a pros/cons block.
 */
function drawWrappedTextPaginated(pg, text, x, width, fontSize, lineGap, color) {
  const doc = pg.doc;
  const L = PL.layout(doc, text, { font: F(doc, 'body'), size: fontSize, width, lineGap });
  L.lines.forEach((line) => {
    pg.ensure(L.lineHeight);
    const single = {
      lines: [line], lineHeight: L.lineHeight, height: L.lineHeight,
      font: L.font, size: L.size, lineGap: L.lineGap, width: L.width, align: L.align
    };
    PL.drawLayout(doc, single, x, pg.y, { color: color || C.text });
    pg.advance(L.lineHeight);
  });
}

/**
 * Bullet list written straight onto the page, splitting at page boundaries.
 * Exported shape is kept for the monthly summary page, which draws two short
 * columns inside a box it has already sized.
 */
function addBulletList(doc, items, x, y, width, color, fontSize = 9, paginator = null, margin = 36) {
  const list = Array.isArray(items) ? items.map((v) => String(v || '').trim()).filter(Boolean) : [];
  let curY = y;
  const bottom = paginator ? paginator.bottom() : pageTextBottom(doc, margin);
  if (!list.length) {
    PL.drawFit(doc, '—', x, curY, width, { font: F(doc, 'body'), size: fontSize, color: C.muted });
    return curY + 14;
  }
  const tw = width - 10;
  list.forEach((raw) => {
    const L = PL.layout(doc, raw, { font: F(doc, 'body'), size: fontSize, width: tw, lineGap: 2 });
    L.lines.forEach((line, i) => {
      // This variant never opens a page of its own: it is used inside a box the
      // caller has already measured, so it simply stops at the page bottom.
      if (curY + L.lineHeight > bottom) return;
      if (i === 0) PL.drawFit(doc, '•', x, curY, 10, { font: F(doc, 'semi'), size: fontSize, color: C.goldMid });
      const single = {
        lines: [line], lineHeight: L.lineHeight, height: L.lineHeight,
        font: L.font, size: L.size, lineGap: L.lineGap, width: L.width, align: L.align
      };
      PL.drawLayout(doc, single, x + 10, curY, { color });
      curY += L.lineHeight;
    });
    curY += 4;
  });
  return curY;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function blockTitle(pg, title) {
  pg.ensure(34);
  sectionTitle(pg.doc, title, pg.y, pg.contentW, pg.margin);
  pg.advance(30);
}

/**
 * Strengths / gaps side by side, then the narrative note.
 *
 * The two columns are emitted as one panel of paired lines, so they stay level
 * with each other and split together. Previously each column paginated on its
 * own and the second one could be drawn on the wrong page entirely.
 */
function drawProsConsBlock(pg, title, block) {
  if (!block) return;
  const doc = pg.doc;
  const pros = Array.isArray(block.pros) ? block.pros : [];
  const cons = Array.isArray(block.cons) ? block.cons : [];
  const note = String(block.note || '').trim();
  const colGap = 10;
  const colW = (pg.contentW - colGap) / 2 - 12;

  blockTitle(pg, title);

  const left = bulletPieces(doc, pros, colW, 7.4, C.text);
  const right = bulletPieces(doc, cons, colW, 7.4, C.text);
  // Pair the columns row by row so they advance in lockstep.
  const rows = [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const a = left[i];
    const b = right[i];
    rows.push({
      h: Math.max(a ? a.h : 0, b ? b.h : 0),
      draw: (x, y) => {
        if (a) a.draw(x, y);
        if (b) b.draw(x + colW + colGap + 12, y);
      }
    });
  }
  // The two column headings ride at the top of EVERY panel this block occupies,
  // so a strengths/gaps list continued onto the next page is still labelled.
  emitPanel(pg, rows, { fill: '#FFFCF7', stroke: '#E5D8C4', radius: 8, pad: 12 }, (cont, cx, cy) => {
    PL.drawFit(doc, cont ? 'Strengths / signals (cont.)' : 'Strengths / signals', cx, cy, colW,
      { font: F(doc, 'semi'), size: 7.4, minSize: 6, color: C.emerald });
    PL.drawFit(doc, cont ? 'Gaps / risks (cont.)' : 'Gaps / risks', cx + colW + colGap + 12, cy, colW,
      { font: F(doc, 'semi'), size: 7.4, minSize: 6, color: C.danger });
  });
  if (note) {
    pg.advance(2);
    drawWrappedTextPaginated(pg, note, pg.margin + 12, pg.contentW - 24, 7.3, 2, C.muted);
    pg.advance(10);
  } else {
    pg.advance(4);
  }
}

function renderKeyValueObject(pg, obj) {
  const doc = pg.doc;
  const keys = Object.keys(obj || {}).filter((k) => k !== 'id');
  if (!keys.length) {
    pg.ensure(24);
    PL.drawFit(doc, 'No data on file.', pg.margin, pg.y, pg.contentW, { font: F(doc, 'body'), size: 8.5, color: C.muted });
    pg.advance(20);
    return;
  }
  const w = pg.contentW - 20;
  const pieces = [];
  keys.forEach((k) => {
    fieldPieces(doc, k, formatVal(obj[k], 3200), w, { labelSize: 7.2, valueSize: 7.6 })
      .forEach((p) => pieces.push(p));
  });
  emitPanel(pg, pieces, { fill: C.panel, stroke: '#CCD6E8', radius: 7, pad: 10 });
}

function renderDailyTable(pg, rows) {
  const doc = pg.doc;
  const header = ['Date', 'Steps', 'Water ml', 'Protein g', 'Sleep h'];
  blockTitle(pg, 'Daily check-ins — complete log (every row)');
  if (!rows.length) {
    pg.ensure(24);
    PL.drawFit(doc, 'No daily check-ins this month.', pg.margin, pg.y, pg.contentW, { font: F(doc, 'body'), size: 9, color: C.muted });
    pg.advance(20);
    return;
  }
  const cw = pg.contentW / 5 - 4;
  const drawHeader = () => {
    header.forEach((h, i) => PL.drawFit(doc, h, pg.margin + i * (cw + 4), pg.y, cw,
      { font: F(doc, 'semi'), size: 7, color: C.text }));
    pg.advance(14);
    doc.moveTo(pg.margin, pg.y).lineTo(pg.margin + pg.contentW, pg.y).strokeColor(C.grid).lineWidth(0.4).stroke();
    pg.advance(6);
  };
  pg.ensure(40);
  drawHeader();
  rows.forEach((r) => {
    const line = [
      String(r.checkin_date || '—').slice(0, 12),
      r.steps != null ? String(r.steps) : '—',
      r.water_ml != null ? String(r.water_ml) : '—',
      r.protein_g != null ? String(r.protein_g) : '—',
      r.sleep_hours != null ? String(r.sleep_hours) : '—'
    ];
    const h = 13;
    if (pg.ensure(h + 4)) drawHeader();
    // Each cell is fitted to its fifth of the row, so a large step count
    // shrinks rather than running into the column beside it.
    line.forEach((cell, i) => PL.drawFit(doc, cell, pg.margin + i * (cw + 4), pg.y, cw,
      { font: F(doc, 'body'), size: 7.2, minSize: 5, color: C.text }));
    pg.advance(h + 4);
  });
  pg.advance(8);
}

function renderProgressTable(pg, rows) {
  const doc = pg.doc;
  blockTitle(pg, 'Progress logs — complete log (every field)');
  if (!rows.length) {
    pg.ensure(24);
    PL.drawFit(doc, 'No progress_logs this month.', pg.margin, pg.y, pg.contentW, { font: F(doc, 'body'), size: 9, color: C.muted });
    pg.advance(20);
    return;
  }
  const w = pg.contentW - 20;
  rows.forEach((r, idx) => {
    const keys = Object.keys(r).filter((k) => !['user_id', 'id'].includes(k));
    const pieces = [];
    keys.forEach((k) => {
      fieldPieces(doc, k, formatVal(r[k], 1500), w, { labelSize: 6.9, valueSize: 7.2, lineGap: 1.5 })
        .forEach((p) => pieces.push(p));
    });
    emitPanel(pg, pieces, { fill: '#F8FAFF', stroke: '#CCD6E8', radius: 6, pad: 10 },
      (cont) => `Entry ${idx + 1}${cont ? ' (continued)' : ''}`);
  });
}

function renderSundayFull(pg, rows) {
  const doc = pg.doc;
  blockTitle(pg, 'Sunday check-ins — all fields per submission');
  if (!rows.length) {
    pg.ensure(24);
    PL.drawFit(doc, 'No Sunday check-ins this month.', pg.margin, pg.y, pg.contentW, { font: F(doc, 'body'), size: 9, color: C.muted });
    pg.advance(20);
    return;
  }
  const fields = [
    'full_name', 'reply_email', 'plan', 'current_weight_waist_week', 'last_week_weight_waist',
    'total_weight_loss', 'training_go', 'nutrition_go', 'sleep', 'occupation_stress',
    'other_stress', 'differences_felt', 'achievements', 'improve_next_week', 'questions',
    'body_fat_percent', 'created_at'
  ];
  const w = pg.contentW - 20;
  rows.forEach((r, idx) => {
    const pieces = [];
    fields.forEach((k) => {
      fieldPieces(doc, k, formatVal(r[k], 2800), w, { labelSize: 6.8, valueSize: 7.2 })
        .forEach((p) => pieces.push(p));
    });
    emitPanel(pg, pieces, { fill: '#FFFEF8', stroke: '#E8DFC8', radius: 7, pad: 10 },
      (cont) => `Sunday #${idx + 1} · ${formatDate(r.created_at)}${cont ? ' (continued)' : ''}`);
  });
}

function renderWorkoutsFull(pg, rows) {
  const doc = pg.doc;
  blockTitle(pg, 'My Workout sessions — complete fields (incl. session_lifts)');
  if (!rows.length) {
    pg.ensure(24);
    PL.drawFit(doc, 'No My Workout rows this month.', pg.margin, pg.y, pg.contentW, { font: F(doc, 'body'), size: 9, color: C.muted });
    pg.advance(20);
    return;
  }
  const w = pg.contentW - 20;
  rows.forEach((r, idx) => {
    const keys = Object.keys(r).filter((k) => !['user_id'].includes(k));
    const pieces = [];
    keys.forEach((k) => {
      fieldPieces(doc, k, formatVal(r[k], 4000), w, { labelSize: 6.8, valueSize: 7.1, lineGap: 1.5 })
        .forEach((p) => pieces.push(p));
    });
    emitPanel(pg, pieces, { fill: '#F5FAF7', stroke: '#C5D9CC', radius: 7, pad: 10 },
      (cont) => `Session ${idx + 1} · ${formatDate(r.created_at || r.session_date)}${cont ? ' (continued)' : ''}`);
  });
}

function renderGoalsHydrationWeight(pg, data) {
  const doc = pg.doc;
  blockTitle(pg, 'Platform goals · hydration · weight_logs (reporting month)');
  const goals = data.userGoals || [];
  if (goals.length) {
    goals.forEach((g, i) => {
      const line = `Goal record ${i + 1}: Target weight: ${g.target_weight ?? '—'} · BF%: ${g.target_body_fat ?? '—'}`
        + ` · Weekly workouts: ${g.weekly_workout_target ?? '—'} · Set: ${formatDate(g.created_at)}`;
      const L = PL.layout(doc, line, { font: F(doc, 'body'), size: 7.6, width: pg.contentW - 20, lineGap: 2 });
      emitPanel(pg, linePieces(doc, L, { color: C.text }), { fill: '#F0F7FF', stroke: '#B8C2D6', radius: 5, pad: 6 });
    });
  } else {
    pg.ensure(22);
    PL.drawFit(doc, 'No user_goals rows.', pg.margin, pg.y, pg.contentW, { font: F(doc, 'body'), size: 8, color: C.muted });
    pg.advance(18);
  }

  const hyd = data.hydrationLogs || [];
  if (hyd.length) {
    pg.ensure(28);
    PL.drawFit(doc, 'Hydration logs', pg.margin, pg.y, pg.contentW, { font: F(doc, 'semi'), size: 8, color: C.goldDark });
    pg.advance(14);
    hyd.forEach((hrow) => {
      const line = `${formatDate(hrow.created_at)} · ${hrow.amount_ml ?? '—'} ml · glasses: ${hrow.glasses ?? '—'}`;
      pg.ensure(14);
      PL.drawFit(doc, line, pg.margin + 8, pg.y, pg.contentW - 16, { font: F(doc, 'body'), size: 7.4, minSize: 5.5, color: C.text });
      pg.advance(12);
    });
    pg.advance(4);
  }

  const wl = data.weightLogs || [];
  if (wl.length) {
    pg.ensure(26);
    PL.drawFit(doc, 'Dedicated weight_logs', pg.margin, pg.y, pg.contentW, { font: F(doc, 'semi'), size: 8, color: C.goldDark });
    pg.advance(14);
    wl.forEach((wrow) => {
      const line = `${formatDate(wrow.created_at)} · ${wrow.weight_kg != null ? wrow.weight_kg + ' kg' : '—'}`;
      pg.ensure(16);
      PL.drawFit(doc, line, pg.margin + 8, pg.y, pg.contentW - 16, { font: F(doc, 'body'), size: 7.4, minSize: 5.5, color: C.text });
      pg.advance(14);
    });
  }
  pg.advance(8);
}

function renderMeetingsOnly(pg, data) {
  const doc = pg.doc;
  blockTitle(pg, 'Meetings (month window)');
  const mtg = data.meetings || [];
  if (!mtg.length) {
    pg.ensure(22);
    PL.drawFit(doc, 'No meetings in this month.', pg.margin, pg.y, pg.contentW, { font: F(doc, 'body'), size: 8, color: C.muted });
    pg.advance(16);
    return;
  }
  mtg.forEach((m) => {
    const line = `${m.meeting_date || '—'} ${m.time_slot || ''} · ${m.status || ''}`
      + `${m.notes ? ' · ' + formatVal(m.notes, 1200) : ''}`;
    const L = PL.layout(doc, line, { font: F(doc, 'body'), size: 7.4, width: pg.contentW - 16, lineGap: 2 });
    emitPanel(pg, linePieces(doc, L, { color: C.text }), { fill: '#F7F5FF', stroke: '#D4CCE8', radius: 5, pad: 6 });
  });
}

function renderProgramsTribe(pg, data) {
  const doc = pg.doc;
  blockTitle(pg, 'Assigned programs & tribe snapshot');
  const programs = data.programs || [];
  programs.forEach((p, i) => {
    const line = `${i === 0 ? '★ CURRENT · ' : ''}${p.program_name || '—'} · assigned ${p.assigned_at ? formatDate(p.assigned_at) : '—'}`;
    const L = PL.layout(doc, line, { font: F(doc, 'body'), size: 7.8, width: pg.contentW, lineGap: 1.5 });
    L.lines.forEach((ln) => {
      pg.ensure(L.lineHeight);
      const single = {
        lines: [ln], lineHeight: L.lineHeight, height: L.lineHeight,
        font: L.font, size: L.size, lineGap: L.lineGap, width: L.width, align: L.align
      };
      PL.drawLayout(doc, single, pg.margin, pg.y, { color: C.text });
      pg.advance(L.lineHeight);
    });
    pg.advance(4);
  });

  const t = data.tribeMember;
  if (t) {
    const lines = [
      `Tribe · ${t.status || '—'} · Phase ${t.phase ?? '—'} · Started ${t.start_date || '—'} · Activity/wk: ${t.activity_per_week ?? '—'}`,
      `Weight ${t.starting_weight ?? '—'} -> ${t.current_weight ?? '—'} (target ${t.target_weight ?? '—'}) · Next check-in: ${t.next_checkin || '—'}`
    ];
    if (t.notes) lines.push(`Notes: ${formatVal(t.notes, 1500)}`);
    const pieces = [];
    lines.forEach((line) => {
      const L = PL.layout(doc, line, { font: F(doc, 'body'), size: 7.6, width: pg.contentW - 20, lineGap: 2 });
      linePieces(doc, L, { color: C.text }).forEach((p) => pieces.push(p));
      pieces.push({ h: 3, draw: () => {} });
    });
    emitPanel(pg, pieces, { fill: '#F2FFF6', stroke: '#9DCDB8', radius: 7, pad: 10 });
  }
  pg.advance(8);
}

/**
 * @param {object} aiNarrative — { executive_summary, sections: { onboarding_audit, ... } }
 */
function renderLuxuryDetailSections(doc, ctx) {
  const {
    margin,
    contentW,
    data,
    aiNarrative,
    performanceLines,
    insightTags,
    docId,
    startY,
    letterRest
  } = ctx;

  const pg = createPaginator(doc, margin, contentW, docId).start(startY);

  /* The executive narrative that did not fit its box on the summary page. It is
     printed first, at the same measure and size, so the letter reads straight
     on — the summary page never cuts a coach's narrative short. */
  if (letterRest && letterRest.lines && letterRest.lines.length) {
    const pad = Math.max(8, (contentW - letterRest.width) / 2);
    emitPanel(pg, linePieces(doc, letterRest, { color: C.text }),
      { fill: '#FFFCF5', stroke: C.gold, radius: 10, pad },
      () => 'FROM THE COACHING DESK · CONTINUED');
    pg.advance(4);
  }
  const secRaw = (aiNarrative && aiNarrative.sections) || {};
  const sec = Object.assign({}, secRaw, { meetings: secRaw.meetings || secRaw.meetings_messages });

  /* Engine snapshot (lifetime) */
  blockTitle(pg, 'Progress engine — cumulative signals');
  const metricsTextW = contentW - 24;
  const snapshot = [];
  const introL = PL.layout(doc, 'Lifetime / merged analytics (not limited to this month).', {
    font: F(doc, 'body'), size: 7.4, width: metricsTextW, lineGap: 1.5
  });
  linePieces(doc, introL, { color: C.muted }).forEach((p) => snapshot.push(p));
  snapshot.push({ h: 6, draw: () => {} });
  bulletPieces(doc, (performanceLines || []).slice(0, 12), metricsTextW, 7.6, C.text).forEach((p) => snapshot.push(p));
  if ((insightTags || []).length) {
    const tagHeadL = PL.layout(doc, 'Engine insight tags', { font: F(doc, 'semi'), size: 7.8, width: metricsTextW });
    snapshot.push({ h: 6, draw: () => {} });
    linePieces(doc, tagHeadL, { color: C.goldDark }).forEach((p) => snapshot.push(p));
    bulletPieces(doc, insightTags.slice(0, 12), metricsTextW, 7.6, C.emerald).forEach((p) => snapshot.push(p));
  }
  emitPanel(pg, snapshot, { fill: C.panel, stroke: '#B8C2D6', radius: 8, pad: 12 });
  pg.advance(4);

  /* Onboarding audit */
  drawProsConsBlock(pg, 'Section 1 · Onboarding audit', sec.onboarding_audit);
  blockTitle(pg, 'Onboarding audit — all submitted fields');
  if (data.audit) {
    renderKeyValueObject(pg, data.audit);
  } else {
    pg.ensure(22);
    PL.drawFit(doc, 'No onboarding audit on file.', margin, pg.y, contentW, { font: F(doc, 'body'), size: 8.5, color: C.muted });
    pg.advance(20);
  }

  /* Part 2 */
  drawProsConsBlock(pg, 'Section 2 · Part-2 deep intake', sec.part2_intake);
  blockTitle(pg, 'Part-2 intake — all fields');
  if (data.part2) {
    renderKeyValueObject(pg, data.part2);
  } else {
    pg.ensure(22);
    PL.drawFit(doc, 'No Part-2 submission.', margin, pg.y, contentW, { font: F(doc, 'body'), size: 8.5, color: C.muted });
    pg.advance(20);
  }

  /* Tribe + programs early */
  drawProsConsBlock(pg, 'Section 3 · Tribe & programs', sec.tribe_programs);
  renderProgramsTribe(pg, data);

  drawProsConsBlock(pg, 'Section 4 · Daily telemetry', sec.daily_checkins);
  renderDailyTable(pg, data.dailyCheckins || []);

  drawProsConsBlock(pg, 'Section 5 · Progress logs', sec.progress_logs);
  renderProgressTable(pg, data.progressLogs || []);

  drawProsConsBlock(pg, 'Section 6 · Sunday check-ins', sec.sunday_checkins);
  renderSundayFull(pg, data.sundayCheckins || []);

  drawProsConsBlock(pg, 'Section 7 · My Workout', sec.workouts);
  renderWorkoutsFull(pg, data.workouts || []);

  drawProsConsBlock(pg, 'Section 8 · Goals · hydration · weight', sec.hydration_weight_goals);
  renderGoalsHydrationWeight(pg, data);

  drawProsConsBlock(pg, 'Section 9 · Meetings', sec.meetings);
  renderMeetingsOnly(pg, data);

  pg.drawFooter();
}

module.exports = {
  renderLuxuryDetailSections,
  createPaginator,
  measureBulletsHeight,
  addBulletList,
  drawWatermark
};
