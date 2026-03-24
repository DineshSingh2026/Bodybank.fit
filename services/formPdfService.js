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

function drawHeader(doc, title, subtitle, logoPath) {
  doc.rect(0, 0, doc.page.width, 88).fill('#0C2238');
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, 36, 16, { fit: [48, 48] }); } catch (e) { /* ignore */ }
  }
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20).text(title, 96, 24);
  doc.fillColor('#DCEBFA').font('Helvetica').fontSize(10).text(subtitle, 96, 51);
  doc.fillColor('#111111');
}

function sectionTitle(doc, title) {
  doc.moveDown(0.8);
  doc.fillColor('#0C2238').font('Helvetica-Bold').fontSize(12).text(title);
  doc.moveDown(0.2);
}

function row(doc, label, value) {
  doc.fillColor('#455A75').font('Helvetica-Bold').fontSize(9).text(label.toUpperCase());
  doc.fillColor('#1A2633').font('Helvetica').fontSize(10).text(text(value), { lineGap: 2 });
  doc.moveDown(0.4);
}

function writeSundayCheckinPdf({ outputPath, record, logoPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    drawHeader(
      doc,
      'BodyBank Sunday Check-In',
      `${text(record.full_name)} | ${fmtDate(record.created_at)}`,
      logoPath
    );
    doc.y = 105;

    sectionTitle(doc, 'Client Details');
    row(doc, 'Full Name', record.full_name);
    row(doc, 'Reply Email', record.reply_email);
    row(doc, 'Submitted At', fmtDate(record.created_at));

    sectionTitle(doc, 'Plan & Progress');
    row(doc, 'Plan', record.plan);
    row(doc, 'Current weight, waist & week', record.current_weight_waist_week);
    row(doc, 'Last week weight & waist', record.last_week_weight_waist);
    row(doc, 'Total weight loss/gain', record.total_weight_loss);

    sectionTitle(doc, 'Execution');
    row(doc, 'How did your training go?', record.training_go);
    row(doc, 'How did your nutrition go?', record.nutrition_go);
    row(doc, 'Sleep (bed/wake, 8 hours, difficulties)', record.sleep);
    row(doc, 'Occupation & stress', record.occupation_stress);
    row(doc, 'Other stress & cause', record.other_stress);

    sectionTitle(doc, 'Reflection');
    row(doc, 'Differences felt (physically & mentally)', record.differences_felt);
    row(doc, 'Biggest achievements', record.achievements);
    row(doc, 'Improve for coming week', record.improve_next_week);
    row(doc, 'Questions', record.questions);

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
      `${text(record.name)} | ${fmtDate(record.created_at)}`,
      logoPath
    );
    doc.y = 105;

    sectionTitle(doc, 'Client Details');
    row(doc, 'Name', record.name);
    row(doc, 'Email', record.email);
    row(doc, 'Mobile', record.mobile);
    row(doc, 'Activity Level', record.activity_level);
    row(doc, 'Submitted At', fmtDate(record.created_at));

    sectionTitle(doc, 'Background');
    row(doc, 'Sports History', record.sports_history);
    row(doc, 'Past/Current Injuries', record.injuries);
    row(doc, 'Mental Health', record.mental_health);
    row(doc, 'Gym Experience', record.gym_experience);

    sectionTitle(doc, 'Lifestyle');
    row(doc, 'Food Choices', record.food_choices);
    row(doc, 'Vices & Addictions', record.vices_addictions);

    sectionTitle(doc, 'Intent');
    row(doc, 'Goals', record.goals);
    row(doc, 'What compelled you', record.what_compelled);

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = { writeSundayCheckinPdf, writePart2Pdf };
