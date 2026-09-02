'use strict';

/**
 * The device registry — one honest description of every wearable BodyBank accepts.
 *
 * This module is DATA, not logic. It answers four questions that the ingest routes,
 * the upload UI and the trend engine all need and must never answer differently:
 *
 *   1. What can this device actually give us?   -> `capabilities`
 *   2. What does its HRV number physically mean? -> `hrvMethod`
 *   3. Is its temperature an absolute or a delta? -> `tempBasis`
 *   4. How much should we trust it?              -> `baseConfidence` / confidenceFor()
 *
 * ── The rules this file is written under ────────────────────────────────────
 *  A. Every `id` is a member of canonicalDay.PROVIDERS. A device id that is not
 *     in that list is rejected at persist time and the member's upload silently
 *     writes nothing, so this is enforced by tests/wearables-registry.js.
 *  B. `capabilities` covers EVERY canonicalDay.METRIC_FIELDS entry. The map is
 *     built from METRIC_FIELDS itself (default 'none') so a field added to the
 *     contract can never leave a hole here.
 *  C. Optimism is a bug. A metric is 'native' only when we are confident the
 *     vendor's own export carries it as a per-day value. Anything we are not sure
 *     about is 'none' and carries an `// UNVERIFIED:` comment naming the doubt.
 *     A false 'native' produces a chart with missing points and a member who
 *     thinks we lost their data; a false 'none' costs us nothing but a later edit.
 *  D. `hrvMethod` is the single most consequential field here. Apple Watch reports
 *     SDNN from a ~60s spot check; Whoop / Oura / Fitbit / Garmin report overnight
 *     RMSSD. Those numbers are not on the same scale. Tagging Apple as
 *     `rmssd_sleep` would make every member who switches watches show a phantom
 *     recovery cliff, and baselineService segregates series on exactly this tag.
 *
 * Capability vocabulary:
 *   'native'  — the vendor's own export/API carries this as a per-day value.
 *   'derived' — BodyBank can compute it from other fields this device DOES supply
 *               (e.g. sleep efficiency from asleep-vs-in-bed). Lower fidelity,
 *               still honest, always flagged as derived downstream.
 *   'none'    — we cannot get it. The field stays null. We say so to the member.
 *
 * Budget bands (Noise, boAt, Fire-Boltt, …) have NO export mechanism whatsoever.
 * They are NOT registry devices — they have no canonical provider id — they are
 * listed in BUDGET_BANDS and all route to the `screenshot` device, so the UI can
 * name the member's actual band and still tell them the truth about it.
 *
 * @module services/wearables/deviceRegistry
 */

const {
  PROVIDERS,
  METRIC_FIELDS,
  HRV_METHOD,
  HRV_METHODS,
  TEMP_BASIS,
  TEMP_BASES,
  MEASUREMENT_SOURCE
} = require('./canonicalDay');

/* ------------------------------------------------------------------ *
 * 1. Vocabulary
 * ------------------------------------------------------------------ */

/** Fidelity of what we can realistically obtain from a device. */
const TIERS = ['full', 'partial', 'minimal'];

/** Accepted ingest routes. Mirrors what the upload UI is allowed to offer. */
const INGEST_ROUTES = ['zip', 'csv', 'json', 'xml', 'pdf', 'screenshot', 'native_sdk'];

/** Legal capability values. */
const CAPABILITIES = ['native', 'derived', 'none'];

/**
 * Static self-check findings. A typo in a `caps({...})` override key would
 * otherwise vanish silently (the key is simply never read), so instead of
 * throwing at require-time — this module must never break a server boot — we
 * collect defects here and tests/wearables-registry.js asserts the list is empty.
 * @type {string[]}
 */
const REGISTRY_DEFECTS = [];

/**
 * Build a complete capability map: every METRIC_FIELDS entry present, defaulting
 * to 'none', with the given overrides applied. Rule B lives here.
 *
 * @param {Object<string,string>} overrides
 * @param {string} [deviceId] for defect reporting
 * @returns {Object<string,string>}
 */
function caps(overrides, deviceId) {
  const out = {};
  METRIC_FIELDS.forEach((f) => { out[f] = 'none'; });
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  Object.keys(src).forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(out, k)) {
      REGISTRY_DEFECTS.push((deviceId || '?') + '.capabilities: "' + k + '" is not a canonical metric field');
      return;
    }
    if (CAPABILITIES.indexOf(src[k]) === -1) {
      REGISTRY_DEFECTS.push((deviceId || '?') + '.capabilities.' + k + ': illegal value ' + JSON.stringify(src[k]));
      return;
    }
    out[k] = src[k];
  });
  return out;
}

/**
 * `confidence` is never reported by a device — BodyBank computes it (see
 * confidenceFor). Every device therefore declares it 'derived', and this constant
 * keeps that from being restated fifteen times.
 */
const CONFIDENCE_IS_OURS = { confidence: 'derived' };

/* ------------------------------------------------------------------ *
 * 2. The devices
 * ------------------------------------------------------------------ */

const DEVICE_LIST = [
  /* ────────────────────────────── Whoop ────────────────────────────── */
  {
    id: 'whoop',
    label: 'WHOOP 4.0 / MG',
    shortLabel: 'WHOOP',
    brand: 'WHOOP',
    tier: 'full',
    ingest: ['zip', 'csv', 'pdf'],
    // Whoop's CSV export is the richest file any consumer wearable produces and
    // is the format services/wearables/whoopParser.js was written against.
    capabilities: caps(Object.assign({
      recoveryScore: 'native',
      readinessScore: 'derived', // BodyBank's normalised score, not a Whoop field
      hrvMs: 'native',
      restingHr: 'native',
      spo2: 'native',
      skinTempC: 'native', // Whoop exports an ABSOLUTE skin temperature
      respiratoryRate: 'native',
      strain: 'native', // Whoop's 0-21 scale — meaningless on any other brand
      energyKcal: 'native',
      maxHr: 'native',
      avgHr: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      sleepPerformancePct: 'native',
      sleepEfficiencyPct: 'native',
      sleepConsistencyPct: 'native',
      sleepNeedMin: 'native',
      sleepDebtMin: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      awakeMin: 'native',
      napMinutes: 'native',
      activeMinutes: 'derived' // summed from the workouts.csv rows
      // UNVERIFIED: Whoop added a step count to the 4.0 app, but we have not
      // confirmed a `steps` column in the CSV export. Left 'none' deliberately.
    }, CONFIDENCE_IS_OURS), 'whoop'),
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    tempBasis: TEMP_BASIS.ABSOLUTE_C,
    baseConfidence: 0.95,
    exportInstructions: 'WHOOP app → Menu (⋮) → Settings → Account → Data Export → Create Export. WHOOP emails you a .zip; upload that file here.',
    caveats: [
      'WHOOP does not count steps, so your step chart will stay empty unless you add a phone or watch.',
      'Strain is a WHOOP-only scale — it cannot be compared with any other brand\'s effort score.',
      'The export email can take a few hours to arrive.'
    ]
  },

  /* ────────────────────────────── Oura ────────────────────────────── */
  {
    id: 'oura',
    label: 'Oura Ring (Gen 3 / Gen 4)',
    shortLabel: 'Oura',
    brand: 'Oura',
    tier: 'full',
    ingest: ['csv', 'json', 'zip'],
    capabilities: caps(Object.assign({
      readinessScore: 'native', // Oura's own Readiness Score, 0-100
      hrvMs: 'native',
      restingHr: 'native',
      spo2: 'native',
      // Oura reports temperature as a DEVIATION from the member's own baseline.
      // Writing that into skinTempC would read as hypothermia — see rule 6.
      skinTempDeviationC: 'native',
      respiratoryRate: 'native',
      energyKcal: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      sleepEfficiencyPct: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      awakeMin: 'native',
      steps: 'native',
      activeMinutes: 'native'
      // UNVERIFIED: max/avg heart rate, nap duration and sleep regularity are all
      // visible in the Oura app but we have not confirmed them as columns in the
      // member-facing CSV export. Left 'none'.
      // Oura's Sleep Score belongs in providerScores ('oura.sleep_score'), never
      // in sleepPerformancePct — it is not WHOOP's measure of the same name.
    }, CONFIDENCE_IS_OURS), 'oura'),
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    tempBasis: TEMP_BASIS.DEVIATION_C,
    baseConfidence: 0.9,
    exportInstructions: 'Oura web dashboard (cloud.ouraring.com) → sign in → Trends → Export Data (CSV), or Oura app → Settings → Account → Export Data. Upload the .csv here.',
    caveats: [
      'Oura reports temperature as a change from your own baseline, not a thermometer reading, so it is only meaningful against your own history.',
      'Oura\'s Readiness Score is Oura\'s formula; we show it beside your BodyBank score rather than mixing the two.',
      'Ring-based step counts run lower than a phone or watch.'
    ]
  },

  /* ────────────────────────────── Fitbit ────────────────────────────── */
  {
    id: 'fitbit',
    label: 'Fitbit (Sense / Versa / Charge / Inspire)',
    shortLabel: 'Fitbit',
    brand: 'Fitbit',
    tier: 'full',
    ingest: ['zip', 'json', 'csv'],
    capabilities: caps(Object.assign({
      hrvMs: 'native', // Fitbit's daily HRV is overnight RMSSD
      restingHr: 'native',
      spo2: 'native',
      skinTempDeviationC: 'native', // Fitbit calls it "temperature variation"
      respiratoryRate: 'native',
      energyKcal: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      sleepEfficiencyPct: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      awakeMin: 'native',
      steps: 'native',
      activeMinutes: 'derived', // Takeout gives very/fairly-active minutes and
      // Active Zone Minutes, which double-count cardio time. We sum to a single
      // honest "active minutes" rather than pretending AZM is the same unit.
      readinessScore: 'derived'
      // UNVERIFIED: Fitbit's Daily Readiness Score is Premium-only and we have not
      // confirmed it appears in Google Takeout. Its Sleep Score belongs in
      // providerScores ('fitbit.sleep_score'). Daily max/avg HR are only present
      // as intraday series, not a per-day field. All left 'none'.
    }, CONFIDENCE_IS_OURS), 'fitbit'),
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    tempBasis: TEMP_BASIS.DEVIATION_C,
    baseConfidence: 0.85,
    exportInstructions: 'Google Takeout (takeout.google.com) → Deselect all → tick Fitbit → Export. Google emails a .zip; upload it here. (Fitbit app → Settings → Manage Data → Export also works for a shorter range.)',
    caveats: [
      'Fitbit reports temperature as a variation from your own baseline, not an absolute reading.',
      'Fitbit\'s Sleep Score is a Fitbit formula; we keep it beside your BodyBank score instead of blending them.',
      'HRV is only recorded on nights you wear the device to sleep with enough battery.'
    ]
  },

  /* ────────────────────────────── Garmin ────────────────────────────── */
  {
    id: 'garmin',
    label: 'Garmin (Forerunner / Fenix / Venu / vívosmart)',
    shortLabel: 'Garmin',
    brand: 'Garmin',
    tier: 'full',
    ingest: ['zip', 'json', 'csv'],
    capabilities: caps(Object.assign({
      hrvMs: 'native', // Garmin HRV Status is an overnight RMSSD average
      restingHr: 'native',
      spo2: 'native',
      respiratoryRate: 'native',
      energyKcal: 'native',
      maxHr: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      awakeMin: 'native',
      steps: 'native',
      activeMinutes: 'native', // Garmin's intensity minutes
      readinessScore: 'derived'
      // UNVERIFIED: Body Battery and Training Readiness are model-dependent Garmin
      // scores — they go to providerScores ('garmin.body_battery'), never into a
      // canonical field. Sleep efficiency, average daily HR and skin temperature
      // are not reliably present across the export, so all are 'none'.
    }, CONFIDENCE_IS_OURS), 'garmin'),
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    tempBasis: null,
    baseConfidence: 0.8,
    exportInstructions: 'Garmin account portal (garmin.com/account) → Data Management → Export Your Data → Request. Garmin emails a .zip of JSON; upload the whole .zip here.',
    caveats: [
      'Garmin\'s export is a large mixed archive and its contents differ by watch model, so some charts may be empty for your device.',
      'HRV Status needs several consecutive nights of wear before Garmin publishes a number at all.',
      'Body Battery is a Garmin score and cannot be compared with any other brand.'
    ]
  },

  /* ────────────────────────── Apple Health ────────────────────────── */
  {
    id: 'apple_health',
    label: 'Apple Watch / Apple Health',
    shortLabel: 'Apple',
    brand: 'Apple',
    tier: 'full',
    ingest: ['zip', 'xml', 'native_sdk'],
    capabilities: caps(Object.assign({
      hrvMs: 'native', // SDNN — see hrvMethod below. NOT comparable with RMSSD.
      restingHr: 'native',
      spo2: 'native',
      respiratoryRate: 'native',
      // Wrist temperature, Series 8+ / Ultra only. RECONCILED against the actual
      // export: the record is
      //   type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" unit="degC" value="33.42"
      // — an absolute Celsius reading, not the "+0.3" the Health app displays. The
      // baseline Apple subtracts to render that deviation is private to the device
      // and appears nowhere in the export, so we could not reproduce it even if we
      // wanted to. The adapter therefore stores the absolute and lets
      // baselineService derive the deviation against the member's own history.
      skinTempC: 'native',
      skinTempDeviationC: 'derived',
      energyKcal: 'native', // active energy burned
      sleepHours: 'native',
      sleepMinutes: 'native',
      remMin: 'native', // iOS 16+ sleep stages
      deepMin: 'native',
      lightMin: 'native',
      awakeMin: 'native',
      steps: 'native',
      sleepEfficiencyPct: 'derived', // asleep vs in-bed, both present in the XML
      napMinutes: 'derived', // short daytime sleep sessions, split out by the adapter
      maxHr: 'derived', // from the intraday heart-rate samples
      avgHr: 'derived',
      activeMinutes: 'derived', // Apple Exercise Time is a different definition
      // from Fitbit/Garmin active minutes, so we mark it derived rather than
      // pretending it is the same unit.
      readinessScore: 'derived'
    }, CONFIDENCE_IS_OURS), 'apple_health'),
    // THE critical entry in this file. HKQuantityTypeIdentifierHeartRateVariabilitySDNN
    // is SDNN over a ~60-second spot measurement, typically far higher than an
    // overnight RMSSD. baselineService refuses to put it in the same series as a
    // Whoop/Oura/Fitbit number precisely because of this tag.
    hrvMethod: HRV_METHOD.SDNN_SPOT,
    // RESOLVED (was UNVERIFIED). Apple's Health app *displays* wrist temperature as
    // a nightly deviation from the member's baseline, and this field originally
    // described that presentation. The export tells a different story: the record is
    //   type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" unit="degC" value="33.42"
    // — an absolute Celsius reading. The baseline Apple subtracts to render "+0.3" is
    // private to the device and is not in the export at all, so the deviation cannot
    // be reproduced from the file; it can only be re-derived against the member's own
    // history, which is what baselineService does.
    //
    // The standing rule still holds and is the safer one: an adapter MUST set each
    // day's `tempBasis` to describe what it actually wrote into that day, never copy
    // this field. appleHealth.js does exactly that, including a defensive branch that
    // routes a |value| <= 10 reading to skinTempDeviationC instead, since no absolute
    // wrist temperature can be that small.
    tempBasis: TEMP_BASIS.ABSOLUTE_C,
    baseConfidence: 0.8,
    exportInstructions: 'iPhone → Health app → tap your photo (top right) → Export All Health Data → Share → Save to Files. Upload the resulting export.zip here.',
    caveats: [
      'Apple measures HRV as SDNN from short spot checks, which reads much higher than the overnight HRV a WHOOP or Oura reports. We keep the two on separate trend lines instead of pretending they match.',
      'Apple Watch takes HRV readings irregularly, so some days will simply have no value.',
      'Wrist temperature needs an Apple Watch Series 8 or later worn overnight.',
      'The export file is large — a year of data can be several hundred megabytes.'
    ]
  },

  /* ────────────────────────── Samsung Health ────────────────────────── */
  {
    id: 'samsung_health',
    label: 'Samsung Galaxy Watch / Samsung Health',
    shortLabel: 'Samsung',
    brand: 'Samsung',
    tier: 'partial',
    ingest: ['zip', 'csv'],
    capabilities: caps(Object.assign({
      restingHr: 'native',
      spo2: 'native',
      energyKcal: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      sleepEfficiencyPct: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      steps: 'native',
      activeMinutes: 'native',
      maxHr: 'derived', // from the heart_rate tracker rows
      avgHr: 'derived',
      awakeMin: 'derived' // sleep session length minus the staged minutes
      // UNVERIFIED: Samsung shows HRV, skin temperature and sleeping breathing
      // rate inside the app, but we have not confirmed any of them as columns in
      // the Samsung Health CSV export. All left 'none' — we would rather show a
      // member an empty HRV chart than a wrong one.
      // Samsung's Sleep Score goes to providerScores ('samsung_health.sleep_score').
    }, CONFIDENCE_IS_OURS), 'samsung_health'),
    hrvMethod: null,
    tempBasis: null,
    baseConfidence: 0.65,
    exportInstructions: 'Samsung Health app → ⋮ (top right) → Settings → Download personal data → confirm. The files land in your phone storage as a .zip; upload that here.',
    caveats: [
      'Samsung\'s export does not include HRV, so your recovery is estimated from sleep and resting heart rate rather than measured.',
      'The export writes to your phone rather than emailing you, so you will need to find the .zip in your Files app.'
    ]
  },

  /* ────────────────────────── Health Connect ────────────────────────── */
  {
    id: 'health_connect',
    label: 'Android Health Connect',
    shortLabel: 'Health Connect',
    brand: 'Google',
    tier: 'partial',
    ingest: ['native_sdk', 'json'],
    capabilities: caps(Object.assign({
      hrvMs: 'native', // HeartRateVariabilityRmssd records
      restingHr: 'native',
      spo2: 'native',
      respiratoryRate: 'native',
      energyKcal: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      awakeMin: 'native',
      steps: 'native',
      maxHr: 'derived',
      avgHr: 'derived',
      activeMinutes: 'derived' // summed from exercise sessions
      // UNVERIFIED: Health Connect has gained a skin-temperature record type, but
      // its availability depends on the Android version and the writing app, and
      // it mixes a baseline with deltas. Left 'none' until an adapter proves it.
    }, CONFIDENCE_IS_OURS), 'health_connect'),
    // Deliberately UNKNOWN, not rmssd_sleep. Health Connect is a pipe, not a
    // sensor: the RMSSD in it was written by whatever app the member installed,
    // over whatever window that app chose. Tagging it 'rmssd_sleep' would let a
    // spot-check reading from a third-party app contaminate an overnight series.
    hrvMethod: HRV_METHOD.UNKNOWN,
    tempBasis: null,
    baseConfidence: 0.7,
    exportInstructions: 'In the BodyBank Android app → Profile → Connect Health Data → allow Health Connect access. No file needed; we read it on your phone with your permission.',
    caveats: [
      'Health Connect only holds what your other apps have written into it, so what we can see depends on which app owns your watch.',
      'We cannot tell how another app measured its HRV, so those readings are kept on their own trend line and never merged with a WHOOP or Oura history.'
    ]
  },

  /* ────────────────────────────── Polar ────────────────────────────── */
  {
    id: 'polar',
    label: 'Polar (Vantage / Grit / Ignite / Verity)',
    shortLabel: 'Polar',
    brand: 'Polar',
    tier: 'partial',
    ingest: ['zip', 'json', 'csv'],
    capabilities: caps(Object.assign({
      hrvMs: 'native', // Nightly Recharge HRV is RMSSD over the first ~4h of sleep
      restingHr: 'native',
      energyKcal: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      steps: 'native',
      maxHr: 'derived',
      avgHr: 'derived',
      activeMinutes: 'derived'
      // UNVERIFIED: SpO2 and breathing rate exist on some Polar models and inside
      // Nightly Recharge, but not across the range and not confirmed in the Flow
      // export. Polar's Sleep Score / ANS charge go to providerScores.
    }, CONFIDENCE_IS_OURS), 'polar'),
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    tempBasis: null,
    baseConfidence: 0.7,
    exportInstructions: 'Polar Flow web (flow.polar.com) → Settings → Account → Export data → request the archive, then upload the .zip here.',
    caveats: [
      'Polar measures HRV over the first hours of sleep rather than the whole night, so it will not match a WHOOP number exactly even on the same night.',
      'Nightly Recharge needs a supported watch worn to bed.'
    ]
  },

  /* ────────────────────────────── Amazfit ────────────────────────────── */
  {
    id: 'amazfit',
    label: 'Amazfit / Zepp (GTR, GTS, T-Rex, Band)',
    shortLabel: 'Amazfit',
    brand: 'Amazfit',
    tier: 'partial',
    ingest: ['zip', 'csv', 'screenshot'],
    capabilities: caps(Object.assign({
      sleepHours: 'native',
      sleepMinutes: 'native',
      deepMin: 'native',
      lightMin: 'native',
      steps: 'native',
      energyKcal: 'native'
      // UNVERIFIED: the Zepp data request returns ACTIVITY / SLEEP / HEARTRATE_AUTO
      // CSVs. The heart-rate file is an intraday sample series with no resting-HR
      // field, and REM, SpO2 and HRV are shown in the app without appearing in the
      // export we have seen. All 'none' rather than guessed.
      // Zepp's PAI and Readiness are brand scores -> providerScores.
    }, CONFIDENCE_IS_OURS), 'amazfit'),
    hrvMethod: null,
    tempBasis: null,
    baseConfidence: 0.5,
    exportInstructions: 'Zepp app → Profile → Settings → Privacy → Export data → request. Zepp emails a .zip of CSV files; upload it here. If the request fails, send us screenshots instead.',
    caveats: [
      'Zepp\'s export does not include HRV or resting heart rate, so recovery is estimated from your sleep and activity rather than measured.',
      'The export request can take several days and sometimes fails — screenshots are a fine fallback.'
    ]
  },

  /* ────────────────────────── Generic CSV ────────────────────────── */
  {
    id: 'generic_csv',
    label: 'Any other tracker (CSV)',
    shortLabel: 'CSV',
    brand: 'Other',
    tier: 'partial',
    ingest: ['csv'],
    // Capability here means "we will accept this column if your file has it" —
    // NOT "your device produces it". Nothing is promised; the file decides. The
    // low baseConfidence and the UNKNOWN method tags carry the uncertainty.
    capabilities: caps(Object.assign({
      recoveryScore: 'native',
      hrvMs: 'native',
      restingHr: 'native',
      spo2: 'native',
      respiratoryRate: 'native',
      energyKcal: 'native',
      maxHr: 'native',
      avgHr: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      sleepEfficiencyPct: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native',
      awakeMin: 'native',
      steps: 'native',
      activeMinutes: 'native',
      readinessScore: 'derived'
      // Temperature is deliberately absent: with no way to know whether a column
      // holds an absolute or a deviation, importing it would risk writing a
      // -0.3 delta into skinTempC. A member with a temperature column should use
      // their vendor's own adapter.
    }, CONFIDENCE_IS_OURS), 'generic_csv'),
    // We cannot know how an arbitrary file measured HRV, so it is quarantined in
    // its own 'unknown' series and never merged with a tagged device history.
    hrvMethod: HRV_METHOD.UNKNOWN,
    tempBasis: TEMP_BASIS.UNKNOWN,
    baseConfidence: 0.55,
    exportInstructions: 'Export a CSV from your app with one row per day and a date column, then upload it here. We match your column names automatically and tell you which ones we did not recognise.',
    caveats: [
      'We can only import the columns your file actually contains.',
      'Because we cannot tell how your app measured HRV, those readings are kept on their own trend line rather than merged with another device\'s history.'
    ]
  },

  /* ────────────────────────── Screenshot / vision ────────────────────────── */
  {
    id: 'screenshot',
    label: 'Screenshots of your app',
    shortLabel: 'Screenshot',
    brand: 'Any',
    tier: 'minimal',
    ingest: ['screenshot', 'pdf'],
    // Whatever is printed on the app's daily summary card, read by AI. Anything
    // that needs a tap to reveal is realistically out of reach.
    capabilities: caps(Object.assign({
      hrvMs: 'native',
      restingHr: 'native',
      spo2: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      steps: 'native',
      energyKcal: 'native',
      remMin: 'native',
      deepMin: 'native',
      lightMin: 'native'
      // Everything else is 'none': stage breakdowns, efficiency and respiratory
      // rate are usually behind another screen, and a value we did not see is a
      // value we do not have.
    }, CONFIDENCE_IS_OURS), 'screenshot'),
    hrvMethod: HRV_METHOD.UNKNOWN,
    tempBasis: TEMP_BASIS.UNKNOWN,
    baseConfidence: 0.35,
    exportInstructions: 'Open your tracker app on the day you want, screenshot the daily summary screen, and upload the images here — one screenshot per day.',
    caveats: [
      'Numbers read from an image can be misread, so please check the values we show back to you before saving.',
      'One screenshot is one day — building a trend this way takes a lot of screenshots.',
      'We cannot tell from an image how your app measured HRV, so those readings stay on their own trend line.'
    ]
  },

  /* ────────────────────────────── Manual ────────────────────────────── */
  {
    id: 'manual',
    label: 'Type it in yourself',
    shortLabel: 'Manual',
    brand: 'BodyBank',
    tier: 'minimal',
    // Intentionally empty: there is no file for manual entry, it is a form in the
    // app. The upload UI must therefore not offer manual as a file route.
    ingest: [],
    capabilities: caps(Object.assign({
      hrvMs: 'native',
      restingHr: 'native',
      spo2: 'native',
      sleepHours: 'native',
      sleepMinutes: 'native',
      steps: 'native',
      energyKcal: 'native',
      readinessScore: 'derived'
    }, CONFIDENCE_IS_OURS), 'manual'),
    hrvMethod: HRV_METHOD.UNKNOWN,
    tempBasis: TEMP_BASIS.UNKNOWN,
    baseConfidence: 0.5,
    exportInstructions: 'BodyBank app → Recovery → Add entry. Fill in whatever you know for that day and leave the rest blank — blank is always better than a guess.',
    caveats: [
      'Typed entries are only as good as what you read off your device.',
      'If you type HRV copied from a different app than usual, tell us which app — the two are not on the same scale.'
    ]
  }
];

/**
 * Budget bands with NO export mechanism at all. These are real devices a lot of
 * Indian members actually wear, and pretending they do not exist pushes people to
 * pick the wrong brand in the picker. They are not providers — they route to the
 * `screenshot` device — so the UI can say "Noise ColorFit → screenshots only"
 * instead of leaving the member to work it out.
 *
 * UNVERIFIED as a class: none of these vendors publishes a documented data-export
 * path, and their apps change often. If any of them ships one, it becomes a
 * `generic_csv` route, not a new provider id.
 */
const BUDGET_BANDS = [
  { brand: 'Noise', label: 'Noise (ColorFit / Luna / Pulse)', deviceId: 'screenshot' },
  { brand: 'boAt', label: 'boAt (Wave / Storm / Xtend)', deviceId: 'screenshot' },
  { brand: 'Fire-Boltt', label: 'Fire-Boltt (Ninja / Phoenix / Talk)', deviceId: 'screenshot' },
  { brand: 'Realme', label: 'Realme Band / Watch', deviceId: 'screenshot' },
  { brand: 'Redmi', label: 'Redmi Watch / Smart Band', deviceId: 'screenshot' },
  { brand: 'Fastrack', label: 'Fastrack Reflex / Revoltt', deviceId: 'screenshot' },
  { brand: 'Titan', label: 'Titan Smart / Talk', deviceId: 'screenshot' },
  { brand: 'pTron', label: 'pTron Force / Reflect', deviceId: 'screenshot' }
].map((b) => Object.assign({}, b, {
  tier: 'minimal',
  ingest: ['screenshot'],
  note: 'This band has no data export. Screenshots are the only way to get its numbers into BodyBank.'
}));

/* ------------------------------------------------------------------ *
 * 3. Static self-check
 * ------------------------------------------------------------------ */

const DEVICES = (() => {
  const map = new Map();
  DEVICE_LIST.forEach((d) => {
    if (PROVIDERS.indexOf(d.id) === -1) {
      REGISTRY_DEFECTS.push(d.id + ': not a member of canonicalDay.PROVIDERS');
    }
    if (map.has(d.id)) REGISTRY_DEFECTS.push(d.id + ': duplicate device id');
    if (TIERS.indexOf(d.tier) === -1) REGISTRY_DEFECTS.push(d.id + '.tier: illegal value ' + JSON.stringify(d.tier));
    if (!Array.isArray(d.ingest)) REGISTRY_DEFECTS.push(d.id + '.ingest: expected an array');
    else d.ingest.forEach((r) => {
      if (INGEST_ROUTES.indexOf(r) === -1) REGISTRY_DEFECTS.push(d.id + '.ingest: unknown route ' + JSON.stringify(r));
    });
    if (d.hrvMethod !== null && HRV_METHODS.indexOf(d.hrvMethod) === -1) {
      REGISTRY_DEFECTS.push(d.id + '.hrvMethod: unknown value ' + JSON.stringify(d.hrvMethod));
    }
    if (d.tempBasis !== null && TEMP_BASES.indexOf(d.tempBasis) === -1) {
      REGISTRY_DEFECTS.push(d.id + '.tempBasis: unknown value ' + JSON.stringify(d.tempBasis));
    }
    // The rule that keeps Apple's SDNN out of Whoop's RMSSD series: a device that
    // claims to supply HRV natively MUST say how it measured it.
    if (d.capabilities.hrvMs === 'native' && !d.hrvMethod) {
      REGISTRY_DEFECTS.push(d.id + ': capabilities.hrvMs is "native" but hrvMethod is not declared');
    }
    if ((d.capabilities.skinTempC !== 'none' || d.capabilities.skinTempDeviationC !== 'none') && !d.tempBasis) {
      REGISTRY_DEFECTS.push(d.id + ': supplies a temperature but tempBasis is not declared');
    }
    if (d.capabilities.skinTempC === 'native' && d.tempBasis === TEMP_BASIS.DEVIATION_C) {
      REGISTRY_DEFECTS.push(d.id + ': claims absolute skinTempC but declares a deviation tempBasis');
    }
    if (d.capabilities.skinTempDeviationC === 'native' && d.tempBasis === TEMP_BASIS.ABSOLUTE_C) {
      REGISTRY_DEFECTS.push(d.id + ': claims skinTempDeviationC but declares an absolute tempBasis');
    }
    if (typeof d.baseConfidence !== 'number' || !(d.baseConfidence >= 0 && d.baseConfidence <= 1)) {
      REGISTRY_DEFECTS.push(d.id + '.baseConfidence: expected 0..1');
    }
    if (typeof d.exportInstructions !== 'string' || !d.exportInstructions.trim()) {
      REGISTRY_DEFECTS.push(d.id + '.exportInstructions: expected a non-empty string');
    }
    if (!Array.isArray(d.caveats) || d.caveats.length === 0) {
      REGISTRY_DEFECTS.push(d.id + '.caveats: expected a non-empty array');
    }
    map.set(d.id, Object.freeze(d));
  });
  BUDGET_BANDS.forEach((b) => {
    if (!map.has(b.deviceId)) REGISTRY_DEFECTS.push('budget band ' + b.brand + ': unknown deviceId ' + b.deviceId);
  });
  return map;
})();

/* ------------------------------------------------------------------ *
 * 4. Lookup helpers — all null-safe, none throws
 * ------------------------------------------------------------------ */

/**
 * Look up one device by canonical provider id.
 *
 * @param {string} id
 * @returns {Object|null} the frozen device entry, or null for an unknown id
 */
function getDevice(id) {
  if (typeof id !== 'string') return null;
  return DEVICES.get(id.trim().toLowerCase()) || null;
}

/**
 * All devices, in registry order (roughly best-supported first).
 *
 * @param {{tier?:string, ingest?:string}} [filter] optional narrowing
 * @returns {Object[]}
 */
function listDevices(filter) {
  let out = DEVICE_LIST.slice();
  if (filter && typeof filter === 'object') {
    if (typeof filter.tier === 'string') out = out.filter((d) => d.tier === filter.tier);
    if (typeof filter.ingest === 'string') out = out.filter((d) => d.ingest.indexOf(filter.ingest) !== -1);
  }
  return out;
}

/** Budget bands that route to `screenshot`. @returns {Object[]} */
function listBudgetBands() {
  return BUDGET_BANDS.slice();
}

/**
 * Raw capability of one device for one canonical metric.
 *
 * @param {string} id
 * @param {string} metric a canonicalDay.METRIC_FIELDS entry
 * @returns {'native'|'derived'|'none'} 'none' for any unknown device or metric
 */
function capabilityFor(id, metric) {
  const d = getDevice(id);
  if (!d || typeof metric !== 'string') return 'none';
  const c = d.capabilities[metric];
  return c || 'none';
}

/**
 * Can we get this metric from this device at all (natively or by derivation)?
 *
 * @param {string} id
 * @param {string} metric
 * @returns {boolean}
 */
function supportsMetric(id, metric) {
  return capabilityFor(id, metric) !== 'none';
}

/**
 * The whole registry as a metric x device grid, for the "what will I actually
 * get?" comparison screen.
 *
 * @returns {{metrics:string[], devices:string[], rows:Object<string,Object<string,string>>}}
 */
function capabilityMatrix() {
  const devices = DEVICE_LIST.map((d) => d.id);
  const rows = {};
  METRIC_FIELDS.forEach((m) => {
    const row = {};
    devices.forEach((id) => { row[id] = capabilityFor(id, m); });
    rows[m] = row;
  });
  return { metrics: METRIC_FIELDS.slice(), devices: devices, rows: rows };
}

/* ------------------------------------------------------------------ *
 * 5. Confidence
 * ------------------------------------------------------------------ */

/**
 * How much a value's route to us discounts it. A number an LLM read off a
 * screenshot is not the same evidence as one parsed from the vendor's own CSV,
 * and must never be presented as if it were (canonicalDay rule on
 * MEASUREMENT_SOURCE).
 */
const SOURCE_MULTIPLIER = {};
SOURCE_MULTIPLIER[MEASUREMENT_SOURCE.DEVICE_EXPORT] = 1;
SOURCE_MULTIPLIER[MEASUREMENT_SOURCE.DEVICE_API] = 1;
SOURCE_MULTIPLIER[MEASUREMENT_SOURCE.NATIVE_SDK] = 0.95;
SOURCE_MULTIPLIER[MEASUREMENT_SOURCE.VISION] = 0.6;
SOURCE_MULTIPLIER[MEASUREMENT_SOURCE.MANUAL] = 0.55;
SOURCE_MULTIPLIER[MEASUREMENT_SOURCE.DERIVED] = 0.5;
/** An unstated route is not a free pass — we simply do not know how it arrived. */
const UNKNOWN_SOURCE_MULTIPLIER = 0.85;

/** Days of history we consider "a full picture" when the caller does not say. */
const DEFAULT_EXPECTED_DAYS = 30;
/** Even a single day keeps this share of the device's confidence. */
const MIN_COVERAGE_FACTOR = 0.6;

function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Confidence 0..1 for data from one device, given how much of it we have and how
 * it reached us.
 *
 *   confidence = baseConfidence x sourceMultiplier x coverageFactor
 *   coverageFactor = 0.6 + 0.4 * min(coverageDays / expectedDays, 1)
 *
 * Coverage is a multiplier rather than an additive term because thin history
 * should scale the whole claim down, not shift it: three days of Whoop is still
 * better evidence than three days of screenshots. The 0.6 floor stops a first
 * upload reading as worthless.
 *
 * Never throws. An unknown device id returns 0 — we can vouch for nothing.
 *
 * @param {string} id canonical provider id
 * @param {{coverageDays?:number, expectedDays?:number, measurementSource?:string}} [opts]
 * @returns {number} 0..1, rounded to 3 decimals
 */
function confidenceFor(id, opts) {
  const d = getDevice(id);
  if (!d) return 0;
  const o = opts && typeof opts === 'object' ? opts : {};

  const expected = (typeof o.expectedDays === 'number' && Number.isFinite(o.expectedDays) && o.expectedDays > 0)
    ? o.expectedDays
    : DEFAULT_EXPECTED_DAYS;
  const covered = (typeof o.coverageDays === 'number' && Number.isFinite(o.coverageDays) && o.coverageDays > 0)
    ? o.coverageDays
    : 0;

  const ratio = clamp01(covered / expected);
  const coverageFactor = covered > 0
    ? MIN_COVERAGE_FACTOR + (1 - MIN_COVERAGE_FACTOR) * (ratio == null ? 0 : ratio)
    : MIN_COVERAGE_FACTOR;

  const mult = (typeof o.measurementSource === 'string'
    && Object.prototype.hasOwnProperty.call(SOURCE_MULTIPLIER, o.measurementSource))
    ? SOURCE_MULTIPLIER[o.measurementSource]
    : UNKNOWN_SOURCE_MULTIPLIER;

  const v = clamp01(d.baseConfidence * mult * coverageFactor);
  return v == null ? 0 : round3(v);
}

module.exports = {
  // data
  DEVICES,
  DEVICE_LIST,
  BUDGET_BANDS,
  TIERS,
  INGEST_ROUTES,
  CAPABILITIES,
  SOURCE_MULTIPLIER,
  DEFAULT_EXPECTED_DAYS,
  REGISTRY_DEFECTS,
  // helpers
  getDevice,
  listDevices,
  listBudgetBands,
  capabilityFor,
  supportsMetric,
  capabilityMatrix,
  confidenceFor
};

// INTEGRATION NOTE (for the orchestrator — I did not edit any file outside my slice):
//
// 1. Checked against the concurrently-updated readinessService.js: its
//    VALID_PROVIDERS and SOURCE_PRECEDENCE now cover every id in this registry,
//    and its precedence order matches this file's baseConfidence ordering (vendor
//    exports > platform aggregates > generic CSV/manual > screenshot > derived).
//    Nothing to do — but if either list changes, they must change together, since
//    a provider missing from VALID_PROVIDERS is normalised to null and its upload
//    silently writes nothing.
//
// 2. Also already handled there: readiness_daily now carries hrv_method,
//    temp_basis, measurement_source and skin_temp_deviation_c. Those four columns
//    are what make baselineService's segregation survive a DB round-trip, so any
//    adapter that writes hrv_ms MUST also write hrv_method (this registry's
//    `hrvMethod` is the default to use when the file itself does not say).
//
// 3. The upload UI should read `ingest` from this registry rather than hard-coding
//    accepted extensions, and must not offer `manual` as a file route (its
//    `ingest` is deliberately empty). Budget-band brands come from
//    listBudgetBands() and must render as "screenshots only", not as providers.
