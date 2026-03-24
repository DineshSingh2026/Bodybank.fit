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
  const hookLines = wrapByWords(hook || caption || prompt || title, isReel ? 24 : 28, isReel ? 5 : 4);
  const subLines = wrapByWords(caption || prompt || title, isReel ? 34 : 40, isReel ? 4 : 3);
  const chips = wrapByWords(title, 18, 3);
  const toneLabel = escapeXml(String(tone || 'Premium').toUpperCase());
  const postLabel = escapeXml(String(postType || 'Post').toUpperCase());
  const panelX = 70;
  const panelY = isReel ? 250 : 210;
  const panelW = width - 140;
  const panelH = isReel ? 1080 : 860;

  const chipSvg = chips.map((chip, i) => {
    const y = isReel ? 1540 + (i * 72) : 1020 + (i * 72);
    return `<g><rect x="92" y="${y}" rx="26" ry="26" width="460" height="54" fill="rgba(255,255,255,0.08)" stroke="rgba(230,192,95,0.45)"/><text x="126" y="${y + 35}" fill="#F8E7BB" font-size="28" font-family="Montserrat,Arial,sans-serif" font-weight="700">${escapeXml(chip)}</text></g>`;
  }).join('');

  const hookSvg = hookLines.map((line, i) => `<text x="98" y="${isReel ? 430 + (i * 78) : 360 + (i * 72)}" fill="#FFFFFF" font-size="${isReel ? 64 : 60}" font-family="Montserrat,Arial,sans-serif" font-weight="800">${escapeXml(line)}</text>`).join('');
  const subSvg = subLines.map((line, i) => `<text x="100" y="${isReel ? 860 + (i * 56) : 710 + (i * 48)}" fill="rgba(255,255,255,0.9)" font-size="${isReel ? 38 : 33}" font-family="Poppins,Arial,sans-serif" font-weight="500">${escapeXml(line)}</text>`).join('');

  const logoTag = logoDataUri
    ? `<image href="${logoDataUri}" x="${width - 246}" y="58" width="156" height="156" />`
    : `<text x="${width - 330}" y="145" fill="#F8E7BB" font-size="42" font-family="Montserrat,Arial,sans-serif" font-weight="800">BODYBANK</text>`;

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
    <linearGradient id="panelGlass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.10)" />
      <stop offset="100%" stop-color="rgba(255,255,255,0.03)" />
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="rgba(0,0,0,0.45)"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)" />
  <rect width="100%" height="100%" fill="url(#glow)" />
  <rect x="26" y="26" width="${width - 52}" height="${height - 52}" rx="34" ry="34" fill="none" stroke="rgba(230,192,95,0.58)" stroke-width="3"/>
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="34" ry="34" fill="url(#panelGlass)" stroke="rgba(255,255,255,0.12)" filter="url(#softShadow)"/>
  <rect x="${panelX + 1}" y="${panelY + 1}" width="${panelW - 2}" height="${panelH - 2}" rx="34" ry="34" fill="none" stroke="rgba(230,192,95,0.26)"/>
  ${logoTag}
  <text x="94" y="128" fill="${palette.gold}" font-size="32" font-family="Montserrat,Arial,sans-serif" letter-spacing="4" font-weight="700">${postLabel} | ${toneLabel}</text>
  ${hookSvg}
  ${subSvg}
  ${chipSvg}
  <text x="92" y="${height - 84}" fill="rgba(255,255,255,0.82)" font-size="28" font-family="Poppins,Arial,sans-serif" font-weight="600">bodybank.fit</text>
  <text x="${width - 92}" y="${height - 84}" text-anchor="end" fill="${palette.accent}" font-size="24" font-family="Poppins,Arial,sans-serif">Train Smart. Look Premium.</text>
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

      const aiResult = await callSonetApi({ keywords, postType, tone });
      const aiResponse = aiResult && aiResult.data ? aiResult.data : aiResult;
      const usage = aiResult && aiResult.usage ? aiResult.usage : null;
      await run(
        'INSERT INTO marketing_contents (keywords, post_type, tone, response_json) VALUES (?, ?, ?, ?::jsonb)',
        [keywords, postType, tone, JSON.stringify(aiResponse)]
      );

      return res.json({ ok: true, data: aiResponse, usage });
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
