const express = require('express');
const { verifyToken, requireAdminOrSuperadmin } = require('../middleware/auth');
const { callSonetApi } = require('../services/marketingAIService');

function createMarketingAIRouter({ run, queryAll }) {
  const router = express.Router();

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
      if (String(e.message || '').toLowerCase().includes('json')) {
        return res.status(502).json({ error: 'AI returned invalid content. Please regenerate.' });
      }
      return res.status(500).json({ error: 'Failed to generate marketing content. Please try again.' });
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
