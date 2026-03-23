(function () {
  const SESSION_KEY = 'bodybank_session';
  const state = {
    lastPayload: null,
    lastInput: null
  };

  const el = {
    keywordsInput: document.getElementById('keywordsInput'),
    postTypeInput: document.getElementById('postTypeInput'),
    toneInput: document.getElementById('toneInput'),
    generateBtn: document.getElementById('generateBtn'),
    regenerateBtn: document.getElementById('regenerateBtn'),
    loading: document.getElementById('loading'),
    errorMessage: document.getElementById('errorMessage'),
    outputCard: document.getElementById('outputCard'),
    outputSections: document.getElementById('outputSections'),
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

    const blocks = [
      ['Hook', payload.content?.hook],
      ['Caption', payload.content?.caption],
      ['Carousel Slides', payload.content?.carousel_slides || []],
      ['Reel Script', payload.content?.reel_script],
      ['WhatsApp Message', payload.content?.whatsapp_message],
      ['Hashtags', payload.hashtags || []],
      ['CTA', payload.cta],
      ['Design Suggestions', payload.design_suggestion || {}]
    ];

    blocks.forEach(([title, value]) => {
      el.outputSections.appendChild(createOutputBlock(title, value));
    });

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
    return [
      `Title: ${payload.title || ''}`,
      `Keywords: ${payload.input_keywords || ''}`,
      `Post Type: ${payload.post_type || ''}`,
      '',
      `Hook:\n${payload.content?.hook || ''}`,
      '',
      `Caption:\n${payload.content?.caption || ''}`,
      '',
      `Carousel Slides:\n${getCarouselText(payload)}`,
      '',
      `Reel Script:\n${payload.content?.reel_script || ''}`,
      '',
      `WhatsApp Message:\n${payload.content?.whatsapp_message || ''}`,
      '',
      `Hashtags:\n${(payload.hashtags || []).join(' ')}`,
      '',
      `CTA:\n${payload.cta || ''}`,
      '',
      `Design Suggestion:\nTheme: ${payload.design_suggestion?.theme || ''}\nColors: ${payload.design_suggestion?.colors || ''}\nVisual Idea: ${payload.design_suggestion?.visual_idea || ''}`
    ].join('\n');
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
    downloadFile('caption.txt', getCaptionText(state.lastPayload));
  });

  el.downloadCarouselBtn.addEventListener('click', () => {
    if (!state.lastPayload) return;
    downloadFile('carousel.txt', getCarouselText(state.lastPayload));
  });

  el.downloadFullBtn.addEventListener('click', () => {
    if (!state.lastPayload) return;
    downloadFile('marketing.txt', getFullText(state.lastPayload));
  });

  loadHistory();
})();
