/**
 * Unit test: the pure logic behind the member screens
 * (Daily Streak, Mind check-in, blood grades, two-week report sentence).
 * Run: node tests/member-screens.js
 *
 * NO NETWORK. NO DATABASE.
 */

const S = require('../services/memberScreens');
const { momentumLine } = require('../routes/memberScreens');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function days(start, n) { const out = []; for (let i = 0; i < n; i++) out.push(S.addDays(start, i)); return out; }

// ── streak runs ──────────────────────────────────────────────────────────────
const today = '2026-09-29';
let set = new Set(days('2026-09-09', 21)); // 09..29 inclusive
let run = S.currentRun(set, today);
eq(run.length, 21, 'run length incl. today');
eq(run.start, '2026-09-09', 'run start');
eq(run.todaySaved, true, 'today saved');

set = new Set(days('2026-09-09', 20)); // up to 28, today not saved yet
run = S.currentRun(set, today);
eq(run.length, 20, 'run still alive when only yesterday is saved');
eq(run.todaySaved, false, 'today not saved');

set = new Set(days('2026-09-01', 5).concat(days('2026-09-10', 3)));
eq(S.currentRun(set, today).length, 0, 'a gap before yesterday breaks the run');
eq(S.bestRun(set), 5, 'best run found in history');
eq(S.bestRun(new Set()), 0, 'no history');

// ── milestones ───────────────────────────────────────────────────────────────
const ms = S.milestonesFor(21);
eq(ms.items.filter((m) => m.reached).map((m) => m.days), [7, 14, 21], 'reached milestones at 21');
eq(ms.next && ms.next.days, 30, 'next milestone');
eq(ms.next && ms.next.in_days, 9, 'days to next');
eq(S.milestonesFor(60).next, null, 'nothing after 60');
eq(S.milestonesFor(0).items.filter((m) => m.reached).length, 0, 'nothing reached at 0');

const aw = S.milestoneAwards('u1', { length: 14, start: '2026-09-16' });
eq(aw.map((a) => a.days), [7, 14], 'awards for a 14-day run');
eq(aw[0].eventKey, 'coins:streak_milestone:u1:2026-09-16:7', 'award key carries the run start (once per run)');
assert(aw.every((a) => a.coins > 0), 'awards carry coins');
const aw2 = S.milestoneAwards('u1', { length: 7, start: '2026-10-01' });
assert(aw2[0].eventKey !== aw[0].eventKey, 'a new run earns the milestone again');
eq(S.milestoneAwards('u1', { length: 0, start: null }), [], 'no run, no awards');

// ── calendar ─────────────────────────────────────────────────────────────────
const real = new Set(days('2026-09-01', 29).filter((d) => d !== '2026-09-08'));
const frz = new Set(['2026-09-15']);
real.delete('2026-09-15');
const cal = S.monthCalendar('2026-09', real, frz, today, '2026-08-01');
eq(cal.days.length, 30, 'September has 30 cells');
eq(cal.first_weekday, 1, '1 Sep 2026 is a Tuesday (Mon=0)');
eq(cal.days[7].state, 'missed', 'the 8th is missed');
eq(cal.days[14].state, 'freeze', 'the 15th was frozen');
eq(cal.days[28].state, 'done', 'today done');
eq(cal.days[29].state, 'future', 'the 30th is in the future');
eq(cal.done, 28, 'done count includes the freeze day');
eq(cal.elapsed, 29, 'elapsed days');
eq([cal.prev, cal.next], ['2026-08', '2026-10'], 'month navigation');
const calJoin = S.monthCalendar('2026-09', new Set(), new Set(), today, '2026-09-20');
eq(calJoin.days[0].state, 'before', 'days before joining are not "missed"');
const calTodayOpen = S.monthCalendar('2026-09', new Set(), new Set(), today, '2026-01-01');
eq(calTodayOpen.days[28].state, 'today', 'unsaved today is "today", not missed');
eq(S.monthCalendar('bad', real, frz, today, null), null, 'bad month');

// ── mind ─────────────────────────────────────────────────────────────────────
eq(S.validMood(3), 3, 'valid mood');
eq(S.validMood(0), null, 'mood below range');
eq(S.validMood(6), null, 'mood above range');
eq(S.validMood('4'), 4, 'mood from a string');
eq(S.validMood(2.5), null, 'fractional mood rejected');
eq(S.moodLabel(4), 'Good', 'mood label');
eq(S.stressLabel(1), 'Low', 'stress label');
eq(S.mindStreak(new Set(days('2026-09-21', 9)), today), 9, 'mind streak');
const sw = S.sleepWeek(new Map([['2026-09-29', 7.4], ['2026-09-27', 6]]), today);
eq(sw.days.length, 7, 'seven sleep bars');
eq(sw.days[6].hours, 7.4, 'latest bar is today');
eq(sw.days[5].hours, null, 'missing day stays null (no invented sleep)');
eq(sw.avg, 6.7, 'average of logged nights only');

// ── blood marker grades ──────────────────────────────────────────────────────
const mk = (status, value, low, high, direction) => ({ markerId: 'x', displayName: 'X', status, value, rawValue: String(value), unit: 'u', direction, referenceRange: { low, high, printed: `${low}-${high}` } });
eq(S.markerGrade(mk('WITHIN_RANGE', 50, 0, 100, 'RANGE')), 'A', 'centre of range is Optimal');
eq(S.markerGrade(mk('WITHIN_RANGE', 95, 0, 100, 'RANGE')), 'B', 'near an edge is Good');
eq(S.markerGrade(mk('WITHIN_RANGE', 95, 0, 100, 'LOWER')), 'B', 'lower-is-better near the top edge is Good');
eq(S.markerGrade(mk('WITHIN_RANGE', 5, 0, 100, 'LOWER')), 'A', 'lower-is-better near the bottom is Optimal');
eq(S.markerGrade(mk('BORDERLINE_HIGH', 98, 0, 100, 'RANGE')), 'C', 'borderline');
eq(S.markerGrade(mk('HIGH', 130, 0, 100, 'LOWER')), 'D', 'unfavourable out of range is Attention');
eq(S.markerGrade(mk('LOW', 40, 50, 100, 'LOWER')), 'A', 'favourable side out of range (low LDL) is Optimal');
eq(S.markerGrade(mk('CRITICAL_LOW', 2, 10, 50, 'RANGE')), 'D', 'critical');
eq(S.markerGrade(mk('NOT_AVAILABLE', null, 0, 1, 'RANGE')), null, 'no value, no grade');
eq(S.markerGrade(Object.assign(mk('WITHIN_RANGE', 5, 0, 10, 'RANGE'), { duplicate: true })), null, 'duplicates are not graded twice');
const bar = S.markerBar(mk('WITHIN_RANGE', 50, 0, 100, 'RANGE'));
assert(bar.band_start > 0 && bar.band_end < 1 && bar.value === 0.5, 'bar places the value mid-band');
eq(S.markerBar(mk('HIGH', 1e9, 0, 100, 'RANGE')).value, 1, 'bar clamps extreme values');

const view = S.bloodGradesView({
  classified: { markers: [mk('WITHIN_RANGE', 50, 0, 100, 'RANGE'), mk('HIGH', 130, 0, 100, 'LOWER'), mk('BORDERLINE_LOW', 51, 50, 100, 'RANGE')] },
  areas: [{ areaId: 'CV', label: 'Heart', grade: 'B', gradeLabel: 'Monitor' }, { areaId: 'TH', label: 'Thyroid', grade: 'NOT_ASSESSED' }]
});
eq(view.total, 3, 'three graded markers');
eq(view.optimal_or_good, 1, 'optimal-or-good count');
eq(view.counts, { A: 1, B: 0, C: 1, D: 1 }, 'grade counts');
eq(view.markers.map((m) => m.grade), ['A', 'C', 'D'], 'good news first');
eq(view.areas.length, 1, 'not-assessed areas are left out');
assert(!/\/100|score/i.test(JSON.stringify(view)), 'no invented overall score in the blood view');

// ── report sentence: facts only ──────────────────────────────────────────────
const line = momentumLine({ totalDelta: 1 }, 13, { done: 8, planned: 8 }, { avg: 140, target: 150 });
eq(line, 'Training, protein and check-ins all on target.', 'three habits on target');
eq(momentumLine({ totalDelta: 1 }, 5, { done: 8, planned: 8 }, { avg: 140, target: 150 }), 'Training and protein both on target.', 'two habits');
assert(!/meal score|score of your meals/i.test(line), 'never mentions a meal score');

if (failures.length) {
  console.error(`member-screens: ${failures.length} of ${checks} checks FAILED`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`member-screens: all ${checks} checks passed`);
