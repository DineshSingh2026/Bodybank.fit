function buildMarketingPrompt({ keywords, postType, tone }) {
  const systemPrompt = [
    'You are Marketing AI for bodybank.fit.',
    'Generate premium fitness marketing content based on user inputs.',
    'Return STRICT JSON only.',
    'Keep content short, engaging, and ready to post.',
    'Target Indian audience.',
    'Include: hook, caption, carousel slides, reel script, WhatsApp message, hashtags, CTA, and design suggestions.',
    'No markdown. No extra commentary.'
  ].join(' ');

  const userPrompt = [
    `Generate content for: ${keywords}`,
    `Post Type: ${postType}`,
    `Tone: ${tone}`,
    'Required JSON shape:',
    JSON.stringify({
      title: '',
      input_keywords: '',
      post_type: '',
      content: {
        hook: '',
        caption: '',
        carousel_slides: [],
        reel_script: '',
        whatsapp_message: ''
      },
      hashtags: [],
      cta: '',
      design_suggestion: {
        theme: '',
        colors: '',
        visual_idea: ''
      }
    }, null, 2)
  ].join('\n');

  return { systemPrompt, userPrompt };
}

function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const directStart = trimmed.indexOf('{');
  const directEnd = trimmed.lastIndexOf('}');
  if (directStart === -1 || directEnd === -1 || directEnd <= directStart) return null;
  const candidate = trimmed.slice(directStart, directEnd + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

function normalizeMarketingResponse(payload, input) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('AI returned empty payload');
  }

  const content = payload.content && typeof payload.content === 'object' ? payload.content : {};
  const design = payload.design_suggestion && typeof payload.design_suggestion === 'object'
    ? payload.design_suggestion
    : {};

  return {
    title: String(payload.title || `Marketing Content for ${input.keywords}`).trim(),
    input_keywords: String(payload.input_keywords || input.keywords || '').trim(),
    post_type: String(payload.post_type || input.postType || '').trim(),
    content: {
      hook: String(content.hook || '').trim(),
      caption: String(content.caption || '').trim(),
      carousel_slides: Array.isArray(content.carousel_slides)
        ? content.carousel_slides.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      reel_script: String(content.reel_script || '').trim(),
      whatsapp_message: String(content.whatsapp_message || '').trim()
    },
    hashtags: Array.isArray(payload.hashtags)
      ? payload.hashtags.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    cta: String(payload.cta || '').trim(),
    design_suggestion: {
      theme: String(design.theme || '').trim(),
      colors: String(design.colors || '').trim(),
      visual_idea: String(design.visual_idea || '').trim()
    }
  };
}

async function callSonetApi({ keywords, postType, tone }) {
  const apiKey = String(process.env.SONET_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('SONET_API_KEY is not configured');
  }

  const endpoint = String(process.env.SONET_API_URL || 'https://api.anthropic.com/v1/messages').trim();
  const model = String(process.env.SONET_MODEL || 'claude-sonnet-4-20250514').trim();
  const { systemPrompt, userPrompt } = buildMarketingPrompt({ keywords, postType, tone });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Sonet API error: ${errText || response.statusText}`);
  }

  const apiData = await response.json();
  const firstContent = apiData && apiData.content && apiData.content[0] ? apiData.content[0] : null;
  const textReply = firstContent && firstContent.type === 'text' ? firstContent.text : '';
  const parsed = extractJsonObject(textReply);
  if (!parsed) {
    throw new Error('Invalid JSON returned from Sonet API');
  }

  return normalizeMarketingResponse(parsed, { keywords, postType, tone });
}

module.exports = { callSonetApi, normalizeMarketingResponse };
