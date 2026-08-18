/* ==========================================================================
   BodyBank — Blood PROGRESS REPORT editor
   --------------------------------------------------------------------------
   Full edit control over a longitudinal blood-comparison report before it is
   printed or sent. The reviewing doctor can hide, retitle, reorder, rewrite,
   delete and add every section, table row, change card and marker, then print a
   PDF that matches the preview exactly.

   The unit of work is the report DOCUMENT served by
   GET/PUT /api/blood/admin/comparison/:id/doc — the same document the server
   renders the PDF from, so the preview here cannot drift from the printout.

   Entry point:  window.bbOpenReportEditor(comparisonId, opts)
     opts.onSaved  — called after a successful save (used to refresh the card)
     opts.clientName — shown in the header before the document loads

   Works for admin and operator alike: the API is staff-gated, and nothing here
   depends on which screen opened it.
   ========================================================================== */
(function () {
  'use strict';

  var ROOT_ID = 'bbReportEditor';
  var TYPE_LABEL = {
    trend: 'Trend table', text: 'Text block', cards: 'Change cards',
    table: 'Table', callout: 'Highlight box', disclaimer: 'Disclaimer'
  };

  var S = {
    id: null,
    doc: null,
    clientName: '',
    clientPhone: '',
    edited: false,
    docUpdatedAt: null,
    dirty: false,
    busy: false,
    view: 'edit',
    openCards: null,   // Set of expanded card ids
    openMarkers: null, // Set of expanded marker keys
    onSaved: null,
    previewTimer: null,
    seq: 0
  };

  // ------------------------------------------------------------------------
  // tiny helpers
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
  function uid(prefix) { S.seq += 1; return (prefix || 'x') + '-' + Date.now().toString(36) + '-' + S.seq; }
  function clampPct(n) { return Math.min(100, Math.max(4, Math.round(n))); }

  // Dotted-path get/set over the document. Every path this file emits is built
  // from literal keys and array indices, so no key can contain a separator.
  function pathSet(obj, path, value) {
    var keys = String(path).split('.');
    var last = keys.pop();
    var target = obj;
    for (var i = 0; i < keys.length; i += 1) {
      if (target == null) return;
      target = target[keys[i]];
    }
    if (target && typeof target === 'object') target[last] = value;
  }

  // ------------------------------------------------------------------------
  // WinAnsi preview parity
  // ------------------------------------------------------------------------
  // The PDF's Helvetica is a WinAnsi font, so the server transliterates anything
  // outside that encoding before printing (see services/comparisonReportPdfKit.js).
  // The preview runs the same conversion — otherwise a pasted "≥" would look fine
  // on screen and print as something else. Characters that survive neither are
  // counted so the editor can warn before the report goes out.
  var UNI_MAP = {
    '→': '->', '⟶': '->', '➔': '->', '➜': '->', '⇒': '=>',
    '←': '<-', '⟵': '<-', '⇐': '<=', '↔': '<->', '↑': '^', '↓': 'v',
    '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '≡': '=',
    '−': '-', '­': '-', '‐': '-', '‑': '-', '⁄': '/',
    '∞': 'infinity', '±': '±',
    'μ': 'µ', '₹': 'Rs.', '′': "'", '″': '"',
    '⁰': '^0', '⁴': '^4', '⁵': '^5', '⁶': '^6', '⁷': '^7',
    '⁸': '^8', '⁹': '^9', '⁺': '^+', '⁻': '^-', 'ⁿ': '^n',
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
    '✓': '*', '✔': '*', '✗': 'x', '✘': 'x', '▲': '^', '▼': 'v',
    '●': '•', '▪': '•', '★': '*', '☆': '*', '⁃': '-',
    ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
    '​': '', '‌': '', '‍': '', '﻿': ''
  };
  var WINANSI_HIGH = {};
  ('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’' +
   '“”•–—˜™š›œžŸ')
    .split('').forEach(function (c) { WINANSI_HIGH[c] = true; });

  var droppedChars = 0;
  function W(input) {
    var s = input == null ? '' : String(input);
    if (!/[^\n\t\x20-\x7E]/.test(s)) return s;
    var out = '';
    for (var i = 0; i < s.length; i += 1) {
      var ch = s.charAt(i);
      if (Object.prototype.hasOwnProperty.call(UNI_MAP, ch)) { out += UNI_MAP[ch]; continue; }
      var cp = s.charCodeAt(i);
      if (ch === '\n' || ch === '\t') { out += ch; continue; }
      if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) { out += ch; continue; }
      if (WINANSI_HIGH[ch]) { out += ch; continue; }
      if (cp >= 0x0300 && cp <= 0x036f) continue;
      droppedChars += 1;
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // document normalisation on load
  // ------------------------------------------------------------------------
  // Table cells are addressed by column id inside the editor's dotted paths, so a
  // column id must never contain a '.'. Rewrite any that would break addressing
  // (and carry every row's cell across) before the document is bound to the UI.
  function normalizeDoc(doc) {
    (doc.sections || []).forEach(function (s) {
      if (s.type !== 'table' || !Array.isArray(s.columns)) return;
      var used = {};
      s.columns.forEach(function (c, ci) {
        var id = String(c.id == null ? '' : c.id);
        if (!id || id.indexOf('.') >= 0 || used[id]) {
          var next = 'c' + ci;
          while (used[next]) next = next + 'x';
          (s.rows || []).forEach(function (r) {
            if (!r.cells) r.cells = {};
            r.cells[next] = r.cells[id];
            delete r.cells[id];
          });
          c.id = next;
        }
        used[c.id] = true;
      });
    });
    return doc;
  }

  // ------------------------------------------------------------------------
  // shell
  // ------------------------------------------------------------------------
  function root() { return document.getElementById(ROOT_ID); }

  function ensureShell() {
    var existing = root();
    if (existing) return existing;
    var el = document.createElement('div');
    el.id = ROOT_ID;
    el.className = 'bbre';
    el.setAttribute('data-view', 'edit');
    el.innerHTML =
      '<div class="bbre-shell" role="dialog" aria-modal="true" aria-label="Edit progress report">' +
        '<div class="bbre-top">' +
          '<div class="bbre-title"><strong id="bbreTitle">Edit progress report</strong>' +
          '<span class="bbre-sub" id="bbreSub"></span></div>' +
          '<div class="bbre-seg" role="group" aria-label="Editor view">' +
            '<button type="button" data-act="view" data-view="edit" class="is-on">Edit</button>' +
            '<button type="button" data-act="view" data-view="preview">Preview</button>' +
          '</div>' +
          '<button type="button" class="bbre-x" data-act="close" aria-label="Close editor">&#10005;</button>' +
        '</div>' +
        '<div class="bbre-body">' +
          '<div class="bbre-pane bbre-edit" id="bbreEdit"></div>' +
          '<div class="bbre-pane bbre-preview" id="bbrePreview"></div>' +
        '</div>' +
        '<div class="bbre-bottom">' +
          '<span class="bbre-status" id="bbreStatus"></span>' +
          '<button type="button" class="bbre-btn danger" data-act="reset">Reset to AI original</button>' +
          '<button type="button" class="bbre-btn" data-act="save">Save</button>' +
          '<button type="button" class="bbre-btn send" data-act="preview">Preview &amp; send &#9656;</button>' +
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
    // Innermost layer first: share sheet, then the preview, then the editor.
    var sheet = document.getElementById('bbreSheet');
    if (sheet && !sheet.hidden) { e.preventDefault(); closeShareSheet(); return; }
    var pv = document.getElementById(PV_ID);
    if (pv && pv.classList.contains('is-open')) { e.preventDefault(); closePreview(); return; }
    var el = root();
    if (el && el.classList.contains('is-open')) { e.preventDefault(); requestClose(); }
  }

  function setBusy(on) {
    S.busy = !!on;
    var el = root();
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.bbre-bottom .bbre-btn'), function (b) { b.disabled = !!on; });
  }

  function setStatus(text, cls) {
    var el = document.getElementById('bbreStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'bbre-status' + (cls ? ' ' + cls : '');
  }

  function markDirty() {
    S.dirty = true;
    setStatus('Unsaved changes', 'is-dirty');
  }

  function setHeader() {
    var t = document.getElementById('bbreTitle');
    var sub = document.getElementById('bbreSub');
    if (t) t.textContent = 'Edit progress report';
    if (!sub) return;
    var bits = [];
    if (S.clientName) bits.push(esc(S.clientName));
    bits.push(S.edited
      ? '<span class="bbre-flag">edited</span>' + (S.docUpdatedAt ? ' ' + esc(shortWhen(S.docUpdatedAt)) : '')
      : 'AI original');
    sub.innerHTML = bits.join(' &middot; ');
  }

  function shortWhen(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function setView(v) {
    S.view = v === 'preview' ? 'preview' : 'edit';
    var el = root();
    if (!el) return;
    el.setAttribute('data-view', S.view);
    Array.prototype.forEach.call(el.querySelectorAll('.bbre-seg button'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-view') === S.view);
    });
    var pane = el.querySelector(S.view === 'preview' ? '.bbre-preview' : '.bbre-edit');
    if (pane) pane.scrollTop = pane.scrollTop; // keep position, no jump
  }

  // ------------------------------------------------------------------------
  // open / close
  // ------------------------------------------------------------------------
  function open(comparisonId, opts) {
    opts = opts || {};
    var id = String(comparisonId || '').trim();
    if (!id) return;
    S.id = id;
    S.doc = null;
    S.dirty = false;
    S.edited = false;
    S.docUpdatedAt = null;
    S.clientName = opts.clientName || '';
    S.clientPhone = opts.clientPhone || '';
    S.onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null;
    S.openCards = {};
    S.openMarkers = {};

    var el = ensureShell();
    el.classList.add('is-open');
    document.body.classList.add('bbre-locked');
    setView('edit');
    setHeader();
    setStatus('');
    setBusy(true);
    document.getElementById('bbreEdit').innerHTML = '<div class="bbre-loading">Loading report…</div>';
    document.getElementById('bbrePreview').innerHTML = '';

    apiCall('GET', '/api/blood/admin/comparison/' + encodeURIComponent(id) + '/doc').then(function (d) {
      setBusy(false);
      if (!d || d.success === false || d.error || !d.doc) {
        document.getElementById('bbreEdit').innerHTML =
          '<div class="bbre-error">' + esc((d && (d.error || d.message)) || 'Could not load this report.') + '</div>';
        return;
      }
      S.doc = normalizeDoc(d.doc);
      S.edited = !!d.edited;
      S.docUpdatedAt = d.docUpdatedAt || null;
      if (d.clientName) S.clientName = d.clientName;
      if (d.clientPhone) S.clientPhone = d.clientPhone;
      setHeader();
      setStatus(S.edited ? 'Saved' : 'AI original', S.edited ? 'is-saved' : '');
      renderAll(false);
    }).catch(function () {
      setBusy(false);
      document.getElementById('bbreEdit').innerHTML = '<div class="bbre-error">Network error.</div>';
    });
  }

  function requestClose() {
    if (S.dirty && !window.confirm('You have unsaved changes to this report. Close and discard them?')) return;
    close();
  }

  function close() {
    var el = root();
    if (el) el.classList.remove('is-open');
    document.body.classList.remove('bbre-locked');
    S.doc = null;
    S.dirty = false;
  }

  // ------------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------------
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || !root().contains(t)) return;
    var act = t.getAttribute('data-act');
    var i = parseInt(t.getAttribute('data-i'), 10);
    var j = parseInt(t.getAttribute('data-j'), 10);
    var k = parseInt(t.getAttribute('data-k'), 10);

    if (act === 'close') { e.preventDefault(); requestClose(); return; }
    if (act === 'view') { e.preventDefault(); setView(t.getAttribute('data-view')); return; }
    if (act === 'save') { e.preventDefault(); save(); return; }
    if (act === 'preview') {
      e.preventDefault();
      // The preview must show what would actually print, so flush edits first.
      saveThen(function () { openPreview(S.id, { clientName: S.clientName, clientPhone: S.clientPhone }); });
      return;
    }
    if (act === 'reset') { e.preventDefault(); resetDoc(); return; }
    if (!S.doc) return;

    e.preventDefault();
    switch (act) {
      case 'toggleOpen': toggleOpen(t.getAttribute('data-id')); return;
      case 'toggleShow': flipShow(t.getAttribute('data-p')); return;
      case 'move': moveSection(i, parseInt(t.getAttribute('data-dir'), 10)); return;
      case 'delSection': delSection(i); return;
      case 'addSection': addSection(t.getAttribute('data-type')); return;
      case 'addRow': addRow(i); return;
      case 'delRow': delRow(i, j); return;
      case 'moveRow': moveIn(S.doc.sections[i].rows, j, parseInt(t.getAttribute('data-dir'), 10)); return;
      case 'addCol': addColumn(i); return;
      case 'delCol': delColumn(i, j); return;
      case 'addGroup': addGroup(i); return;
      case 'delGroup': delGroup(i, j); return;
      case 'addItem': addItem(i, j); return;
      case 'delItem': delItem(i, j, k); return;
      case 'moveItem': moveIn(S.doc.sections[i].groups[j].items, k, parseInt(t.getAttribute('data-dir'), 10)); return;
      case 'markerOpen': toggleMarker(t.getAttribute('data-id')); return;
      case 'delMarker': delMarker(i, j, k); return;
      case 'panelAll': panelAll(i, j, t.getAttribute('data-on') === '1'); return;
      case 'delPanel': delPanel(i, j); return;
      case 'addStat': addStat(); return;
      case 'delStat': delStat(i); return;
      default: return;
    }
  }

  function onInput(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var p = el.getAttribute('data-p');
    if (!p || !S.doc) return;
    if (el.type === 'checkbox' || el.tagName === 'SELECT') return; // handled by change
    var value = el.value;
    if (el.getAttribute('data-kind') === 'pct') {
      value = clampPct(parseFloat(value) || 0) / 100;
    }
    pathSet(S.doc, p, value);
    if (el.tagName === 'TEXTAREA') autoGrow(el);
    if (el.getAttribute('data-live') === 'name') {
      var head = el.closest('.bbre-card');
      var nameEl = head ? head.querySelector('.bbre-card-name') : null;
      if (nameEl && nameEl.firstChild) nameEl.firstChild.nodeValue = el.value || 'Untitled section';
    }
    markDirty();
    schedulePreview();
  }

  function onChange(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var p = el.getAttribute('data-p');
    if (!p || !S.doc) return;
    if (el.type === 'checkbox') {
      pathSet(S.doc, p, !!el.checked);
      var card = el.closest('.bbre-card');
      if (card && el.getAttribute('data-live') === 'show') card.classList.toggle('is-hidden', !el.checked);
      markDirty();
      renderPreview();
      return;
    }
    if (el.tagName === 'SELECT') {
      pathSet(S.doc, p, el.value);
      markDirty();
      renderPreview();
    }
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(600, el.scrollHeight + 2) + 'px';
  }

  function schedulePreview() {
    if (S.previewTimer) clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(renderPreview, 180);
  }

  // ------------------------------------------------------------------------
  // structural mutations (each re-renders the edit pane)
  // ------------------------------------------------------------------------
  function toggleOpen(id) {
    if (!id) return;
    if (S.openCards[id]) delete S.openCards[id]; else S.openCards[id] = true;
    var card = root().querySelector('.bbre-card[data-cid="' + cssEscape(id) + '"]');
    if (card) card.classList.toggle('is-collapsed', !S.openCards[id]);
    if (S.openCards[id]) {
      Array.prototype.forEach.call(card ? card.querySelectorAll('textarea') : [], autoGrow);
    }
  }
  function toggleMarker(id) {
    if (!id) return;
    if (S.openMarkers[id]) delete S.openMarkers[id]; else S.openMarkers[id] = true;
    renderAll(true, false);
  }
  function cssEscape(v) { return String(v).replace(/"/g, '\\"'); }

  function flipShow(path) {
    if (!path) return;
    var keys = String(path).split('.');
    var last = keys.pop();
    var target = S.doc;
    for (var i = 0; i < keys.length; i += 1) { if (target == null) return; target = target[keys[i]]; }
    if (!target) return;
    target[last] = target[last] === false;
    markDirty();
    renderAll(true);
  }

  function moveIn(list, i, dir) {
    if (!Array.isArray(list)) return;
    var j = i + dir;
    if (j < 0 || j >= list.length) return;
    var tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    markDirty();
    renderAll(true);
  }
  function moveSection(i, dir) { moveIn(S.doc.sections, i, dir); }

  function delSection(i) {
    var s = S.doc.sections[i];
    if (!s) return;
    var name = s.title || s.subtitle || TYPE_LABEL[s.type] || 'this section';
    if (!window.confirm('Remove "' + name + '" from the report?\n\nTip: use the ● toggle to hide it instead — hiding is reversible without resetting.')) return;
    S.doc.sections.splice(i, 1);
    markDirty();
    renderAll(true);
  }

  function addSection(type) {
    var s;
    if (type === 'table') {
      s = {
        id: uid('sec'), type: 'table', show: true, pageBreak: false, title: '', subtitle: 'New table',
        columns: [
          { id: 'c0', header: 'Column 1', width: 0.34, style: 'strong', show: true },
          { id: 'c1', header: 'Column 2', width: 0.33, style: 'normal', show: true },
          { id: 'c2', header: 'Column 3', width: 0.33, style: 'muted', show: true }
        ],
        rows: [{ id: uid('r'), show: true, cells: { c0: '', c1: '', c2: '' } }]
      };
    } else if (type === 'cards') {
      s = {
        id: uid('sec'), type: 'cards', show: true, pageBreak: true, title: 'New card section', subtitle: '',
        groups: [{ id: uid('grp'), title: 'Group', tone: 'good', show: true, items: [newCardItem()] }]
      };
    } else if (type === 'callout') {
      s = {
        id: uid('sec'), type: 'callout', show: true, pageBreak: false, title: '', subtitle: '',
        label: 'NOTE', tone: 'green', italic: false, text: ''
      };
    } else {
      s = {
        id: uid('sec'), type: 'text', show: true, pageBreak: true, title: 'New section', subtitle: '',
        badge: { show: false, label: '', text: '' }, align: 'justify', body: ''
      };
    }
    // Slot new work in ahead of the trailing disclaimer, where a reader expects it.
    var at = S.doc.sections.length;
    while (at > 0 && S.doc.sections[at - 1].type === 'disclaimer') at -= 1;
    S.doc.sections.splice(at, 0, s);
    S.openCards[s.id] = true;
    markDirty();
    renderAll(true);
    setTimeout(function () {
      var card = root().querySelector('.bbre-card[data-cid="' + cssEscape(s.id) + '"]');
      if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 30);
  }

  function newCardItem() {
    return { id: uid('it'), show: true, marker: '', from: '', to: '', level: '', meaning: '' };
  }

  function addRow(i) {
    var s = S.doc.sections[i];
    if (!s || s.type !== 'table') return;
    var cells = {};
    (s.columns || []).forEach(function (c) { cells[c.id] = ''; });
    s.rows.push({ id: uid('r'), show: true, cells: cells });
    markDirty();
    renderAll(true);
  }
  function delRow(i, j) {
    var s = S.doc.sections[i];
    if (!s || !s.rows) return;
    s.rows.splice(j, 1);
    markDirty();
    renderAll(true);
  }
  function addColumn(i) {
    var s = S.doc.sections[i];
    if (!s || s.type !== 'table') return;
    if (s.columns.length >= 8) { toast('A table can hold up to 8 columns', 'error'); return; }
    var n = 0;
    var id = 'c0';
    var used = {};
    s.columns.forEach(function (c) { used[c.id] = true; });
    while (used[id]) { n += 1; id = 'c' + n; }
    // Take the new column's width from the existing ones so the row still spans 100%.
    var share = 1 / (s.columns.length + 1);
    s.columns.forEach(function (c) { c.width = (Number(c.width) || 0.25) * (1 - share); });
    s.columns.push({ id: id, header: 'New column', width: share, style: 'normal', show: true });
    (s.rows || []).forEach(function (r) { r.cells[id] = ''; });
    markDirty();
    renderAll(true);
  }
  function delColumn(i, j) {
    var s = S.doc.sections[i];
    if (!s || !s.columns || s.columns.length <= 1) { toast('A table needs at least one column', 'error'); return; }
    var col = s.columns[j];
    s.columns.splice(j, 1);
    (s.rows || []).forEach(function (r) { if (r.cells) delete r.cells[col.id]; });
    markDirty();
    renderAll(true);
  }

  function addGroup(i) {
    var s = S.doc.sections[i];
    if (!s || s.type !== 'cards') return;
    s.groups.push({ id: uid('grp'), title: 'New group', tone: 'good', show: true, items: [newCardItem()] });
    markDirty();
    renderAll(true);
  }
  function delGroup(i, j) {
    var s = S.doc.sections[i];
    if (!s || !s.groups) return;
    var g = s.groups[j];
    if (g && g.items && g.items.length && !window.confirm('Remove the "' + (g.title || 'group') + '" group and its ' + g.items.length + ' card(s)?')) return;
    s.groups.splice(j, 1);
    markDirty();
    renderAll(true);
  }
  function addItem(i, j) {
    var g = S.doc.sections[i] && S.doc.sections[i].groups[j];
    if (!g) return;
    g.items.push(newCardItem());
    markDirty();
    renderAll(true);
  }
  function delItem(i, j, k) {
    var g = S.doc.sections[i] && S.doc.sections[i].groups[j];
    if (!g) return;
    g.items.splice(k, 1);
    markDirty();
    renderAll(true);
  }

  function delMarker(i, j, k) {
    var p = S.doc.sections[i] && S.doc.sections[i].panels[j];
    if (!p) return;
    p.markers.splice(k, 1);
    markDirty();
    renderAll(true);
  }
  function delPanel(i, j) {
    var s = S.doc.sections[i];
    if (!s || !s.panels) return;
    var p = s.panels[j];
    if (p && !window.confirm('Remove the "' + (p.name || 'panel') + '" panel and its ' + (p.markers || []).length + ' marker(s)?')) return;
    s.panels.splice(j, 1);
    markDirty();
    renderAll(true);
  }
  function panelAll(i, j, on) {
    var p = S.doc.sections[i] && S.doc.sections[i].panels[j];
    if (!p) return;
    (p.markers || []).forEach(function (m) { m.show = !!on; });
    if (on) p.show = true;
    markDirty();
    renderAll(true);
  }

  function addStat() {
    var st = S.doc.cover.stats;
    if (st.items.length >= 6) { toast('Up to 6 cover stats', 'error'); return; }
    st.items.push({ id: uid('stat'), label: 'NEW STAT', value: '', tone: 'blue', show: true });
    markDirty();
    renderAll(true);
  }
  function delStat(i) {
    S.doc.cover.stats.items.splice(i, 1);
    markDirty();
    renderAll(true);
  }

  // ------------------------------------------------------------------------
  // render — edit pane
  // ------------------------------------------------------------------------
  function renderAll(keepScroll, alsoPreview) {
    renderEditor(keepScroll);
    if (alsoPreview !== false) renderPreview();
  }

  function renderEditor(keepScroll) {
    var pane = document.getElementById('bbreEdit');
    if (!pane || !S.doc) return;
    var top = keepScroll ? pane.scrollTop : 0;
    var h = '';
    h += '<p class="bbre-hint">Everything below prints exactly as you leave it. Use <strong>&#9679;</strong> to keep a ' +
      'section in the report or <strong>&#9675;</strong> to leave it out — hiding is reversible, deleting is not.</p>';
    h += coverCard();
    (S.doc.sections || []).forEach(function (s, i) { h += sectionCard(s, i); });
    h += '<div class="bbre-addbar">' +
      '<button type="button" class="bbre-add" data-act="addSection" data-type="text">+ Text section</button>' +
      '<button type="button" class="bbre-add" data-act="addSection" data-type="table">+ Table</button>' +
      '<button type="button" class="bbre-add" data-act="addSection" data-type="cards">+ Change cards</button>' +
      '<button type="button" class="bbre-add" data-act="addSection" data-type="callout">+ Highlight box</button>' +
      '</div>';
    pane.innerHTML = h;
    pane.scrollTop = top;
    Array.prototype.forEach.call(pane.querySelectorAll('.bbre-card:not(.is-collapsed) textarea'), autoGrow);
  }

  function eyeBtn(path, on) {
    return '<button type="button" class="bbre-ico ' + (on ? 'on' : 'off') + '" data-act="toggleShow" data-p="' +
      esc(path) + '" aria-label="' + (on ? 'Hide from report' : 'Show in report') + '" title="' +
      (on ? 'Shown in the report — click to hide' : 'Hidden from the report — click to show') + '">' +
      (on ? '&#9679;' : '&#9675;') + '</button>';
  }
  function field(label, path, value, kind) {
    return '<div class="bbre-field"><label class="bbre-lab">' + esc(label) + '</label>' +
      '<input class="bbre-in" type="' + (kind === 'number' ? 'number' : 'text') + '" data-p="' + esc(path) + '" value="' + esc(value) + '"></div>';
  }
  function area(label, path, value, rows) {
    return '<div class="bbre-field"><label class="bbre-lab">' + esc(label) + '</label>' +
      '<textarea class="bbre-ta" rows="' + (rows || 3) + '" data-p="' + esc(path) + '">' + esc(value) + '</textarea></div>';
  }
  function select(label, path, value, options) {
    var h = '<div class="bbre-field"><label class="bbre-lab">' + esc(label) + '</label><select class="bbre-sel" data-p="' + esc(path) + '">';
    options.forEach(function (o) {
      h += '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    });
    return h + '</select></div>';
  }
  function check(label, path, value, live) {
    return '<label class="bbre-check"><input type="checkbox" data-p="' + esc(path) + '"' +
      (value !== false ? ' checked' : '') + (live ? ' data-live="' + esc(live) + '"' : '') + '> ' + esc(label) + '</label>';
  }

  function coverCard() {
    var c = S.doc.cover || {};
    var f = c.fields || {};
    var open = !!S.openCards['cover'];
    var h = '<div class="bbre-card' + (open ? '' : ' is-collapsed') + (c.show === false ? ' is-hidden' : '') + '" data-cid="cover">';
    h += '<div class="bbre-card-head" data-act="toggleOpen" data-id="cover">' +
      eyeBtn('cover.show', c.show !== false) +
      '<div class="bbre-card-name">Cover page<small>Title, patient details, trajectory, stats</small></div>' +
      '<span class="bbre-chev">&#9662;</span></div>';
    h += '<div class="bbre-card-body">';
    h += field('Report title', 'cover.brandTitle', c.brandTitle);
    h += field('Sub-title', 'cover.brandSubtitle', c.brandSubtitle);
    h += '<div class="bbre-field">' + check('Show the patient details card', 'cover.showFields', c.showFields) + '</div>';
    h += '<div class="bbre-grid">';
    h += field('Patient name', 'cover.fields.patientName', f.patientName);
    h += field('Report date', 'cover.fields.reportDate', f.reportDate);
    h += field('Report type', 'cover.fields.reportType', f.reportType);
    h += field('Age / gender', 'cover.fields.ageGender', f.ageGender);
    h += field('Fitness goal', 'cover.fields.goal', f.goal);
    h += field('Tests compared', 'cover.fields.testsCompared', f.testsCompared);
    h += '</div>';

    var t = c.trajectory || {};
    h += '<div class="bbre-field">' + check('Show the overall-trajectory banner', 'cover.trajectory.show', t.show) + '</div>';
    h += field('Trajectory', 'cover.trajectory.label', t.label);
    h += area('Executive summary', 'cover.trajectory.summary', t.summary, 4);

    var st = c.stats || { items: [] };
    h += '<div class="bbre-field">' + check('Show the stat chips', 'cover.stats.show', st.show) + '</div>';
    (st.items || []).forEach(function (it, i) {
      h += '<div class="bbre-item' + (it.show === false ? ' is-hidden' : '') + '">' +
        '<div class="bbre-item-head">' + eyeBtn('cover.stats.items.' + i + '.show', it.show !== false) +
        '<span class="bbre-item-num">Stat ' + (i + 1) + '</span>' +
        '<button type="button" class="bbre-ico del" data-act="delStat" data-i="' + i + '" aria-label="Delete stat">&#10005;</button></div>' +
        '<div class="bbre-grid-3">' +
        field('Label', 'cover.stats.items.' + i + '.label', it.label) +
        field('Value', 'cover.stats.items.' + i + '.value', it.value) +
        select('Colour', 'cover.stats.items.' + i + '.tone', it.tone,
          [['green', 'Green'], ['red', 'Red'], ['blue', 'Blue'], ['amber', 'Amber'], ['gold', 'Gold']]) +
        '</div></div>';
    });
    h += '<button type="button" class="bbre-add" data-act="addStat">+ Add stat chip</button>';

    var fn = c.footnote || {};
    h += '<div class="bbre-field" style="margin-top:10px">' + check('Show the cover footnote', 'cover.footnote.show', fn.show) + '</div>';
    h += area('Cover footnote', 'cover.footnote.text', fn.text, 3);
    h += '</div></div>';
    return h;
  }

  function sectionSummary(s) {
    if (s.type === 'trend') {
      var shown = 0;
      var total = 0;
      (s.panels || []).forEach(function (p) {
        (p.markers || []).forEach(function (m) {
          total += 1;
          if (m.show !== false && p.show !== false) shown += 1;
        });
      });
      return 'Trend table &middot; ' + shown + ' of ' + total + ' markers shown';
    }
    if (s.type === 'table') {
      var rows = (s.rows || []).filter(function (r) { return r.show !== false; }).length;
      return 'Table &middot; ' + rows + ' of ' + (s.rows || []).length + ' rows';
    }
    if (s.type === 'cards') {
      var n = 0;
      var tot = 0;
      (s.groups || []).forEach(function (g) {
        (g.items || []).forEach(function (it) { tot += 1; if (it.show !== false && g.show !== false) n += 1; });
      });
      return 'Change cards &middot; ' + n + ' of ' + tot + ' shown';
    }
    return TYPE_LABEL[s.type] || 'Section';
  }

  function sectionCard(s, i) {
    var cid = s.id || ('sec' + i);
    var open = !!S.openCards[cid];
    var name = s.title || s.subtitle || TYPE_LABEL[s.type] || 'Untitled section';
    var last = (S.doc.sections || []).length - 1;
    var h = '<div class="bbre-card' + (open ? '' : ' is-collapsed') + (s.show === false ? ' is-hidden' : '') + '" data-cid="' + esc(cid) + '">';
    h += '<div class="bbre-card-head" data-act="toggleOpen" data-id="' + esc(cid) + '">' +
      eyeBtn('sections.' + i + '.show', s.show !== false) +
      '<div class="bbre-card-name">' + esc(name) + '<small>' + sectionSummary(s) + (s.pageBreak ? ' &middot; new page' : '') + '</small></div>' +
      '<button type="button" class="bbre-ico" data-act="move" data-i="' + i + '" data-dir="-1"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">&#9650;</button>' +
      '<button type="button" class="bbre-ico" data-act="move" data-i="' + i + '" data-dir="1"' + (i === last ? ' disabled' : '') + ' aria-label="Move down">&#9660;</button>' +
      '<span class="bbre-chev">&#9662;</span></div>';
    h += '<div class="bbre-card-body">';
    h += '<div class="bbre-grid">' +
      '<div class="bbre-field"><label class="bbre-lab">Heading</label><input class="bbre-in" type="text" data-live="name" data-p="sections.' + i + '.title" value="' + esc(s.title) + '"></div>' +
      '<div class="bbre-field"><label class="bbre-lab">Sub-heading</label><input class="bbre-in" type="text" data-p="sections.' + i + '.subtitle" value="' + esc(s.subtitle) + '"></div>' +
      '</div>';
    h += '<div class="bbre-field">' + check('Start this section on a new page', 'sections.' + i + '.pageBreak', !!s.pageBreak) + '</div>';

    if (s.type === 'trend') h += trendBody(s, i);
    else if (s.type === 'text') h += textBody(s, i);
    else if (s.type === 'cards') h += cardsBody(s, i);
    else if (s.type === 'table') h += tableBody(s, i);
    else if (s.type === 'callout') h += calloutBody(s, i);
    else if (s.type === 'disclaimer') h += disclaimerBody(s, i);

    // Deleting is the one irreversible action here, so it sits at the foot of the
    // open section rather than as a stray ✕ in the header next to the safe controls.
    h += '<button type="button" class="bbre-remove" data-act="delSection" data-i="' + i + '">Remove this section from the report</button>';
    h += '</div></div>';
    return h;
  }

  function textBody(s, i) {
    var b = s.badge || {};
    var h = '';
    h += '<div class="bbre-field">' + check('Show the highlight badge above the text', 'sections.' + i + '.badge.show', !!b.show) + '</div>';
    h += '<div class="bbre-grid">' +
      field('Badge label', 'sections.' + i + '.badge.label', b.label) +
      field('Badge text', 'sections.' + i + '.badge.text', b.text) + '</div>';
    h += select('Text alignment', 'sections.' + i + '.align', s.align, [['justify', 'Justified'], ['left', 'Left']]);
    h += area('Body text', 'sections.' + i + '.body', s.body, 8);
    return h;
  }

  function calloutBody(s, i) {
    var h = '';
    h += '<div class="bbre-grid">' +
      field('Small label', 'sections.' + i + '.label', s.label) +
      select('Colour', 'sections.' + i + '.tone', s.tone,
        [['green', 'Green'], ['gold', 'Gold'], ['amber', 'Amber'], ['red', 'Red'], ['blue', 'Blue']]) + '</div>';
    h += '<div class="bbre-field">' + check('Italic text', 'sections.' + i + '.italic', !!s.italic) + '</div>';
    h += area('Text', 'sections.' + i + '.text', s.text, 4);
    return h;
  }

  function disclaimerBody(s, i) {
    var h = '<p class="bbre-hint">The medical disclaimer closes the report. Edit the wording if your clinic requires ' +
      'specific language, or hide it with the &#9679; toggle.</p>';
    h += field('Bold lead-in', 'sections.' + i + '.label', s.label);
    h += area('Disclaimer text', 'sections.' + i + '.text', s.text, 5);
    return h;
  }

  function cardsBody(s, i) {
    var h = '';
    (s.groups || []).forEach(function (g, j) {
      h += '<div class="bbre-groupbar">' + eyeBtn('sections.' + i + '.groups.' + j + '.show', g.show !== false) +
        '<input class="bbre-in" type="text" data-p="sections.' + i + '.groups.' + j + '.title" value="' + esc(g.title) + '">' +
        '<select class="bbre-sel" style="width:auto;min-width:104px" data-p="sections.' + i + '.groups.' + j + '.tone">' +
        ['good,Green', 'bad,Red', 'watch,Amber'].map(function (o) {
          var kv = o.split(',');
          return '<option value="' + kv[0] + '"' + (g.tone === kv[0] ? ' selected' : '') + '>' + kv[1] + '</option>';
        }).join('') + '</select>' +
        '<button type="button" class="bbre-ico del" data-act="delGroup" data-i="' + i + '" data-j="' + j + '" aria-label="Delete group">&#10005;</button></div>';
      (g.items || []).forEach(function (it, k) {
        var lastK = g.items.length - 1;
        h += '<div class="bbre-item tone-' + esc(g.tone) + (it.show === false ? ' is-hidden' : '') + '">' +
          '<div class="bbre-item-head">' + eyeBtn('sections.' + i + '.groups.' + j + '.items.' + k + '.show', it.show !== false) +
          '<span class="bbre-item-num">' + esc(it.marker || 'Card ' + (k + 1)) + '</span>' +
          '<button type="button" class="bbre-ico" data-act="moveItem" data-i="' + i + '" data-j="' + j + '" data-k="' + k + '" data-dir="-1"' + (k === 0 ? ' disabled' : '') + ' aria-label="Move up">&#9650;</button>' +
          '<button type="button" class="bbre-ico" data-act="moveItem" data-i="' + i + '" data-j="' + j + '" data-k="' + k + '" data-dir="1"' + (k === lastK ? ' disabled' : '') + ' aria-label="Move down">&#9660;</button>' +
          '<button type="button" class="bbre-ico del" data-act="delItem" data-i="' + i + '" data-j="' + j + '" data-k="' + k + '" aria-label="Delete card">&#10005;</button></div>' +
          field('Marker', 'sections.' + i + '.groups.' + j + '.items.' + k + '.marker', it.marker) +
          '<div class="bbre-grid-3">' +
          field('From', 'sections.' + i + '.groups.' + j + '.items.' + k + '.from', it.from) +
          field('To', 'sections.' + i + '.groups.' + j + '.items.' + k + '.to', it.to) +
          select('Level', 'sections.' + i + '.groups.' + j + '.items.' + k + '.level', it.level,
            [['', 'None'], ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']]) +
          '</div>' +
          area('Explanation', 'sections.' + i + '.groups.' + j + '.items.' + k + '.meaning', it.meaning, 3) +
          '</div>';
      });
      h += '<button type="button" class="bbre-add" data-act="addItem" data-i="' + i + '" data-j="' + j + '">+ Add card to "' + esc(g.title || 'group') + '"</button>';
    });
    h += '<div style="margin-top:10px"><button type="button" class="bbre-add" data-act="addGroup" data-i="' + i + '">+ Add card group</button></div>';
    return h;
  }

  function tableBody(s, i) {
    var cols = s.columns || [];
    var h = '<div class="bbre-lab" style="margin-bottom:6px">Columns</div>';
    cols.forEach(function (c, j) {
      h += '<div class="bbre-item' + (c.show === false ? ' is-hidden' : '') + '">' +
        '<div class="bbre-item-head">' + eyeBtn('sections.' + i + '.columns.' + j + '.show', c.show !== false) +
        '<span class="bbre-item-num">Column ' + (j + 1) + '</span>' +
        '<button type="button" class="bbre-ico del" data-act="delCol" data-i="' + i + '" data-j="' + j + '" aria-label="Delete column">&#10005;</button></div>' +
        '<div class="bbre-grid-3">' +
        field('Header', 'sections.' + i + '.columns.' + j + '.header', c.header) +
        '<div class="bbre-field"><label class="bbre-lab">Width %</label><input class="bbre-in" type="number" min="4" max="100" step="1" data-kind="pct" data-p="sections.' + i + '.columns.' + j + '.width" value="' + Math.round((Number(c.width) || 0.25) * 100) + '"></div>' +
        select('Style', 'sections.' + i + '.columns.' + j + '.style', c.style,
          [['normal', 'Normal'], ['strong', 'Bold'], ['muted', 'Muted'], ['accent', 'Blue'], ['warn', 'Amber'], ['action', 'Start/Stop colour']]) +
        '</div></div>';
    });
    h += '<button type="button" class="bbre-add" data-act="addCol" data-i="' + i + '">+ Add column</button>';

    h += '<div class="bbre-lab" style="margin:14px 0 6px">Rows</div>';
    (s.rows || []).forEach(function (r, j) {
      var lastJ = s.rows.length - 1;
      var firstCol = cols[0];
      var lead = firstCol ? ((r.cells || {})[firstCol.id] || '') : '';
      h += '<div class="bbre-item' + (r.show === false ? ' is-hidden' : '') + '">' +
        '<div class="bbre-item-head">' + eyeBtn('sections.' + i + '.rows.' + j + '.show', r.show !== false) +
        '<span class="bbre-item-num">' + esc(lead || 'Row ' + (j + 1)) + '</span>' +
        '<button type="button" class="bbre-ico" data-act="moveRow" data-i="' + i + '" data-j="' + j + '" data-dir="-1"' + (j === 0 ? ' disabled' : '') + ' aria-label="Move up">&#9650;</button>' +
        '<button type="button" class="bbre-ico" data-act="moveRow" data-i="' + i + '" data-j="' + j + '" data-dir="1"' + (j === lastJ ? ' disabled' : '') + ' aria-label="Move down">&#9660;</button>' +
        '<button type="button" class="bbre-ico del" data-act="delRow" data-i="' + i + '" data-j="' + j + '" aria-label="Delete row">&#10005;</button></div>';
      cols.forEach(function (c) {
        var v = (r.cells || {})[c.id] || '';
        var path = 'sections.' + i + '.rows.' + j + '.cells.' + c.id;
        h += String(v).length > 60
          ? area(c.header || 'Cell', path, v, 2)
          : field(c.header || 'Cell', path, v);
      });
      h += '</div>';
    });
    h += '<button type="button" class="bbre-add" data-act="addRow" data-i="' + i + '">+ Add row</button>';
    return h;
  }

  function trendBody(s, i) {
    var h = area('Intro line', 'sections.' + i + '.intro', s.intro, 3);
    h += '<div class="bbre-lab" style="margin:12px 0 6px">Test columns</div>';
    h += '<p class="bbre-hint">Hide a test to drop that whole column from the table.</p>';
    (s.columns || []).forEach(function (c, j) {
      h += '<div class="bbre-mk' + (c.show === false ? ' is-hidden' : '') + '">' +
        eyeBtn('sections.' + i + '.columns.' + j + '.show', c.show !== false) +
        '<div class="bbre-mk-name"><input class="bbre-in" type="text" data-p="sections.' + i + '.columns.' + j + '.label" value="' + esc(c.label) + '"></div>' +
        '</div>';
    });

    (s.panels || []).forEach(function (p, j) {
      var shown = (p.markers || []).filter(function (m) { return m.show !== false; }).length;
      h += '<div class="bbre-groupbar">' + eyeBtn('sections.' + i + '.panels.' + j + '.show', p.show !== false) +
        '<input class="bbre-in" type="text" data-p="sections.' + i + '.panels.' + j + '.name" value="' + esc(p.name) + '">' +
        '<button type="button" class="bbre-ico del" data-act="delPanel" data-i="' + i + '" data-j="' + j + '" aria-label="Delete panel">&#10005;</button></div>';
      h += '<div class="bbre-chipbar">' +
        '<span class="bbre-hint" style="margin:0;align-self:center">' + shown + ' of ' + (p.markers || []).length + ' shown</span>' +
        '<button type="button" class="bbre-chip" data-act="panelAll" data-i="' + i + '" data-j="' + j + '" data-on="1">Show all</button>' +
        '<button type="button" class="bbre-chip" data-act="panelAll" data-i="' + i + '" data-j="' + j + '" data-on="0">Hide all</button></div>';
      (p.markers || []).forEach(function (m, k) {
        var mkId = (s.id || i) + ':' + (p.id || j) + ':' + (m.id || k);
        var mkOpen = !!S.openMarkers[mkId];
        h += '<div class="bbre-mk' + (m.show === false ? ' is-hidden' : '') + '">' +
          eyeBtn('sections.' + i + '.panels.' + j + '.markers.' + k + '.show', m.show !== false) +
          '<div class="bbre-mk-name"><input class="bbre-in" type="text" data-p="sections.' + i + '.panels.' + j + '.markers.' + k + '.name" value="' + esc(m.name) + '"></div>' +
          '<button type="button" class="bbre-ico' + (mkOpen ? ' on' : '') + '" data-act="markerOpen" data-id="' + esc(mkId) + '" aria-label="Edit values">&#8942;</button>' +
          '<button type="button" class="bbre-ico del" data-act="delMarker" data-i="' + i + '" data-j="' + j + '" data-k="' + k + '" aria-label="Delete marker">&#10005;</button>' +
          '</div>';
        if (!mkOpen) return;
        var base = 'sections.' + i + '.panels.' + j + '.markers.' + k;
        h += '<div class="bbre-mk-open">';
        h += field('Reference range', base + '.reference', m.reference);
        h += '<div class="bbre-grid">';
        (s.columns || []).forEach(function (c, ci) {
          var v = (m.values || [])[ci] || { text: '', status: '' };
          h += '<div class="bbre-field"><label class="bbre-lab">' + esc(c.label || ('Test ' + (ci + 1))) +
            (c.show === false ? ' (column hidden)' : '') + '</label>' +
            '<input class="bbre-in" type="text" data-p="' + base + '.values.' + ci + '.text" value="' + esc(v.text) + '">' +
            '<select class="bbre-sel" style="margin-top:5px" data-p="' + base + '.values.' + ci + '.status">' +
            [['', 'No colour'], ['Normal', 'Normal (green)'], ['High', 'Out of range (red)'], ['Low', 'Borderline (amber)']].map(function (o) {
              return '<option value="' + esc(o[0]) + '"' + (String(v.status) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
            }).join('') + '</select></div>';
        });
        h += '</div>';
        h += '<div class="bbre-grid-3">' +
          field('Trend label', base + '.trend.text', (m.trend || {}).text) +
          select('Trend meaning', base + '.trend.dir', (m.trend || {}).dir,
            [['improving', 'Improving (green)'], ['worsening', 'Worsening (red)'], ['stable', 'Stable (grey)'], ['changed', 'Changed (blue)'], ['na', 'Not applicable']]) +
          select('Arrow', base + '.trend.arrow', (m.trend || {}).arrow,
            [['up', 'Up'], ['down', 'Down'], ['flat', 'Flat']]) +
          '</div></div>';
      });
    });
    return h;
  }

  // ------------------------------------------------------------------------
  // render — preview pane
  // ------------------------------------------------------------------------
  function renderPreview() {
    var pane = document.getElementById('bbrePreview');
    if (!pane || !S.doc) return;
    droppedChars = 0;
    var top = pane.scrollTop;
    var c = S.doc.cover || {};
    var pages = [];
    var current = null;

    if (c.show !== false) pages.push(pvCover(c));

    (S.doc.sections || []).filter(function (s) { return s.show !== false; }).forEach(function (s) {
      var html = pvSection(s);
      if (!html) return;
      if (current === null || s.pageBreak) { current = html; pages.push(current); }
      else { pages[pages.length - 1] += html; current = pages[pages.length - 1]; }
    });

    var body = pages.length
      ? pages.map(function (p, i) {
        return '<div class="bbre-pp"><div class="bbre-pp-lab">Page ' + (i + 1) + '</div>' + p + '</div>';
      }).join('')
      : '<div class="bbre-pp"><div class="bbre-pv-empty">Everything is hidden — this report would print empty.</div></div>';

    var warn = droppedChars
      ? '<p class="bbre-warn">' + droppedChars + ' character' + (droppedChars === 1 ? '' : 's') +
        ' in this report cannot be printed by the PDF font and will be dropped. They are already removed from the preview below — ' +
        'retype them in plain text (for example write "mcg" instead of a symbol) if the wording matters.</p>'
      : '';

    pane.innerHTML = warn +
      '<p class="bbre-hint">Live preview of the printed report. Page numbers are approximate — a long section flows onto ' +
      'as many pages as it needs.</p>' +
      '<div class="bbre-paper">' + body + '</div>';
    pane.scrollTop = top;
  }

  function pvCover(c) {
    var f = c.fields || {};
    var h = '<div class="bbre-pv-brand">BODYBANK<span>.FIT &nbsp;&middot;&nbsp; AI HEALTH INTELLIGENCE</span></div>';
    h += '<div class="bbre-pv-h1">' + esc(W(c.brandTitle)) + '</div>';
    if (c.brandSubtitle) h += '<div class="bbre-pv-h2">' + esc(W(c.brandSubtitle)) + '</div>';
    h += '<div class="bbre-pv-rule"></div>';
    if (c.showFields !== false) {
      h += '<div class="bbre-pv-facts">' +
        pvFact('Patient name', f.patientName, '') +
        pvFact('Report date', f.reportDate, '') +
        pvFact('Report type', f.reportType, 'grn') +
        pvFact('Age / gender', f.ageGender, 'sm') +
        pvFact('Fitness goal', f.goal, 'sm') +
        pvFact('Tests compared', f.testsCompared, 'mut') +
        '</div>';
    }
    var t = c.trajectory || {};
    if (t.show !== false && (t.label || t.summary)) {
      var lab = W(t.label || '—');
      var col = /improv/i.test(lab) ? '#3dd68c' : /worsen/i.test(lab) ? '#ff5c5c' : /stable/i.test(lab) ? '#4da6ff' : '#f5a623';
      h += '<div class="bbre-pv-banner" style="border-color:' + col + '">' +
        '<div class="bbre-pv-banner-l"><small>OVERALL TRAJECTORY</small><strong style="color:' + col + '">' + esc(lab) + '</strong></div>' +
        '<div class="bbre-pv-banner-r">' + esc(W(t.summary)) + '</div></div>';
    }
    var st = c.stats || {};
    var chips = (st.show === false ? [] : (st.items || [])).filter(function (x) { return x.show !== false && String(x.value || '').trim(); });
    if (chips.length) {
      h += '<div class="bbre-pv-chips">' + chips.map(function (x) {
        return '<div class="bbre-pv-chip"><b style="color:' + toneHex(x.tone) + '">' + esc(W(x.value)) + '</b><small>' + esc(W(x.label).toUpperCase()) + '</small></div>';
      }).join('') + '</div>';
    }
    var fn = c.footnote || {};
    if (fn.show !== false && String(fn.text || '').trim()) {
      h += '<div class="bbre-pv-foot">' + esc(W(fn.text)) + '</div>';
    }
    return h;
  }
  function pvFact(label, value, cls) {
    return '<div><div class="bbre-pv-fact-l">' + esc(label) + '</div>' +
      '<div class="bbre-pv-fact-v ' + (cls || '') + '">' + esc(W(value) || '—') + '</div></div>';
  }
  function toneHex(t) {
    return t === 'green' ? '#3dd68c' : t === 'red' ? '#ff5c5c' : t === 'amber' ? '#f5a623' : t === 'gold' ? '#e6c46a' : '#4da6ff';
  }
  function trendHex(d) {
    return d === 'improving' ? '#3dd68c' : d === 'worsening' ? '#ff5c5c' : d === 'changed' ? '#4da6ff' : '#8a8880';
  }
  function statusHex(st) {
    var s = String(st || '').toLowerCase();
    if (s === 'normal' || s === 'optimal') return '#3dd68c';
    if (s === 'critical' || s === 'high' || s === 'deficient' || s === 'elevated') return '#ff5c5c';
    if (!s) return '#f0ede8';
    return '#f5a623';
  }
  function pvHead(s) {
    var h = '';
    if (String(s.title || '').trim()) {
      h += '<div class="bbre-pv-head">' + esc(W(s.title)) + '</div><div class="bbre-pv-headrule"></div>';
    }
    if (String(s.subtitle || '').trim()) h += '<div class="bbre-pv-sub">' + esc(W(s.subtitle)) + '</div>';
    return h;
  }

  function pvSection(s) {
    if (s.type === 'trend') return pvTrend(s);
    if (s.type === 'text') return pvText(s);
    if (s.type === 'cards') return pvCards(s);
    if (s.type === 'table') return pvTable(s);
    if (s.type === 'callout') return pvCallout(s);
    if (s.type === 'disclaimer') return pvDisclaimer(s);
    return '';
  }

  function pvText(s) {
    var b = s.badge || {};
    var h = pvHead(s);
    if (b.show && (b.label || b.text)) {
      h += '<div class="bbre-pv-badge"><small>' + esc(W(b.label).toUpperCase()) + '</small><b>' + esc(W(b.text)) + '</b></div>';
    }
    if (String(s.body || '').trim()) h += '<div class="bbre-pv-body">' + esc(W(s.body)) + '</div>';
    return h;
  }

  function pvTrend(s) {
    var cols = (s.columns || []).map(function (c, i) { return { c: c, i: i }; }).filter(function (x) { return x.c.show !== false; });
    var panels = (s.panels || []).filter(function (p) { return p.show !== false; })
      .map(function (p) { return { name: p.name, markers: (p.markers || []).filter(function (m) { return m.show !== false; }) }; })
      .filter(function (p) { return p.markers.length; });
    if (!panels.length) return '';
    var h = pvHead(s);
    if (String(s.intro || '').trim()) h += '<div class="bbre-pv-body mut">' + esc(W(s.intro)) + '</div>';
    panels.forEach(function (p) {
      h += '<div class="bbre-pv-sub">' + esc(W(p.name)) + '</div>';
      h += '<div class="bbre-pv-tablewrap"><table class="bbre-pv-table"><thead><tr>' +
        '<th>Marker</th><th>Reference</th>' +
        cols.map(function (x) { return '<th class="dt">' + esc(W(x.c.label)) + '</th>'; }).join('') +
        '<th>Trend</th></tr></thead><tbody>';
      p.markers.forEach(function (m) {
        h += '<tr><td class="c-mk">' + esc(W(m.name)) + '</td>' +
          '<td class="c-muted">' + (esc(W(m.reference)) || '—') + '</td>';
        cols.forEach(function (x) {
          var v = (m.values || [])[x.i] || {};
          var text = W(v.text);
          h += text
            ? '<td style="font-weight:700;color:' + statusHex(v.status) + '">' + esc(text) + '</td>'
            : '<td class="c-muted">—</td>';
        });
        var tr = m.trend || {};
        var glyph = tr.arrow === 'up' ? '▲' : tr.arrow === 'down' ? '▼' : '–';
        h += '<td class="c-trend" style="color:' + trendHex(tr.dir) + '">' + glyph + ' ' + esc(W(tr.text)) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    });
    return h;
  }

  function pvCards(s) {
    var groups = (s.groups || []).filter(function (g) { return g.show !== false; })
      .map(function (g) { return { title: g.title, tone: g.tone, items: (g.items || []).filter(function (it) { return it.show !== false; }) }; })
      .filter(function (g) { return g.items.length; });
    if (!groups.length) return '';
    var h = pvHead(s);
    groups.forEach(function (g) {
      if (String(g.title || '').trim()) h += '<div class="bbre-pv-sub">' + esc(W(g.title)) + '</div>';
      g.items.forEach(function (it) {
        var from = W(it.from);
        var to = W(it.to);
        var arrow = from && to ? (from + '  ' + W('→') + '  ' + to) : (to || from || '');
        var lvlCol = it.level === 'High' ? '#ff5c5c' : it.level === 'Medium' ? '#f5a623' : '#3dd68c';
        var toneCol = g.tone === 'bad' ? '#ff5c5c' : g.tone === 'watch' ? '#f5a623' : '#3dd68c';
        h += '<div class="bbre-pv-card tone-' + esc(g.tone) + '">' +
          '<div class="bbre-pv-card-t">' + esc(W(it.marker)) +
          (it.level ? '<em style="color:' + lvlCol + '">' + esc(String(it.level).toUpperCase()) + '</em>' : '') + '</div>' +
          (arrow ? '<div class="bbre-pv-card-a" style="color:' + toneCol + '">' + esc(arrow) + '</div>' : '') +
          (String(it.meaning || '').trim() ? '<div class="bbre-pv-card-m">' + esc(W(it.meaning)) + '</div>' : '') +
          '</div>';
      });
    });
    return h;
  }

  function pvTable(s) {
    var cols = (s.columns || []).filter(function (c) { return c.show !== false; });
    var rows = (s.rows || []).filter(function (r) { return r.show !== false; });
    if (!cols.length || !rows.length) return '';
    var total = cols.reduce(function (a, c) { return a + (Number(c.width) || 0.25); }, 0) || 1;
    var h = pvHead(s);
    h += '<div class="bbre-pv-tablewrap"><table class="bbre-pv-table"><thead><tr>' +
      cols.map(function (c) {
        return '<th style="width:' + (((Number(c.width) || 0.25) / total) * 100).toFixed(1) + '%">' + esc(W(c.header)) + '</th>';
      }).join('') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>' + cols.map(function (c) {
        var v = W((r.cells || {})[c.id] || '');
        if (c.style === 'action') {
          var lc = String(v).toLowerCase();
          var col = lc === 'stop' ? '#ff5c5c' : lc === 'start' ? '#3dd68c' : lc === 'adjust' ? '#f5a623' : '#f0ede8';
          return '<td style="font-weight:700;color:' + col + '">' + esc(v) + '</td>';
        }
        var cls = c.style === 'accent' ? 'c-accent' : c.style === 'muted' ? 'c-muted'
          : c.style === 'warn' ? 'c-warn' : c.style === 'strong' ? 'c-strong' : '';
        return '<td class="' + cls + '">' + esc(v) + '</td>';
      }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function pvCallout(s) {
    if (!String(s.text || '').trim() && !String(s.label || '').trim()) return '';
    var h = pvHead(s);
    h += '<div class="bbre-pv-callout t-' + esc(s.tone || 'green') + (s.italic ? ' italic' : ' bold') + '">' +
      (String(s.label || '').trim() ? '<small>' + esc(W(s.label).toUpperCase()) + '</small>' : '') +
      '<div>' + esc(W(s.text)) + '</div></div>';
    return h;
  }

  function pvDisclaimer(s) {
    if (!String(s.text || '').trim()) return '';
    return pvHead(s) + '<div class="bbre-pv-disc"><b>' + esc(W(s.label)) + '</b><i>' + esc(W(s.text)) + '</i></div>';
  }

  // ------------------------------------------------------------------------
  // persistence + output
  // ------------------------------------------------------------------------
  function save(silent) {
    return new Promise(function (resolve) {
      if (!S.doc || !S.id) { resolve(false); return; }
      setBusy(true);
      setStatus('Saving…');
      apiCall('PUT', '/api/blood/admin/comparison/' + encodeURIComponent(S.id) + '/doc', { doc: S.doc })
        .then(function (d) {
          setBusy(false);
          if (!d || d.success === false || d.error) {
            setStatus('Not saved', 'is-dirty');
            alertBox('Could not save', (d && (d.error || d.message)) || 'Unknown error');
            resolve(false);
            return;
          }
          // Adopt the server's sanitised copy so screen and print stay identical.
          if (d.doc) S.doc = normalizeDoc(d.doc);
          S.dirty = false;
          S.edited = true;
          S.docUpdatedAt = new Date().toISOString();
          setHeader();
          setStatus('Saved', 'is-saved');
          renderAll(true);
          if (!silent) toast('Report saved');
          if (S.onSaved) { try { S.onSaved(S.id); } catch (_) {} }
          resolve(true);
        })
        .catch(function () {
          setBusy(false);
          setStatus('Not saved', 'is-dirty');
          alertBox('Could not save', 'Network error.');
          resolve(false);
        });
    });
  }

  // Run an action that needs the server to hold the current edits first.
  function saveThen(fn) {
    if (!S.dirty) { fn(); return; }
    save(true).then(function (ok) { if (ok) fn(); });
  }

  function resetDoc() {
    if (!window.confirm('Discard every edit and rebuild this report from the AI original?\n\nThis cannot be undone.')) return;
    setBusy(true);
    setStatus('Resetting…');
    apiCall('POST', '/api/blood/admin/comparison/' + encodeURIComponent(S.id) + '/doc/reset', {}).then(function (d) {
      setBusy(false);
      if (!d || d.success === false || d.error || !d.doc) {
        setStatus('');
        alertBox('Could not reset', (d && (d.error || d.message)) || 'Unknown error');
        return;
      }
      S.doc = normalizeDoc(d.doc);
      S.edited = false;
      S.docUpdatedAt = null;
      S.dirty = false;
      S.openMarkers = {};
      setHeader();
      setStatus('AI original');
      renderAll(false);
      toast('Reset to the AI original');
      if (S.onSaved) { try { S.onSaved(S.id); } catch (_) {} }
    }).catch(function () {
      setBusy(false);
      alertBox('Could not reset', 'Network error.');
    });
  }

  function fetchPdfFor(id, inline) {
    var base = (typeof API !== 'undefined' ? API : '');
    var url = base + '/api/blood/admin/comparison/' + encodeURIComponent(id) + '/pdf' + (inline ? '?inline=1' : '');
    var token = window.currentUser && window.currentUser.token;
    return fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error((j && j.error) || ('PDF failed (' + r.status + ')'));
        });
      }
      return r.blob();
    });
  }

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  // ========================================================================
  // FINAL PREVIEW + WHATSAPP SHARE
  // ========================================================================
  // The last stop before a report reaches a client: the real PDF, rendered from
  // the saved document, with the two ways WhatsApp can actually carry it.
  //
  // WhatsApp deep links (wa.me) cannot carry an attachment — there is no media
  // parameter, by design. So there are exactly two honest routes, and the sheet
  // offers both rather than pretending one does the other's job:
  //   • the OS share sheet, which hands WhatsApp the real PDF file, but lets the
  //     phone pick the recipient;
  //   • a direct link into THIS client's chat, carrying a revocable URL that
  //     opens the report.

  var PV_ID = 'bbReportPreview';
  var P = { id: null, blobUrl: null, file: null, clientName: '', clientPhone: '', share: null, busy: false };

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function canShareFiles(file) {
    try {
      return !!(navigator.canShare && navigator.share && file && navigator.canShare({ files: [file] }));
    } catch (_) { return false; }
  }
  function pvRoot() { return document.getElementById(PV_ID); }

  function ensurePreviewShell() {
    var existing = pvRoot();
    if (existing) return existing;
    var el = document.createElement('div');
    el.id = PV_ID;
    el.className = 'bbre-pv2';
    el.innerHTML =
      '<div class="bbre-pv2-shell" role="dialog" aria-modal="true" aria-label="Final report preview">' +
        '<div class="bbre-top">' +
          '<div class="bbre-title"><strong>Final report preview</strong>' +
          '<span class="bbre-sub" id="bbrePvSub"></span></div>' +
          '<button type="button" class="bbre-x" data-pv="close" aria-label="Close preview">&#10005;</button>' +
        '</div>' +
        '<div class="bbre-pv2-body" id="bbrePvBody"></div>' +
        '<div class="bbre-bottom">' +
          '<button type="button" class="bbre-btn" data-pv="download">Download PDF</button>' +
          '<button type="button" class="bbre-btn wa" data-pv="share">Share on WhatsApp</button>' +
        '</div>' +
        '<div class="bbre-sheet" id="bbreSheet" hidden></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', onPreviewClick);
    return el;
  }

  function onPreviewClick(e) {
    var t = e.target.closest ? e.target.closest('[data-pv]') : null;
    if (!t) return;
    e.preventDefault();
    var act = t.getAttribute('data-pv');
    if (act === 'close') return closePreview();
    if (act === 'download') return downloadCurrent();
    if (act === 'share') return openShareSheet();
    if (act === 'sheet-close') return closeShareSheet();
    if (act === 'share-file') return shareFile();
    if (act === 'share-chat') return shareToChat();
    if (act === 'copy-link') return copyShareLink();
    if (act === 'revoke') return revokeShareLink();
    if (act === 'open-pdf') {
      if (P.blobUrl) window.open(P.blobUrl, '_blank');
      return undefined;
    }
    return undefined;
  }

  function pvBusy(on) {
    P.busy = !!on;
    var el = pvRoot();
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.bbre-bottom .bbre-btn, .bbre-sheet-btn'), function (b) {
      b.disabled = !!on;
    });
  }

  /**
   * Build the report PDF and show it. Call after saving — it renders whatever the
   * server currently holds, which is what the client would receive.
   */
  function openPreview(id, opts) {
    opts = opts || {};
    var el = ensurePreviewShell();
    P.id = id;
    P.clientName = opts.clientName || '';
    P.clientPhone = opts.clientPhone || '';
    P.share = null;
    releaseBlob();
    el.classList.add('is-open');
    document.body.classList.add('bbre-locked');
    document.getElementById('bbrePvSub').textContent = P.clientName || '';
    document.getElementById('bbrePvBody').innerHTML =
      '<div class="bbre-loading">Building the final PDF…</div>';
    closeShareSheet();
    pvBusy(true);

    fetchPdfFor(id, true).then(function (blob) {
      pvBusy(false);
      P.blobUrl = URL.createObjectURL(blob);
      try {
        P.file = new File([blob], 'BodyBank_Progress_Report.pdf', { type: 'application/pdf' });
      } catch (_) {
        P.file = null; // very old browsers: share-as-file simply won't be offered
      }
      var body = document.getElementById('bbrePvBody');
      if (isIOS()) {
        // iOS Safari will not render a PDF inside an iframe — it shows a blank box.
        // Offer the real thing instead of a broken embed.
        body.innerHTML =
          '<div class="bbre-pv2-ios">' +
            '<div class="bbre-pv2-ios-ico">&#128196;</div>' +
            '<p><strong>Your report is ready.</strong></p>' +
            '<p class="bbre-hint">iPhones and iPads can\'t display a PDF inside the app, so tap below to read it ' +
            'through, then come back to share it.</p>' +
            '<button type="button" class="bbre-btn primary" data-pv="open-pdf">Open the PDF</button>' +
          '</div>';
      } else {
        body.innerHTML = '<iframe class="bbre-pv2-frame" title="Report preview" src="' + P.blobUrl + '"></iframe>';
      }
    }).catch(function (err) {
      pvBusy(false);
      document.getElementById('bbrePvBody').innerHTML =
        '<div class="bbre-error">' + esc((err && err.message) || 'Could not build the PDF.') + '</div>';
    });
  }

  function releaseBlob() {
    if (P.blobUrl) { try { URL.revokeObjectURL(P.blobUrl); } catch (_) {} }
    P.blobUrl = null;
    P.file = null;
  }

  function closePreview() {
    var el = pvRoot();
    if (el) el.classList.remove('is-open');
    closeShareSheet();
    releaseBlob();
    // The editor may still be open underneath; only unlock when nothing is showing.
    var ed = root();
    if (!ed || !ed.classList.contains('is-open')) document.body.classList.remove('bbre-locked');
  }

  function downloadCurrent() {
    if (!P.id) return;
    pvBusy(true);
    fetchPdfFor(P.id, false).then(function (blob) {
      pvBusy(false);
      saveBlob(blob, 'BodyBank_Progress_Report.pdf');
    }).catch(function (err) {
      pvBusy(false);
      alertBox('Download failed', (err && err.message) || 'Could not build the PDF.');
    });
  }

  // ---- share sheet ---------------------------------------------------------
  function closeShareSheet() {
    var s = document.getElementById('bbreSheet');
    if (s) { s.hidden = true; s.innerHTML = ''; }
  }

  function openShareSheet() {
    var s = document.getElementById('bbreSheet');
    if (!s) return;
    // Entry points that don't know the client's number (the card buttons) would
    // otherwise render "Open chat" as permanently disabled. Ask the server once,
    // then redraw with the real answer.
    if (!P.clientPhone && !P.share) {
      getShareLink().then(function (d) { if (d && d.clientPhone) openShareSheet(); }).catch(function () {});
    }
    var who = P.clientName || 'the client';
    var fileOk = canShareFiles(P.file);
    var h = '<div class="bbre-sheet-card">';
    h += '<div class="bbre-sheet-head"><strong>Send to ' + esc(who) + '</strong>' +
      '<button type="button" class="bbre-ico" data-pv="sheet-close" aria-label="Close">&#10005;</button></div>';

    if (fileOk) {
      h += '<button type="button" class="bbre-sheet-btn" data-pv="share-file">' +
        '<span class="bbre-sheet-ico">&#128206;</span>' +
        '<span><b>Send the PDF file</b><small>Opens your phone\'s share sheet with the report attached. ' +
        'Choose WhatsApp, then choose ' + esc(who) + '.</small></span></button>';
    }

    var phone = String(P.clientPhone || '').replace(/[^0-9]/g, '');
    h += '<button type="button" class="bbre-sheet-btn" data-pv="share-chat"' + (phone.length >= 7 ? '' : ' disabled') + '>' +
      '<span class="bbre-sheet-ico">&#128172;</span>' +
      '<span><b>Open ' + esc(who) + '’s chat</b><small>' +
      (phone.length >= 7
        ? 'Goes straight to their WhatsApp with a secure link that opens the report.'
        : 'No mobile number saved for this client — add one on their profile first.') +
      '</small></span></button>';

    h += '<button type="button" class="bbre-sheet-btn" data-pv="copy-link">' +
      '<span class="bbre-sheet-ico">&#128279;</span>' +
      '<span><b>Copy the report link</b><small>Paste it anywhere yourself.</small></span></button>';

    h += '<p class="bbre-sheet-note">WhatsApp links can’t carry an attachment, so the chat and copy options send a ' +
      'secure link instead of the file. The link opens the report on any phone and stops working after ' +
      'the expiry date.</p>';
    h += '<div id="bbreSheetState" class="bbre-sheet-state"></div>';
    h += '</div>';
    s.innerHTML = h;
    s.hidden = false;
  }

  function sheetState(msg, cls) {
    var el = document.getElementById('bbreSheetState');
    if (el) el.innerHTML = msg ? '<span class="' + (cls || '') + '">' + msg + '</span>' : '';
  }

  /** Hand WhatsApp (or any app) the actual PDF through the OS share sheet. */
  function shareFile() {
    if (!P.file) return;
    var text = 'Your BodyBank blood progress report' + (P.clientName ? ' — ' + P.clientName : '') + '.';
    navigator.share({ files: [P.file], title: 'BodyBank Progress Report', text: text })
      .then(function () { closeShareSheet(); toast('Shared'); })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return; // the user backed out
        // Some platforms reject files alongside text — retry with the file alone.
        navigator.share({ files: [P.file] })
          .then(function () { closeShareSheet(); toast('Shared'); })
          .catch(function (e2) {
            if (e2 && e2.name === 'AbortError') return;
            sheetState('Your browser blocked the share sheet. Use “Open chat” or “Copy link” instead.', 'warn');
          });
      });
  }

  /** Mint (or reuse) the public link, then jump into this client's WhatsApp chat. */
  function shareToChat() {
    // Open the tab inside the click gesture, or mobile browsers block it.
    var tab = window.open('', '_blank');
    sheetState('Preparing the link…');
    pvBusy(true);
    getShareLink().then(function (d) {
      pvBusy(false);
      if (!d) { if (tab && !tab.closed) tab.close(); return; }
      if (!d.waUrl) {
        if (tab && !tab.closed) tab.close();
        sheetState('No usable mobile number for this client.', 'warn');
        return;
      }
      if (tab && !tab.closed) tab.location.href = d.waUrl;
      else window.location.href = d.waUrl;
      sheetState('Opened WhatsApp. Link valid until ' + esc(fmtDay(d.expiresAt)) + '.', 'good');
    }).catch(function () {
      pvBusy(false);
      if (tab && !tab.closed) tab.close();
      sheetState('Could not create the link.', 'warn');
    });
  }

  function copyShareLink() {
    sheetState('Preparing the link…');
    pvBusy(true);
    getShareLink().then(function (d) {
      pvBusy(false);
      if (!d) return;
      var validity = 'Valid until ' + esc(fmtDay(d.expiresAt)) + '. ' +
        '<button type="button" class="bbre-linkbtn" data-pv="revoke">Revoke link</button>';
      // Show the link before attempting the clipboard: writeText can reject — or
      // hang indefinitely — when the document isn't focused, and the reviewer must
      // still walk away with a usable link either way.
      sheetState('Link ready. ' + validity, 'good');
      copyText(d.message).then(function (okCopy) {
        sheetState(okCopy
          ? 'Message and link copied. ' + validity
          : 'Your browser blocked the copy — select the text below instead. ' + validity +
            '<textarea class="bbre-ta" readonly rows="4" style="margin-top:8px">' + esc(d.message) + '</textarea>',
          okCopy ? 'good' : 'warn');
      });
    }).catch(function () {
      pvBusy(false);
      sheetState('Could not create the link.', 'warn');
    });
  }

  function revokeShareLink() {
    if (!window.confirm('Revoke the shared link? Anyone who already has it will no longer be able to open the report.')) return;
    pvBusy(true);
    apiCall('DELETE', '/api/blood/admin/comparison/' + encodeURIComponent(P.id) + '/share-link', {}).then(function (d) {
      pvBusy(false);
      P.share = null;
      sheetState(d && d.success === false ? 'Could not revoke the link.' : 'Link revoked.', d && d.success === false ? 'warn' : 'good');
    }).catch(function () { pvBusy(false); sheetState('Could not revoke the link.', 'warn'); });
  }

  // Cached per preview session so "copy" then "open chat" reuse one link rather
  // than minting a second token and orphaning the first.
  function getShareLink() {
    if (P.share) return Promise.resolve(P.share);
    return apiCall('POST', '/api/blood/admin/comparison/' + encodeURIComponent(P.id) + '/share-link', {})
      .then(function (d) {
        if (!d || d.success === false || d.error) {
          sheetState(esc((d && (d.error || d.message)) || 'Could not create the link.'), 'warn');
          return null;
        }
        P.share = d;
        if (!P.clientPhone && d.clientPhone) P.clientPhone = d.clientPhone;
        return d;
      });
  }

  function fmtDay(v) {
    var d = new Date(v);
    return isNaN(d.getTime()) ? 'the expiry date'
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function copyText(text) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return Promise.resolve(legacyCopy(text));
    // An unfocused document can leave writeText pending forever, so race it.
    return Promise.race([
      navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); }),
      new Promise(function (resolve) { setTimeout(function () { resolve(legacyCopy(text)); }, 1200); })
    ]);
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var okCopy = document.execCommand('copy');
      document.body.removeChild(ta);
      return okCopy;
    } catch (_) { return false; }
  }

  /**
   * Preview a saved report without opening the editor — used by the Share and
   * Preview buttons on the comparison card itself.
   */
  function previewOnly(id, opts) {
    openPreview(id, opts || {});
  }

  window.bbOpenReportEditor = open;
  window.bbCloseReportEditor = close;
  window.bbPreviewReportPdf = previewOnly;
})();
