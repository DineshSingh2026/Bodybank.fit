/**
 * BodyBank AI — Elite Admin Coaching Intelligence Engine v2.0
 *
 * Features:
 *  - Pre-computed deterministic metrics (compliance, trends, score/100, risk flags)
 *  - Exact date-range parsing (last N days, this week, last month, custom, etc.)
 *  - All 17 program profiles embedded + AI-powered recommendation engine
 *  - Smart client name/email resolution with disambiguation
 *  - Business analytics and compliance leaderboard
 *  - Intent-aware enrichment
 */
'use strict';

const { PDFParse } = require('pdf-parse');
const pathMod = require('path');

const MAX_PDF_TEXT = parseInt(process.env.ADMIN_AI_PROGRAM_TEXT_MAX || '12000', 10);
const DEFAULT_LOOKBACK_DAYS = parseInt(process.env.ADMIN_AI_CLIENT_LOOKBACK_DAYS || '30', 10);

// ─────────────────────────────────────────────────────────────────────────────
// ALL 17 PROGRAM PROFILES (derived from full PDF extraction)
// ─────────────────────────────────────────────────────────────────────────────
const PROGRAM_LIBRARY = [
  {
    id: 'BODY WORKOUT 2.pdf',
    name: 'Body Workout 2',
    type: 'AMRAP Circuit',
    duration_min: 10,
    equipment: [],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate',
    goals: ['fat_loss', 'general_fitness', 'endurance'],
    level: ['beginner', 'intermediate'],
    gender: 'any',
    muscle_focus: ['full_body', 'abs', 'chest', 'glutes', 'quads'],
    format: 'AMRAP — as many rounds as possible in 10 minutes. 8 exercises.',
    exercises: 'Seal Jack, Ab Crunches, Glute Bridge, Split Lunge Hop, L-Sit, Mountain Climbers, Single-Leg Knee Tuck, Pushup',
    best_for: 'Time-pressed clients, fat loss add-on session, travel, no equipment',
    not_ideal_for: 'Pure muscle gain, advanced athletes wanting volume',
    injury_caution: []
  },
  {
    id: 'BODYWEIGHT WORKOUT!.pdf',
    name: 'Bodyweight Workout',
    type: 'Countdown Circuit',
    duration_min: 30,
    equipment: ['pullup_bar'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate_high',
    goals: ['fat_loss', 'general_fitness', 'endurance', 'conditioning'],
    level: ['beginner', 'intermediate'],
    gender: 'any',
    muscle_focus: ['full_body', 'quads', 'lats', 'abs'],
    format: 'Countdown 10 to 1 reps across 3 exercises, 0 sec rest, 30 min',
    exercises: 'Jump Squat, Pullup/Pushup, Burpees',
    best_for: 'Conditioning, fat loss, beginners to intermediates with pullup bar access',
    not_ideal_for: 'Strength/mass focus, shoulder injuries, no pullup bar',
    injury_caution: ['shoulder', 'elbow']
  },
  {
    id: 'Cycle Sync.pdf',
    name: 'Cycle Sync',
    type: 'Cycle-Synced 28-Day Women\'s Program',
    duration_min: 35,
    equipment: ['dumbbells'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: 5,
    intensity: 'low_to_moderate',
    goals: ['fat_loss', 'general_fitness', 'hormonal_balance', 'women_specific', 'lower_body'],
    level: ['beginner', 'intermediate'],
    gender: 'female',
    muscle_focus: ['lower_body', 'glutes', 'quads', 'core'],
    format: '4 phases: Phase I stretching (Day 1-5), Phase II strength (Day 5-12), Phase III HIIT (Day 12-19), Phase IV power (Day 20-28)',
    exercises: 'Phase I: Stretching | Phase II: Leg Circles, Squats, Lunges, Single Glute Lift, Wall Sits | Phase III: Jumping Jacks, Mountain Climbers, Squat Jumps, Flutter Kicks, Shoulder Taps | Phase IV: Ickey Shuffle, Box Squat, Wall Sit',
    best_for: 'Female clients, hormonal balance, lower body focus, cycle-aware training',
    not_ideal_for: 'Male clients, irregular cycles, purely strength goals',
    injury_caution: []
  },
  {
    id: 'DUMBBELL WORKOUT.pdf',
    name: 'Dumbbell Workout',
    type: 'Full Body Strength',
    duration_min: 30,
    equipment: ['dumbbells', 'barbell', 'kettlebells'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate',
    goals: ['muscle_gain', 'strength', 'recomp'],
    level: ['intermediate'],
    gender: 'any',
    muscle_focus: ['full_body', 'chest', 'back', 'shoulders', 'hamstrings', 'abs'],
    format: '8 compound exercises, 3 sets (work up to 5), minimal rest, 30 min',
    exercises: 'Floor Press, Bentover Dumbbell Row, Weighted Situp, Renegade Row, Goblet Squat, One-Arm Overhead Press, Single-Leg Romanian Deadlift, Dumbbell One-Arm Swing',
    best_for: 'Home/garage gym, intermediate level, muscle gain, recomp',
    not_ideal_for: 'Beginners (complex movements), pure cardio goals, no equipment',
    injury_caution: ['lower_back', 'shoulder']
  },
  {
    id: 'FAT ON FIRE.pdf',
    name: 'Fat on Fire',
    type: 'Metabolic Conditioning — Sprint Protocol',
    duration_min: 30,
    equipment: ['dumbbells'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'high',
    goals: ['fat_loss', 'weight_loss', 'metabolic_boost', 'calorie_burn'],
    level: ['intermediate'],
    gender: 'any',
    muscle_focus: ['full_body', 'abs', 'shoulders', 'chest', 'biceps'],
    format: '7 exercises × 3 sets × 20 reps, 10 sec rest, SPRINT 30 sec after EVERY SET',
    exercises: 'Leg Circles, Russian Twists, Double Crunch, Side Crunch, Seated Dumbbell Press, Bicep Curl, Dumbbell Bench Press',
    best_for: 'Fat loss priority, intermediate fitness, clients wanting intense accountability sessions',
    not_ideal_for: 'Pure muscle gain, knee/ankle injuries (sprints), beginners',
    injury_caution: ['knee', 'ankle', 'hip']
  },
  {
    id: 'FLARE.pdf',
    name: 'Flare',
    type: 'Functional Circuit / Creative Fitness',
    duration_min: 40,
    equipment: ['pullup_bar'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate',
    goals: ['general_fitness', 'fat_loss', 'fun_factor', 'mobility', 'full_body_conditioning'],
    level: ['intermediate'],
    gender: 'any',
    muscle_focus: ['full_body', 'abs', 'quads', 'shoulders', 'back'],
    format: 'Circuit — all exercises in order, 20 sec rest after every 4 exercises, repeat 2-3 times',
    exercises: '14 creative exercises including Crescent Chair, Push-Up Side Arm Balance, Pull-Up Knee Raise, Flip-Flop Crunch, Crawly Plyo Push-Up, Releve Plie, Chin-Up Circle Crunch, Boat Plow, Balance Arch-Press, Hop-Press, Glamour Hammer, Flying Warrior, Squat Rockers, Warrior Squat Moon',
    best_for: 'Clients who get bored, want variety, dance/fitness enthusiasts, general fitness',
    not_ideal_for: 'Pure strength, advanced athletes, no pull-up bar access',
    injury_caution: ['shoulder', 'wrist']
  },
  {
    id: 'R1.pdf',
    name: 'R1 — Chest & Triceps (Rest-Pause)',
    type: 'Gym Strength — Rest-Pause Specialization',
    duration_min: 50,
    equipment: ['cables', 'dumbbells', 'gym_machines'],
    gym_required: true,
    home_friendly: false,
    days_per_week_hint: 1,
    intensity: 'high',
    goals: ['muscle_gain', 'strength', 'hypertrophy', 'specialization'],
    level: ['advanced'],
    gender: 'any',
    muscle_focus: ['chest', 'triceps'],
    format: '7 exercises, 3 sets × rest-pause pattern (3,3,3,2,2,1 reps), 10-20 sec intra-set rest, 5-6RM weight, single-arm alternating',
    exercises: 'Single-Arm Press, Incline Bench Press, Low-Cable Cross-Over, Single-Arm Cable Cross-Over, Single-Arm Cable Tricep Extension, One-Arm Tricep Dumbbell Extension (Supine), Standing One-Arm Dumbbell Triceps Extension',
    best_for: 'Advanced gym-goers, chest/triceps specialization, lagging muscle groups, rest-pause protocol',
    not_ideal_for: 'Beginners, home training, shoulder injuries',
    injury_caution: ['shoulder', 'elbow', 'pec_muscle']
  },
  {
    id: 'R2.pdf',
    name: 'R2 — Legs (Rest-Pause)',
    type: 'Gym Strength — Rest-Pause Specialization',
    duration_min: 50,
    equipment: ['gym_machines', 'dumbbells'],
    gym_required: true,
    home_friendly: false,
    days_per_week_hint: 1,
    intensity: 'high',
    goals: ['muscle_gain', 'strength', 'hypertrophy', 'leg_development', 'specialization'],
    level: ['advanced'],
    gender: 'any',
    muscle_focus: ['quads', 'hamstrings', 'calves'],
    format: '7 exercises, 3 sets × rest-pause (3,3,3,2,2,1), single-leg dominant, 5-6RM weight',
    exercises: 'Single-Leg Press, Dumbbell Reverse Lunge, Dumbbell Step-Up, Single-Leg Extension, Single-Leg Seated Curl, Single-Leg Calf Press, Single-Leg Seated Calf Raise',
    best_for: 'Leg development, fixing imbalances, advanced gym clients, squat alternative',
    not_ideal_for: 'Home training, beginners, knee injuries',
    injury_caution: ['knee', 'ankle', 'hip_flexor']
  },
  {
    id: 'R3.pdf',
    name: 'R3 — Shoulders & Traps (Rest-Pause)',
    type: 'Gym Strength — Rest-Pause Specialization',
    duration_min: 50,
    equipment: ['cables', 'gym_machines', 'smith_machine'],
    gym_required: true,
    home_friendly: false,
    days_per_week_hint: 1,
    intensity: 'high',
    goals: ['muscle_gain', 'strength', 'hypertrophy', 'shoulder_development', 'specialization'],
    level: ['advanced'],
    gender: 'any',
    muscle_focus: ['shoulders', 'traps'],
    format: '5 exercises, 3 sets × rest-pause (3,3,3,2,2,1), single-arm, cables + Smith machine',
    exercises: 'Single-Arm Standing Shoulder Press, Single-Arm Smith Machine Upright Row, Standing Low-Pulley Delt Raise, Single-Arm Incline Delt Raise, Single-Arm Smith Machine Shrug',
    best_for: 'Shoulder specialization, advanced gym clients, upper body aesthetics',
    not_ideal_for: 'Home training, beginners, shoulder impingement/rotator cuff issues',
    injury_caution: ['shoulder', 'rotator_cuff', 'neck']
  },
  {
    id: 'R4.pdf',
    name: 'R4 — Back & Biceps (Rest-Pause)',
    type: 'Gym Strength — Rest-Pause Specialization',
    duration_min: 50,
    equipment: ['cables', 'dumbbells', 'gym_machines'],
    gym_required: true,
    home_friendly: false,
    days_per_week_hint: 1,
    intensity: 'high',
    goals: ['muscle_gain', 'strength', 'hypertrophy', 'back_development', 'specialization'],
    level: ['advanced'],
    gender: 'any',
    muscle_focus: ['lats', 'upper_back', 'biceps'],
    format: '6 exercises, 3 sets × rest-pause (3,3,3,2,2,1), single-arm, cable dominant',
    exercises: 'Single-Arm Pulldown, One-Arm Cable Rows, Straight-Arm Pulldown, Dumbbell Alternate Bicep Curl, Alternate Incline Dumbbell Curl, Single-Arm Dumbbell Preacher Curl',
    best_for: 'Back and biceps specialization, advanced gym clients, cable machine access',
    not_ideal_for: 'Home training, beginners, no cable machine',
    injury_caution: ['elbow', 'bicep_tendon', 'shoulder']
  },
  {
    id: 'RIPPER 2.0.pdf',
    name: 'Ripper 2.0',
    type: 'Superset Training — 4-Day Split (Intermediate)',
    duration_min: 45,
    equipment: ['dumbbells', 'barbell', 'gym_machines'],
    gym_required: true,
    home_friendly: false,
    days_per_week_hint: 4,
    intensity: 'moderate_high',
    goals: ['muscle_gain', 'strength', 'recomp', 'hypertrophy', 'general_performance'],
    level: ['intermediate', 'advanced'],
    gender: 'any',
    muscle_focus: ['full_body', 'chest', 'back', 'biceps', 'triceps', 'shoulders', 'quads', 'glutes'],
    format: 'Day I: Chest+Back (Floor Press + Bent-Over Row). Day II: Biceps+Triceps (Curl + Tricep Ext). Day III: Shoulders+Traps (Arnold Press + Shrugs). Day IV: Legs (Squat + Bulgarian Split Squat). Pyramid reps (20,10,5×8), rest builds and drops.',
    exercises: 'D1: Floor Press + Bent-Over Row. D2: Bicep Curl + Tricep Extension. D3: Arnold Press + Shrugs/Upright Row. D4: Leg Press/Squat + Bulgarian Split Squat',
    best_for: 'Gym clients, 4 days/week, intermediate to advanced level, muscle gain + conditioning combo',
    not_ideal_for: 'Home training, beginners, clients with less than 4 days/week available',
    injury_caution: ['knee', 'lower_back', 'shoulder']
  },
  {
    id: 'RIPPER.pdf',
    name: 'Ripper',
    type: 'Superset Training — 4-Day Split (Advanced / High Volume)',
    duration_min: 45,
    equipment: ['dumbbells', 'barbell', 'gym_machines'],
    gym_required: true,
    home_friendly: false,
    days_per_week_hint: 4,
    intensity: 'very_high',
    goals: ['muscle_gain', 'strength', 'hypertrophy', 'advanced_performance', 'maximum_volume'],
    level: ['advanced'],
    gender: 'any',
    muscle_focus: ['full_body', 'chest', 'back', 'biceps', 'triceps', 'shoulders', 'quads', 'glutes'],
    format: 'Same as Ripper 2.0 but MUCH higher volume. Pyramid reps (30,20,10,5×4,10,20,30) vs 2.0 (20,10,5×8). Much heavier loads.',
    exercises: 'D1: Floor Press + Bent-Over Row. D2: Bicep Curl + Tricep Extension. D3: Arnold Press + Shrugs/Upright Row. D4: Leg Press/Squat + Bulgarian Split Squat',
    best_for: 'Advanced gym clients, maximum volume, 4 days/week, high fitness base, experienced lifters',
    not_ideal_for: 'Intermediates (too heavy volume), home training, injury history, fatigue-prone clients',
    injury_caution: ['knee', 'lower_back', 'shoulder', 'elbow']
  },
  {
    id: 'SQUEEZE 2.0 WORKOUT.pdf',
    name: 'Squeeze 2.0',
    type: 'Resistance Band + Dumbbell Upper Body',
    duration_min: 45,
    equipment: ['resistance_bands', 'dumbbells'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate',
    goals: ['muscle_gain', 'toning', 'upper_body_focus', 'home_training', 'recomp'],
    level: ['intermediate'],
    gender: 'any',
    muscle_focus: ['lats', 'chest', 'biceps', 'shoulders', 'upper_back'],
    format: '9 exercises: 6 sets × 45 sec (bands) + 4 sets × 20 reps (dumbbells). 40-50 min.',
    exercises: 'Bent-Over Row, Chest Press, Hammer Curl, Lat Pull-Down, Cross-Over Chest Fly, Bicep Curl, Straight Arm Lat Pulldown, Cross-Body Chest Press, Shoulder Press',
    best_for: 'Home clients, upper body development, intermediate level, band + dumbbell access, upgrade from Squeeze',
    not_ideal_for: 'Leg-focused goals, no equipment, purely cardio',
    injury_caution: ['shoulder', 'elbow', 'wrist']
  },
  {
    id: 'SQUEEZE WORKOUT.pdf',
    name: 'Squeeze Workout',
    type: 'Resistance Band Full Body',
    duration_min: 25,
    equipment: ['resistance_bands'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate',
    goals: ['fat_loss', 'toning', 'general_fitness', 'home_training'],
    level: ['beginner', 'intermediate'],
    gender: 'any',
    muscle_focus: ['quads', 'biceps', 'shoulders', 'triceps', 'obliques'],
    format: '5 exercises × 6 sets × 40 sec work / 20 sec rest. 20-30 min. Resistance bands only.',
    exercises: 'Curl to Squat with ISO Hold, Reverse Lunge + Front & Lateral Raise, Single-Arm Overhead Triceps Extension, Crossed Upright Row, Resistance Band Woodchopper',
    best_for: 'Travel clients, beginners, bands only, quick fat loss sessions, time-pressed',
    not_ideal_for: 'Serious muscle gain, no bands available, gym-only clients',
    injury_caution: ['shoulder', 'knee']
  },
  {
    id: 'STRETCH!.pdf',
    name: 'Stretch!',
    type: 'Full Body Mobility & Recovery',
    duration_min: 20,
    equipment: [],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'very_low',
    goals: ['recovery', 'mobility', 'flexibility', 'injury_prevention'],
    level: ['beginner', 'intermediate', 'advanced'],
    gender: 'any',
    muscle_focus: ['full_body', 'neck', 'hips', 'hip_flexors', 'arms', 'lats', 'core', 'spine', 'lower_body'],
    format: '8 body sections, 5-6 slow controlled stretches per section, breathe through each rep',
    exercises: 'Neck, Hips, Hip Flexors, Arms, Lats, Core, Spine, Lower Body stretching',
    best_for: 'ALL clients as recovery/rest day add-on, injury prevention, mobility-limited clients',
    not_ideal_for: 'Standalone primary training program — always supplement another program',
    injury_caution: []
  },
  {
    id: 'T-REX 1.pdf',
    name: 'T-REX 1',
    type: 'TRX Suspension Training',
    duration_min: 45,
    equipment: ['trx_suspension_trainer'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate_high',
    goals: ['muscle_gain', 'strength', 'general_fitness', 'functional_fitness', 'core_strength'],
    level: ['intermediate'],
    gender: 'any',
    muscle_focus: ['lats', 'biceps', 'chest', 'shoulders', 'quads', 'abs'],
    format: '6 exercises × 45 sec each. 5 straight sets OR 10 circuit rounds. 15 sec rest between sets.',
    exercises: 'TRX Row, TRX Bicep Curl, TRX Push-Up, TRX Lateral Press-Out, TRX Pistol Squat, Row-Hold Press-Out',
    best_for: 'TRX owner, functional fitness, intermediate level, core activation priority',
    not_ideal_for: 'No TRX access, beginners, pure mass/strength goals',
    injury_caution: ['shoulder', 'wrist', 'lower_back']
  },
  {
    id: 'T-REX 2.pdf',
    name: 'T-REX 2',
    type: 'TRX Suspension Training — Progression',
    duration_min: 45,
    equipment: ['trx_suspension_trainer'],
    gym_required: false,
    home_friendly: true,
    days_per_week_hint: null,
    intensity: 'moderate_high',
    goals: ['muscle_gain', 'strength', 'general_fitness', 'functional_fitness', 'rotational_strength'],
    level: ['intermediate', 'advanced'],
    gender: 'any',
    muscle_focus: ['lats', 'biceps', 'chest', 'obliques', 'quads', 'abs'],
    format: 'Same as T-REX 1 but harder exercises: 6 × 45 sec, 5 straight sets or 10 circuits, 15 sec rest',
    exercises: 'Alpine Row, Lateral Bicep Curl, Superman Push-Up, Side Plank, Floating Lunge, Cross-Over Pulls',
    best_for: 'Clients who completed T-REX 1, TRX progression, oblique strength, functional intermediate-advanced',
    not_ideal_for: 'No TRX access, beginners, T-REX 1 not yet mastered',
    injury_caution: ['shoulder', 'oblique', 'lower_back']
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — Embedded program knowledge + Elite coaching framework
// ─────────────────────────────────────────────────────────────────────────────
const BODYBANK_TRAINER_AI_SYSTEM_PROMPT = `You are **BodyBank AI** — the world's most advanced fitness coaching intelligence for admin and trainers at BodyBank.fit. You combine the expertise of a world-class strength coach, nutritionist, sports scientist, and data analyst.

You are TRAINER-FACING ONLY. Never speak as if the client is reading this. Be direct, confident, and ultra-specific. You give exact numbers, specific recommendations, and actionable decisions — never vague suggestions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PRE-COMPUTED METRICS — USE THESE AS GROUND TRUTH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When an ENRICHED CLIENT PACK is present in your context, it contains PRE-COMPUTED METRICS computed by the server (not estimated). Trust these numbers completely. Your job is to interpret them, provide coaching insight, and give action items — not to re-calculate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## COMPLETE PROGRAM LIBRARY — ALL 17 BODYBANK PROGRAMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**HOME / NO GYM PROGRAMS:**
| Program | Type | Duration | Equipment | Intensity | Level | Best Goal |
|---|---|---|---|---|---|---|
| Body Workout 2 | AMRAP Circuit | 10 min | None | Moderate | Beginner-Inter | Fat loss add-on |
| Bodyweight Workout! | Countdown 10-1 | 30 min | Pullup bar | Moderate-High | Beginner-Inter | Conditioning |
| Cycle Sync | 28-day Cycle-Synced | 30-40 min | Dumbbells | Low-Moderate | Beginner-Inter | FEMALES: Hormonal balance, lower body |
| Dumbbell Workout | Full Body Strength | 30 min | Dumbbells/Barbell | Moderate | Intermediate | Muscle gain/Recomp |
| Fat on Fire | Sprint Metabolic | 30 min | Dumbbells | HIGH | Intermediate | Maximum fat loss |
| Flare | Functional Circuit | 40 min | Pullup bar | Moderate | Intermediate | Fun/variety/fat loss |
| Squeeze Workout | Resistance Band | 25 min | Bands only | Moderate | Beginner-Inter | Home fat loss/toning |
| Squeeze 2.0 | Band + Dumbbell | 45 min | Bands + Dumbbells | Moderate | Intermediate | Home upper body muscle |
| Stretch! | Mobility/Recovery | 20 min | None | Very Low | All levels | Recovery + injury prevention |
| T-REX 1 | TRX Suspension | 45 min | TRX only | Moderate-High | Intermediate | Functional strength |
| T-REX 2 | TRX Progression | 45 min | TRX only | Moderate-High | Inter-Advanced | TRX progression from T-REX 1 |

**GYM-REQUIRED PROGRAMS:**
| Program | Type | Duration | Split | Intensity | Level | Best Goal |
|---|---|---|---|---|---|---|
| Ripper 2.0 | Superset 4-Day | 45 min | Push/Pull/Shoulders/Legs | Moderate-High | Intermediate-Advanced | Muscle gain + conditioning |
| Ripper | Superset 4-Day (Heavy) | 45 min | Same as 2.0 | VERY HIGH | Advanced only | Max volume hypertrophy |
| R1 — Chest & Triceps | Rest-Pause Specialization | 50 min | Chest+Triceps day | High | Advanced | Chest/triceps lagging |
| R2 — Legs | Rest-Pause Specialization | 50 min | Legs day | High | Advanced | Leg development |
| R3 — Shoulders & Traps | Rest-Pause Specialization | 50 min | Shoulders day | High | Advanced | Shoulder development |
| R4 — Back & Biceps | Rest-Pause Specialization | 50 min | Back+Biceps day | High | Advanced | Back/bicep specialization |

**R-SERIES NOTE:** R1+R2+R3+R4 can be combined as a complete 4-day split: Day 1=R1 (Push), Day 2=R2 (Legs), Day 3=R3 (Shoulders), Day 4=R4 (Pull). This is the most advanced gym split we offer.

**IMPORTANT — PROGRAM ASSIGNMENT IS THE ADMIN'S DECISION:**
All 17 programs are completely independent. There is no mandatory progression order. The admin assigns any program to any client at any time based on their judgment. Your role is only to SUGGEST the best-fit programs based on the client's actual data (goal, equipment access, fitness level, injuries, activity frequency). Never say "client must progress to X" or "client should move on from Y". Always frame suggestions as: "Based on [client]'s current data, I suggest considering [Program X] because [reason tied to their data]. Final assignment is yours as the trainer."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PROGRAM SUGGESTION FRAMEWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When the admin asks which program to assign, suggest the best fits based on the client's data using this scoring logic:
1. GOAL ALIGNMENT (40 pts): Does the program address their primary goal?
2. EQUIPMENT ACCESS (25 pts): Home or gym? Do they have the required equipment?
3. EXPERIENCE LEVEL (20 pts): Beginner/intermediate/advanced match?
4. FREQUENCY MATCH (10 pts): How many days/week can they train?
5. INJURY SAFETY (5 pts): No contraindicated movements for known injuries?

Always state the score and data-backed reason for the top 3 suggestions. Always use PRE-COMPUTED PROGRAM RECOMMENDATIONS from the context when present. Always end with: "Final program assignment is your call as the trainer."

NEVER say a client "must" or "should" move to a specific program. NEVER imply programs have a fixed order or progression. Each program stands alone.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## SCORE /100 RUBRIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Client score is pre-computed. When explaining it:
- 90-100: Elite compliance + strong goal progress + good recovery
- 75-89: Good progress, minor gaps in nutrition or sleep
- 60-74: Decent effort, compliance or nutrition issues limiting results
- 45-59: Significant compliance problems or goal misalignment
- Below 45: Urgent intervention needed — multiple red flags

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## RESPONSE FORMATS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**FULL CLIENT REPORT** (triggered by: "report for X", "how is X doing", "full report"):
Use this exact structure:
\`\`\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLIENT: [Full Name] | [Email]
PERIOD: [Date range]
PROGRAM: [Assigned program or "None assigned"]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 COMPLIANCE
  Check-ins: X/Y days (Z%)
  Streak: X days | Last check-in: date
  Sunday submissions: X/Y weeks

⚖️ BODY METRICS
  Weight: Xkg → Xkg (▼/▲ Xkg | X.X kg/week)
  Body fat: X% → X% (if logged)
  Trend: [POSITIVE / STALLED / REGRESSING]

🍽️ NUTRITION
  Calories: X kcal avg
  Protein: Xg avg [vs Xg target if known — DEFICIT/SURPLUS]
  Water: X L avg | Sleep: X hrs avg

💪 TRAINING
  Workouts: X sessions | Avg duration: X min
  Bench: Xkg → Xkg (▲Xkg) [if logged]
  Squat: Xkg → Xkg (▲Xkg) [if logged]
  Deadlift: Xkg → Xkg (▲Xkg) [if logged]

📄 PROGRAM STATUS
  Current: [Program name] | Assigned: [date] | [X] weeks on this program
  Program goal: [what this program is designed to achieve per PDF]
  Prescribed workouts/week: [X from PDF]
  Prescribed nutrition: [calories/protein targets from PDF if stated]
  Session structure: [what the program prescribes — e.g. Upper/Lower, Full Body, etc.]
  ─────────────────────────────────
  PRESCRIBED vs ACTUAL:
  Workouts: Program says X/week → Client logged Y/week ([compliant/underperforming])
  Nutrition: Program targets Xcal/Xg protein → Client averaged Ycal/Yg ([on track/deficit])
  Training type match: [Are they doing the right type of sessions?]
  ─────────────────────────────────
  Program fit score: [X/100 — is this still the right program for them?]
  Suggested change: YES / NO — [data-backed reason in one line]
  If YES → top 2 alternatives: [name + score + key reason each]
  ⚑ Final program assignment is the trainer's decision.

🚨 RED FLAGS
  [Only real issues from data. Nothing generic.]

✅ ACTION ITEMS (do these today)
  1. [Specific, numbers-based, immediate action]
  2. [Specific, numbers-based, immediate action]
  3. [Specific, numbers-based, immediate action]

⭐ SCORE: XX/100
  [One line: what's driving it up/down]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
\`\`\`

**DETAILED / MONTHLY REPORT** (triggered by: "detailed report", "monthly report", "complete report", "everything about X"):
This is the FULL deep-dive. Use EVERY data point from the enriched client pack. Miss nothing.
Structure:
\`\`\`
╔══════════════════════════════════════════════════════╗
  DETAILED CLIENT REPORT — [Full Name]
  Period: [from] → [to]  |  Generated: [today's date]
╚══════════════════════════════════════════════════════╝

1. CLIENT PROFILE
   Goal | Experience | Gym access | Days/week | Injuries | Gender
   Audit form goals | Part-2 form goals | What compelled them
   Sports history | Food preferences | Mental health notes | Vices

2. PLATFORM TARGETS
   Target weight | Target BF% | Weekly workout target (all goal entries, newest first)

3. TRIBE STATUS
   Phase | Start date | Starting weight → Current weight → Target weight
   Activity days/week | Trainer notes | Next check-in date

4. ASSIGNED PROGRAM — FULL INTELLIGENCE
   Program name | Assigned date | Weeks on program
   Program type | Intensity level | Gym required: YES/NO
   Program goal (from PDF): [exact goal statement]
   Prescribed workouts/week: [number and types]
   Prescribed session structure: [e.g. Day 1: Upper Push, Day 2: Lower Pull...]
   Prescribed nutrition targets: [calories, protein, any other macros from PDF]
   Progression criteria: [what triggers moving to next phase or level]
   ────────────────────────────────────────────
   PRESCRIBED vs ACTUAL BREAKDOWN:
   Training frequency: Prescribed X → Logged Y → [Gap analysis]
   Session types match: [Are they doing what the program says?]
   Nutrition adherence: Prescribed Xcal/Xg → Logged Ycal/Yg → [Gap %]
   Body composition progress: Expected [X] per program → Actual [Y]
   Overall program compliance: [X%]
   ────────────────────────────────────────────
   If no program assigned: ⚠ NO PROGRAM ASSIGNED
   → Top 3 recommendations from scored list with reasons

5. COMPLIANCE DEEP DIVE
   Daily check-ins: X/Y (Z%)
   Progress logs: X/Y (Z%)
   Sunday check-ins: X/Y weeks (Z%)
   Workouts: X sessions
   Current streak: X days | Longest streak: [compute if possible]
   Last activity: [date]

6. BODY METRICS — FULL TIMELINE
   Weight: List every entry date + value (from progress_logs AND weight_logs)
   Body fat: List every entry
   Net change: Xkg over X days = X.X kg/week
   Trend: POSITIVE / STALLED / REGRESSING + reason

7. NUTRITION — FULL BREAKDOWN
   Every week's average calories + protein
   Overall avg: Xcal | Xg protein | X L water | X hrs sleep
   Deficit/surplus vs target
   Hydration log data (if present)
   Notable days (best/worst)

8. TRAINING — SESSION BY SESSION
   List ALL workout sessions: date | name | duration | feedback
   Strength progression per lift (bench/squat/deadlift) with first → last
   Workout types breakdown
   Missing sessions vs. weekly target

9. SUNDAY CHECK-INS — ALL ENTRIES
   For each Sunday submission:
   Date | Weight/waist | Total loss | Training compliance | Nutrition compliance
   Sleep | Occupation stress | Other stress | Differences felt
   Achievements | What to improve | Questions asked

10. DAILY CHECK-INS — FULL LOG
    Table: Date | Steps | Water | Protein | Sleep

11. MESSAGE HISTORY
    All messages between admin and client in this period

12. MEETINGS
    All scheduled/completed meetings with notes

13. PROGRAM SUGGESTIONS
    Top 5 scored programs with match score and reason (admin assigns at their discretion)

14. RED FLAGS & RISK ANALYSIS
    All flagged issues with severity + root cause + recommended intervention

15. ACTION PLAN
    1. [Immediate — this week]
    2. [Short term — this month]
    3. [Structural — program/nutrition/recovery]
    4. [Mindset/accountability]
    5. [Follow-up checkpoint — date + metric to check]

16. OVERALL SCORE: XX/100
    Score breakdown by category (compliance, nutrition, training, body composition, engagement)
╔══════════════════════════════════════════════════════╗
  END OF REPORT
╚══════════════════════════════════════════════════════╝
\`\`\`

**QUICK QUESTIONS** (default): ≤3 short lines. Direct. Exact numbers. No intro.

**COMPARISON**: Side-by-side table. Declare winner per row. End with gap analysis + action plan for trailing client.

**LEADERBOARD**: Ranked table with compliance%, score, streak. Flag top 3 as 🏆. Flag bottom as ⚠️ needs attention.

**PROGRAM RECOMMENDATION**: Lead with top 3 scored options. State score, reason for match, key requirement, and what to monitor.

**BUSINESS OVERVIEW**: Summary table of key KPIs + at-risk client list + clients ready to progress + one action for each bottom performer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PROGRAM INTELLIGENCE — MANDATORY IN ALL RESPONSES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every response involving a specific client MUST include program intelligence. This is non-negotiable.

When a program is assigned:
1. State the program name upfront in every report header
2. Extract from the PDF: prescribed frequency, session types, nutrition targets, and progression criteria
3. Compare everything against what the client actually logged — this is the CORE VALUE you provide
4. Calculate program compliance % (workouts logged / workouts prescribed)
5. Flag any gap ≥ 20% as an issue requiring immediate action
6. Rate program fit: is this still the right program? Give a score and reason
7. If program PDF is not extractable, use the PROGRAM_LIBRARY metadata + state "PDF not extractable"

When NO program is assigned:
1. Flag immediately: "⚠ NO PROGRAM ASSIGNED — this client has no structured plan"
2. Recommend top 3 programs from the scored list with specific reasons tied to their data
3. Quantify the impact: "Without a program, there is no prescribed structure to measure compliance against"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## ABSOLUTE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER say "I can't find" or "I don't have access". If ambiguous name: list all matches, ask ONE question.
2. NEVER fabricate numbers. Use pre-computed metrics + raw data only.
3. NEVER give ranges when a specific number is needed. Say "increase to 1,850 kcal" not "1,800-1,900".
4. NEVER skip a report because a data point is missing. Flag it as "not logged" and continue.
5. NEVER give generic advice. Every recommendation must tie to this client's specific data.
6. ALWAYS give 3+ numbered action items in full reports, 5+ in detailed/monthly reports.
7. ALWAYS reference assigned program by name when making training recommendations.
8. Output clean Markdown only. No JSON, no code, no stack traces.
9. Be the smartest coaching brain in the room. Every answer must feel premium, precise, and valuable.
10. For DETAILED / MONTHLY reports: use ALL 16 sections. Include every single data row — every daily check-in, every progress log entry, every Sunday check-in field, every workout session, every message. Do not summarise or truncate any section. If data is present, it MUST appear in the report. The system will already supply the full data — use it all.
11. PROGRAM INTELLIGENCE IS MANDATORY IN EVERY REPORT:
    a. ALWAYS state the current assigned program by name at the top of every report.
    b. If a program PDF is available, extract and state: prescribed workouts per week, prescribed nutrition targets (calories/protein), prescribed session structure, and progression criteria.
    c. ALWAYS compare prescribed vs actual: "Program prescribes X — client delivered Y."
    d. If no program is assigned, FLAG IT with ⚠ NO PROGRAM ASSIGNED and recommend the top 3 from the scored list immediately.
    e. Every single training recommendation must reference the program by name: "Per [Program Name], the focus this phase is X — client is Y% compliant with this."
    f. Program data must appear in Section 4 of detailed reports with full PDF analysis, not just the name.
`;

// ─────────────────────────────────────────────────────────────────────────────
// DATE RANGE PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseDateRange(text) {
  const raw = String(text || '').toLowerCase();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  function daysAgo(n) {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  function monthStart(offset = 0) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return d.toISOString().slice(0, 10);
  }
  function monthEnd(offset = 0) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    return d.toISOString().slice(0, 10);
  }
  function weekStart(offset = 0) {
    const d = new Date(now);
    const day = d.getDay() === 0 ? 6 : d.getDay() - 1;
    d.setDate(d.getDate() - day + offset * 7);
    return d.toISOString().slice(0, 10);
  }

  // Specific N days
  const nDays = raw.match(/\blast\s+(\d+)\s+days?\b/) || raw.match(/\bpast\s+(\d+)\s+days?\b/);
  if (nDays) {
    const n = parseInt(nDays[1], 10);
    return { from_date: daysAgo(n), to_date: today, label: `last ${n} days`, days: n };
  }

  // Specific N weeks
  const nWeeks = raw.match(/\blast\s+(\d+)\s+weeks?\b/) || raw.match(/\bpast\s+(\d+)\s+weeks?\b/);
  if (nWeeks) {
    const n = parseInt(nWeeks[1], 10) * 7;
    return { from_date: daysAgo(n), to_date: today, label: `last ${nWeeks[1]} weeks`, days: n };
  }

  if (/\btoday\b/.test(raw)) return { from_date: today, to_date: today, label: 'today', days: 1 };
  if (/\byesterday\b/.test(raw)) return { from_date: daysAgo(1), to_date: daysAgo(1), label: 'yesterday', days: 1 };

  if (/\bthis\s+week\b/.test(raw)) {
    const ws = weekStart(0);
    return { from_date: ws, to_date: today, label: 'this week', days: Math.ceil((new Date(today) - new Date(ws)) / 86400000) + 1 };
  }
  if (/\blast\s+week\b/.test(raw)) {
    const ws = weekStart(-1);
    const we = daysAgo(new Date(now).getDay() === 0 ? 1 : new Date(now).getDay());
    return { from_date: ws, to_date: we, label: 'last week', days: 7 };
  }

  if (/\bthis\s+month\b/.test(raw)) {
    return { from_date: monthStart(0), to_date: today, label: 'this month', days: now.getDate() };
  }
  if (/\blast\s+month\b/.test(raw)) {
    const fm = monthStart(-1);
    const lm = monthEnd(-1);
    const days = Math.ceil((new Date(lm) - new Date(fm)) / 86400000) + 1;
    return { from_date: fm, to_date: lm, label: 'last month', days };
  }

  // Named month like "March 2026"
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (let i = 0; i < monthNames.length; i++) {
    const re = new RegExp('\\b' + monthNames[i] + '\\s+(\\d{4})\\b');
    const m = raw.match(re);
    if (m) {
      const y = parseInt(m[1], 10);
      const fm = new Date(y, i, 1).toISOString().slice(0, 10);
      const lm = new Date(y, i + 1, 0).toISOString().slice(0, 10);
      const days = Math.ceil((new Date(lm) - new Date(fm)) / 86400000) + 1;
      return { from_date: fm, to_date: lm, label: `${m[0]}`, days };
    }
  }

  // Default
  const n = DEFAULT_LOOKBACK_DAYS;
  return { from_date: daysAgo(n), to_date: today, label: `last ${n} days`, days: n };
}

// ─────────────────────────────────────────────────────────────────────────────
// STOPWORDS FOR NAME RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────
const NAME_STOPWORDS = new Set([
  'report','audit','check','the','my','our','give','show','summarize','list','how','what',
  'when','why','full','compare','rank','leaderboard','top','bottom','client','data',
  'nutrition','program','score','last','this','week','month','days','all','any','best',
  'worst','new','latest','recent','is','are','who','which','their','they','get','update',
  'today','yesterday','morning','evening','suggest','recommend','should','help',
  'analysis','analyze','overview','business','stats','metrics','update'
]);

function isLikelyName(chunk) {
  const first = String(chunk || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z']/g, '');
  if (!first || first.length < 2) return false;
  return !NAME_STOPWORDS.has(first);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function qOne(queryAll, sql, params) {
  const rows = await queryAll(sql, params);
  return rows && rows.length ? rows[0] : null;
}

function n(v, fb = 0) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : fb;
}

function avg(arr, key) {
  const vals = arr.map(r => n(r[key])).filter(v => v > 0);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function pct(count, total) {
  if (!total) return null;
  return Math.round((count / total) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF TEXT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────
async function extractPdfText(fs, filePath, maxLen) {
  let parser = null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    parser = new PDFParse({ data: new Uint8Array(buf) });
    const data = await parser.getText();
    let t = String(data.text || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (t.length > maxLen) return `${t.slice(0, maxLen)}\n[... PDF truncated at ${maxLen} chars]`;
    return t;
  } catch (e) {
    return `[PDF extract error: ${e.message}]`;
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      await parser.destroy().catch(() => {});
    }
  }
}

function programFilePath(rootDir, programId) {
  const safe = String(programId || '').replace(/[/\\]/g, '');
  return pathMod.join(rootDir, 'public', 'programs', 'pdfs', safe);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT RESOLUTION — smart name + email matching with disambiguation
// ─────────────────────────────────────────────────────────────────────────────
async function findUsers(queryAll, needle) {
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

async function resolveClientsFromMessage(queryAll, text) {
  const raw = String(text || '');
  const ids = new Set();
  const ambiguous = [];

  // Email exact match
  const emails = raw.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || [];
  for (const em of emails) {
    const row = await qOne(queryAll, `SELECT id FROM users WHERE role = 'user' AND LOWER(email) = LOWER(?)`, [em.trim()]);
    if (row) ids.add(row.id);
  }

  // Extract name-like chunks from patterns
  const patterns = [
    /\bhow\s+is\s+([^,.?\n]+?)\s+doing\b/i,
    /\bfull\s+report\s+(?:for|on|of)\s+([^,.?\n]+)/i,
    /\breport\s+(?:for|on|of)\s+([^,.?\n]+)/i,
    /\bclient\s+score\s+for\s+([^,.?\n]+)/i,
    /\baudit\s+(?:for|on)\s+([^,.?\n]+)/i,
    /\bprogram\s+check\s+(?:for|on)\s+([^,.?\n]+)/i,
    /\bnutrition\s+(?:for|of)\s+([^,.?\n]+)/i,
    /\bcalories?\s+(?:for|of)\s+([^,.?\n]+)/i,
    /\bprotein\s+(?:for|of)\s+([^,.?\n]+)/i,
    /\bwhy\s+is\s+([^,.?\n]+?)\s+(?:stuck|plateau|stalling|not\s+progressing)/i,
    /\bis\s+([A-Za-z][A-Za-z\s.'-]{1,40})\s+following\b/i,
    /\bshould\s+(?:I\s+progress|we\s+progress)\s+([^,.?\n]+)/i,
    /\bgive\s+me\s+([A-Za-z][A-Za-z\s.'-]{1,40})(?:'s\s+data|\s+data|\s+report)\b/i,
    /\b([A-Za-z][A-Za-z\s.'-]{1,40})\s+last\s+\d+\s+days?\b/i,
    /\b(?:for|about)\s+client\s+([^,.?\n]+)/i,
    /\bcompare\s+([^,.?\n]+?)\s+(?:and|vs\.?|with)\s+([^,.?\n]+)/i,
  ];

  const chunks = [];

  // Compare pattern extracts two
  const compareM = raw.match(/\bcompare\s+([^,.?\n]+?)\s+(?:and|vs\.?|with)\s+([^,.?\n]+)/i);
  if (compareM) {
    [compareM[1], compareM[2]].forEach(p => {
      const s = p.replace(/[,.?!].*$/, '').trim();
      if (s.length >= 2 && s.length < 80 && isLikelyName(s)) chunks.push(s);
    });
  } else {
    // Single client patterns
    for (const re of patterns.slice(0, -1)) {
      const m = raw.match(re);
      if (m && m[1]) {
        const s = m[1].replace(/[,.?!].*$/, '').trim();
        if (s.length >= 2 && s.length < 80 && isLikelyName(s)) chunks.push(s);
      }
    }
  }

  const seen = new Set();
  for (const chunk of chunks) {
    const key = chunk.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const users = await findUsers(queryAll, chunk);
    if (users.length === 1) {
      ids.add(users[0].id);
    } else if (users.length > 1) {
      ambiguous.push({
        query: chunk,
        matches: users.map(u => ({ id: u.id, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), email: u.email }))
      });
    }
  }

  return { ids: [...ids], ambiguous };
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC METRIC ENGINE
// ─────────────────────────────────────────────────────────────────────────────
function computeClientMetrics(data) {
  const { progress_logs = [], daily_checkins = [], sunday_checkins = [], workout_logs = [], user_goals, tribe_member, dateRange } = data;
  const days = dateRange ? dateRange.days : DEFAULT_LOOKBACK_DAYS;

  // ── COMPLIANCE ──────────────────────────────────────────────────────────────
  const dailyPct = pct(daily_checkins.length, days);
  const logPct = pct(progress_logs.length, days);
  const sunExpected = Math.max(1, Math.floor(days / 7));
  const sunPct = pct(sunday_checkins.length, sunExpected);
  const lastCheckin = daily_checkins.length
    ? daily_checkins[daily_checkins.length - 1].checkin_date
    : (progress_logs.length ? progress_logs[progress_logs.length - 1].created_at?.slice(0, 10) : null);

  // Streak: count consecutive recent daily check-in days
  let streak = 0;
  if (daily_checkins.length) {
    const dateSet = new Set(daily_checkins.map(r => r.checkin_date?.slice(0, 10)).filter(Boolean));
    const today = new Date().toISOString().slice(0, 10);
    let d = new Date(today);
    while (true) {
      const ds = d.toISOString().slice(0, 10);
      if (dateSet.has(ds)) { streak++; d.setDate(d.getDate() - 1); }
      else break;
      if (streak > 365) break;
    }
  }

  // ── WEIGHT ───────────────────────────────────────────────────────────────────
  const wLogs = progress_logs.filter(r => n(r.weight) > 0);
  const weightFirst = wLogs.length ? n(wLogs[0].weight) : null;
  const weightLast = wLogs.length > 1 ? n(wLogs[wLogs.length - 1].weight) : (wLogs.length ? n(wLogs[0].weight) : null);
  const weightDelta = (weightFirst !== null && weightLast !== null) ? Math.round((weightLast - weightFirst) * 10) / 10 : null;
  const weightPerWeek = (weightDelta !== null && days > 0) ? Math.round((weightDelta / days * 7) * 100) / 100 : null;
  const weightTrend = weightDelta === null ? 'no_data' : weightDelta < -0.2 ? 'decreasing' : weightDelta > 0.2 ? 'increasing' : 'stable';

  // Stall detection: check last 14 days
  const recentWLogs = wLogs.slice(-Math.ceil(14 / Math.max(1, days / Math.max(1, wLogs.length))));
  const stalled = recentWLogs.length >= 3 &&
    Math.abs(n(recentWLogs[recentWLogs.length - 1].weight) - n(recentWLogs[0].weight)) < 0.3;

  // ── BODY FAT ─────────────────────────────────────────────────────────────────
  const bfLogs = progress_logs.filter(r => n(r.body_fat) > 0);
  const bfFirst = bfLogs.length ? n(bfLogs[0].body_fat) : null;
  const bfLast = bfLogs.length > 1 ? n(bfLogs[bfLogs.length - 1].body_fat) : (bfLogs.length ? n(bfLogs[0].body_fat) : null);
  const bfDelta = (bfFirst !== null && bfLast !== null) ? Math.round((bfLast - bfFirst) * 10) / 10 : null;

  // ── NUTRITION ─────────────────────────────────────────────────────────────────
  const avgCal = avg(progress_logs, 'calories_intake');
  const avgProtLog = avg(progress_logs, 'protein_intake');
  const avgProtDaily = avg(daily_checkins, 'protein_g');
  const avgProt = avgProtLog || avgProtDaily;
  const avgWaterLog = avg(progress_logs, 'water_intake'); // litres
  const avgWaterDailyMl = avg(daily_checkins, 'water_ml');
  const avgWater = avgWaterLog || (avgWaterDailyMl ? Math.round(avgWaterDailyMl / 100) / 10 : null);
  const avgSleepLog = avg(progress_logs, 'sleep_hours');
  const avgSleepDaily = avg(daily_checkins, 'sleep_hours');
  const avgSleep = avgSleepLog || avgSleepDaily;

  // ── TRAINING ──────────────────────────────────────────────────────────────────
  const workoutCount = workout_logs.length;
  const durSecs = workout_logs.map(r => n(r.duration_seconds)).filter(v => v > 0);
  const avgDurMin = durSecs.length ? Math.round(durSecs.reduce((a, b) => a + b, 0) / durSecs.length / 60) : null;
  const completedBool = progress_logs.filter(r => r.workout_completed === true || r.workout_completed === 1).length;

  // Lift progression
  function liftTrend(field) {
    const vals = progress_logs.filter(r => n(r[field]) > 0);
    if (!vals.length) return { first: null, last: null, delta: null };
    const f = n(vals[0][field]);
    const l = n(vals[vals.length - 1][field]);
    return { first: f, last: l, delta: Math.round((l - f) * 10) / 10 };
  }
  const bench = liftTrend('strength_bench');
  const squat = liftTrend('strength_squat');
  const deadlift = liftTrend('strength_deadlift');

  // ── GOAL TARGETS ─────────────────────────────────────────────────────────────
  const goalTargetWeight = n(user_goals?.latest?.target_weight) || n(tribe_member?.target_weight) || null;
  const goalProteinMin = weightLast ? Math.round(weightLast * 1.8) : null; // 1.8g/kg for muscle gain

  // ── RISK FLAGS ───────────────────────────────────────────────────────────────
  const riskFlags = [];

  if (stalled && weightDelta !== null)
    riskFlags.push({ code: 'WEIGHT_STALLED', msg: `Weight unchanged (±0.3kg) over last 14 days — plateau risk high` });

  if (avgProt !== null && avgProt < 100)
    riskFlags.push({ code: 'LOW_PROTEIN', msg: `Avg protein ${avgProt}g/day — critically low. Muscle loss risk.` });
  else if (avgProt !== null && goalProteinMin && avgProt < goalProteinMin)
    riskFlags.push({ code: 'PROTEIN_DEFICIT', msg: `Avg protein ${avgProt}g/day vs minimum ${goalProteinMin}g/day for their body weight — ${goalProteinMin - avgProt}g/day deficit` });

  if (avgSleep !== null && avgSleep < 6)
    riskFlags.push({ code: 'POOR_SLEEP', msg: `Avg sleep ${avgSleep} hrs/night — below 6hrs. Cortisol elevated, recovery compromised, water retention likely.` });

  if (dailyPct !== null && dailyPct < 50)
    riskFlags.push({ code: 'LOW_COMPLIANCE', msg: `Daily check-in rate ${dailyPct}% — below 50%. Data unreliable, behaviour coaching needed.` });

  if (workoutCount === 0 && days >= 7)
    riskFlags.push({ code: 'NO_WORKOUTS', msg: `Zero workouts logged in last ${days} days.` });

  if (avgCal !== null && avgCal < 1200)
    riskFlags.push({ code: 'VERY_LOW_CALORIES', msg: `Avg ${avgCal} kcal/day — dangerously low. Risk of metabolic slowdown and muscle loss.` });

  if (sunday_checkins.length === 0 && days >= 14)
    riskFlags.push({ code: 'NO_SUNDAY_CHECKIN', msg: `No Sunday check-in submitted in last ${days} days — accountability gap.` });

  // ── CLIENT SCORE /100 ────────────────────────────────────────────────────────
  let score = 0;

  // Compliance (30 pts)
  score += Math.round(Math.min(15, (dailyPct || 0) / 100 * 15));
  score += Math.round(Math.min(10, (logPct || 0) / 100 * 10));
  score += sunday_checkins.length > 0 ? 5 : 0;

  // Goal progress (25 pts)
  if (weightDelta !== null) {
    // Default: assume fat loss (most common)
    if (weightDelta < -0.1) score += 15; // losing weight
    else if (Math.abs(weightDelta) <= 0.3) score += 8; // stable
    // gaining: 5 (could be muscle gain goal)
    else score += 5;
  } else score += 8; // no data: neutral
  if (bfDelta !== null) { score += bfDelta < 0 ? 10 : bfDelta === 0 ? 5 : 0; }
  else score += 5; // no data: neutral

  // Nutrition (20 pts)
  if (avgProt !== null) {
    score += avgProt >= 150 ? 10 : avgProt >= 120 ? 7 : avgProt >= 100 ? 4 : 0;
  } else score += 5;
  if (avgCal !== null) {
    score += (avgCal >= 1400 && avgCal <= 2800) ? 10 : avgCal < 1400 ? 5 : 8;
  } else score += 5;

  // Consistency (15 pts)
  score += Math.min(15, streak * 3);

  // Recovery (10 pts)
  if (avgSleep !== null) {
    score += avgSleep >= 7 ? 10 : avgSleep >= 6 ? 7 : avgSleep >= 5 ? 4 : 0;
  } else score += 5;

  score = Math.min(100, Math.max(0, score));

  // Score drivers explanation
  const scoreDrivers = [];
  if (streak >= 5) scoreDrivers.push(`${streak}-day check-in streak`);
  if (bench.delta > 0) scoreDrivers.push(`bench +${bench.delta}kg progression`);
  if (weightDelta !== null && weightDelta < -0.5) scoreDrivers.push(`weight trending down (${weightDelta}kg)`);
  if (avgSleep !== null && avgSleep < 6) scoreDrivers.push(`poor sleep (${avgSleep}h) pulling score down`);
  if (avgProt !== null && goalProteinMin && avgProt < goalProteinMin)
    scoreDrivers.push(`protein deficit (${avgProt}g vs ${goalProteinMin}g target)`);
  if (dailyPct !== null && dailyPct < 60) scoreDrivers.push(`low check-in compliance (${dailyPct}%)`);

  return {
    compliance: {
      daily_checkins: { count: daily_checkins.length, expected: days, pct: dailyPct },
      progress_logs: { count: progress_logs.length, expected: days, pct: logPct },
      sunday_checkins: { count: sunday_checkins.length, expected: sunExpected, pct: sunPct },
      workouts_logged: workoutCount,
      streak_days: streak,
      last_checkin: lastCheckin
    },
    weight: { first: weightFirst, last: weightLast, delta: weightDelta, per_week: weightPerWeek, trend: weightTrend, logs_count: wLogs.length },
    body_fat: { first: bfFirst, last: bfLast, delta: bfDelta, logs_count: bfLogs.length },
    nutrition: {
      avg_calories: avgCal, avg_protein_g: avgProt, avg_water_l: avgWater, avg_sleep_hrs: avgSleep,
      protein_target_min_g: goalProteinMin
    },
    training: {
      workouts_completed: workoutCount, avg_duration_min: avgDurMin, completed_from_logs: completedBool,
      bench, squat, deadlift
    },
    goals: { target_weight: goalTargetWeight, weekly_workout_target: n(user_goals?.latest?.weekly_workout_target) || null, target_body_fat: n(user_goals?.latest?.target_body_fat) || null },
    risk_flags: riskFlags,
    score,
    score_drivers: scoreDrivers
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROGRAM RECOMMENDATION ENGINE — scores all 17 programs for user profile
// ─────────────────────────────────────────────────────────────────────────────
function extractUserProfile(pack) {
  const audit = pack.latest_audit || {};
  const part2 = pack.latest_part2 || {};
  const tribe = pack.tribe_member || {};

  const goalRaw = String(part2.goals || audit.goals || tribe.notes || '').toLowerCase();
  let goal = 'general_fitness';
  if (/fat|weight\s*loss|slim|lean|cut/.test(goalRaw)) goal = 'fat_loss';
  else if (/muscle|bulk|mass|gain|hyper/.test(goalRaw)) goal = 'muscle_gain';
  else if (/recomp|body.*comp/.test(goalRaw)) goal = 'recomp';
  else if (/flex|stretch|mobil/.test(goalRaw)) goal = 'flexibility';
  else if (/perform|athletic|sport/.test(goalRaw)) goal = 'performance';
  else if (/hormonal|cycle|pcod|pcos|female/.test(goalRaw)) goal = 'hormonal_balance';

  const expRaw = String(part2.gym_experience || audit.fitness_experience || '').toLowerCase();
  let experience_level = 'beginner';
  if (/\b(advanced|expert|years?|experienced)\b/.test(expRaw)) experience_level = 'advanced';
  else if (/\b(intermediate|moderate|some\s+experience)\b/.test(expRaw)) experience_level = 'intermediate';

  const gymRaw = String(part2.gym_experience || '').toLowerCase();
  const gym_access = /gym|weight|machine|cable|barbell/.test(gymRaw);

  const injuryRaw = String(part2.injuries || '').toLowerCase();
  const injuries = [];
  ['knee','shoulder','back','lower_back','elbow','hip','ankle','wrist','neck'].forEach(inj => {
    if (injuryRaw.includes(inj.replace('_', ' '))) injuries.push(inj);
  });

  const activityRaw = String(part2.activity_level || tribe.activity_per_week || '').toLowerCase();
  let activity_days = 3;
  const daysM = activityRaw.match(/(\d+)\s*(?:day|x\/week)/);
  if (daysM) activity_days = parseInt(daysM[1], 10);
  else if (/\b5|five\b/.test(activityRaw)) activity_days = 5;
  else if (/\b4|four\b/.test(activityRaw)) activity_days = 4;
  else if (/\b2|two\b/.test(activityRaw)) activity_days = 2;
  else if (tribe.activity_per_week) activity_days = n(tribe.activity_per_week) || 3;

  const nameRaw = String(pack.user?.name || '').toLowerCase();
  const genderRaw = String(part2.goals || audit.goals || '').toLowerCase();
  let gender = 'unknown';
  if (/\b(female|woman|women|girl|she|her)\b/.test(genderRaw + injuryRaw + goalRaw)) gender = 'female';
  else if (/\b(male|man|men|boy|he|him)\b/.test(genderRaw + injuryRaw + goalRaw)) gender = 'male';

  return { goal, experience_level, gym_access, injuries, activity_days, gender };
}

function scoreUserForProgram(profile, program) {
  let score = 0;

  // GOAL FIT (40 pts)
  const goalMap = {
    fat_loss: ['fat_loss', 'weight_loss', 'metabolic_boost', 'calorie_burn', 'general_fitness'],
    muscle_gain: ['muscle_gain', 'strength', 'hypertrophy', 'recomp', 'specialization'],
    recomp: ['recomp', 'muscle_gain', 'fat_loss', 'general_fitness'],
    general_fitness: ['general_fitness', 'endurance', 'conditioning', 'functional_fitness', 'fun_factor', 'core_strength'],
    flexibility: ['recovery', 'mobility', 'flexibility', 'injury_prevention'],
    performance: ['strength', 'advanced_performance', 'functional_fitness', 'general_performance'],
    hormonal_balance: ['hormonal_balance', 'women_specific', 'lower_body', 'general_fitness']
  };
  const userGoalTags = goalMap[profile.goal] || goalMap.general_fitness;
  const overlap = program.goals.filter(g => userGoalTags.includes(g)).length;
  score += Math.min(40, overlap * 15);

  // EQUIPMENT FIT (25 pts)
  if (profile.gym_access) {
    score += 25; // gym access works for all programs
  } else {
    score += program.home_friendly ? (program.gym_required ? 0 : 25) : 0;
  }

  // LEVEL FIT (20 pts)
  if (program.level.includes(profile.experience_level)) score += 20;
  else if (
    (profile.experience_level === 'advanced' && program.level.includes('intermediate')) ||
    (profile.experience_level === 'intermediate' && program.level.includes('beginner'))
  ) score += 12;
  else score += 3;

  // FREQUENCY FIT (10 pts)
  if (!program.days_per_week_hint) {
    score += 7; // flexible programs
  } else {
    const diff = Math.abs(program.days_per_week_hint - profile.activity_days);
    score += diff === 0 ? 10 : diff === 1 ? 7 : diff === 2 ? 4 : 1;
  }

  // INJURY SAFETY (5 pts)
  const conflict = program.injury_caution.some(ic =>
    profile.injuries.some(inj => ic.includes(inj) || inj.includes(ic))
  );
  score += conflict ? 0 : 5;

  // GENDER PENALTY for Cycle Sync if male
  if (program.id === 'Cycle Sync.pdf' && profile.gender === 'male') score = Math.max(0, score - 30);

  return Math.min(100, Math.round(score));
}

function recommendPrograms(profile) {
  return PROGRAM_LIBRARY
    .map(prog => ({ ...prog, match_score: scoreUserForProgram(profile, prog) }))
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 5)
    .map(p => ({
      name: p.name,
      id: p.id,
      match_score: p.match_score,
      duration_min: p.duration_min,
      intensity: p.intensity,
      gym_required: p.gym_required,
      best_for: p.best_for,
      not_ideal_for: p.not_ideal_for
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD FULL CLIENT PACK
// ─────────────────────────────────────────────────────────────────────────────
async function buildClientPack(deps, userId, dateRange, detailed = false) {
  const { queryAll, fs, rootDir } = deps;
  const user = await qOne(queryAll, 'SELECT id, first_name, last_name, email FROM users WHERE id = ?', [userId]);
  if (!user) return null;

  const email = (user.email || '').toLowerCase();
  const dr = dateRange || parseDateRange('');
  const fromIso = `${dr.from_date}T00:00:00.000Z`;
  const toIso = `${dr.to_date}T23:59:59.999Z`;

  // Detailed mode: no row limits on any table
  const workoutLimit = detailed ? '' : 'LIMIT 50';
  const sundayLimit = detailed ? '' : 'LIMIT 12';
  const meetingLimit = detailed ? '' : 'LIMIT 5';

  const [programs, progress, daily, sunday, workouts, audit, part2, tribe, meetings, goals,
         hydration, weightLogs, threads] = await Promise.all([
    // All assigned programs
    queryAll(
      `SELECT a.assigned_at, p.id as program_id, p.name as program_name, p.pdf_url
       FROM user_program_assignments a JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ? AND a.removed_at IS NULL ORDER BY a.assigned_at DESC`,
      [userId]
    ),
    // All progress logs (every field)
    queryAll(
      `SELECT weight, body_fat, calories_intake, protein_intake, workout_completed, workout_type,
              strength_bench, strength_squat, strength_deadlift, sleep_hours, water_intake, created_at
       FROM progress_logs WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at <= ?::timestamptz ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ),
    // All daily check-ins
    queryAll(
      `SELECT checkin_date, steps, water_ml, protein_g, sleep_hours, created_at
       FROM daily_checkins WHERE user_id = ? AND checkin_date >= ?::date AND checkin_date <= ?::date ORDER BY checkin_date ASC`,
      [userId, dr.from_date, dr.to_date]
    ),
    // All Sunday check-ins — every single field
    queryAll(
      `SELECT plan, current_weight_waist_week, last_week_weight_waist, total_weight_loss,
              training_go, nutrition_go, sleep, occupation_stress, other_stress,
              differences_felt, achievements, improve_next_week, questions, created_at
       FROM sunday_checkins WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at <= ?::timestamptz ORDER BY created_at DESC ${sundayLimit}`,
      [userId, fromIso, toIso]
    ),
    // All workouts
    queryAll(
      `SELECT workout_name, duration_seconds, feedback, created_at FROM workout_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at <= ?::timestamptz ORDER BY created_at ASC ${workoutLimit}`,
      [userId, fromIso, toIso]
    ),
    // Full audit form
    queryAll(
      `SELECT first_name, last_name, email, city, goals, status, fitness_experience, motivation, created_at
       FROM audit_requests WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1`,
      [email]
    ),
    // Full Part-2 intake
    queryAll(
      `SELECT name, email, mobile, activity_level, sports_history, injuries, mental_health, gym_experience,
              food_choices, vices_addictions, goals, what_compelled, created_at
       FROM part2_audit WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1`,
      [email]
    ),
    // Tribe member row
    queryAll(
      `SELECT phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, status, notes, next_checkin
       FROM tribe_members WHERE LOWER(email) = ? ORDER BY start_date DESC LIMIT 1`,
      [email]
    ),
    // Meetings
    queryAll(
      `SELECT meeting_date, time_slot, status, notes, created_at FROM meetings
       WHERE user_id = ? ORDER BY created_at DESC ${meetingLimit}`,
      [userId]
    ),
    // All user_goals entries
    queryAll(
      `SELECT target_weight, target_body_fat, weekly_workout_target, created_at
       FROM user_goals WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    ),
    // Hydration logs
    queryAll(
      `SELECT amount_ml, glasses, created_at FROM hydration_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at <= ?::timestamptz ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ).catch(() => []),
    // Dedicated weight logs
    queryAll(
      `SELECT weight_kg, created_at FROM weight_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at <= ?::timestamptz ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ).catch(() => []),
    // Admin–client message threads (last 20 messages)
    queryAll(
      `SELECT tm.body, tm.sender_role, tm.created_at
       FROM thread_messages tm
       JOIN message_threads mt ON mt.id = tm.thread_id
       WHERE mt.user_id = ? AND tm.created_at >= ?::timestamptz AND tm.created_at <= ?::timestamptz
       ORDER BY tm.created_at ASC LIMIT 20`,
      [userId, fromIso, toIso]
    ).catch(() => [])
  ]);

  // Extract full PDF text for ALL assigned programs
  const programBlocks = [];
  for (const p of programs) {
    const fp = programFilePath(rootDir, p.program_id);
    const txt = await extractPdfText(fs, fp, MAX_PDF_TEXT);
    programBlocks.push({ ...p, extracted_pdf_text: txt || null });
  }

  const packData = {
    user_goals: { latest: goals[0] || null, history: goals },
    latest_audit: audit[0] || null,
    latest_part2: part2[0] || null,
    tribe_member: tribe[0] || null,
    progress_logs: progress,
    daily_checkins: daily,
    sunday_checkins: sunday,
    workout_logs: workouts,
    hydration_logs: hydration,
    weight_logs: weightLogs,
    message_history: threads,
    dateRange: dr
  };

  const metrics = computeClientMetrics(packData);
  const userProfile = extractUserProfile({ ...packData, user: { name: `${user.first_name || ''} ${user.last_name || ''}`.trim() } });
  const recommendations = recommendPrograms(userProfile);

  return {
    user: { id: user.id, name: `${user.first_name || ''} ${user.last_name || ''}`.trim(), email: user.email },
    period: dr,
    detailed,
    user_profile: userProfile,
    computed_metrics: metrics,
    assigned_programs: programBlocks,
    program_recommendations: recommendations,
    user_goals: packData.user_goals,
    latest_audit: packData.latest_audit,
    latest_part2: packData.latest_part2,
    tribe_member: packData.tribe_member,
    recent_meetings: meetings,
    raw_data: {
      progress_logs: progress,
      daily_checkins: daily,
      sunday_checkins: sunday,
      workout_logs: workouts,
      hydration_logs: hydration,
      weight_logs: weightLogs,
      message_history: threads
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT ENRICHED CLIENT PACK AS HUMAN-READABLE TEXT (for system context)
// detailed=true → every single row of every table, nothing truncated
// ─────────────────────────────────────────────────────────────────────────────
function formatPackAsText(pack) {
  const m = pack.computed_metrics;
  const u = pack.user;
  const dr = pack.period;
  const detailed = pack.detailed || false;
  const rd = pack.raw_data;
  const lines = [];

  lines.push(`\n${'═'.repeat(60)}`);
  lines.push(`ENRICHED CLIENT PACK: ${u.name} (${u.email})${detailed ? ' — DETAILED / FULL REPORT MODE' : ''}`);
  lines.push(`PERIOD: ${dr.label} (${dr.from_date} → ${dr.to_date}, ${dr.days} days)`);
  lines.push(`${'═'.repeat(60)}`);

  // ── USER PROFILE ─────────────────────────────────────────────────────────────
  const prof = pack.user_profile;
  lines.push(`\n[USER PROFILE]`);
  lines.push(`  Goal: ${prof.goal.replace(/_/g, ' ').toUpperCase()}`);
  lines.push(`  Experience level: ${prof.experience_level}`);
  lines.push(`  Gym access: ${prof.gym_access ? 'YES' : 'NO (home training)'}`);
  lines.push(`  Activity: ${prof.activity_days} days/week`);
  lines.push(`  Injuries: ${prof.injuries.length ? prof.injuries.join(', ') : 'none reported'}`);
  lines.push(`  Gender: ${prof.gender}`);

  // ── USER GOALS (platform targets) ────────────────────────────────────────────
  if (pack.user_goals?.history?.length) {
    lines.push(`\n[PLATFORM GOALS (user_goals table — all entries)]`);
    pack.user_goals.history.forEach((g, i) => {
      lines.push(`  ${i === 0 ? 'LATEST' : `Entry ${i + 1}`} (${g.created_at?.slice(0, 10)}): Target weight: ${g.target_weight ?? 'not set'}kg | Target BF%: ${g.target_body_fat ?? 'not set'}% | Weekly workouts: ${g.weekly_workout_target ?? 'not set'}`);
    });
  } else {
    lines.push(`\n[PLATFORM GOALS]: Not set`);
  }

  // ── TRIBE ─────────────────────────────────────────────────────────────────────
  if (pack.tribe_member) {
    const t = pack.tribe_member;
    lines.push(`\n[TRIBE MEMBER DATA]`);
    lines.push(`  Status: ${t.status} | Phase: ${t.phase} | Started: ${t.start_date}`);
    lines.push(`  Starting weight: ${t.starting_weight ?? '-'}kg | Current: ${t.current_weight ?? '-'}kg | Target: ${t.target_weight ?? '-'}kg`);
    lines.push(`  Activity per week: ${t.activity_per_week ?? '-'} days`);
    if (t.notes) lines.push(`  Trainer notes: ${t.notes}`);
    if (t.next_checkin) lines.push(`  Next check-in scheduled: ${t.next_checkin}`);
  } else {
    lines.push(`\n[TRIBE MEMBER DATA]: Not in tribe`);
  }

  // ── ONBOARDING AUDIT ─────────────────────────────────────────────────────────
  if (pack.latest_audit) {
    const a = pack.latest_audit;
    lines.push(`\n[ONBOARDING AUDIT FORM (submitted ${a.created_at?.slice(0, 10)})]`);
    lines.push(`  Name: ${a.first_name || ''} ${a.last_name || ''} | City: ${a.city || '-'}`);
    if (a.goals) lines.push(`  Goals stated: ${a.goals}`);
    if (a.fitness_experience) lines.push(`  Fitness experience: ${a.fitness_experience}`);
    if (a.motivation) lines.push(`  Motivation: ${a.motivation}`);
    lines.push(`  Status: ${a.status}`);
  } else {
    lines.push(`\n[ONBOARDING AUDIT FORM]: Not submitted`);
  }

  // ── PART-2 INTAKE FORM (full) ─────────────────────────────────────────────────
  if (pack.latest_part2) {
    const p2 = pack.latest_part2;
    lines.push(`\n[PART-2 DEEP INTAKE FORM (submitted ${p2.created_at?.slice(0, 10)})]`);
    if (p2.goals) lines.push(`  Goals: ${p2.goals}`);
    if (p2.injuries) lines.push(`  Injuries / medical: ${p2.injuries}`);
    if (p2.mental_health) lines.push(`  Mental health notes: ${p2.mental_health}`);
    if (p2.gym_experience) lines.push(`  Gym experience: ${p2.gym_experience}`);
    if (p2.activity_level) lines.push(`  Activity level: ${p2.activity_level}`);
    if (p2.sports_history) lines.push(`  Sports history: ${p2.sports_history}`);
    if (p2.food_choices) lines.push(`  Food preferences: ${p2.food_choices}`);
    if (p2.vices_addictions) lines.push(`  Vices / addictions: ${p2.vices_addictions}`);
    if (p2.what_compelled) lines.push(`  What compelled them: ${p2.what_compelled}`);
    if (p2.mobile) lines.push(`  Mobile: ${p2.mobile}`);
  } else {
    lines.push(`\n[PART-2 DEEP INTAKE FORM]: Not submitted`);
  }

  // ── ASSIGNED PROGRAMS (full PDF text) ────────────────────────────────────────
  if (pack.assigned_programs.length) {
    lines.push(`\n[ASSIGNED PROGRAMS — ${pack.assigned_programs.length} total]`);
    pack.assigned_programs.forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.program_name} (assigned ${p.assigned_at?.slice(0, 10)})`);
      if (p.extracted_pdf_text) {
        lines.push(`     FULL PDF CONTENT:\n     ${p.extracted_pdf_text}`);
      } else {
        lines.push(`     PDF: not extractable (may be scanned image)`);
      }
    });
  } else {
    lines.push(`\n[ASSIGNED PROGRAMS]: None assigned`);
  }

  // ── PRE-COMPUTED METRICS ──────────────────────────────────────────────────────
  lines.push(`\n${'─'.repeat(50)}`);
  lines.push(`PRE-COMPUTED METRICS — GROUND TRUTH (server-computed)`);
  lines.push(`${'─'.repeat(50)}`);

  lines.push(`\nCOMPLIANCE:`);
  lines.push(`  Daily check-ins: ${m.compliance.daily_checkins.count}/${m.compliance.daily_checkins.expected} days (${m.compliance.daily_checkins.pct ?? 'n/a'}%)`);
  lines.push(`  Progress logs: ${m.compliance.progress_logs.count}/${m.compliance.progress_logs.expected} days (${m.compliance.progress_logs.pct ?? 'n/a'}%)`);
  lines.push(`  Sunday check-ins: ${m.compliance.sunday_checkins.count}/${m.compliance.sunday_checkins.expected} weeks (${m.compliance.sunday_checkins.pct ?? 'n/a'}%)`);
  lines.push(`  Workouts logged: ${m.compliance.workouts_logged}`);
  lines.push(`  Current streak: ${m.compliance.streak_days} days`);
  lines.push(`  Last check-in: ${m.compliance.last_checkin || 'never'}`);

  lines.push(`\nWEIGHT & BODY COMPOSITION:`);
  if (m.weight.first !== null) {
    const arr = m.weight.delta < 0 ? '▼' : m.weight.delta > 0 ? '▲' : '→';
    lines.push(`  ${m.weight.first}kg → ${m.weight.last}kg (${arr} ${Math.abs(m.weight.delta)}kg total | ${m.weight.per_week >= 0 ? '+' : ''}${m.weight.per_week}kg/week)`);
    lines.push(`  Trend: ${m.weight.trend.toUpperCase()} | Based on ${m.weight.logs_count} progress logs`);
  } else lines.push(`  Weight (progress_logs): not logged this period`);

  if (rd.weight_logs?.length) {
    const wl = rd.weight_logs;
    lines.push(`  Dedicated weight_logs: ${wl.length} entries | First: ${wl[0].weight_kg}kg (${wl[0].created_at?.slice(0, 10)}) → Last: ${wl[wl.length-1].weight_kg}kg (${wl[wl.length-1].created_at?.slice(0, 10)})`);
  }

  if (m.body_fat.first !== null) {
    const arr = m.body_fat.delta < 0 ? '▼' : m.body_fat.delta > 0 ? '▲' : '→';
    lines.push(`  Body fat: ${m.body_fat.first}% → ${m.body_fat.last}% (${arr} ${Math.abs(m.body_fat.delta)}%)`);
  } else lines.push(`  Body fat: not logged`);

  lines.push(`\nNUTRITION:`);
  lines.push(`  Avg calories: ${m.nutrition.avg_calories ?? 'not logged'} kcal/day`);
  if (m.nutrition.avg_protein_g !== null) {
    const pt = m.nutrition.protein_target_min_g;
    const gap = pt ? ` — ${pt - m.nutrition.avg_protein_g > 0 ? `DEFICIT: ${pt - m.nutrition.avg_protein_g}g/day below ${pt}g target` : `OK (meets minimum ${pt}g target)`}` : '';
    lines.push(`  Avg protein: ${m.nutrition.avg_protein_g}g/day${gap}`);
  } else lines.push(`  Avg protein: not logged`);
  lines.push(`  Avg water: ${m.nutrition.avg_water_l ?? 'not logged'} L/day`);
  lines.push(`  Avg sleep: ${m.nutrition.avg_sleep_hrs ?? 'not logged'} hrs/night`);

  if (rd.hydration_logs?.length) {
    const totalMl = rd.hydration_logs.reduce((s, r) => s + (n(r.amount_ml) || 0), 0);
    const avgGlasses = rd.hydration_logs.reduce((s, r) => s + (n(r.glasses) || 0), 0) / rd.hydration_logs.length;
    lines.push(`  Hydration logs (dedicated table): ${rd.hydration_logs.length} entries | Total: ${totalMl}ml | Avg glasses/day: ${avgGlasses.toFixed(1)}`);
  }

  lines.push(`\nTRAINING:`);
  lines.push(`  Workouts: ${m.training.workouts_completed} sessions | Avg duration: ${m.training.avg_duration_min ?? 'n/a'} min`);
  if (m.training.bench.first !== null) lines.push(`  Bench press: ${m.training.bench.first}kg → ${m.training.bench.last}kg (${m.training.bench.delta >= 0 ? '▲' : '▼'} ${Math.abs(m.training.bench.delta)}kg)`);
  else lines.push(`  Bench press: not logged`);
  if (m.training.squat.first !== null) lines.push(`  Squat: ${m.training.squat.first}kg → ${m.training.squat.last}kg (${m.training.squat.delta >= 0 ? '▲' : '▼'} ${Math.abs(m.training.squat.delta)}kg)`);
  else lines.push(`  Squat: not logged`);
  if (m.training.deadlift.first !== null) lines.push(`  Deadlift: ${m.training.deadlift.first}kg → ${m.training.deadlift.last}kg (${m.training.deadlift.delta >= 0 ? '▲' : '▼'} ${Math.abs(m.training.deadlift.delta)}kg)`);
  else lines.push(`  Deadlift: not logged`);

  lines.push(`\nCLIENT SCORE: ${m.score}/100`);
  if (m.score_drivers.length) lines.push(`  Drivers: ${m.score_drivers.join(' | ')}`);

  lines.push(`\nRISK FLAGS:`);
  if (m.risk_flags.length) m.risk_flags.forEach(f => lines.push(`  ⚠ [${f.code}] ${f.msg}`));
  else lines.push(`  None — client is on track`);

  // ── PROGRAM SUGGESTIONS ───────────────────────────────────────────────────────
  lines.push(`\n[PROGRAM SUGGESTIONS (all 17 scored — admin assigns at their discretion)]`);
  pack.program_recommendations.forEach((p, i) => {
    lines.push(`  ${i + 1}. ${p.name} — ${p.match_score}/100 | ${p.duration_min}min | ${p.intensity} | Gym: ${p.gym_required ? 'YES' : 'NO'}`);
    lines.push(`     Best for: ${p.best_for}`);
  });

  // ── MEETINGS ──────────────────────────────────────────────────────────────────
  if (pack.recent_meetings?.length) {
    lines.push(`\n[ALL MEETINGS (${pack.recent_meetings.length} in period)]`);
    pack.recent_meetings.forEach(mt => {
      lines.push(`  ${mt.meeting_date} ${mt.time_slot} | ${mt.status}${mt.notes ? ' | Notes: ' + mt.notes : ''}`);
    });
  } else {
    lines.push(`\n[MEETINGS]: None in this period`);
  }

  // ── MESSAGE HISTORY ───────────────────────────────────────────────────────────
  if (rd.message_history?.length) {
    lines.push(`\n[ADMIN–CLIENT MESSAGE HISTORY (${rd.message_history.length} messages in period)]`);
    rd.message_history.forEach(msg => {
      lines.push(`  [${msg.sender_role.toUpperCase()}] ${msg.created_at?.slice(0, 10)}: ${msg.body}`);
    });
  } else {
    lines.push(`\n[ADMIN–CLIENT MESSAGES]: None in this period`);
  }

  // ── ALL SUNDAY CHECK-INS (every field) ────────────────────────────────────────
  if (rd.sunday_checkins.length) {
    lines.push(`\n[ALL SUNDAY CHECK-INS — ${rd.sunday_checkins.length} submission(s)]`);
    rd.sunday_checkins.forEach((s, i) => {
      lines.push(`\n  Sunday #${i + 1} — ${s.created_at?.slice(0, 10)}`);
      if (s.plan) lines.push(`    Plan / week summary: ${s.plan}`);
      if (s.current_weight_waist_week) lines.push(`    Weight/waist this week: ${s.current_weight_waist_week}`);
      if (s.last_week_weight_waist) lines.push(`    Last week weight/waist: ${s.last_week_weight_waist}`);
      if (s.total_weight_loss) lines.push(`    Total weight loss to date: ${s.total_weight_loss}`);
      if (s.training_go) lines.push(`    Training compliance: ${s.training_go}`);
      if (s.nutrition_go) lines.push(`    Nutrition compliance: ${s.nutrition_go}`);
      if (s.sleep) lines.push(`    Sleep notes: ${s.sleep}`);
      if (s.occupation_stress) lines.push(`    Occupation stress: ${s.occupation_stress}`);
      if (s.other_stress) lines.push(`    Other stress: ${s.other_stress}`);
      if (s.differences_felt) lines.push(`    Differences felt: ${s.differences_felt}`);
      if (s.achievements) lines.push(`    Achievements: ${s.achievements}`);
      if (s.improve_next_week) lines.push(`    Improve next week: ${s.improve_next_week}`);
      if (s.questions) lines.push(`    Questions: ${s.questions}`);
    });
  } else {
    lines.push(`\n[SUNDAY CHECK-INS]: None in this period`);
  }

  // ── ALL DAILY CHECK-INS (every row) ──────────────────────────────────────────
  if (rd.daily_checkins.length) {
    lines.push(`\n[ALL DAILY CHECK-INS — ${rd.daily_checkins.length} days]`);
    if (detailed) {
      rd.daily_checkins.forEach(d => {
        lines.push(`  ${d.checkin_date} | Steps: ${d.steps ?? '-'} | Water: ${d.water_ml ?? '-'}ml | Protein: ${d.protein_g ?? '-'}g | Sleep: ${d.sleep_hours ?? '-'}hrs`);
      });
    } else {
      // Standard: first + last 5 + summary
      const show = [...rd.daily_checkins.slice(0, 3), ...(rd.daily_checkins.length > 6 ? ['...'] : []), ...rd.daily_checkins.slice(-3)];
      show.forEach(d => {
        if (d === '...') { lines.push(`  ... (${rd.daily_checkins.length - 6} more rows) ...`); return; }
        lines.push(`  ${d.checkin_date} | Steps: ${d.steps ?? '-'} | Water: ${d.water_ml ?? '-'}ml | Protein: ${d.protein_g ?? '-'}g | Sleep: ${d.sleep_hours ?? '-'}hrs`);
      });
    }
  } else {
    lines.push(`\n[DAILY CHECK-INS]: None in this period`);
  }

  // ── ALL PROGRESS LOGS (every row) ────────────────────────────────────────────
  if (rd.progress_logs.length) {
    lines.push(`\n[ALL PROGRESS LOGS — ${rd.progress_logs.length} entries]`);
    if (detailed) {
      rd.progress_logs.forEach(p => {
        const parts = [`  ${p.created_at?.slice(0, 10)}`];
        if (n(p.weight)) parts.push(`Weight:${p.weight}kg`);
        if (n(p.body_fat)) parts.push(`BF:${p.body_fat}%`);
        if (n(p.calories_intake)) parts.push(`Cal:${p.calories_intake}kcal`);
        if (n(p.protein_intake)) parts.push(`Prot:${p.protein_intake}g`);
        if (p.workout_completed) parts.push(`Workout:${p.workout_type || 'yes'}`);
        if (n(p.strength_bench)) parts.push(`Bench:${p.strength_bench}kg`);
        if (n(p.strength_squat)) parts.push(`Squat:${p.strength_squat}kg`);
        if (n(p.strength_deadlift)) parts.push(`DL:${p.strength_deadlift}kg`);
        if (n(p.sleep_hours)) parts.push(`Sleep:${p.sleep_hours}h`);
        if (n(p.water_intake)) parts.push(`Water:${p.water_intake}L`);
        lines.push(parts.join(' | '));
      });
    } else {
      const show = [...rd.progress_logs.slice(0, 3), ...(rd.progress_logs.length > 6 ? [null] : []), ...rd.progress_logs.slice(-3)];
      show.forEach(p => {
        if (!p) { lines.push(`  ... (${rd.progress_logs.length - 6} more entries) ...`); return; }
        const parts = [`  ${p.created_at?.slice(0, 10)}`];
        if (n(p.weight)) parts.push(`Weight:${p.weight}kg`);
        if (n(p.calories_intake)) parts.push(`Cal:${p.calories_intake}kcal`);
        if (n(p.protein_intake)) parts.push(`Prot:${p.protein_intake}g`);
        if (n(p.strength_bench)) parts.push(`Bench:${p.strength_bench}kg`);
        lines.push(parts.join(' | '));
      });
    }
  } else {
    lines.push(`\n[PROGRESS LOGS]: None in this period`);
  }

  // ── ALL WORKOUT LOGS (every session) ─────────────────────────────────────────
  if (rd.workout_logs.length) {
    lines.push(`\n[ALL WORKOUT SESSIONS — ${rd.workout_logs.length} sessions]`);
    rd.workout_logs.forEach(w => {
      const dur = w.duration_seconds ? `${Math.round(w.duration_seconds / 60)}min` : '-';
      const fb = w.feedback ? ` | Feedback: ${w.feedback}` : '';
      lines.push(`  ${w.created_at?.slice(0, 10)} | ${w.workout_name || 'unnamed'} | ${dur}${fb}`);
    });
  } else {
    lines.push(`\n[WORKOUT SESSIONS]: None in this period`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────────────────────────────────────
async function buildLeaderboard(queryAll, dateRange) {
  const dr = dateRange || parseDateRange('');
  const rows = await queryAll(
    `SELECT u.id, u.first_name, u.last_name, u.email,
      (SELECT COUNT(*)::int FROM daily_checkins dc WHERE dc.user_id = u.id AND dc.checkin_date >= ?::date AND dc.checkin_date <= ?::date) AS daily_n,
      (SELECT COUNT(*)::int FROM progress_logs pl WHERE pl.user_id = u.id AND pl.created_at >= ?::timestamptz AND pl.created_at <= ?::timestamptz) AS log_n,
      (SELECT COUNT(*)::int FROM workout_logs wl WHERE wl.user_id = u.id AND wl.created_at >= ?::timestamptz AND wl.created_at <= ?::timestamptz) AS workout_n,
      (SELECT MAX(dc2.checkin_date)::text FROM daily_checkins dc2 WHERE dc2.user_id = u.id) AS last_checkin
     FROM users u
     WHERE u.role = 'user' AND (u.approval_status = 'approved' OR u.approval_status IS NULL)
     ORDER BY daily_n DESC, log_n DESC LIMIT 50`,
    [dr.from_date, dr.to_date, `${dr.from_date}T00:00:00Z`, `${dr.to_date}T23:59:59Z`, `${dr.from_date}T00:00:00Z`, `${dr.to_date}T23:59:59Z`]
  );
  const days = dr.days || DEFAULT_LOOKBACK_DAYS;
  return rows.map((r, i) => ({
    rank: i + 1,
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    email: r.email,
    daily_checkins: r.daily_n,
    progress_logs: r.log_n,
    workouts: r.workout_n,
    compliance_pct: pct(r.daily_n, days),
    last_checkin: r.last_checkin || 'never'
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS STATS
// ─────────────────────────────────────────────────────────────────────────────
async function buildBusinessStats(queryAll) {
  const dr = parseDateRange('last 30 days');

  const [
    activeClients, totalTribe, pendingAudit, pendingSignups,
    totalWorkouts, totalDailyCheckins, totalSundayCheckins,
    atRisk, scheduledMeetings
  ] = await Promise.all([
    queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status='approved' OR approval_status IS NULL)"),
    queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='active'"),
    queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='pending'"),
    queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status='pending')"),
    queryAll("SELECT COUNT(*) as c FROM workout_logs WHERE created_at >= ?::timestamptz", [`${dr.from_date}T00:00:00Z`]),
    queryAll("SELECT COUNT(*) as c FROM daily_checkins WHERE checkin_date >= ?::date", [dr.from_date]),
    queryAll("SELECT COUNT(*) as c FROM sunday_checkins WHERE created_at >= ?::timestamptz", [`${dr.from_date}T00:00:00Z`]),
    queryAll(
      `SELECT u.first_name, u.last_name, u.email,
        (SELECT MAX(dc.checkin_date)::text FROM daily_checkins dc WHERE dc.user_id = u.id) AS last_checkin
       FROM users u
       WHERE u.role = 'user' AND (u.approval_status = 'approved' OR u.approval_status IS NULL)
       AND NOT EXISTS (SELECT 1 FROM daily_checkins dc2 WHERE dc2.user_id = u.id AND dc2.checkin_date >= ?::date)
       ORDER BY last_checkin ASC NULLS FIRST LIMIT 10`,
      [dr.from_date]
    ),
    queryAll("SELECT COUNT(*) as c FROM meetings WHERE status='scheduled'")
  ]);

  return {
    active_clients: n(activeClients[0]?.c),
    active_tribe_members: n(totalTribe[0]?.c),
    pending_audit_forms: n(pendingAudit[0]?.c),
    pending_signups: n(pendingSignups[0]?.c),
    workouts_last_30_days: n(totalWorkouts[0]?.c),
    daily_checkins_last_30_days: n(totalDailyCheckins[0]?.c),
    sunday_checkins_last_30_days: n(totalSundayCheckins[0]?.c),
    scheduled_meetings: n(scheduledMeetings[0]?.c),
    at_risk_clients: atRisk.map(r => ({
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email,
      last_checkin: r.last_checkin || 'never'
    }))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION
// ─────────────────────────────────────────────────────────────────────────────
function detectIntent(text) {
  const t = text.toLowerCase();
  const wantsDetailed = /\b(detailed\s+report|monthly\s+report|full\s+detailed|complete\s+report|everything|full\s+report|in.?depth\s+report|deep\s+dive|deep\s+report|thorough\s+report|comprehensive\s+report)\b/.test(t);
  return {
    wantsLeaderboard: /\b(rank|ranking|leaderboard|most\s+compliant|best\s+performing|worst\s+performing|top\s+clients?|who\s+is\s+doing\s+best|compliance\s+rate)\b/.test(t),
    wantsBusiness: /\b(business|overview|overall\s+stats?|how\s+many|active\s+clients?|at.?risk|pending)\b/.test(t),
    wantsComparison: /\bcompare\b/.test(t),
    wantsProgramRec: /\b(which\s+program|what\s+program|recommend.*program|program.*recommend|best\s+program\s+for|suggest.*program|assign.*program)\b/.test(t),
    wantsReport: /\b(full\s+report|report\s+for|how\s+is.*doing|give\s+me.*report|tell\s+me\s+about|show\s+me)\b/.test(t) || wantsDetailed,
    wantsDetailed,
    wantsNutrition: /\b(nutrition|calories?|protein|eating|diet|food)\b/.test(t),
    wantsPlateau: /\b(stuck|plateau|stall|not\s+progress|no\s+results?|not\s+losing|not\s+gaining)\b/.test(t)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENRICHMENT ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────
async function enrichAdminAiContext(deps, userMessage, baseContext) {
  const { queryAll, fs, rootDir } = deps;
  const parts = [baseContext || ''];
  const msg = String(userMessage || '');
  const intent = detectIntent(msg);
  const dateRange = parseDateRange(msg);

  // ── Business stats
  if (intent.wantsBusiness) {
    try {
      const biz = await buildBusinessStats(queryAll);
      parts.push('\n--- BUSINESS OVERVIEW ---');
      parts.push(`Active clients: ${biz.active_clients} | Active tribe members: ${biz.active_tribe_members}`);
      parts.push(`Pending audit forms: ${biz.pending_audit_forms} | Pending sign-ups: ${biz.pending_signups}`);
      parts.push(`Scheduled meetings: ${biz.scheduled_meetings}`);
      parts.push(`Last 30 days: ${biz.workouts_last_30_days} workouts | ${biz.daily_checkins_last_30_days} daily check-ins | ${biz.sunday_checkins_last_30_days} Sunday check-ins`);
      if (biz.at_risk_clients.length) {
        parts.push(`AT-RISK CLIENTS (no check-in in last 30 days):`);
        biz.at_risk_clients.forEach(c => parts.push(`  ⚠ ${c.name} | ${c.email} | Last check-in: ${c.last_checkin}`));
      }
    } catch (e) {
      parts.push(`\n--- BUSINESS STATS ERROR: ${e.message} ---`);
    }
  }

  // ── Leaderboard
  if (intent.wantsLeaderboard) {
    try {
      const lb = await buildLeaderboard(queryAll, dateRange);
      parts.push(`\n--- COMPLIANCE LEADERBOARD (${dateRange.label}) ---`);
      lb.forEach(r => {
        const flag = r.rank <= 3 ? '🏆' : r.compliance_pct < 40 ? '⚠️' : '';
        parts.push(`  ${r.rank}. ${r.name} | ${r.compliance_pct ?? 0}% compliance | ${r.daily_checkins} daily check-ins | ${r.workouts} workouts | Last: ${r.last_checkin} ${flag}`);
      });
    } catch (e) {
      parts.push(`\n--- LEADERBOARD ERROR: ${e.message} ---`);
    }
  }

  // ── Client packs
  const { ids, ambiguous } = await resolveClientsFromMessage(queryAll, msg);

  if (ambiguous.length) {
    parts.push('\n--- AMBIGUOUS CLIENT MATCHES ---');
    ambiguous.forEach(a => {
      parts.push(`Query "${a.query}" matched multiple clients:`);
      a.matches.forEach(m => parts.push(`  • ${m.name} (${m.email})`));
    });
  }

  for (const uid of ids) {
    try {
      const pack = await buildClientPack(deps, uid, dateRange, intent.wantsDetailed);
      if (pack) parts.push(formatPackAsText(pack));
    } catch (e) {
      parts.push(`\n--- CLIENT PACK ERROR (user ${uid}): ${e.message} ---`);
    }
  }

  // ── Program recommendation without specific client
  if (intent.wantsProgramRec && ids.length === 0) {
    parts.push('\n--- ALL 17 PROGRAM PROFILES (for general recommendation) ---');
    PROGRAM_LIBRARY.forEach(p => {
      parts.push(`  ${p.name}: ${p.type} | ${p.duration_min}min | Intensity: ${p.intensity} | Level: ${p.level.join('/')} | Goals: ${p.goals.join(', ')} | Gym: ${p.gym_required ? 'YES' : 'NO'}`);
      parts.push(`    Best for: ${p.best_for}`);
    });
  }

  // ── No client resolved note
  if (ids.length === 0 && !intent.wantsLeaderboard && !intent.wantsBusiness && !intent.wantsProgramRec) {
    parts.push(
      '\n--- NOTE: No specific client matched this message ---\n' +
      'Use the LIVE DATABASE CONTEXT above for global questions.\n' +
      'For per-client analysis, include the client\'s full name or email (e.g. "Report for Jane Doe" or "How is jane@example.com doing last 7 days?").'
    );
  }

  parts.push(`\n--- MESSAGE DATE RANGE PARSED: "${dateRange.label}" (${dateRange.from_date} to ${dateRange.to_date}) ---`);

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// FINAL SYSTEM CONTENT BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildTrainerSystemContent(enrichedContext) {
  return BODYBANK_TRAINER_AI_SYSTEM_PROMPT + '\n\n' + enrichedContext;
}

module.exports = {
  BODYBANK_TRAINER_AI_SYSTEM_PROMPT,
  PROGRAM_LIBRARY,
  enrichAdminAiContext,
  buildTrainerSystemContent,
  parseDateRange,
  computeClientMetrics,
  recommendPrograms
};
