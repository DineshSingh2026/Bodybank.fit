'use strict';

/**
 * BodyBank — the shared PDF layout kernel.
 *
 * ===========================================================================
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * ===========================================================================
 * No line of text in any BodyBank PDF may leave the box it was drawn into.
 *
 * Every overflow we have ever shipped came from one of four mistakes, and this
 * module removes all four by construction:
 *
 *  1. MEASURE/DRAW MISMATCH — a block measured at 10pt over `w - 20` but drawn
 *     at 9pt over `w - 12`, or measured as one font and drawn as two. The box
 *     was sized from the measurement, so the drawing spilled out of it.
 *     -> `measure()` and `drawText()` share one wrap routine, so a height taken
 *        from `measure()` is the height `drawText()` will occupy. Exactly.
 *
 *  2. `lineBreak: false` DOES NOT DO WHAT THE WHOLE CODEBASE ASSUMED.
 *     PDFKit only skips its line wrapper when `options.width` is ABSENT
 *     (pdfkit.js `_text`: `if (options.width) { ...LineWrapper... }`). The
 *     ubiquitous `{ width: w, lineBreak: false }` therefore still wraps — and
 *     a wrapped line past the bottom margin still adds a page. That is how a
 *     long member name put a second footer line below the edge of the paper.
 *     With no width at all it does not wrap, but then nothing clips it either
 *     and it simply runs off the side. Both spellings overflow.
 *     -> `fitText()` shrinks then ellipsizes until the string genuinely
 *        measures within its column, and `drawSingle()` draws it with NO
 *        width, so the wrapper is never constructed. Alignment inside the
 *        column is computed here instead of being delegated to PDFKit.
 *
 *  3. PDFKit PAGINATES BEHIND THE FLOW'S BACK. A `text()` that runs past the
 *     bottom margin silently calls addPage(). The renderer's own `y` cursor
 *     does not know, so the next block draws at a stale coordinate, and the
 *     page it created never receives a background or a footer.
 *     -> Every draw in this module goes through `drawSingle()`, which never
 *        gives PDFKit a width and therefore can never trigger a page break.
 *        `createFlow()` additionally listens for `pageAdded` and
 *        resynchronises if anything else triggers one.
 *
 *  4. BREAKING A PAGE THAT IS ALREADY EMPTY. `if (y + need > BOTTOM) newPage()`
 *     run on a fresh page produces a blank page and tries again — the origin of
 *     the empty pages in the monthly performance report.
 *     -> `flow.ensure()` refuses to break a page nothing has been drawn on, and
 *        oversized blocks are split rather than pushed.
 *
 * Nothing here formats, rounds or interprets a value. It measures strings and
 * moves a cursor; the reports keep every bit of their own logic.
 */

const { txt, hasText } = require('./pdfText');

/** Appended when a single line has to be cut. WinAnsi-safe (U+2026 is in WinAnsi). */
const ELLIPSIS = '…';

/** Widest word-space stretch we will accept before abandoning justification. */
const MAX_WORD_SPACING = 5;

// ---------------------------------------------------------------------------
// Font handling
// ---------------------------------------------------------------------------

/**
 * Apply font + size to the document, tolerating a font name the document has
 * not registered (a report that ships Inter but falls back to Helvetica).
 */
function applyFont(doc, font, size) {
  if (font) {
    try { doc.font(font); } catch (_) { /* keep the current face */ }
  }
  if (size != null) doc.fontSize(size);
  return doc;
}

/** Line advance for the current font/size, matching PDFKit's own wrap engine. */
function lineAdvance(doc, lineGap) {
  return doc.currentLineHeight(true) + (lineGap || 0);
}

/**
 * Put ONE line on the page with PDFKit's wrapper switched off for real.
 *
 * Omitting `width` is the switch: `_text` only builds a LineWrapper when a
 * width is present, so without one PDFKit draws the fragment where we put it
 * and never wraps, never justifies for us and — the part that matters — never
 * adds a page. Alignment within the notional column is therefore ours to do,
 * which is what `align` + `width` mean here: they position the line, they do
 * not constrain it. The caller is responsible for having fitted the string
 * first (see `fitText`); this function trusts it.
 */
function drawSingle(doc, s, x, y, width, opts) {
  const o = opts || {};
  if (s === '' || s == null) return;
  const drawOpts = { lineBreak: false };
  if (o.characterSpacing) drawOpts.characterSpacing = o.characterSpacing;
  if (o.wordSpacing) drawOpts.wordSpacing = o.wordSpacing;
  if (o.link) drawOpts.link = o.link;
  let dx = x;
  const align = o.align || 'left';
  if (width > 0 && (align === 'center' || align === 'right')) {
    const w = doc.widthOfString(s, drawOpts);
    dx = align === 'center' ? x + (width - w) / 2 : x + (width - w);
    // An align that would push the line left of its own column means the line
    // is wider than the column; keep it pinned to the column instead.
    if (dx < x) dx = x;
  }
  doc.text(s, dx, y, drawOpts);
}

// ---------------------------------------------------------------------------
// Single-line fitting — the answer to `lineBreak: false`
// ---------------------------------------------------------------------------

/**
 * Cut `s` down until it measures within `width`, ending in an ellipsis.
 * Assumes the caller has already applied the font and size.
 */
function ellipsize(doc, s, width, opts) {
  const o = opts || undefined;
  if (doc.widthOfString(s, o) <= width) return s;
  // Nothing sensible fits: give back the ellipsis alone (or nothing at all).
  if (doc.widthOfString(ELLIPSIS, o) > width) return '';
  let lo = 0;
  let hi = s.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (doc.widthOfString(s.slice(0, mid).trimEnd() + ELLIPSIS, o) <= width) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return s.slice(0, best).trimEnd() + ELLIPSIS;
}

/**
 * The single most important function in this file.
 *
 * Returns a string AND the size it must be drawn at, such that the result is
 * guaranteed to measure within `width`. Shrinking is tried first (down to
 * `minSize`, by default 88% of the requested size) because a slightly smaller
 * name reads better than a truncated one; only then is the string cut.
 *
 * @returns {{text: string, size: number, shrunk: boolean, clipped: boolean}}
 */
function fitText(doc, text, width, opts) {
  const o = opts || {};
  const size = o.size == null ? doc._fontSize : o.size;
  const measureOpts = o.characterSpacing ? { characterSpacing: o.characterSpacing } : undefined;
  const s = txt(text);
  applyFont(doc, o.font, size);
  if (!s) return { text: '', size, shrunk: false, clipped: false };
  if (!(width > 0)) return { text: '', size, shrunk: false, clipped: true };
  if (doc.widthOfString(s, measureOpts) <= width) return { text: s, size, shrunk: false, clipped: false };

  const floor = o.minSize == null ? Math.max(5.5, size * 0.88) : o.minSize;
  // Try progressively smaller sizes in 0.25pt steps — small enough that the
  // step is invisible next to its neighbours, coarse enough to stay cheap.
  for (let trial = size - 0.25; trial >= floor; trial -= 0.25) {
    doc.fontSize(trial);
    if (doc.widthOfString(s, measureOpts) <= width) {
      return { text: s, size: trial, shrunk: true, clipped: false };
    }
  }
  doc.fontSize(floor);
  const cut = ellipsize(doc, s, width, measureOpts);
  doc.fontSize(size);
  return { text: cut, size: floor, shrunk: floor < size, clipped: true };
}

/**
 * Draw exactly one line that cannot leave `width`.
 * `align` is honoured inside the given width ('left' | 'center' | 'right').
 * @returns {number} the height the line occupies
 */
function drawFit(doc, text, x, y, width, opts) {
  const o = opts || {};
  const fitted = fitText(doc, text, width, o);
  if (!fitted.text) return 0;
  applyFont(doc, o.font, fitted.size);
  if (o.color) doc.fillColor(o.color);
  drawSingle(doc, fitted.text, x, y, width, o);
  return lineAdvance(doc, 0);
}

// ---------------------------------------------------------------------------
// Wrapping — one routine used by both measurement and drawing
// ---------------------------------------------------------------------------

/** Split a word that cannot fit on a line of its own (a URL, a long ID). */
function breakWord(doc, word, width) {
  const out = [];
  let cur = '';
  for (const ch of word) {
    const cand = cur + ch;
    if (cur && doc.widthOfString(cand) > width) { out.push(cur); cur = ch; }
    else cur = cand;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/**
 * Greedy wrap. The caller must have applied the font and size already.
 * Blank source lines are preserved so paragraph spacing survives.
 * @returns {string[]}
 */
function wrapLines(doc, text, width) {
  const s = txt(text);
  const out = [];
  if (!(width > 0)) return out;
  s.split(/\r?\n/).forEach((para) => {
    const words = para.split(/\s+/).filter((w) => w.length);
    if (!words.length) { out.push(''); return; }
    let line = '';
    words.forEach((w) => {
      const cand = line ? line + ' ' + w : w;
      if (doc.widthOfString(cand) <= width) { line = cand; return; }
      if (line) out.push(line);
      if (doc.widthOfString(w) > width) {
        const pieces = breakWord(doc, w, width);
        for (let i = 0; i < pieces.length - 1; i += 1) out.push(pieces[i]);
        line = pieces[pieces.length - 1];
      } else {
        line = w;
      }
    });
    if (line) out.push(line);
  });
  return out;
}

/**
 * Lay a block out without drawing it. The returned object is what `drawLayout`
 * consumes, so a caller that sizes a box from `layout.height` and then draws
 * that same layout into it cannot be wrong.
 */
function layout(doc, text, opts) {
  const o = opts || {};
  const size = o.size == null ? doc._fontSize : o.size;
  const lineGap = o.lineGap || 0;
  const width = o.width;
  applyFont(doc, o.font, size);
  const fontName = doc._font && (doc._font.name || doc._font.filename);
  let lines = wrapLines(doc, text, width);
  const lineHeight = lineAdvance(doc, lineGap);
  let truncated = false;
  // A ceiling turns an unbounded block into a bounded one: keep whole lines and
  // mark the last one, rather than letting the tail escape the container.
  const cap = [];
  if (o.maxHeight != null && lineHeight > 0) cap.push(Math.max(0, Math.floor((o.maxHeight + 0.01) / lineHeight)));
  if (o.maxLines != null) cap.push(o.maxLines);
  if (cap.length) {
    const maxLines = Math.min.apply(null, cap);
    if (lines.length > maxLines) {
      truncated = true;
      lines = lines.slice(0, maxLines);
      if (lines.length) {
        const last = lines[lines.length - 1];
        lines[lines.length - 1] = ellipsize(doc, last + ' ', width) || last;
      }
    }
  }
  return {
    lines,
    lineHeight,
    height: lines.length * lineHeight,
    font: o.font || fontName,
    size,
    lineGap,
    width,
    align: o.align || 'left',
    truncated
  };
}

/** Height of `text` as `drawText` will draw it. Never an estimate. */
function measure(doc, text, opts) {
  return layout(doc, text, opts).height;
}

/**
 * Draw a prepared layout at (x, y). Each line goes out with `lineBreak: false`,
 * so PDFKit can never decide to add a page on our behalf.
 * @returns {number} height drawn
 */
function drawLayout(doc, L, x, y, opts) {
  const o = opts || {};
  if (!L.lines.length) return 0;
  const color = o.color;
  const align = o.align || L.align || 'left';
  const justify = align === 'justify';
  let cy = y;
  L.lines.forEach((line, i) => {
    if (line !== '') {
      applyFont(doc, L.font, L.size);
      if (color) doc.fillColor(color);
      const drawOpts = { align: justify ? 'left' : align };
      // Justify by stretching the word gaps, but only while the stretch stays
      // subtle. Beyond that the line looks worse justified than ragged. The
      // last line of a block is never stretched.
      if (justify && i < L.lines.length - 1) {
        const words = line.split(' ').length - 1;
        if (words > 0) {
          const slack = L.width - doc.widthOfString(line);
          const ws = slack / words;
          if (ws > 0.05 && ws <= MAX_WORD_SPACING) drawOpts.wordSpacing = ws;
        }
      }
      drawSingle(doc, line, x, cy, L.width, drawOpts);
    }
    cy += L.lineHeight;
  });
  return L.lines.length * L.lineHeight;
}

/**
 * Measure-and-draw in one call for the common case.
 * @returns {number} height drawn
 */
function drawText(doc, text, x, y, opts) {
  const L = layout(doc, text, opts);
  return drawLayout(doc, L, x, y, opts);
}

// ---------------------------------------------------------------------------
// Mixed-font runs — "**Marker** — reason" on one flowing block
// ---------------------------------------------------------------------------

/**
 * Reports repeatedly draw a bold lead-in followed by muted detail using
 * PDFKit's `continued: true`, but measure the concatenation in a single font.
 * The measurement is then wrong in both directions and the box is wrong with
 * it. `richLayout` wraps the run with each segment measured in its own face.
 *
 * @param {Array<{text:string, font?:string, size?:number, color?:string}>} segments
 */
function richLayout(doc, segments, width, opts) {
  const o = opts || {};
  const lineGap = o.lineGap || 0;
  const segs = (Array.isArray(segments) ? segments : []).filter(function (s) { return s && hasText(s.text); });

  // Tokenise into words that each remember the face they belong to.
  const tokens = [];
  segs.forEach(function (seg) {
    txt(seg.text).split(/(\s+)/).forEach(function (p) {
      if (!p) return;
      if (/^\s+$/.test(p)) { tokens.push({ space: true, seg: seg }); return; }
      tokens.push({ text: p, seg: seg });
    });
  });

  const widthOf = function (tok) {
    applyFont(doc, tok.seg.font, tok.seg.size);
    return doc.widthOfString(tok.space ? ' ' : tok.text);
  };
  const heightOf = function (seg) {
    applyFont(doc, seg.font, seg.size);
    return doc.currentLineHeight(true);
  };

  const lines = [];
  let cur = [];
  let curW = 0;
  const flush = function () {
    // Trailing spaces never count toward a line's width.
    while (cur.length && cur[cur.length - 1].space) cur.pop();
    if (cur.length) lines.push(cur);
    cur = [];
    curW = 0;
  };

  tokens.forEach(function (tok) {
    const w = widthOf(tok);
    if (tok.space) {
      if (!cur.length) return;           // no leading spaces on a wrapped line
      cur.push({ space: true, seg: tok.seg, w: w });
      curW += w;
      return;
    }
    if (curW + w > width && cur.length) flush();
    if (w > width) {
      // A single unbreakable token wider than the column: split it by character
      // so it wraps instead of running past the edge.
      applyFont(doc, tok.seg.font, tok.seg.size);
      const pieces = breakWord(doc, tok.text, width);
      pieces.forEach(function (piece, i) {
        applyFont(doc, tok.seg.font, tok.seg.size);
        const pw = doc.widthOfString(piece);
        cur.push({ text: piece, seg: tok.seg, w: pw });
        curW += pw;
        if (i < pieces.length - 1) flush();
      });
      return;
    }
    cur.push({ text: tok.text, seg: tok.seg, w: w });
    curW += w;
  });
  flush();

  const lineHeights = lines.map(function (ln) {
    return ln.reduce(function (m, t) { return Math.max(m, heightOf(t.seg)); }, 0) + lineGap;
  });
  let kept = lines;
  let keptH = lineHeights;
  let truncated = false;
  if (o.maxHeight != null) {
    let acc = 0;
    let n = 0;
    while (n < lineHeights.length && acc + lineHeights[n] <= o.maxHeight + 0.01) { acc += lineHeights[n]; n += 1; }
    if (n < lines.length) { truncated = true; kept = lines.slice(0, n); keptH = lineHeights.slice(0, n); }
  }
  return {
    lines: kept,
    lineHeights: keptH,
    height: keptH.reduce(function (a, b) { return a + b; }, 0),
    lineGap: lineGap,
    width: width,
    truncated: truncated
  };
}

/** Draw a rich run laid out by `richLayout`. @returns {number} height drawn */
function drawRich(doc, L, x, y) {
  let cy = y;
  L.lines.forEach(function (line, li) {
    let cx = x;
    line.forEach(function (tok) {
      const seg = tok.seg;
      applyFont(doc, seg.font, seg.size);
      if (seg.color) doc.fillColor(seg.color);
      const s = tok.space ? ' ' : tok.text;
      // The remaining width is a hard stop: a token is dropped rather than
      // drawn past the right edge of the run, even if the layout above were
      // somehow wrong.
      if (cx + tok.w <= x + L.width + 0.01) drawSingle(doc, s, cx, cy, 0, {});
      cx += tok.w;
    });
    cy += L.lineHeights[li];
  });
  return L.height;
}

/** Measure + draw a rich run. @returns {number} height drawn */
function drawRichText(doc, segments, x, y, width, opts) {
  return drawRich(doc, richLayout(doc, segments, width, opts), x, y);
}

// ---------------------------------------------------------------------------
// Diagonal watermark
// ---------------------------------------------------------------------------

/**
 * Ghosted diagonal wordmark, guaranteed to land on the paper.
 *
 * Two things used to go wrong with the hand-rolled version in each dossier:
 * it was drawn through `doc.text()` with a width (so PDFKit could wrap it and,
 * at the foot of a page, add one), and its anchors were guessed, so the last
 * repetition ran off the right edge and below the sheet.
 *
 * Here the rotated bounding box is computed from the real string metrics and
 * the anchors are placed inside what is left of the page, shrinking the type
 * if even one repetition will not fit.
 *
 * @param {object} opts {text, angle (degrees, default 28 up-to-the-right),
 *   size, font, color, opacity, count}
 */
function diagonalWatermark(doc, opts) {
  const o = opts || {};
  const s = txt(o.text == null ? 'CONFIDENTIAL' : o.text);
  if (!s) return;
  const font = o.font || 'Helvetica-Bold';
  const count = Math.max(1, o.count == null ? 3 : o.count);
  const deg = -(o.angle == null ? 28 : o.angle);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const pw = doc.page.width;
  const ph = doc.page.height;

  // Shrink until one repetition's rotated box fits the sheet.
  let size = o.size == null ? 48 : o.size;
  let w = 0;
  let h = 0;
  for (;;) {
    applyFont(doc, font, size);
    w = doc.widthOfString(s);
    h = doc.currentLineHeight(true);
    if ((cos * w + sin * h) <= pw && (sin * w + cos * h) <= ph) break;
    if (size <= 10) return;                   // nothing sensible will fit
    size -= 2;
  }

  // Anchor limits, derived from where the rotated quad's corners land.
  const spanX = cos * w + sin * h;
  const above = sin * w;                      // the run rises to the right
  const below = cos * h;
  const axMin = 4;
  const axMax = Math.max(axMin, pw - spanX - 4);
  const ayMin = above + 4;
  const ayMax = Math.max(ayMin, ph - below - 4);

  doc.save();
  doc.opacity(o.opacity == null ? 0.035 : o.opacity);
  doc.fillColor(o.color || '#D4AF37');
  applyFont(doc, font, size);
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const ax = axMin + (axMax - axMin) * t;
    const ay = ayMin + (ayMax - ayMin) * t;
    doc.save();
    doc.rotate(deg, { origin: [ax, ay] });
    drawSingle(doc, s, ax, ay, 0, {});        // no width: never wraps, never paginates
    doc.restore();
  }
  doc.opacity(1);
  doc.restore();
}

// ---------------------------------------------------------------------------
// The page flow
// ---------------------------------------------------------------------------

/**
 * A vertical cursor that owns pagination.
 *
 * @param {PDFDocument} doc
 * @param {object} geom {top, bottom, left, width, onPage?(doc, flow), trackPages?}
 *   `onPage` runs for every page the flow opens AND for any page PDFKit opens
 *   on its own, so a background can never be missed.
 */
function createFlow(doc, geom) {
  const g = geom || {};
  const top = g.top == null ? 70 : g.top;
  const bottom = g.bottom == null ? 780 : g.bottom;

  const flow = {
    doc: doc,
    y: top,
    top: top,
    bottom: bottom,
    left: g.left == null ? 51 : g.left,
    width: g.width == null ? 493 : g.width,
    /** Page indexes that carry content and therefore deserve chrome. */
    pages: new Set(),
    /** True once anything has been drawn on the current page. */
    dirty: false,

    /** Room left on the current page. */
    room: function () { return bottom - flow.y; },
    /**
     * Nothing has been drawn on this page yet.
     *
     * Both signals count. `dirty` is set by `advance()`, but renderers that
     * move the cursor with a plain `ctx.y += h` would otherwise still look
     * fresh, so a cursor that has left the top of the page counts as ink too.
     */
    isFresh: function () { return !flow.dirty && flow.y <= flow.top + 0.5; },
    /** Record that the cursor has produced ink, so the page is no longer blank. */
    touch: function () { flow.dirty = true; return flow; },

    index: function () { return doc.bufferedPageRange().count - 1; },

    newPage: function () {
      doc.addPage();      // `pageAdded` below does the bookkeeping
      return flow;
    },

    /**
     * Guarantee `need` points of room.
     *
     * Two refusals matter, and both exist to stop blank pages:
     *   - a page nothing has been drawn on is never broken (breaking it would
     *     leave it empty and solve nothing);
     *   - a block taller than a whole page is not pushed to the next page,
     *     because it would not fit there either — the caller is expected to
     *     split it, and `fitBlock` below tells it how much room it really has.
     */
    ensure: function (need) {
      const want = need == null ? 0 : need;
      if (flow.y + want <= bottom) return false;
      if (flow.isFresh()) return false;
      flow.newPage();
      return true;
    },

    /**
     * Start a new page only if the current one already carries content.
     * Used where a section wants to open at the top of a page.
     */
    sectionBreak: function () {
      if (!flow.isFresh()) flow.newPage();
      return flow;
    },

    /** The tallest block that can start here, after an `ensure`. */
    fitBlock: function (need) {
      flow.ensure(need);
      return Math.min(need, bottom - flow.y);
    },

    /** Advance the cursor and mark the page as carrying content. */
    advance: function (h) {
      if (h > 0) flow.dirty = true;
      flow.y += h;
      return flow;
    },

    /** Full page height available to content. */
    pageHeight: function () { return bottom - top; }
  };

  const register = function () {
    flow.y = top;
    flow.dirty = false;
    const idx = doc.bufferedPageRange().count - 1;
    if (g.trackPages !== false) flow.pages.add(idx);
    if (typeof g.onPage === 'function') g.onPage(doc, flow);
  };

  doc.on('pageAdded', register);

  // Page 1 already exists when the flow is created.
  if (g.trackPages !== false && g.claimFirstPage !== false) {
    flow.pages.add(doc.bufferedPageRange().count - 1);
  }

  return flow;
}

/**
 * Write a wrapped block through a flow, breaking pages between lines so a long
 * narrative never runs into the footer and never leaves a page half-drawn.
 *
 * @returns {number} total height consumed
 */
function flowText(flow, text, opts) {
  const o = opts || {};
  const doc = flow.doc;
  const x = o.x == null ? flow.left : o.x;
  const width = o.width == null ? flow.width : o.width;
  const lo = {};
  Object.keys(o).forEach(function (k) { lo[k] = o[k]; });
  lo.width = width;
  const L = layout(doc, text, lo);
  if (!L.lines.length) {
    if (o.spaceAfter) flow.advance(o.spaceAfter);
    return 0;
  }
  let drawn = 0;
  L.lines.forEach(function (line, i) {
    flow.ensure(L.lineHeight);
    const single = {
      lines: [line], lineHeight: L.lineHeight, height: L.lineHeight,
      font: L.font, size: L.size, lineGap: L.lineGap, width: L.width, align: L.align
    };
    const isLast = i === L.lines.length - 1;
    drawLayout(doc, single, x, flow.y, {
      color: o.color,
      align: (o.align === 'justify' && isLast) ? 'left' : o.align
    });
    flow.advance(L.lineHeight);
    drawn += L.lineHeight;
  });
  if (o.spaceAfter) flow.advance(o.spaceAfter);
  return drawn;
}

module.exports = {
  ELLIPSIS: ELLIPSIS,
  applyFont: applyFont,
  lineAdvance: lineAdvance,
  ellipsize: ellipsize,
  drawSingle: drawSingle,
  fitText: fitText,
  drawFit: drawFit,
  breakWord: breakWord,
  wrapLines: wrapLines,
  layout: layout,
  measure: measure,
  drawLayout: drawLayout,
  drawText: drawText,
  richLayout: richLayout,
  drawRich: drawRich,
  drawRichText: drawRichText,
  diagonalWatermark: diagonalWatermark,
  createFlow: createFlow,
  flowText: flowText,
  txt: txt,
  hasText: hasText
};
