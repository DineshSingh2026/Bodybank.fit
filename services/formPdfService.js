const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

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

function drawWatermark(doc) {
  doc.save();
  doc.opacity(0.03);
  doc.fillColor(C.gold);
  doc.font(F(doc, 'display')).fontSize(48);
  for (let i = 0; i < 3; i += 1) {
    doc.save();
    doc.rotate(-26, { origin: [100 + i * 180, 160 + i * 100] });
    doc.text('CONFIDENTIAL', 30 + i * 50, 80 + i * 160);
    doc.restore();
  }
  doc.opacity(1);
  doc.restore();
}

/** Matches monthly report hero: black band, gold rules, logo, hierarchy. */
function drawLuxuryHero(doc, { headline, subline, clientLine, logoPath }) {
  const w = doc.page.width;
  const textX = 258;
  const textW = Math.max(180, w - textX - 188);
  doc.rect(0, 0, w, 108).fill(C.bg);
  doc.moveTo(0, 108).lineTo(w, 108).lineWidth(3).strokeColor(C.gold).stroke();
  doc.moveTo(0, 111).lineTo(w, 111).lineWidth(0.5).strokeColor(C.goldDark).stroke();

  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 40, 28, { fit: [200, 52] });
    } catch (e) { /* ignore */ }
  }

  doc.fillColor('#8FA0C4').font(F(doc, 'body')).fontSize(8.5).text('PRIVATE FORM DOSSIER', textX, 46);
  doc.fillColor('#F2F4FA').font(F(doc, 'display')).fontSize(19).text(headline, textX, 62, { width: textW });
  doc.fillColor(C.goldMid).font(F(doc, 'semi')).fontSize(9.5).text(subline, textX, 88, { width: textW });

  const docId = crypto.randomBytes(4).toString('hex').toUpperCase();
  doc.fillColor('#5C6578').font(F(doc, 'body')).fontSize(7.5).text(`DOC ${docId}`, w - 128, 28, { width: 112, align: 'right' });
  doc.fillColor('#4A5568').font(F(doc, 'body')).fontSize(7).text(clientLine.slice(0, 120), w - 128, 42, { width: 112, align: 'right', lineGap: 2 });
}

function ensureSpace(doc, requiredHeight = 100) {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight > bottomLimit) {
    doc.addPage();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
    drawWatermark(doc);
    doc.fillColor(C.text);
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
  }
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
    doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(7.5).text(String(item.label || '').toUpperCase(), x + 12, y + 12, { width: cardW - 20 });
    doc.fillColor(C.text).font(F(doc, 'display')).fontSize(14).text(text(item.value), x + 12, y + 28, { width: cardW - 20 });
  }
  doc.y = y + h + 16;
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 40);
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.roundedRect(x, y, w, 22, 6).fillAndStroke(C.panelSoft, C.lineSoft);
  doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8.8).text(String(title || '').toUpperCase(), x + 10, y + 6);
  doc.y = y + 30;
}

function fieldCard(doc, label, value) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelText = String(label || '').toUpperCase();
  const valueText = text(value);
  doc.font(F(doc, 'body')).fontSize(10);
  const valueHeight = doc.heightOfString(valueText, { width: w - 28, lineGap: 3 });
  const h = Math.max(48, valueHeight + 34);
  ensureSpace(doc, h + 12);
  const y = doc.y;
  doc.save();
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, C.line);
  doc.roundedRect(x + 3, y + 10, 3.2, h - 20, 1).fill(C.gold);
  doc.restore();
  doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(8.5).text(labelText, x + 14, y + 12, { width: w - 22 });
  doc.fillColor(C.text).font(F(doc, 'body')).fontSize(10).text(valueText, x + 14, y + 26, {
    width: w - 22,
    lineGap: 3
  });
  doc.y = y + h + 10;
}

function drawCoachNoteBar(doc, noteText) {
  ensureSpace(doc, 36);
  const x = doc.page.margins.left;
  const w = doc.page.width - x * 2;
  const y = doc.y;
  doc.roundedRect(x, y, w, 32, 8).fill(C.noteBg);
  doc.roundedRect(x, y, w, 32, 8).lineWidth(1.2).strokeColor(C.gold).stroke();
  doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text('LIFESTYLE MANAGER DESK', x + 12, y + 9);
  doc.fillColor(C.text).font(F(doc, 'body')).fontSize(8.8).text(noteText, x + 12, y + 19, { width: w - 24 });
  doc.y = y + 40;
}

function drawFooterLuxury(doc) {
  const margin = doc.page.margins.left;
  const w = doc.page.width - margin * 2;
  const y = doc.page.height - 28;
  doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.5)
    .text('CONFIDENTIAL · bodybank.fit · Private client record', margin, y, { width: w, align: 'center' });
}

function startFormDocument(outputPath) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc._bbFormFonts = registerFormFonts(doc);
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
  drawWatermark(doc);
  return { doc, stream };
}

function writeSundayCheckinPdf({ outputPath, record, logoPath }) {
  return new Promise((resolve, reject) => {
    const { doc, stream } = startFormDocument(outputPath);
    const name = text(record.full_name);
    drawLuxuryHero(doc, {
      headline: 'SUNDAY CHECK-IN',
      subline: `${fmtDate(record.created_at)} · Weekly performance reflection`,
      clientLine: name,
      logoPath
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

    drawFooterLuxury(doc);
    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

function writePart2Pdf({ outputPath, record, logoPath }) {
  return new Promise((resolve, reject) => {
    const { doc, stream } = startFormDocument(outputPath);
    const name = text(record.name);
    drawLuxuryHero(doc, {
      headline: 'PART-2 INTAKE',
      subline: `${fmtDate(record.created_at)} · Lifestyle profile`,
      clientLine: name,
      logoPath
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

    drawFooterLuxury(doc);
    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = { writeSundayCheckinPdf, writePart2Pdf };
