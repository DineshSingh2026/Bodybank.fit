/* ============================================================================
   FitChef Nutrition Assessment — the form.
   ----------------------------------------------------------------------------
   Renders entirely from the schema the server serves, so a question can never
   appear here and be dropped on submit. Three jobs beyond drawing inputs:

     1. Never ask twice. Anything the DB can already evidence arrives in
        `prefill`, is written straight into the answer state, and is shown as a
        "confirm this" card at the top of the step rather than as blank fields.
        A member who logs steps and sleep daily should not be typing them again.
     2. Pay out early. The teaser after Step 3 hands over real numbers before
        asking for the expensive stuff — it is the single biggest thing keeping
        people in a form this long.
     3. Never lose work. Every change is debounced to the server and mirrored to
        localStorage, so a dropped connection or a closed tab costs nothing.
   ========================================================================== */

(function () {
  'use strict';

  var API = '/api/nutrition-assessment';
  var LS_KEY = 'fitchef_assessment_draft';

  var S = {
    steps: [],          // schema
    answers: {},        // flat: key -> value
    prefill: {},        // key -> { value, source }
    confirmed: {},      // step key -> true once the member has accepted the card
    idx: -1,            // -1 = intro, 0..n-1 = steps, n = review
    token: '',          // BodyBank member JWT, if we are inside a logged-in browser
    invite: '',         // ?t= token from an admin-sent link
    isMember: false,
    saving: false,
    dirty: false,
    submitted: false,
    draftId: '',        // returned by PUT /draft; addresses uploads for cold visitors
    part: 1,            // which part this page is rendering
    nextPart: null,     // what the member should do after this one
    part1Done: false,
    part2Done: false,
    partMeta: null,
    totalParts: 2,
    files: {}           // field key -> [{name, original}]
  };

  // ── tiny helpers ────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  function isEmpty(v) {
    return v == null || v === '' || v === false ||
      (Array.isArray(v) && !v.length) ||
      (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (S.token) opts.headers.Authorization = 'Bearer ' + S.token;
    if (body) opts.body = JSON.stringify(body);
    var url = API + path;
    // The invite token rides in the query string so it survives every method.
    if (S.invite && !S.token) url += (url.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(S.invite);
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = {};
        try { data = t ? JSON.parse(t) : {}; } catch (e) { data = { error: 'Unexpected server response' }; }
        if (!r.ok) { data._status = r.status; return Promise.reject(data); }
        return data;
      });
    });
  }

  /** Mirror of the server's schema.matches — the same clause grammar. */
  function matches(clause) {
    if (!clause) return true;
    if (Array.isArray(clause.any)) return clause.any.some(matches);
    if (Array.isArray(clause.all)) return clause.all.every(matches);
    var raw = clause.field === '_is_member' ? (S.isMember ? 'yes' : 'no') : S.answers[clause.field];
    var list = Array.isArray(raw) ? raw.map(String) : (raw == null || raw === '' ? [] : [String(raw)]);
    if (clause.truthy) return list.length > 0;
    if (clause.has) return clause.has.some(function (v) { return list.indexOf(v) !== -1; });
    if (clause.in) return clause.in.some(function (v) { return list.indexOf(String(v)) !== -1; });
    if (clause.not) return list.length ? !clause.not.some(function (v) { return list.indexOf(String(v)) !== -1; }) : false;
    return true;
  }

  function visibleFields(step) {
    return step.fields.filter(function (f) { return !f.when || matches(f.when); });
  }

  /**
   * Keys that some other field's visibility depends on. Answering one of these
   * has to repaint the step; answering anything else does not — and repainting
   * a twenty-field step on every tap threw away scroll position and made the
   * chips feel laggy on a phone. Computed once from the schema.
   */
  var _triggers = null;
  function isTrigger(key) {
    if (!_triggers) {
      _triggers = {};
      var walk = function (c) {
        if (!c) return;
        if (c.any) return c.any.forEach(walk);
        if (c.all) return c.all.forEach(walk);
        if (c.field) _triggers[c.field] = true;
      };
      S.steps.forEach(function (st) { st.fields.forEach(function (f) { walk(f.when); }); });
    }
    return !!_triggers[key];
  }

  /** Repaint one field's chips from state, without touching the rest of the step. */
  function repaintChips(key) {
    var host = document.querySelector('[data-fc-field="' + key + '"]');
    if (!host) return;
    var v = S.answers[key];
    var list = Array.isArray(v) ? v.map(String) : (v == null || v === '' ? [] : [String(v)]);
    host.querySelectorAll('[data-fc-chip]').forEach(function (b) {
      var on = list.indexOf(b.getAttribute('data-val')) !== -1;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var err = host.querySelector('[data-fc-err]');
    if (err && list.length) { err.classList.add('fc-hidden'); host.classList.remove('is-invalid'); }
  }

  /** Answers nested by step, the shape the API stores. */
  function nested() {
    var out = {};
    S.steps.forEach(function (step) {
      var bag = {};
      step.fields.forEach(function (f) {
        if (!isEmpty(S.answers[f.key]) || S.answers[f.key] === true) bag[f.key] = S.answers[f.key];
      });
      if (Object.keys(bag).length) out[step.key] = bag;
    });
    return out;
  }

  // ── persistence ─────────────────────────────────────────────────────────

  var saveTimer = null;
  function markSaving(text) { var n = el('fcSave'); if (n) n.textContent = text || ''; }

  function cacheLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ answers: S.answers, idx: S.idx, confirmed: S.confirmed, at: Date.now() }));
    } catch (e) { /* private mode — the server draft is the real one anyway */ }
  }

  function scheduleSave() {
    S.dirty = true;
    cacheLocal();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(pushDraft, 1200);
  }

  function pushDraft() {
    if (S.submitted) return Promise.resolve();
    if (!S.dirty) return Promise.resolve();
    // Nothing to key a server-side draft on until we know who this is.
    if (!S.isMember && !S.invite && !S.answers.email) return Promise.resolve();
    S.dirty = false;
    S.saving = true;
    markSaving('Saving…');
    return api('PUT', '/draft', { answers: nested(), last_step: Math.max(1, S.idx + 1), part: S.part })
      .then(function (d) {
        if (d && d.id) S.draftId = d.id;
        markSaving('Saved — you can close this and come back.');
      })
      .catch(function () { S.dirty = true; markSaving('Saved on this device. We will sync when you are back online.'); })
      .then(function () { S.saving = false; });
  }

  function setAnswer(key, value) {
    S.answers[key] = value;
    scheduleSave();
  }

  // ── field renderers ─────────────────────────────────────────────────────

  function srcTag(key) {
    var p = S.prefill[key];
    if (!p || !p.source) return '';
    return '<span class="fc-src">' + esc(p.source) + '</span>';
  }

  function head(f) {
    return '<label class="fc-field-label" for="fc_' + esc(f.key) + '">' + esc(f.label)
      + (f.required ? '<span class="fc-req" title="Required">*</span>' : '') + '</label>'
      + srcTag(f.key)
      + (f.help ? '<p class="fc-help">' + esc(f.help) + '</p>' : '');
  }

  function chips(f, values, selected, multi) {
    return '<div class="fc-chips" role="' + (multi ? 'group' : 'radiogroup') + '" aria-label="' + esc(f.label) + '">'
      + values.map(function (o) {
        var on = multi ? selected.indexOf(o) !== -1 : String(selected) === String(o);
        return '<button type="button" class="fc-chip' + (on ? ' on' : '') + '"'
          + ' data-fc-chip="' + esc(f.key) + '" data-val="' + esc(o) + '"'
          + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(o) + '</button>';
      }).join('') + '</div>';
  }

  function renderField(f) {
    var v = S.answers[f.key];
    var body = '';

    switch (f.type) {
      case 'select':
        body = chips(f, f.options || [], v == null ? '' : v, false);
        break;

      case 'multi':
        body = chips(f, f.options || [], Array.isArray(v) ? v : [], true);
        break;

      case 'yesno':
        body = '<div class="fc-yesno">' + ['Yes', 'No'].map(function (o) {
          var on = String(v) === o;
          return '<button type="button" class="fc-chip' + (on ? ' on' : '') + '" data-fc-chip="' + esc(f.key)
            + '" data-val="' + o + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + o + '</button>';
        }).join('') + '</div>';
        break;

      case 'textarea':
        body = '<textarea class="fc-textarea" id="fc_' + esc(f.key) + '" data-fc-input="' + esc(f.key) + '"'
          + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '')
          + ' placeholder="' + esc(f.placeholder || '') + '">' + esc(v || '') + '</textarea>';
        break;

      case 'number':
        body = '<div class="fc-unit-row"><input class="fc-input" type="number" inputmode="decimal" id="fc_' + esc(f.key) + '"'
          + ' data-fc-input="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '"'
          + (f.step ? ' step="' + esc(f.step) + '"' : '') + ' placeholder="' + esc(f.placeholder || '') + '">'
          + (f.unit ? '<span class="fc-unit">' + esc(f.unit) + '</span>' : '') + '</div>';
        break;

      case 'date':
      case 'time':
      case 'email':
      case 'tel':
      case 'text':
        body = '<input class="fc-input" type="' + f.type + '" id="fc_' + esc(f.key) + '" data-fc-input="' + esc(f.key) + '"'
          + ' value="' + esc(v == null ? '' : v) + '"'
          + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '')
          + (f.type === 'tel' ? ' inputmode="tel"' : '')
          + ' placeholder="' + esc(f.placeholder || '') + '">';
        break;

      case 'height':
        body = renderHeight(f, v);
        break;

      case 'slider':
        // A slider renders at its midpoint whether or not it has been touched,
        // so it LOOKS answered. Record that default as the real answer at render
        // time — otherwise someone happy with the middle value presses Continue
        // and gets "this one is required" pointing at a field that looks filled.
        var sv = v || Math.round(((f.min || 1) + (f.max || 10)) / 2);
        if (isEmpty(v)) S.answers[f.key] = sv;
        body = '<div class="fc-slider-row">'
          + '<input class="fc-slider" type="range" id="fc_' + esc(f.key) + '" data-fc-slider="' + esc(f.key) + '"'
          + ' min="' + (f.min || 1) + '" max="' + (f.max || 10) + '" step="1" value="' + sv + '">'
          + '<span class="fc-slider-val" id="fcSlv_' + esc(f.key) + '">' + sv + '</span></div>'
          + '<div class="fc-scale"><span>Calm</span><span>Breaking point</span></div>';
        break;

      case 'tags':
        body = renderTags(f, Array.isArray(v) ? v : []);
        break;

      case 'recall':
        body = renderRecall(f, v || {});
        break;

      case 'grid':
        body = renderGrid(f, v || {});
        break;

      case 'labs':
        body = renderLabs(f, v || {});
        break;

      case 'files':
        body = renderFiles(f);
        break;

      case 'consent':
        return '<div class="fc-field" data-fc-field="' + esc(f.key) + '">'
          + '<label class="fc-consent"><input type="checkbox" data-fc-consent="' + esc(f.key) + '"'
          + (v ? ' checked' : '') + '><span>' + esc(f.text || f.label)
          + (f.required ? ' <strong>(required)</strong>' : '') + '</span></label>'
          + '<div class="fc-err fc-hidden" data-fc-err="' + esc(f.key) + '"></div></div>';

      default:
        body = '<input class="fc-input" id="fc_' + esc(f.key) + '" data-fc-input="' + esc(f.key) + '" value="' + esc(v || '') + '">';
    }

    return '<div class="fc-field" data-fc-field="' + esc(f.key) + '">' + head(f) + body
      + '<div class="fc-err fc-hidden" data-fc-err="' + esc(f.key) + '"></div></div>';
  }

  function renderHeight(f, v) {
    var mode = S._heightMode || 'cm';
    var ft = '', inch = '';
    if (v) { var total = Math.round(Number(v) / 2.54); ft = Math.floor(total / 12); inch = total % 12; }
    return '<div class="fc-height-tabs" role="group" aria-label="Height unit">'
      + '<button type="button" data-fc-hmode="cm" class="' + (mode === 'cm' ? 'on' : '') + '">cm</button>'
      + '<button type="button" data-fc-hmode="ftin" class="' + (mode === 'ftin' ? 'on' : '') + '">ft / in</button></div>'
      + (mode === 'cm'
        ? '<div class="fc-unit-row"><input class="fc-input" type="number" inputmode="decimal" id="fc_' + esc(f.key) + '"'
          + ' data-fc-input="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '"><span class="fc-unit">cm</span></div>'
        : '<div class="fc-ftin">'
          + '<div class="fc-unit-row"><input class="fc-input" type="number" inputmode="numeric" data-fc-ft value="' + ft + '"><span class="fc-unit">ft</span></div>'
          + '<div class="fc-unit-row"><input class="fc-input" type="number" inputmode="numeric" data-fc-in value="' + inch + '"><span class="fc-unit">in</span></div></div>');
  }

  function renderTags(f, list) {
    return '<div class="fc-tags" data-fc-taglist="' + esc(f.key) + '">'
      + list.map(function (t, i) {
        return '<span class="fc-tag">' + esc(t) + '<button type="button" data-fc-tagdel="' + esc(f.key)
          + '" data-i="' + i + '" aria-label="Remove ' + esc(t) + '">×</button></span>';
      }).join('') + '</div>'
      + '<input class="fc-input" id="fc_' + esc(f.key) + '" data-fc-tagadd="' + esc(f.key) + '"'
      + ' placeholder="' + esc(f.placeholder || 'Type and press Enter') + '">';
  }

  function renderRecall(f, v) {
    return '<div class="fc-recall">' + (f.meals || []).map(function (m) {
      return '<div class="fc-recall-row">'
        + '<div class="fc-recall-top"><span class="fc-recall-name">' + esc(m.label) + '</span>'
        + '<input class="fc-input fc-recall-time" type="time" data-fc-recall-time="' + esc(m.key) + '" data-key="' + esc(f.key) + '"'
        + ' value="' + esc((v[m.key] || {}).at || '') + '" aria-label="' + esc(m.label) + ' time"></div>'
        + '<input class="fc-input" data-fc-recall="' + esc(m.key) + '" data-key="' + esc(f.key) + '"'
        + ' value="' + esc((v[m.key] || {}).what || '') + '" placeholder="' + esc(m.placeholder) + '">'
        + '</div>';
    }).join('') + '</div>';
  }

  // Twenty-one foods x five frequencies. A real table needs ~560px, which on a
  // phone means horizontally scrolling every single row — unusable for the block
  // the whole plan leans on. So each food is its own row of five buttons that
  // shrink to fit, with the full column names given once as a legend.
  var GRID_SHORT = { 'Never': 'Never', '1–2× week': '1–2', '3–4× week': '3–4', 'Daily': 'Daily', 'Multiple times daily': '2×+' };

  function renderGrid(f, v) {
    var cols = f.cols || [];
    var done = 0;
    var rows = (f.rows || []).map(function (r) {
      var picked = v[r.key] || '';
      if (picked) done++;
      return '<div class="fc-fr' + (picked ? ' done' : '') + '" data-fc-frrow="' + esc(r.key) + '">'
        + '<div class="fc-fr-name">' + esc(r.label) + '</div>'
        + '<div class="fc-fr-opts">' + cols.map(function (c) {
          return '<button type="button" class="fc-fr-b' + (picked === c ? ' on' : '') + '"'
            + ' data-fc-grid="' + esc(f.key) + '" data-row="' + esc(r.key) + '" data-col="' + esc(c) + '"'
            + ' aria-label="' + esc(r.label + ': ' + c) + '" aria-pressed="' + (picked === c ? 'true' : 'false') + '">'
            + esc(GRID_SHORT[c] || c) + '</button>';
        }).join('') + '</div></div>';
    }).join('');
    var legend = '<div class="fc-fr-legend">' + cols.map(function (c) {
      var short = GRID_SHORT[c] || c;
      return '<span>' + esc(short) + (short === c ? '' : ' = ' + esc(c)) + '</span>';
    }).join('') + '</div>';
    return legend + '<div class="fc-fr-list">' + rows + '</div>'
      + '<p class="fc-grid-hint" data-fc-gridcount="' + esc(f.key) + '">' + done + ' of ' + (f.rows || []).length + ' answered</p>';
  }

  function renderLabs(f, v) {
    var open = S['_labsOpen'] || Object.keys(v).length > 0;
    return '<button type="button" class="fc-labs-toggle" data-fc-labs>'
      + (open ? '− Hide the lab values' : '+ Type in your lab values instead (optional)') + '</button>'
      + (open ? '<div class="fc-labs">' + (f.labs || []).map(function (l) {
        return '<div><label class="fc-lab-l" for="fclab_' + esc(l.key) + '">' + esc(l.label)
          + ' <span style="opacity:.65">' + esc(l.unit) + '</span></label>'
          + '<input class="fc-input" type="number" step="0.01" inputmode="decimal" id="fclab_' + esc(l.key) + '"'
          + ' data-fc-lab="' + esc(l.key) + '" data-key="' + esc(f.key) + '" value="' + esc(v[l.key] == null ? '' : v[l.key]) + '"></div>';
      }).join('') + '</div>' : '');
  }

  function renderFiles(f) {
    var got = S.files[f.key] || [];
    return '<label class="fc-file">' + (got.length ? 'Add another file' : 'Tap to choose ' + (f.max > 1 ? 'files' : 'a file'))
      + '<input type="file" data-fc-file="' + esc(f.key) + '" accept="' + esc(f.accept || '') + '"' + (f.max > 1 ? ' multiple' : '') + '></label>'
      + (got.length ? '<div class="fc-filelist">' + got.map(function (x) { return '<div>✓ ' + esc(x.original || x.name) + '</div>'; }).join('') + '</div>' : '');
  }

  // ── the confirm card ────────────────────────────────────────────────────

  /**
   * Fields on this step that the DB already answered. Showing these as a card to
   * accept — instead of as pre-filled inputs to scroll past — is what turns a
   * ninety-field form into a five-minute one for an existing member.
   */
  function knownOnStep(step) {
    return visibleFields(step).filter(function (f) {
      return S.prefill[f.key] && !isEmpty(S.answers[f.key]);
    });
  }

  function displayValue(f, v) {
    if (Array.isArray(v)) return v.join(', ');
    if (v && typeof v === 'object') {
      return Object.keys(v).map(function (k) { return k + ': ' + v[k]; }).join(', ');
    }
    if (f.type === 'height') return v + ' cm';
    return String(v) + (f.unit ? ' ' + f.unit : '');
  }

  function confirmCard(step) {
    var known = knownOnStep(step);
    if (!known.length || S.confirmed[step.key]) return '';
    return '<div class="fc-confirm">'
      + '<h3 class="fc-confirm-h">We already have this — just check it.</h3>'
      + '<p class="fc-confirm-sub">Pulled from what you have already given BodyBank. Confirm and we skip straight past these ' + known.length + ' question' + (known.length === 1 ? '' : 's') + '.</p>'
      + '<div class="fc-confirm-list">' + known.map(function (f) {
        return '<div class="fc-confirm-row"><span class="fc-confirm-k">' + esc(f.label) + '</span>'
          + '<span class="fc-confirm-v">' + esc(displayValue(f, S.answers[f.key])) + '</span>'
          + '<span class="fc-confirm-src">' + esc((S.prefill[f.key] || {}).source || '') + '</span></div>';
      }).join('') + '</div>'
      + '<div class="fc-confirm-acts">'
      + '<button type="button" class="fc-btn fc-btn--primary fc-btn--sm" data-fc-confirm="' + esc(step.key) + '" style="flex:0 0 auto">That\'s all correct</button>'
      + '<button type="button" class="fc-btn fc-btn--ghost fc-btn--sm" data-fc-edit="' + esc(step.key) + '">Something has changed</button>'
      + '</div></div>';
  }

  // ── the teaser ──────────────────────────────────────────────────────────

  function teaserCard() {
    var d = window.NAMetrics.derive(S.answers);
    if (!d.bmr || !d.tdee) return '';
    var p = d.protein_target_g;
    var band = d.whtr_band;
    return '<div class="fc-teaser">'
      + '<p class="fc-teaser-k">Your starting numbers</p>'
      + '<h3 class="fc-teaser-h">Here is where your body sits today.</h3>'
      + '<div class="fc-teaser-grid">'
      + '<div class="fc-tstat"><div class="fc-tstat-l">Resting burn (BMR)</div><div class="fc-tstat-v">' + d.bmr + ' <small>kcal</small></div>'
      + '<div class="fc-tstat-n">What you burn doing nothing at all.</div></div>'
      + '<div class="fc-tstat"><div class="fc-tstat-l">Daily burn (TDEE)</div><div class="fc-tstat-v">' + d.tdee + ' <small>kcal</small></div>'
      + '<div class="fc-tstat-n">Including how you move and train.</div></div>'
      + (p ? '<div class="fc-tstat"><div class="fc-tstat-l">Protein target</div><div class="fc-tstat-v">' + p.low + '–' + p.high + ' <small>g</small></div>'
        + '<div class="fc-tstat-n">Per day, for your goal and training load.</div></div>' : '')
      + (d.whtr ? '<div class="fc-tstat"><div class="fc-tstat-l">Waist-to-height</div><div class="fc-tstat-v">' + d.whtr.toFixed(2) + '</div>'
        + '<div class="fc-tstat-n">' + esc(band ? band.label : '') + '</div></div>' : '')
      + (band ? '<div class="fc-tstat fc-tstat--wide"><div class="fc-tstat-l">What that means</div>'
        + '<div class="fc-tstat-n" style="margin-top:2px;font-size:13px">' + esc(band.note) + '</div></div>' : '')
      + '</div>'
      + '<p class="fc-teaser-foot">These are rough starting numbers. The next few minutes are what make them yours.</p>'
      + '</div>';
  }

  // ── review ──────────────────────────────────────────────────────────────

  function reviewScreen() {
    var html = '<div class="fc-step-head"><p class="fc-step-kicker">Last look</p>'
      + '<h2 class="fc-step-title">Everything you told us.</h2>'
      + '<p class="fc-step-blurb">Tap any step to go back and change an answer. Nothing is sent until you press Submit.</p></div>';

    S.steps.forEach(function (step, i) {
      var rows = visibleFields(step).filter(function (f) { return !isEmpty(S.answers[f.key]); });
      if (!rows.length) return;
      html += '<div class="fc-field"><label class="fc-field-label">' + esc(step.title)
        + ' <button type="button" class="fc-btn fc-btn--ghost fc-btn--sm" data-fc-goto="' + i + '" style="float:right">Edit</button></label>'
        + '<div class="fc-confirm-list">' + rows.slice(0, 40).map(function (f) {
          return '<div class="fc-confirm-row"><span class="fc-confirm-k">' + esc(f.label) + '</span>'
            + '<span class="fc-confirm-v">' + esc(displayValue(f, S.answers[f.key])).slice(0, 400) + '</span></div>';
        }).join('') + '</div></div>';
    });
    return html;
  }

  // ── step rendering ──────────────────────────────────────────────────────

  function render() {
    var boot = el('fcBoot'), intro = el('fcIntro'), stepEl = el('fcStep'), done = el('fcDone');
    boot.classList.add('fc-hidden');
    el('fcBar').hidden = false;

    if (S.submitted) {
      intro.classList.add('fc-hidden'); stepEl.classList.add('fc-hidden'); done.classList.remove('fc-hidden');
      el('fcBar').hidden = true; el('fcProgWrap').hidden = true;
      return;
    }

    if (S.idx < 0) {
      intro.classList.remove('fc-hidden'); stepEl.classList.add('fc-hidden');
      el('fcProgWrap').hidden = true;
      el('fcBack').style.visibility = 'hidden';
      el('fcNext').textContent = S.answers.full_name ? 'Continue' : 'Start — 9 minutes';
      return;
    }

    intro.classList.add('fc-hidden');
    stepEl.classList.remove('fc-hidden');
    el('fcProgWrap').hidden = false;
    el('fcBack').style.visibility = 'visible';

    var total = S.steps.length + 1; // + review
    var n = S.idx + 1;
    el('fcProgStep').textContent = S.idx >= S.steps.length ? 'Review & submit' : S.steps[S.idx].title;
    el('fcProgOf').textContent = 'Step ' + n + ' of ' + total;
    el('fcProgFill').style.width = Math.round((n / total) * 100) + '%';

    if (S.idx >= S.steps.length) {
      stepEl.innerHTML = reviewScreen();
      el('fcNext').textContent = 'Submit my assessment';
      window.scrollTo(0, 0);
      return;
    }

    var step = S.steps[S.idx];
    var hidden = S.confirmed[step.key] ? [] : knownOnStep(step).map(function (f) { return f.key; });

    var html = '<div class="fc-step-head"><p class="fc-step-kicker">Step ' + n + ' of ' + total + '</p>'
      + '<h2 class="fc-step-title">' + esc(step.title) + '</h2>'
      + (step.blurb ? '<p class="fc-step-blurb">' + esc(step.blurb) + '</p>' : '') + '</div>';

    // The teaser belongs to the step AFTER the body metrics, where it is a
    // reward for what was just typed rather than a distraction from it.
    if (S.idx > 0 && S.steps[S.idx - 1].teaser) html += teaserCard();

    html += confirmCard(step);
    html += visibleFields(step)
      .filter(function (f) { return hidden.indexOf(f.key) === -1; })
      .map(renderField).join('');

    stepEl.innerHTML = html;
    el('fcNext').textContent = 'Continue';
    window.scrollTo(0, 0);
  }

  // ── validation ──────────────────────────────────────────────────────────

  function validateStep() {
    if (S.idx < 0 || S.idx >= S.steps.length) return true;
    var step = S.steps[S.idx];
    var bad = null;
    document.querySelectorAll('[data-fc-err]').forEach(function (n) { n.classList.add('fc-hidden'); });
    document.querySelectorAll('[data-fc-field]').forEach(function (n) { n.classList.remove('is-invalid'); });

    visibleFields(step).forEach(function (f) {
      if (!f.required) return;
      var v = S.answers[f.key];
      var empty = isEmpty(v);
      if (f.type === 'recall') {
        empty = !v || !Object.keys(v).some(function (k) { return String((v[k] || {}).what || '').trim(); });
      }
      if (f.type === 'grid') {
        var need = (f.rows || []).length;
        empty = !v || Object.keys(v).length < need;
      }
      if (!empty) return;
      var host = document.querySelector('[data-fc-field="' + f.key + '"]');
      var errN = document.querySelector('[data-fc-err="' + f.key + '"]');
      if (host) host.classList.add('is-invalid');
      if (errN) {
        errN.textContent = f.type === 'grid'
          ? 'Please pick a frequency for every row — this one block does a lot of the work.'
          : (f.type === 'recall' ? 'Please fill in at least one meal from yesterday.' : 'This one is required.');
        errN.classList.remove('fc-hidden');
      }
      if (!bad) bad = host;
    });

    if (bad) { bad.scrollIntoView({ behavior: 'smooth', block: 'center' }); return false; }
    return true;
  }

  // ── events ──────────────────────────────────────────────────────────────

  function onClick(e) {
    var t = e.target.closest('button, label.fc-file');
    if (!t) return;

    var chip = t.getAttribute && t.getAttribute('data-fc-chip');
    if (chip) {
      var f = fieldByKey(chip);
      var val = t.getAttribute('data-val');
      if (f && f.type === 'multi') {
        var cur = Array.isArray(S.answers[chip]) ? S.answers[chip].slice() : [];
        var at = cur.indexOf(val);
        if (at === -1) {
          // An "exclusive" option (None / I don't skip) clears the rest, and any
          // real option clears it — otherwise you get "None, Peanuts".
          if (f.exclusive && val === f.exclusive) cur = [val];
          else { cur = cur.filter(function (x) { return x !== f.exclusive; }); if (!f.max || cur.length < f.max) cur.push(val); }
        } else cur.splice(at, 1);
        setAnswer(chip, cur);
      } else {
        setAnswer(chip, S.answers[chip] === val ? '' : val);
      }
      if (isTrigger(chip)) render(); else repaintChips(chip);
      return;
    }

    var grid = t.getAttribute && t.getAttribute('data-fc-grid');
    if (grid) {
      var g = Object.assign({}, S.answers[grid] || {});
      var row = t.getAttribute('data-row'), col = t.getAttribute('data-col');
      if (g[row] === col) delete g[row]; else g[row] = col;
      setAnswer(grid, g);
      // Repaint just this block — a full render would bounce the scroll position
      // halfway through a twenty-one row matrix.
      var host = document.querySelector('[data-fc-field="' + grid + '"]');
      var gf = fieldByKey(grid);
      if (host && gf) {
        host.querySelectorAll('.fc-fr-b').forEach(function (b) {
          var on = g[b.getAttribute('data-row')] === b.getAttribute('data-col');
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        host.querySelectorAll('[data-fc-frrow]').forEach(function (rowEl) {
          rowEl.classList.toggle('done', !!g[rowEl.getAttribute('data-fc-frrow')]);
        });
        var cnt = host.querySelector('[data-fc-gridcount]');
        if (cnt) cnt.textContent = Object.keys(g).length + ' of ' + gf.rows.length + ' answered';
        var gerr = host.querySelector('[data-fc-err]');
        if (gerr && Object.keys(g).length >= gf.rows.length) { gerr.classList.add('fc-hidden'); host.classList.remove('is-invalid'); }
      }
      return;
    }

    var confirmKey = t.getAttribute && t.getAttribute('data-fc-confirm');
    if (confirmKey) { S.confirmed[confirmKey] = true; scheduleSave(); render(); return; }

    var editKey = t.getAttribute && t.getAttribute('data-fc-edit');
    if (editKey) { S.confirmed[editKey] = true; render(); return; }

    var tagDel = t.getAttribute && t.getAttribute('data-fc-tagdel');
    if (tagDel) {
      var list = (S.answers[tagDel] || []).slice();
      list.splice(parseInt(t.getAttribute('data-i'), 10), 1);
      setAnswer(tagDel, list); render(); return;
    }

    var hmode = t.getAttribute && t.getAttribute('data-fc-hmode');
    if (hmode) { S._heightMode = hmode; render(); return; }

    if (t.hasAttribute && t.hasAttribute('data-fc-labs')) { S._labsOpen = !S._labsOpen; render(); return; }

    var goto = t.getAttribute && t.getAttribute('data-fc-goto');
    if (goto) { S.idx = parseInt(goto, 10); render(); return; }
  }

  function fieldByKey(key) {
    for (var i = 0; i < S.steps.length; i++) {
      var f = S.steps[i].fields.filter(function (x) { return x.key === key; })[0];
      if (f) return f;
    }
    return null;
  }

  function onInput(e) {
    var n = e.target;
    var key = n.getAttribute && n.getAttribute('data-fc-input');
    if (key) {
      var f = fieldByKey(key);
      var v = n.value;
      if (f && (f.type === 'number' || f.type === 'height')) v = v === '' ? '' : Number(v);
      S.answers[key] = v; scheduleSave(); return;
    }
    if (n.hasAttribute && (n.hasAttribute('data-fc-ft') || n.hasAttribute('data-fc-in'))) {
      var host = n.closest('.fc-ftin');
      var ft = Number((host.querySelector('[data-fc-ft]') || {}).value || 0);
      var inch = Number((host.querySelector('[data-fc-in]') || {}).value || 0);
      var cm = Math.round((ft * 12 + inch) * 2.54);
      S.answers.height_cm = cm > 0 ? cm : ''; scheduleSave(); return;
    }
    var slider = n.getAttribute && n.getAttribute('data-fc-slider');
    if (slider) {
      S.answers[slider] = Number(n.value);
      var out = el('fcSlv_' + slider); if (out) out.textContent = n.value;
      scheduleSave(); return;
    }
    var recall = n.getAttribute && n.getAttribute('data-fc-recall');
    var recallT = n.getAttribute && n.getAttribute('data-fc-recall-time');
    if (recall || recallT) {
      var rkey = n.getAttribute('data-key');
      var bag = Object.assign({}, S.answers[rkey] || {});
      var slot = recall || recallT;
      bag[slot] = Object.assign({}, bag[slot] || {});
      if (recall) bag[slot].what = n.value; else bag[slot].at = n.value;
      S.answers[rkey] = bag; scheduleSave(); return;
    }
    var lab = n.getAttribute && n.getAttribute('data-fc-lab');
    if (lab) {
      var lkey = n.getAttribute('data-key');
      var labs = Object.assign({}, S.answers[lkey] || {});
      if (n.value === '') delete labs[lab]; else labs[lab] = Number(n.value);
      S.answers[lkey] = labs; scheduleSave(); return;
    }
    var consent = n.getAttribute && n.getAttribute('data-fc-consent');
    if (consent) { setAnswer(consent, !!n.checked); return; }
  }

  function onKeydown(e) {
    var add = e.target.getAttribute && e.target.getAttribute('data-fc-tagadd');
    if (add && (e.key === 'Enter' || e.key === ',')) {
      e.preventDefault();
      var val = String(e.target.value || '').trim().replace(/,$/, '');
      if (!val) return;
      var list = (S.answers[add] || []).slice();
      if (list.indexOf(val) === -1) list.push(val);
      e.target.value = '';
      setAnswer(add, list); render();
      var again = document.querySelector('[data-fc-tagadd="' + add + '"]'); if (again) again.focus();
    }
  }

  function onFile(e) {
    var key = e.target.getAttribute && e.target.getAttribute('data-fc-file');
    if (!key || !e.target.files || !e.target.files.length) return;
    // The row has to exist before a file can hang off it, so flush the draft first.
    S.dirty = true;
    markSaving('Uploading…');
    pushDraft().then(function () {
      var fd = new FormData();
      for (var i = 0; i < e.target.files.length; i++) fd.append('files', e.target.files[i]);
      var url = API + '/upload?slot=' + encodeURIComponent(key)
        + (S.draftId ? '&id=' + encodeURIComponent(S.draftId) : '')
        + (S.invite && !S.token ? '&t=' + encodeURIComponent(S.invite) : '');
      var headers = {};
      if (S.token) headers.Authorization = 'Bearer ' + S.token;
      return fetch(url, { method: 'POST', body: fd, headers: headers }).then(function (r) { return r.json(); });
    }).then(function (d) {
      if (!d || d.error) throw new Error((d && d.error) || 'Upload failed');
      S.files[key] = (S.files[key] || []).concat(d.files || []);
      S.answers[key] = S.files[key].map(function (x) { return x.name; });
      markSaving('Uploaded.'); scheduleSave(); render();
    }).catch(function (err) {
      markSaving((err && err.message) || 'That upload did not go through — you can carry on without it.');
    });
  }

  function next() {
    if (S.submitted) return;
    if (S.idx < 0) { S.idx = 0; render(); pushDraft(); return; }
    if (!validateStep()) return;
    if (S.idx < S.steps.length) { S.idx++; render(); pushDraft(); return; }
    submit();
  }

  function back() {
    if (S.idx <= -1) return;
    S.idx--; render();
  }

  function submit() {
    var btn = el('fcNext');
    btn.disabled = true; btn.textContent = 'Sending…';
    api('POST', '/submit', { answers: nested(), part: S.part }).then(function (d) {
      S.submitted = true;
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      if (d.review_note) {
        el('fcDoneFlag').innerHTML = '<div class="fc-note" style="text-align:left">' + esc(d.review_note) + '</div>';
      }
      // Part 1 is not the end of the road, and the done screen must say so —
      // otherwise a member reads "submitted" and never expects a second link.
      var doneMsg = el('fcDoneMsg');
      if (doneMsg) {
        if (d.complete === false && d.next_part === 2) {
          doneMsg.textContent = 'Part 1 is in — that is the hard part done. '
            + 'We will send you the Part 2 link shortly; it adds the detail that makes the plan yours '
            + 'and picks up exactly where this left off.';
        } else if (d.complete === true) {
          doneMsg.textContent = 'That is everything. Your plan can now be built around how you actually live.';
        }
      }

      var dv = d.derived || {};
      if (dv.bmr) {
        el('fcDoneNumbers').innerHTML = '<div class="fc-teaser" style="text-align:left;margin-top:22px">'
          + '<p class="fc-teaser-k">Your numbers</p>'
          + '<div class="fc-teaser-grid">'
          + '<div class="fc-tstat"><div class="fc-tstat-l">Daily burn</div><div class="fc-tstat-v">' + dv.tdee + ' <small>kcal</small></div></div>'
          + (dv.calorie_target ? '<div class="fc-tstat"><div class="fc-tstat-l">Your target</div><div class="fc-tstat-v">' + dv.calorie_target + ' <small>kcal</small></div></div>' : '')
          + (dv.protein_target_g ? '<div class="fc-tstat"><div class="fc-tstat-l">Protein</div><div class="fc-tstat-v">' + dv.protein_target_g.low + '–' + dv.protein_target_g.high + ' <small>g</small></div></div>' : '')
          + (dv.whtr ? '<div class="fc-tstat"><div class="fc-tstat-l">Waist-to-height</div><div class="fc-tstat-v">' + dv.whtr.toFixed(2) + '</div></div>' : '')
          + '</div></div>';
      }
      render();
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Submit my assessment';
      if (err && err.refused) {
        el('fcStep').innerHTML = '<div class="fc-alert">' + esc(err.error) + '</div>';
        window.scrollTo(0, 0);
        return;
      }
      if (err && err.missing && err.missing.length) {
        // Land them on the first step that is actually missing something.
        var firstStep = err.missing[0].step;
        for (var i = 0; i < S.steps.length; i++) if (S.steps[i].key === firstStep) { S.idx = i; break; }
        render();
        setTimeout(validateStep, 60);
        markSaving('A few answers are still needed — they are marked in red.');
        return;
      }
      markSaving((err && err.error) || 'That did not send. Check your connection and try again.');
    });
  }

  // ── boot ────────────────────────────────────────────────────────────────

  function readMemberToken() {
    try {
      var s = JSON.parse(localStorage.getItem('bodybank_session') || 'null');
      return s && s.token && s.role === 'user' ? s.token : '';
    } catch (e) { return ''; }
  }

  function seedFromPrefill(prefill) {
    S.prefill = prefill || {};
    Object.keys(S.prefill).forEach(function (k) {
      var p = S.prefill[k];
      if (p && !isEmpty(p.value) && isEmpty(S.answers[k])) S.answers[k] = p.value;
    });
  }

  /** Headline blurb for the part being filled. */
  function introBlurb() {
    if (S.partMeta && S.partMeta.blurb) return S.partMeta.blurb;
    return S.part === 2
      ? 'The detail that makes the plan yours. Your Part 1 answers are already saved.'
      : 'The essentials: who you are, your goal, your numbers and a short health check.';
  }

  /** Put the part into the page title, heading and intro. */
  function applyPartCopy() {
    var title = (S.partMeta && S.partMeta.title) || ('FitChef Assessment — Part ' + S.part);
    var h = el('fcIntroTitle');
    if (h) h.textContent = title;
    var b = el('fcIntroBlurb');
    if (b && !b.getAttribute('data-personalised')) b.textContent = introBlurb();
    var badge = el('fcPartBadge');
    if (badge) {
      badge.hidden = false;
      badge.textContent = 'Part ' + S.part + ' of ' + S.totalParts;
    }
    try { document.title = title; } catch (e) { /* ignore */ }
  }

  function boot() {
    S.invite = qs('t');
    S.token = readMemberToken();

    // The server decides which part to open: an explicit ?part= wins, otherwise it
    // works it out from what has already been submitted. Asking /session first and
    // taking the steps from ITS answer means the two can never disagree — fetching
    // the schema separately would race, and a member could be shown part 1's
    // questions while the server expected part 2.
    var partQ = qs('part');
    api('GET', '/session' + (partQ ? '?part=' + encodeURIComponent(partQ) : ''))
      .catch(function () { return {}; })
      .then(function (sess) {
        sess = sess || {};
        S.part = Number(sess.part) === 2 ? 2 : 1;
        S.nextPart = sess.next_part || null;
        S.part1Done = !!sess.part1_done;
        S.part2Done = !!sess.part2_done;
        S.partMeta = sess.meta || null;
        S.totalParts = Number(sess.total_parts) || 2;
        S.steps = (sess.steps && sess.steps.length) ? sess.steps : [];
        S.isMember = !!sess.is_member;
        // A very old server, or one that failed, still yields a usable form.
        if (!S.steps.length) {
          return api('GET', '/schema?part=' + S.part).then(function (sc) {
            S.steps = (sc && sc.steps) || [];
            return sess;
          }).catch(function () { return sess; });
        }
        return sess;
      })
      .then(function (sess) {
        sess = sess || {};

        // Server draft first, then whatever this device cached (a newer local
        // edit made offline should not be thrown away by a stale server row).
        var draft = sess.draft;
        if (draft && draft.id) S.draftId = draft.id;
        if (draft && draft.answers) {
          Object.keys(draft.answers).forEach(function (stepKey) {
            var bag = draft.answers[stepKey] || {};
            Object.keys(bag).forEach(function (k) { S.answers[k] = bag[k]; });
          });
          // last_step is an index within the part the draft was left on. Resuming
          // at it only makes sense when that is the part we are now rendering.
          if (Number(draft.part || 1) === S.part) {
            S.idx = Math.max(0, Math.min(S.steps.length - 1, (draft.last_step || 1) - 1));
          } else {
            S.idx = -1;
          }
        }
        try {
          var local = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
          if (local && local.answers && (!draft || new Date(draft.updated_at || 0).getTime() < (local.at || 0))) {
            Object.keys(local.answers).forEach(function (k) { S.answers[k] = local.answers[k]; });
            S.confirmed = local.confirmed || {};
            if (typeof local.idx === 'number') S.idx = local.idx;
          }
        } catch (e) { /* ignore */ }

        seedFromPrefill(sess.prefill);

        var thisPartDone = (S.part === 1 && S.part1Done) || (S.part === 2 && S.part2Done);
        if (sess.already_submitted || thisPartDone) {
          S.submitted = true;
          el('fcDoneMsg').textContent = S.part2Done
            ? 'You have completed both parts. If something has changed, message your coach and we will reopen it.'
            : (S.part1Done && S.part === 1
              ? 'Part 1 is already in. We will send you the Part 2 link — there is nothing to do here right now.'
              : 'You have already completed this assessment. If something has changed, message your coach and we will reopen it.');
        } else if (S.idx < 0) {
          S.idx = -1;
        }

        var knownCount = Object.keys(S.prefill).length;
        if (knownCount) {
          var note = el('fcIntroKnown');
          note.hidden = false;
          note.innerHTML = '<strong>We have already filled in ' + knownCount + ' answer' + (knownCount === 1 ? '' : 's') + ' for you.</strong> '
            + 'Your profile, your check-ins' + (S.prefill.labs ? ', your blood report' : '') + ' and your earlier forms all feed in, '
            + 'so you only confirm them. This should take you closer to five minutes than nine.';
          el('fcIntroBlurb').textContent = introBlurb();
        }
        applyPartCopy();

        render();
      })
      .catch(function () {
        el('fcBoot').innerHTML = '<div class="fc-alert">We could not load the assessment. Please refresh, or try the link again in a moment.</div>';
      });
  }

  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-fc-file')) onFile(e);
    else onInput(e);
  });
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', function () { if (S.dirty) pushDraft(); });

  document.addEventListener('DOMContentLoaded', function () {
    el('fcNext').addEventListener('click', next);
    el('fcBack').addEventListener('click', back);
    boot();
  });
}());
