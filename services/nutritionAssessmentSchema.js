'use strict';

/**
 * FitChef Nutrition Assessment — the form definition, and the ONLY place it lives.
 *
 * The browser renders from this (served at GET /api/nutrition-assessment/schema),
 * the server validates against it, and the CSV export takes its headers from it.
 * One source of truth, so a field can never exist on screen but be dropped on
 * submit, or appear in the table with no label.
 *
 * Field shape
 *   key        storage key inside its step's answer object
 *   label      question as the member reads it
 *   type       text | textarea | email | tel | number | date | time | select |
 *              multi | yesno | tags | slider | height | grid | recall | files
 *   options    for select / multi
 *   required   blocks the step's Next button
 *   when       conditional render (see matches() below)
 *   prefill    key in the prefill payload that can answer this from the DB
 *   help       small print under the label
 *
 * `when` operators, all evaluated against the flat answer map:
 *   { field, in: [...] }      value is one of
 *   { field, not: [...] }     value is none of
 *   { field, has: [...] }     multi-select contains any of
 *   { field, truthy: true }   any non-empty value
 *   { any: [ ...clauses ] }   OR
 *   { all: [ ...clauses ] }   AND
 */

const GOALS = [
  'Fat loss',
  'Muscle gain',
  'Body recomposition',
  'Maintain & eat cleaner',
  'Sports or endurance performance',
  'Manage a medical condition',
  'Fix energy & digestion',
  'Healthy pregnancy or postpartum'
];

const CONDITIONS = [
  'Type 2 diabetes', 'Prediabetes', 'Type 1 diabetes', 'PCOS / PCOD',
  'Hypothyroidism', 'Hyperthyroidism', 'High blood pressure', 'High cholesterol',
  'Fatty liver', 'High uric acid / gout', 'Kidney disease or stones', 'IBS',
  "IBD (Crohn's / colitis)", 'Acidity / GERD', 'Celiac disease',
  'Gallbladder removed', 'Anaemia', 'Migraine', 'Arthritis', 'Asthma',
  'Cancer (current or past)', 'Recent surgery', 'None of these'
];

const FREQ_COLS = ['Never', '1–2× week', '3–4× week', 'Daily', 'Multiple times daily'];

const FREQ_ROWS = [
  { key: 'eggs', label: 'Eggs' },
  { key: 'chicken_fish', label: 'Chicken or fish' },
  { key: 'red_meat', label: 'Red meat' },
  { key: 'paneer_tofu', label: 'Paneer or tofu' },
  { key: 'dal_legumes', label: 'Dal / legumes / rajma / chana' },
  { key: 'curd', label: 'Curd or buttermilk' },
  { key: 'milk', label: 'Milk' },
  { key: 'whey', label: 'Whey protein' },
  { key: 'fruits', label: 'Fruits' },
  { key: 'vegetables', label: 'Vegetables (non-potato)' },
  { key: 'salad', label: 'Salad or raw veg' },
  { key: 'nuts_seeds', label: 'Nuts and seeds' },
  { key: 'white_rice', label: 'White rice' },
  { key: 'roti', label: 'Roti / chapati' },
  { key: 'maida', label: 'Bread / maida items' },
  { key: 'millets', label: 'Millets or brown rice' },
  { key: 'fried', label: 'Deep-fried food' },
  { key: 'packaged_snacks', label: 'Packaged snacks (chips, namkeen, biscuits)' },
  { key: 'sweets', label: 'Sweets / desserts' },
  { key: 'restaurant', label: 'Restaurant or delivered food' },
  { key: 'sugary_drinks', label: 'Sugary drinks / juice / soda' }
];

const RECALL_MEALS = [
  { key: 'early', label: 'Early morning', placeholder: 'e.g. 2 cups tea with sugar, 4 almonds' },
  { key: 'breakfast', label: 'Breakfast', placeholder: 'e.g. 3 idli + sambar + 1 tsp ghee, or 2 eggs + 2 toast' },
  { key: 'mid_morning', label: 'Mid-morning', placeholder: 'e.g. coffee + biscuits, or nothing' },
  { key: 'lunch', label: 'Lunch', placeholder: 'e.g. 2 cups rice, dal, curry, curd, pickle' },
  { key: 'evening', label: 'Evening', placeholder: 'e.g. tea + samosa, or protein shake' },
  { key: 'dinner', label: 'Dinner', placeholder: 'e.g. 3 chapati + sabzi + salad' },
  { key: 'post_dinner', label: 'After dinner', placeholder: 'e.g. ice cream, warm milk, nothing' }
];

const LAB_FIELDS = [
  { key: 'hba1c', label: 'HbA1c', unit: '%' },
  { key: 'fasting_glucose', label: 'Fasting glucose', unit: 'mg/dL' },
  { key: 'tsh', label: 'TSH', unit: 'mIU/L' },
  { key: 'vitamin_d', label: 'Vitamin D', unit: 'ng/mL' },
  { key: 'b12', label: 'Vitamin B12', unit: 'pg/mL' },
  { key: 'ferritin', label: 'Ferritin', unit: 'ng/mL' },
  { key: 'haemoglobin', label: 'Haemoglobin', unit: 'g/dL' },
  { key: 'ldl', label: 'LDL', unit: 'mg/dL' },
  { key: 'hdl', label: 'HDL', unit: 'mg/dL' },
  { key: 'triglycerides', label: 'Triglycerides', unit: 'mg/dL' },
  { key: 'alt', label: 'ALT / SGPT', unit: 'U/L' },
  { key: 'uric_acid', label: 'Uric acid', unit: 'mg/dL' },
  { key: 'creatinine', label: 'Creatinine', unit: 'mg/dL' }
];

const STEPS = [
  // ─────────────────────────────────────────────────────────── 1
  {
    key: 'identity',
    part: 1,
    title: 'Who you are',
    blurb: 'Just enough to reach you with the report.',
    fields: [
      { key: 'full_name', label: 'Full name', type: 'text', required: true, prefill: 'full_name' },
      { key: 'mobile', label: 'Mobile (WhatsApp)', type: 'tel', required: true, prefill: 'mobile', help: 'We send the report here.' },
      { key: 'email', label: 'Email', type: 'email', required: true, prefill: 'email' },
      { key: 'city', label: 'City', type: 'text', required: true, prefill: 'city' },
      {
        key: 'source', label: 'How did you hear about us', type: 'select',
        options: ['BodyBank', 'Instagram', 'A friend or family', 'Google', 'A doctor or clinic', 'Event or workshop', 'Other'],
        when: { field: '_is_member', in: ['no'] }
      }
    ]
  },

  // ─────────────────────────────────────────────────────────── 2
  {
    key: 'goals',
    part: 1,
    title: 'What you want',
    blurb: 'The plan is built backwards from this.',
    fields: [
      { key: 'goal_primary', label: 'Primary goal', type: 'select', required: true, options: GOALS, prefill: 'goal_primary' },
      { key: 'goal_secondary', label: 'Secondary goals', type: 'multi', max: 2, options: GOALS, help: 'Pick up to two. Optional.' },
      {
        key: 'target_weight', label: 'Target weight', type: 'number', unit: 'kg', step: '0.1',
        when: { field: 'goal_primary', in: ['Fat loss', 'Muscle gain', 'Body recomposition'] },
        prefill: 'target_weight'
      },
      { key: 'target_date', label: 'Target date', type: 'date', help: 'Optional — leave blank if there is no deadline.' },
      {
        key: 'goal_event', label: 'Is there a specific event?', type: 'select',
        options: ['Wedding', 'Shoot or shooting schedule', 'Sports event', "Doctor's advice", 'Health scare', 'Travel', 'No specific event']
      },
      {
        key: 'goal_pace', label: 'Pace you want', type: 'select', required: true,
        options: ['Steady (0.25–0.5 kg/wk)', 'Moderate (0.5–0.75 kg/wk)', "I'd rather go slow and never feel deprived"]
      },
      {
        key: 'past_attempts', label: 'Have you tried structured diets before?', type: 'select', required: true,
        options: ['Never', 'Once or twice', '3–5 times', 'Too many to count']
      },
      {
        key: 'past_failure_reasons', label: 'What ended the last attempt?', type: 'multi',
        when: { field: 'past_attempts', not: ['Never', ''] },
        help: 'This decides the shape of your plan more than any number does.',
        options: ['Hunger', 'Boredom with food', 'Travel or work schedule', 'Cost', 'No time to cook',
          'Social & family eating', 'Hit a plateau', 'Injury or illness', 'Lost motivation', 'It worked, I just stopped']
      },
      {
        key: 'past_success_notes', label: 'What actually worked last time?', type: 'textarea', maxlength: 200,
        when: { field: 'past_attempts', not: ['Never', ''] },
        placeholder: 'One line is enough.'
      }
    ]
  },

  // ─────────────────────────────────────────────────────────── 3
  {
    key: 'body',
    part: 1,
    title: 'Your body',
    blurb: 'These four numbers produce your metabolic starting point on the next screen.',
    teaser: true,
    fields: [
      { key: 'dob', label: 'Date of birth', type: 'date', required: true, prefill: 'dob' },
      { key: 'sex', label: 'Sex', type: 'select', required: true, options: ['Male', 'Female', 'Prefer to self-describe'], prefill: 'sex', help: 'Used only for the metabolic rate calculation.' },
      { key: 'height_cm', label: 'Height', type: 'height', required: true, prefill: 'height_cm' },
      // waist / hip / neck are ENTERED in inches — that is what members here
      // measure in — but the keys stay *_cm and the stored value stays canonical
      // centimetres. whtr() divides waist by height, the prefill comes from body
      // snapshots recorded in cm, and every row written before this change is in
      // cm; storing inches under the same key would silently make all three wrong
      // by a factor of 2.54. The `length` type shows inches and converts on entry.
      { key: 'weight_kg', label: 'Current weight', type: 'number', unit: 'kg', step: '0.1', required: true, prefill: 'weight_kg' },
      { key: 'waist_cm', label: 'Waist at navel', type: 'length', unit: 'in', required: true, prefill: 'waist_cm', help: 'Measure at the navel, standing relaxed, tape snug but not squeezing. This predicts metabolic risk better than BMI does.' },
      { key: 'hip_cm', label: 'Hip', type: 'length', unit: 'in', help: 'Optional — widest point. Enables waist-to-hip ratio.' },
      { key: 'neck_cm', label: 'Neck', type: 'length', unit: 'in', help: 'Optional — enables a body-fat estimate.' },
      { key: 'body_fat_pct', label: 'Known body fat %', type: 'number', unit: '%', prefill: 'body_fat_pct' },
      {
        key: 'body_fat_method', label: 'Measured how?', type: 'select',
        options: ['DEXA', 'InBody or BIA', 'Skinfold', 'Smart scale', 'Guess'],
        when: { field: 'body_fat_pct', truthy: true }
      },
      { key: 'weight_6mo', label: 'Weight 6 months ago', type: 'number', unit: 'kg', step: '0.1', prefill: 'weight_6mo', help: 'Optional — the trajectory tells us more than the snapshot.' },
      { key: 'weight_highest', label: 'Highest adult weight', type: 'number', unit: 'kg', step: '0.1' },
      { key: 'photos', label: 'Progress photos', type: 'files', accept: 'image/*', max: 3, help: 'Optional — front, side, back. Private, used only for your assessment.' }
    ]
  },

  // ─────────────────────────────────────────────────────────── 4
  {
    key: 'health',
    part: 1,
    title: 'Health screening',
    blurb: 'This is what separates a nutrition plan from a menu. Nothing here is shared outside your coaching team.',
    fields: [
      { key: 'conditions', label: 'Diagnosed conditions', type: 'multi', options: CONDITIONS, required: true, exclusive: 'None of these' },

      // 4b — conditional follow-ups
      { key: 'hba1c_value', label: 'Most recent HbA1c', type: 'number', unit: '%', step: '0.1', when: { field: 'conditions', has: ['Type 2 diabetes', 'Prediabetes', 'Type 1 diabetes'] }, prefill: 'lab_hba1c' },
      { key: 'on_insulin', label: 'Are you on insulin?', type: 'yesno', when: { field: 'conditions', has: ['Type 2 diabetes', 'Type 1 diabetes'] } },
      { key: 'glucose_meds', label: 'Diabetes medication', type: 'text', when: { field: 'conditions', has: ['Type 2 diabetes', 'Prediabetes', 'Type 1 diabetes'] }, placeholder: 'e.g. Metformin 500mg twice daily' },

      { key: 'cycle_regular', label: 'Your cycle', type: 'select', options: ['Regular', 'Irregular', 'Absent'], when: { field: 'conditions', has: ['PCOS / PCOD'] } },
      { key: 'on_metformin', label: 'On metformin?', type: 'yesno', when: { field: 'conditions', has: ['PCOS / PCOD'] } },
      { key: 'on_ocp', label: 'On the pill (OCP)?', type: 'yesno', when: { field: 'conditions', has: ['PCOS / PCOD'] } },

      { key: 'tsh_value', label: 'Most recent TSH', type: 'number', step: '0.01', unit: 'mIU/L', when: { field: 'conditions', has: ['Hypothyroidism', 'Hyperthyroidism'] }, prefill: 'lab_tsh' },
      { key: 'thyroid_med_name', label: 'Thyroid medication', type: 'text', when: { field: 'conditions', has: ['Hypothyroidism', 'Hyperthyroidism'] }, placeholder: 'e.g. Thyronorm 50mcg' },
      { key: 'thyroid_med_timing', label: 'When do you take it?', type: 'time', when: { field: 'conditions', has: ['Hypothyroidism', 'Hyperthyroidism'] }, help: 'Your first meal has to sit 45 minutes after this.' },

      { key: 'egfr_known', label: 'Known eGFR or creatinine', type: 'text', when: { field: 'conditions', has: ['Kidney disease or stones'] }, help: 'Leave blank if you do not know it.' },

      { key: 'bp_meds', label: 'Blood pressure medication', type: 'text', when: { field: 'conditions', has: ['High blood pressure'] } },
      { key: 'bp_recent_reading', label: 'Recent BP reading', type: 'text', when: { field: 'conditions', has: ['High blood pressure'] }, placeholder: 'e.g. 138/88' },

      { key: 'trigger_foods', label: 'Foods that trigger a flare', type: 'text', when: { field: 'conditions', has: ['IBS', "IBD (Crohn's / colitis)"] } },
      { key: 'flare_frequency', label: 'How often do you flare?', type: 'select', options: ['Rarely', 'Monthly', 'Weekly', 'Currently in a flare'], when: { field: 'conditions', has: ['IBS', "IBD (Crohn's / colitis)"] } },

      { key: 'reflux_frequency', label: 'How often is the reflux?', type: 'select', options: ['Occasionally', 'Weekly', 'Most days'], when: { field: 'conditions', has: ['Acidity / GERD'] } },
      { key: 'night_reflux', label: 'Does it wake you at night?', type: 'yesno', when: { field: 'conditions', has: ['Acidity / GERD'] } },

      { key: 'uric_acid_value', label: 'Recent uric acid', type: 'number', step: '0.1', unit: 'mg/dL', when: { field: 'conditions', has: ['High uric acid / gout'] }, prefill: 'lab_uric_acid' },

      // 4c — universal
      {
        key: 'pregnancy_status', label: 'Pregnant, breastfeeding, or trying?', type: 'select',
        options: ['No', 'Pregnant', 'Breastfeeding', 'Trying to conceive'],
        when: { field: 'sex', in: ['Female'] }
      },
      { key: 'medications', label: 'Current medications', type: 'tags', placeholder: 'Type and press Enter — leave empty if none' },
      {
        key: 'supplements', label: 'Current supplements', type: 'multi', exclusive: 'None',
        options: ['Whey', 'Creatine', 'Multivitamin', 'Vitamin D', 'B12', 'Omega-3', 'Iron', 'Calcium',
          'Magnesium', 'Pre-workout', 'Fat burner', 'Probiotic', 'Ayurvedic / herbal', 'None']
      },
      { key: 'has_bloodwork', label: 'Blood test in the last 6 months?', type: 'yesno', prefill: 'has_bloodwork' },
      { key: 'bloodwork_file', label: 'Upload the report', type: 'files', accept: '.pdf,image/*', max: 2, when: { field: 'has_bloodwork', in: ['Yes'] }, help: 'Optional — or type the key values below instead.' },
      { key: 'labs', label: 'Key values', type: 'labs', labs: LAB_FIELDS, when: { field: 'has_bloodwork', in: ['Yes'] }, collapsed: true, prefill: 'labs', help: 'All optional. Fill in whatever you have.' },
      { key: 'injuries', label: 'Injuries or physical limitations', type: 'textarea', prefill: 'injuries' },
      { key: 'smoking', label: 'Smoking', type: 'select', options: ['Never', 'Occasionally', 'Daily'], required: true, prefill: 'smoking' },
      {
        key: 'alcohol_frequency', label: 'Alcohol', type: 'select', required: true, prefill: 'alcohol_frequency',
        options: ['Never', 'Few times a year', 'Monthly', 'Weekly', '2–3× a week', 'Most days']
      },
      {
        key: 'alcohol_units', label: 'Typical drinks per session', type: 'number',
        when: { field: 'alcohol_frequency', not: ['Never', ''] },
        help: 'One drink = 30ml spirits, 150ml wine, or 330ml beer.'
      }
    ]
  },

  // ─────────────────────────────────────────────────────────── 5
  {
    key: 'activity',
    part: 2,
    title: 'Movement & training',
    blurb: 'This refines the calorie number and decides where meals sit in your day.',
    fields: [
      {
        key: 'occupation_type', label: 'Work type', type: 'select', required: true, prefill: 'occupation_type',
        options: ['Desk', 'Field or travel-heavy', 'Physical labour', 'Shift or night work', 'Student', 'Homemaker', 'Between jobs']
      },
      {
        key: 'shift_type', label: 'Shift timing', type: 'select', options: ['Day', 'Rotating', 'Night'],
        when: { field: 'occupation_type', in: ['Shift or night work'] },
        help: 'Night shifts change meal timing completely — we build around your actual clock.'
      },
      {
        key: 'daily_steps', label: 'Average daily steps', type: 'select', required: true, prefill: 'daily_steps',
        options: ['<3k', '3–5k', '5–8k', '8–12k', '12k+', 'Not tracked']
      },
      {
        key: 'trains', label: 'Do you train?', type: 'select', required: true, prefill: 'trains',
        options: ['Not currently', '1–2× week', '3–4× week', '5–6× week', 'Daily']
      },
      {
        key: 'training_types', label: 'Training types', type: 'multi',
        when: { field: 'trains', not: ['Not currently', ''] },
        options: ['Weights', 'Cardio machines', 'Running', 'Cycling', 'Swimming', 'Yoga or Pilates', 'HIIT or functional', 'Sport', 'Walking only']
      },
      {
        key: 'session_minutes', label: 'Session length', type: 'select', options: ['<30', '30–45', '45–60', '60–90', '90+'],
        when: { field: 'trains', not: ['Not currently', ''] }
      },
      {
        key: 'training_time', label: 'Usual training time', type: 'select',
        options: ['Early morning', 'Morning', 'Afternoon', 'Evening', 'Night'],
        when: { field: 'trains', not: ['Not currently', ''] },
        help: 'Drives where your pre- and post-workout meals land.'
      },
      { key: 'trains_fasted', label: 'Do you train fasted?', type: 'select', options: ['Yes', 'No', 'Sometimes'], when: { field: 'trains', not: ['Not currently', ''] } },
      {
        key: 'training_experience', label: 'Training experience', type: 'select',
        options: ['<6 months', '6mo–2yr', '2–5yr', '5yr+'],
        when: { field: 'trains', not: ['Not currently', ''] }
      },
      { key: 'has_coach', label: 'Working with a coach?', type: 'yesno' },
      { key: 'coach_name', label: "Coach's name", type: 'text', when: { field: 'has_coach', in: ['Yes'] }, help: 'So our advice does not contradict theirs.' },
      { key: 'activity_barriers', label: 'Anything stopping you being more active?', type: 'multi', exclusive: 'Nothing', options: ['Time', 'Injury', 'Gym access', 'Motivation', 'Energy', 'Nothing'] }
    ]
  },

  // ─────────────────────────────────────────────────────────── 6
  {
    key: 'current_diet',
    part: 2,
    title: 'How you eat today',
    blurb: 'This is the part that makes your plan actually yours. Everything before it was context — this is data.',
    fields: [
      { key: 'meals_per_day', label: 'Meals per day (including snacks)', type: 'select', required: true, options: ['1', '2', '3', '4', '5+'] },
      { key: 'first_meal_time', label: 'First food of the day', type: 'time', required: true },
      { key: 'last_meal_time', label: 'Last food of the day', type: 'time', required: true },
      { key: 'skipped_meals', label: 'Do you skip meals?', type: 'multi', exclusive: "I don't skip", options: ['Breakfast', 'Lunch', 'Dinner', "I don't skip"] },
      { key: 'does_if', label: 'Do you follow intermittent fasting?', type: 'yesno' },
      { key: 'if_protocol', label: 'Which protocol?', type: 'select', options: ['16:8', '18:6', 'OMAD', '5:2', 'Other'], when: { field: 'does_if', in: ['Yes'] } },
      { key: 'weekend_differs', label: 'Do weekends differ from weekdays?', type: 'select', options: ['Not really', 'Somewhat', 'Completely different'] },

      {
        key: 'recall', label: 'Yesterday, meal by meal', type: 'recall', meals: RECALL_MEALS, required: true,
        help: 'Write what you actually ate yesterday, not what a good day looks like. The plan is only as accurate as this.'
      },

      {
        key: 'frequency_grid', label: 'How often do you eat these?', type: 'grid', rows: FREQ_ROWS, cols: FREQ_COLS, required: true,
        help: 'About 40 seconds of tapping. It gives us your protein adequacy, fibre, refined-carb load and processed-food burden in one pass.'
      },

      { key: 'water_litres', label: 'Water per day', type: 'select', required: true, prefill: 'water_litres', options: ['<1', '1–2', '2–3', '3–4', '4+'] },
      { key: 'tea_coffee_cups', label: 'Tea or coffee per day', type: 'select', options: ['0', '1–2', '3–4', '5+'] },
      { key: 'beverage_sugar', label: 'Sugar in tea/coffee', type: 'select', options: ['No sugar', '1 tsp', '2 tsp', '2+ tsp', 'Jaggery', 'Sweetener'], when: { field: 'tea_coffee_cups', not: ['0', ''] } },
      { key: 'who_cooks', label: 'Who cooks your food', type: 'select', required: true, options: ['I do', 'Family member', 'Cook or maid', 'Mess or canteen', 'Mostly ordered in'] },
      { key: 'cooking_oil', label: 'Cooking oil used', type: 'multi', options: ['Sunflower', 'Groundnut', 'Mustard', 'Coconut', 'Sesame', 'Olive', 'Ghee', 'Rice bran', 'Refined blend', "Don't know"] },
      { key: 'oil_litres_pp', label: 'Household oil per person per month', type: 'select', options: ['<0.5L', '0.5–1L', '1L+', "Don't know"] },
      { key: 'outside_meals_week', label: 'Meals eaten outside per week', type: 'select', required: true, options: ['0', '1–2', '3–5', '6–10', '10+'] }
    ]
  },

  // ─────────────────────────────────────────────────────────── 7
  {
    key: 'preferences',
    part: 2,
    title: 'Food rules & taste',
    blurb: 'The difference between a plan you follow and one you abandon.',
    fields: [
      {
        key: 'diet_type', label: 'Diet type', type: 'select', required: true, prefill: 'diet_type',
        options: ['Vegetarian', 'Vegan', 'Eggetarian', 'Non-vegetarian', 'Jain', 'Satvik (no onion-garlic)', 'Keto', 'Other']
      },
      { key: 'nonveg_days', label: 'Non-veg days per week', type: 'select', options: ['1', '2', '3', '4', '5', '6', '7'], when: { field: 'diet_type', in: ['Non-vegetarian'] } },
      {
        key: 'fasting_practices', label: 'Religious or fasting practices', type: 'multi', exclusive: 'None',
        options: ['Ekadashi', 'Navratri', 'Karwa Chauth', 'Sunday veg', 'Tuesday or Saturday veg', 'Ramadan', 'Sravana masam', 'None']
      },
      {
        key: 'allergies', label: 'Allergies', type: 'multi', required: true, exclusive: 'None',
        options: ['Milk', 'Lactose intolerance', 'Gluten or wheat', 'Tree nuts', 'Peanuts', 'Soy', 'Egg', 'Fish', 'Shellfish', 'Sesame', 'None']
      },
      { key: 'allergy_other', label: 'Any other allergy', type: 'text', when: { field: 'allergies', not: ['None'] } },
      { key: 'intolerances', label: 'Foods that upset your stomach', type: 'tags', help: 'Different from an allergy — this is the practical one.' },
      { key: 'dislikes', label: 'Foods you will not eat', type: 'tags', help: 'Be honest. A plan full of food you hate is a plan you drop.' },
      { key: 'must_haves', label: 'Foods you want kept in the plan', type: 'tags', help: 'Your evening chai, your Sunday biryani. We build around them, not against them.' },
      {
        key: 'cuisines', label: 'Cuisine preference', type: 'multi',
        options: ['Andhra & Telangana', 'South Indian', 'North Indian', 'Bengali', 'Maharashtrian', 'Continental', 'Pan-Asian', 'Mediterranean', 'Middle Eastern']
      },
      { key: 'staple_preference', label: 'Rice or roti person?', type: 'select', required: true, options: ['Rice', 'Roti', 'Both equally', 'Millets'] },
      { key: 'spice_level', label: 'Spice level', type: 'select', required: true, options: ['Mild', 'Medium', 'High', 'Very high'] },
      {
        key: 'repetition_tolerance', label: 'Variety needs', type: 'select', required: true,
        options: ['Happy to repeat meals', 'Some variety', 'I need something different daily'],
        help: 'This decides whether we build you a 5-recipe rotation or a 25-recipe one.'
      }
    ]
  },

  // ─────────────────────────────────────────────────────────── 8
  {
    key: 'wellbeing',
    part: 2,
    title: 'Digestion, sleep & appetite',
    blurb: 'Where most plans quietly fail.',
    fields: [
      { key: 'bowel_frequency', label: 'Bowel movements', type: 'select', required: true, options: ['Multiple times daily', 'Daily', 'Every 2 days', 'Less than every 2 days', 'Irregular'] },
      { key: 'bloating', label: 'Bloating', type: 'select', required: true, options: ['Never', 'Occasionally', 'Most days', 'After specific foods'] },
      { key: 'bloating_triggers', label: 'What triggers it?', type: 'text', when: { field: 'bloating', in: ['After specific foods', 'Most days'] } },
      { key: 'acidity', label: 'Acidity or reflux', type: 'select', required: true, options: ['Never', 'Occasionally', 'Weekly', 'Most days'] },
      { key: 'sleep_hours', label: 'Sleep hours', type: 'select', required: true, prefill: 'sleep_hours', options: ['<5', '5–6', '6–7', '7–8', '8+'] },
      { key: 'bedtime', label: 'Bedtime', type: 'time' },
      { key: 'wake_time', label: 'Wake time', type: 'time' },
      { key: 'sleep_quality', label: 'Sleep quality', type: 'select', options: ['Refreshed', 'Okay', 'Groggy most days', 'Poor, wake often'] },
      { key: 'energy_dip', label: 'When does your energy dip?', type: 'multi', exclusive: 'No real dip', options: ['Morning', 'After lunch', 'Late afternoon', 'Evening', 'No real dip'] },
      { key: 'stress_level', label: 'Stress level', type: 'slider', min: 1, max: 10, required: true, prefill: 'stress_level', help: '1 is calm, 10 is at breaking point.' },
      { key: 'hunger_peak', label: 'Hungriest time of day', type: 'select', required: true, options: ['Morning', 'Afternoon', 'Evening', 'Late night', 'Fairly even'] },
      { key: 'cravings', label: 'Cravings', type: 'multi', exclusive: 'No strong cravings', options: ['Sweet', 'Salty & fried', 'Carbs & bread', 'Chocolate', 'Caffeine', 'No strong cravings'] },
      { key: 'craving_time', label: 'When do the cravings hit?', type: 'select', options: ['Morning', 'Afternoon', 'Evening', 'Late night', 'No pattern'], when: { field: 'cravings', not: ['No strong cravings'] } },
      { key: 'emotional_eating', label: 'Do you eat in response to stress or boredom?', type: 'select', required: true, options: ['Never', 'Sometimes', 'Often', 'Very often'] },
      { key: 'food_relationship_notes', label: "Anything about your relationship with food you'd like us to know", type: 'textarea', help: 'Optional, and read only by your coaching team.' }
    ]
  },

  // ─────────────────────────────────────────────────────────── 9
  {
    key: 'logistics',
    part: 2,
    title: 'Kitchen & logistics',
    blurb: 'A plan that ignores your kitchen is a plan you cannot cook.',
    fields: [
      { key: 'kitchen_access', label: 'Kitchen access', type: 'select', required: true, options: ['Full kitchen', 'Basic (induction, microwave)', 'Microwave only', 'No cooking facility'] },
      { key: 'cooking_time', label: 'Time you can spend cooking', type: 'select', required: true, options: ['Under 15 min', '15–30 min', '30–60 min', "I don't cook"] },
      { key: 'cooking_skill', label: 'Cooking skill', type: 'select', options: ['Beginner', 'Comfortable', 'Confident'], when: { field: 'cooking_time', not: ["I don't cook", ''] } },
      { key: 'carries_tiffin', label: 'Do you carry food to work?', type: 'select', options: ['Yes daily', 'Sometimes', 'No', 'Work from home'] },
      { key: 'household_size', label: 'Cooking for how many', type: 'select', options: ['1', '2', '3–4', '5+'] },
      { key: 'family_same_food', label: 'Does the family eat the same food?', type: 'select', options: ['Yes', 'Mostly', 'No, I eat separately'], when: { field: 'household_size', not: ['1', ''] } },
      { key: 'travel_days', label: 'Travel days per month', type: 'select', required: true, options: ['0', '1–3', '4–7', '8–15', '15+'] },
      { key: 'budget_band', label: 'Monthly budget for food or plan', type: 'select', options: ['Under ₹5,000', '₹5,000–10,000', '₹10,000–20,000', '₹20,000–35,000', '₹35,000+', 'Rather not say'] },
      { key: 'delivery_interest', label: 'Interested in prepared meal delivery?', type: 'select', required: true, options: ['Daily', '3× a week', 'Weekly', 'Just the plan, no delivery'] },
      { key: 'pincode', label: 'Pincode', type: 'text', maxlength: 6, when: { field: 'delivery_interest', not: ['Just the plan, no delivery', ''] }, help: 'So we can confirm we deliver to you.' }
    ]
  },

  // ─────────────────────────────────────────────────────────── 10
  {
    key: 'accountability',
    part: 1,
    title: 'Accountability & consent',
    blurb: 'Last screen. Thirty seconds.',
    fields: [
      { key: 'checkin_frequency', label: 'Preferred check-in frequency', type: 'select', required: true, options: ['Daily', 'Weekly', 'Fortnightly', 'Monthly'] },
      { key: 'checkin_channel', label: 'Preferred channel', type: 'select', required: true, options: ['WhatsApp', 'In-app', 'Email', 'Call'] },
      { key: 'will_log_food', label: 'Willing to log meals daily?', type: 'select', required: true, options: ['Yes', 'A few days a week', 'Prefer not to'] },
      { key: 'will_weigh_food', label: 'Willing to weigh portions initially?', type: 'select', required: true, options: ['Yes', 'For a short while', 'No'] },
      { key: 'final_notes', label: 'Anything else we should know', type: 'textarea' },
      {
        key: 'consent_health_data', label: 'Consent', type: 'consent', required: true,
        text: "I agree to FitChef processing the health information I've shared to prepare my nutrition assessment and plan. I understand this is nutritional guidance, not medical advice or treatment, and that I should consult my doctor before making changes if I have a medical condition or take medication."
      },
      { key: 'consent_marketing', label: 'Marketing', type: 'consent', text: 'You can send me occasional updates, recipes and offers. (Optional — your assessment is unaffected either way.)' }
    ]
  }
];

/** Evaluate a `when` clause against the flat answer map. */
function matches(clause, answers) {
  if (!clause) return true;
  if (Array.isArray(clause.any)) return clause.any.some((c) => matches(c, answers));
  if (Array.isArray(clause.all)) return clause.all.every((c) => matches(c, answers));

  const raw = answers ? answers[clause.field] : undefined;
  const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [String(raw)]);

  if (clause.truthy) return list.length > 0;
  if (clause.has) return clause.has.some((v) => list.indexOf(v) !== -1);
  if (clause.in) return clause.in.some((v) => list.indexOf(String(v)) !== -1 || (v === '' && list.length === 0));
  if (clause.not) {
    if (list.length === 0) return clause.not.indexOf('') === -1 ? false : false;
    return !clause.not.some((v) => list.indexOf(String(v)) !== -1);
  }
  return true;
}

/** Every field key in the schema, in order — used for CSV headers. */
function allFields() {
  const out = [];
  STEPS.forEach((s) => s.fields.forEach((f) => out.push(Object.assign({ step: s.key, stepTitle: s.title }, f))));
  return out;
}

/** Look up one field definition by key. */
function fieldByKey(key) {
  return allFields().filter((f) => f.key === key)[0] || null;
}

/* ────────────────────────────── parts ──────────────────────────────
 * The assessment is delivered in two sittings. This is a TAG on the existing
 * steps, deliberately not a second schema or a second form: nothing was moved,
 * removed or duplicated, so a field can never exist in one part's copy and not
 * the other.
 *
 * Part 1 is the smallest set that still produces something safe and usable on
 * its own — identity, goal, body metrics, the health screen and consent. The
 * health screen is NOT optional here and must never be deferred to part 2:
 * review.computeFlags() is the gate that stops a deficit plan reaching someone
 * pregnant, on insulin, or in kidney failure, and metrics.derive() already
 * turns the body step alone into BMR / TDEE / protein. Consent likewise has to
 * be captured before any health data is processed at all.
 *
 * Part 2 is enrichment: training, current diet, preferences, wellbeing and
 * kitchen logistics. Valuable, but nothing in it gates safety.
 */
const PARTS = [1, 2];

const PART_META = {
  1: {
    part: 1,
    title: 'FitChef Assessment — Part 1',
    blurb: 'The essentials: who you are, your goal, your numbers and a short health check. About 3–4 minutes.',
    done: 'Part 1 is in. We can already work out your calorie and protein targets from this.'
  },
  2: {
    part: 2,
    title: 'FitChef Assessment — Part 2',
    blurb: 'The detail that makes the plan yours: how you train, how you eat now, what you like, and how your kitchen runs.',
    done: 'That is everything. Your plan can now be built around how you actually live.'
  }
};

/** Steps belonging to one part, in their original order. */
function stepsForPart(part) {
  const p = Number(part) === 2 ? 2 : 1;
  return STEPS.filter((s) => Number(s.part) === p);
}

/** Which part a step key belongs to, or null when the key is unknown. */
function partOfStep(stepKey) {
  const s = STEPS.find((x) => x.key === String(stepKey));
  return s ? Number(s.part) : null;
}

/** Which part a FIELD belongs to — used to validate a submission per part. */
function partOfField(fieldKey) {
  const s = STEPS.find((x) => x.fields.some((f) => f.key === String(fieldKey)));
  return s ? Number(s.part) : null;
}

/** Every field in one part. */
function fieldsForPart(part) {
  return stepsForPart(part).reduce((acc, s) => acc.concat(s.fields), []);
}

module.exports = {
  STEPS, matches, allFields, fieldByKey, LAB_FIELDS, FREQ_ROWS, FREQ_COLS, RECALL_MEALS,
  PARTS, PART_META, stepsForPart, partOfStep, partOfField, fieldsForPart
};
