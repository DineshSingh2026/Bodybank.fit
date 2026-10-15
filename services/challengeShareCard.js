'use strict';

/**
 * BodyBank Challenges — share card (story 1080×1920, square 1080×1080).
 *
 * Built as SVG (no Puppeteer) and rasterised with `sharp` when it is installed.
 * Without sharp the SVG itself is served, so nothing breaks.
 *
 * Privacy: first name + last initial only. Activity counts (check ins, workouts)
 * appear on every card; nutrition counts only when the member ticked
 * "include my results". Never weight or other body data.
 */

let sharp = null;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FONT = "'Plus Jakarta Sans','Inter','Segoe UI',Roboto,Arial,sans-serif";
const SERIF = "'Playfair Display',Georgia,'Times New Roman',serif";

/**
 * @param {object} d { name, challenge, day, length, done:boolean, stats:{checkins,workouts,protein_days}, include_results, url }
 * @param {'story'|'square'} format
 */
function buildSvg(d, format) {
  const data = d || {};
  const square = format === 'square';
  const W = 1080;
  const H = square ? 1080 : 1920;
  const cx = W / 2;
  const top = square ? 170 : 520;
  const challenge = esc(String(data.challenge || 'Challenge').toUpperCase());
  const day = Math.max(1, Number(data.day) || 1);
  const st = data.stats || {};
  const bits = [];
  const pl = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
  if (st.checkins != null) bits.push(pl(st.checkins, 'check in', 'check ins'));
  if (st.workouts != null) bits.push(pl(st.workouts, 'workout', 'workouts'));
  if (data.include_results && st.protein_days != null) bits.push(pl(st.protein_days, 'protein day', 'protein days'));
  const name = esc(data.name || '');
  const url = esc(data.url || 'bodybank.fit/challenge');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F1D488"/><stop offset=".55" stop-color="#C9A040"/><stop offset="1" stop-color="#9E7A22"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy="${square ? '.45' : '.4'}" r=".7"><stop offset="0" stop-color="#2a2110"/><stop offset="1" stop-color="#0b0b0c"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="48" y="48" width="${W - 96}" height="${H - 96}" rx="48" fill="none" stroke="url(#g)" stroke-width="4"/>
  <text x="${cx}" y="${top}" text-anchor="middle" font-family="${FONT}" font-size="34" font-weight="700" letter-spacing="8" fill="#D9B45A">BODYBANK · ${challenge}</text>
  <text x="${cx}" y="${top + (square ? 300 : 360)}" text-anchor="middle" font-family="${FONT}" font-size="${square ? 250 : 300}" font-weight="800" fill="url(#g)">DAY ${day}</text>
  <text x="${cx}" y="${top + (square ? 440 : 540)}" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-size="${square ? 120 : 150}" fill="url(#g)">${data.done === false ? 'in progress.' : 'done.'}</text>
  ${name ? `<text x="${cx}" y="${top + (square ? 540 : 680)}" text-anchor="middle" font-family="${FONT}" font-size="44" font-weight="700" fill="#F5F1E8">${name}</text>` : ''}
  ${bits.length ? `<text x="${cx}" y="${top + (square ? 610 : 770)}" text-anchor="middle" font-family="${FONT}" font-size="38" font-weight="600" fill="#A49F95">${esc(bits.join('   ·   '))}</text>` : ''}
  <text x="${cx}" y="${H - (square ? 120 : 200)}" text-anchor="middle" font-family="${FONT}" font-size="36" font-weight="700" fill="#D9B45A">${url}</text>
</svg>`;
}

/** @returns {Promise<{type:string, body:Buffer}>} */
async function render(d, format) {
  const svg = buildSvg(d, format);
  if (sharp) {
    try {
      const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
      return { type: 'image/png', body: png };
    } catch (_) { /* fall back to SVG */ }
  }
  return { type: 'image/svg+xml', body: Buffer.from(svg) };
}

module.exports = { buildSvg, render, hasSharp: () => !!sharp };
