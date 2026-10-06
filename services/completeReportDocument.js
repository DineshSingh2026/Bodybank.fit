'use strict';

/**
 * BodyBank — HEALTH MAP 360: THE EDITABLE DOCUMENT.
 *
 * The 360 edition is the Health Map report with a doctor in it. It is built by
 * taking the standard Health Map document EXACTLY as services/gradedReportDocument.js
 * produces it and inserting additional sections around it:
 *
 *   Doctor's summary + sign-off      a named, registered doctor's reading
 *   Reading your results together    cross-marker patterns and calculated indices
 *   What this means for your goal    the results against what the client wants
 *   What you told us                 medicines, conditions and lifestyle vs results
 *   Your nutrition plan              foods, a sample day, four weekly steps
 *   Your retest plan                 what to repeat, when, and what to add
 *   Questions for your doctor call   so the consultation is used well
 *   Consultation summaries           filled in after the two calls
 *
 * Nothing in the standard Health Map is altered: its sections arrive here already
 * built and are passed through untouched, in their original order. The standard
 * report and its document builder are not modified by this file in any way.
 *
 * ─── WHAT A REVIEWER CAN CHANGE ───────────────────────────────────────────────
 * Every added section is ordinary editable content: the doctor or nutritionist can
 * rewrite, hide, reorder or delete any of it before the client sees it. As in the
 * standard report, the measured values themselves stay locked — a calculated index
 * can be hidden or annotated, but its number cannot be retyped.
 *
 * ─── THE SIGN-OFF ─────────────────────────────────────────────────────────────
 * The doctor's name, qualification, registration number and signature print only
 * when the sign-off is ticked. The doctor's details are copied from the consultant
 * record by the server, never typed into the document, and the time and the staff
 * account that ticked it are stamped by the server (services/gradedReportService.js).
 */

const gradedDoc = require('./gradedReportDocument');
const { buildInsights, LEVEL } = require('./complete/insights');
const personal = require('./complete/personal');

const EDITION = 'complete';
const REPORT_TITLE = 'BodyBank Health Map 360 Report';
/** Section types this edition adds to the standard nine. */
const EXTRA_TYPES = ['insights', 'signoff'];
const LIMITS = { rows: 40, text: 4000, short: 600 };
const DEFAULT_STATEMENT = 'I have reviewed this report and the laboratory results it is based on.';

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix || 'x'}-${Date.now().toString(36)}-c${seq.toString(36)}`;
}
function str(v, max) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > (max || LIMITS.short) ? s.slice(0, max || LIMITS.short) : s;
}
function bool(v, dflt) {
  if (v === true) return true;
  if (v === false) return false;
  return !!dflt;
}

const LEVEL_LABEL = { [LEVEL.FLAG]: 'Discuss with your doctor', [LEVEL.WATCH]: 'Worth acting on', [LEVEL.OK]: 'Good to know' };

function listSection(title, subtitle, texts, opts) {
  const o = opts || {};
  return {
    id: newId('ls'), type: 'list', show: true, pageBreak: !!o.pageBreak, style: o.style || 'bulleted',
    title, subtitle: subtitle || '',
    items: texts.map((t) => (typeof t === 'string' ? { text: t } : t))
      .filter((t) => t && t.text)
      .map((t) => ({ id: newId('li'), show: true, text: t.text, requiresProfessional: !!t.requiresProfessional }))
  };
}

function textSection(title, subtitle, body, opts) {
  const o = opts || {};
  return {
    id: newId('tx'), type: 'text', show: o.show !== false, pageBreak: !!o.pageBreak, variant: 'body',
    title, subtitle: subtitle || '', body: body || ''
  };
}

/**
 * Build the default 360 document.
 *
 * @param {object} report HealthReport (services/gradedHealthReport.js)
 * @param {object} [context] what the client told us — see personal.normalizeContext
 * @param {object} [opts] { coachNote, doctor: { name, qualification, regNo } }
 * @returns {object} doc
 */
function buildCompleteDoc(report, context, opts) {
  const o = opts || {};
  const R = report || {};
  const ctx = personal.normalizeContext(Object.assign({
    age: R.client && R.client.age, sex: R.client && R.client.sex, goal: R.client && R.client.goal
  }, context || {}));

  const base = gradedDoc.buildGradedDoc(R, { coachNote: o.coachNote });
  const { indices, patterns } = buildInsights(R, ctx);
  const goal = personal.buildGoalSection(R, ctx);
  const notes = personal.buildContextNotes(R, ctx);
  const plan = personal.buildNutritionPlan(R, ctx, patterns);
  const retest = personal.buildRetestPlan(R, ctx, patterns);
  const questions = personal.buildQuestions(R, ctx, patterns);
  const doctor = o.doctor || {};

  // ── the sections this edition adds ───────────────────────────────────────
  const summary = [
    textSection("Doctor's Summary", 'Your results, read as a whole by the doctor who reviewed this report.',
      personal.buildSummaryDraft(R, ctx, patterns), { pageBreak: true }),
    {
      id: newId('sign'), type: 'signoff', show: true, pageBreak: false, title: '', subtitle: '',
      doctorName: str(doctor.name, 120), qualification: str(doctor.qualification, 200), regNo: str(doctor.regNo, 120),
      statement: DEFAULT_STATEMENT, signed: false, signedAt: '', signedBy: ''
    }
  ];

  const together = [];
  if (patterns.length) {
    together.push({
      id: newId('pat'), type: 'insights', show: true, pageBreak: true, variant: 'patterns',
      title: 'Reading Your Results Together',
      subtitle: 'Some findings only show up when results are read side by side. These are the combinations on your report and what each one points to.',
      rows: patterns.map((p) => ({
        id: newId('pr'), show: true, label: p.title, result: '', range: '',
        status: LEVEL_LABEL[p.level] || LEVEL_LABEL[LEVEL.WATCH], level: p.level,
        basis: (p.evidence || []).join('  ·  '), note: p.meaning, action: p.action
      }))
    });
  }
  if (indices.length) {
    together.push({
      id: newId('idx'), type: 'insights', show: true, pageBreak: !patterns.length, variant: 'indices',
      title: patterns.length ? 'Calculated From Your Results' : 'Reading Your Results Together',
      subtitle: 'Standard medical calculations that combine two or more of your results. Each shows the numbers it was worked out from.',
      rows: indices.map((i) => ({
        id: newId('ir'), show: true, label: i.label, result: i.result, range: i.range,
        status: i.status, level: i.level, basis: i.basis, note: i.note, action: ''
      }))
    });
  }

  const goalSecs = goal ? [listSection(goal.title, goal.subtitle, goal.items, { pageBreak: !together.length })] : [];
  const noteSecs = notes ? [listSection(notes.title, notes.subtitle, notes.items, { pageBreak: true })] : [];

  const planSecs = [
    textSection('Your Nutrition Plan', 'A starting plan from your sports nutritionist, built on the findings in this report.', plan.intro, { pageBreak: true }),
    listSection('Foods to Add', '', plan.add),
    listSection('Foods to Cut Back', '', plan.limit),
    listSection('A Sample Day', 'One way to put it together. Swap any item for a similar one you prefer.', plan.day),
    listSection('Your Four-Week Focus', 'One change at a time. Add the next week\'s step without dropping the earlier ones.', plan.weeks, { style: 'numbered' })
  ];
  if (plan.supplements.length) {
    planSecs.push(listSection('Supplements to Discuss With Your Doctor',
      'Do not start these on your own. Your doctor will confirm which you need, the dose and for how long.', plan.supplements));
  }

  const followSecs = [
    listSection(retest.title, retest.subtitle, retest.items, { pageBreak: true }),
    listSection(questions.title, questions.subtitle, questions.items, { style: 'numbered' })
  ];

  // Written after the calls. Hidden until someone fills them in, so an empty
  // heading can never reach a client.
  const consultSecs = [
    textSection('Doctor Consultation Summary', 'What was discussed and agreed on your call with the doctor.', '', { show: false, pageBreak: true }),
    textSection('Nutrition Consultation Summary', 'What was discussed and agreed on your call with the sports nutritionist.', '', { show: false })
  ];

  // ── weave them around the standard sections, which pass through untouched ──
  const sections = [];
  const of = (type, pred) => base.sections.filter((s) => s.type === type && (!pred || pred(s)));
  const isLead = (s) => s.variant === 'lead';
  const isCrit = (s) => s.tone === 'review' && !s.coachNote;
  const isNote = (s) => !!s.coachNote;

  sections.push(...of('callout', isCrit));
  sections.push(...of('healthmap'));
  sections.push(...of('text', isLead));
  sections.push(...summary);
  sections.push(...of('priorities'));
  sections.push(...together);
  sections.push(...goalSecs);
  sections.push(...of('progress'));
  sections.push(...of('areacards'));
  sections.push(...of('markers'));
  sections.push(...of('list'));
  sections.push(...noteSecs);
  sections.push(...planSecs);
  sections.push(...followSecs);
  sections.push(...of('text', (s) => !isLead(s)));
  sections.push(...consultSecs);
  sections.push(...of('callout', isNote));
  sections.push(...of('disclaimer'));

  const cover = Object.assign({}, base.cover, { title: REPORT_TITLE });
  cover.stats = (base.cover.stats || []).concat([
    { id: newId('cs'), show: true, label: 'Patterns found', value: String(patterns.length) }
  ]);

  return Object.assign({}, base, { edition: EDITION, cover, sections });
}

// ---------------------------------------------------------------------------
// Sanitising a document that came back from a browser
// ---------------------------------------------------------------------------

/** Run one standard section through the standard sanitiser, unchanged. */
function sanitizeBaseSection(raw) {
  // The standard sanitiser works on whole documents and always guarantees a
  // disclaimer, so a throwaway one is supplied and then discarded.
  const filler = { type: 'disclaimer', body: 'x'.repeat(gradedDoc.MIN_DISCLAIMER_CHARS + 10) };
  const out = gradedDoc.sanitizeGradedDoc({ sections: [raw, filler] }).sections;
  return out.length === 2 ? out[0] : null;
}

function sanitizeExtraSection(raw) {
  const s = {
    id: str(raw.id, 80) || newId(raw.type),
    type: raw.type,
    show: bool(raw.show, true),
    pageBreak: bool(raw.pageBreak, false),
    title: str(raw.title, 240),
    subtitle: str(raw.subtitle, 400)
  };
  if (raw.type === 'insights') {
    s.variant = raw.variant === 'patterns' ? 'patterns' : 'indices';
    s.rows = (Array.isArray(raw.rows) ? raw.rows.slice(0, LIMITS.rows) : []).map((r) => {
      const lv = Number(r && r.level);
      return {
        id: str(r && r.id, 80) || newId('r'),
        show: bool(r && r.show, true),
        label: str(r && r.label, 160),
        result: str(r && r.result, 80),
        range: str(r && r.range, 120),
        status: str(r && r.status, 60),
        level: [LEVEL.INFO, LEVEL.OK, LEVEL.WATCH, LEVEL.FLAG].indexOf(lv) >= 0 ? lv : LEVEL.INFO,
        basis: str(r && r.basis, LIMITS.short),
        note: str(r && r.note, LIMITS.text),
        action: str(r && r.action, LIMITS.text)
      };
    });
  } else if (raw.type === 'signoff') {
    s.doctorName = str(raw.doctorName, 120);
    s.qualification = str(raw.qualification, 200);
    s.regNo = str(raw.regNo, 120);
    s.statement = str(raw.statement, LIMITS.short) || DEFAULT_STATEMENT;
    s.signed = bool(raw.signed, false);
    s.signedAt = str(raw.signedAt, 40);
    s.signedBy = str(raw.signedBy, 200);
    // A sign-off block is never hidden while signed and never shown while unsigned:
    // its visibility follows the tick, so the two cannot disagree.
    s.show = true;
  }
  return s;
}

/**
 * Normalise an edited 360 document. Standard sections go through the standard
 * sanitiser one by one; the two added types are handled here. Anything else is
 * dropped: the renderer must never receive a shape it did not expect.
 */
function sanitizeCompleteDoc(input) {
  const doc = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const shell = gradedDoc.sanitizeGradedDoc({
    docVersion: doc.docVersion, engineVersion: doc.engineVersion, rulesetVersion: doc.rulesetVersion,
    modelVersion: doc.modelVersion, cover: doc.cover, sections: []
  });
  const cover = shell.cover;
  if (!cover.title || cover.title === 'BodyBank Health Map Report') cover.title = REPORT_TITLE;

  const sections = [];
  let signoffSeen = false;
  (Array.isArray(doc.sections) ? doc.sections.slice(0, gradedDoc.LIMITS.sections + 30) : []).forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    if (EXTRA_TYPES.indexOf(raw.type) >= 0) {
      if (raw.type === 'signoff') {
        if (signoffSeen) return;          // one sign-off per report
        signoffSeen = true;
      }
      sections.push(sanitizeExtraSection(raw));
      return;
    }
    const s = sanitizeBaseSection(raw);
    if (s) sections.push(s);
  });

  // The sanitiser's own guarantee, kept: no document leaves without a disclaimer.
  if (!sections.some((s) => s.type === 'disclaimer')) {
    sections.push(shell.sections.filter((s) => s.type === 'disclaimer')[0]);
  }

  return {
    docVersion: shell.docVersion,
    engineVersion: shell.engineVersion,
    rulesetVersion: shell.rulesetVersion,
    modelVersion: shell.modelVersion,
    edition: EDITION,
    cover,
    sections
  };
}

/** The sign-off section of a document, or null. */
function signoffOf(doc) {
  if (!doc || !Array.isArray(doc.sections)) return null;
  return doc.sections.filter((s) => s.type === 'signoff')[0] || null;
}

/** Has a doctor signed this document? */
function isSigned(doc) {
  const s = signoffOf(doc);
  return !!(s && s.signed && s.doctorName && s.regNo);
}

module.exports = {
  EDITION, REPORT_TITLE, EXTRA_TYPES, DEFAULT_STATEMENT, LEVEL_LABEL,
  buildCompleteDoc, sanitizeCompleteDoc, signoffOf, isSigned
};
