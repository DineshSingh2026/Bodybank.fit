'use strict';

/**
 * Whoop data-export parser — zero dependencies, RFC4180-correct CSV.
 *
 * Whoop members download a ZIP of CSVs (physiological_cycles.csv, sleeps.csv,
 * workouts.csv, journal_entries.csv). Column NAMES drift between app versions,
 * units drift with account settings, and timestamps carry per-cycle UTC offsets.
 * This module normalises all of that into BodyBank's canonical per-day shape.
 *
 * Design rules (non-negotiable):
 *   1. Columns are NEVER read by position — only through the alias table below.
 *      Unrecognised headers are collected into `unknownColumns`, never dropped
 *      silently and never fatal.
 *   2. A cycle / sleep is attributed to the calendar date of its WAKE time,
 *      converted to Asia/Kolkata. A sleep 23:40 -> 06:10 belongs to the wake day.
 *   3. Naps never inflate nightly sleep — they accumulate into `napMinutes`.
 *   4. Units are detected from header text AND sanity-checked against the value
 *      (a "celsius" reading of 95 is really Fahrenheit). Canonical SI is stored
 *      alongside the raw value and the detected unit.
 *   5. Nothing is ever invented. Unparseable / missing required fields produce a
 *      `rejected` entry. Missing numerics are `null`, never 0.
 *
 * @module services/wearables/whoopParser
 */

/** BodyBank's canonical timezone (same constant as services/streakService.js). */
const WHOOP_TZ = 'Asia/Kolkata';

/* ------------------------------------------------------------------ *
 * 1. RFC4180 CSV
 * ------------------------------------------------------------------ */

/**
 * Split CSV text into physical rows of raw string cells.
 * Handles: quoted fields, embedded commas, embedded `""` quotes, CRLF/LF/CR
 * line endings and a leading UTF-8 BOM. Index i of the result corresponds to
 * physical line i+1 (used for `rowNumber` in rejections).
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  let s = text == null ? '' : String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') {
      if (s[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = ''; i += 1; continue;
    }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** True when every cell of a physical row is blank (skipped, not rejected). */
function isBlankRow(cells) {
  return !cells || cells.every((c) => String(c == null ? '' : c).trim() === '');
}

/* ------------------------------------------------------------------ *
 * 2. Header normalisation + alias table  (accuracy requirement #1)
 * ------------------------------------------------------------------ */

/**
 * Normalise a raw header cell to a match key: drop the BOM, drop parenthesised
 * units `(bpm)` `(min)` `(celsius)`, lowercase, then strip every non-alphanumeric
 * character. "Deep (SWS) duration (min)" -> "deepduration".
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeHeaderKey(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/** Sleep columns shared by physiological_cycles.csv and sleeps.csv. */
const SLEEP_ALIASES = {
  sleepOnset: ['sleeponset', 'sleeponsettime', 'sleepstart', 'sleepstarttime', 'asleeponset', 'bedtime', 'sleepbegin'],
  wakeOnset: ['wakeonset', 'wakeonsettime', 'wakeuptime', 'waketime', 'sleepend', 'sleependtime', 'awakeonset'],
  sleepPerformancePct: ['sleepperformance', 'sleepperformancescore', 'sleepscore'],
  respiratoryRate: ['respiratoryrate', 'respirationrate', 'resprate', 'breathingrate'],
  asleepMin: ['asleepduration', 'asleeptime', 'sleepduration', 'totalsleepduration', 'totalsleeptime', 'timeasleep', 'totalinsleeptime'],
  inBedMin: ['inbedduration', 'inbedtime', 'timeinbed', 'totalinbedtime'],
  lightMin: ['lightsleepduration', 'lightduration', 'lightsleep', 'lightsleeptime', 'totallightsleeptime'],
  deepMin: ['deepduration', 'deepsleepduration', 'deepswsduration', 'swsduration', 'slowwavesleepduration', 'deepsleep', 'totalslowwavesleeptime'],
  remMin: ['remduration', 'remsleepduration', 'remsleep', 'remsleeptime', 'totalremsleeptime'],
  awakeMin: ['awakeduration', 'awaketime', 'wakeduration', 'timeawake', 'totalawaketime'],
  sleepNeedMin: ['sleepneed', 'sleepneeded', 'sleepneededduration'],
  sleepDebtMin: ['sleepdebt', 'sleepdebtduration'],
  sleepEfficiencyPct: ['sleepefficiency', 'sleepefficiencyscore'],
  sleepConsistencyPct: ['sleepconsistency', 'sleepconsistencyscore']
};

const CYCLE_ONLY_ALIASES = {
  cycleStart: ['cyclestarttime', 'cyclestart', 'starttime', 'start'],
  cycleEnd: ['cycleendtime', 'cycleend', 'endtime', 'end'],
  cycleTimezone: ['cycletimezone', 'timezone', 'timezoneoffset', 'tz', 'cycletimezoneoffset'],
  recoveryScore: ['recoveryscore', 'recovery'],
  restingHr: ['restingheartrate', 'restinghr', 'rhr'],
  hrvMs: ['heartratevariability', 'heartratevariabilityrmssd', 'hrv', 'hrvrmssd'],
  skinTemp: ['skintemp', 'skintemperature', 'temperature'],
  spo2: ['bloodoxygen', 'spo2', 'oxygensaturation', 'bloodoxygenlevel'],
  strain: ['daystrain', 'strain', 'scaledstrain'],
  energy: ['energyburned', 'calories', 'caloriesburned', 'energyexpenditure', 'kilojoules'],
  maxHr: ['maxhr', 'maxheartrate', 'maximumheartrate'],
  avgHr: ['averagehr', 'avghr', 'averageheartrate', 'avgheartrate', 'meanheartrate']
};

const SLEEPS_ONLY_ALIASES = {
  isNap: ['nap', 'isnap', 'napyn', 'naps', 'isanap']
};

const WORKOUT_ALIASES = {
  start: ['workoutstarttime', 'workoutstart', 'starttime', 'start', 'cyclestarttime'],
  end: ['workoutendtime', 'workoutend', 'endtime', 'end', 'cycleendtime'],
  timezone: ['workouttimezone', 'cycletimezone', 'timezone', 'tz'],
  durationMin: ['duration', 'workoutduration', 'activityduration', 'totalduration'],
  activity: ['activityname', 'activity', 'sport', 'sportname', 'workouttype', 'activitytype'],
  strain: ['activitystrain', 'workoutstrain', 'strain'],
  energy: ['energyburned', 'calories', 'caloriesburned', 'kilojoules'],
  maxHr: ['maxhr', 'maxheartrate', 'maximumheartrate'],
  avgHr: ['averagehr', 'avghr', 'averageheartrate', 'avgheartrate'],
  z1: ['hrzone1duration', 'hrzone1', 'heartratezone1duration', 'zone1duration', 'zone1'],
  z2: ['hrzone2duration', 'hrzone2', 'heartratezone2duration', 'zone2duration', 'zone2'],
  z3: ['hrzone3duration', 'hrzone3', 'heartratezone3duration', 'zone3duration', 'zone3'],
  z4: ['hrzone4duration', 'hrzone4', 'heartratezone4duration', 'zone4duration', 'zone4'],
  z5: ['hrzone5duration', 'hrzone5', 'heartratezone5duration', 'zone5duration', 'zone5']
};

const JOURNAL_ALIASES = {
  cycleStart: ['cyclestarttime', 'cyclestart', 'starttime', 'start', 'date'],
  question: ['questiontext', 'question', 'behaviour', 'behavior', 'journalquestion'],
  answer: ['answeredyesno', 'answer', 'response', 'answered', 'value'],
  notes: ['notes', 'note', 'comment', 'comments', 'notestext']
};

/** kind -> { normalizedHeader: canonicalKey } */
const ALIAS_INDEX = (() => {
  function invert(...tables) {
    const out = Object.create(null);
    tables.forEach((t) => {
      Object.keys(t).forEach((canon) => {
        t[canon].forEach((alias) => { if (!(alias in out)) out[alias] = canon; });
      });
    });
    return out;
  }
  return {
    cycles: invert(CYCLE_ONLY_ALIASES, SLEEP_ALIASES),
    sleeps: invert(CYCLE_ONLY_ALIASES, SLEEP_ALIASES, SLEEPS_ONLY_ALIASES),
    workouts: invert(WORKOUT_ALIASES),
    journal: invert(JOURNAL_ALIASES)
  };
})();

const KINDS = ['cycles', 'sleeps', 'workouts', 'journal'];

/* ------------------------------------------------------------------ *
 * 3. Timestamps + timezone  (accuracy requirement #2)
 * ------------------------------------------------------------------ */

/**
 * Parse an offset declaration: "UTC+05:30", "+0530", "GMT-7", "Z".
 * @returns {number|null} minutes east of UTC
 */
function parseOffsetMinutes(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (/^(z|utc|gmt|utc\+0+(:0+)?|gmt\+0+(:0+)?)$/i.test(s)) return 0;
  const m = /([+-])(\d{1,2}):?(\d{2})?$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[2], 10);
  const mi = m[3] == null ? 0 : parseInt(m[3], 10);
  if (h > 14 || mi > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (h * 60 + mi);
}

function validEpoch(y, mo, d, h, mi, se, ms) {
  if (h > 23 || mi > 59 || se > 60) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return t;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Parse a Whoop timestamp.
 *
 * Accepts `2025-03-14T23:40:12.000+05:30`, `2025-03-14 23:40:12`, `2025-03-14`,
 * and US-style `3/14/2025 11:40:12 PM` (Whoop's US locale export). A bare
 * timestamp with no offset is only converted when the row declares a timezone
 * (`Cycle timezone`); otherwise its literal date is used as-is rather than
 * inventing a zone.
 *
 * @param {string} value
 * @param {string} [tzHint] value of the row's timezone column
 * @returns {{epochMs:number|null, hasZone:boolean, localYmd:string, iso:string|null}|null}
 */
function parseTimestamp(value, tzHint) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;

  let y;
  let mo;
  let d;
  let h = 0;
  let mi = 0;
  let se = 0;
  let ms = 0;
  let offRaw = null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
    h = m[4] == null ? 0 : +m[4];
    mi = m[5] == null ? 0 : +m[5];
    se = m[6] == null ? 0 : +m[6];
    ms = m[7] == null ? 0 : +String(m[7]).slice(0, 3).padEnd(3, '0');
    offRaw = m[8] || null;
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) return null;
    // Whoop's non-ISO export uses the US M/D/YYYY ordering.
    mo = +m[1]; d = +m[2]; y = +m[3];
    h = m[4] == null ? 0 : +m[4];
    mi = m[5] == null ? 0 : +m[5];
    se = m[6] == null ? 0 : +m[6];
    if (m[7]) {
      const pm = /p/i.test(m[7]);
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    offRaw = m[8] || null;
  }

  const wallMs = validEpoch(y, mo, d, h, mi, se, ms);
  if (wallMs == null) return null;

  const localYmd = `${y}-${pad2(mo)}-${pad2(d)}`;
  let offMin = offRaw ? parseOffsetMinutes(offRaw) : null;
  let hasZone = offMin != null;
  if (!hasZone) {
    const hinted = parseOffsetMinutes(tzHint);
    if (hinted != null) { offMin = hinted; hasZone = true; }
  }
  if (!hasZone) return { epochMs: null, hasZone: false, localYmd, iso: null };

  const epochMs = wallMs - offMin * 60000;
  return { epochMs, hasZone: true, localYmd, iso: new Date(epochMs).toISOString() };
}

/**
 * Calendar date (YYYY-MM-DD) of a timestamp in `tz`.
 * Same `Intl.DateTimeFormat('en-CA', { timeZone })` idiom as streakService.
 *
 * @param {string} isoLike
 * @param {string} [tz=Asia/Kolkata]
 * @param {string} [tzHint] the row's declared timezone, for bare timestamps
 * @returns {string|null}
 */
function ymdInTz(isoLike, tz, tzHint) {
  const p = parseTimestamp(isoLike, tzHint);
  if (!p) return null;
  // No offset anywhere in the data: the printed date is the only truth we have.
  if (!p.hasZone) return p.localYmd;
  const zone = tz || WHOOP_TZ;
  try {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(p.epochMs));
    return s.length >= 10 ? s.slice(0, 10) : null;
  } catch (_) {
    return new Date(p.epochMs).toISOString().slice(0, 10);
  }
}

/* ------------------------------------------------------------------ *
 * 4. Values + units  (accuracy requirements #4, #5)
 * ------------------------------------------------------------------ */

const NULLISH = new Set(['', '-', '--', 'n/a', 'na', 'null', 'nan', 'none', 'undefined']);

/** Numeric cell -> number, or null. Never 0 for a missing value. */
function toNum(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (NULLISH.has(s.toLowerCase())) return null;
  const cleaned = s.replace(/,/g, '').replace(/%/g, '').replace(/\s/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toStr(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

const TRUEY = new Set(['true', 'yes', 'y', '1', 't']);
const FALSEY = new Set(['false', 'no', 'n', '0', 'f']);

function toBool(raw) {
  const s = toStr(raw);
  if (s == null) return null;
  const k = s.toLowerCase();
  if (TRUEY.has(k)) return true;
  if (FALSEY.has(k)) return false;
  return null;
}

function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Declared skin-temp unit from the raw header text. */
function declaredTempUnit(header) {
  const h = String(header || '');
  if (/fahrenheit|deg\s*f|°\s*f|\(\s*f\s*\)|\bf\b/i.test(h)) return 'F';
  return 'C';
}

/**
 * Canonicalise skin temperature. Header text is a hint, not proof: an account
 * switched to imperial still exports a column labelled "(celsius)", so a
 * "celsius" reading above 45 is treated as Fahrenheit.
 *
 * @returns {{skinTempC:number|null, skinTempRaw:number|null, skinTempUnit:string|null}}
 */
function canonicalizeTemp(value, header) {
  const raw = toNum(value);
  if (raw == null) return { skinTempC: null, skinTempRaw: null, skinTempUnit: null };
  let unit = declaredTempUnit(header);
  if (unit === 'C' && raw >= 45) unit = 'F';       // 95 "celsius" is really 95F
  else if (unit === 'F' && raw <= 45) unit = 'C';  // 33 "fahrenheit" is really 33C
  const c = unit === 'F' ? (raw - 32) * 5 / 9 : raw;
  return { skinTempC: round(c, 2), skinTempRaw: raw, skinTempUnit: unit };
}

/** Declared energy unit from the raw header text. */
function declaredEnergyUnit(header) {
  const h = String(header || '');
  if (/kilojoule|\bkj\b/i.test(h)) return 'kJ';
  if (/kilocalorie|\bkcal\b/i.test(h)) return 'kcal';
  return 'cal';
}

/**
 * Canonicalise energy to kilocalories. Whoop's "(cal)" column is really kcal;
 * a value above 20000 is small calories and is scaled down.
 * @returns {{energyKcal:number|null, energyRaw:number|null, energyUnit:string|null}}
 */
function canonicalizeEnergy(value, header) {
  const raw = toNum(value);
  if (raw == null) return { energyKcal: null, energyRaw: null, energyUnit: null };
  let unit = declaredEnergyUnit(header);
  let kcal = raw;
  if (unit === 'kJ') kcal = raw / 4.184;
  else if (raw > 20000) { unit = 'cal(small)'; kcal = raw / 1000; }
  return { energyKcal: round(kcal, 1), energyRaw: raw, energyUnit: unit };
}

/* ------------------------------------------------------------------ *
 * 5. Per-file parsing
 * ------------------------------------------------------------------ */

/**
 * Parse one Whoop CSV into canonical rows.
 *
 * @param {string} text raw CSV text
 * @param {'cycles'|'sleeps'|'workouts'|'journal'} kind
 * @param {{file?:string}} [opts]
 * @returns {{kind:string, file:string, headers:string[], fields:(string|null)[],
 *            headerByField:Object, unknownColumns:string[], rows:Object[],
 *            rejected:Object[], rowsParsed:number, rowsRejected:number}}
 */
function parseWhoopCsv(text, kind, opts) {
  const file = (opts && opts.file) || `${kind}.csv`;
  if (KINDS.indexOf(kind) === -1) throw new Error(`parseWhoopCsv: unknown kind "${kind}"`);

  const index = ALIAS_INDEX[kind];
  const table = parseCsv(text);
  const out = {
    kind, file, headers: [], fields: [], headerByField: {},
    unknownColumns: [], rows: [], rejected: [], rowsParsed: 0, rowsRejected: 0
  };

  // First non-blank physical row is the header.
  let headerLine = -1;
  for (let i = 0; i < table.length; i += 1) {
    if (!isBlankRow(table[i])) { headerLine = i; break; }
  }
  if (headerLine === -1) return out;

  out.headers = table[headerLine].map((h) => String(h == null ? '' : h).replace(/^\uFEFF/, '').trim());
  const seen = new Set();
  out.fields = out.headers.map((h) => {
    const key = normalizeHeaderKey(h);
    const canon = key ? index[key] : undefined;
    if (!canon) {
      if (h !== '' && !out.unknownColumns.includes(h)) out.unknownColumns.push(h);
      return null;
    }
    if (seen.has(canon)) return canon; // duplicate spelling of the same field
    seen.add(canon);
    if (!(canon in out.headerByField)) out.headerByField[canon] = h;
    return canon;
  });

  for (let i = headerLine + 1; i < table.length; i += 1) {
    const cells = table[i];
    if (isBlankRow(cells)) continue;
    const rowNumber = i + 1; // 1-based physical line
    const raw = Object.create(null);
    for (let c = 0; c < out.fields.length; c += 1) {
      const f = out.fields[c];
      if (!f) continue;
      const v = c < cells.length ? String(cells[c] == null ? '' : cells[c]).trim() : '';
      if (v !== '' && (raw[f] == null || raw[f] === '')) raw[f] = v;
      else if (!(f in raw)) raw[f] = '';
    }
    const rec = buildRow(kind, raw, out.headerByField);
    if (rec.error) {
      out.rejected.push({ file, rowNumber, reason: rec.error, raw: cells.slice() });
      out.rowsRejected += 1;
    } else {
      rec.row._rowNumber = rowNumber;
      rec.row._file = file;
      out.rows.push(rec.row);
      out.rowsParsed += 1;
    }
  }
  return out;
}

/** Convert a raw cell map into a canonical row, or return `{error}` (never invent). */
function buildRow(kind, raw, headerByField) {
  const tzHint = raw.cycleTimezone || raw.timezone || null;

  if (kind === 'cycles' || kind === 'sleeps') {
    const sleep = readSleepFields(raw, tzHint);
    // Attribution: the WAKE date. A cycle without a wake time falls back to its
    // cycle end (the same instant, differently labelled); nothing else.
    let date = sleep.wakeOnset ? ymdInTz(sleep.wakeOnset, WHOOP_TZ, tzHint) : null;
    let attributedFrom = date ? 'wakeOnset' : null;
    if (!date && kind === 'cycles' && raw.cycleEnd) {
      date = ymdInTz(raw.cycleEnd, WHOOP_TZ, tzHint);
      attributedFrom = date ? 'cycleEnd' : null;
    }
    if (!date) {
      const hadCandidate = kind === 'cycles'
        ? Boolean(sleep.wakeOnset || toStr(raw.cycleEnd))
        : Boolean(sleep.wakeOnset);
      return {
        error: hadCandidate
          ? (kind === 'cycles' ? 'unparseable wake/cycle-end timestamp' : 'unparseable wake onset')
          : 'missing wake onset (cannot attribute a calendar date)'
      };
    }

    const row = Object.assign({ date, attributedFrom, kind }, sleep);
    row.isNap = kind === 'sleeps' ? (toBool(raw.isNap) === true) : false;
    row.cycleStart = toStr(raw.cycleStart);
    row.cycleEnd = toStr(raw.cycleEnd);
    row.cycleTimezone = toStr(tzHint);
    const startParsed = row.cycleStart ? parseTimestamp(row.cycleStart, tzHint) : null;
    row.cycleStartEpochMs = startParsed ? startParsed.epochMs : null;

    if (kind === 'cycles') {
      row.recoveryScore = toNum(raw.recoveryScore);
      row.restingHr = toNum(raw.restingHr);
      row.hrvMs = toNum(raw.hrvMs);
      row.spo2 = toNum(raw.spo2);
      row.strain = toNum(raw.strain);
      row.maxHr = toNum(raw.maxHr);
      row.avgHr = toNum(raw.avgHr);
      Object.assign(row, canonicalizeTemp(raw.skinTemp, headerByField.skinTemp));
      Object.assign(row, canonicalizeEnergy(raw.energy, headerByField.energy));
    }
    return { row };
  }

  if (kind === 'workouts') {
    const startRaw = toStr(raw.start);
    const p = startRaw ? parseTimestamp(startRaw, tzHint) : null;
    if (!p) {
      return { error: startRaw ? 'unparseable workout start time' : 'missing workout start time' };
    }
    const date = ymdInTz(startRaw, WHOOP_TZ, tzHint);
    if (!date) return { error: 'unparseable workout start time' };
    const endRaw = toStr(raw.end);
    const pe = endRaw ? parseTimestamp(endRaw, tzHint) : null;
    const energy = canonicalizeEnergy(raw.energy, headerByField.energy);
    return {
      row: {
        date,
        startedAt: p.iso || p.localYmd,
        endedAt: pe ? (pe.iso || pe.localYmd) : null,
        durationMin: toNum(raw.durationMin),
        activity: toStr(raw.activity),
        strain: toNum(raw.strain),
        energyKcal: energy.energyKcal,
        maxHr: toNum(raw.maxHr),
        avgHr: toNum(raw.avgHr),
        zones: {
          z1: toNum(raw.z1), z2: toNum(raw.z2), z3: toNum(raw.z3),
          z4: toNum(raw.z4), z5: toNum(raw.z5)
        }
      }
    };
  }

  // journal
  const startRaw = toStr(raw.cycleStart);
  const question = toStr(raw.question);
  if (!startRaw) return { error: 'missing cycle start time' };
  const p = parseTimestamp(startRaw, tzHint);
  if (!p) return { error: 'unparseable cycle start time' };
  if (!question) return { error: 'missing question text' };
  const rawAnswer = toStr(raw.answer);
  const bool = toBool(rawAnswer);
  return {
    row: {
      date: ymdInTz(startRaw, WHOOP_TZ, tzHint),
      cycleStartEpochMs: p.epochMs,
      question,
      answer: bool == null ? rawAnswer : bool,
      notes: toStr(raw.notes)
    }
  };
}

/** Sleep-stage / duration fields, shared by cycles and sleeps. */
function readSleepFields(raw, tzHint) {
  const asleep = toNum(raw.asleepMin);
  return {
    sleepOnset: toStr(raw.sleepOnset),
    wakeOnset: toStr(raw.wakeOnset),
    sleepMinutes: asleep,
    sleepHours: asleep == null ? null : round(asleep / 60, 2),
    inBedMin: toNum(raw.inBedMin),
    lightMin: toNum(raw.lightMin),
    deepMin: toNum(raw.deepMin),
    remMin: toNum(raw.remMin),
    awakeMin: toNum(raw.awakeMin),
    sleepNeedMin: toNum(raw.sleepNeedMin),
    sleepDebtMin: toNum(raw.sleepDebtMin),
    sleepEfficiencyPct: toNum(raw.sleepEfficiencyPct),
    sleepConsistencyPct: toNum(raw.sleepConsistencyPct),
    sleepPerformancePct: toNum(raw.sleepPerformancePct),
    respiratoryRate: toNum(raw.respiratoryRate),
    _tzHint: tzHint || null
  };
}

/* ------------------------------------------------------------------ *
 * 6. Export routing + day merge
 * ------------------------------------------------------------------ */

/** Route a ZIP entry name to a kind. Tolerant of folders, prefixes and case. */
function classifyFile(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!base || !/\.csv$/.test(base)) return null;
  const stem = base.replace(/\.csv$/, '');
  if (/physiolog|cycle/.test(stem)) return 'cycles';
  if (/sleep|nap/.test(stem)) return 'sleeps';
  if (/workout|activit|exercis/.test(stem)) return 'workouts';
  if (/journal|behavio/.test(stem)) return 'journal';
  return null;
}

/** Empty canonical day record — every metric starts as null (never 0). */
function emptyDay(date) {
  return {
    date,
    source: 'whoop',
    recoveryScore: null,
    hrvMs: null,
    restingHr: null,
    spo2: null,
    skinTempC: null,
    skinTempRaw: null,
    skinTempUnit: null,
    strain: null,
    energyKcal: null,
    maxHr: null,
    avgHr: null,
    sleepHours: null,
    sleepMinutes: null,
    sleepPerformancePct: null,
    sleepNeedMin: null,
    sleepDebtMin: null,
    sleepEfficiencyPct: null,
    sleepConsistencyPct: null,
    remMin: null,
    deepMin: null,
    lightMin: null,
    awakeMin: null,
    napMinutes: 0,
    respiratoryRate: null
  };
}

const SLEEP_DAY_FIELDS = [
  'sleepHours', 'sleepMinutes', 'sleepPerformancePct', 'sleepNeedMin', 'sleepDebtMin',
  'sleepEfficiencyPct', 'sleepConsistencyPct', 'remMin', 'deepMin', 'lightMin',
  'awakeMin', 'respiratoryRate'
];
const CYCLE_DAY_FIELDS = [
  'recoveryScore', 'hrvMs', 'restingHr', 'spo2', 'skinTempC', 'skinTempRaw',
  'skinTempUnit', 'strain', 'energyKcal', 'maxHr', 'avgHr'
];

/** Longer sleep wins a same-date collision; a null duration always loses. */
function longerSleep(a, b) {
  const av = a && a.sleepMinutes != null ? a.sleepMinutes : -1;
  const bv = b && b.sleepMinutes != null ? b.sleepMinutes : -1;
  return bv > av ? b : a;
}

/**
 * Parse a full Whoop export.
 *
 * @param {{files: Array<{name:string, text:string}>}} input
 * @returns {{days:Object[], workouts:Object[], journal:Object[], summary:Object, rejected:Object[]}}
 */
function parseWhoopExport(input) {
  const files = (input && Array.isArray(input.files) ? input.files : []).filter(Boolean);

  const filesSeen = [];
  const rejected = [];
  const unknownColumns = [];
  const duplicates = [];
  const notes = [];
  let rowsParsed = 0;
  let rowsRejected = 0;

  const byKind = { cycles: [], sleeps: [], workouts: [], journal: [] };

  // Deterministic order: cycles first (they seed the day records and the
  // cycle-start -> attributed-date index that journal entries reuse).
  const ordered = [];
  KINDS.forEach((k) => {
    files.forEach((f) => { if (classifyFile(f && f.name) === k) ordered.push({ f, kind: k }); });
  });
  files.forEach((f) => { if (!classifyFile(f && f.name)) ordered.push({ f, kind: null }); });

  ordered.forEach(({ f, kind }) => {
    const name = String((f && f.name) || '');
    if (!kind) {
      filesSeen.push({ name, kind: null, rowsParsed: 0, rowsRejected: 0 });
      notes.push(`Unrecognised file skipped: ${name}`);
      return;
    }
    const res = parseWhoopCsv(f.text, kind, { file: name });
    filesSeen.push({ name, kind, rowsParsed: res.rowsParsed, rowsRejected: res.rowsRejected });
    rowsParsed += res.rowsParsed;
    rowsRejected += res.rowsRejected;
    res.rejected.forEach((r) => rejected.push(r));
    res.unknownColumns.forEach((col) => {
      if (!unknownColumns.some((u) => u.file === name && u.column === col)) {
        unknownColumns.push({ file: name, kind, column: col });
      }
    });
    byKind[kind] = byKind[kind].concat(res.rows);
  });

  /* ---- days ---- */
  const dayMap = new Map();
  function dayFor(date) {
    if (!dayMap.has(date)) dayMap.set(date, emptyDay(date));
    return dayMap.get(date);
  }

  // Cycles: one winner per date.
  const cyclesByDate = new Map();
  byKind.cycles.forEach((r) => {
    const prev = cyclesByDate.get(r.date);
    if (!prev) { cyclesByDate.set(r.date, r); return; }
    const win = longerSleep(prev, r);
    const lose = win === prev ? r : prev;
    cyclesByDate.set(r.date, win);
    duplicates.push({
      date: r.date,
      kind: 'cycles',
      keptRowNumber: win._rowNumber,
      droppedRowNumber: lose._rowNumber,
      reason: 'two cycles map to one date; kept the one with the longer sleep',
      keptSleepMinutes: win.sleepMinutes,
      droppedSleepMinutes: lose.sleepMinutes
    });
  });
  cyclesByDate.forEach((r, date) => {
    const d = dayFor(date);
    CYCLE_DAY_FIELDS.forEach((k) => { if (r[k] !== undefined) d[k] = r[k]; });
    SLEEP_DAY_FIELDS.forEach((k) => { if (r[k] !== undefined) d[k] = r[k]; });
  });

  // Sleeps: naps accumulate separately and NEVER touch nightly sleep.
  const nightlyByDate = new Map();
  byKind.sleeps.forEach((r) => {
    const d = dayFor(r.date);
    if (r.isNap) {
      if (r.sleepMinutes != null) d.napMinutes += r.sleepMinutes;
      return;
    }
    const prev = nightlyByDate.get(r.date);
    if (!prev) { nightlyByDate.set(r.date, r); return; }
    const win = longerSleep(prev, r);
    const lose = win === prev ? r : prev;
    nightlyByDate.set(r.date, win);
    duplicates.push({
      date: r.date,
      kind: 'sleeps',
      keptRowNumber: win._rowNumber,
      droppedRowNumber: lose._rowNumber,
      reason: 'two nightly sleeps map to one date; kept the longer one',
      keptSleepMinutes: win.sleepMinutes,
      droppedSleepMinutes: lose.sleepMinutes
    });
  });
  // sleeps.csv only fills gaps — a cycle row is the authority for its date.
  nightlyByDate.forEach((r, date) => {
    const d = dayFor(date);
    SLEEP_DAY_FIELDS.forEach((k) => {
      if (d[k] == null && r[k] !== undefined && r[k] !== null) d[k] = r[k];
    });
  });

  const days = Array.from(dayMap.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  days.forEach((d) => { d.napMinutes = round(d.napMinutes, 2); });

  /* ---- workouts ---- */
  const workouts = byKind.workouts
    .map((w) => ({
      date: w.date,
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      durationMin: w.durationMin,
      activity: w.activity,
      strain: w.strain,
      energyKcal: w.energyKcal,
      maxHr: w.maxHr,
      avgHr: w.avgHr,
      zones: w.zones
    }))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));

  /* ---- journal ---- */
  // Journal rows carry the CYCLE start time; re-attribute them to the same
  // calendar date the cycle landed on (wake date), so they line up with `days`.
  const cycleDateByStart = new Map();
  byKind.cycles.forEach((r) => {
    if (r.cycleStartEpochMs != null) cycleDateByStart.set(r.cycleStartEpochMs, r.date);
  });
  let journalUnmatched = 0;
  const journal = byKind.journal.map((j) => {
    let date = j.date;
    if (j.cycleStartEpochMs != null && cycleDateByStart.has(j.cycleStartEpochMs)) {
      date = cycleDateByStart.get(j.cycleStartEpochMs);
    } else {
      journalUnmatched += 1;
    }
    return { date, question: j.question, answer: j.answer, notes: j.notes };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (journalUnmatched) {
    notes.push(`${journalUnmatched} journal row(s) had no matching cycle; dated by their own cycle start time.`);
  }

  /* ---- summary ---- */
  const allDates = []
    .concat(days.map((d) => d.date))
    .concat(workouts.map((w) => w.date))
    .concat(journal.map((j) => j.date))
    .filter(Boolean)
    .sort();

  return {
    days,
    workouts,
    journal,
    summary: {
      filesSeen,
      rowsParsed,
      rowsRejected,
      dateRange: { from: allDates[0] || null, to: allDates[allDates.length - 1] || null },
      unknownColumns,
      duplicates,
      notes,
      timezone: WHOOP_TZ
    },
    rejected
  };
}

module.exports = {
  parseWhoopCsv,
  parseWhoopExport,
  // helpers exported for tests / reuse
  parseCsv,
  normalizeHeaderKey,
  parseTimestamp,
  parseOffsetMinutes,
  ymdInTz,
  toNum,
  toBool,
  canonicalizeTemp,
  canonicalizeEnergy,
  classifyFile,
  WHOOP_TZ
};
