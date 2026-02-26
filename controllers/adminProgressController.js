const db = require('../config/db');
const progressService = require('../services/progressService');

async function getUsers(req, res) {
  try {
    const rows = await db.queryAll(
      "SELECT id, first_name, last_name, email FROM users WHERE role = 'user' AND (approval_status IS NULL OR approval_status = 'approved') ORDER BY first_name, last_name"
    );
    const users = rows.map(r => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email,
      email: r.email
    }));
    res.json(users);
  } catch (e) {
    console.error('[admin progress] getUsers:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function getUserProgress(req, res) {
  try {
    const userId = req.params.userId;
    const data = await progressService.getAdminUserProgress(userId);
    res.json(data);
  } catch (e) {
    console.error('[admin progress] getUserProgress:', e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { getUsers, getUserProgress };
