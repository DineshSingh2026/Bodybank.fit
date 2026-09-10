/*
 * BodyBank — the yoga postures the product knows about.
 *
 * Single source of truth shared by:
 *   - public/index.html    → the "Yoga" posture dropdown in My Workout
 *   - public/ai-trainer.html → the #ygSel list (kept in step by tests/yoga-postures-in-sync.js)
 *
 * `key` must match the AI Trainer's exercise key exactly, so a logged posture
 * and a coached posture are the same thing everywhere.
 */
(function (root) {
  root.BB_YOGA_POSTURES = [
    { key: 'plank',    emoji: '🧘', en: 'Plank',         sa: 'Kumbhakasana' },
    { key: 'warrior2', emoji: '🧘', en: 'Warrior II',    sa: 'Virabhadrasana II' },
    { key: 'tree',     emoji: '🌳', en: 'Tree',          sa: 'Vrikshasana' },
    { key: 'goddess',  emoji: '🧘', en: 'Goddess',       sa: 'Utkata Konasana' },
    { key: 'downdog',  emoji: '🐕', en: 'Downward Dog',  sa: 'Adho Mukha Svanasana' },
    { key: 'chair',    emoji: '🪑', en: 'Chair',         sa: 'Utkatasana' },
    { key: 'warrior1', emoji: '🧘', en: 'Warrior I',     sa: 'Virabhadrasana I' },
    { key: 'triangle', emoji: '📐', en: 'Triangle',      sa: 'Trikonasana' },
    { key: 'boat',     emoji: '⛵', en: 'Boat',          sa: 'Navasana' },
    { key: 'bridge',   emoji: '🌉', en: 'Bridge',        sa: 'Setu Bandhasana' },
    { key: 'cobra',    emoji: '🐍', en: 'Cobra',         sa: 'Bhujangasana' },
  ];

  /** "🐕 Downward Dog · Adho Mukha Svanasana" — the label used in dropdowns. */
  root.bbYogaLabel = function (p) {
    return p.emoji + ' ' + p.en + ' · ' + p.sa;
  };
}(window));
