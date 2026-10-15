'use strict';

/**
 * BodyBank Challenges — certificate of completion (PDFKit, one A4 landscape page).
 *
 * Black + gold, the member's name, the challenge, dates, a results row and a
 * signature line. Every string goes through services/pdfLayout.js drawFit, so a
 * long name shrinks or ellipsizes instead of leaving its box (tests/pdf-layout-audit.js
 * renders it empty / normal / extreme).
 *
 * No body data, no blood data, no meal scores: only activity counts.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const L = require('./pdfLayout');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const GOLD = '#D9B45A';
const GOLD_DIM = '#9E7A22';
const GOLD_LIGHT = '#F1D488';
const INK = '#0B0B0C';
const CARD = '#141416';
const TEXT = '#F5F1E8';
const MUTED = '#A49F95';

const SIGNATURE = 'Coach Kling, Founder, BodyBank';

function registerFonts(doc) {
  const f = (n) => path.join(FONT_DIR, n);
  const reg = (name, file) => { try { if (fs.existsSync(f(file))) doc.registerFont(name, f(file)); else doc.registerFont(name, 'Helvetica'); } catch (_) { doc.registerFont(name, 'Helvetica'); } };
  reg('Body', 'Inter-Regular.ttf');
  reg('Semi', 'Inter-SemiBold.ttf');
  reg('Display', 'InterDisplay-Bold.ttf');
  // Built-in serif italic stands in for Playfair Display italic.
  doc.registerFont('Serif', 'Times-BoldItalic');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(ymd, withYear) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${withYear ? ' ' + m[1] : ''}`;
}
function dateRange(a, b) {
  if (!a || !b) return '';
  const sameYear = String(a).slice(0, 4) === String(b).slice(0, 4);
  return `${fmtDay(a, !sameYear)} to ${fmtDay(b, true)}`;
}
function n(v) { return v == null || v === '' ? '—' : Number(v).toLocaleString('en-IN'); }

/** Gold medal drawn with vectors (no emoji glyphs in PDFs). */
function medal(doc, cx, cy) {
  doc.save();
  doc.moveTo(cx - 12, cy - 34).lineTo(cx - 4, cy - 10).lineTo(cx - 14, cy - 10).closePath().fill(GOLD_DIM);
  doc.moveTo(cx + 12, cy - 34).lineTo(cx + 4, cy - 10).lineTo(cx + 14, cy - 10).closePath().fill(GOLD_DIM);
  const g = doc.linearGradient(cx - 16, cy - 16, cx + 16, cy + 16);
  g.stop(0, GOLD_LIGHT).stop(0.55, '#C9A040').stop(1, GOLD_DIM);
  doc.circle(cx, cy + 2, 16).fill(g);
  doc.circle(cx, cy + 2, 11).lineWidth(1.2).stroke(INK);
  doc.restore();
}

/**
 * @param {object} d  { name, challenge, length, days_done, start_date, end_date, coach, stats:{checkins,sessions,sets,protein_days,avg_steps,coins}, verify_url }
 * @returns {Promise<Buffer>}
 */
function renderCertificate(d) {
  const data = d || {};
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: 'BodyBank certificate of completion', Author: 'BodyBank' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      registerFonts(doc);
      const W = doc.page.width;
      const H = doc.page.height;

      // Page + double gold frame
      doc.rect(0, 0, W, H).fill(INK);
      doc.roundedRect(24, 24, W - 48, H - 48, 18).lineWidth(1.6).stroke(GOLD);
      doc.roundedRect(32, 32, W - 64, H - 64, 14).lineWidth(0.6).stroke(GOLD_DIM);

      const x = 70;
      const w = W - 140;

      L.drawFit(doc, 'BODYBANK', x, 52, w, { font: 'Display', size: 13, color: GOLD, align: 'center', characterSpacing: 3 });
      medal(doc, W / 2, 112);
      L.drawFit(doc, 'CERTIFICATE OF COMPLETION', x, 146, w, { font: 'Semi', size: 12, color: GOLD, align: 'center', characterSpacing: 2.6 });

      L.drawFit(doc, data.name || 'BodyBank member', x, 186, w, { font: 'Serif', size: 46, minSize: 22, color: GOLD_LIGHT, align: 'center' });
      L.drawFit(doc, 'completed the BodyBank', x, 246, w, { font: 'Body', size: 13, color: MUTED, align: 'center' });
      const title = `${data.length ? data.length + ' Day ' : ''}${data.challenge || 'Challenge'}`.replace(/^(\d+) Day (\d+ Day )/, '$1 Day ');
      L.drawFit(doc, title, x, 266, w, { font: 'Display', size: 22, color: TEXT, align: 'center' });
      const sub = [dateRange(data.start_date, data.end_date), data.days_done != null && data.length ? `${data.days_done} of ${data.length} days` : '', data.coach || ''].filter(Boolean).join('  ·  ');
      L.drawFit(doc, sub, x, 300, w, { font: 'Body', size: 11, color: MUTED, align: 'center' });

      // Results row
      const st = data.stats || {};
      const cells = [
        ['Check ins', n(st.checkins)],
        ['Coach Mode sessions', st.sessions != null ? `${n(st.sessions)}${st.sets ? ' · ' + n(st.sets) + ' sets' : ''}` : '—'],
        ['Protein target hit', st.protein_days != null ? `${n(st.protein_days)} days` : '—'],
        ['Avg steps', n(st.avg_steps)],
        ['Coins earned', n(st.coins)]
      ];
      const top = 332;
      const boxH = 70;
      const gap = 10;
      const bw = (w - gap * (cells.length - 1)) / cells.length;
      cells.forEach((c, i) => {
        const bx = x + i * (bw + gap);
        doc.roundedRect(bx, top, bw, boxH, 12).fill(CARD);
        doc.roundedRect(bx, top, bw, boxH, 12).lineWidth(0.6).stroke('#3a3220');
        L.drawFit(doc, c[1], bx + 10, top + 14, bw - 20, { font: 'Display', size: 18, minSize: 10, color: GOLD_LIGHT, align: 'center' });
        L.drawFit(doc, c[0], bx + 10, top + 44, bw - 20, { font: 'Body', size: 9.5, minSize: 7, color: MUTED, align: 'center' });
      });

      // Signature + verification
      const sy = 448;
      const sx = W / 2 - 150;
      L.drawFit(doc, 'Coach Kling', sx, sy, 300, { font: 'Serif', size: 24, color: GOLD, align: 'center' });
      doc.moveTo(sx, sy + 34).lineTo(sx + 300, sy + 34).lineWidth(0.8).stroke(GOLD_DIM);
      L.drawFit(doc, data.signature || SIGNATURE, sx, sy + 42, 300, { font: 'Semi', size: 10, color: TEXT, align: 'center' });

      if (data.verify_url) {
        L.drawFit(doc, 'Verify: ' + data.verify_url, x, H - 70, w, { font: 'Body', size: 8.5, color: MUTED, align: 'center' });
        try { doc.link(x, H - 72, w, 12, data.verify_url); } catch (_) { /* link is a nicety */ }
      }
      L.drawFit(doc, 'BodyBank · bodybank.fit', x, H - 56, w, { font: 'Body', size: 8.5, color: GOLD_DIM, align: 'center' });
      doc.end();
    } catch (e) {
      try { doc.end(); } catch (_) { /* ignore */ }
      reject(e);
    }
  });
}

module.exports = { renderCertificate, SIGNATURE, dateRange };
