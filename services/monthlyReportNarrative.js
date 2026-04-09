'use strict';

/**
 * Luxury monthly report: AI-generated executive summary + per-section pros/cons.
 * Falls back to deterministic heuristics if the API is unavailable or JSON parse fails.
 */

const MAX_FIELD_LEN = 1800;
const MAX_SNAPSHOT_CHARS = 110000;

function truncate(str, max = MAX_FIELD_LEN) {
  const s = String(str == null ? '' : str);
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n… [truncated]';
}

/** Deep-clone and truncate long strings for the model snapshot. */
function sanitizeForSnapshot(obj, depth = 0) {
  if (depth > 12) return null;
  if (obj == null) return obj;
  if (typeof obj === 'string') return truncate(obj, MAX_FIELD_LEN);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 500).map((x) => sanitizeForSnapshot(x, depth + 1));
  if (typeof obj === 'object') {
    const out = {};
    const keys = Object.keys(obj).slice(0, 200);
    keys.forEach((k) => {
      out[k] = sanitizeForSnapshot(obj[k], depth + 1);
    });
    return out;
  }
  return String(obj);
}

function buildSnapshot({ data, user, monthKey, monthKeyText, reportSummary, prevSummary, insights }) {
  const coach = insights && typeof insights === 'object' ? { ...insights } : null;
  const payload = {
    client: { name: user.name, email: user.email, id: user.id },
    reporting_month: monthKey,
    month_label: monthKeyText,
    summary_this_month: reportSummary,
    summary_prior_month: prevSummary,
    progress_insights_engine: coach,
    data: {
      progressLogs: data.progressLogs || [],
      dailyCheckins: data.dailyCheckins || [],
      sundayCheckins: data.sundayCheckins || [],
      workouts: data.workouts || [],
      part2: data.part2 || null,
      audit: data.audit || null,
      tribeMember: data.tribeMember || null,
      programs: data.programs || [],
      userGoals: data.userGoals || [],
      hydrationLogs: data.hydrationLogs || [],
      weightLogs: data.weightLogs || [],
      meetings: data.meetings || []
    }
  };
  let json = JSON.stringify(sanitizeForSnapshot(payload), null, 0);
  if (json.length > MAX_SNAPSHOT_CHARS) {
    json = json.slice(0, MAX_SNAPSHOT_CHARS) + '\n… [snapshot truncated for API]';
  }
  return json;
}

const NARRATIVE_SYSTEM = `You are the lead coach and report author for BodyBank — a luxury, evidence-based fitness brand.
You will receive a JSON snapshot of ONE client's data for a single calendar month (and lifetime engine insights where noted).

TASK — Output ONLY valid JSON (no markdown fences, no commentary before or after). Use this exact shape:
{
  "executive_summary": "3–5 short paragraphs in plain text. Warm, precise, executive tone. Reference specific numbers from the data.",
  "sections": {
    "onboarding_audit": { "pros": ["..."], "cons": ["..."], "note": "one paragraph" },
    "part2_intake": { "pros": [], "cons": [], "note": "" },
    "daily_checkins": { "pros": [], "cons": [], "note": "" },
    "progress_logs": { "pros": [], "cons": [], "note": "" },
    "sunday_checkins": { "pros": [], "cons": [], "note": "" },
    "workouts": { "pros": [], "cons": [], "note": "" },
    "tribe_programs": { "pros": [], "cons": [], "note": "" },
    "hydration_weight_goals": { "pros": [], "cons": [], "note": "" },
    "meetings": { "pros": [], "cons": [], "note": "" }
  }
}

Rules:
- If a section has no data (empty arrays / null), still give 1–2 "cons" about visibility gaps and 1 "pro" if any signal exists, and explain in note.
- "pros" and "cons" are 2–5 bullets each, complete sentences, no fluff.
- Never invent numbers; say "not logged" when data is missing.
- British or Indian English is fine; stay professional and kind.`;

function parseNarrativeJson(text) {
  if (!text || typeof text !== 'string') return null;
  let raw = text.trim();
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Deterministic luxury-style narrative when AI is off or fails. */
function buildHeuristicNarrative({ data, reportSummary, prevSummary, insights }) {
  const daily = data.dailyCheckins || [];
  const prog = data.progressLogs || [];
  const sun = data.sundayCheckins || [];
  const wk = data.workouts || [];
  const audit = data.audit;
  const p2 = data.part2;
  const tribe = data.tribeMember;
  const goals = data.userGoals || [];
  const hyd = data.hydrationLogs || [];
  const wl = data.weightLogs || [];
  const mtg = data.meetings || [];

  const daysExpected = reportSummary._daysInMonth || 30;
  const dailyPct = daysExpected ? Math.round((daily.length / daysExpected) * 100) : 0;

  let executive = '';
  executive += `This month shows ${daily.length} daily check-in days, ${prog.length} progress log entries, ${sun.length} Sunday reviews, and ${wk.length} My Workout sessions. `;
  if (reportSummary.avgSleep != null && reportSummary.avgSleep < 6.5) {
    executive += `Sleep is averaging ${reportSummary.avgSleep.toFixed(1)}h in daily data — recovery capacity may cap adaptation until sleep improves. `;
  }
  if (prevSummary && prevSummary.dailyCount != null) {
    executive += `Versus the prior month, daily check-ins moved from ${prevSummary.dailyCount} to ${daily.length}. `;
  }
  executive += `Use the section breakdowns for full field-level detail; gaps flagged below are coaching opportunities, not judgment.`;

  const sec = (pros, cons, note) => ({ pros, cons, note });

  const onboarding_audit = sec(
    audit
      ? ['Onboarding capture gives demographic and goal context for programming.', 'Motivation and experience fields support safe progression choices.']
      : ['No onboarding audit on file — rely on Part-2 and live coaching for context.'],
    audit
      ? ['Single snapshot may be dated vs current lifestyle — confirm in conversation.']
      : ['Without audit data, early risk factors may be under-documented.'],
    audit
      ? 'Cross-check stated goals and occupation stress against current week behaviour.'
      : 'Consider prompting the client to complete onboarding for a fuller dossier.'
  );

  const part2_intake = sec(
    p2
      ? ['Deep intake covers injuries, mental load, and food environment — high-signal for coaching.', 'Activity and gym experience inform volume prescriptions.']
      : ['Part-2 not submitted — coaching relies on lighter signals only.'],
    p2
      ? ['Injuries and vices require periodic re-validation as capacity changes.']
      : ['Risk: programming without structured medical / lifestyle disclosure.'],
    p2 ? 'Revisit injury and stress notes if training intensity ramps this quarter.' : 'Prioritise Part-2 completion for safety and personalization.'
  );

  const daily_checkins = sec(
    daily.length >= 10
      ? [`Strong telemetry (${daily.length} days) — trends in steps, protein, and sleep are usable.`]
      : daily.length > 0
        ? ['Some daily visibility — better than none for accountability.']
        : ['No daily rows this month — habit and nutrition signals are blind.'],
    daily.length < daysExpected * 0.4
      ? [`Check-in coverage ~${dailyPct}% of month — gaps weaken trend confidence.`]
      : ['Watch for selective logging (weekends vs weekdays) when interpreting averages.'],
    'Daily layer is the fastest feedback loop for adherence and recovery.'
  );

  const progress_logs = sec(
    prog.length >= 4 ? ['Repeated body metrics entries support weight/BF trajectory analysis.'] : ['Limited progress rows — each entry still anchors the chart.'],
    prog.length === 0 ? ['No progress_logs — strength and scale trends rely on other tables.'] : ['Sparse logging can exaggerate noise in deltas.'],
    'Progress logs remain the canonical merge point for weight, intake, and strength markers.'
  );

  const sunday_checkins = sec(
    sun.length > 0 ? ['Weekly narrative captures mindset, obstacles, and wins.'] : ['No Sunday submission this month — long-form reflection missing.'],
    sun.length === 0 ? ['Risk: drift without structured weekly accountability.'] : ['Late-week stress may be under-reported if only one Sunday exists.'],
    'Sunday forms are ideal for adjusting next-week priorities and celebrating adherence.'
  );

  const completed = wk.filter((r) => r.workout_completed === true || r.workout_completed === 1).length;
  const workouts = sec(
    wk.length >= 8 ? ['Training frequency supports adaptation when recovery matches.'] : wk.length > 0 ? ['Sessions logged — volume can now be refined for quality and progression.'] : ['No My Workout rows — resistance stimulus unverified in-app.'],
    wk.length > 0 && completed < wk.length * 0.5
      ? ['Many sessions not marked complete — data hygiene may hide true compliance.']
      : wk.length === 0
        ? ['No logged sessions — cannot verify intensity, lifts, or RPE patterns.']
        : ['Ensure session_lifts and intensity tags stay consistent for period-over-period review.'],
    'My Workout holds structured lifts, intensity, and energy — use for load management.'
  );

  const tribe_programs = sec(
    (data.programs || []).length ? ['Assigned program(s) document expected stimulus and structure.'] : [],
    !(data.programs || []).length ? ['No active program assignment visible — alignment between plan and logs is unclear.'] : [],
    tribe
      ? `Tribe status ${tribe.status || '—'} · phase ${tribe.phase ?? '—'}.`
      : 'Not currently showing tribe membership — coaching context may be app-only.'
  );

  const hydration_weight_goals = sec(
    [
      goals.length ? ['Platform goals set a north star for weight, BF%, and weekly sessions.'] : [],
      hyd.length || wl.length ? ['Dedicated hydration or weight_logs add precision beyond merged progress.'] : []
    ]
      .flat()
      .filter(Boolean),
    [
      !goals.length ? ['Goals table empty — targets are implicit only.'] : [],
      !hyd.length && !wl.length ? ['No standalone hydration/weight_logs — rely on daily/progress for fluids and scale.'] : []
    ]
      .flat()
      .filter(Boolean),
    'Align goal targets with what was actually logged this month.'
  );

  const meetingsSec = sec(
    mtg.length ? ['Scheduled touchpoints are on record for accountability and planning.'] : ['No meetings logged in this month — coaching may be app-only.'],
    mtg.length ? [] : ['No in-person or scheduled video slots captured in the system this month.'],
    'Meeting notes summarise intent; execution still lives in daily logs and workouts.'
  );

  return {
    executive_summary: executive,
    sections: {
      onboarding_audit,
      part2_intake,
      daily_checkins,
      progress_logs,
      sunday_checkins,
      workouts,
      tribe_programs,
      hydration_weight_goals,
      meetings: meetingsSec
    },
    _source: 'heuristic'
  };
}

/**
 * @param {object} params
 * @param {function(string,string,number): Promise<{reply?: string}|null>} params.callAnthropicChat - (system, userMessage, maxTokens)
 */
async function fetchMonthlyReportNarrative(params) {
  const { data, user, monthKey, monthKeyText, reportSummary, prevSummary, insights, callAnthropicChat } = params;
  if (!callAnthropicChat) return null;
  const snapshot = buildSnapshot({
    data,
    user,
    monthKey,
    monthKeyText,
    reportSummary,
    prevSummary,
    insights
  });
  const userMsg =
    'Analyze the following client-month JSON. Respond with ONLY the JSON object described in your system instructions.\n\n' +
    snapshot;
  const maxTok = Math.max(
    8192,
    parseInt(process.env.MONTHLY_REPORT_AI_MAX_TOKENS || '16384', 10)
  );
  try {
    const result = await callAnthropicChat(NARRATIVE_SYSTEM, userMsg, maxTok);
    const text = result && result.reply;
    const parsed = parseNarrativeJson(text || '');
    if (parsed && parsed.sections && typeof parsed.executive_summary === 'string') {
      parsed._source = 'anthropic';
      return parsed;
    }
  } catch (e) {
    console.error('[monthlyReportNarrative]', e.message);
  }
  return null;
}

module.exports = {
  buildSnapshot,
  buildHeuristicNarrative,
  fetchMonthlyReportNarrative,
  parseNarrativeJson,
  truncate
};
