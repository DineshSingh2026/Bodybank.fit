(function () {
  const SESSION_KEY = 'bodybank_session';
  const state = {
    lastPayload: null,
    lastInput: null,
    sessionUsage: {
      totalTokens: 0,
      totalInr: 0
    }
  };

  const el = {
    keywordsInput: document.getElementById('keywordsInput'),
    postTypeInput: document.getElementById('postTypeInput'),
    toneInput: document.getElementById('toneInput'),
    generateBtn: document.getElementById('generateBtn'),
    regenerateBtn: document.getElementById('regenerateBtn'),
    loading: document.getElementById('loading'),
    usageMeta: document.getElementById('usageMeta'),
    usageTotals: document.getElementById('usageTotals'),
    errorMessage: document.getElementById('errorMessage'),
    outputCard: document.getElementById('outputCard'),
    outputSections: document.getElementById('outputSections'),
    imagePreviewWrap: document.getElementById('imagePreviewWrap'),
    generatedImagePreview: document.getElementById('generatedImagePreview'),
    downloadImageBtn: document.getElementById('downloadImageBtn'),
    downloadCaptionBtn: document.getElementById('downloadCaptionBtn'),
    downloadCarouselBtn: document.getElementById('downloadCarouselBtn'),
    downloadFullBtn: document.getElementById('downloadFullBtn'),
    historyList: document.getElementById('historyList'),
    refreshHistoryBtn: document.getElementById('refreshHistoryBtn')
  };

  function getToken() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed.token : '';
    } catch (e) {
      return '';
    }
  }

  async function apiRequest(url, options) {
    const token = getToken();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, Object.assign({}, options, { headers }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  function setLoading(isLoading) {
    el.loading.classList.toggle('hidden', !isLoading);
    el.generateBtn.disabled = isLoading;
    el.regenerateBtn.disabled = isLoading;
  }

  function showError(message) {
    if (!message) {
      el.errorMessage.textContent = '';
      el.errorMessage.classList.add('hidden');
      return;
    }
    el.errorMessage.textContent = message;
    el.errorMessage.classList.remove('hidden');
  }

  function parseUsage(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const input = Number(src.input_tokens || 0);
    const output = Number(src.output_tokens || 0);
    const total = Number(src.total_tokens || (input + output));
    const inr = Number(src.estimated_cost_inr || 0);
    const usd = Number(src.estimated_cost_usd || 0);
    return {
      provider: String(src.provider || 'anthropic'),
      model: String(src.model || ''),
      input_tokens: Number.isFinite(input) ? input : 0,
      output_tokens: Number.isFinite(output) ? output : 0,
      total_tokens: Number.isFinite(total) ? total : 0,
      estimated_cost_inr: Number.isFinite(inr) ? inr : 0,
      estimated_cost_usd: Number.isFinite(usd) ? usd : 0
    };
  }

  function formatUsageMeta(usage) {
    if (!usage) return '';
    return `Usage: ${usage.total_tokens} tokens (in ${usage.input_tokens} / out ${usage.output_tokens}) | Rs ${usage.estimated_cost_inr.toFixed(2)}${usage.model ? ` | ${usage.model}` : ''}`;
  }

  function updateUsageUi(rawUsage) {
    if (!rawUsage) {
      el.usageMeta.textContent = '';
      el.usageMeta.classList.add('hidden');
      return;
    }
    const usage = parseUsage(rawUsage);
    el.usageMeta.textContent = formatUsageMeta(usage);
    el.usageMeta.classList.remove('hidden');
    state.sessionUsage.totalTokens += usage.total_tokens;
    state.sessionUsage.totalInr += usage.estimated_cost_inr;
    el.usageTotals.textContent = `Session total: ${state.sessionUsage.totalTokens} tokens | Rs ${state.sessionUsage.totalInr.toFixed(2)}`;
  }

  function formatValue(value) {
    if (Array.isArray(value)) {
      if (!value.length) return '-';
      return value.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).map((k) => `${k}: ${value[k]}`).join('\n');
    }
    return String(value || '-');
  }

  function normalizePostType(postType) {
    const raw = String(postType || '').trim().toLowerCase();
    if (raw === 'carousel') return 'Carousel';
    if (raw === 'reel') return 'Reel';
    return 'Post';
  }

  function createOutputBlock(title, value) {
    const wrapper = document.createElement('article');
    wrapper.className = 'output-block';

    const head = document.createElement('div');
    head.className = 'output-block-head';

    const titleEl = document.createElement('h3');
    titleEl.className = 'output-title';
    titleEl.textContent = title;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const text = formatValue(value);
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1000);
      } catch (e) {
        alert('Could not copy. Please copy manually.');
      }
    });

    const content = document.createElement('div');
    content.className = 'output-content';
    content.textContent = formatValue(value);

    head.appendChild(titleEl);
    head.appendChild(copyBtn);
    wrapper.appendChild(head);
    wrapper.appendChild(content);
    return wrapper;
  }

  function renderOutput(payload) {
    if (!payload) return;
    state.lastPayload = payload;
    el.outputSections.innerHTML = '';
    const postType = normalizePostType(payload.post_type || state.lastInput?.postType || '');
    let blocks = [];
    if (postType === 'Post') {
      blocks = [
        ['Hook', payload.content?.hook],
        ['Caption', payload.content?.caption],
        ['Hashtags', payload.hashtags || []],
        ['CTA', payload.cta],
        ['Design Suggestions', payload.design_suggestion || {}]
      ];
    } else if (postType === 'Carousel') {
      blocks = [
        ['Hook', payload.content?.hook],
        ['Caption', payload.content?.caption],
        ['Carousel Slides', payload.content?.carousel_slides || []],
        ['Hashtags', payload.hashtags || []],
        ['CTA', payload.cta],
        ['Design Suggestions', payload.design_suggestion || {}]
      ];
    } else {
      blocks = [
        ['Hook', payload.content?.hook],
        ['Caption', payload.content?.caption],
        ['Reel Script', payload.content?.reel_script],
        ['Hashtags', payload.hashtags || []],
        ['CTA', payload.cta],
        ['Design Suggestions', payload.design_suggestion || {}]
      ];
    }

    blocks.forEach(([title, value]) => {
      el.outputSections.appendChild(createOutputBlock(title, value));
    });

    const imageUrl = String(payload.image_url || '').trim();
    if (imageUrl) {
      el.generatedImagePreview.src = imageUrl;
      el.generatedImagePreview.alt = `${postType} creative`;
      el.imagePreviewWrap.classList.remove('hidden');
      el.downloadImageBtn.classList.remove('hidden');
    } else {
      el.generatedImagePreview.removeAttribute('src');
      el.imagePreviewWrap.classList.add('hidden');
      el.downloadImageBtn.classList.add('hidden');
    }

    el.downloadCaptionBtn.textContent = postType === 'Post' ? 'Download Post' : 'Download Caption';
    el.downloadCarouselBtn.classList.toggle('hidden', postType !== 'Carousel');
    el.downloadFullBtn.textContent = postType === 'Post' ? 'Download Post Full' : 'Download Full Content';

    el.outputCard.classList.remove('hidden');
  }

  function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function getCaptionText(payload) {
    return payload?.content?.caption || '';
  }

  function getCarouselText(payload) {
    const slides = payload?.content?.carousel_slides || [];
    return slides.map((item, idx) => `Slide ${idx + 1}: ${item}`).join('\n');
  }

  function getFullText(payload) {
    if (!payload) return '';
    const postType = normalizePostType(payload.post_type || state.lastInput?.postType || '');
    if (postType === 'Post') {
      return [
        `Title: ${payload.title || ''}`,
        `Keywords: ${payload.input_keywords || ''}`,
        `Post Type: Post`,
        '',
        `Hook:\n${payload.content?.hook || ''}`,
        '',
        `Caption:\n${payload.content?.caption || ''}`,
        '',
        `Hashtags:\n${(payload.hashtags || []).join(' ')}`,
        '',
        `CTA:\n${payload.cta || ''}`,
        '',
        `Design Suggestion:\nTheme: ${payload.design_suggestion?.theme || ''}\nColors: ${payload.design_suggestion?.colors || ''}\nVisual Idea: ${payload.design_suggestion?.visual_idea || ''}`,
        '',
        `Image URL:\n${payload.image_url || ''}`,
        '',
        `Image Prompt:\n${payload.content?.image_prompt || ''}`
      ].join('\n');
    }
    if (postType === 'Carousel') {
      return [
        `Title: ${payload.title || ''}`,
        `Keywords: ${payload.input_keywords || ''}`,
        `Post Type: Carousel`,
        '',
        `Hook:\n${payload.content?.hook || ''}`,
        '',
        `Caption:\n${payload.content?.caption || ''}`,
        '',
        `Carousel Slides:\n${getCarouselText(payload)}`,
        '',
        `Hashtags:\n${(payload.hashtags || []).join(' ')}`,
        '',
        `CTA:\n${payload.cta || ''}`,
        '',
        `Design Suggestion:\nTheme: ${payload.design_suggestion?.theme || ''}\nColors: ${payload.design_suggestion?.colors || ''}\nVisual Idea: ${payload.design_suggestion?.visual_idea || ''}`,
        '',
        `Image URL:\n${payload.image_url || ''}`,
        '',
        `Image Prompt:\n${payload.content?.image_prompt || ''}`
      ].join('\n');
    }
    return [
      `Title: ${payload.title || ''}`,
      `Keywords: ${payload.input_keywords || ''}`,
      `Post Type: Reel`,
      '',
      `Hook:\n${payload.content?.hook || ''}`,
      '',
      `Caption:\n${payload.content?.caption || ''}`,
      '',
      `Reel Script:\n${payload.content?.reel_script || ''}`,
      '',
      `Hashtags:\n${(payload.hashtags || []).join(' ')}`,
      '',
      `CTA:\n${payload.cta || ''}`,
      '',
      `Design Suggestion:\nTheme: ${payload.design_suggestion?.theme || ''}\nColors: ${payload.design_suggestion?.colors || ''}\nVisual Idea: ${payload.design_suggestion?.visual_idea || ''}`,
      '',
      `Image URL:\n${payload.image_url || ''}`,
      '',
      `Image Prompt:\n${payload.content?.image_prompt || ''}`
    ].join('\n');
  }

  function downloadBlobAsFile(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  async function convertSvgBlobToPngBlob(svgBlob) {
    return new Promise((resolve, reject) => {
      try {
        const image = new Image();
        const svgUrl = URL.createObjectURL(svgBlob);
        image.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || 1080;
            canvas.height = image.naturalHeight || 1350;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            canvas.toBlob((pngBlob) => {
              URL.revokeObjectURL(svgUrl);
              if (!pngBlob) return reject(new Error('PNG conversion failed'));
              resolve(pngBlob);
            }, 'image/png');
          } catch (err) {
            URL.revokeObjectURL(svgUrl);
            reject(err);
          }
        };
        image.onerror = () => {
          URL.revokeObjectURL(svgUrl);
          reject(new Error('SVG load failed'));
        };
        image.src = svgUrl;
      } catch (e) {
        reject(e);
      }
    });
  }

  async function downloadImageFromUrl(imageUrl, fallbackFilename) {
    const safeUrl = String(imageUrl || '').trim();
    if (!safeUrl) return;
    try {
      const res = await fetch(safeUrl);
      if (!res.ok) throw new Error('Image request failed');
      const blob = await res.blob();
      const isSvg = (blob.type || '').toLowerCase().includes('svg') || safeUrl.includes('/api/marketing-ai/visual');
      if (isSvg) {
        const pngBlob = await convertSvgBlobToPngBlob(blob);
        downloadBlobAsFile(pngBlob, fallbackFilename);
      } else {
        downloadBlobAsFile(blob, fallbackFilename);
      }
    } catch (e) {
      // Fallback for CORS-restricted image hosts.
      const a = document.createElement('a');
      a.href = safeUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  async function generateContent() {
    showError('');
    const keywords = el.keywordsInput.value.trim();
    const postType = el.postTypeInput.value;
    const tone = el.toneInput.value;
    if (!keywords) {
      showError('Please enter keywords.');
      return;
    }

    state.lastInput = { keywords, postType, tone };
    setLoading(true);
    try {
      const result = await apiRequest('/api/marketing-ai/generate', {
        method: 'POST',
        body: JSON.stringify({ keywords, postType, tone })
      });
      renderOutput(result.data);
      updateUsageUi(result.usage || null);
      await loadHistory();
    } catch (e) {
      showError(e.message || 'Could not generate content. Please check API key and model settings.');
    } finally {
      setLoading(false);
    }
  }

  async function regenerateContent() {
    if (!state.lastInput) {
      return generateContent();
    }
    setLoading(true);
    showError('');
    try {
      const result = await apiRequest('/api/marketing-ai/generate', {
        method: 'POST',
        body: JSON.stringify(state.lastInput)
      });
      renderOutput(result.data);
      updateUsageUi(result.usage || null);
      await loadHistory();
    } catch (e) {
      showError(e.message || 'Could not regenerate content');
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    try {
      const result = await apiRequest('/api/marketing-ai/history', { method: 'GET' });
      const items = result.items || [];
      el.historyList.innerHTML = '';
      if (!items.length) {
        el.historyList.innerHTML = '<div class="history-item">No history yet.</div>';
        return;
      }

      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'history-item';
        const title = document.createElement('div');
        title.className = 'history-title';
        title.textContent = `${item.keywords} (${item.post_type}, ${item.tone})`;
        const meta = document.createElement('div');
        meta.className = 'history-meta';
        meta.textContent = new Date(item.created_at).toLocaleString();
        row.appendChild(title);
        row.appendChild(meta);
        row.addEventListener('click', () => renderOutput(item.response_json));
        el.historyList.appendChild(row);
      });
    } catch (e) {
      el.historyList.innerHTML = '<div class="history-item">Could not load history.</div>';
    }
  }

  el.generateBtn.addEventListener('click', generateContent);
  el.regenerateBtn.addEventListener('click', regenerateContent);
  el.refreshHistoryBtn.addEventListener('click', loadHistory);

  el.downloadCaptionBtn.addEventListener('click', () => {
    if (!state.lastPayload) return;
    const postType = normalizePostType(state.lastPayload.post_type || state.lastInput?.postType || '');
    const fileName = postType === 'Post' ? 'post.txt' : 'caption.txt';
    downloadFile(fileName, getCaptionText(state.lastPayload));
  });

  el.downloadImageBtn.addEventListener('click', () => {
    if (!state.lastPayload) return;
    const postType = normalizePostType(state.lastPayload.post_type || state.lastInput?.postType || '');
    const filename = postType === 'Reel' ? 'reel-image.png' : postType === 'Carousel' ? 'carousel-image.png' : 'post-image.png';
    downloadImageFromUrl(state.lastPayload.image_url, filename);
  });

  el.downloadCarouselBtn.addEventListener('click', () => {
    if (!state.lastPayload) return;
    const postType = normalizePostType(state.lastPayload.post_type || state.lastInput?.postType || '');
    if (postType !== 'Carousel') return;
    downloadFile('carousel.txt', getCarouselText(state.lastPayload));
  });

  el.downloadFullBtn.addEventListener('click', () => {
    if (!state.lastPayload) return;
    const postType = normalizePostType(state.lastPayload.post_type || state.lastInput?.postType || '');
    const fileName = postType === 'Post' ? 'post-full.txt' : postType === 'Carousel' ? 'carousel-full.txt' : 'reel-full.txt';
    downloadFile(fileName, getFullText(state.lastPayload));
  });

  loadHistory();
})();
