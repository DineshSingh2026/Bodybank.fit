'use strict';

/**
 * Samsung Health adapter — legacy CSV export, with an honest dead end.
 *
 * ── Read this before trusting anything below ─────────────────────────────────
 *
 * Samsung has been closing this door for years:
 *
 *   - The in-app "Download personal data" / "Export data" flow that produced a
 *     ZIP of `com.samsung.*.csv` files has been REMOVED OR RESTRICTED in most
 *     regions. Many members simply cannot produce this file at all.
 *   - The Samsung Health Data SDK (the supported replacement) is PARTNER-GATED:
 *     it requires an approved Samsung developer partnership per app. BodyBank
 *     does not have one, and applying for one is a business decision, not a
 *     parsing problem.
 *   - Where the export still exists, its column names are internal package
 *     identifiers that have changed shape at least twice across app versions.
 *
 * The practical route for a Samsung Galaxy Watch member on Android is therefore
 * HEALTH CONNECT, which Samsung Health writes into and which we read through
 * `services/wearables/adapters/healthConnect.js`. This module exists so that a
 * member who DOES still have a legacy export gets their history in, and so that
 * every member who does not gets a clear instruction instead of a silent zero.
 *
 * That second job is the important one. When this adapter cannot read the input
 * it returns `emptyParsedExport` with a note steering the member to Health
 * Connect. It never throws, and it never reports "0 days" as though that were
 * the member's actual data.
 *
 * ── Uncertainty ──────────────────────────────────────────────────────────────
 *
 * Every mapping below is marked `// UNVERIFIED:` where I could not confirm it
 * against a real export. Unknown columns are surfaced in
 * `summary.unknownColumns`, never guessed into a canonical field.
 *
 * @module services/wearables/adapters/samsungHealth
 */

const { parseCsv, parseTimestamp, ymdInTz, toNum, WHOOP_TZ } = require('../whoopParser');
const C = require('../canonicalDay');

const PROVIDER = 'samsung_health';

/**
 * A legacy export from a discontinued flow, with column names we could not
 * verify, is materially weaker evidence than a current vendor export.
 */
const SAMSUNG_CSV_CONFIDENCE = 0.65;

/** The steer every failure path ends with. */
const HEALTH_CONNECT_STEER =
  'Samsung removed the personal-data export in most regions and its Health Data '
  + 'SDK is partner-gated, so we cannot read a Galaxy Watch directly. Connect '
  + 'Samsung Health to Health Connect on your phone and sync through the BodyBank '
  + 'app instead — that path carries the same sleep, heart-rate and step data.';

/* ------------------------------------------------------------------ *
 * Column normalisation
 * ------------------------------------------------------------------ */

/**
 * Samsung's headers are fully-qualified package identifiers:
 *   `com.samsung.health.sleep.start_time`
 *   `com.samsung.shealth.tracker.pedometer_day_summary.step_count`
 * Strip the package prefix, then reduce to alphanumerics the way whoopParser's
 * `normalizeHeaderKey` does, so a version that drops or adds a path segment
 * still matches.
 *
 * UNVERIFIED: exact prefixes. A real export would confirm whether the current
 * app writes `com.samsung.health.` or `com.samsung.shealth.` for each table.
 */
function normalizeSamsungHeader(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/^com\.samsung\.(s?health)\./, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Canonical key -> the normalised header spellings that map to it.
 *
 * UNVERIFIED, all of it. These are the spellings reported by community tooling
 * around the Samsung Health export; a real ZIP from a current Galaxy Watch would
 * confirm them and would very likely add more. Anything not listed here is
 * reported through `summary.unknownColumns` rather than being read by position.
 */
const SLEEP_ALIASES = {
  startTime: ['sleepstarttime', 'starttime', 'sleepstart', 'bedtime', 'sleepstartdatetime'],
  endTime: ['sleependtime', 'endtime', 'sleepend', 'waketime', 'wakeuptime', 'sleependdatetime'],
  timeOffset: ['timeoffset', 'sleeptimeoffset', 'utcoffset'],
  sleepMinutes: ['sleepduration', 'sleepdurationmin', 'totalsleepduration', 'sleepsleepduration'],
  efficiencyPct: ['efficiency', 'sleepefficiency', 'sleepsleepefficiency'],
  sleepScore: ['sleepscore', 'score', 'sleepsleepscore'],
  remMin: ['remduration', 'remsleepduration', 'sleepremduration'],
  deepMin: ['deepduration', 'deepsleepduration', 'sleepdeepduration'],
  lightMin: ['lightduration', 'lightsleepduration', 'sleeplightduration'],
  awakeMin: ['awakeduration', 'awakesleepduration', 'sleepawakeduration'],
  mentalRecovery: ['mentalrecovery', 'sleepmentalrecovery'],
  physicalRecovery: ['physicalrecovery', 'sleepphysicalrecovery']
};

const STEP_ALIASES = {
  dayTime: ['daytime', 'day', 'date', 'createtime', 'starttime'],
  steps: ['stepcount', 'count', 'totalstep', 'steps', 'pedometerdaysummarycount'],
  energyKcal: ['calorie', 'calories', 'activecalorie', 'pedometerdaysummarycalorie'],
  activeMinutes: ['activetime', 'activeminute', 'walkingtime', 'runtime']
};

const HR_ALIASES = {
  startTime: ['starttime', 'createtime', 'heartratestarttime'],
  timeOffset: ['timeoffset', 'utcoffset', 'heartratetimeoffset'],
  heartRate: ['heartrate', 'heartrateheartrate', 'rate'],
  min: ['heartratemin', 'min'],
  max: ['heartratemax', 'max'],
  restingHr: ['restingheartrate', 'resting'],
  spo2: ['spo2', 'oxygensaturation', 'bloodoxygen']
};

function invert(table) {
  const out = Object.create(null);
  Object.keys(table).forEach((canon) => {
    table[canon].forEach((alias) => { if (!(alias in out)) out[alias] = canon; });
  });
  return out;
}

const ALIAS_INDEX = {
  sleep: invert(SLEEP_ALIASES),
  steps: invert(STEP_ALIASES),
  heart: invert(HR_ALIASES)
};

/**
 * Route a file name to a table.
 *
 * UNVERIFIED: real names look like
 * `com.samsung.shealth.sleep.20240117093012.csv`. Matching on the table word
 * rather than the whole name keeps this working if the timestamp format or the
 * package path changes.
 */
function classifyFile(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!base || !/\.csv$/.test(base)) return null;
  if (/sleep_stage|sleep_combined/.test(base)) return 'sleepStage';
  if (/sleep/.test(base)) return 'sleep';
  if (/pedometer|step/.test(base)) return 'steps';
  if (/heart_rate|heartrate|hrm/.test(base)) return 'heart';
  return null;
}

/* ------------------------------------------------------------------ *
 * CSV shape
 * ------------------------------------------------------------------ */

/**
 * Samsung prefixes each CSV with a one-line metadata row
 * (`com.samsung.shealth.sleep,16,`) before the real header. Find the header by
 * looking for the first row that actually contains a column we recognise —
 * positional assumptions about "line 2" break the moment Samsung adds a line.
 *
 * @returns {{headerLine:number, fields:(string|null)[], headers:string[], unknown:string[]}|null}
 */
function locateHeader(table, index) {
  for (let i = 0; i < Math.min(table.length, 5); i += 1) {
    const cells = table[i];
    if (!cells || cells.length < 2) continue;
    const headers = cells.map((h) => String(h == null ? '' : h).trim());
    const fields = headers.map((h) => {
      const key = normalizeSamsungHeader(h);
      return key ? (index[key] || null) : null;
    });
    if (fields.filter(Boolean).length >= 2) {
      const unknown = [];
      headers.forEach((h, c) => { if (!fields[c] && h) unknown.push(h); });
      return { headerLine: i, fields, headers, unknown };
    }
  }
  return null;
}

function rowMap(cells, fields) {
  const raw = Object.create(null);
  for (let c = 0; c < fields.length; c += 1) {
    const f = fields[c];
    if (!f) continue;
    const v = c < cells.length ? String(cells[c] == null ? '' : cells[c]).trim() : '';
    if (raw[f] === undefined || raw[f] === '') raw[f] = v;
  }
  return raw;
}

function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Samsung writes durations inconsistently: some tables in minutes, some in
 * milliseconds, some in seconds.
 *
 * UNVERIFIED: which unit each column uses. Rather than guess, the magnitude
 * decides — nothing above 1440 can be minutes of sleep, and nothing above 86400
 * can be seconds of it. A value we cannot place is returned as null, not scaled
 * by a hopeful constant.
 */
function durationToMinutes(value) {
  const n = toNum(value);
  if (n === null) return null;
  if (n < 0) return null;
  if (n <= 1440) return n;                 // already minutes
  if (n <= 86400) return round(n / 60, 1); // seconds
  if (n <= 86400000) return round(n / 60000, 1); // milliseconds
  return null;
}

/* ------------------------------------------------------------------ *
 * Parse
 * ------------------------------------------------------------------ */

/**
 * Parse a legacy Samsung Health CSV export.
 *
 * @param {{files:Array<{name:string,text:string}>}|Array} input
 * @param {{timezone?:string}} [opts]
 * @returns {{days:Object[], workouts:Object[], journal:Object[], summary:Object, rejected:Object[]}}
 */
function parse(input, opts) {
  const options = opts || {};
  const tz = options.timezone || WHOOP_TZ;

  let files;
  if (Array.isArray(input)) files = input;
  else if (input && Array.isArray(input.files)) files = input.files;
  else files = [];
  // adapterRegistry hands adapters [{name,text}] and/or [{name,buffer}].
  files = files
    .filter(Boolean)
    .map((f) => (typeof f.text === 'string'
      ? f
      : (f.buffer && typeof f.buffer.toString === 'function'
        ? { name: f.name, text: f.buffer.toString('utf8') }
        : null)))
    .filter((f) => f && typeof f.text === 'string');

  if (!files.length) {
    return C.emptyParsedExport(PROVIDER, [
      'No Samsung Health CSV was found in this upload.', HEALTH_CONNECT_STEER
    ]);
  }

  const filesSeen = [];
  const unknownColumns = [];
  const rejected = [];
  const implausible = [];
  const notes = [];
  const buckets = new Map(); // date -> accumulator
  let rowsParsed = 0;
  let rowsRejected = 0;
  let readable = 0;

  function note(t) { if (notes.indexOf(t) === -1) notes.push(t); }
  function reject(file, rowNumber, reason, raw) {
    rowsRejected += 1;
    if (rejected.length < 200) rejected.push({ file, rowNumber, reason, raw: raw || null });
  }
  function bucket(date) {
    let b = buckets.get(date);
    if (!b) {
      b = {
        date,
        sleep: null,            // the winning night
        napMinutes: 0,
        steps: null,
        energyKcal: null,
        activeMinutes: null,
        hr: [],
        hrMax: null,
        restingHr: [],
        spo2: [],
        providerScores: {}
      };
      buckets.set(date, b);
    }
    return b;
  }

  /**
   * Samsung timestamps come as `2024-01-17 09:30:12.000` with the UTC offset in a
   * SEPARATE `time_offset` column (`UTC+0530`). Feeding both to whoopParser's
   * parseTimestamp reproduces exactly the tz-hint behaviour the Whoop cycles use.
   */
  function attribute(value, offset) {
    if (!value) return null;
    return ymdInTz(String(value).replace(/\.\d+$/, ''), tz, offset || null);
  }
  /**
   * The pedometer day summary's `day_time` column.
   *
   * UNVERIFIED: this column has appeared both as an epoch-millisecond integer and
   * as a printed date string across app versions, so both are accepted. A bare
   * 13-digit integer cannot be anything but epoch ms, and a date string cannot be
   * mistaken for one, so the two cannot be confused.
   */
  function attributeDay(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return null;
    if (/^\d{12,14}$/.test(s)) {
      const ms = Number(s);
      if (!Number.isFinite(ms)) return null;
      return ymdInTz(new Date(ms).toISOString(), tz);
    }
    return attribute(s, null);
  }

  function instant(value, offset) {
    if (!value) return null;
    const p = parseTimestamp(String(value).replace(/\.\d+$/, ''), offset || null);
    return p && p.epochMs != null ? p.epochMs : null;
  }

  files.forEach((f) => {
    const name = String(f.name || 'samsung.csv');
    const kind = classifyFile(name);
    if (!kind) {
      filesSeen.push({ name, kind: null, rowsParsed: 0, rowsRejected: 0 });
      note('Unrecognised file skipped: ' + name);
      return;
    }
    const indexKind = kind === 'sleepStage' ? 'sleep' : kind;
    const table = parseCsv(f.text);
    const head = locateHeader(table, ALIAS_INDEX[indexKind]);
    if (!head) {
      filesSeen.push({ name, kind, rowsParsed: 0, rowsRejected: 0 });
      note('Could not find a recognisable header row in ' + name
        + '. Samsung has changed this export format more than once; the columns '
        + 'are reported in summary.unknownColumns rather than read by position.');
      (table[0] || []).forEach((h) => {
        const t = String(h || '').trim();
        if (t && !unknownColumns.some((u) => u.file === name && u.column === t)) {
          unknownColumns.push({ file: name, kind, column: t });
        }
      });
      return;
    }
    head.unknown.forEach((col) => {
      if (!unknownColumns.some((u) => u.file === name && u.column === col)) {
        unknownColumns.push({ file: name, kind, column: col });
      }
    });

    let parsedHere = 0;
    let rejectedHere = 0;

    for (let i = head.headerLine + 1; i < table.length; i += 1) {
      const cells = table[i];
      if (!cells || cells.every((c) => String(c == null ? '' : c).trim() === '')) continue;
      const raw = rowMap(cells, head.fields);
      const rowNumber = i + 1;

      if (indexKind === 'sleep') {
        // Rule 2: attribute to the WAKE date.
        const date = attribute(raw.endTime, raw.timeOffset);
        if (!date) {
          reject(name, rowNumber, raw.endTime
            ? 'unparseable sleep end time' : 'missing sleep end time (cannot attribute a date)',
          cells.slice());
          rejectedHere += 1;
          continue;
        }
        let mins = durationToMinutes(raw.sleepMinutes);
        const startMs = instant(raw.startTime, raw.timeOffset);
        const endMs = instant(raw.endTime, raw.timeOffset);
        if (mins === null && startMs !== null && endMs !== null && endMs > startMs) {
          mins = round((endMs - startMs) / 60000, 1);
        }
        if (mins === null) {
          reject(name, rowNumber, 'sleep row has no readable duration', cells.slice());
          rejectedHere += 1;
          continue;
        }

        // Rule 3: a short daytime sleep is a nap and must not become the night.
        let isNap = false;
        if (startMs !== null && mins < 180) {
          const hour = hourInTz(startMs, tz);
          if (hour !== null && hour >= 8 && hour < 20) isNap = true;
        }
        const b = bucket(date);
        if (isNap) {
          b.napMinutes += mins;
        } else {
          const cand = {
            sleepMinutes: mins,
            remMin: durationToMinutes(raw.remMin),
            deepMin: durationToMinutes(raw.deepMin),
            lightMin: durationToMinutes(raw.lightMin),
            awakeMin: durationToMinutes(raw.awakeMin),
            efficiencyPct: toNum(raw.efficiencyPct),
            sleepScore: toNum(raw.sleepScore)
          };
          if (!b.sleep) b.sleep = cand;
          else if (cand.sleepMinutes > b.sleep.sleepMinutes) {
            b.napMinutes += b.sleep.sleepMinutes;
            b.sleep = cand;
          } else {
            b.napMinutes += cand.sleepMinutes;
          }
        }
        parsedHere += 1;
        continue;
      }

      if (indexKind === 'steps') {
        const date = attributeDay(raw.dayTime);
        if (!date) {
          reject(name, rowNumber, 'unparseable day for a step summary row', cells.slice());
          rejectedHere += 1;
          continue;
        }
        const b = bucket(date);
        const steps = toNum(raw.steps);
        if (steps !== null) b.steps = (b.steps || 0) + steps;
        const kcal = toNum(raw.energyKcal);
        if (kcal !== null) b.energyKcal = (b.energyKcal || 0) + kcal;
        const am = durationToMinutes(raw.activeMinutes);
        if (am !== null) b.activeMinutes = (b.activeMinutes || 0) + am;
        parsedHere += 1;
        continue;
      }

      // heart
      const date = attribute(raw.startTime, raw.timeOffset);
      if (!date) {
        reject(name, rowNumber, 'unparseable heart-rate timestamp', cells.slice());
        rejectedHere += 1;
        continue;
      }
      const b = bucket(date);
      // Keep the average and the maximum apart: folding a row's `max` into the
      // sample list used for the mean drags the day's average heart rate upward.
      const hr = toNum(raw.heartRate);
      if (hr !== null) {
        b.hr.push(hr);
        if (b.hrMax === null || hr > b.hrMax) b.hrMax = hr;
      }
      const mx = toNum(raw.max);
      if (mx !== null && (b.hrMax === null || mx > b.hrMax)) b.hrMax = mx;
      const rhr = toNum(raw.restingHr);
      if (rhr !== null) b.restingHr.push(rhr);
      const ox = toNum(raw.spo2);
      if (ox !== null) b.spo2.push(ox);
      parsedHere += 1;
    }

    rowsParsed += parsedHere;
    // NOTE: rowsRejected is incremented by reject() itself; adding rejectedHere
    // here as well would double-count every rejection in the summary.
    if (parsedHere > 0) readable += 1;
    filesSeen.push({ name, kind, rowsParsed: parsedHere, rowsRejected: rejectedHere });
  });

  if (!readable) {
    const empty = C.emptyParsedExport(PROVIDER, notes.concat([
      'None of the uploaded files could be read as a Samsung Health export.',
      HEALTH_CONNECT_STEER
    ]));
    empty.summary.filesSeen = filesSeen;
    empty.summary.unknownColumns = unknownColumns;
    empty.summary.rowsRejected = rowsRejected;
    empty.rejected = rejected;
    empty.summary.timezone = tz;
    return empty;
  }

  /* ---- to canonical days ---- */
  function set(day, field, value) {
    if (value === null || value === undefined || !Number.isFinite(value)) { day[field] = null; return; }
    const range = C.SANITY[field];
    if (range && ((range[0] !== null && value < range[0]) || (range[1] !== null && value > range[1]))) {
      implausible.push({ date: day.date, field, value, range, reason: 'outside the plausible range; nulled' });
      day[field] = null;
      return;
    }
    day[field] = value;
  }

  const days = Array.from(buckets.keys()).sort().map((date) => {
    const b = buckets.get(date);
    const day = C.emptyCanonicalDay(date, PROVIDER);
    day.measurementSource = C.MEASUREMENT_SOURCE.DEVICE_EXPORT;
    day.confidence = SAMSUNG_CSV_CONFIDENCE;
    day.deviceModel = options.deviceModel || null;

    if (b.sleep) {
      set(day, 'sleepMinutes', round(b.sleep.sleepMinutes, 1));
      if (day.sleepMinutes !== null) {
        set(day, 'sleepHours', round(day.sleepMinutes / 60, 2));
        set(day, 'remMin', b.sleep.remMin);
        set(day, 'deepMin', b.sleep.deepMin);
        set(day, 'lightMin', b.sleep.lightMin);
        set(day, 'awakeMin', b.sleep.awakeMin);
        set(day, 'sleepEfficiencyPct', b.sleep.efficiencyPct);
        const stageSum = (day.remMin || 0) + (day.deepMin || 0) + (day.lightMin || 0);
        if (stageSum > day.sleepMinutes * 1.03 + 1) {
          note('Sleep stages on ' + date + ' exceeded the night; breakdown dropped '
            + '(the duration units in this export could not be confirmed).');
          day.remMin = null; day.deepMin = null; day.lightMin = null;
        }
      }
      // Samsung's Sleep Score is device-native and NOT comparable with Whoop's
      // sleep performance or Oura's sleep score. It never touches a canonical field.
      if (b.sleep.sleepScore !== null && b.sleep.sleepScore !== undefined) {
        day.providerScores['samsung.sleep_score'] = b.sleep.sleepScore;
      }
    }
    set(day, 'napMinutes', round(b.napMinutes, 1));
    if (day.napMinutes === null) day.napMinutes = 0;

    set(day, 'steps', b.steps === null ? null : round(b.steps, 0));
    set(day, 'energyKcal', b.energyKcal === null ? null : round(b.energyKcal, 1));
    set(day, 'activeMinutes', b.activeMinutes === null ? null : round(b.activeMinutes, 0));

    if (b.hr.length) {
      const sum = b.hr.reduce((a, x) => a + x, 0);
      set(day, 'avgHr', round(sum / b.hr.length, 1));
    }
    if (b.hrMax !== null) set(day, 'maxHr', round(b.hrMax, 0));
    if (b.restingHr.length) {
      const sum = b.restingHr.reduce((a, x) => a + x, 0);
      set(day, 'restingHr', round(sum / b.restingHr.length, 1));
    }
    if (b.spo2.length) {
      const sum = b.spo2.reduce((a, x) => a + x, 0);
      set(day, 'spo2', round(sum / b.spo2.length, 1));
    }

    // The legacy export carries NO HRV, NO skin temperature, NO recovery and NO
    // strain. Every one of those stays null. `hrvMethod` therefore also stays
    // null, which is correct: there is no HRV to tag.
    day.hrvMs = null;
    day.hrvMethod = null;
    day.recoveryScore = null;
    day.readinessScore = null;
    day.strain = null;

    return day;
  });

  note('Read from a legacy Samsung Health CSV export. Column meanings in this '
    + 'format are unverified against a current export; anything unrecognised is '
    + 'listed in summary.unknownColumns. ' + HEALTH_CONNECT_STEER);

  const out = {
    days,
    workouts: [],
    journal: [],
    summary: {
      provider: PROVIDER,
      filesSeen,
      rowsParsed,
      rowsRejected,
      dateRange: {
        from: days.length ? days[0].date : null,
        to: days.length ? days[days.length - 1].date : null
      },
      unknownColumns,
      duplicates: [],
      implausible,
      notes,
      timezone: tz
    },
    rejected
  };

  const check = C.validateParsedExport(out);
  if (!check.ok) {
    out.summary.notes = out.summary.notes.concat(
      check.errors.slice(0, 20).map((e) => 'contract: ' + e)
    );
    out.summary.contractViolations = check.errors.length;
  }
  return out;
}

/** Local hour of an instant, for the nap heuristic. */
function hourInTz(epochMs, tz) {
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || WHOOP_TZ, hour: '2-digit', hourCycle: 'h23'
    }).format(new Date(epochMs));
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return new Date(epochMs).getUTCHours();
  }
}

/* ------------------------------------------------------------------ *
 * INTEGRATION NOTE
 * ------------------------------------------------------------------ */
/*
 * INTEGRATION NOTE (member-facing copy):
 *   The upload UI should NOT offer "Samsung Health" as a first-class export
 *   option. Offer "Samsung / Galaxy Watch" and route it to the Health Connect
 *   native sync, with the legacy CSV upload as a secondary "I already have an
 *   old export" path. HEALTH_CONNECT_STEER (exported below) is the exact wording
 *   to show when this adapter reads nothing.
 *
 * INTEGRATION NOTE (deviceRegistry):
 *   Register 'samsung_health' with confidence prior 0.65, hasHrv FALSE,
 *   hasRecovery false, hasStrain false. A member on this path has no HRV series
 *   at all, which the readiness engine must handle rather than treat as a gap.
 */

module.exports = {
  parse,
  classifyFile,
  normalizeSamsungHeader,
  durationToMinutes,
  locateHeader,
  PROVIDER,
  SAMSUNG_CSV_CONFIDENCE,
  HEALTH_CONNECT_STEER,
  ALIAS_INDEX
};
