const fs = require('fs');
const PDFDocument = require('pdfkit');

function text(v) {
  const s = String(v == null ? '' : v).trim();
  return s || '-';
}

function fmtDate(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

const COLORS = {
  navy: '#0A2540',
  blue: '#1E4D8C',
  blueSoft: '#EEF5FF',
  white: '#FFFFFF',
  slate: '#6D7D91',
  text: '#1B2A3A',
  line: '#D6E3F4',
  card: '#F8FBFF',
  accent: '#DDAF3B'
};

function ensureSpace(doc, requiredHeight = 100) {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight > bottomLimit) doc.addPage();
}

function drawHeader(doc, title, subtitle, logoPath) {
  doc.rect(0, 0, doc.page.width, 108).fill(COLORS.navy);
  doc.rect(0, 92, doc.page.width, 16).fill(COLORS.blue);
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, 36, 22, { fit: [54, 54] }); } catch (e) { /* ignore */ }
  }
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(24).text(title, 102, 28);
  doc.fillColor('#DCEBFA').font('Helvetica-Bold').fontSize(12).text(subtitle, 102, 62);
  doc.fillColor(COLORS.text);
}

function drawMetaStrip(doc, items) {
  const x = doc.page.margins.left;
  const y = 122;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const boxW = Math.floor((w - 16) / 3);
  const h = 56;
  for (let i = 0; i < 3; i += 1) {
    const bx = x + i * (boxW + 8);
    doc.roundedRect(bx, y, boxW, h, 8).fillAndStroke(COLORS.blueSoft, COLORS.line);
    const item = items[i] || { label: '', value: '-' };
    doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(9).text(item.label.toUpperCase(), bx + 10, y + 10);
    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(12).text(text(item.value), bx + 10, y + 24, { width: boxW - 20 });
  }
  doc.y = y + h + 14;
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 44);
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.roundedRect(x, y, w, 30, 8).fillAndStroke(COLORS.card, COLORS.line);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(13).text(title, x + 12, y + 9);
  doc.y = y + 38;
}

function fieldCard(doc, label, value) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelText = String(label || '').toUpperCase();
  const valueText = text(value);
  const valueHeight = doc.heightOfString(valueText, { width: w - 24, lineGap: 3 });
  const h = Math.max(52, valueHeight + 30);
  ensureSpace(doc, h + 10);
  const y = doc.y;
  doc.roundedRect(x, y, w, h, 8).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(9).text(labelText, x + 12, y + 10);
  doc.fillColor(COLORS.text).font('Helvetica').fontSize(11).text(valueText, x + 12, y + 24, {
    width: w - 24,
    lineGap: 3
  });
  doc.y = y + h + 8;
}

function drawFooterBrand(doc) {
  const y = doc.page.height - 30;
  doc.strokeColor(COLORS.line).lineWidth(1).moveTo(doc.page.margins.left, y - 6).lineTo(doc.page.width - doc.page.margins.right, y - 6).stroke();
  doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(8)
    .text('BODYBANK.FIT | PREMIUM CLIENT REPORT', doc.page.margins.left, y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'right'
    });
}

function writeSundayCheckinPdf({ outputPath, record, logoPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    drawHeader(
      doc,
      'BodyBank Sunday Check-In',
      `${text(record.full_name)} | ${fmtDate(record.created_at)} | Weekly Performance Reflection`,
      logoPath
    );
    drawMetaStrip(doc, [
      { label: 'Client', value: record.full_name },
      { label: 'Email', value: record.reply_email },
      { label: 'Submitted', value: fmtDate(record.created_at) }
    ]);

    sectionTitle(doc, 'Plan & Baseline');
    fieldCard(doc, 'Plan', record.plan);
    fieldCard(doc, 'Current weight, waist & week', record.current_weight_waist_week);
    fieldCard(doc, 'Last week weight & waist', record.last_week_weight_waist);
    fieldCard(doc, 'Total weight loss / gain', record.total_weight_loss);

    sectionTitle(doc, 'Execution Quality');
    fieldCard(doc, 'How did your training go?', record.training_go);
    fieldCard(doc, 'How did your nutrition go?', record.nutrition_go);
    fieldCard(doc, 'Sleep (bed/wake, 8 hours, difficulties)', record.sleep);
    fieldCard(doc, 'Occupation & stress', record.occupation_stress);
    fieldCard(doc, 'Other stress & cause', record.other_stress);

    sectionTitle(doc, 'Reflection & Next Week Strategy');
    fieldCard(doc, 'Differences felt (physically & mentally)', record.differences_felt);
    fieldCard(doc, 'Biggest achievements', record.achievements);
    fieldCard(doc, 'Improve for coming week', record.improve_next_week);
    fieldCard(doc, 'Questions', record.questions);

    ensureSpace(doc, 50);
    doc.moveDown(0.3);
    doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(10)
      .text('Coach Note: Keep weekly progression objective and measurable.', { align: 'left' });

    drawFooterBrand(doc);

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

function writePart2Pdf({ outputPath, record, logoPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    drawHeader(
      doc,
      'BodyBank Part-2 Submission',
      `${text(record.name)} | ${fmtDate(record.created_at)} | Lifestyle Intake Profile`,
      logoPath
    );
    drawMetaStrip(doc, [
      { label: 'Client', value: record.name },
      { label: 'Email', value: record.email },
      { label: 'Submitted', value: fmtDate(record.created_at) }
    ]);

    sectionTitle(doc, 'Client Identity');
    fieldCard(doc, 'Name', record.name);
    fieldCard(doc, 'Email', record.email);
    fieldCard(doc, 'Mobile', record.mobile);
    fieldCard(doc, 'Activity Level', record.activity_level);

    sectionTitle(doc, 'Performance Background');
    fieldCard(doc, 'Sports History', record.sports_history);
    fieldCard(doc, 'Past / Current Injuries', record.injuries);
    fieldCard(doc, 'Mental Health', record.mental_health);
    fieldCard(doc, 'Gym Experience', record.gym_experience);

    sectionTitle(doc, 'Lifestyle Constraints');
    fieldCard(doc, 'Food Choices', record.food_choices);
    fieldCard(doc, 'Vices & Addictions', record.vices_addictions);

    sectionTitle(doc, 'Intent & Motivation');
    fieldCard(doc, 'Goals', record.goals);
    fieldCard(doc, 'What compelled you', record.what_compelled);

    ensureSpace(doc, 50);
    doc.moveDown(0.3);
    doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(10)
      .text('Coach Note: This intake should drive the next 30-day intervention plan.', { align: 'left' });

    drawFooterBrand(doc);

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = { writeSundayCheckinPdf, writePart2Pdf };
