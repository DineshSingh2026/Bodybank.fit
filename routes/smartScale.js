'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { triggerSmartScaleExtraction } = require('../services/smartScaleExtractionService');
const { notifyAsync } = require('../utils/notify');
const { notifyAgent } = require('../utils/agentWebhook');

// Same shape as routes/blood.js: keep decoded files well under the shared 40MB
// JSON body limit, and cap how many files ride in one upload call.
const MAX_B64_CHARS_PER_FILE = 20 * 1024 * 1024;
const MAX_FILE_BYTES = Math.floor(MAX_B64_CHARS_PER_FILE * 3 / 4);
const MAX_FILES_PER_UPLOAD = 4;

// Roles allowed to view/manage every client's smart scale uploads. Operators get
// the same read parity they already have on blood reports.
const STAFF_ROLES = ['admin', 'superadmin', 'operator'];
const isStaff = (req) => STAFF_ROLES.includes(req && req.user && req.user.role);

const MIME_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic'
};

function extForMime(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] || 'bin';
}

function uploadsRoot() {
  return path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
}

// Every path this resolves is server-generated at upload time (see below), so this
// containment check is defence in depth against a tampered row ever escaping the
// uploads directory — same guard routes/blood.js applies to blood report files.
function resolveStoredPath(stored) {
  if (!stored) return null;
  const root = uploadsRoot();
  const direct = path.resolve(String(stored));
  const rel = path.relative(root, direct);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return direct;
  return path.join(root, 'smart-scale', path.basename(String(stored)));
}

function parseJsonCol(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (_) { return null; }
}

function mapRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name || '',
    userEmail: r.user_email || '',
    checkinId: r.checkin_id || null,
    originalFilename: r.original_filename || '',
    mimeType: r.mime_type || '',
    fileSize: r.file_size != null ? Number(r.file_size) : 0,
    createdAt: r.created_at,
    profile_picture: String(r.client_profile_picture || '').trim(),
    // AI extraction of the report's own printed metrics — see smartScaleExtractionService.
    extractionStatus: r.extraction_status || 'pending',
    extractionError: r.extraction_error || '',
    extractedData: parseJsonCol(r.extracted_data),
    deviceBrand: r.device_brand || '',
    reportDate: r.report_date || null
  };
}

function downloadName(row) {
  const ext = extForMime(row.mime_type) || (path.extname(row.original_filename || '').replace('.', '')) || 'bin';
  const who = String(row.user_name || 'client').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'client';
  const when = String(row.created_at || '').slice(0, 10) || 'undated';
  return `SmartScale_${who}_${when}.${ext}`;
}

function createSmartScaleRouter(deps) {
  const { run, queryOne, queryAll, verifyToken, rateLimiter, sendPushToAdmins } = deps;
  const db = { run, queryOne, queryAll };
  const notifyStaffPush = typeof sendPushToAdmins === 'function' ? sendPushToAdmins : async () => {};

  const router = require('express').Router();
  router.use(verifyToken);

  const staffOnly = (req, res, next) => {
    if (!isStaff(req)) return res.status(403).json({ success: false, error: 'Forbidden' });
    next();
  };

  // Member uploads one or more smart scale files (decades scan PDF, screenshot, etc).
  // Entirely optional and independent of the Sunday check-in submission — a failed
  // or skipped upload here must never block that form.
  router.post('/upload', rateLimiter(10, 120000), async (req, res) => {
    try {
      const userId = req.user.id;
      const { files, checkinId } = req.body || {};
      const list = Array.isArray(files) ? files : [];
      if (!list.length) return res.status(400).json({ success: false, error: 'No file provided' });
      if (list.length > MAX_FILES_PER_UPLOAD) {
        return res.status(400).json({ success: false, error: `Upload up to ${MAX_FILES_PER_UPLOAD} files at a time.` });
      }

      const u = await queryOne(`SELECT id, first_name, last_name, email FROM users WHERE id = ?`, [userId]);
      const displayName = [u && u.first_name, u && u.last_name].filter(Boolean).join(' ').trim() || (u && u.email) || '';

      const fileDir = path.join(uploadsRoot(), 'smart-scale', String(userId));
      fs.mkdirSync(fileDir, { recursive: true });

      const saved = [];
      for (const f of list) {
        const b64 = f && f.base64 ? String(f.base64).replace(/\s/g, '') : '';
        if (!b64) continue;
        if (b64.length > MAX_B64_CHARS_PER_FILE) {
          return res.status(400).json({ success: false, error: 'One of the files is too large (max ~15MB each).' });
        }
        const mime = String((f && f.mimeType) || 'application/octet-stream').slice(0, 80).toLowerCase();
        if (!MIME_EXT[mime]) {
          return res.status(400).json({ success: false, error: 'Only PDF or image files (jpg/png/webp/heic) are accepted.' });
        }
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) continue;
        if (buf.length > MAX_FILE_BYTES) {
          return res.status(400).json({ success: false, error: 'One of the files is too large (max ~15MB each).' });
        }
        const ext = extForMime(mime);
        const fileName = `scale_${userId}_${Date.now()}_${saved.length}.${ext}`;
        const filePath = path.join(fileDir, fileName);
        fs.writeFileSync(filePath, buf);

        const id = uuidv4();
        await run(
          `INSERT INTO smart_scale_uploads (
            id, user_id, checkin_id, file_path, original_filename, mime_type, file_size, user_name, user_email
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            userId,
            checkinId != null ? String(checkinId).slice(0, 64) : null,
            filePath,
            String((f && f.filename) || '').slice(0, 200),
            mime,
            buf.length,
            displayName,
            (u && u.email) ? String(u.email) : ''
          ]
        );
        saved.push(id);
        // Fire-and-forget: the member's upload response never waits on Claude, and
        // a slow/failed extraction just leaves the row retryable from admin.
        triggerSmartScaleExtraction(db, id, b64, mime, userId).catch((err) =>
          console.error('[smart-scale] extraction trigger failed:', err && err.message)
        );
      }

      if (!saved.length) return res.status(400).json({ success: false, error: 'No valid file provided' });

      // Staff-facing activity: this had no notification presence at all before —
      // matches the WhatsApp/webhook/push pattern blood report uploads already use.
      const notifyPayload = { name: displayName || 'A client', email: (u && u.email) || '—' };
      notifyAsync('SMART_SCALE_UPLOADED', notifyPayload);
      notifyAgent('SMART_SCALE_UPLOADED', notifyPayload);
      notifyStaffPush(JSON.stringify({
        title: '⚖️ Smart scale report uploaded',
        body: (displayName || 'A client') + ' uploaded ' + saved.length + ' smart scale file' + (saved.length === 1 ? '' : 's') + '.',
        id: 'scale-' + saved[0]
      })).catch(() => {});

      res.json({ success: true, uploaded: saved.length, ids: saved });
    } catch (e) {
      console.error('[smart-scale upload]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Upload failed' });
    }
  });

  // Member's own uploads (for the check-in page to show "already uploaded" state).
  router.get('/my-uploads', async (req, res) => {
    try {
      const rows = await queryAll(
        `SELECT * FROM smart_scale_uploads WHERE user_id = ? ORDER BY created_at DESC`,
        [req.user.id]
      );
      res.json({ uploads: (rows || []).map(mapRow) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Owner or staff downloads the original file.
  router.get('/file/:id', async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM smart_scale_uploads WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.user_id !== req.user.id && !isStaff(req)) return res.status(403).json({ error: 'Forbidden' });
      const resolved = row.file_path ? resolveStoredPath(String(row.file_path).trim()) : null;
      if (!resolved || !fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'File is no longer on the server.' });
      }
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.download(resolved, downloadName(row));
    } catch (e) {
      console.error('[smart-scale file]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Owner or staff deletes an upload.
  router.delete('/:id', async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM smart_scale_uploads WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Not found' });
      if (row.user_id !== req.user.id && !isStaff(req)) return res.status(403).json({ success: false, error: 'Forbidden' });
      try {
        const resolved = row.file_path ? resolveStoredPath(String(row.file_path).trim()) : null;
        if (resolved && fs.existsSync(resolved)) fs.unlinkSync(resolved);
      } catch (_) {}
      await run(`DELETE FROM smart_scale_uploads WHERE id = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (e) {
      console.error('[smart-scale delete]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Delete failed' });
    }
  });

  // Staff: every client's smart scale uploads, newest first.
  router.get('/admin/all', staffOnly, async (req, res) => {
    try {
      const rows = await queryAll(
        `SELECT s.*, u.profile_picture AS client_profile_picture
         FROM smart_scale_uploads s
         LEFT JOIN users u ON u.id = s.user_id
         ORDER BY s.created_at DESC`
      );
      res.json({ uploads: (rows || []).map(mapRow) });
    } catch (e) {
      console.error('[smart-scale admin all]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Staff: re-run extraction (e.g. after a transient API failure, or the model
  // failed to recognise the file the first time). Re-reads the file from disk —
  // nothing is re-uploaded.
  router.post('/admin/retry/:id', staffOnly, rateLimiter(20, 120000), async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM smart_scale_uploads WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Not found' });
      const resolved = row.file_path ? resolveStoredPath(String(row.file_path).trim()) : null;
      if (!resolved || !fs.existsSync(resolved)) {
        return res.status(400).json({ success: false, error: 'Original file is no longer on the server.' });
      }
      const buf = fs.readFileSync(resolved);
      if (!buf.length) return res.status(400).json({ success: false, error: 'File is empty.' });
      if (buf.length > MAX_FILE_BYTES) return res.status(400).json({ success: false, error: 'File is too large to reprocess.' });
      const b64 = buf.toString('base64');
      triggerSmartScaleExtraction(db, row.id, b64, row.mime_type, row.user_id).catch((err) =>
        console.error('[smart-scale] retry trigger failed:', err && err.message)
      );
      res.json({ success: true, message: 'Extraction restarted. Refresh in a moment.' });
    } catch (e) {
      console.error('[smart-scale admin retry]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Retry failed' });
    }
  });

  return router;
}

module.exports = { createSmartScaleRouter };
