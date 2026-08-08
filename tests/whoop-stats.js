/**
 * Unit test: deterministic Whoop/readiness stats engine + numeric report validator.
 * Run: node tests/whoop-stats.js
 *
 * NO NETWORK. NO DATABASE. Every expected value below is computed BY HAND from the
 * fixtures so a silent change in the arithmetic fails loudly.
 */

const {
  computeWhoopStats,
  flattenFactsToNumbers,
  isoWeekKey
} = require('../services/wearables/whoopStatsService');
const {
  validateReportNumbers,
  extractNumbersFromText,
  buildFactsForPrompt
} = require('../services/wearables/whoopReportService');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

function eq(actual, expected, msg) {
  checks += 1;
  const ok = Object.is(actual, expected);
  if (!ok) failures.push(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return ok;
}

function deepEq(actual, expected, msg) {
  checks += 1;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) failures.push(`${msg} — expected ${b}, got ${a}`);
  return a === b;
}

function section(name) {
  console.log(`=== ${name} ===`);
}

function ymd(day) {
  return `2026-01-${String(day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// FIXTURE A — 7 days, sleepHours = [1, 2, null, 3, null, 4, 5]
// Mixed camelCase / snake_case keys on purpose.
// Hand-computed: n=5, mean=3, median=3, min=1, max=5, sd=sqrt(2)=1.4142→1.4, latest=5
// ---------------------------------------------------------------------------
const FIXTURE_A = [
  { date: ymd(1), sleep_hours: 1, source: 'whoop' },
  { date: ymd(2), sleepHours: 2, source: 'whoop' },
  { date: ymd(3), sleep_hours: null, source: 'whoop' },
  { date: ymd(4), sleepHours: 3, source: 'whoop' },
  { date: ymd(5), sleep_hours: null, source: 'whoop' },
  { date: ymd(6), sleepHours: 4, source: 'whoop' },
  { date: ymd(7), sleep_hours: 5, source: 'whoop' }
];

// ---------------------------------------------------------------------------
// FIXTURE B — 30 days across 2026-01-01..2026-01-31 with 2026-01-16 MISSING.
//   recovery        : 70 for the first 15 rows, 30 for the last 15
//   restingHr       : 60 for the first 15 rows, 54 for the last 15  (falls = improves)
//   hrv             : 50, but null on every row where index % 3 === 1  (10 nulls)
//   sleepHours      : 5.5 where index % 5 === 0 (6 rows), else 7.5
//   strain          : 16 every day
//   sleepDebtMin    : 90 every day
//   respiratoryRate : absent entirely
// ---------------------------------------------------------------------------
const FIXTURE_B = [];
{
  const dates = [];
  for (let d = 1; d <= 31; d += 1) {
    if (d === 16) continue; // calendar gap
    dates.push(ymd(d));
  }
  for (let i = 0; i < dates.length; i += 1) {
    FIXTURE_B.push({
      date: dates[i],
      source: 'whoop',
      recovery_score: i < 15 ? 70 : 30,
      resting_hr: i < 15 ? 60 : 54,
      hrv_ms: i % 3 === 1 ? null : 50,
      sleep_hours: i % 5 === 0 ? 5.5 : 7.5,
      strain: 16,
      sleep_debt_min: 90
    });
  }
}

// ---------------------------------------------------------------------------
// FIXTURE C — next-day alignment across a DATE GAP + exactly-known Pearson r.
// Dates: 03-01, 03-02, 03-03, [03-04 MISSING], 03-05, 03-06, 03-07
//
//   sleepHours→nextDayRecovery pairs (by calendar date, not array index):
//     (1→50) (2→60) [3→? dropped: 03-04 absent] (4→80) (5→90) [6→? dropped: 03-08 absent]
//   => n = 4 (an index-based implementation would wrongly find 5), y = 10x + 40 => r = 1
//   strain→nextDayRecovery: x=[9,8,6,5], y=[50,60,80,90] => y = -10x + 140 => r = -1
//   sleepEfficiency→hrv (same day): perfectly linear over 6 points => r = 1, n = 6
//   napMin→nextDayRecovery: only 2 pairs => below the n<3 guard => r = null
// ---------------------------------------------------------------------------
const FIXTURE_C = [
  { date: '2026-03-01', sleepHours: 1, recoveryScore: 40, strain: 9, sleepEfficiencyPct: 80, hrvMs: 40, napMin: 20 },
  { date: '2026-03-02', sleepHours: 2, recoveryScore: 50, strain: 8, sleepEfficiencyPct: 82, hrvMs: 41, napMin: 30 },
  { date: '2026-03-03', sleepHours: 3, recoveryScore: 60, strain: 7, sleepEfficiencyPct: 84, hrvMs: 42 },
  { date: '2026-03-05', sleepHours: 4, recoveryScore: 70, strain: 6, sleepEfficiencyPct: 86, hrvMs: 43 },
  { date: '2026-03-06', sleepHours: 5, recoveryScore: 80, strain: 5, sleepEfficiencyPct: 88, hrvMs: 44 },
  { date: '2026-03-07', sleepHours: 6, recoveryScore: 90, strain: 4, sleepEfficiencyPct: 90, hrvMs: 45 }
];

// ---------------------------------------------------------------------------

function run() {
  const A = computeWhoopStats(FIXTURE_A);
  const B = computeWhoopStats(FIXTURE_B);
  const C = computeWhoopStats(FIXTURE_C);

  section('mean / median / stdDev with nulls interspersed (and snake_case keys)');
  const sa = A.metrics.sleepHours;
  assert(sa !== null, 'sleepHours metric block exists');
  eq(sa.n, 5, 'A.sleepHours.n skips nulls');
  eq(sa.mean, 3, 'A.sleepHours.mean');
  eq(sa.median, 3, 'A.sleepHours.median');
  eq(sa.min, 1, 'A.sleepHours.min');
  eq(sa.max, 5, 'A.sleepHours.max');
  eq(sa.stdDev, 1.4, 'A.sleepHours.stdDev (population sd = sqrt(2))');
  eq(sa.latest, 5, 'A.sleepHours.latest');
  eq(sa.latestDate, '2026-01-07', 'A.sleepHours.latestDate');
  eq(sa.unit, 'h', 'A.sleepHours.unit');
  eq(A.metrics.recovery, null, 'A metric with n===0 is null, not 0');
  eq(A.trends.recovery, null, 'A trend for an absent metric is null');
  eq(A.coverage.daysTotal, 7, 'A.coverage.daysTotal');
  eq(A.coverage.daysWithData, 5, 'A.coverage.daysWithData (null-only rows do not count)');
  eq(A.coverage.completenessPct, 71.4, 'A.coverage.completenessPct = 5/7');
  eq(A.trends.sleepHours.firstHalfMean, 1.5, 'A.sleepHours trend firstHalfMean (odd n drops middle)');
  eq(A.trends.sleepHours.secondHalfMean, 4.5, 'A.sleepHours trend secondHalfMean');
  eq(A.trends.sleepHours.deltaAbs, 3, 'A.sleepHours trend deltaAbs');
  eq(A.trends.sleepHours.deltaPct, 200, 'A.sleepHours trend deltaPct');
  eq(A.trends.sleepHours.direction, 'improving', 'A.sleepHours trend direction');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  section('polarity-correct trend direction (resting HR vs recovery)');
  eq(B.trends.restingHr.firstHalfMean, 60, 'B.restingHr firstHalfMean');
  eq(B.trends.restingHr.secondHalfMean, 54, 'B.restingHr secondHalfMean');
  eq(B.trends.restingHr.deltaAbs, -6, 'B.restingHr deltaAbs');
  eq(B.trends.restingHr.deltaPct, -10, 'B.restingHr deltaPct');
  eq(B.trends.restingHr.direction, 'improving', 'FALLING resting HR must be improving');
  eq(B.trends.restingHr.changeDirection, 'down', 'B.restingHr changeDirection');
  eq(B.trends.recovery.firstHalfMean, 70, 'B.recovery firstHalfMean');
  eq(B.trends.recovery.secondHalfMean, 30, 'B.recovery secondHalfMean');
  eq(B.trends.recovery.deltaAbs, -40, 'B.recovery deltaAbs');
  eq(B.trends.recovery.deltaPct, -57.1, 'B.recovery deltaPct (-40/70*100)');
  eq(B.trends.recovery.direction, 'declining', 'FALLING recovery must be declining');
  eq(B.trends.strain.direction, 'stable', 'neutral-polarity strain is never improving/declining');
  eq(B.trends.strain.polarity, 0, 'strain polarity is neutral');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  section('descriptive stats over the 30-day window');
  eq(B.metrics.recovery.n, 30, 'B.recovery.n');
  eq(B.metrics.recovery.mean, 50, 'B.recovery.mean');
  eq(B.metrics.recovery.median, 50, 'B.recovery.median');
  eq(B.metrics.recovery.min, 30, 'B.recovery.min');
  eq(B.metrics.recovery.max, 70, 'B.recovery.max');
  eq(B.metrics.recovery.stdDev, 20, 'B.recovery.stdDev');
  eq(B.metrics.recovery.latest, 30, 'B.recovery.latest');
  eq(B.metrics.hrv.n, 20, 'B.hrv.n skips the 10 interspersed nulls');
  eq(B.metrics.hrv.mean, 50, 'B.hrv.mean');
  eq(B.metrics.hrv.stdDev, 0, 'B.hrv.stdDev');
  eq(B.metrics.sleepHours.mean, 7.1, 'B.sleepHours.mean = 213/30');
  eq(B.metrics.sleepHours.median, 7.5, 'B.sleepHours.median');
  eq(B.metrics.sleepHours.stdDev, 0.8, 'B.sleepHours.stdDev');
  eq(B.metrics.respiratoryRate, null, 'absent respiratoryRate metric is null');
  eq(B.coverage.daysTotal, 31, 'B.coverage.daysTotal is the calendar span');
  eq(B.coverage.daysWithData, 30, 'B.coverage.daysWithData');
  eq(B.coverage.completenessPct, 96.8, 'B.coverage.completenessPct = 30/31');
  eq(B.coverage.dateFrom, '2026-01-01', 'B.coverage.dateFrom');
  eq(B.coverage.dateTo, '2026-01-31', 'B.coverage.dateTo');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  section('weekly ISO buckets, sleep debt, balance, notable days, flags');
  eq(isoWeekKey('2026-01-01'), '2026-W01', 'isoWeekKey matches the coinService algorithm');
  eq(B.weekly.length, 5, 'B weekly bucket count');
  deepEq(B.weekly.map((w) => w.week), ['2026-W01', '2026-W02', '2026-W03', '2026-W04', '2026-W05'], 'B weekly keys');
  deepEq(B.weekly.map((w) => w.days), [4, 7, 6, 7, 6], 'B weekly day counts (W03 is short: 01-16 missing)');
  eq(B.weekly[0].recovery, 70, 'B weekly[0] recovery mean');
  eq(B.weekly[4].recovery, 30, 'B weekly[4] recovery mean');

  eq(B.sleepDebt.totalMin, 2700, 'B.sleepDebt.totalMin');
  eq(B.sleepDebt.avgPerNightMin, 90, 'B.sleepDebt.avgPerNightMin');
  eq(B.sleepDebt.worstMin, 90, 'B.sleepDebt.worstMin');
  eq(B.sleepDebt.worstDate, '2026-01-01', 'B.sleepDebt.worstDate');
  eq(B.sleepDebt.nightsUnder6h, 6, 'B.sleepDebt.nightsUnder6h');
  eq(B.sleepDebt.nightsOver8h, 0, 'B.sleepDebt.nightsOver8h');

  eq(B.strainRecoveryBalance.daysConsidered, 30, 'B balance daysConsidered');
  eq(B.strainRecoveryBalance.daysHighStrainLowRecovery, 15, 'B balance high-strain/low-recovery days');
  eq(B.strainRecoveryBalance.avgStrainOnLowRecoveryDays, 16, 'B balance avg strain on low-recovery days');
  eq(B.strainRecoveryBalance.interpretationKey, 'overreaching', 'B balance interpretationKey');

  eq(B.notableDays.bestRecovery.value, 70, 'B notable best recovery value');
  eq(B.notableDays.bestRecovery.date, '2026-01-01', 'B notable best recovery date');
  eq(B.notableDays.worstRecovery.value, 30, 'B notable worst recovery value');
  eq(B.notableDays.worstRecovery.date, '2026-01-17', 'B notable worst recovery date');
  eq(B.notableDays.shortestSleep.value, 5.5, 'B notable shortest sleep');

  const flagKeys = B.flags.map((f) => f.key);
  assert(flagKeys.indexOf('chronic_sleep_debt') !== -1, 'B raises chronic_sleep_debt');
  assert(flagKeys.indexOf('overreaching') !== -1, 'B raises overreaching');
  assert(flagKeys.indexOf('declining_hrv') === -1, 'B does not raise declining_hrv (HRV is flat)');
  assert(flagKeys.indexOf('elevated_resting_hr') === -1, 'B does not raise elevated_resting_hr (RHR fell)');
  const debtFlag = B.flags.find((f) => f.key === 'chronic_sleep_debt');
  eq(debtFlag.severity, 'warn', 'chronic_sleep_debt severity at 90 min/night');
  eq(debtFlag.avgPerNightMin, 90, 'chronic_sleep_debt carries its supporting number');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  section('Pearson r + next-day alignment across a date GAP');
  const cSleep = C.correlations.sleepHoursToNextDayRecovery;
  eq(cSleep.n, 4, 'gap-aware alignment yields 4 pairs, not 5 (index-based would be wrong)');
  eq(cSleep.r, 1, 'perfectly positive lagged correlation');
  eq(cSleep.strength, 'strong', 'r=1 strength');
  eq(cSleep.direction, 'positive', 'r=1 direction');
  eq(cSleep.lagDays, 1, 'sleep→recovery uses a 1-day lag');

  const cStrain = C.correlations.strainToNextDayRecovery;
  eq(cStrain.n, 4, 'strain→next-day recovery pair count');
  eq(cStrain.r, -1, 'perfectly negative lagged correlation');
  eq(cStrain.direction, 'negative', 'negative direction label');

  const cEff = C.correlations.sleepEfficiencyToHrv;
  eq(cEff.n, 6, 'same-day pair count uses every day');
  eq(cEff.r, 1, 'same-day efficiency↔HRV correlation');
  eq(cEff.lagDays, 0, 'efficiency↔HRV is same-day');

  const cNap = C.correlations.napMinToNextDayRecovery;
  eq(cNap.n, 2, 'nap pair count');
  eq(cNap.r, null, 'n < 3 guard returns null r');
  eq(cNap.strength, 'none', 'null r strength');

  eq(B.correlations.sleepHoursToNextDayRecovery.n, 28, 'B lagged pairs skip the 01-15→01-16 and 01-31→02-01 gaps');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  section('flattenFactsToNumbers + prompt fact trimming');
  const nums = flattenFactsToNumbers(B);
  assert(nums instanceof Set, 'flattenFactsToNumbers returns a Set');
  assert(nums.has('50'), 'fact set contains recovery mean "50"');
  assert(nums.has('-57.1'), 'fact set contains signed deltaPct "-57.1"');
  assert(nums.has('57.1'), 'fact set also admits the unsigned form of a negative fact');
  assert(nums.has('96.8'), 'fact set contains completenessPct "96.8"');
  assert(nums.has('2700'), 'fact set contains sleepDebt totalMin');
  assert(nums.has('2026'), 'fact set contains the year from ISO dates');
  assert(nums.has('2026-01-17'), 'fact set contains whole ISO dates');
  assert(!nums.has('88.6'), 'fact set does not contain an arbitrary number');

  const prompted = buildFactsForPrompt(B);
  assert(prompted && prompted.metrics && prompted.coverage, 'buildFactsForPrompt keeps the aggregates');
  assert(prompted.metrics.respiratoryRate === undefined, 'buildFactsForPrompt drops null metrics');
  assert(!Object.prototype.hasOwnProperty.call(prompted, 'days'), 'buildFactsForPrompt never sends raw daily rows');
  const promptedNumbers = String(JSON.stringify(prompted)).match(/-?\d+(?:\.\d+)?/g) || [];
  const leaked = promptedNumbers.filter((t) => !nums.has(t) && !nums.has(t.replace(/^-/, '')));
  deepEq(leaked, [], 'every number in the prompt JSON is present in the validator fact set');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  section('numeric validator catches invented numbers');
  deepEq(extractNumbersFromText('HRV rose 1,234 ms to 62.5 (-3.4)'), ['1234', '62.5', '-3.4'], 'numeral extraction strips thousands separators');

  const factsA = flattenFactsToNumbers(A);
  const cleanReport = {
    headline: 'Sleep is trending up',
    summary: 'Across 7 days you logged 5 nights of data (71.4% coverage). Sleep averaged 3 h.',
    sections: [{ title: 'Sleep', body: 'The first half averaged 1.5 h and the second half 4.5 h.' }],
    sleepAnalysis: 'Your longest night was 5 h and your shortest 1 h.',
    recoveryAnalysis: 'No recovery data was captured in this window, so nothing can be said about it.',
    trainingLoadAnalysis: 'No strain data was captured.',
    correlationInsights: 'There were not enough paired days to compute a correlation.',
    actions: [
      { rank: 1, action: 'Protect a consistent bedtime for the next 7 nights.', rationale: 'Sleep averaged 3 h, well below need.' },
      { rank: 2, action: 'Wear the strap every night.', rationale: 'Only 5 nights were captured.' }
    ],
    coachNotes: 'Coverage is the first fix.'
  };
  const cleanResult = validateReportNumbers(cleanReport, factsA);
  assert(cleanResult.passed, `faithful report must pass (orphans: ${JSON.stringify(cleanResult.orphanNumbers)})`);
  deepEq(cleanResult.orphanNumbers, [], 'faithful report has no orphan numbers');
  assert(cleanResult.checked > 0, 'validator actually inspected numbers');

  const dirtyReport = JSON.parse(JSON.stringify(cleanReport));
  dirtyReport.recoveryAnalysis = 'Your HRV averaged 88.6 ms, which is solid.'; // invented
  dirtyReport.actions[0].rationale = 'You lost 1,234 minutes of sleep this month.'; // invented
  const dirtyResult = validateReportNumbers(dirtyReport, factsA);
  eq(dirtyResult.passed, false, 'invented numbers must fail validation');
  assert(dirtyResult.orphanNumbers.indexOf('88.6') !== -1, 'orphan 88.6 is reported');
  assert(dirtyResult.orphanNumbers.indexOf('1234') !== -1, 'orphan 1234 is reported (commas normalised)');
  assert(
    dirtyResult.occurrences.some((o) => o.field === 'recoveryAnalysis' && o.number === '88.6'),
    'orphan occurrence names the offending field'
  );
  assert(
    dirtyResult.occurrences.some((o) => o.field === 'actions[0].rationale'),
    'orphans inside actions[] are caught'
  );

  const ordinalReport = { headline: 'Top 3 priorities', summary: 'Step 1, step 2, step 3 — all in 2026.', sections: [], actions: [] };
  assert(validateReportNumbers(ordinalReport, factsA).passed, 'small ordinals and years are allowlisted');

  const roundedReport = { headline: 'Coverage was 71%', summary: '', sections: [], actions: [] };
  const roundedResult = validateReportNumbers(roundedReport, factsA);
  eq(roundedResult.passed, false, 're-rounding a fact (71.4 → 71) is treated as invented arithmetic');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  console.log('');
  if (failures.length > 0) {
    console.log('--- FAILURES ---');
    failures.forEach((f) => console.log(' ', f));
    console.log(`\n${failures.length} of ${checks} checks FAILED`);
    process.exit(1);
  }
  console.log(`--- All ${checks} whoop-stats checks passed ---`);
}

try {
  run();
} catch (e) {
  console.error(e);
  process.exit(1);
}
