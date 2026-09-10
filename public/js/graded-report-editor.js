/* ==========================================================================
   BodyBank — HEALTH MAP REPORT editor

   Full edit control over a graded health report before it is printed or sent.
   The reviewer can hide, retitle, reorder and rewrite every section, drop
   individual findings and markers, and see the result rendered exactly as it
   will print — then download or send it.

   The unit of work is the report DOCUMENT served by
   GET/PUT /api/blood/admin/report/:id/graded-doc — the same document the server
   renders the PDF from, so the preview here cannot drift from the printout.

   ── WHAT IS DELIBERATELY NOT EDITABLE ────────────────────────────────────────
   Measured values, units, reference ranges and the derived status are read-only.
   They are what the lab printed and what the grade was computed from; a report
   where a reviewer can retype a number is a report nobody can trust. A reviewer
   who disagrees hides the row or writes a note beside it, which keeps the
   disagreement visible instead of rewriting the evidence.

   Entry point:  window.bbOpenGradedReportEditor(reportId, opts)
     opts.onSaved    — called after a successful save (used to refresh the card)
     opts.clientName — shown in the header before the document loads

   Works for admin and operator alike: the API is staff-gated, and nothing here
   depends on which screen opened it.
   ========================================================================== */
(function () {
  'use strict';

  var ROOT_ID = 'bbGradedEditor';

  var TYPE_LABEL = {
    healthmap: 'Health Map',
    priorities: 'Top Priorities',
    areacards: 'Health Areas',
    markers: 'Detailed Lab Results',
    progress: 'Health Progress',
    text: 'Text block',
    list: 'Steps',
    callout: 'Highlight box',
    disclaimer: 'Disclaimer'
  };

  var GRADE_LABEL = {
    A: 'Healthy', B: 'Monitor', C: 'Attention Recommended',
    D: 'Further Evaluation', NOT_ASSESSED: 'Not Assessed'
  };

  var S = {
    id: null,
    doc: null,
    clientName: '',
    edited: false,
    updatedAt: null,
    updatedBy: '',
    dirty: false,
    busy: false,
    view: 'edit',
    open: null,       // Set of expanded section ids
    onSaved: null,
    previewTimer: null,
    seq: 0
  };

  // ------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------

  function esc(s) {
    if (s == null || s === '') return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    if (typeof nutritionShowToast === 'function') nutritionShowToast(msg, kind || 'success');
  }
  function alertBox(title, msg) {
    if (typeof showPopup === 'function') showPopup(title, msg, '', 'OK', null, 'error');
    else window.alert(title + '\n\n' + msg);
  }
  function uid(p) { S.seq += 1; return (p || 'x') + '-' + Date.now().toString(36) + '-' + S.seq; }

  // ── WinAnsi preview parity ──────────────────────────────────────────────
  // PDFKit's Helvetica is WinAnsi-only. The preview runs the same conversion the
  // renderer does, so a pasted "≥" looks the same here as it will on the page,
  // and the reviewer is warned about anything that has to be dropped.
  var UNI_MAP = {
    '→': '->', '⟶': '->', '➔': '->', '➜': '->', '⇒': '=>',
    '←': '<-', '⟵': '<-', '⇐': '<=', '↔': '<->', '↑': '^', '↓': 'v',
    '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '≡': '=',
    '−': '-', '­': '-', '‐': '-', '‑': '-', '–': '-', '⁄': '/',
    '∞': 'infinity', 'μ': 'µ', '₹': 'Rs.', '′': "'", '″': '"',
    '⁰': '^0', '¹': '^1', '²': '2', '³': '3', '⁴': '^4', '⁵': '^5',
    '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9',
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
    '✓': '*', '✔': '*', '✗': 'x', '✘': 'x', '▲': '^', '▼': 'v',
    '●': '•', '▪': '•', '■': '•', '★': '*', '☆': '*',
    '─': '-', '═': '=',
    ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
    '​': '', '‌': '', '‍': '', '﻿': ''
  };
  var WINANSI_HIGH = {};
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'
    .split('').forEach(function (c) { WINANSI_HIGH[c] = true; });

  function W(input) {
    var s = String(input == null ? '' : input);
    if (!/[^\n\t\x20-\x7E]/.test(s)) return s;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (Object.prototype.hasOwnProperty.call(UNI_MAP, ch)) { out += UNI_MAP[ch]; continue; }
      var cp = s.charCodeAt(i);
      if (ch === '\n' || ch === '\t') { out += ch; continue; }
      if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) { out += ch; continue; }
      if (WINANSI_HIGH[ch]) { out += ch; continue; }
      if (cp >= 0x0300 && cp <= 0x036f) continue;
    }
    return out;
  }
  /** Characters the print engine will have to drop, for the warning strip. */
  function droppedChars(doc) {
    var bad = {};
    var walk = function (n) {
      if (n == null) return;
      if (typeof n === 'string') {
        for (var i = 0; i < n.length; i++) {
          var ch = n.charAt(i);
          if (W(ch) === '' && ch.trim() !== '') bad[ch] = true;
        }
        return;
      }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (typeof n === 'object') Object.keys(n).forEach(function (k) { walk(n[k]); });
    };
    walk(doc);
    return Object.keys(bad);
  }

  function root() { return document.getElementById(ROOT_ID); }

  // ------------------------------------------------------------------------
  // shell
  // ------------------------------------------------------------------------

  function ensureShell() {
    var el = root();
    if (el) return el;
    el = document.createElement('div');
    el.id = ROOT_ID;
    el.className = 'bbge';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Health Map report editor');
    el.innerHTML =
      '<div class="bbge-shell">' +
        '<div class="bbge-top">' +
          '<div class="bbge-who"><div class="bbge-title">Health Map report</div>' +
            '<div class="bbge-sub" id="bbgeSub"></div></div>' +
          '<div class="bbge-seg" role="tablist">' +
            '<button type="button" data-act="view" data-view="edit" class="is-on">Edit</button>' +
            '<button type="button" data-act="view" data-view="preview">Preview</button>' +
          '</div>' +
          '<button type="button" class="bbge-x" data-act="close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="bbge-warn" id="bbgeWarn" hidden></div>' +
        '<div class="bbge-panes">' +
          '<div class="bbge-pane bbge-edit" id="bbgeEdit"></div>' +
          '<div class="bbge-pane bbge-preview" id="bbgePreview"></div>' +
        '</div>' +
        '<div class="bbge-bottom">' +
          '<span class="bbge-status" id="bbgeStatus"></span>' +
          '<span class="bbge-spacer"></span>' +
          '<button type="button" class="bbge-btn" data-act="reset">Reset to generated</button>' +
          '<button type="button" class="bbge-btn" data-act="pdf">Download PDF</button>' +
          '<button type="button" class="bbge-btn primary" data-act="save">Save</button>' +
          '<button type="button" class="bbge-btn send" data-act="send">Send to client</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
    return el;
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    var el = root();
    if (el && !el.hidden) requestClose();
  }

  function setBusy(on) {
    S.busy = !!on;
    var el = root();
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.bbge-bottom .bbge-btn'), function (b) {
      b.disabled = !!on;
    });
  }
  function setStatus(text, cls) {
    var el = document.getElementById('bbgeStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'bbge-status' + (cls ? ' ' + cls : '');
  }
  function markDirty() {
    S.dirty = true;
    setStatus('Unsaved changes', 'warn');
  }
  function setHeader() {
    var sub = document.getElementById('bbgeSub');
    if (!sub) return;
    var bits = [];
    if (S.clientName) bits.push(esc(S.clientName));
    if (S.doc && S.doc.cover && S.doc.cover.screeningDateLabel) {
      bits.push(esc(S.doc.cover.screeningDateLabel));
    }
    bits.push(S.edited
      ? 'Edited' + (S.updatedBy ? ' by ' + esc(S.updatedBy) : '')
      : 'Generated');
    sub.innerHTML = bits.join(' &middot; ');
  }

  function setView(v) {
    S.view = v === 'preview' ? 'preview' : 'edit';
    var el = root();
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.bbge-seg button'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-view') === S.view);
    });
    el.querySelector('.bbge-panes').setAttribute('data-view', S.view);
    renderPreview();
  }

  // ------------------------------------------------------------------------
  // open / close
  // ------------------------------------------------------------------------

  function open(reportId, opts) {
    opts = opts || {};
    var el = ensureShell();
    el.hidden = false;
    document.body.style.overflow = 'hidden';

    S.id = String(reportId);
    S.clientName = opts.clientName || '';
    S.onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null;
    S.doc = null;
    S.dirty = false;
    S.open = new Set();
    setView('edit');
    setHeader();
    setStatus('Loading…');
    document.getElementById('bbgeEdit').innerHTML = '<div class="bbge-empty">Loading the report…</div>';
    document.getElementById('bbgePreview').innerHTML = '';

    apiCall('GET', '/api/blood/admin/report/' + encodeURIComponent(S.id) + '/graded-doc')
      .then(function (d) {
        if (!d || d.success === false || d.error) {
          setStatus('');
          document.getElementById('bbgeEdit').innerHTML =
            '<div class="bbge-empty">' + esc((d && d.error) || 'Could not load this report.') + '</div>';
          return;
        }
        S.doc = d.doc;
        S.edited = !!d.edited;
        S.updatedAt = d.updatedAt || null;
        S.updatedBy = d.updatedBy || '';
        if (!S.clientName) S.clientName = d.clientName || '';
        setHeader();
        setStatus(S.edited ? 'Saved' : 'Generated — not yet edited', 'ok');
        renderAll();
      })
      .catch(function () {
        setStatus('');
        document.getElementById('bbgeEdit').innerHTML = '<div class="bbge-empty">Network error.</div>';
      });
  }

  function requestClose() {
    if (S.dirty && !window.confirm('You have unsaved changes. Close without saving?')) return;
    close();
  }
  function close() {
    var el = root();
    if (el) el.hidden = true;
    document.body.style.overflow = '';
    S.dirty = false;
  }

  // ------------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------------

  function onClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');

    if (act === 'close') { requestClose(); return; }
    if (act === 'view') { setView(btn.getAttribute('data-view')); return; }
    if (act === 'save') { save(); return; }
    if (act === 'reset') { resetDoc(); return; }
    if (act === 'pdf') { downloadPdf(); return; }
    if (act === 'send') { send(); return; }

    if (!S.doc) return;
    var i = Number(btn.getAttribute('data-i'));
    var j = Number(btn.getAttribute('data-j'));
    var k = Number(btn.getAttribute('data-k'));

    if (act === 'toggle') { toggleOpen(btn.getAttribute('data-id')); return; }
    if (act === 'show') { flipShow(i); return; }
    if (act === 'up') { moveSection(i, -1); return; }
    if (act === 'down') { moveSection(i, 1); return; }
    if (act === 'brk') {
      S.doc.sections[i].pageBreak = !S.doc.sections[i].pageBreak;
      markDirty(); renderAll(true);
      return;
    }
    if (act === 'itemshow') { flipItemShow(i, j, k); return; }
  }

  function onInput(e) {
    var el = e.target.closest('[data-path]');
    if (!el || !S.doc) return;
    pathSet(S.doc, el.getAttribute('data-path'), el.value);
    markDirty();
    if (el.tagName === 'TEXTAREA') autoGrow(el);
    schedulePreview();
  }
  function onChange(e) {
    var el = e.target.closest('[data-path]');
    if (!el || !S.doc) return;
    pathSet(S.doc, el.getAttribute('data-path'), el.value);
    markDirty();
    schedulePreview();
  }

  function pathSet(obj, path, value) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      var idx = /^\d+$/.test(key) ? Number(key) : key;
      if (cur[idx] == null) return;
      cur = cur[idx];
    }
    var last = parts[parts.length - 1];
    cur[/^\d+$/.test(last) ? Number(last) : last] = value;
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, 420) + 'px';
  }
  function schedulePreview() {
    if (S.previewTimer) clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(renderPreview, 160);
  }

  function toggleOpen(id) {
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
    renderAll(true);
  }
  function flipShow(i) {
    var s = S.doc.sections[i];
    if (s.type === 'disclaimer') {
      toast('The disclaimer has to stay on every report.', 'error');
      return;
    }
    s.show = !s.show;
    markDirty();
    renderAll(true);
  }
  function moveSection(i, dir) {
    var list = S.doc.sections;
    var j = i + dir;
    if (j < 0 || j >= list.length) return;
    var t = list[i]; list[i] = list[j]; list[j] = t;
    markDirty();
    renderAll(true);
  }
  /** Hide one finding, marker or step inside a section. */
  function flipItemShow(i, j, k) {
    var s = S.doc.sections[i];
    if (!s) return;
    var item = null;
    if (s.type === 'markers') item = s.groups[j] && s.groups[j].markers[k];
    else if (s.type === 'areacards') item = s.cards[j] && s.cards[j].findings[k];
    else if (s.type === 'priorities') item = s.items[j];
    else if (s.type === 'list') item = s.items[j];
    else if (s.type === 'healthmap') item = s.areas[j];
    else if (s.type === 'progress') item = s.groups[j] && s.groups[j].items[k];
    if (!item) return;
    item.show = item.show === false;
    markDirty();
    renderAll(true);
  }

  // ------------------------------------------------------------------------
  // edit pane
  // ------------------------------------------------------------------------

  function renderAll(keepScroll) {
    var pane = document.getElementById('bbgeEdit');
    if (!pane || !S.doc) return;
    var top = keepScroll ? pane.scrollTop : 0;
    pane.innerHTML = S.doc.sections.map(sectionEditor).join('');
    Array.prototype.forEach.call(pane.querySelectorAll('textarea'), autoGrow);
    pane.scrollTop = top;

    var dropped = droppedChars(S.doc);
    var warn = document.getElementById('bbgeWarn');
    if (warn) {
      if (dropped.length) {
        warn.hidden = false;
        warn.innerHTML = 'These characters cannot be printed and will be removed from the PDF: ' +
          dropped.map(function (c) { return '<code>' + esc(c) + '</code>'; }).join(' ');
      } else {
        warn.hidden = true;
      }
    }
    renderPreview();
  }

  function field(label, path, value, rows) {
    var id = uid('f');
    if (rows) {
      return '<label class="bbge-field"><span>' + esc(label) + '</span>' +
        '<textarea id="' + id + '" data-path="' + esc(path) + '" rows="' + rows + '">' +
        esc(value || '') + '</textarea></label>';
    }
    return '<label class="bbge-field"><span>' + esc(label) + '</span>' +
      '<input id="' + id + '" type="text" data-path="' + esc(path) + '" value="' + esc(value || '') + '"></label>';
  }

  /** A read-only value the reviewer may hide but never retype. */
  function locked(label, value) {
    return '<div class="bbge-locked"><span>' + esc(label) + '</span><b>' + esc(value || '—') + '</b></div>';
  }

  function itemToggle(i, j, k, on, label, extra) {
    return '<div class="bbge-item' + (on === false ? ' is-off' : '') + '">' +
      '<button type="button" class="bbge-eye" data-act="itemshow" data-i="' + i + '" data-j="' + j + '"' +
      (k != null ? ' data-k="' + k + '"' : '') + ' title="' + (on === false ? 'Show' : 'Hide') + '">' +
      (on === false ? '&#128065;&#8725;' : '&#128065;') + '</button>' +
      '<span class="bbge-item-l">' + esc(label) + '</span>' +
      (extra ? '<span class="bbge-item-x">' + extra + '</span>' : '') +
      '</div>';
  }

  /** A readable name for a section whose heading is deliberately blank. */
  function defaultLabel(s) {
    if (s.type === 'text' && s.variant === 'lead') return 'Key message';
    return TYPE_LABEL[s.type] || 'Section';
  }

  function sectionEditor(s, i) {
    var isOpen = S.open.has(s.id);
    var off = s.show === false;
    var head =
      '<div class="bbge-sec-head">' +
        '<button type="button" class="bbge-chev" data-act="toggle" data-id="' + esc(s.id) + '" aria-expanded="' + isOpen + '">' +
          (isOpen ? '&#9662;' : '&#9656;') + '</button>' +
        '<span class="bbge-sec-type">' + esc(TYPE_LABEL[s.type] || s.type) + '</span>' +
        '<span class="bbge-sec-title">' + esc(s.title || defaultLabel(s)) + '</span>' +
        '<span class="bbge-spacer"></span>' +
        (s.type === 'disclaimer'
          ? '<span class="bbge-lock" title="Always printed">locked</span>'
          : '<button type="button" class="bbge-eye" data-act="show" data-i="' + i + '" title="' + (off ? 'Show' : 'Hide') + '">' +
            (off ? '&#128065;&#8725;' : '&#128065;') + '</button>') +
        '<button type="button" class="bbge-mini" data-act="brk" data-i="' + i + '" title="Start this section on a new page">' +
          (s.pageBreak ? '&#9776; new page' : '&#9776;') + '</button>' +
        '<button type="button" class="bbge-mini" data-act="up" data-i="' + i + '" title="Move up">&#9650;</button>' +
        '<button type="button" class="bbge-mini" data-act="down" data-i="' + i + '" title="Move down">&#9660;</button>' +
      '</div>';

    if (!isOpen) return '<div class="bbge-sec' + (off ? ' is-off' : '') + '">' + head + '</div>';

    var body = '<div class="bbge-sec-body">';
    if (s.type !== 'disclaimer') {
      body += field('Heading', 'sections.' + i + '.title', s.title);
      if (s.type !== 'text' || s.variant !== 'lead') {
        body += field('Sub-heading', 'sections.' + i + '.subtitle', s.subtitle, 2);
      }
    }

    if (s.type === 'text' || s.type === 'callout' || s.type === 'disclaimer') {
      body += field(s.type === 'callout' && s.coachNote ? 'Your note to the client' : 'Text',
        'sections.' + i + '.body', s.body, 6);
    }

    if (s.type === 'healthmap') {
      body += '<div class="bbge-list">' + (s.areas || []).map(function (a, j) {
        return itemToggle(i, j, null, a.show, a.label,
          '<b class="bbge-g bbge-g' + esc(a.grade) + '">' + esc(a.grade) + '</b> ' +
          esc(GRADE_LABEL[a.grade] || ''));
      }).join('') + '</div>';
      if ((s.notAssessed || []).length) {
        body += '<div class="bbge-note">Not assessed: ' +
          (s.notAssessed).map(function (a) { return esc(a.label); }).join(', ') + '</div>';
      }
    }

    if (s.type === 'priorities') {
      body += (s.items || []).map(function (p, j) {
        return '<div class="bbge-card' + (p.show === false ? ' is-off' : '') + '">' +
          itemToggle(i, j, null, p.show, 'Priority ' + p.rank,
            '<b class="bbge-g bbge-g' + esc(p.grade) + '">' + esc(p.grade) + '</b>') +
          field('Title', 'sections.' + i + '.items.' + j + '.title', p.title) +
          locked('Result', p.result) +
          locked('Status', p.status) +
          field('Why it matters', 'sections.' + i + '.items.' + j + '.whyItMatters', p.whyItMatters, 3) +
          field('Next step', 'sections.' + i + '.items.' + j + '.nextStep', p.nextStep, 3) +
          (p.requiresProfessional
            ? '<div class="bbge-flag">Flagged for professional review — this line always prints.</div>' : '') +
          '</div>';
      }).join('');
    }

    if (s.type === 'areacards') {
      body += (s.cards || []).map(function (cd, j) {
        return '<div class="bbge-card' + (cd.show === false ? ' is-off' : '') + '">' +
          itemToggle(i, j, null, cd.show, cd.label,
            '<b class="bbge-g bbge-g' + esc(cd.grade) + '">' + esc(cd.grade) + '</b>') +
          field('Summary', 'sections.' + i + '.cards.' + j + '.summary', cd.summary, 3) +
          (cd.trendLine ? field('Trend', 'sections.' + i + '.cards.' + j + '.trendLine', cd.trendLine, 2) : '') +
          field('Focus on', 'sections.' + i + '.cards.' + j + '.focus', cd.focus, 3) +
          '<div class="bbge-sub2">Findings</div>' +
          '<div class="bbge-list">' + (cd.findings || []).map(function (f, k) {
            return itemToggle(i, j, k, f.show, f.label,
              esc(f.result) + ' &middot; ' + esc(f.status));
          }).join('') + '</div>' +
          '</div>';
      }).join('');
    }

    if (s.type === 'markers') {
      body += (s.groups || []).map(function (g, j) {
        return '<div class="bbge-card"><div class="bbge-sub2">' + esc(g.label) + '</div>' +
          '<div class="bbge-list">' + (g.markers || []).map(function (m, k) {
            return itemToggle(i, j, k, m.show, m.label,
              esc(m.result) + ' &middot; ' + esc(m.status) +
              (m.duplicate ? ' <i>(repeat)</i>' : ''));
          }).join('') + '</div></div>';
      }).join('');
    }

    if (s.type === 'progress') {
      body += (s.groups || []).map(function (g, j) {
        if (!(g.items || []).length) return '';
        return '<div class="bbge-card"><div class="bbge-sub2">' + esc(g.title) +
          ' (' + g.items.length + ')</div><div class="bbge-list">' +
          g.items.map(function (it, k) {
            return itemToggle(i, j, k, it.show, it.label,
              esc(it.previous ? it.previous + ' -> ' + it.current : it.current));
          }).join('') + '</div></div>';
      }).join('');
    }

    if (s.type === 'list') {
      body += (s.items || []).map(function (it, j) {
        return '<div class="bbge-card' + (it.show === false ? ' is-off' : '') + '">' +
          itemToggle(i, j, null, it.show, 'Step ' + (j + 1), '') +
          field('Text', 'sections.' + i + '.items.' + j + '.text', it.text, 3) +
          '</div>';
      }).join('');
    }

    body += '</div>';
    return '<div class="bbge-sec is-open' + (off ? ' is-off' : '') + '">' + head + body + '</div>';
  }

  // ------------------------------------------------------------------------
  // preview — mirrors services/gradedReportPdfKit.js section for section
  // ------------------------------------------------------------------------

  function p(s) { return esc(W(s)); }

  function renderPreview() {
    var pane = document.getElementById('bbgePreview');
    if (!pane || !S.doc) return;
    var d = S.doc;
    var cover = d.cover || {};

    var html = '<article class="bbgp">' +
      '<header class="bbgp-cover">' +
        '<div class="bbgp-brand">BodyBank.fit<span>Preventive Health Screening</span></div>' +
        '<h1>' + p(cover.title) + '</h1>' +
        '<div class="bbgp-client"><div><b>' + p(cover.clientName) + '</b>' +
          '<span>' + p(cover.clientMeta) + '</span></div>' +
          '<div class="bbgp-date"><span>SCREENING DATE</span><b>' + p(cover.screeningDateLabel) + '</b></div>' +
        '</div>' +
        '<div class="bbgp-stats">' + (cover.stats || []).map(function (st) {
          return '<div><b>' + p(st.value) + '</b><span>' + p(st.label) + '</span></div>';
        }).join('') + '</div>' +
      '</header>';

    (d.sections || []).forEach(function (s) {
      if (s.show === false) return;
      html += previewSection(s);
    });
    html += '</article>';
    pane.innerHTML = html;
  }

  function head(s) {
    if (!s.title) return '';
    return '<h2>' + p(s.title) + '</h2>' +
      (s.subtitle ? '<p class="bbgp-sub">' + p(s.subtitle) + '</p>' : '');
  }

  function previewSection(s) {
    var brk = s.pageBreak ? ' bbgp-brk' : '';

    if (s.type === 'healthmap') {
      var tiles = (s.areas || []).filter(function (a) { return a.show !== false; }).map(function (a) {
        return '<div class="bbgp-tile"><b class="bbgp-badge bbge-g' + esc(a.grade) + '">' +
          esc(a.grade === 'NOT_ASSESSED' ? '–' : a.grade) + '</b>' +
          '<div><span class="bbgp-tile-n">' + p(a.label) + '</span>' +
          '<span class="bbgp-tile-g">' + p(a.gradeLabel) + '</span>' +
          '<span class="bbgp-pips" data-pips="' + esc(a.grade) + '"></span></div>' +
          (a.previousGrade && a.previousGrade !== a.grade
            ? '<i class="bbgp-was">was ' + esc(a.previousGrade) + '</i>' : '') +
          '</div>';
      }).join('');
      var na = (s.notAssessed || []).filter(function (a) { return a.show !== false; });
      return '<section class="bbgp-s' + brk + '">' + head(s) +
        '<div class="bbgp-map">' + tiles + '</div>' +
        (na.length ? '<div class="bbgp-na"><b>' + p(s.notAssessedTitle) + '</b> ' +
          na.map(function (a) { return p(a.label) + ' (needs ' + p(a.needs) + ')'; }).join(';  ') + '</div>' : '') +
        '</section>';
    }

    if (s.type === 'text') {
      if (s.variant === 'lead') {
        return '<section class="bbgp-s' + brk + '"><div class="bbgp-lead">' + p(s.body) + '</div></section>';
      }
      return '<section class="bbgp-s' + brk + '">' + head(s) +
        String(s.body || '').split(/\n\s*\n/).map(function (x) {
          return '<p>' + p(x) + '</p>';
        }).join('') + '</section>';
    }

    if (s.type === 'priorities') {
      var items = (s.items || []).filter(function (x) { return x.show !== false; });
      if (!items.length) {
        return '<section class="bbgp-s' + brk + '">' + head(s) +
          '<p class="bbgp-muted">No finding on this screening rises to the level of a priority.</p></section>';
      }
      return '<section class="bbgp-s' + brk + '">' + head(s) + items.map(function (x) {
        return '<div class="bbgp-pri bbge-b' + esc(x.grade) + '">' +
          '<div class="bbgp-pri-h"><b class="bbgp-rank bbge-g' + esc(x.grade) + '">' + esc(x.rank) + '</b>' +
            '<div><h3>' + p(x.title) + '</h3><span>' + p(x.areaLabel) + ' &middot; Grade ' + esc(x.grade) + '</span></div></div>' +
          '<div class="bbgp-layers">' +
            '<div><i>RESULT</i><b>' + p(x.result) + '</b></div>' +
            '<div><i>STATUS</i><b>' + p(x.status) + '</b></div>' +
          '</div>' +
          '<div class="bbgp-layer"><i>WHY IT MATTERS</i><p>' + p(x.whyItMatters) + '</p></div>' +
          '<div class="bbgp-layer"><i>NEXT STEP</i><p>' + p(x.nextStep) + '</p></div>' +
          (x.requiresProfessional && x.professionalNote
            ? '<div class="bbgp-flag">&gt; ' + p(x.professionalNote) + '</div>' : '') +
          '</div>';
      }).join('') + '</section>';
    }

    if (s.type === 'areacards') {
      return '<section class="bbgp-s' + brk + '">' + head(s) +
        (s.cards || []).filter(function (c) { return c.show !== false; }).map(function (c) {
          var f = (c.findings || []).filter(function (x) { return x.show !== false; });
          return '<div class="bbgp-area">' +
            '<div class="bbgp-area-h bbge-b' + esc(c.grade) + '">' +
              '<b class="bbgp-badge bbge-g' + esc(c.grade) + '">' + esc(c.grade) + '</b>' +
              '<div><h3>' + p(c.label) + '</h3><span>' + p(c.gradeLabel) + '</span></div>' +
              (c.requiresProfessional ? '<i class="bbgp-pro">DISCUSS WITH A PROFESSIONAL</i>' : '') +
            '</div>' +
            (c.summary ? '<p>' + p(c.summary) + '</p>' : '') +
            (c.trendLine ? '<p class="bbgp-muted">' + p(c.trendLine) + '</p>' : '') +
            f.map(function (x) {
              return '<div class="bbgp-find"><span class="bbgp-find-n">' + p(x.label) + '</span>' +
                '<b>' + p(x.result) + '</b>' +
                '<span class="bbgp-muted">' + (x.range ? 'ref ' + p(x.range) : '') + '</span>' +
                '<i>' + p(x.status) + '</i>' +
                (x.insight ? '<p>' + p(x.insight) + '</p>' : '') + '</div>';
            }).join('') +
            (c.focus ? '<div class="bbgp-focus"><i>FOCUS ON</i><p>' + p(c.focus) + '</p></div>' : '') +
            '</div>';
        }).join('') + '</section>';
    }

    if (s.type === 'markers') {
      var usedPref = false;
      var groups = (s.groups || []).filter(function (g) { return g.show !== false; }).map(function (g) {
        var rows = (g.markers || []).filter(function (m) { return m.show !== false; });
        if (!rows.length) return '';
        return '<h4>' + p(g.label) + '</h4><table class="bbgp-tbl"><thead><tr>' +
          '<th>Marker</th><th>Result</th><th>Reference</th><th>Status</th><th class="r">Trend</th>' +
          '</tr></thead><tbody>' + rows.map(function (m) {
            if (m.rangeSource === 'BODYBANK_PREFERRED') usedPref = true;
            return '<tr><td>' + p(m.label) + '</td><td><b>' + p(m.result) + '</b></td>' +
              '<td class="bbgp-muted">' + p(m.range) +
              (m.rangeSource === 'BODYBANK_PREFERRED' ? ' *' : '') + '</td>' +
              '<td' + (m.status === 'Within range' ? ' class="bbgp-muted"' : '') + '>' + p(m.status) + '</td>' +
              '<td class="r bbgp-muted">' + (m.trend && m.trend !== 'NOT_COMPARABLE' ? p(m.trendLabel) : '') + '</td></tr>';
          }).join('') + '</tbody></table>';
      }).join('');
      return '<section class="bbgp-s' + brk + '">' + head(s) + groups +
        (usedPref ? '<p class="bbgp-foot">*  Your lab did not print a reference range for this marker, so a BodyBank preferred range was used and is shown here.</p>' : '') +
        '</section>';
    }

    if (s.type === 'progress') {
      return '<section class="bbgp-s' + brk + '">' + head(s) +
        (s.caution ? '<div class="bbgp-caution">' + p(s.caution) + '</div>' : '') +
        (s.groups || []).filter(function (g) { return g.show !== false; }).map(function (g) {
          var items = (g.items || []).filter(function (x) { return x.show !== false; });
          if (!items.length) return '';
          if (g.key === 'stable') {
            return '<h4 class="bbgp-t-' + esc(g.key) + '">' + p(g.title) + ' (' + items.length + ')</h4>' +
              '<p class="bbgp-muted">' + items.map(function (x) { return p(x.label); }).join(', ') + '</p>';
          }
          return '<h4 class="bbgp-t-' + esc(g.key) + '">' + p(g.title) + ' (' + items.length + ')</h4>' +
            '<div class="bbgp-prog">' + items.map(function (x) {
              return '<div><span>' + p(x.label) + '</span><b>' +
                (x.previous ? p(x.previous) + '  &rarr;  ' + p(x.current) : p(x.current)) + '</b>' +
                (x.newReason === 'FIRST_MEASURED' ? '<i>first measured</i>'
                  : x.newReason === 'MOVED_OUT_OF_RANGE' ? '<i>moved out of range</i>' : '') +
                '</div>';
            }).join('') + '</div>';
        }).join('') + '</section>';
    }

    if (s.type === 'list') {
      var steps = (s.items || []).filter(function (x) { return x.show !== false; });
      return '<section class="bbgp-s' + brk + '">' + head(s) + '<ol class="bbgp-steps">' +
        steps.map(function (x) {
          return '<li' + (x.requiresProfessional ? ' class="pro"' : '') + '>' + p(x.text) + '</li>';
        }).join('') + '</ol></section>';
    }

    if (s.type === 'callout') {
      var items = (s.items || []).filter(function (x) { return x.show !== false; });
      return '<section class="bbgp-s' + brk + '"><div class="bbgp-call bbgp-call-' + esc(s.tone || 'neutral') + '">' +
        (s.title ? '<h3>' + p(s.title) + '</h3>' : '') +
        (s.body ? '<p>' + p(s.body) + '</p>' : '') +
        items.map(function (x) {
          return '<div class="bbgp-call-i"><b>' + p(x.label) + '</b><span>' + p(x.result) + '</span>' +
            '<i>' + (x.range ? 'ref ' + p(x.range) : '') + '</i>' +
            (x.note ? '<p>' + p(x.note) + '</p>' : '') + '</div>';
        }).join('') + '</div></section>';
    }

    if (s.type === 'disclaimer') {
      return '<section class="bbgp-s"><div class="bbgp-disc"><b>' + p(s.title) + '</b><p>' + p(s.body) + '</p></div></section>';
    }
    return '';
  }

  // ------------------------------------------------------------------------
  // actions
  // ------------------------------------------------------------------------

  function save(then) {
    if (!S.doc || S.busy) return;
    setBusy(true);
    setStatus('Saving…');
    apiCall('PUT', '/api/blood/admin/report/' + encodeURIComponent(S.id) + '/graded-doc', { doc: S.doc })
      .then(function (d) {
        setBusy(false);
        if (!d || d.success === false || d.error) {
          setStatus('Not saved', 'warn');
          alertBox('Save failed', (d && d.error) || 'Could not save the report.');
          return;
        }
        S.doc = d.doc;
        S.edited = true;
        S.dirty = false;
        setHeader();
        setStatus('Saved', 'ok');
        toast('Report saved');
        renderAll(true);
        if (S.onSaved) S.onSaved();
        if (typeof then === 'function') then();
      })
      .catch(function () {
        setBusy(false);
        setStatus('Not saved', 'warn');
        alertBox('Save failed', 'Network error.');
      });
  }

  function resetDoc() {
    if (!window.confirm('Discard your edits and go back to the generated report? The grades themselves do not change.')) return;
    setBusy(true);
    setStatus('Resetting…');
    apiCall('POST', '/api/blood/admin/report/' + encodeURIComponent(S.id) + '/graded-doc/reset', {})
      .then(function (d) {
        setBusy(false);
        if (!d || d.success === false || d.error) {
          setStatus('');
          alertBox('Reset failed', (d && d.error) || 'Could not reset the report.');
          return;
        }
        S.doc = d.doc;
        S.edited = false;
        S.dirty = false;
        setHeader();
        setStatus('Back to the generated report', 'ok');
        renderAll();
        if (S.onSaved) S.onSaved();
      })
      .catch(function () { setBusy(false); setStatus(''); });
  }

  /** Always saves first: a PDF built from stale text is the bug this whole layer exists to prevent. */
  function downloadPdf() {
    var go = function () {
      if (typeof bbAuthedDownload === 'function') {
        bbAuthedDownload('/api/blood/pdf/' + encodeURIComponent(S.id), 'BodyBank_Health_Map_Report.pdf');
      }
    };
    if (S.dirty) save(go); else go();
  }

  function send() {
    var go = function () {
      if (!window.confirm('Send this report to the client by email and inbox?')) return;
      setBusy(true);
      apiCall('POST', '/api/blood/admin/send/' + encodeURIComponent(S.id), {})
        .then(function (d) {
          setBusy(false);
          if (!d || d.success === false || d.error) {
            alertBox('Send failed', (d && d.error) || 'Could not send the report.');
            return;
          }
          toast('Report sent to the client');
          if (S.onSaved) S.onSaved();
          close();
        })
        .catch(function () { setBusy(false); alertBox('Send failed', 'Network error.'); });
    };
    if (S.dirty) save(go); else go();
  }

  window.bbOpenGradedReportEditor = open;
  window.bbCloseGradedReportEditor = close;
})();
