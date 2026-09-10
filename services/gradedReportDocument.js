'use strict';

/**
 * BodyBank — the EDITABLE graded-report DOCUMENT.
 *
 * The same architecture the progress report already uses (services/comparisonDocument.js),
 * applied to the single graded health report:
 *
 *   HealthReport ──buildGradedDoc()──▶ doc ──PDFKit──▶ PDF
 *                                       ▲
 *                          the reviewer edits it in the app
 *
 * ─── WHY A DOCUMENT SITS BETWEEN THE ENGINE AND THE PAGE ──────────────────────
 * Without this layer the PDF renders straight off the engine output, which means a
 * reviewing coach or doctor cannot change a single word before it reaches a client.
 * The existing classic report has exactly that problem: its only editable surface is
 * a notes textarea. Here, the document IS the report — everything printed comes from
 * it, so "what the reviewer sees in the editor" and "what the client receives" cannot
 * disagree.
 *
 * ─── WHAT IS EDITABLE, AND WHAT IS NOT ────────────────────────────────────────
 * Every section can be hidden, retitled, reordered or deleted, and prose can be
 * rewritten freely. Two things are deliberately NOT editable:
 *
 *   • The RESULT layer — measured values, units and reference ranges. These are what
 *     the lab printed. A report where a reviewer can retype a number is a report
 *     nobody can trust.
 *   • The STATUS layer — the derived classification. It follows from the value and
 *     the range by arithmetic; editing it would break the audit trail that makes a
 *     grade explainable.
 *
 * A reviewer who disagrees with a grade hides the section or writes a note beside it.
 * That keeps disagreement visible rather than silently rewriting the evidence.
 *
 * Section types:
 *   healthmap  — the grade grid (page-1 hero)
 *   priorities — up to three priority cards
 *   areacards  — per-area drill-downs
 *   markers    — the full lab table, grouped
 *   progress   — improved / stable / needs attention, new & resolved
 *   text       — heading + prose
 *   list       — numbered or bulleted steps
 *   callout    — a boxed highlight (critical findings, coach's note)
 *   disclaimer — the fixed medical disclaimer
 */

const DOC_VERSION = 1;

/**
 * Shortest string accepted as a medical disclaimer. Long enough that no real
 * disclaimer trips it, short enough that a legitimate rewrite is not blocked.
 */
const MIN_DISCLAIMER_CHARS = 60;

/**
 * Guard rails for anything arriving from a browser. Generous enough that no real
 * report reaches them, tight enough that a malformed payload cannot exhaust memory
 * or produce a PDF that never finishes rendering.
 */
const LIMITS = {
  sections: 60,
  title: 240,
  subtitle: 400,
  body: 40000,
  short: 600,
  areas: 12,
  priorities: 3,
  markerGroups: 20,
  markersPerGroup: 200,
  listItems: 40,
  progressItems: 200,
  findings: 30
};

const SECTION_TYPES = ['healthmap', 'priorities', 'areacards', 'markers', 'progress',
  'text', 'list', 'callout', 'disclaimer'];
const CALLOUT_TONES = ['neutral', 'gold', 'attention', 'review'];
const LIST_STYLES = ['numbered', 'bulleted'];

let idSeq = 0;
function newId(prefix) {
  idSeq += 1;
  return `${prefix || 's'}-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

function str(v, max) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  const cap = max || LIMITS.short;
  return s.length > cap ? s.slice(0, cap) : s;
}
function bool(v, dflt) {
  if (v === true) return true;
  if (v === false) return false;
  return !!dflt;
}
function arr(v, max) {
  if (!Array.isArray(v)) return [];
  return max && v.length > max ? v.slice(0, max) : v;
}
function pick(v, allowed, dflt) {
  const s = String(v == null ? '' : v);
  return allowed.indexOf(s) >= 0 ? s : dflt;
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * Format a report date without a timezone dragging it onto the previous day.
 * A pg DATE column arrives here as the string 'YYYY-MM-DD'; treating that as UTC
 * midnight and reading local components loses a day west of Greenwich.
 */
function formatDate(v) {
  const s = String(v == null ? '' : v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Building the default document
// ---------------------------------------------------------------------------

/**
 * Turn a HealthReport into the default editable document.
 *
 * Order is fixed and matches the report's information architecture: anything at a
 * panic level first, then the map, the framing sentence, the priorities, the area
 * cards, progress, the full table, next steps, the coach's note and the disclaimer.
 *
 * @param {object} report HealthReport from services/gradedHealthReport.js
 * @param {object} [opts] { coachNote }
 * @returns {object} doc
 */
function buildGradedDoc(report, opts) {
  const o = opts || {};
  const sections = [];
  const R = report || {};

  // 0. Panic-level results, above everything. Only present when they exist.
  if ((R.criticalFindings || []).length) {
    sections.push({
      id: newId('crit'),
      type: 'callout',
      show: true,
      pageBreak: false,
      tone: 'review',
      title: 'Results to review first',
      body: 'These results sit well outside their reference range. Please bring them to a healthcare professional.',
      items: R.criticalFindings.map((f) => ({
        id: newId('ci'),
        show: true,
        label: f.displayName,
        result: f.result,
        range: (f.range && f.range.text) || '',
        status: f.statusLabel,
        note: f.insight || ''
      }))
    });
  }

  // 1. Health Map — the hero of page one.
  sections.push({
    id: newId('map'),
    type: 'healthmap',
    show: true,
    pageBreak: false,
    title: 'Your Health Map',
    subtitle: 'How each area of your health looks on this screening.',
    legend: true,
    areas: (R.healthMap || []).slice(0, LIMITS.areas).map((a) => ({
      id: newId('ma'),
      areaId: a.areaId,
      show: true,
      label: a.label,
      grade: a.grade,
      gradeLabel: a.gradeLabel,
      previousGrade: a.previousGrade || null,
      trend: a.trend || 'NOT_COMPARABLE'
    })),
    notAssessed: (R.notAssessed || []).map((a) => ({
      id: newId('na'),
      show: true,
      label: a.label,
      needs: a.needs
    })),
    notAssessedTitle: 'Not assessed in this screening'
  });

  // 2. Key message.
  sections.push({
    id: newId('key'),
    type: 'text',
    show: true,
    pageBreak: false,
    variant: 'lead',
    title: '',
    body: [R.keyMessage, R.firstScreeningNote].filter(Boolean).join(' ')
  });

  // 3. Priorities — page two in print.
  sections.push({
    id: newId('pri'),
    type: 'priorities',
    show: true,
    pageBreak: true,
    title: 'Your Top Priorities',
    subtitle: (R.priorities || []).length
      ? 'The findings worth your attention first. Nothing else on this report is more important than these.'
      : 'No finding on this screening rises to the level of a priority.',
    items: (R.priorities || []).slice(0, LIMITS.priorities).map((p) => ({
      id: newId('p'),
      show: true,
      rank: p.rank,
      title: p.title,
      areaLabel: p.areaLabel,
      grade: p.grade,
      result: p.result,
      status: p.statusLabel,
      whyItMatters: p.whyItMatters,
      nextStep: p.nextStep,
      professionalNote: p.professionalNote || '',
      requiresProfessional: !!p.requiresProfessional
    }))
  });

  // 4. Progress, when there is a genuine previous screening.
  if (R.progress) {
    const item = (m) => ({
      id: newId('pg'),
      show: true,
      label: m.displayName,
      previous: m.previous ? `${m.previous.value}${m.unit ? ' ' + m.unit : ''}` : '',
      current: `${m.value != null ? m.value : ''}${m.unit ? ' ' + m.unit : ''}`,
      trend: m.trend,
      newReason: m.newReason || null
    });
    sections.push({
      id: newId('prog'),
      type: 'progress',
      show: true,
      pageBreak: true,
      title: 'Your Health Progress',
      subtitle: `${formatDate(R.progress.previousDate)} to ${formatDate(R.progress.currentDate)}` +
        (R.progress.intervalDays != null ? ` — ${R.progress.intervalDays} days apart` : ''),
      caution: R.progress.shortInterval ? R.progress.shortIntervalNote : '',
      groups: [
        { id: newId('g'), key: 'improved', show: true, title: 'Improved', items: arr(R.progress.improved, LIMITS.progressItems).map(item) },
        { id: newId('g'), key: 'needsAttention', show: true, title: 'Needs Attention', items: arr(R.progress.needsAttention, LIMITS.progressItems).map(item) },
        { id: newId('g'), key: 'newFindings', show: true, title: 'New Findings', items: arr(R.progress.newFindings, LIMITS.progressItems).map(item) },
        { id: newId('g'), key: 'resolved', show: true, title: 'Resolved', items: arr(R.progress.resolved, LIMITS.progressItems).map(item) },
        { id: newId('g'), key: 'stable', show: true, title: 'Stable', items: arr(R.progress.stable, LIMITS.progressItems).map(item) }
      ]
    });
  }

  // 5. Health-area drill-downs, worst first.
  sections.push({
    id: newId('areas'),
    type: 'areacards',
    show: true,
    pageBreak: true,
    title: 'Your Health Areas',
    subtitle: 'What was measured in each area, and what it points to.',
    cards: (R.areas || []).slice(0, LIMITS.areas).map((a) => ({
      id: newId('ac'),
      areaId: a.areaId,
      show: true,
      label: a.label,
      grade: a.grade,
      gradeLabel: a.gradeLabel,
      gradeMeaning: a.gradeMeaning,
      summary: a.summary || '',
      trendLine: a.trendLine || '',
      focus: a.focus || '',
      requiresProfessional: !!a.requiresProfessional,
      findings: arr(a.keyFindings, LIMITS.findings).map((f) => ({
        id: newId('f'),
        show: true,
        label: f.displayName,
        result: f.result,
        range: (f.range && f.range.text) || '',
        rangeSource: (f.range && f.range.source) || null,
        status: f.statusLabel,
        statusMark: f.statusMark,
        insight: f.insight || '',
        nextStep: f.nextStep || '',
        trend: f.trend,
        trendLabel: f.trendLabel,
        previous: f.previous ? String(f.previous.value) : ''
      }))
    }))
  });

  // 6. Everything that was measured. Nothing omitted.
  sections.push({
    id: newId('tbl'),
    type: 'markers',
    show: true,
    pageBreak: true,
    title: 'Detailed Lab Results',
    subtitle: 'Every marker on your report, grouped by health area. Results not mapped to an area appear last.',
    groups: arr(R.markerGroups, LIMITS.markerGroups).map((g) => ({
      id: newId('mg'),
      areaId: g.areaId,
      show: true,
      label: g.label,
      markers: arr(g.markers, LIMITS.markersPerGroup).map((m) => ({
        id: newId('m'),
        show: true,
        label: m.displayName,
        printedName: m.printedName !== m.displayName ? m.printedName : '',
        result: m.result,
        range: (m.range && m.range.text) || '—',
        rangeSource: (m.range && m.range.source) || null,
        status: m.statusLabel,
        statusMark: m.statusMark,
        statusSource: m.statusSource,
        duplicate: !!m.duplicate,
        insight: m.insight || '',
        trend: m.trend,
        trendLabel: m.trendLabel,
        previous: m.previous ? String(m.previous.value) : ''
      }))
    }))
  });

  // 7. Next steps.
  sections.push({
    id: newId('steps'),
    type: 'list',
    show: true,
    pageBreak: false,
    style: 'numbered',
    title: 'Your Next Steps',
    subtitle: '',
    items: arr(R.nextSteps, LIMITS.listItems).map((s) => ({
      id: newId('st'),
      show: true,
      text: s.text,
      requiresProfessional: !!s.requiresProfessional
    }))
  });

  // 8. The clinical narrative from the existing analysis pass, when present. Kept
  // as ordinary editable prose so a reviewer can trim or delete it entirely.
  const clinical = R.clinical;
  if (clinical && clinical.clinical_interpretation) {
    sections.push({
      id: newId('clin'),
      type: 'text',
      show: true,
      pageBreak: true,
      variant: 'body',
      title: 'Clinical Interpretation',
      subtitle: 'A fuller narrative review of this panel.',
      body: str(clinical.clinical_interpretation, LIMITS.body)
    });
  }

  // 9. The coach's note — synced with admin_notes, as the progress report does.
  sections.push({
    id: newId('note'),
    type: 'callout',
    show: !!o.coachNote,
    pageBreak: false,
    tone: 'gold',
    coachNote: true,
    title: 'A note from your coach',
    body: str(o.coachNote || '', LIMITS.body),
    items: []
  });

  // 10. Always last, never collapsed.
  sections.push({
    id: newId('disc'),
    type: 'disclaimer',
    show: true,
    locked: true,
    pageBreak: false,
    title: 'Medical Disclaimer',
    body: R.disclaimer || ''
  });

  return {
    docVersion: DOC_VERSION,
    engineVersion: R.engineVersion || '',
    rulesetVersion: R.rulesetVersion || '',
    modelVersion: R.modelVersion || '',
    cover: {
      title: R.reportTitle || 'BodyBank Health Map Report',
      clientName: str(R.client && R.client.name, LIMITS.title),
      clientMeta: [R.client && R.client.age, R.client && R.client.sex, R.client && R.client.goal]
        .filter(Boolean).join('  ·  '),
      screeningDate: R.screeningDate || '',
      screeningDateLabel: formatDate(R.screeningDate),
      reportId: str(R.reportId, 120),
      summary: str(R.keyMessage, LIMITS.subtitle),
      stats: [
        { id: newId('cs'), show: true, label: 'Areas assessed', value: String((R.healthMapSummary || {}).assessed || 0) },
        { id: newId('cs'), show: true, label: 'Markers measured', value: String(R.markerCount || 0) },
        { id: newId('cs'), show: true, label: 'Priorities', value: String((R.priorities || []).length) }
      ]
    },
    sections
  };
}

// ---------------------------------------------------------------------------
// Sanitising a document that came back from a browser
// ---------------------------------------------------------------------------

function sanitizeItemCommon(it, prefix) {
  return {
    id: str(it && it.id, 80) || newId(prefix),
    show: bool(it && it.show, true)
  };
}

/**
 * Normalise an edited document. Anything unrecognised is dropped rather than
 * trusted: the renderer must never receive a shape it did not expect.
 *
 * The RESULT and STATUS fields survive an edit only as strings the editor sent back
 * unchanged — the editor does not expose them for editing, and the golden-regression
 * test asserts that a round trip leaves them identical to the engine output.
 */
function sanitizeGradedDoc(input) {
  const doc = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const cover = (doc.cover && typeof doc.cover === 'object') ? doc.cover : {};

  const out = {
    docVersion: num(doc.docVersion, DOC_VERSION),
    engineVersion: str(doc.engineVersion, 80),
    rulesetVersion: str(doc.rulesetVersion, 80),
    modelVersion: str(doc.modelVersion, 80),
    cover: {
      title: str(cover.title, LIMITS.title) || 'BodyBank Health Map Report',
      clientName: str(cover.clientName, LIMITS.title),
      clientMeta: str(cover.clientMeta, LIMITS.subtitle),
      screeningDate: str(cover.screeningDate, 40),
      screeningDateLabel: str(cover.screeningDateLabel, 80),
      reportId: str(cover.reportId, 120),
      summary: str(cover.summary, LIMITS.subtitle),
      stats: arr(cover.stats, 8).map((s) => Object.assign(sanitizeItemCommon(s, 'cs'), {
        label: str(s && s.label, 80),
        value: str(s && s.value, 40)
      }))
    },
    sections: []
  };

  arr(doc.sections, LIMITS.sections).forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    const type = pick(raw.type, SECTION_TYPES, null);
    if (!type) return;

    const s = {
      id: str(raw.id, 80) || newId(type),
      type,
      show: bool(raw.show, true),
      pageBreak: bool(raw.pageBreak, false),
      title: str(raw.title, LIMITS.title),
      subtitle: str(raw.subtitle, LIMITS.subtitle)
    };

    if (type === 'healthmap') {
      s.legend = bool(raw.legend, true);
      s.notAssessedTitle = str(raw.notAssessedTitle, LIMITS.title) || 'Not assessed in this screening';
      s.areas = arr(raw.areas, LIMITS.areas).map((a) => Object.assign(sanitizeItemCommon(a, 'ma'), {
        areaId: str(a && a.areaId, 60),
        label: str(a && a.label, 120),
        grade: pick(a && a.grade, ['A', 'B', 'C', 'D', 'NOT_ASSESSED'], 'NOT_ASSESSED'),
        gradeLabel: str(a && a.gradeLabel, 80),
        previousGrade: pick(a && a.previousGrade, ['A', 'B', 'C', 'D'], null),
        trend: str(a && a.trend, 40)
      }));
      s.notAssessed = arr(raw.notAssessed, LIMITS.areas).map((a) => Object.assign(sanitizeItemCommon(a, 'na'), {
        label: str(a && a.label, 120),
        needs: str(a && a.needs, LIMITS.subtitle)
      }));
    } else if (type === 'priorities') {
      s.items = arr(raw.items, LIMITS.priorities).map((p, i) => Object.assign(sanitizeItemCommon(p, 'p'), {
        rank: num(p && p.rank, i + 1),
        title: str(p && p.title, LIMITS.title),
        areaLabel: str(p && p.areaLabel, 120),
        grade: pick(p && p.grade, ['A', 'B', 'C', 'D'], 'C'),
        result: str(p && p.result, LIMITS.short),
        status: str(p && p.status, 80),
        whyItMatters: str(p && p.whyItMatters, LIMITS.short),
        nextStep: str(p && p.nextStep, LIMITS.short),
        professionalNote: str(p && p.professionalNote, LIMITS.short),
        requiresProfessional: bool(p && p.requiresProfessional, false)
      }));
    } else if (type === 'areacards') {
      s.cards = arr(raw.cards, LIMITS.areas).map((c) => Object.assign(sanitizeItemCommon(c, 'ac'), {
        areaId: str(c && c.areaId, 60),
        label: str(c && c.label, 120),
        grade: pick(c && c.grade, ['A', 'B', 'C', 'D', 'NOT_ASSESSED'], 'NOT_ASSESSED'),
        gradeLabel: str(c && c.gradeLabel, 80),
        gradeMeaning: str(c && c.gradeMeaning, LIMITS.subtitle),
        summary: str(c && c.summary, LIMITS.body),
        trendLine: str(c && c.trendLine, LIMITS.body),
        focus: str(c && c.focus, LIMITS.body),
        requiresProfessional: bool(c && c.requiresProfessional, false),
        findings: arr(c && c.findings, LIMITS.findings).map((f) => Object.assign(sanitizeItemCommon(f, 'f'), {
          label: str(f && f.label, 120),
          result: str(f && f.result, 120),
          range: str(f && f.range, 120),
          rangeSource: str(f && f.rangeSource, 40) || null,
          status: str(f && f.status, 80),
          statusMark: str(f && f.statusMark, 8),
          insight: str(f && f.insight, LIMITS.body),
          nextStep: str(f && f.nextStep, LIMITS.body),
          trend: str(f && f.trend, 40),
          trendLabel: str(f && f.trendLabel, 60),
          previous: str(f && f.previous, 60)
        }))
      }));
    } else if (type === 'markers') {
      s.groups = arr(raw.groups, LIMITS.markerGroups).map((g) => Object.assign(sanitizeItemCommon(g, 'mg'), {
        areaId: str(g && g.areaId, 60),
        label: str(g && g.label, 120),
        markers: arr(g && g.markers, LIMITS.markersPerGroup).map((m) => Object.assign(sanitizeItemCommon(m, 'm'), {
          label: str(m && m.label, 120),
          printedName: str(m && m.printedName, 120),
          result: str(m && m.result, 120),
          range: str(m && m.range, 120),
          rangeSource: str(m && m.rangeSource, 40) || null,
          status: str(m && m.status, 80),
          statusMark: str(m && m.statusMark, 8),
          statusSource: str(m && m.statusSource, 40),
          duplicate: bool(m && m.duplicate, false),
          insight: str(m && m.insight, LIMITS.body),
          trend: str(m && m.trend, 40),
          trendLabel: str(m && m.trendLabel, 60),
          previous: str(m && m.previous, 60)
        }))
      }));
    } else if (type === 'progress') {
      s.caution = str(raw.caution, LIMITS.subtitle);
      s.groups = arr(raw.groups, 8).map((g) => Object.assign(sanitizeItemCommon(g, 'g'), {
        key: str(g && g.key, 40),
        title: str(g && g.title, LIMITS.title),
        items: arr(g && g.items, LIMITS.progressItems).map((it) => Object.assign(sanitizeItemCommon(it, 'pg'), {
          label: str(it && it.label, 120),
          previous: str(it && it.previous, 80),
          current: str(it && it.current, 80),
          trend: str(it && it.trend, 40),
          newReason: str(it && it.newReason, 40) || null
        }))
      }));
    } else if (type === 'list') {
      s.style = pick(raw.style, LIST_STYLES, 'numbered');
      s.items = arr(raw.items, LIMITS.listItems).map((it) => Object.assign(sanitizeItemCommon(it, 'st'), {
        text: str(it && it.text, LIMITS.body),
        requiresProfessional: bool(it && it.requiresProfessional, false)
      }));
    } else if (type === 'callout') {
      s.tone = pick(raw.tone, CALLOUT_TONES, 'neutral');
      s.coachNote = bool(raw.coachNote, false);
      s.body = str(raw.body, LIMITS.body);
      s.items = arr(raw.items, LIMITS.findings).map((it) => Object.assign(sanitizeItemCommon(it, 'ci'), {
        label: str(it && it.label, 120),
        result: str(it && it.result, 120),
        range: str(it && it.range, 120),
        status: str(it && it.status, 80),
        note: str(it && it.note, LIMITS.body)
      }));
    } else if (type === 'text') {
      s.variant = pick(raw.variant, ['lead', 'body'], 'body');
      s.body = str(raw.body, LIMITS.body);
    } else if (type === 'disclaimer') {
      // The disclaimer is locked: a reviewer can move it, but not delete it, hide it
      // or empty it. It is the one section the product cannot ship without, so a
      // blank body is refilled with the canonical text rather than printed empty.
      s.locked = true;
      s.show = true;
      s.title = s.title || 'Medical Disclaimer';
      const body = str(raw.body, LIMITS.body).trim();
      // A genuine legal rewrite is welcome; gutting the disclaimer to a token
      // character is not. Anything too short to be a disclaimer is treated the same
      // as an empty one and replaced with the canonical text.
      s.body = body.length >= MIN_DISCLAIMER_CHARS ? body : require('./grading/copy').DISCLAIMER;
    }

    out.sections.push(s);
  });

  // A document that arrived without a disclaimer gets one back. This is the last
  // line of defence: no path through the editor can produce a report without it.
  if (!out.sections.some((s) => s.type === 'disclaimer')) {
    out.sections.push({
      id: newId('disc'),
      type: 'disclaimer',
      show: true,
      locked: true,
      pageBreak: false,
      title: 'Medical Disclaimer',
      subtitle: '',
      body: require('./grading/copy').DISCLAIMER
    });
  }

  return out;
}

/** Does this document have anything worth printing? */
function docHasVisibleContent(doc) {
  if (!doc || !Array.isArray(doc.sections)) return false;
  return doc.sections.some((s) => s.show && s.type !== 'disclaimer');
}

/** Read the coach's note out of a document (used to sync admin_notes). */
function docCoachNote(doc) {
  if (!doc || !Array.isArray(doc.sections)) return '';
  const s = doc.sections.filter((x) => x.type === 'callout' && x.coachNote)[0];
  return s ? String(s.body || '') : '';
}

/** Write the coach's note into a document, creating the section if needed. */
function setDocCoachNote(doc, note) {
  if (!doc || !Array.isArray(doc.sections)) return doc;
  const text = str(note, LIMITS.body);
  const existing = doc.sections.filter((x) => x.type === 'callout' && x.coachNote)[0];
  if (existing) {
    existing.body = text;
    existing.show = !!text;
    return doc;
  }
  const discIdx = doc.sections.map((s) => s.type).lastIndexOf('disclaimer');
  const section = {
    id: newId('note'),
    type: 'callout',
    show: !!text,
    pageBreak: false,
    tone: 'gold',
    coachNote: true,
    title: 'A note from your coach',
    subtitle: '',
    body: text,
    items: []
  };
  if (discIdx >= 0) doc.sections.splice(discIdx, 0, section);
  else doc.sections.push(section);
  return doc;
}

module.exports = {
  DOC_VERSION,
  MIN_DISCLAIMER_CHARS,
  LIMITS,
  SECTION_TYPES,
  buildGradedDoc,
  sanitizeGradedDoc,
  docHasVisibleContent,
  docCoachNote,
  setDocCoachNote,
  formatDate
};
