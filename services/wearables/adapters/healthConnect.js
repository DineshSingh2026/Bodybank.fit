'use strict';

/**
 * Health Connect adapter — the server side of the native Android bridge.
 *
 * Health Connect is the practical route to almost every Android-side wearable:
 * Samsung Galaxy Watch, Amazfit/Zepp, Fitbit's Android app, Garmin Connect, Mi
 * Band, Oura's Android app and Google Fit all write into it. Rather than build a
 * separate adapter per brand — each with its own export format, most of which are
 * being withdrawn — we read the one API they all feed.
 *
 * ── Division of labour ───────────────────────────────────────────────────────
 *
 * The Health Connect READ happens in the `bodybank-app` Capacitor project, not
 * here. That app holds the permissions, does the aggregation, and POSTs the
 * result. THIS module is the server-side contract: it validates that payload
 * ruthlessly and turns it into canonical days.
 *
 * The payload schema is specified for the mobile team in
 * `docs/NATIVE_HEALTH_BRIDGE.md`. Keep the two in sync: SCHEMA_VERSIONS here is
 * the authority on what the server will accept.
 *
 * ── Why the validation is so unforgiving ─────────────────────────────────────
 *
 * Everything in this payload is client-supplied. A rooted phone, a buggy app
 * build, or a member with a broken third-party tracker can send any number at
 * all. So:
 *   - an unknown `schemaVersion` is REFUSED outright, never best-effort parsed:
 *     a v2 payload read with v1 rules would silently mean something else;
 *   - every number goes through `canonicalDay.SANITY` and is NULLED (and
 *     reported) if implausible — never clamped, never trusted;
 *   - `hrvMethod` is REQUIRED to be stated by the client. Health Connect's
 *     `HeartRateVariabilityRmssdRecord` is RMSSD, but whether it came from a
 *     sleep session or a 60-second spot check is knowable only on the device,
 *     and the difference is exactly the trap that Apple's SDNN illustrates. We
 *     do not guess: an unstated method becomes HRV_METHOD.UNKNOWN, which keeps
 *     the value out of any cross-device comparison.
 *
 * @module services/wearables/adapters/healthConnect
 */

const { parseTimestamp, ymdInTz, WHOOP_TZ } = require('../whoopParser');
const C = require('../canonicalDay');

const PROVIDER = 'health_connect';

/**
 * Payload schema versions this server understands. ADD to this array; never
 * silently reinterpret an old version. The mobile app sends the version it was
 * built against, so an old app keeps working after a server deploy.
 */
const SCHEMA_VERSIONS = [1];

/**
 * An in-app read is weaker evidence than a vendor's own export: we get whatever
 * the OS chose to surface, filtered through permissions the member may have
 * granted only partially, aggregated by our own client code.
 */
const HEALTH_CONNECT_CONFIDENCE = 0.8;

/** Hard ceiling on days in one payload — roughly three years. */
const MAX_DAYS = 1200;

/* ------------------------------------------------------------------ *
 * Payload field mapping (rule 1: an explicit table, never positional)
 * ------------------------------------------------------------------ */

/**
 * payload day key -> canonical field. The client sends verbose, unit-suffixed
 * names on purpose: `restingHeartRateBpm`, not `rhr`. A unit in the name is a
 * unit we can check, and a name we did not expect lands in `unknownColumns`
 * rather than being dropped or guessed at.
 */
const DAY_FIELD_MAP = {
  restingHeartRateBpm: 'restingHr',
  heartRateAvgBpm: 'avgHr',
  heartRateMaxBpm: 'maxHr',
  oxygenSaturationPct: 'spo2',
  respiratoryRateBrpm: 'respiratoryRate',
  steps: 'steps',
  exerciseMinutes: 'activeMinutes'
};

/** Keys handled by dedicated logic below, so they are not "unknown". */
const HANDLED_DAY_KEYS = new Set([
  'date', 'hrv', 'skinTemperature', 'sleep', 'energy',
  'activeCaloriesKcal', 'totalCaloriesKcal', 'basalCaloriesKcal',
  'providerScores', 'deviceModel', 'originPackages', 'notes'
].concat(Object.keys(DAY_FIELD_MAP)));

/**
 * Client-declared HRV provenance -> canonical method tag.
 *
 * Health Connect exposes `HeartRateVariabilityRmssdRecord`, so the metric is
 * RMSSD. What the record does NOT say is the window it was measured over. The
 * client must state it; anything it cannot state is `unknown`.
 */
function resolveHrvMethod(hrv) {
  if (!hrv || typeof hrv !== 'object') return null;
  const metric = String(hrv.metric || 'rmssd').toLowerCase();
  const window = String(hrv.window || '').toLowerCase();
  if (metric === 'rmssd') {
    if (window === 'sleep' || window === 'sleep_session') return C.HRV_METHOD.RMSSD_SLEEP;
    if (window === 'spot' || window === 'instant' || window === 'manual') return C.HRV_METHOD.RMSSD_SPOT;
    return C.HRV_METHOD.UNKNOWN;
  }
  if (metric === 'sdnn') {
    if (window === 'sleep' || window === 'sleep_session') return C.HRV_METHOD.SDNN_SLEEP;
    if (window === 'spot' || window === 'instant' || window === 'manual') return C.HRV_METHOD.SDNN_SPOT;
    return C.HRV_METHOD.UNKNOWN;
  }
  // An HRV number whose statistic we do not know is not comparable with anything.
  return C.HRV_METHOD.UNKNOWN;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Accept a JSON number and NOTHING else. A numeric string from a client is a
 * symptom (a locale-formatted float, a "null" literal, a stringified NaN), so it
 * is reported rather than coerced.
 */
function jsonNum(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined; // undefined = malformed
}

function isYmd(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

/* ------------------------------------------------------------------ *
 * Parse
 * ------------------------------------------------------------------ */

/**
 * Parse a Health Connect bridge payload.
 *
 * @param {Object|string|{files:Array}} payload the POSTed JSON (object, raw JSON
 *        text, or the standard `{files:[{name,text}]}` upload envelope)
 * @param {{timezone?:string}} [opts]
 * @returns {{days:Object[], workouts:Object[], journal:Object[], summary:Object, rejected:Object[]}}
 */
function parse(payload, opts) {
  const options = opts || {};
  let body = payload;

  // Envelope tolerance: the shared upload route hands every adapter
  // {files:[{name,text}]}, so accept that as well as a bare object.
  if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.files)) {
    const f = body.files.find((x) => x && (typeof x.text === 'string'
      || (x.buffer && typeof x.buffer.toString === 'function')));
    body = f ? (typeof f.text === 'string' ? f.text : f.buffer.toString('utf8')) : null;
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return C.emptyParsedExport(PROVIDER, [
        'The Health Connect payload was not valid JSON: ' + e.message
      ]);
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return C.emptyParsedExport(PROVIDER, [
      'Expected a Health Connect bridge payload object; see docs/NATIVE_HEALTH_BRIDGE.md'
    ]);
  }

  /* ---- version gate: refuse, never improvise ---- */
  const version = body.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return C.emptyParsedExport(PROVIDER, [
      'Payload is missing a numeric `schemaVersion`. Supported: '
      + SCHEMA_VERSIONS.join(', ') + '.'
    ]);
  }
  if (SCHEMA_VERSIONS.indexOf(version) === -1) {
    return C.emptyParsedExport(PROVIDER, [
      'Unsupported Health Connect payload schemaVersion ' + version
      + '. This server understands ' + SCHEMA_VERSIONS.join(', ')
      + '. Refusing to guess at the meaning of an unknown schema — update the '
      + 'server, or have the app send a version it is listed above.'
    ]);
  }

  const tz = options.timezone || body.timezone || WHOOP_TZ;
  const device = body.device && typeof body.device === 'object' ? body.device : {};
  const deviceModel = [device.manufacturer, device.model]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean).join(' ') || null;

  const rawDays = Array.isArray(body.days) ? body.days : null;
  if (!rawDays) {
    return C.emptyParsedExport(PROVIDER, [
      'Payload has no `days` array. The client must send daily aggregates, not raw samples.'
    ]);
  }

  const notes = [];
  const rejected = [];
  const implausible = [];
  const unknownColumns = [];
  const byDate = new Map();
  let rowsRejected = 0;

  function note(t) { if (notes.indexOf(t) === -1) notes.push(t); }
  function reject(index, reason, raw) {
    rowsRejected += 1;
    if (rejected.length < 200) {
      rejected.push({ file: 'health-connect.json', rowNumber: index, reason, raw: raw || null });
    }
  }
  function unknown(key) {
    if (!unknownColumns.some((u) => u.column === key)) {
      unknownColumns.push({ file: 'health-connect.json', kind: 'payload-key', column: key });
    }
  }

  function set(day, field, value) {
    if (value === null || value === undefined || !Number.isFinite(value)) { day[field] = null; return; }
    const range = C.SANITY[field];
    if (range && ((range[0] !== null && value < range[0]) || (range[1] !== null && value > range[1]))) {
      implausible.push({
        date: day.date, field, value, range,
        reason: 'client-supplied value outside the plausible range; nulled rather than clamped'
      });
      day[field] = null;
      return;
    }
    day[field] = value;
  }

  if (rawDays.length > MAX_DAYS) {
    note('Payload carried ' + rawDays.length + ' days; only the most recent '
      + MAX_DAYS + ' were read.');
  }
  const slice = rawDays.slice(-MAX_DAYS);

  slice.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      reject(i, 'day entry is not an object', raw);
      return;
    }
    if (!isYmd(raw.date)) {
      reject(i, 'day entry has no valid `date` (YYYY-MM-DD)', raw);
      return;
    }
    if (byDate.has(raw.date)) {
      reject(i, 'duplicate date ' + raw.date + ' in payload; first occurrence kept', raw);
      return;
    }

    const day = C.emptyCanonicalDay(raw.date, PROVIDER);
    day.measurementSource = C.MEASUREMENT_SOURCE.NATIVE_SDK;
    day.deviceModel = typeof raw.deviceModel === 'string' && raw.deviceModel.trim()
      ? raw.deviceModel.trim() : deviceModel;
    day.confidence = HEALTH_CONNECT_CONFIDENCE;

    /* ---- flat numeric fields ---- */
    Object.keys(DAY_FIELD_MAP).forEach((key) => {
      if (!(key in raw)) return;
      const n = jsonNum(raw[key]);
      if (n === undefined) {
        reject(i, key + ' must be a JSON number or null, got ' + JSON.stringify(raw[key]), raw);
        return;
      }
      set(day, DAY_FIELD_MAP[key], n);
    });

    /* ---- HRV: the method must be stated, never inferred ---- */
    if (raw.hrv !== undefined && raw.hrv !== null) {
      const n = jsonNum(raw.hrv && raw.hrv.valueMs);
      if (n === undefined) {
        reject(i, 'hrv.valueMs must be a JSON number', raw.hrv);
      } else {
        set(day, 'hrvMs', n === null ? null : round(n, 1));
        if (day.hrvMs !== null) {
          const method = resolveHrvMethod(raw.hrv);
          day.hrvMethod = method || C.HRV_METHOD.UNKNOWN;
          if (day.hrvMethod === C.HRV_METHOD.UNKNOWN) {
            note('HRV on ' + raw.date + ' arrived without a stated metric/window and is '
              + 'tagged `unknown`; it will not be compared against other devices. '
              + 'Have the app send hrv.metric ("rmssd") and hrv.window ("sleep"|"spot").');
          }
        }
      }
    }

    /* ---- temperature: absolute and deviation are different numbers ---- */
    const t = raw.skinTemperature;
    if (t && typeof t === 'object') {
      const basis = String(t.basis || '').toLowerCase();
      const abs = jsonNum(t.valueC);
      const dev = jsonNum(t.deviationC);
      if (abs === undefined || dev === undefined) {
        reject(i, 'skinTemperature values must be JSON numbers', t);
      } else if (basis === 'absolute_c' && abs !== null) {
        set(day, 'skinTempC', round(abs, 2));
        if (day.skinTempC !== null) { day.tempBasis = C.TEMP_BASIS.ABSOLUTE_C; day.skinTempRaw = abs; day.skinTempUnit = 'C'; }
      } else if (basis === 'deviation_c' && dev !== null) {
        set(day, 'skinTempDeviationC', round(dev, 2));
        if (day.skinTempDeviationC !== null) { day.tempBasis = C.TEMP_BASIS.DEVIATION_C; day.skinTempRaw = dev; day.skinTempUnit = 'C'; }
      } else if (abs !== null || dev !== null) {
        // A temperature whose basis we do not know is unusable: -0.3 written into
        // skinTempC reads as hypothermia, 33.1 written into a deviation reads as
        // a fever of 33 degrees. Refuse both.
        reject(i, 'skinTemperature needs an explicit basis of "absolute_c" or "deviation_c"', t);
      }
    }

    /* ---- energy ---- */
    const active = jsonNum(raw.activeCaloriesKcal);
    const total = jsonNum(raw.totalCaloriesKcal);
    const basal = jsonNum(raw.basalCaloriesKcal);
    if (active === undefined || total === undefined || basal === undefined) {
      reject(i, 'calorie fields must be JSON numbers', raw);
    } else if (total !== null) {
      set(day, 'energyKcal', round(total, 1));
    } else if (active !== null || basal !== null) {
      set(day, 'energyKcal', round((active || 0) + (basal || 0), 1));
    }
    if (active !== null && active !== undefined) day.providerScores['health_connect.active_kcal'] = round(active, 1);

    /* ---- sleep (rules 2 and 3 are the CLIENT's job; we verify) ---- */
    const s = raw.sleep;
    if (s && typeof s === 'object') {
      const total2 = jsonNum(s.totalMinutes);
      if (total2 === undefined) {
        reject(i, 'sleep.totalMinutes must be a JSON number', s);
      } else if (total2 !== null) {
        set(day, 'sleepMinutes', round(total2, 1));
        if (day.sleepMinutes !== null) set(day, 'sleepHours', round(day.sleepMinutes / 60, 2));
      }
      const stage = (k, field) => {
        const n = jsonNum(s[k]);
        if (n === undefined) { reject(i, 'sleep.' + k + ' must be a JSON number', s); return; }
        if (n !== null) set(day, field, round(n, 1));
      };
      stage('remMinutes', 'remMin');
      stage('deepMinutes', 'deepMin');
      stage('lightMinutes', 'lightMin');
      stage('awakeMinutes', 'awakeMin');
      const nap = jsonNum(s.napMinutes);
      if (nap !== undefined && nap !== null) {
        set(day, 'napMinutes', round(nap, 1));
        if (day.napMinutes === null) day.napMinutes = 0;
      }
      const eff = jsonNum(s.efficiencyPct);
      const inBed = jsonNum(s.inBedMinutes);
      if (eff !== undefined && eff !== null) {
        set(day, 'sleepEfficiencyPct', round(eff, 1));
      } else if (inBed !== undefined && inBed !== null && inBed > 0
                 && day.sleepMinutes !== null && inBed >= day.sleepMinutes) {
        // Arithmetic on two measured durations, not an invented score.
        set(day, 'sleepEfficiencyPct', round((day.sleepMinutes / inBed) * 100, 1));
      }

      // Rule 3 check. The client is told to keep naps out of totalMinutes; if the
      // stages exceed the night, we drop the breakdown rather than ship a day the
      // contract validator would reject.
      const stageSum = (day.remMin || 0) + (day.deepMin || 0) + (day.lightMin || 0);
      if (day.sleepMinutes !== null && stageSum > day.sleepMinutes * 1.03 + 1) {
        note('Sleep stages on ' + raw.date + ' totalled ' + Math.round(stageSum)
          + ' min against a ' + day.sleepMinutes + ' min night; stage breakdown '
          + 'dropped. Check the client is excluding naps from sleep.totalMinutes.');
        day.remMin = null; day.deepMin = null; day.lightMin = null;
      }
      if (day.sleepMinutes === null) {
        day.remMin = null; day.deepMin = null; day.lightMin = null;
        day.sleepHours = null; day.sleepEfficiencyPct = null;
      }
    }

    /* ---- device-native scores: never a canonical field ---- */
    if (raw.providerScores && typeof raw.providerScores === 'object'
        && !Array.isArray(raw.providerScores)) {
      Object.keys(raw.providerScores).forEach((k) => {
        const v = raw.providerScores[k];
        if (typeof v !== 'number' && typeof v !== 'string') return;
        const key = /^[a-z0-9_]+\.[a-z0-9_]+$/.test(k) ? k : null;
        if (key) day.providerScores[key] = v;
        else note('providerScores key ' + JSON.stringify(k) + ' on ' + raw.date
          + ' is not namespaced (expected e.g. "samsung.sleep_score") and was dropped');
      });
    }

    /* ---- Health Connect has no recovery, readiness or strain ---- */
    day.recoveryScore = null;
    day.readinessScore = null;
    day.strain = null;

    Object.keys(raw).forEach((k) => { if (!HANDLED_DAY_KEYS.has(k)) unknown(k); });

    byDate.set(raw.date, day);
  });

  /* ---- workouts ---- */
  const workouts = [];
  if (Array.isArray(body.workouts)) {
    body.workouts.forEach((w, i) => {
      if (!w || typeof w !== 'object') { reject(i, 'workout entry is not an object', w); return; }
      const p = w.startedAt ? parseTimestamp(w.startedAt) : null;
      const date = isYmd(w.date) ? w.date : (w.startedAt ? ymdInTz(w.startedAt, tz) : null);
      if (!date) { reject(i, 'workout has no usable date or startedAt', w); return; }
      const num = (v) => { const n = jsonNum(v); return n === undefined ? null : n; };
      workouts.push({
        date,
        startedAt: p ? (p.iso || p.localYmd) : (typeof w.startedAt === 'string' ? w.startedAt : null),
        endedAt: typeof w.endedAt === 'string' ? w.endedAt : null,
        durationMin: num(w.durationMin),
        activity: typeof w.activity === 'string' ? w.activity : null,
        strain: null, // Health Connect has no strain metric
        energyKcal: num(w.energyKcal),
        maxHr: num(w.maxHr),
        avgHr: num(w.avgHr),
        zones: { z1: null, z2: null, z3: null, z4: null, z5: null }
      });
    });
    workouts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const days = Array.from(byDate.values())
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (unknownColumns.length) {
    note(unknownColumns.length + ' unrecognised payload key(s) were ignored: '
      + unknownColumns.map((u) => u.column).join(', ')
      + '. They are listed in summary.unknownColumns, not dropped silently.');
  }

  const out = {
    days,
    workouts,
    journal: [],
    summary: {
      provider: PROVIDER,
      filesSeen: [{
        name: 'health-connect.json',
        kind: 'native-bridge',
        schemaVersion: version,
        rowsParsed: days.length,
        rowsRejected
      }],
      rowsParsed: days.length,
      rowsRejected,
      dateRange: {
        from: days.length ? days[0].date : null,
        to: days.length ? days[days.length - 1].date : null
      },
      unknownColumns,
      duplicates: [],
      implausible,
      notes,
      timezone: tz,
      schemaVersion: version,
      device: {
        platform: typeof device.platform === 'string' ? device.platform : 'android',
        manufacturer: typeof device.manufacturer === 'string' ? device.manufacturer : null,
        model: typeof device.model === 'string' ? device.model : null,
        appVersion: typeof device.appVersion === 'string' ? device.appVersion : null,
        originPackages: Array.isArray(device.originPackages)
          ? device.originPackages.filter((x) => typeof x === 'string') : []
      }
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

/* ------------------------------------------------------------------ *
 * INTEGRATION NOTES
 * ------------------------------------------------------------------ */
/*
 * INTEGRATION NOTE (route):
 *   Needs POST /api/wearables/native/health-connect, authenticated as the member,
 *   accepting application/json. Payloads are small — a year of daily aggregates
 *   is well under 1MB — so the existing express.json path is fine here; only the
 *   Apple XML path needs a streaming endpoint. Rate-limit it: the app should send
 *   at most a few times a day, and a sync loop must not become a write amplifier.
 *   Route the body straight into healthConnect.parse(req.body) and then into the
 *   existing readinessService.previewUpload / commitUpload pair.
 *
 * INTEGRATION NOTE (idempotency):
 *   The app will re-send overlapping windows on every sync. commitUpload's
 *   UNIQUE(user_id, date, source) upsert handles that, but the sha256 the route
 *   currently derives from raw bytes will differ on every send (the payload
 *   carries an `exportedAt`). Either exclude `exportedAt` from the hash or accept
 *   that native syncs are never "already imported".
 *
 * INTEGRATION NOTE (deviceRegistry):
 *   Register 'health_connect' with confidence prior 0.8, hasRecovery false,
 *   hasStrain false, and NO fixed hrvMethod — it is per-day, from the payload.
 */

module.exports = {
  parse,
  resolveHrvMethod,
  PROVIDER,
  SCHEMA_VERSIONS,
  HEALTH_CONNECT_CONFIDENCE,
  DAY_FIELD_MAP,
  MAX_DAYS
};
