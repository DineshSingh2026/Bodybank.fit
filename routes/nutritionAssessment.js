'use strict';

/**
 * FitChef Nutrition Assessment — HTTP layer.
 *
 * Mounted from server.js as:
 *   app.use('/api/nutrition-assessment', createNutritionAssessmentRouter({ ... }))
 *
 * Three ways in, and the route treats them differently only in how much it can
 * prefill:
 *   1. a signed-in BodyBank member  — Bearer token, everything we know is filled
 *   2. a personal invite link       — ?t=<signed token> minted by an admin, no login
 *   3. the plain shareable link     — cold, rate-limited, nothing prefilled
 *
 * Answers are stored as JSONB keyed by step. Part-2 took the other road — one
 * column per question — and needed twenty ALTER TABLE patches to get to twenty
 * fields; this form has over a hundred, so the shape has to be the payload.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const schema = require('../services/nutritionAssessmentSchema');
const prefillService = require('../services/nutritionAssessmentPrefill');
const review = require('../services/nutritionAssessmentReview');
const metrics = require('../public/js/nutrition-assessment-metrics');

const INVITE_PURPOSE = 'nutrition-assessment';
const INVITE_EXPIRY = process.env.NUTRITION_ASSESSMENT_LINK_EXPIRY || '60d';

function createNutritionAssessmentRouter(deps = {}) {
  const {
    run, queryOne, queryAll,
    verifyToken, requireAdminOrSuperadmin, requireOperator,
    rateLimiter, jwtSecret, uploadsDir, multer,
    onSubmit // optional side-effects hook (push + email), injected by server.js
  } = deps;

  const db = { run, queryOne, queryAll };
  const router = express.Router();
  const limit = (max, windowMs) =>
    (typeof rateLimiter === 'function' ? rateLimiter(max, windowMs) : (req, res, next) => next());

  const FILES_DIR = path.join(uploadsDir || path.join(__dirname, '..', 'uploads'), 'nutrition-assessment');

  const upload = multer
    ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 3 } })
    : null;
  const uploadAny = upload ? upload.array('files', 3) : (req, _res, next) => next();

  // ───────────────────────────────────────────── identity

  function signInvite(payload) {
    return jwt.sign(Object.assign({ purpose: INVITE_PURPOSE }, payload), jwtSecret, { expiresIn: INVITE_EXPIRY });
  }

  function readInvite(token) {
    if (!token) return null;
    try {
      const d = jwt.verify(String(token), jwtSecret);
      return d && d.purpose === INVITE_PURPOSE ? d : null;
    } catch (e) { return null; }
  }

  /**
   * Who is filling this in? Never throws — a bad token degrades to a cold
   * visitor rather than a 401, because the form still works without prefill.
   */
  function actorOf(req) {
    const header = req.headers.authorization;
    const bearer = header && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (bearer) {
      try {
        const d = jwt.verify(bearer, jwtSecret);
        if (d && d.id) return { userId: String(d.id), email: d.email || '', role: d.role || 'user', mode: 'member' };
      } catch (e) { /* fall through to the invite token */ }
    }
    const inv = readInvite(req.query.t || (req.body && req.body.t));
    if (inv) {
      return {
        userId: inv.userId ? String(inv.userId) : '',
        email: inv.email || '', name: inv.name || '', mobile: inv.mobile || '',
        role: 'user', mode: 'invite'
      };
    }
    return { userId: '', email: '', name: '', mobile: '', role: '', mode: 'cold' };
  }

  function originFor(req) {
    const configured = String(process.env.PUBLIC_URL || process.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
    return configured || `${req.protocol}://${req.get('host')}`;
  }

  const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  };

  /** Merge the per-step answer objects into the flat map the rules work on. */
  function flatten(answers) {
    const flat = {};
    Object.keys(answers || {}).forEach((step) => {
      const bag = answers[step];
      if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
        Object.keys(bag).forEach((k) => { flat[k] = bag[k]; });
      }
    });
    return flat;
  }

  /** Drop answers to fields whose `when` clause is not satisfied — a member who
   *  switches from Non-vegetarian to Vegan must not keep their nonveg_days. */
  function pruneHidden(answers) {
    const flat = flatten(answers);
    const out = {};
    schema.STEPS.forEach((step) => {
      const bag = (answers && answers[step.key]) || {};
      const kept = {};
      step.fields.forEach((f) => {
        if (!(f.key in bag)) return;
        if (f.when && !schema.matches(f.when, flat)) return;
        kept[f.key] = bag[f.key];
      });
      if (Object.keys(kept).length) out[step.key] = kept;
    });
    return out;
  }

  /**
   * The row this person is currently filling, if any.
   *
   * `emailHint` is the email typed into Step 1 by someone who arrived on the
   * plain shareable link. Without it, autosave would open a partial row and the
   * submit twenty minutes later would open a SECOND one, leaving the admin list
   * showing the same person twice — once abandoned, once complete.
   */
  async function findDraft(actor, emailHint) {
    if (actor.userId) {
      return db.queryOne(
        `SELECT * FROM nutrition_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [actor.userId]
      );
    }
    const email = actor.email || String(emailHint || '').trim();
    if (email) {
      return db.queryOne(
        `SELECT * FROM nutrition_assessments WHERE user_id IS NULL AND LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1`,
        [email]
      );
    }
    return null;
  }

  function publicRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      last_step: Number(row.last_step) || 1,
      answers: parseJson(row.answers) || {},
      derived: parseJson(row.derived) || {},
      submitted_at: row.submitted_at || null,
      updated_at: row.updated_at || null
    };
  }

  // ───────────────────────────────────────────── public: schema + session

  router.get('/schema', limit(120, 60000), (req, res) => {
    res.json({ steps: schema.STEPS });
  });

  /**
   * Everything the form needs to boot in one round trip: who we think you are,
   * what we already know about you, and the draft you left behind.
   */
  router.get('/session', limit(60, 60000), async (req, res) => {
    try {
      const actor = actorOf(req);
      let prefill = { known: {}, isMember: false, sources: [] };
      try {
        prefill = await prefillService.buildPrefill(db, {
          userId: actor.userId, email: actor.email, name: actor.name, mobile: actor.mobile
        });
      } catch (e) { console.error('[nutrition-assessment] prefill failed:', e.message); }

      const draft = await findDraft(actor);
      res.json({
        mode: actor.mode,
        is_member: !!actor.userId,
        prefill: prefill.known,
        prefill_sources: prefill.sources,
        draft: publicRow(draft),
        already_submitted: !!(draft && draft.status === 'complete')
      });
    } catch (e) {
      console.error('[nutrition-assessment] session:', e.message);
      res.status(500).json({ error: 'Could not start the assessment' });
    }
  });

  /**
   * Autosave. Upserts one partial row per person and is deliberately forgiving —
   * a failed autosave must never interrupt typing, so validation waits for submit.
   */
  router.put('/draft', limit(240, 60000), async (req, res) => {
    try {
      const actor = actorOf(req);
      const body = req.body || {};
      const answers = pruneHidden(body.answers || {});
      const flat = flatten(answers);
      const lastStep = Math.max(1, Math.min(schema.STEPS.length, parseInt(body.last_step, 10) || 1));

      const identity = {
        full_name: String(flat.full_name || actor.name || '').slice(0, 200),
        email: String(flat.email || actor.email || '').slice(0, 200),
        mobile: String(flat.mobile || actor.mobile || '').slice(0, 40),
        city: String(flat.city || '').slice(0, 120)
      };
      if (!actor.userId && !identity.email) return res.json({ saved: false, reason: 'no-identity' });

      const existing = await findDraft(actor, identity.email);
      if (existing && existing.status === 'complete') return res.json({ saved: false, reason: 'already-submitted', id: existing.id });

      const derived = metrics.derive(flat);
      if (existing) {
        await run(
          `UPDATE nutrition_assessments
             SET answers = ?::jsonb, derived = ?::jsonb, last_step = ?, full_name = ?, email = ?, mobile = ?, city = ?,
                 goal_primary = ?, diet_type = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [JSON.stringify(answers), JSON.stringify(derived), lastStep, identity.full_name, identity.email,
            identity.mobile, identity.city, String(flat.goal_primary || ''), String(flat.diet_type || ''), existing.id]
        );
        return res.json({ saved: true, id: existing.id });
      }

      const id = crypto.randomUUID();
      await run(
        `INSERT INTO nutrition_assessments
           (id, user_id, status, last_step, full_name, email, mobile, city, goal_primary, diet_type, answers, derived, ref_source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?)`,
        [id, actor.userId || null, 'partial', lastStep, identity.full_name, identity.email, identity.mobile,
          identity.city, String(flat.goal_primary || ''), String(flat.diet_type || ''),
          JSON.stringify(answers), JSON.stringify(derived), String(req.query.ref || body.ref || actor.mode)]
      );
      res.json({ saved: true, id });
    } catch (e) {
      console.error('[nutrition-assessment] draft:', e.message);
      res.status(500).json({ saved: false, error: 'Could not save' });
    }
  });

  /** Optional file attachments (progress photos, a lab PDF). */
  router.post('/upload', limit(20, 60000), uploadAny, async (req, res) => {
    try {
      if (!upload) return res.status(503).json({ error: 'Uploads are not available on this server' });
      const actor = actorOf(req);
      // The draft id is a v4 UUID the client received from PUT /draft — infeasible
      // to guess, so it is what an anonymous visitor is allowed to attach files to.
      // Email is deliberately NOT a lookup key here: photos and lab reports are the
      // most sensitive thing this form holds.
      const byId = String(req.query.id || req.body.id || '');
      let draft = null;
      if (actor.userId || actor.email) draft = await findDraft(actor);
      if (!draft && /^[0-9a-f-]{36}$/i.test(byId)) {
        draft = await db.queryOne(
          `SELECT * FROM nutrition_assessments WHERE id = ? AND user_id IS NULL AND status = 'partial'`, [byId]
        );
      }
      if (!draft) return res.status(400).json({ error: 'Start the form before uploading' });
      const slot = String(req.query.slot || req.body.slot || 'file').replace(/[^a-z_]/gi, '') || 'file';

      const dir = path.join(FILES_DIR, String(draft.id));
      fs.mkdirSync(dir, { recursive: true });

      const saved = (req.files || []).map((f, i) => {
        const ext = path.extname(f.originalname || '').slice(0, 10).replace(/[^.a-z0-9]/gi, '') || '.bin';
        const name = `${slot}-${Date.now()}-${i}${ext}`;
        fs.writeFileSync(path.join(dir, name), f.buffer);
        return { name, original: String(f.originalname || '').slice(0, 200), size: f.size, slot };
      });
      if (!saved.length) return res.status(400).json({ error: 'No file received' });
      res.json({ files: saved });
    } catch (e) {
      console.error('[nutrition-assessment] upload:', e.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  /** Final submit — validates required fields, runs the §11 rules, locks the row. */
  router.post('/submit', limit(8, 60000), async (req, res) => {
    try {
      const actor = actorOf(req);
      const body = req.body || {};
      const answers = pruneHidden(body.answers || {});
      const flat = flatten(answers);

      const missing = [];
      schema.STEPS.forEach((step) => {
        step.fields.forEach((f) => {
          if (!f.required) return;
          if (f.when && !schema.matches(f.when, flat)) return;
          const v = flat[f.key];
          const empty = v == null || v === '' || v === false ||
            (Array.isArray(v) && !v.length) ||
            (f.type === 'grid' && (!v || typeof v !== 'object' || !Object.keys(v).length)) ||
            (f.type === 'recall' && (!v || typeof v !== 'object' || !Object.values(v).some((x) => String(x || '').trim())));
          if (empty) missing.push({ step: step.key, key: f.key, label: f.label });
        });
      });
      if (missing.length) return res.status(400).json({ error: 'Some required answers are missing', missing });

      if (!flat.consent_health_data) return res.status(400).json({ error: 'Consent is required to process health information' });

      const flags = review.computeFlags(flat);
      if (review.isRefused(flags)) {
        return res.status(403).json({
          error: 'We cannot accept a nutrition assessment for anyone under 18. Please ask a parent or guardian to contact us directly.',
          refused: true
        });
      }

      const derived = metrics.derive(flat);
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);
      const identity = {
        full_name: String(flat.full_name || '').slice(0, 200),
        email: String(flat.email || '').slice(0, 200),
        mobile: String(flat.mobile || '').slice(0, 40),
        city: String(flat.city || '').slice(0, 120)
      };

      const existing = await findDraft(actor, identity.email);
      if (existing && existing.status === 'complete') {
        return res.status(409).json({ error: 'This assessment has already been submitted', id: existing.id });
      }

      const id = existing ? existing.id : crypto.randomUUID();
      const cols = [
        JSON.stringify(answers), JSON.stringify(derived), JSON.stringify(flags),
        review.reviewStatus(flags), identity.full_name, identity.email, identity.mobile, identity.city,
        String(flat.goal_primary || ''), String(flat.diet_type || ''),
        !!flat.consent_health_data, !!flat.consent_marketing, ip
      ];

      if (existing) {
        await run(
          `UPDATE nutrition_assessments
             SET answers = ?::jsonb, derived = ?::jsonb, flags = ?::jsonb, review_status = ?,
                 full_name = ?, email = ?, mobile = ?, city = ?, goal_primary = ?, diet_type = ?,
                 consent_health = ?, consent_marketing = ?, consent_ip = ?,
                 status = 'complete', last_step = ${schema.STEPS.length},
                 submitted_at = CURRENT_TIMESTAMP, consent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`, cols.concat([id])
        );
      } else {
        await run(
          `INSERT INTO nutrition_assessments
             (answers, derived, flags, review_status, full_name, email, mobile, city, goal_primary, diet_type,
              consent_health, consent_marketing, consent_ip,
              id, user_id, status, last_step, ref_source, submitted_at, consent_at)
           VALUES (?::jsonb,?::jsonb,?::jsonb,?,?,?,?,?,?,?,?,?,?,?,?,'complete',${schema.STEPS.length},?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          cols.concat([id, actor.userId || null, String(body.ref || actor.mode)])
        );
      }

      if (typeof onSubmit === 'function') {
        Promise.resolve(onSubmit({ id, identity, flags, derived, userId: actor.userId || '' })).catch(() => {});
      }

      res.json({
        id,
        message: 'Assessment submitted',
        derived,
        flagged: flags.some((f) => f.block),
        review_note: flags.some((f) => f.block)
          ? 'Because of what you shared about your health, a member of our team will review this personally before anything is generated. That is deliberate, and it is the safe way round.'
          : ''
      });
    } catch (e) {
      console.error('[nutrition-assessment] submit:', e.message);
      res.status(500).json({ error: 'Submission failed' });
    }
  });

  /** The member dashboard tile asks this: have I done it, and where did I stop? */
  router.get('/mine', verifyToken, limit(120, 60000), async (req, res) => {
    try {
      const row = await db.queryOne(
        `SELECT id, status, last_step, submitted_at, updated_at FROM nutrition_assessments
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [String(req.user.id)]
      );
      if (!row) return res.json({ status: 'not_started', total_steps: schema.STEPS.length });
      res.json({
        status: row.status === 'complete' ? 'complete' : 'in_progress',
        id: row.id,
        last_step: Number(row.last_step) || 1,
        step_title: (schema.STEPS[(Number(row.last_step) || 1) - 1] || {}).title || '',
        total_steps: schema.STEPS.length,
        submitted_at: row.submitted_at,
        updated_at: row.updated_at
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not load status' });
    }
  });

  // ───────────────────────────────────────────── staff

  /** Mint a prefilled personal link for one member or lead. */
  router.post('/invite-link', verifyToken, requireAdminOrSuperadmin, limit(60, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      const payload = {};
      if (b.user_id) {
        const u = await db.queryOne(`SELECT id, first_name, last_name, email, phone FROM users WHERE id = ?`, [String(b.user_id)]);
        if (!u) return res.status(404).json({ error: 'Member not found' });
        payload.userId = String(u.id);
        payload.name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
        payload.email = u.email || '';
        payload.mobile = u.phone || '';
      } else {
        if (!b.email) return res.status(400).json({ error: 'An email (or a member) is required' });
        payload.name = String(b.name || '').slice(0, 200);
        payload.email = String(b.email).slice(0, 200);
        payload.mobile = String(b.mobile || '').slice(0, 40);
      }
      const token = signInvite(payload);
      res.json({
        url: `${originFor(req)}/nutrition-assessment.html?t=${encodeURIComponent(token)}`,
        name: payload.name, email: payload.email, expires_in: INVITE_EXPIRY
      });
    } catch (e) {
      console.error('[nutrition-assessment] invite-link:', e.message);
      res.status(500).json({ error: 'Could not create the link' });
    }
  });

  /** Members an admin can send a personal link to, for the picker in the tab. */
  router.get('/candidates', verifyToken, requireOperator, limit(60, 60000), async (req, res) => {
    try {
      const q = `%${String(req.query.search || '').trim().toLowerCase()}%`;
      const rows = await queryAll(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
                (SELECT status FROM nutrition_assessments na WHERE na.user_id = u.id ORDER BY na.created_at DESC LIMIT 1) AS assessment_status
         FROM users u
         WHERE u.role = 'user' AND COALESCE(u.suspended, FALSE) = FALSE
           AND (LOWER(u.email) LIKE ? OR LOWER(u.first_name || ' ' || u.last_name) LIKE ?)
         ORDER BY u.first_name, u.last_name LIMIT 200`, [q, q]
      );
      res.json({
        members: rows.map((r) => ({
          id: r.id,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email,
          email: r.email, mobile: r.phone || '',
          status: r.assessment_status === 'complete' ? 'submitted' : (r.assessment_status ? 'in progress' : 'not started')
        }))
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not load members' });
    }
  });

  function listFilters(req) {
    const where = [];
    const params = [];
    const status = String(req.query.status || '').trim();
    if (status === 'complete' || status === 'partial') { where.push('na.status = ?'); params.push(status); }
    if (String(req.query.flagged || '') === '1') where.push("na.review_status = 'blocked'");
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('na.created_at >= ?'); params.push(from + ' 00:00:00'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('na.created_at <= ?'); params.push(to + ' 23:59:59'); }
    const search = String(req.query.search || '').trim().toLowerCase();
    if (search) {
      where.push('(LOWER(na.full_name) LIKE ? OR LOWER(na.email) LIKE ? OR na.mobile LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const SORTS = {
      latest: 'COALESCE(na.submitted_at, na.updated_at, na.created_at) DESC',
      oldest: 'COALESCE(na.submitted_at, na.updated_at, na.created_at) ASC',
      name: 'LOWER(na.full_name) ASC',
      flagged: "(na.review_status = 'blocked') DESC, na.created_at DESC"
    };
    const order = SORTS[String(req.query.sort || 'latest')] || SORTS.latest;
    return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params, order };
  }

  /** Staff list. Operators read it; only admins can delete or resolve. */
  router.get('/list', verifyToken, requireOperator, limit(120, 60000), async (req, res) => {
    try {
      const f = listFilters(req);
      const rows = await queryAll(
        `SELECT na.id, na.user_id, na.status, na.last_step, na.full_name, na.email, na.mobile, na.city,
                na.goal_primary, na.diet_type, na.review_status, na.flags, na.derived,
                na.created_at, na.updated_at, na.submitted_at,
                (u.id IS NOT NULL) AS is_member
         FROM nutrition_assessments na
         LEFT JOIN users u ON u.id = na.user_id
         ${f.clause} ORDER BY ${f.order} LIMIT 500`, f.params
      );
      const mapped = rows.map((r) => {
        const flags = parseJson(r.flags) || [];
        const derived = parseJson(r.derived) || {};
        return {
          id: r.id, user_id: r.user_id || null, is_member: !!r.is_member,
          status: r.status, last_step: Number(r.last_step) || 1, total_steps: schema.STEPS.length,
          step_title: (schema.STEPS[(Number(r.last_step) || 1) - 1] || {}).title || '',
          name: r.full_name || r.email || '—', email: r.email || '', mobile: r.mobile || '', city: r.city || '',
          goal: r.goal_primary || '', diet: r.diet_type || '',
          flagged: r.review_status === 'blocked',
          flag_labels: flags.map((x) => x.label),
          bmr: derived.bmr || null, tdee: derived.tdee || null, whtr: derived.whtr || null,
          created_at: r.created_at, updated_at: r.updated_at, submitted_at: r.submitted_at
        };
      });
      const complete = mapped.filter((r) => r.status === 'complete').length;
      res.json({
        rows: mapped,
        summary: {
          total: mapped.length,
          complete,
          partial: mapped.length - complete,
          flagged: mapped.filter((r) => r.flagged).length,
          completion_pct: mapped.length ? Math.round((complete / mapped.length) * 1000) / 10 : 0
        },
        share_url: `${originFor(req)}/nutrition-assessment.html`
      });
    } catch (e) {
      console.error('[nutrition-assessment] list:', e.message);
      res.status(500).json({ error: 'Could not load submissions' });
    }
  });

  /** CSV of exactly what the current filters show, one column per schema field. */
  router.get('/export.csv', verifyToken, requireAdminOrSuperadmin, limit(20, 60000), async (req, res) => {
    try {
      const f = listFilters(req);
      const rows = await queryAll(
        `SELECT na.* FROM nutrition_assessments na ${f.clause} ORDER BY ${f.order} LIMIT 5000`, f.params
      );
      const fields = schema.allFields().filter((x) => ['files', 'consent'].indexOf(x.type) === -1);
      const header = ['Submitted at', 'Status', 'Name', 'Email', 'Mobile', 'City', 'Member', 'Flags',
        'BMR', 'TDEE', 'WHtR', 'Protein target'].concat(fields.map((x) => x.label));

      const cell = (v) => {
        if (v == null) return '';
        if (Array.isArray(v)) return v.join('; ');
        if (typeof v === 'object') {
          return Object.keys(v).map((k) => `${k}: ${Array.isArray(v[k]) ? v[k].join('/') : v[k]}`).join(' | ');
        }
        return String(v);
      };
      const esc = (v) => `"${String(cell(v)).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

      const lines = [header.map(esc).join(',')];
      rows.forEach((r) => {
        const flat = flatten(parseJson(r.answers) || {});
        const derived = parseJson(r.derived) || {};
        const flags = parseJson(r.flags) || [];
        const protein = derived.protein_target_g ? `${derived.protein_target_g.low}–${derived.protein_target_g.high}g` : '';
        lines.push([
          r.submitted_at || r.updated_at || r.created_at, r.status, r.full_name, r.email, r.mobile, r.city,
          r.user_id ? 'Yes' : 'No', flags.map((x) => x.label).join('; '),
          derived.bmr || '', derived.tdee || '', derived.whtr || '', protein
        ].concat(fields.map((x) => flat[x.key])).map(esc).join(','));
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="fitchef-nutrition-assessments-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('﻿' + lines.join('\r\n'));
    } catch (e) {
      console.error('[nutrition-assessment] export:', e.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  /** One submission, rendered as ordered sections so the reviewer reads it in form order. */
  router.get('/:id', verifyToken, requireOperator, limit(120, 60000), async (req, res) => {
    try {
      const r = await db.queryOne(`SELECT * FROM nutrition_assessments WHERE id = ?`, [String(req.params.id)]);
      if (!r) return res.status(404).json({ error: 'Not found' });
      const answers = parseJson(r.answers) || {};
      const flat = flatten(answers);

      const sections = schema.STEPS.map((step) => ({
        key: step.key,
        title: step.title,
        rows: step.fields
          .filter((fd) => (!fd.when || schema.matches(fd.when, flat)) && flat[fd.key] != null && flat[fd.key] !== '' &&
            !(Array.isArray(flat[fd.key]) && !flat[fd.key].length))
          .map((fd) => ({ key: fd.key, label: fd.label, type: fd.type, value: flat[fd.key] }))
      })).filter((s) => s.rows.length);

      let files = [];
      try {
        const dir = path.join(FILES_DIR, String(r.id));
        if (fs.existsSync(dir)) files = fs.readdirSync(dir).map((n) => ({ name: n, url: `/api/nutrition-assessment/${r.id}/file/${encodeURIComponent(n)}` }));
      } catch (e) { /* attachments are a bonus, never a failure */ }

      res.json({
        id: r.id, user_id: r.user_id, status: r.status, last_step: Number(r.last_step) || 1,
        name: r.full_name, email: r.email, mobile: r.mobile, city: r.city,
        created_at: r.created_at, updated_at: r.updated_at, submitted_at: r.submitted_at,
        consent: { health: !!r.consent_health, marketing: !!r.consent_marketing, at: r.consent_at, ip: r.consent_ip },
        derived: parseJson(r.derived) || {},
        flags: parseJson(r.flags) || [],
        review_status: r.review_status || '',
        sections, files
      });
    } catch (e) {
      console.error('[nutrition-assessment] detail:', e.message);
      res.status(500).json({ error: 'Could not load the submission' });
    }
  });

  /** Attachments never sit under the public /uploads mount — they come through here. */
  router.get('/:id/file/:name', verifyToken, requireOperator, limit(120, 60000), (req, res) => {
    const name = path.basename(String(req.params.name));
    const file = path.join(FILES_DIR, path.basename(String(req.params.id)), name);
    if (!file.startsWith(FILES_DIR) || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(file);
  });

  /** Admin marks a flagged submission as reviewed, with a note. */
  router.post('/:id/review', verifyToken, requireAdminOrSuperadmin, limit(60, 60000), async (req, res) => {
    try {
      const note = String((req.body || {}).note || '').slice(0, 2000);
      await run(
        `UPDATE nutrition_assessments SET review_status = 'reviewed', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [note, String(req.user.email || req.user.id || ''), String(req.params.id)]
      );
      res.json({ message: 'Marked reviewed' });
    } catch (e) {
      res.status(500).json({ error: 'Could not update' });
    }
  });

  router.delete('/:id', verifyToken, requireAdminOrSuperadmin, limit(30, 60000), async (req, res) => {
    try {
      const id = path.basename(String(req.params.id));
      await run(`DELETE FROM nutrition_assessments WHERE id = ?`, [id]);
      try { fs.rmSync(path.join(FILES_DIR, id), { recursive: true, force: true }); } catch (e) { /* ignore */ }
      res.json({ message: 'Deleted' });
    } catch (e) {
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  return router;
}

module.exports = { createNutritionAssessmentRouter };
