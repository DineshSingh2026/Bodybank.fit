/**
 * Unit test: member calorie balance (target source + left / over / deficit maths).
 * Run: node tests/nutrition-calorie-balance.js
 *
 * NO NETWORK. NO DATABASE.
 *
 * Guards:
 *  - getUserGoals uses the latest nutrition assessment's calorie_target, falls back
 *    to 2000 for missing, junk or out of range values, and reports the source;
 *  - nutritionCalorieBalance (public/index.html) states: under, near, hit, over,
 *    with left / over / percent maths, and never divides by zero;
 *  - the card copy never shows a score or a grade.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getUserGoals } = require('../services/nutritionService');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── server: target source ───────────────────────────────────────────────────
const dbWith = (row, throws) => ({
  queryOne: async (sql) => {
    if (throws) throw new Error('relation "nutrition_assessments" does not exist');
    assert(/nutrition_assessments/.test(sql), 'reads nutrition_assessments');
    return row;
  }
});

async function serverChecks() {
  eq(await getUserGoals(dbWith({ derived: { calorie_target: 1780.4 } }), 'u1'),
    { calorieGoal: 1780, proteinGoal: 150, calorieGoalSource: 'assessment' }, 'assessment target used and rounded');
  eq(await getUserGoals(dbWith({ derived: JSON.stringify({ calorie_target: 2350 }) }), 'u1'),
    { calorieGoal: 2350, proteinGoal: 150, calorieGoalSource: 'assessment' }, 'derived stored as text is parsed');
  for (const [label, row] of [['no row', null], ['no derived', { derived: null }], ['no target', { derived: {} }],
    ['junk', { derived: { calorie_target: 'abc' } }], ['too low', { derived: { calorie_target: 400 } }],
    ['too high', { derived: { calorie_target: 9000 } }], ['bad json', { derived: '{oops' }]]) {
    eq(await getUserGoals(dbWith(row), 'u1'), { calorieGoal: 2000, proteinGoal: 150, calorieGoalSource: 'default' }, 'default when ' + label);
  }
  eq((await getUserGoals(dbWith(null, true), 'u1')).calorieGoal, 2000, 'missing table falls back to default');
}

// ── client: balance maths from public/index.html ────────────────────────────
function loadClient() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const grab = (name) => {
    const start = html.indexOf('function ' + name + '(');
    assert(start >= 0, 'index.html defines ' + name);
    let depth = 0; let i = html.indexOf('{', start);
    for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
    return html.slice(start, i + 1);
  };
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([grab('nutritionCalorieBalance'), grab('nutritionKcal'), grab('nutritionRenderCalorieBalance')].join('\n'), ctx);
  return { ctx, html };
}

function clientChecks() {
  const { ctx, html } = loadClient();
  const B = ctx.nutritionCalorieBalance;
  const pick = (o) => ({ state: o.state, left: o.left, over: o.over, pct: o.pct });
  eq(pick(B(760, 2000)), { state: 'under', left: 1240, over: 0, pct: 38 }, '760 of 2000 → under, 1240 left');
  eq(pick(B(1800, 2000)), { state: 'near', left: 200, over: 0, pct: 90 }, '1800 of 2000 → near');
  eq(pick(B(1960, 2000)), { state: 'hit', left: 40, over: 0, pct: 98 }, 'within 60 of target → hit');
  eq(pick(B(2000, 2000)), { state: 'hit', left: 0, over: 0, pct: 100 }, 'exactly on target → hit');
  eq(pick(B(2180, 2000)), { state: 'over', left: 0, over: 180, pct: 109 }, '2180 of 2000 → over by 180');
  eq(pick(B(0, 2000)), { state: 'under', left: 2000, over: 0, pct: 0 }, 'nothing eaten');
  eq(B(500, 0).goal, 2000, 'zero target falls back to 2000 (no divide by zero)');
  eq(B(-50, 1800).eaten, 0, 'negative intake clamps to 0');
  eq(B('612', '1750').left, 1138, 'string numbers are coerced');
  eq(ctx.nutritionKcal(12345.6), '12,346', 'kcal formatting');

  // Render: the card uses the right state and words, and never a score.
  const box = { attrs: {}, innerHTML: '', classList: { remove() {}, add() {} }, setAttribute(k, v) { this.attrs[k] = v; } };
  ctx.document = { getElementById: (id) => (id === 'nutriCalBalance' ? box : null) };
  ctx.bbNutritionState = { goals: { cal: 2000, calSource: 'assessment' } };
  ctx.nutritionRenderCalorieBalance(2180, 2000);
  eq(box.attrs['data-state'], 'over', 'render sets data-state');
  assert(/180<\/b>/.test(box.innerHTML) && /kcal over your target/.test(box.innerHTML), 'over card shows the surplus');
  assert(/a surplus/.test(box.innerHTML), 'over card names the surplus');
  assert(/personal daily target/.test(box.innerHTML), 'personal target source shown');
  ctx.bbNutritionState = { goals: { cal: 2000 } };
  ctx.nutritionRenderCalorieBalance(760, 2000);
  assert(/1,240<\/b>/.test(box.innerHTML) && /kcal left for today/.test(box.innerHTML), 'under card shows kcal left');
  assert(/a deficit for now/.test(box.innerHTML), 'under card names the deficit');
  assert(/Standard 2,000 kcal daily target/.test(box.innerHTML), 'default target is labelled as standard');
  assert(!/score|grade/i.test(box.innerHTML), 'no score or grade in the card');

  // Wiring: both data paths keep the target source and the summary renders the card.
  assert((html.match(/bbNutritionState\.goals\.calSource = ds\.calorieGoalSource/g) || []).length === 2, 'both load paths keep the target source');
  assert(html.includes('nutritionRenderCalorieBalance(totCal, cg);'), 'summary renders the balance card');
  assert(html.includes('id="nutriCalBalance"'), 'card container in the markup');
}

(async () => {
  await serverChecks();
  clientChecks();
  if (failures.length) {
    console.error(`nutrition-calorie-balance: ${failures.length} of ${checks} checks FAILED`);
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log(`nutrition-calorie-balance: all ${checks} checks passed`);
})();
