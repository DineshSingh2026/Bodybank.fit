const express = require('express');
const fs = require('fs');
const path = require('path');
const { verifyToken, requireAdminOrSuperadmin } = require('../middleware/auth');
const { callSonetApi } = require('../services/marketingAIService');

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapByWords(text, maxCharsPerLine, maxLines) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxCharsPerLine) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, maxCharsPerLine - 3))}...`;
  }
  return lines;
}

function toLuxuryPalette(tone) {
  const raw = String(tone || '').toLowerCase();
  if (raw.includes('motiv')) return { bg1: '#0B162E', bg2: '#1D3A77', accent: '#9FD3FF', gold: '#E7C76A' };
  if (raw.includes('sales')) return { bg1: '#1A0B0B', bg2: '#4D1818', accent: '#FFB088', gold: '#F5C26B' };
  return { bg1: '#0A0D14', bg2: '#1C2336', accent: '#88D9FF', gold: '#E6C05F' };
}

function buildLuxuryMarketingSvg({ postType, keywords, tone, hook, caption, prompt, logoDataUri }) {
  const isReel = String(postType || '').toLowerCase() === 'reel';
  const width = 1080;
  const height = isReel ? 1920 : 1350;
  const palette = toLuxuryPalette(tone);
  const title = String(keywords || 'BodyBank').trim() || 'BodyBank';
  const hookLines = wrapByWords(hook || caption || prompt || title, 34, isReel ? 5 : 4);
  const subLines = wrapByWords(caption || prompt || title, 44, isReel ? 4 : 3);
  const chips = wrapByWords(title, 18, 3);

  const chipSvg = chips.map((chip, i) => {
    const y = isReel ? 1540 + (i * 72) : 980 + (i * 72);
    return `<g><rect x="78" y="${y}" rx="26" ry="26" width="420" height="54" fill="rgba(255,255,255,0.08)" stroke="rgba(230,192,95,0.45)"/><text x="110" y="${y + 35}" fill="#F8E7BB" font-size="28" font-family="Arial, sans-serif" font-weight="700">${escapeXml(chip)}</text></g>`;
  }).join('');

  const hookSvg = hookLines.map((line, i) => `<text x="82" y="${isReel ? 430 + (i * 72) : 360 + (i * 68)}" fill="#FFFFFF" font-size="${isReel ? 64 : 58}" font-family="Arial, sans-serif" font-weight="800">${escapeXml(line)}</text>`).join('');
  const subSvg = subLines.map((line, i) => `<text x="84" y="${isReel ? 790 + (i * 52) : 690 + (i * 46)}" fill="rgba(255,255,255,0.88)" font-size="${isReel ? 40 : 34}" font-family="Arial, sans-serif" font-weight="500">${escapeXml(line)}</text>`).join('');

  const logoTag = logoDataUri
    ? `<image href="${logoDataUri}" x="${width - 250}" y="56" width="164" height="164" />`
    : `<text x="${width - 280}" y="145" fill="#F8E7BB" font-size="48" font-family="Arial, sans-serif" font-weight="800">BODYBANK</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.bg1}" />
      <stop offset="100%" stop-color="${palette.bg2}" />
    </linearGradient>
    <radialGradient id="glow" cx="80%" cy="20%" r="70%">
      <stop offset="0%" stop-color="rgba(230,192,95,0.35)" />
      <stop offset="100%" stop-color="rgba(230,192,95,0)" />
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)" />
  <rect width="100%" height="100%" fill="url(#glow)" />
  <rect x="30" y="30" width="${width - 60}" height="${height - 60}" rx="34" ry="34" fill="none" stroke="rgba(230,192,95,0.58)" stroke-width="4"/>
  ${logoTag}
  <text x="84" y="130" fill="${palette.gold}" font-size="34" font-family="Arial, sans-serif" letter-spacing="4" font-weight="700">${escapeXml(String(postType || 'Post').toUpperCase())} | ${escapeXml(String(tone || 'Premium').toUpperCase())}</text>
  ${hookSvg}
  ${subSvg}
  ${chipSvg}
  <text x="84" y="${height - 82}" fill="rgba(255,255,255,0.78)" font-size="28" font-family="Arial, sans-serif" font-weight="600">bodybank.fit</text>
  <text x="${width - 332}" y="${height - 82}" fill="${palette.accent}" font-size="26" font-family="Arial, sans-serif">Train Smart. Look Premium.</text>
</svg>`;
}

function createMarketingAIRouter({ run, queryAll }) {
  const router = express.Router();

  router.get('/visual', (req, res) => {
    try {
      const keywords = String(req.query?.keywords || '').trim();
      const postType = String(req.query?.postType || 'Post').trim();
      const tone = String(req.query?.tone || 'Premium').trim();
      const hook = String(req.query?.hook || '').trim();
      const caption = String(req.query?.caption || '').trim();
      const prompt = String(req.query?.prompt || '').trim();
      const logoPath = path.join(__dirname, '..', 'public', 'img', 'bodybank-logo-short.png');
      let logoDataUri = '';
      if (fs.existsSync(logoPath)) {
        const b64 = fs.readFileSync(logoPath).toString('base64');
        logoDataUri = `data:image/png;base64,${b64}`;
      }
      const svg = buildLuxuryMarketingSvg({ postType, keywords, tone, hook, caption, prompt, logoDataUri });
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(svg);
    } catch (e) {
      console.error('[marketing-ai visual]', e.message);
      return res.status(500).json({ error: 'Could not generate branded image.' });
    }
  });

  router.post('/generate', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const keywords = String(req.body?.keywords || '').trim();
      const postType = String(req.body?.postType || '').trim();
      const tone = String(req.body?.tone || '').trim();

      if (!keywords || !postType || !tone) {
        return res.status(400).json({ error: 'keywords, postType, and tone are required' });
      }

      const aiResponse = await callSonetApi({ keywords, postType, tone });
      await run(
        'INSERT INTO marketing_contents (keywords, post_type, tone, response_json) VALUES (?, ?, ?, ?::jsonb)',
        [keywords, postType, tone, JSON.stringify(aiResponse)]
      );

      return res.json({ ok: true, data: aiResponse });
    } catch (e) {
      console.error('[marketing-ai generate]', e.message);
      const safeMsg = String(e.message || '').slice(0, 240);
      if (String(e.message || '').toLowerCase().includes('json')) {
        return res.status(502).json({ error: 'AI returned invalid content. Please regenerate.' });
      }
      return res.status(500).json({ error: safeMsg || 'Failed to generate marketing content. Please try again.' });
    }
  });

  router.get('/history', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const rows = await queryAll(
        'SELECT id, keywords, post_type, tone, response_json, created_at FROM marketing_contents ORDER BY created_at DESC LIMIT 20'
      );
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error('[marketing-ai history]', e.message);
      return res.status(500).json({ error: 'Failed to load history' });
    }
  });

  return router;
}

module.exports = { createMarketingAIRouter };
