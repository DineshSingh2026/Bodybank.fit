function normalizePostType(postType) {
  const raw = String(postType || '').trim().toLowerCase();
  if (raw === 'carousel') return 'Carousel';
  if (raw === 'reel') return 'Reel';
  return 'Post';
}

function buildPostTypeShape(normalizedPostType) {
  if (normalizedPostType === 'Carousel') {
    return {
      title: '',
      input_keywords: '',
      post_type: 'Carousel',
      content: {
        hook: '',
        caption: '',
        carousel_slides: [],
        image_prompt: ''
      },
      hashtags: [],
      cta: '',
      design_suggestion: {
        theme: '',
        colors: '',
        visual_idea: ''
      }
    };
  }
  if (normalizedPostType === 'Reel') {
    return {
      title: '',
      input_keywords: '',
      post_type: 'Reel',
      content: {
        hook: '',
        caption: '',
        reel_script: '',
        image_prompt: ''
      },
      hashtags: [],
      cta: '',
      design_suggestion: {
        theme: '',
        colors: '',
        visual_idea: ''
      }
    };
  }
  return {
    title: '',
    input_keywords: '',
    post_type: 'Post',
    content: {
      hook: '',
      caption: '',
      image_prompt: ''
    },
    hashtags: [],
    cta: '',
    design_suggestion: {
      theme: '',
      colors: '',
      visual_idea: ''
    }
  };
}

function buildMarketingPrompt({ keywords, postType, tone }) {
  const normalizedPostType = normalizePostType(postType);
  const requiredShape = buildPostTypeShape(normalizedPostType);
  const systemPrompt = [
    'You are Marketing AI for bodybank.fit.',
    'Generate premium fitness marketing content based on user inputs.',
    'Return STRICT JSON only.',
    'Keep content short, engaging, direct, and ready to post.',
    'Target Indian audience.',
    `Generate only fields needed for selected post type: ${normalizedPostType}.`,
    'Do not return templates, instructions, placeholders, or internal prompt text.',
    'Write final copy that can be posted manually without edits.',
    'No markdown. No extra commentary.'
  ].join(' ');

  const userPrompt = [
    `Generate content for: ${keywords}`,
    `Post Type: ${normalizedPostType}`,
    `Tone: ${tone}`,
    normalizedPostType === 'Post'
      ? 'Create a normal social media post: one hook + one final caption + hashtags + CTA. Do not include slides/scenes/instructions.'
      : normalizedPostType === 'Carousel'
        ? 'Create carousel-ready output with concise slide-wise points and supporting caption.'
        : 'Create reel-ready output with a concise final reel script and supporting caption.',
    'Also provide content.image_prompt as a high-quality visual generation prompt for an Instagram-ready image that matches the post.',
    'Required JSON shape:',
    JSON.stringify(requiredShape, null, 2)
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

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function estimateAnthropicCost(inputTokens, outputTokens) {
  const usdToInr = toNumber(process.env.AI_COST_USD_TO_INR, 83);
  const inputPerMillion = toNumber(process.env.ANTHROPIC_INPUT_PER_MILLION_USD, 3);
  const outputPerMillion = toNumber(process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD, 15);
  const inputUsd = (Math.max(0, inputTokens) / 1_000_000) * inputPerMillion;
  const outputUsd = (Math.max(0, outputTokens) / 1_000_000) * outputPerMillion;
  const totalUsd = inputUsd + outputUsd;
  const totalInr = totalUsd * usdToInr;
  return {
    estimated_cost_usd: Number(totalUsd.toFixed(6)),
    estimated_cost_inr: Number(totalInr.toFixed(4))
  };
}

function normalizeMarketingResponse(payload, input) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('AI returned empty payload');
  }

  const content = payload.content && typeof payload.content === 'object' ? payload.content : {};
  const design = payload.design_suggestion && typeof payload.design_suggestion === 'object'
    ? payload.design_suggestion
    : {};

  const normalizedPostType = normalizePostType(payload.post_type || input.postType || '');
  const fallbackImagePrompt = [
    `${normalizedPostType} creative for BodyBank fitness brand`,
    `Target topic: ${input.keywords}`,
    `Tone: ${input.tone || ''}`,
    'Instagram post style, premium modern layout, high contrast, clean typography',
    'No watermarks, no logos from other brands, no blurry text'
  ].join('. ');

  const imagePrompt = String(content.image_prompt || payload.image_prompt || fallbackImagePrompt).trim();
  const imageUrl = buildMarketingImageUrl({
    imagePrompt,
    postType: normalizedPostType,
    keywords: input.keywords || '',
    tone: input.tone || '',
    hook: String(content.hook || ''),
    caption: String(content.caption || '')
  });

  const base = {
    title: String(payload.title || `Marketing Content for ${input.keywords}`).trim(),
    input_keywords: String(payload.input_keywords || input.keywords || '').trim(),
    post_type: normalizedPostType,
    content: {
      hook: String(content.hook || '').trim(),
      caption: String(content.caption || '').trim(),
      carousel_slides: Array.isArray(content.carousel_slides)
        ? content.carousel_slides.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      reel_script: String(content.reel_script || '').trim(),
      whatsapp_message: String(content.whatsapp_message || '').trim(),
      image_prompt: imagePrompt
    },
    hashtags: Array.isArray(payload.hashtags)
      ? payload.hashtags.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    cta: String(payload.cta || '').trim(),
    design_suggestion: {
      theme: String(design.theme || '').trim(),
      colors: String(design.colors || '').trim(),
      visual_idea: String(design.visual_idea || '').trim()
    },
    image_url: imageUrl
  };

  if (normalizedPostType === 'Post') {
    base.content.carousel_slides = [];
    base.content.reel_script = '';
    base.content.whatsapp_message = '';
  } else if (normalizedPostType === 'Carousel') {
    base.content.reel_script = '';
    base.content.whatsapp_message = '';
  } else if (normalizedPostType === 'Reel') {
    base.content.carousel_slides = [];
    base.content.whatsapp_message = '';
  }

  return base;
}

function buildMarketingImageUrl({ imagePrompt, postType, keywords, tone, hook, caption }) {
  const params = new URLSearchParams({
    postType: String(postType || 'Post').slice(0, 30),
    keywords: String(keywords || '').slice(0, 160),
    tone: String(tone || '').slice(0, 50),
    hook: String(hook || '').slice(0, 180),
    caption: String(caption || '').slice(0, 280),
    prompt: String(imagePrompt || '').slice(0, 900),
    seed: String(Math.floor(Date.now() / 1000))
  });
  return `/api/marketing-ai/visual?${params.toString()}`;
}

async function callSonetApi({ keywords, postType, tone }) {
  const apiKey = String(
    process.env.SONET_API_KEY ||
    process.env.SONNET_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    ''
  ).trim();
  if (!apiKey) {
    throw new Error('Marketing AI API key missing. Set SONET_API_KEY (or SONNET_API_KEY / ANTHROPIC_API_KEY).');
  }

  const endpoint = String(process.env.SONET_API_URL || 'https://api.anthropic.com/v1/messages').trim();
  const model = String(process.env.SONET_MODEL || 'claude-sonnet-4-6').trim();
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
  const inputTokens = toNumber(apiData && apiData.usage && apiData.usage.input_tokens, 0);
  const outputTokens = toNumber(apiData && apiData.usage && apiData.usage.output_tokens, 0);
  const contentBlocks = Array.isArray(apiData && apiData.content) ? apiData.content : [];
  const textReply = contentBlocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const parsed = extractJsonObject(textReply);
  if (!parsed) {
    throw new Error('Invalid JSON returned from Sonet API');
  }

  const data = normalizeMarketingResponse(parsed, { keywords, postType, tone });
  const usage = {
    provider: 'anthropic',
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...estimateAnthropicCost(inputTokens, outputTokens)
  };
  return { data, usage };
}

module.exports = { callSonetApi, normalizeMarketingResponse };
