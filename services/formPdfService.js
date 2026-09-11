/**
 * BodyBank — private form dossiers (Sunday check-in, Part-2 intake).
 *
 * These are the least bounded documents in the product: every field is free
 * text a client typed, so a single answer can be one word or three thousand
 * characters. Two rules follow, and both are enforced through
 * services/pdfLayout.js rather than by hoping the values stay short:
 *
 *   - a value is measured at the width and font it will be drawn with, and its
 *     card is sized from that measurement, so nothing escapes a card;
 *   - a value longer than a page is split across pages instead of being drawn
 *     into a card taller than the paper.
 *
 * Branding is painted from a `pageAdded` hook, so EVERY page carries the hero
 * or its continuation strip and the confidential footer — previously only the
 * final page had a footer and only page one had any branding at all.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const PL = require('./pdfLayout');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

function registerFormFonts(doc) {
  const regular = path.join(FONT_DIR, 'Inter-Regular.ttf');
  const semi = path.join(FONT_DIR, 'Inter-SemiBold.ttf');
  const display = path.join(FONT_DIR, 'InterDisplay-Bold.ttf');
  try {
    if (!fs.existsSync(regular)) return false;
    doc.registerFont('BBBody', regular);
    if (fs.existsSync(semi)) doc.registerFont('BBSemi', semi);
    else doc.registerFont('BBSemi', regular);
    if (fs.existsSync(display)) doc.registerFont('BBDisplay', display);
    else doc.registerFont('BBDisplay', semi);
    return true;
  } catch (e) {
    return false;
  }
}

function F(doc, role) {
  const custom = doc._bbFormFonts === true;
  if (!custom) {
    if (role === 'display' || role === 'semi') return 'Helvetica-Bold';
    return 'Helvetica';
  }
  if (role === 'display') return 'BBDisplay';
  if (role === 'semi') return 'BBSemi';
  return 'BBBody';
}

const C = {
  bg: '#07070A',
  pageBg: '#E8ECF4',
  panel: '#FFFFFF',
  panelSoft: '#E2E6EF',
  gold: '#D4AF37',
  goldMid: '#B8922E',
  goldDark: '#7A6220',
  text: '#0E1118',
  muted: '#5A6278',
  line: '#B8C2D6',
  lineSoft: '#C5CDDC',
  noteBg: '#FFFCF5'
};

function text(v) {
  const s = String(v == null ? '' : v).trim();
  return s || '-';
}

function fmtDate(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Diagonal CONFIDENTIAL ghosting.
 *
 * Placed by the kernel, which derives the rotated bounding box from the real
 * string metrics so no repetition bleeds off the paper, and draws it with no
 * width so PDFKit can neither wrap it nor add a page for it.
 */
function drawWatermark(doc) {
  PL.diagonalWatermark(doc, { text: 'CONFIDENTIAL', font: F(doc, 'display'), size: 46, color: C.gold, opacity: 0.03, count: 3 });
}

/** Matches monthly report hero: black band, gold rules, logo, hierarchy. */
function drawLuxuryHero(doc, { headline, subline, clientLine, logoPath, docId }) {
  const w = doc.page.width;
  const mR = doc.page.margins.right;
  // The right-hand plate is anchored to the right MARGIN. Anchoring it to
  // `w - 128` with a 112pt width put its right edge 20pt past the margin.
  const plateW = 112;
  const plateX = w - mR - plateW;
  const textX = 258;
  const textW = Math.max(180, plateX - textX - 16);
  doc.rect(0, 0, w, 108).fill(C.bg);
  doc.moveTo(0, 108).lineTo(w, 108).lineWidth(3).strokeColor(C.gold).stroke();
  doc.moveTo(0, 111).lineTo(w, 111).lineWidth(0.5).strokeColor(C.goldDark).stroke();

  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 40, 28, { fit: [200, 52] });
    } catch (e) { /* ignore */ }
  } else {
    // Without the lockup image the hero still has to say who this is from.
    PL.drawFit(doc, 'BODYBANK', 40, 40, 200, { font: F(doc, 'display'), size: 20, color: C.gold });
    PL.drawFit(doc, 'bodybank.fit', 40, 64, 200, { font: F(doc, 'body'), size: 9, color: '#8FA0C4' });
  }

  PL.drawFit(doc, 'PRIVATE FORM DOSSIER', textX, 46, textW, { font: F(doc, 'body'), size: 8.5, color: '#8FA0C4' });
  PL.drawFit(doc, headline, textX, 62, textW, { font: F(doc, 'display'), size: 19, minSize: 10, color: '#F2F4FA' });
  PL.drawFit(doc, subline, textX, 88, textW, { font: F(doc, 'semi'), size: 9.5, minSize: 6.5, color: C.goldMid });

  PL.drawFit(doc, `DOC ${docId}`, plateX, 28, plateW, { font: F(doc, 'body'), size: 7.5, color: '#5C6578', align: 'right' });
  // Three lines at most for the client name, fitted to the plate beside the title.
  PL.drawText(doc, clientLine, plateX, 42,
    { font: F(doc, 'body'), size: 7, width: plateW, align: 'right', lineGap: 2, color: '#4A5568', maxLines: 3 });
}

/** The slim band that identifies a continuation page. */
function drawContinuationHeader(doc, headline, docId) {
  const w = doc.page.width;
  doc.rect(0, 0, w, 48).fill(C.bg);
  doc.rect(0, 46, w, 2).fill(C.gold);
  PL.drawFit(doc, `BODYBANK  ·  ${headline}  ·  CONTINUED`, doc.page.margins.left, 22,
    w - doc.page.margins.left * 2 - 120, { font: F(doc, 'semi'), size: 8, minSize: 6, color: C.goldMid });
  PL.drawFit(doc, `DOC ${docId}`, w - doc.page.margins.right - 112, 22, 112,
    { font: F(doc, 'body'), size: 7.5, color: '#5C6578', align: 'right' });
}

/** Where content may start and where it must stop on the current page. */
function contentTop(doc) { return doc._bbFirstPageDone ? 62 : doc.page.margins.top; }
function contentBottom(doc) { return doc.page.height - 40; }

/**
 * Guarantee `requiredHeight` points of room.
 *
 * A page that carries no content is never broken — doing so just chains empty
 * pages — and the new page gets its background, watermark, continuation band
 * and footer from the `pageAdded` hook, so no page can go out unbranded.
 */
function ensureSpace(doc, requiredHeight = 100) {
  const top = contentTop(doc);
  if (doc.y + requiredHeight <= contentBottom(doc)) return;
  if (doc.y <= top + 0.5) return;
  doc.addPage();
  doc.x = doc.page.margins.left;
  doc.y = contentTop(doc);
  doc.fillColor(C.text);
}

/** Three meta cards — same KPI visual language as monthly report. */
function drawMetaKpiRow(doc, items) {
  const margin = doc.page.margins.left;
  const contentW = doc.page.width - margin * 2;
  const gap = 8;
  const cardW = (contentW - gap * 2) / 3;
  const y = 122;
  const h = 62;
  for (let i = 0; i < 3; i += 1) {
    const x = margin + i * (cardW + gap);
    const item = items[i] || { label: '', value: '-' };
    doc.save();
    doc.roundedRect(x, y, cardW, h, 10).fillAndStroke(C.panel, C.line);
    doc.roundedRect(x + 3, y + 10, 3.2, h - 20, 1).fill(C.gold);
    doc.restore();
    PL.drawFit(doc, String(item.label || '').toUpperCase(), x + 12, y + 12, cardW - 24,
      { font: F(doc, 'semi'), size: 7.5, minSize: 5.5, color: C.muted });
    // A KPI is one line by contract; a long email or name shrinks to fit its
    // card instead of wrapping out through the bottom of it.
    PL.drawFit(doc, text(item.value), x + 12, y + 28, cardW - 24,
      { font: F(doc, 'display'), size: 14, minSize: 5.5, color: C.text });
  }
  doc.y = y + h + 16;
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 40);
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.roundedRect(x, y, w, 22, 6).fillAndStroke(C.panelSoft, C.lineSoft);
  PL.drawFit(doc, String(title || '').toUpperCase(), x + 10, y + 6, w - 20,
    { font: F(doc, 'semi'), size: 8.8, minSize: 6, color: C.goldDark });
  doc.y = y + 30;
}

/**
 * One labelled answer.
 *
 * The answer is free text of any length, so it is laid out first and then drawn
 * card by card: whatever fits on this page gets a card here, and the remainder
 * continues in another card on the next page. Nothing is truncated and nothing
 * leaves its card.
 */
function fieldCard(doc, label, value) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelText = String(label || '').toUpperCase();
  const tw = w - 28;
  const L = PL.layout(doc, text(value), { font: F(doc, 'body'), size: 10, width: tw, lineGap: 3 });

  let line = 0;
  let first = true;
  while (line < L.lines.length) {
    ensureSpace(doc, Math.min(48, L.lineHeight + 46));
    const room = contentBottom(doc) - doc.y - 46;
    let take = Math.max(1, Math.floor((room + 0.01) / L.lineHeight));
    if (take > L.lines.length - line) take = L.lines.length - line;
    const slice = {
      lines: L.lines.slice(line, line + take),
      lineHeight: L.lineHeight, height: take * L.lineHeight,
      font: L.font, size: L.size, lineGap: L.lineGap, width: L.width, align: L.align
    };
    const h = Math.max(48, slice.height + 34);
    const y = doc.y;
    doc.save();
    doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, C.line);
    doc.roundedRect(x + 3, y + 10, 3.2, h - 20, 1).fill(C.gold);
    doc.restore();
    PL.drawFit(doc, first ? labelText : labelText + ' (CONTINUED)', x + 14, y + 12, tw,
      { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.muted });
    PL.drawLayout(doc, slice, x + 14, y + 26, { color: C.text });
    doc.y = y + h + 10;
    line += take;
    first = false;
  }
}

function drawCoachNoteBar(doc, noteText) {
  const x = doc.page.margins.left;
  const w = doc.page.width - x * 2;
  // Sized from the note rather than pinned at 32pt, which was one line's worth
  // of room for a sentence that already needed more than one line.
  const L = PL.layout(doc, noteText, { font: F(doc, 'body'), size: 8.8, width: w - 24, lineGap: 1.5 });
  const h = Math.max(32, 22 + L.height + 8);
  ensureSpace(doc, h + 8);
  const y = doc.y;
  doc.roundedRect(x, y, w, h, 8).fill(C.noteBg);
  doc.roundedRect(x, y, w, h, 8).lineWidth(1.2).strokeColor(C.gold).stroke();
  PL.drawFit(doc, 'LIFESTYLE MANAGER DESK', x + 12, y + 9, w - 24, { font: F(doc, 'semi'), size: 8, color: C.goldDark });
  PL.drawLayout(doc, L, x + 12, y + 22, { color: C.text });
  doc.y = y + h + 8;
}

function drawFooterLuxury(doc) {
  const margin = doc.page.margins.left;
  const w = doc.page.width - margin * 2;
  const y = doc.page.height - 28;
  PL.drawFit(doc, 'CONFIDENTIAL · bodybank.fit · Private client record', margin, y, w,
    { font: F(doc, 'body'), size: 7.5, color: C.muted, align: 'center' });
}

/**
 * Open a dossier and arm the per-page chrome.
 *
 * Everything a page needs to look like a BodyBank document — ground, watermark,
 * continuation band, footer — is painted from the `pageAdded` hook, so it is
 * impossible to add a page and forget it. The previous version painted the
 * footer once, at the end, onto whichever page happened to be current.
 */
function startFormDocument(outputPath, brand) {
  const b = brand || {};
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc._bbFormFonts = registerFormFonts(doc);
  doc._bbFirstPageDone = false;
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
  drawWatermark(doc);
  // Page one gets its footer now; every later page gets it from the hook below.
  // Painting it once more at the end (as before) double-printed it on
  // whichever page happened to be last.
  drawFooterLuxury(doc);
  doc.on('pageAdded', () => {
    doc._bbFirstPageDone = true;
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
    drawWatermark(doc);
    drawContinuationHeader(doc, b.headline || 'DOSSIER', b.docId || '');
    drawFooterLuxury(doc);
    doc.fillColor(C.text);
    doc.x = doc.page.margins.left;
    doc.y = contentTop(doc);
  });
  return { doc, stream };
}

function writeSundayCheckinPdf({ outputPath, record, logoPath }) {
  return new Promise((resolve, reject) => {
    const docId = crypto.randomBytes(4).toString('hex').toUpperCase();
    const { doc, stream } = startFormDocument(outputPath, { headline: 'SUNDAY CHECK-IN', docId });
    const name = text(record.full_name);
    drawLuxuryHero(doc, {
      headline: 'SUNDAY CHECK-IN',
      subline: `${fmtDate(record.created_at)} · Weekly performance reflection`,
      clientLine: name,
      logoPath,
      docId
    });
    drawMetaKpiRow(doc, [
      { label: 'Client', value: name },
      { label: 'Email', value: record.reply_email || '-' },
      { label: 'Submitted', value: fmtDate(record.created_at) }
    ]);

    sectionTitle(doc, 'Plan & baseline');
    fieldCard(doc, 'Plan', record.plan);
    fieldCard(
      doc,
      'Body fat % (current)',
      record.body_fat_percent != null && record.body_fat_percent !== '' ? String(record.body_fat_percent) : '—'
    );
    fieldCard(doc, 'Current weight, waist & week', record.current_weight_waist_week);
    fieldCard(doc, 'Last week weight & waist', record.last_week_weight_waist);
    fieldCard(doc, 'Total weight loss / gain', record.total_weight_loss);

    sectionTitle(doc, 'Execution quality');
    fieldCard(doc, 'How did your training go?', record.training_go);
    fieldCard(doc, 'How did your nutrition go?', record.nutrition_go);
    fieldCard(doc, 'Sleep (bed/wake, 8 hours, difficulties)', record.sleep);
    fieldCard(doc, 'Occupation & stress', record.occupation_stress);
    fieldCard(doc, 'Other stress & cause', record.other_stress);

    sectionTitle(doc, 'Reflection & next week');
    fieldCard(doc, 'Differences felt (physically & mentally)', record.differences_felt);
    fieldCard(doc, 'Biggest achievements', record.achievements);
    fieldCard(doc, 'Improve for coming week', record.improve_next_week);
    fieldCard(doc, 'Questions', record.questions);

    doc.moveDown(0.2);
    drawCoachNoteBar(doc, 'Keep weekly progression objective and measurable. Use this record to calibrate load, nutrition, and recovery.');

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

function writePart2Pdf({ outputPath, record, logoPath }) {
  return new Promise((resolve, reject) => {
    const docId = crypto.randomBytes(4).toString('hex').toUpperCase();
    const { doc, stream } = startFormDocument(outputPath, { headline: 'PART-2 INTAKE', docId });
    const name = text(record.name);
    drawLuxuryHero(doc, {
      headline: 'PART-2 INTAKE',
      subline: `${fmtDate(record.created_at)} · Lifestyle profile`,
      clientLine: name,
      logoPath,
      docId
    });
    drawMetaKpiRow(doc, [
      { label: 'Client', value: name },
      { label: 'Email', value: record.email || '-' },
      { label: 'Submitted', value: fmtDate(record.created_at) }
    ]);

    sectionTitle(doc, 'Client identity');
    fieldCard(doc, 'Name', record.name);
    fieldCard(doc, 'Email', record.email);
    fieldCard(doc, 'Mobile', record.mobile);
    fieldCard(doc, 'Activity level', record.activity_level);

    sectionTitle(doc, 'Quick details');
    fieldCard(doc, 'Height', record.height_cm ? (record.height_cm + ' cm') : '-');
    fieldCard(doc, 'Bodyweight', record.bodyweight_kg ? (record.bodyweight_kg + ' kg') : '-');
    fieldCard(doc, 'Workouts / week', record.workouts_per_week);
    fieldCard(doc, 'Sleep / night', record.sleep_hours ? (record.sleep_hours + ' hrs') : '-');
    fieldCard(doc, 'Stress level', record.stress_level ? (record.stress_level + ' / 10') : '-');
    fieldCard(doc, 'Smoking', record.smoking);
    fieldCard(doc, 'Alcohol', record.alcohol);

    sectionTitle(doc, 'Performance background');
    fieldCard(doc, 'Sports history', record.sports_history);
    fieldCard(doc, 'Past / current injuries', record.injuries);
    fieldCard(doc, 'Mental health', record.mental_health);
    fieldCard(doc, 'Gym experience', record.gym_experience);

    sectionTitle(doc, 'Lifestyle constraints');
    fieldCard(doc, 'Food choices', record.food_choices);
    fieldCard(doc, 'Vices & addictions', record.vices_addictions);

    sectionTitle(doc, 'Intent & motivation');
    fieldCard(doc, 'Goals', record.goals);
    fieldCard(doc, 'What compelled you', record.what_compelled);

    doc.moveDown(0.2);
    drawCoachNoteBar(doc, 'This intake should inform the next 30-day intervention plan and Lifestyle Manager priorities.');

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = { writeSundayCheckinPdf, writePart2Pdf };
