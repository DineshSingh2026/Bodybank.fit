const progressService = require('../services/progressService');
const db = require('../config/db');
const userEmail = require('../services/userEmailService');

async function postProgress(req, res) {
  try {
    const userId = req.user.id;
    const body = req.body || {};
    const {
      log_date,
      weight, body_fat, calories_intake, protein_intake,
      workout_completed, workout_type, strength_bench, strength_squat, strength_deadlift,
      sleep_hours, water_intake
    } = body;

    await progressService.insertProgress(userId, {
      log_date, weight, body_fat, calories_intake, protein_intake,
      workout_completed, workout_type, strength_bench, strength_squat, strength_deadlift,
      sleep_hours, water_intake
    });

    try {
      const u = await db.queryOne('SELECT email, first_name FROM users WHERE id = ?', [userId]);
      if (u && u.email && userEmail.isConfigured()) {
        const lines = [];
        if (weight != null) lines.push(`Weight: ${weight} kg`);
        if (body_fat != null) lines.push(`Body fat: ${body_fat}%`);
        if (workout_completed) lines.push(`Workout: ${workout_type || 'completed'}`);
        if (sleep_hours != null) lines.push(`Sleep: ${sleep_hours} h`);
        userEmail.emailProgressSaved(u.email, u.first_name, lines);
      }
    } catch (e) { /* non-fatal */ }

    res.status(201).json({ success: true, message: 'Progress saved for this date' });
  } catch (e) {
    console.error('[progress] POST error:', e.message);
    res.status(500).json({ error: 'Failed to save progress' });
  }
}

async function getProgress(req, res) {
  try {
    const userId = req.user.id;
    const data = await progressService.getProgressWithMeta(userId);
    res.json(data);
  } catch (e) {
    console.error('[progress] GET error:', e.message);
    res.status(500).json({ error: 'Failed to load progress' });
  }
}

module.exports = { postProgress, getProgress };
