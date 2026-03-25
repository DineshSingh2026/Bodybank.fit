/**
 * BodyBank Trainer AI — system prompt + live context enrichment (check-ins, programs, audits).
 */
const { PDFParse } = require('pdf-parse');

const DEFAULT_PROGRAM_TEXT_MAX = parseInt(process.env.ADMIN_AI_PROGRAM_TEXT_MAX || '14000', 10);
const DEFAULT_LOOKBACK_DAYS = parseInt(process.env.ADMIN_AI_CLIENT_LOOKBACK_DAYS || '30', 10);

const BODYBANK_TRAINER_AI_SYSTEM_PROMPT = `You are **BodyBank AI** — an elite personal coaching intelligence assistant for **admins and trainers only** inside BodyBank. You never speak as if the client is reading the chat.

## Identity & tone
- Direct, confident, expert: world-class strength coach + nutritionist + data analyst.
- Give **specific numbers** from the data provided (never invent). If a metric is missing, say **"[metric] not logged for this period"** and continue — do not refuse the answer.
- Do not hedge with "it depends" without immediately making a **clear recommendation** and stating the assumption in one line.
- Never say **"I can't find"** or **"I don't have access"**. If a client name is ambiguous, list **all plausible matches** from the context and ask **one** disambiguation question, then stop.
- Never say **"I don't have access to that data"** for data types the platform stores; if something is not in the payload, say it is **not logged** and proceed.

## Data you may receive
- **LIVE DATABASE CONTEXT** — global snapshot (counts, recent rows).
- **ENRICHED CLIENT PACK(s)** — progress logs, daily check-ins, Sunday check-ins, workouts, **user_goals** (platform targets: weight, body fat %, weekly workouts; newest first), assigned programs (with **PDF text extract** when available), latest audit request (by email), Part-2 intake, tribe row (incl. notes), recent meetings.
- There are **no separate "trainer notes"** beyond tribe \`notes\` and meeting \`notes\` in this export.

## PDF program intelligence
- When **ASSIGNED PROGRAM (extracted PDF text)** is present: lead with **"According to [Program name] — here is what is prescribed vs what the client logged..."**
- **Never invent** program details. If PDF text is missing or empty, say: **"No program PDF text extracted for [client]. PDF may be missing, scanned-only, or unread. Assign/upload a text-based PDF for program-specific analysis."**

## Capabilities (triggers — adapt depth to the question)
1. Individual client report / "how is [name] doing" / last N days  
2. Compare two clients  
3. Rank / leaderboard / compliance (use leaderboard block in context when present)  
4. Program vs actuals, nutrition, plateau, period summaries, audit summary, business overview  

## Full client report structure (use when doing a full report)
Use markdown with clear headers:

### CLIENT: [Name] | PERIOD: [range] | PROGRAM: [name or "none extracted"]

#### Compliance
- Check-ins, streak signals, Sunday submissions (from data)

#### Body metrics
- Weight / body fat from progress logs (numbers + trend)

#### Nutrition & recovery (from logs)
- Avg calories, protein, sleep, water — vs targets **only if targets appear in program PDF text**; otherwise say targets not in extracted program text

#### Training
- Workouts completed, lift numbers if logged

#### Program status
- Prescribed vs actual (from PDF + logs)

#### Red flags
- Real issues only from data

#### Trainer action items
- **At least 3** numbered, specific actions

#### Client score
- **XX / 100** with one-line justification (derived only from provided data)

## Quick questions
- **≤3 short lines**, no preamble.

## Absolute rules
1. Facts and numbers must come from **LIVE DATABASE CONTEXT** and **ENRICHED CLIENT PACK** only.
2. Never fabricate check-ins, weights, or program content.
3. Prefer **one exact number** (e.g. "1850 kcal") when recommending a change; state it as a coaching decision tied to data.
4. **Trainer-facing only** — do not copy-paste sensitive narratives to "send to client" verbatim if they contain medical detail; summarize operationally.
5. Output: clean **Markdown** (###, bullets). No JSON, no stack traces.
`;

async function extractPdfText(fs, filePath, maxLen) {
  let parser = null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    parser = new PDFParse({ data: new Uint8Array(buf) });
    const data = await parser.getText();
    let t = String(data.text || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (t.length > maxLen) return `${t.slice(0, maxLen)}\n[... PDF text truncated at ${maxLen} chars]`;
    return t;
  } catch (e) {
    return `[PDF read/extract error: ${e.message}]`;
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      try {
        await parser.destroy();
      } catch (_) { /* ignore */ }
    }
  }
}

function programFilePath(rootDir, programId) {
  const safe = String(programId || '').replace(/[/\\\\]/g, '');
  return require('path').join(rootDir, 'public', 'programs', 'pdfs', safe);
}

const LEADING_CHUNK_STOPWORDS = new Set([
  'report', 'audit', 'check', 'the', 'my', 'our', 'give', 'show', 'summarize', 'list', 'how', 'what', 'when', 'why',
  'full', 'compare', 'rank', 'leaderboard', 'top', 'bottom', 'client', 'data', 'nutrition', 'program', 'score'
]);

function isLikelyPersonNameChunk(t) {
  const first = String(t || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z']/g, '');
  if (!first) return false;
  return !LEADING_CHUNK_STOPWORDS.has(first.replace(/'/g, ''));
}

async function findUsersMatching(queryAll, needle) {
  const q = String(needle || '').trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/%/g, '\\%')}%`;
  return queryAll(
    `SELECT id, first_name, last_name, email FROM users WHERE role = 'user'
     AND (approval_status = 'approved' OR approval_status IS NULL)
     AND (email ILIKE ? OR first_name ILIKE ? OR last_name ILIKE ?
          OR (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE ?)
     ORDER BY created_at DESC LIMIT 8`,
    [like, like, like, like]
  );
}

async function resolveClientIdsFromMessage(queryAll, text) {
  const raw = String(text || '');
  const ids = new Set();
  const ambiguous = [];

  const emails = raw.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || [];
  for (const em of emails) {
    const row = await queryOne(queryAll, `SELECT id, first_name, last_name, email FROM users WHERE role = 'user' AND LOWER(email) = LOWER(?)`, [em.trim()]);
    if (row) ids.add(row.id);
  }

  const chunks = [];
  if (/\bcompare\b/i.test(raw)) {
    const after = raw.replace(/^[\s\S]*?\bcompare\b/i, '').trim();
    after.split(/\s+(?:and|vs\.?|with)\s+/i).forEach((p) => {
      const s = p.replace(/[,.?!].*$/, '').trim();
      if (s.length >= 2 && s.length < 80) chunks.push(s);
    });
  }
  const patterns = [
    /\bhow\s+is\s+([^,.?\n]+?)\s+doing\b/i,
    /\breport\s+for\s+([^,.?\n]+)/i,
    /\bfull\s+report\s+for\s+([^,.?\n]+)/i,
    /\b(?:for|about)\s+client\s+([^,.?\n]+)/i,
    /\bclient\s+score\s+for\s+([^,.?\n]+)/i,
    /\bgive\s+me\s+([A-Za-z][A-Za-z\s.'-]{1,48})(?:'s\s+data|\s+data)\b/i,
    /\b(?:nutrition|calories|protein)\s+(?:for|on)\s+([^,.?\n]+)/i,
    /\baudit\s+for\s+([^,.?\n]+)/i,
    /\bprogram\s+check\s+for\s+([^,.?\n]+)/i,
    /\bis\s+([A-Za-z][A-Za-z\s.'-]{1,48})\s+following\b/i,
    /\bwhy\s+is\s+([^,.?\n]+?)\s+(?:stuck|plateau)/i,
    /\b([A-Za-z][A-Za-z\s.'-]{1,48})\s+last\s+\d+\s+days\b/i,
    /\b(?:for|about)\s+([A-Za-z][A-Za-z\s.'-]{2,50})(?=\s+last\b|\s+this\b|\s+in\s+the|\s*$|[,.?!])/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      const s = m[1].trim();
      if (s.length >= 2 && s.length < 80 && isLikelyPersonNameChunk(s)) chunks.push(s);
    }
  }

  const seen = new Set();
  for (const chunk of chunks) {
    const key = chunk.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const users = await findUsersMatching(queryAll, chunk);
    if (users.length === 1) ids.add(users[0].id);
    else if (users.length > 1) ambiguous.push({ query: chunk, matches: users.map((u) => ({ id: u.id, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), email: u.email })) });
  }

  return { ids: [...ids], ambiguous };
}

async function queryOne(queryAll, sql, params) {
  const rows = await queryAll(sql, params);
  return rows && rows.length ? rows[0] : null;
}

function isoFromDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function dateStrFromDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function buildClientPack({ queryAll, fs, rootDir }, userId, lookbackDays, programTextMax) {
  const user = await queryOne(queryAll, 'SELECT id, first_name, last_name, email, approval_status FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const email = (user.email || '').toLowerCase();
  const fromIso = isoFromDaysAgo(lookbackDays);
  const fromDate = dateStrFromDaysAgo(lookbackDays);

  const [programs, progress, daily, sunday, workouts, audit, part2, tribe, meetings, goals] = await Promise.all([
    queryAll(
      `SELECT a.assigned_at, p.id as program_id, p.name as program_name, p.pdf_url
       FROM user_program_assignments a
       JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ? AND a.removed_at IS NULL
       ORDER BY a.assigned_at DESC LIMIT 4`,
      [userId]
    ),
    queryAll(
      `SELECT weight, body_fat, calories_intake, protein_intake, workout_completed, workout_type,
              strength_bench, strength_squat, strength_deadlift, sleep_hours, water_intake, created_at
       FROM progress_logs WHERE user_id = ? AND created_at >= ?::timestamptz ORDER BY created_at ASC`,
      [userId, fromIso]
    ),
    queryAll(
      `SELECT checkin_date, steps, water_ml, protein_g, sleep_hours, created_at
       FROM daily_checkins WHERE user_id = ? AND checkin_date >= ?::date ORDER BY checkin_date ASC`,
      [userId, fromDate]
    ),
    queryAll(
      `SELECT plan, current_weight_waist_week, total_weight_loss, training_go, nutrition_go, sleep, achievements, created_at
       FROM sunday_checkins WHERE user_id = ? AND created_at >= ?::timestamptz ORDER BY created_at DESC LIMIT 8`,
      [userId, fromIso]
    ),
    queryAll(
      `SELECT workout_name, duration_seconds, feedback, created_at FROM workout_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz ORDER BY created_at DESC LIMIT 25`,
      [userId, fromIso]
    ),
    queryAll(
      `SELECT first_name, last_name, email, city, goals, status, fitness_experience, motivation, created_at
       FROM audit_requests WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1`,
      [email]
    ),
    queryAll(
      `SELECT name, email, mobile, activity_level, sports_history, injuries, mental_health, gym_experience,
              food_choices, vices_addictions, goals, what_compelled, created_at
       FROM part2_audit WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1`,
      [email]
    ),
    queryAll(
      `SELECT phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, status, notes, next_checkin
       FROM tribe_members WHERE LOWER(email) = ? ORDER BY start_date DESC LIMIT 1`,
      [email]
    ),
    queryAll(
      `SELECT meeting_date, time_slot, status, notes, created_at FROM meetings
       WHERE LOWER(user_email) = ? ORDER BY created_at DESC LIMIT 5`,
      [email]
    ),
    queryAll(
      `SELECT target_weight, target_body_fat, weekly_workout_target, created_at
       FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
      [userId]
    )
  ]);

  const programBlocks = [];
  for (const p of programs) {
    const fp = programFilePath(rootDir, p.program_id);
    const extracted = await extractPdfText(fs, fp, programTextMax);
    programBlocks.push({
      program_id: p.program_id,
      program_name: p.program_name,
      pdf_url: p.pdf_url,
      assigned_at: p.assigned_at,
      extracted_pdf_text: extracted || null
    });
  }

  return {
    user: {
      id: user.id,
      name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      email: user.email
    },
    lookback_days: lookbackDays,
    user_goals: {
      latest: goals[0] || null,
      history: goals
    },
    assigned_programs: programBlocks,
    progress_logs: progress,
    daily_checkins: daily,
    sunday_checkins: sunday,
    workout_logs: workouts,
    latest_audit_request: audit[0] || null,
    latest_part2: part2[0] || null,
    tribe_member: tribe[0] || null,
    recent_meetings: meetings
  };
}

async function buildLeaderboardSnippet(queryAll, lookbackDays) {
  const fromDate = dateStrFromDaysAgo(lookbackDays);
  const fromIso = isoFromDaysAgo(lookbackDays);
  const rows = await queryAll(
    `SELECT u.id, u.first_name, u.last_name, u.email,
      (SELECT COUNT(*)::int FROM daily_checkins dc WHERE dc.user_id = u.id AND dc.checkin_date >= ?::date) AS daily_checkins_n,
      (SELECT COUNT(*)::int FROM progress_logs pl WHERE pl.user_id = u.id AND pl.created_at >= ?::timestamptz) AS progress_logs_n,
      (SELECT COUNT(*)::int FROM workout_logs wl WHERE wl.user_id = u.id AND wl.created_at >= ?::timestamptz) AS workouts_n
     FROM users u
     WHERE u.role = 'user' AND (u.approval_status = 'approved' OR u.approval_status IS NULL)
     ORDER BY daily_checkins_n DESC, progress_logs_n DESC
     LIMIT 35`,
    [fromDate, fromIso, fromIso]
  );
  return rows;
}

/**
 * Append enriched packs + leaderboard to base admin context.
 */
async function enrichAdminAiContext(deps, userMessage, baseContext) {
  const { queryAll, fs, rootDir } = deps;
  const lookback = DEFAULT_LOOKBACK_DAYS;
  const maxProg = DEFAULT_PROGRAM_TEXT_MAX;
  const parts = [baseContext || ''];
  const msg = String(userMessage || '');

  const wantLeader = /\b(rank|ranking|leaderboard|top\s+clients|most\s+compliant|best\s+performing|worst\s+performing|who\s+is\s+doing\s+best)\b/i.test(msg);
  if (wantLeader) {
    try {
      const lb = await buildLeaderboardSnippet(queryAll, lookback);
      parts.push('\n--- LEADERBOARD SNAPSHOT (last ' + lookback + ' days; sort hint: daily check-ins) ---\n');
      parts.push(JSON.stringify(lb, null, 0).slice(0, 28000));
    } catch (e) {
      parts.push('\n--- LEADERBOARD: fetch failed: ' + e.message + ' ---\n');
    }
  }

  const { ids, ambiguous } = await resolveClientIdsFromMessage(queryAll, msg);
  if (ambiguous.length) {
    parts.push('\n--- AMBIGUOUS CLIENT MATCHES (ask trainer to pick one) ---\n');
    parts.push(JSON.stringify(ambiguous, null, 2));
  }

  for (const uid of ids) {
    try {
      const pack = await buildClientPack({ queryAll, fs, rootDir }, uid, lookback, maxProg);
      if (pack) {
        parts.push('\n--- ENRICHED CLIENT PACK ---\n');
        parts.push(JSON.stringify(pack, null, 2));
      }
    } catch (e) {
      parts.push('\n--- CLIENT PACK ERROR user ' + uid + ': ' + e.message + ' ---\n');
    }
  }

  if (ids.length === 0 && !wantLeader && !/\b(how many|pending|list|count|overall stats|dashboard)\b/i.test(msg)) {
    parts.push(
      '\n--- NOTE ---\nNo specific client was auto-linked to this message (no email match and no confident name match). ' +
        'Use LIVE DATABASE CONTEXT for global questions. For a named client, include their **email** or **full name** (e.g. "How is Jane Doe doing in the last 30 days?").\n'
    );
  }

  return parts.join('\n');
}

function buildTrainerSystemContent(enrichedContext) {
  return BODYBANK_TRAINER_AI_SYSTEM_PROMPT + '\n\n--- LIVE DATABASE CONTEXT (includes enrichment below) ---\n' + enrichedContext;
}

module.exports = {
  BODYBANK_TRAINER_AI_SYSTEM_PROMPT,
  enrichAdminAiContext,
  buildTrainerSystemContent
};
