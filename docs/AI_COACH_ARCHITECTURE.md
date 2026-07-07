# BodyBank.fit — AI Coach Architecture (Master Blueprint)

> **Status:** ✅ **v1 IMPLEMENTED (2026-07-07)** — Phases 1–6 built and tested (20 unit + 9 e2e green vs local Postgres). Code lives in `services/coach/` + `routes/coach.js`, wired into `server.js`. Runs behind `COACH_WORKERS_ENABLED` (default OFF: events record durably, nothing sends until flipped). Model tiers updated to current IDs: **Haiku 4.5 / Sonnet 5 / Opus 4.8** (this doc's `claude-sonnet-4-6` predates Sonnet 5). Degrades to safe templates when `ANTHROPIC_API_KEY` is unset. Remaining follow-ups: meal-log emit wiring (`routes/nutrition.js`), a frontend settings card, and Phase 7 A/B (`coach_experiments`). See the memory note `ai-coach-architecture` for the rollout env flags.
>
> Original design blueprint, v1. Grounds every recommendation in the *existing* BodyBank codebase (Node 20 / Express 5 / Postgres monolith, Anthropic Claude + Twilio WhatsApp already integrated). Build this **on top of** what exists — do not redesign the app.
>
> **Author intent:** A 24/7 personal coach that feels handwritten, remembers everything, and never spams. The hard part is *not* generating text — it's deciding **whether**, **when**, and **how** to speak. The Decision Engine and Memory System are the product; the LLM is a renderer.

---

## 0. TL;DR — the 7 decisions that define this system

1. **The LLM is the cheapest part.** The intelligence lives in a deterministic **Decision Engine** (should I speak? when? how loud?) and a **Memory System** (who is this person?). Claude only *renders* a message once the engine has decided to speak.
2. **In-app chat + push is the primary AI channel, not WhatsApp.** WhatsApp Business forbids freeform messages outside a 24-hour window (your code already hits error `63016`). Freeform AI coaching → in-app `thread_messages` + Web/FCM push (no window limit). WhatsApp → within-window replies + a small set of pre-approved templates.
3. **One message budget per user per day.** Hard cap (default 1–2 proactive touches/day, configurable). Every candidate message competes for the budget by priority/value score. This is how you avoid notification fatigue with 45 event types.
4. **Three model tiers.** Haiku 4.5 for the high-volume *classify/decide* step, Sonnet 4.6 for *message generation*, Opus 4.8 for *weekly/monthly narrative reports*. (Defaults — see §13; you can run everything on Opus 4.8 for max quality at ~5× the cost.)
5. **Events are already half-built.** `utils/notify.js` has an event taxonomy with `priority` + `dedup` TTLs. Generalize it into a durable `coach_events` queue instead of inventing a new system.
6. **Memory is layered:** durable Postgres facts (structured) + a rolling natural-language "user dossier" (the long-term memory the prompt reads) + recent message log (anti-repetition). No vector DB needed at launch (see §6.4 for when it is).
7. **Everything is opt-in, auditable, and cost-capped.** Per-user channel consent, quiet hours, a kill switch, full message provenance, and a hard monthly token budget with graceful degradation.

---

## 1. System architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BODYBANK APP (existing)                                                       │
│  Express routes → user actions: workout, meal, water, sleep, weight, checkin   │
└───────────────┬────────────────────────────────────────────────────────────── ┘
                │  emitCoachEvent(type, userId, payload)   ← single integration point
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  1. EVENT ENGINE        coach_events table (durable queue, status machine)     │
│     - ingest + dedup (reuse notify.js TTL logic)                               │
│     - classify priority/category                                               │
└───────────────┬──────────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  2. DECISION ENGINE     "should I speak, when, how loud?"                       │
│     deterministic gates → optional Haiku tie-break → schedule or drop          │
│     reads: message budget, quiet hours, recency, engagement, health score      │
└───────────────┬──────────────────────────────────────────────────────────────┘
                ▼ (decided: SEND NOW / SEND AT t / SUPPRESS / BATCH)
┌──────────────────────────────────────────────────────────────────────────────┐
│  3. CONTEXT BUILDER     assembles the prompt context pack                       │
│     - user dossier (long-term memory)  - structured stats (deterministic)       │
│     - recent coach messages (anti-repeat)  - personality profile               │
│     - relevant program knowledge (from bodybankAiCoachContext)                  │
└───────────────┬──────────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  4. MESSAGE GENERATOR   Claude (Sonnet 4.6) → 1 candidate message               │
│     - prompt template (versioned) + personality + context pack                  │
│     - self-check: length, no-repeat, tone, no fabricated numbers                │
└───────────────┬──────────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  5. DELIVERY ROUTER     channel selection + send                                │
│     in-app thread_messages + push (primary) | WhatsApp (in-window/template)     │
│     writes coach_messages (provenance) + updates memory                         │
└───────────────┬──────────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  6. FEEDBACK LOOP       opens, replies, action-after-message → effectiveness     │
│     feeds A/B, health score, and the dossier                                    │
└──────────────────────────────────────────────────────────────────────────────┘

  CRON / WORKERS (node-cron, IST):  daily health-score recompute · inactivity sweeps
  · weekly/monthly report generation · dossier refresh · budget reset · DLQ retry
```

### 1.1 Component map → files (new + reused)

| Layer | New module | Reuses / extends |
|---|---|---|
| Event Engine | `services/coach/eventEngine.js` | `utils/notify.js` (priority + dedup), existing `notifyAsync` call-sites |
| Decision Engine | `services/coach/decisionEngine.js` | `services/insightService.js`, health score |
| Memory | `services/coach/memoryService.js`, `services/coach/dossierService.js` | `users`, `daily_checkins`, `workout_logs`, `progress_logs` |
| Context | `services/coach/contextBuilder.js` | `services/bodybankAiCoachContext.js` (program library, data model) |
| Generator | `services/coach/messageGenerator.js` | existing Anthropic client pattern (`services/nutritionService.js`) |
| Personality | `services/coach/personalityEngine.js` | new |
| Delivery | `services/coach/deliveryRouter.js` | `services/whatsapp.js`, `sendPushToUser`, `thread_messages`, `user_inbox` |
| Health score | `services/coach/healthScore.js` | `services/scorecardService.js`, `muscleRankingService.js` |
| Scheduling | `services/coach/coachScheduler.js` | `services/campaignScheduler.js` (node-cron pattern, IST) |
| Prompts | `services/coach/prompts/*.js` | `bodybankAiCoachContext.js` system-prompt style |
| Orchestration | `services/coach/llm.js` | central Anthropic wrapper (model tiers, caching, retries) |

> **Why not a separate microservice?** Your app is a single Express process on Render with an in-memory rate limiter (per memory: won't survive multi-process). Keep the coach **in-process** for v1 (a `services/coach/` module tree + a worker started from `server.js`). Extract to a worker process only when §16 scaling triggers fire. Adding a microservice now would multiply the deploy/observability surface for no benefit at your current scale.

---

## 2. The Event Engine

### 2.1 Principle
Every meaningful action calls **one** function. That's the only thing the rest of the app needs to know about the coach.

```js
// services/coach/eventEngine.js
const { emitCoachEvent } = require('./eventEngine');

// e.g. inside the existing meal-log handler in routes/nutrition.js:
emitCoachEvent('MEAL_LOGGED', userId, {
  mealType, score, calories, protein, carbs, fat, date,
});
```

`emitCoachEvent` is **fire-and-forget and never throws** (same contract as `notifyAsync`). It:
1. Computes a dedup fingerprint (reuse `notify.js` `isDup`/`mark`, but persisted, not in-memory).
2. Inserts a row into `coach_events` with `status='pending'`.
3. Returns immediately. A worker drains the queue.

> **Why a durable table, not an in-memory queue?** Render restarts the process on every deploy (your push-notifications memory notes this). An in-memory queue loses events on deploy. A Postgres table is the simplest durable queue that survives restarts, gives you an audit trail for free, and needs no Redis. (Add Redis/BullMQ only at the §16 scale trigger.)

### 2.2 Event taxonomy

Generalize the existing `EVENT_META` map. Every event has: `category`, `base_priority`, `dedup_ttl`, `decay` (how fast it goes stale), and `default_action`.

| Category | Events | Notes |
|---|---|---|
| **Positive / reinforce** | `WORKOUT_COMPLETED`, `MEAL_LOGGED`, `PROTEIN_GOAL_HIT`, `WATER_GOAL_HIT`, `NEW_PR`, `STREAK_MILESTONE`, `GOAL_ACHIEVED`, `CONSISTENCY_IMPROVED`, `WEIGHT_GOAL_PROGRESS` | High value, but **most should NOT message** — batch into a daily/weekly summary. Over-praising is the #1 way to feel robotic. |
| **Corrective / nudge** | `WORKOUT_MISSED`, `PROTEIN_DEFICIT`, `CALORIE_EXCESS`, `CALORIE_DEFICIT_RISK`, `HYDRATION_LOW`, `SLEEP_LOW`, `PROGRESS_PLATEAU`, `RAPID_WEIGHT_LOSS`, `RAPID_WEIGHT_GAIN` | Never guilt. Frame as "I noticed X, here's one thing." Rate-limit hard. |
| **Lifecycle / re-engage** | `NO_ACTIVITY_1D`, `NO_ACTIVITY_3D`, `NO_ACTIVITY_7D`, `APP_REOPENED`, `COMEBACK`, `BIRTHDAY` | Comeback after a lapse is the single highest-leverage moment — make it warm, never "you missed 3 days." |
| **Scheduled / ritual** | `MORNING_CHECKIN`, `EVENING_REFLECTION`, `MEAL_REMINDER`, `WORKOUT_REMINDER`, `SLEEP_REMINDER`, `RECOVERY_REMINDER`, `DAILY_MOTIVATION`, `WEEKLY_SUMMARY`, `MONTHLY_SUMMARY`, `COACH_CHECKIN` | Time-driven, not event-driven. Personalized to the user's typical times (from memory). |
| **Conversational** | `USER_REPLIED` | User sent a message → highest priority, answer fast, bypasses budget. |

`coach_events` rows carry the raw payload; the Decision Engine, not the emitter, decides fate.

### 2.3 Status machine

```
pending → evaluating → (scheduled | suppressed | batched)
scheduled → generating → sent | failed
failed → (retry ≤ N) → sent | dead_letter
```

Every transition is timestamped. `suppressed` rows keep a `suppress_reason` (budget_exceeded, quiet_hours, deduped, low_value, user_muted_category) — this is gold for tuning and for the "why didn't the coach message me" debugging question.

---

## 3. The Decision Engine — the core product

This is where most fitness apps fail (they message on every event) and where ChatGPT-style products have nothing (they only react). **Deterministic gates first, LLM only as a tie-breaker.** Cheap, debuggable, and you can explain every decision.

### 3.1 The pipeline (in order; first failing gate wins)

```js
async function decide(event, user) {
  // HARD GATES (deterministic, no LLM) — return SUPPRESS immediately
  if (!user.coach_enabled)                 return suppress('coach_off');
  if (isMutedCategory(user, event))        return suppress('category_muted');
  if (inQuietHours(user, now))             return defer('quiet_hours'); // reschedule, don't drop
  if (isStale(event))                      return suppress('stale');     // event aged out via decay
  if (await isDuplicateRecent(event))      return suppress('deduped');

  // CONVERSATIONAL bypass — a user reply always gets answered, ignores budget
  if (event.type === 'USER_REPLIED')       return sendNow({ bypassBudget: true });

  // VALUE SCORE (deterministic 0–100)
  const score = valueScore(event, user);   // priority × freshness × user-fit × novelty
  if (score < user.min_send_threshold)     return suppress('low_value');

  // BUDGET — the anti-fatigue core
  const budget = await remainingBudget(user, today);
  if (budget <= 0) {
    return event.batchable ? batch('budget_exceeded') : suppress('budget_exceeded');
  }

  // TIMING — is now the best time, or would waiting produce a better message?
  const slot = bestSendSlot(event, user);  // uses learned active hours from memory
  if (slot.waitMinutes > 0 && event.deferrable) return defer('better_slot', slot.at);

  // OPTIONAL LLM TIE-BREAK (Haiku) — only for ambiguous mid-score events
  if (score >= 40 && score <= 60) {
    const verdict = await haikuShouldSend(contextSummary(event, user));
    if (!verdict.send) return suppress('llm_declined: ' + verdict.reason);
  }

  return sendNow();
}
```

### 3.2 The value score (deterministic)

```
value = base_priority(event)                      // 0–40 from taxonomy
      × freshness(event.age, event.decay)          // 1.0 → 0.0 as it ages
      × user_fit(event, user)                      // is this a known weak spot? ×1.3 ; a strength? ×0.7
      × novelty(event, recent_messages)            // talked about this in last 48h? ×0.4
      × engagement(user)                           // ignores last 5 msgs? ×0.6 ; replies often? ×1.2
```

`user_fit` is what makes it feel personal: if the dossier says "protein is this user's chronic weak spot," a `PROTEIN_DEFICIT` event scores higher than for someone who always hits protein. `novelty` is the anti-repetition guard *before* generation (the generator has a second guard).

### 3.3 Message budget (the anti-fatigue mechanism)

- Per-user daily budget of **proactive** messages (default 2; `coach_settings.daily_budget`). User replies and weekly/monthly reports don't count against it.
- Budget resets at the user's morning (IST cron).
- High-value events can **borrow** from tomorrow (max 1) for true urgency (e.g. `RAPID_WEIGHT_LOSS`).
- Positive reinforcement events almost never spend budget individually — they accumulate into the evening reflection / weekly summary.

> **Challenge to your spec:** you listed ~45 events as if each could message. With a 2/day budget and a value gate, on a typical active day a user gets *one* well-chosen message (e.g. a warm comeback nudge, or "your protein's been climbing all week — nice"), not 8 notifications. That's the difference between WHOOP and spam.

### 3.4 "Would waiting produce a better message?"
Yes, often. Examples the engine encodes:
- `WORKOUT_COMPLETED` at 7am → don't fire instantly. Hold; if they also log a good breakfast, send **one** message connecting both ("strong start — workout done and a 30g-protein breakfast"). Coalescing beats two pings.
- `PROTEIN_DEFICIT` detected at lunch → wait until ~5pm when they can still act ("you're at 60g, ~90 to go — dinner's your shot").
- `NO_ACTIVITY_1D` → never message same-day; the absence isn't meaningful yet.

This is the **coalescing window**: deferrable events sit in a short buffer (e.g. 2–4h) and the generator can fold several into one message.

---

## 4. Memory System

### 4.1 Three layers

| Layer | Store | Purpose | Updated |
|---|---|---|---|
| **Structured facts** | Postgres (existing tables + `coach_user_profile`) | Ground truth: goals, PRs, streaks, typical times, macro history | On every event (deterministic) |
| **Dossier** (long-term memory) | `coach_dossier.summary` (text) | The natural-language "what I know about this person" the prompt reads | Nightly cron + after significant events |
| **Recent message log** | `coach_messages` (last N) | Anti-repetition + conversational continuity | On every send |

### 4.2 The dossier — the heart of "feels like it knows me"

A compact (~300–500 word) markdown profile, regenerated nightly by Claude from structured data + the prior dossier. It's what gets injected into every generation prompt. Structure:

```markdown
## <Name> — coach dossier (updated 2026-06-29)
**Goal:** fat loss, target 78kg (from 84kg), ~0.5kg/wk. 11 weeks in.
**Program:** Ripper 2.0 (4-day split), assigned 2026-05-01.
**Personality fit:** responds to data + brief wins; goes quiet under pressure. Prefers Science Coach tone.
**Strengths:** training consistency (logs 4×/wk reliably), morning workouts (~6:30am).
**Weak spots:** protein (avg 95g vs 150g target), weekend nutrition collapses, sleep <6h on weeknights.
**Patterns:** trains Mon/Tue/Thu/Sat; skips when work-stressed (mentioned 2× in Sunday check-ins).
**Wins to remember:** hit first bodyweight bench 2026-06-10; 21-day streak in May.
**Recent arc:** 9-day plateau at 81kg, broke it last week (-0.6kg). Mood improving.
**Coaching notes:** do NOT nag about weekends — acknowledged it's hard, offered one swap. Last comeback worked when framed as "no big deal, let's go."
**Sensitive:** mentioned anxiety in onboarding — never use shame/guilt framing.
```

This is the long-term memory. It's cheap (one Haiku/Sonnet call per user per night, batchable), human-readable (admins can inspect/edit), and prompt-cacheable.

### 4.3 What the AI remembers (your list → where it lives)

| You asked it to remember | Lives in |
|---|---|
| Every workout / meal / weight / measurement | Existing tables (`workout_logs`, `progress_logs`, `daily_checkins`, `sunday_checkins`) |
| Every milestone / streak / PR | `coach_user_profile` (computed) + dossier "wins" |
| Every failure / comeback | Dossier "recent arc" + `coach_events` history |
| Every previous AI message | `coach_messages` |
| Coaching preferences / favourite foods/workouts / typical times / weekend behaviour / common excuses | Dossier (extracted nightly from check-ins + patterns) |

### 4.4 Do you need a vector DB / RAG?
**Not at launch.** Your per-user data is small and bounded — the dossier + structured queries fit comfortably in context. Add pgvector **only** when you want semantic recall over a large free-text history (e.g. "what did they say about their knee injury 4 months ago?" across hundreds of Sunday check-ins). When that day comes: `pgvector` extension on your existing Postgres, embed Sunday check-in narratives + chat history, retrieve top-k into the context pack. No separate vector service needed. (§6.4 has the trigger.)

---

## 5. Personality Engine

### 5.1 Personalities (your list, refined)

| Personality | Voice | Default for |
|---|---|---|
| **Friendly Coach** | warm, encouraging, casual | most users (default) |
| **Science Coach** | data-first, explains the "why", cites numbers | analytical users, data-loggers |
| **Athletic Coach** | direct, intense, performance language | advanced lifters, PR-chasers |
| **Strict Accountability** | firm, no-excuses, but never cruel | users who *opt in* to tough love |
| **Minimalist** | one line, no fluff, just the signal | low-tolerance-for-notifications users |
| **Premium Concierge** | polished, anticipatory, "your manager" | high-tier members (ties to your "Lifestyle Manager" brand) |

### 5.2 Implementation
A personality is **not** a different model — it's a swappable system-prompt fragment + tone parameters (`max_words`, `emoji_budget`, `warmth`, `directness`). The Context Builder injects the active fragment. Users switch in settings; the engine can also **auto-suggest** a switch ("want me to keep it short and skip the pep talk?") when it detects low engagement with the current tone.

```js
// personality fragment example (Science Coach)
const SCIENCE_COACH = {
  id: 'science',
  voice: `You explain the mechanism in one clause, then the action. You use exact numbers
from the context (never invent them). Calm, precise, no hype. Max 1 emoji, often zero.`,
  maxWords: 90, emojiBudget: 1, warmth: 0.5, directness: 0.8,
};
```

> **Reuse:** your `bodybankAiCoachContext.js` already encodes a strong, evidence-based, non-fluffy voice (trainer-facing). Lift its *values* (never fabricate numbers, tie advice to the user's data, no generic advice) into the **shared base voice** that all personalities inherit, then layer tone on top.

---

## 6. AI Orchestration, Prompts & Context

### 6.1 The central LLM wrapper (`services/coach/llm.js`)
One module owns every Claude call: model selection, prompt caching, streaming for long outputs, retries with backoff, refusal handling, token accounting, and the monthly budget kill-switch. Mirrors your existing Anthropic usage in `services/nutritionService.js` but centralizes it.

```js
// Tiers (see §13 for cost rationale; all overridable per-call)
const TIER = {
  decide:   'claude-haiku-4-5',   // should-send tie-break, classification
  generate: 'claude-sonnet-4-6',  // the handwritten coaching message
  report:   'claude-opus-4-8',    // weekly/monthly narrative, dossier synthesis
};
```

Key behaviors:
- **Adaptive thinking** (`thinking: {type:'adaptive'}`) on report/dossier calls; off for short message generation (latency).
- **Prompt caching:** the personality base voice + program library + data-model description are a *stable prefix* → mark with `cache_control` so repeated generations pay ~0.1× on that prefix. Put the volatile per-user dossier and event *after* the cache breakpoint. (Prefix-match caching: any byte change before the breakpoint invalidates it — keep the prefix frozen and deterministic.)
- **Streaming** for any `max_tokens > ~16k` (monthly reports) to avoid HTTP timeouts.
- **Refusal/fallback:** check `stop_reason` before reading content; on transient errors retry, on persistent failure fall back to a **safe templated message** (never leave the user hanging or send a half-message).

### 6.2 The context pack (what the generator sees)

```
[ system, cached prefix ]
  BASE VOICE (shared values: never fabricate, tie to data, no shame)
  ACTIVE PERSONALITY fragment
  DATA MODEL note (from bodybankAiCoachContext — daily_checkin vs workout_log etc.)
  RELEVANT PROGRAM knowledge (only the user's assigned program, not all 17)

[ user turn, NOT cached — volatile ]
  DOSSIER (long-term memory)
  TRIGGER: <event type + structured payload>
  DETERMINISTIC STATS: <pre-computed; e.g. "protein today 95g/150g; 7-day avg 102g">
  RECENT COACH MESSAGES (last 5, for anti-repetition): "<…>"
  HEALTH SCORE: <87/100, driven up by training, down by sleep>
  CONSTRAINTS: max_words=90, channel=in_app, time=evening, language=en
  TASK: write ONE message. <output rules>
```

> **Critical reuse:** `bodybankAiCoachContext.js` already documents the exact data model (daily_checkins vs sunday_checkins vs workout_logs, `session_lifts` JSON, canonical bench/squat/deadlift). Inject that note so the coach never says "you didn't log protein on your workout day" when protein lives in a different table — a real bug class your trainer-AI prompt already guards against.

### 6.3 Prompt templates + versioning
- Each message *type* (comeback, plateau, protein-nudge, weekly-summary) has a template module exporting `{ id, version, build(ctx) }`.
- Store the `prompt_version` on every `coach_messages` row → you can correlate a prompt change with engagement deltas, and A/B two versions cleanly.
- Templates are **data-light, instruction-heavy**: they tell Claude the *job and the rules*, and let the dossier+stats supply the specifics. (Opus/Sonnet do worse with over-prescriptive, example-stuffed prompts — state the goal and constraints, not a script.)

**Example template (protein nudge, Science Coach):**
```
TASK: The user is short on protein today and there's still a meal left to log.
Write ONE message (≤90 words) that:
- States the gap with the exact numbers from STATS (do not round away from them).
- Gives ONE concrete, achievable action for their next meal (use their known favourite
  high-protein foods from the dossier if present).
- Does not mention previous days unless STATS shows a multi-day pattern worth naming.
- No guilt, no "you should have." Forward-looking only.
- Must not repeat any phrasing from RECENT COACH MESSAGES.
Output: the message text only. No preamble, no sign-off, no emoji unless it adds warmth.
```

### 6.4 When to add RAG / pgvector
Trigger: when free-text history (Sunday check-ins, chat) per user exceeds what you'll inline (~practically, hundreds of entries) **and** the coach needs semantic recall ("they mentioned a shoulder issue months ago"). Then: enable `pgvector`, embed narratives, retrieve top-k into the context pack. Until then, the dossier is your retrieval layer.

---

## 7. WhatsApp & multi-channel delivery strategy

### 7.1 The hard constraint (must design around)
- **In-window (≤24h since user's last inbound WhatsApp):** freeform AI text is allowed. 
- **Out-of-window:** only **pre-approved template messages** — no freeform AI text. Your `whatsapp.js` already falls back to templates on error `63016`.
- Your current `TWILIO_WHATSAPP_FROM` is the **sandbox**. Production requires a WhatsApp Business sender + approved templates + explicit user opt-in.

### 7.2 Channel routing (Delivery Router)

```
            ┌─ user replied within 24h? → WhatsApp freeform (in-window)  ── best
proactive ─┤
 message    ├─ user opted into WhatsApp + out-of-window + message maps to
            │     an approved template → send template (limited expressiveness)
            └─ else → IN-APP: thread_messages + user_inbox + push   ── default, no window limit
```

- **In-app chat is the primary AI surface** because it has no window restriction and you already deliver to it (`campaignScheduler.broadcastMessage` writes `thread_messages` + `user_inbox` + push). The AI coach becomes the automated voice of the existing "Lifestyle Manager" thread.
- **Push** (`sendPushToUser` / FCM) carries the title + first ~120 chars; tapping opens the thread.
- **WhatsApp** is reserved for: (a) replies inside the 24h window, (b) a small set of approved templates for high-value re-engagement (`COMEBACK`, `WEEKLY_SUMMARY` teaser) where you accept reduced expressiveness for reach.

### 7.3 Message constraints (your spec, enforced in code)
- Proactive message: **40–110 words** (tighter than your 80–150 — shorter reads as more human in a chat bubble). Weekly/monthly summaries may run longer.
- Generator output passes a **post-filter**: word count, emoji budget, no banned phrases (a configurable list of "AI-slop" openers like "I hope this message finds you"), and a similarity check against the last 5 messages (reject + regenerate once if too similar).

---

## 8. Health Score (the coach's internal compass)

A 0–100 composite, recomputed nightly, that *drives coaching* (not just a vanity number). Reuse `scorecardService.js` / `muscleRankingService.js` where they already compute sub-scores.

| Dimension | Source | Weight (default) |
|---|---|---|
| Workout consistency | `workout_logs` completed vs program target | 20 |
| Nutrition quality | meal scores (`nutritionService.computeMealScore`) | 15 |
| Protein adherence | `daily_checkins.protein` vs target | 12 |
| Hydration | `daily_checkins.water_ml` | 8 |
| Sleep | `daily_checkins.sleep` | 12 |
| Recovery | rest-day balance, intensity vs energy | 8 |
| Consistency / streak | `coach_user_profile.streak` | 10 |
| Body composition trend | `progress_logs` weight/BF trajectory vs goal | 10 |
| Mood | Sunday check-in sentiment | 5 |

The score is stored with a **per-dimension breakdown** so the coach can say "your score dipped — it's sleep, not training." The score's **biggest negative driver** is a primary input to the Decision Engine's `user_fit` factor: the coach focuses on the weakest lever, not random events.

---

## 9. Database schema (new tables — Postgres)

> Follows your existing conventions: UUID PKs (`uuidv4`), `NOW()` defaults, your `queryAll`/`run` helpers. Add via your startup auto-create path now; migrate to a real migration tool (Knex) when schema churn justifies it (already flagged in your codebase concerns).

```sql
-- 1. Event queue
CREATE TABLE coach_events (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,
  category      TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  priority      INT  NOT NULL DEFAULT 0,
  dedup_key     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|evaluating|scheduled|batched|suppressed|generating|sent|failed|dead_letter
  suppress_reason TEXT,
  scheduled_for TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_coach_events_pending ON coach_events(status, scheduled_for);
CREATE INDEX idx_coach_events_user    ON coach_events(user_id, created_at DESC);
CREATE INDEX idx_coach_events_dedup   ON coach_events(user_id, dedup_key, created_at DESC);

-- 2. Per-user coach settings (consent, budget, quiet hours, personality)
CREATE TABLE coach_settings (
  user_id           UUID PRIMARY KEY REFERENCES users(id),
  coach_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  personality       TEXT    NOT NULL DEFAULT 'friendly',
  daily_budget      INT     NOT NULL DEFAULT 2,
  min_send_threshold INT    NOT NULL DEFAULT 35,
  quiet_start       TIME    NOT NULL DEFAULT '21:30',
  quiet_end         TIME    NOT NULL DEFAULT '07:30',
  timezone          TEXT    NOT NULL DEFAULT 'Asia/Kolkata',
  whatsapp_opt_in   BOOLEAN NOT NULL DEFAULT FALSE,
  muted_categories  JSONB   NOT NULL DEFAULT '[]',
  language          TEXT    NOT NULL DEFAULT 'en',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Long-term memory dossier
CREATE TABLE coach_dossier (
  user_id     UUID PRIMARY KEY REFERENCES users(id),
  summary     TEXT NOT NULL DEFAULT '',          -- the markdown dossier (the prompt reads this)
  facts       JSONB NOT NULL DEFAULT '{}',        -- structured extracted facts
  version     INT  NOT NULL DEFAULT 1,
  refreshed_at TIMESTAMPTZ
);

-- 4. Computed per-user profile (fast read for decision/score)
CREATE TABLE coach_user_profile (
  user_id        UUID PRIMARY KEY REFERENCES users(id),
  health_score   INT,
  score_breakdown JSONB,
  streak_days    INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  typical_workout_hour INT,            -- learned active hours
  active_hours   JSONB,                -- histogram of activity by hour
  weak_dimension TEXT,                 -- biggest negative score driver
  last_active_at TIMESTAMPTZ,
  recomputed_at  TIMESTAMPTZ
);

-- 5. Message provenance + anti-repetition + feedback
CREATE TABLE coach_messages (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  event_id      UUID REFERENCES coach_events(id),
  type          TEXT NOT NULL,
  channel       TEXT NOT NULL,         -- in_app|whatsapp|push
  personality   TEXT,
  prompt_version TEXT,
  model         TEXT,
  body          TEXT NOT NULL,
  ab_variant    TEXT,
  tokens_in     INT, tokens_out INT, cost_usd NUMERIC(10,5),
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- feedback
  opened_at     TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ,
  action_after  TEXT,                  -- did they log/workout within N hours?
  reaction      TEXT                   -- thumbs up/down if surfaced in UI
);
CREATE INDEX idx_coach_messages_user ON coach_messages(user_id, sent_at DESC);

-- 6. Daily budget ledger (cheap, resettable)
CREATE TABLE coach_budget_ledger (
  user_id  UUID NOT NULL REFERENCES users(id),
  ymd      DATE NOT NULL,
  spent    INT  NOT NULL DEFAULT 0,
  borrowed INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ymd)
);

-- 7. Token/cost accounting (global kill-switch input)
CREATE TABLE coach_cost_ledger (
  ymd        DATE PRIMARY KEY,
  tokens_in  BIGINT DEFAULT 0,
  tokens_out BIGINT DEFAULT 0,
  cost_usd   NUMERIC(12,4) DEFAULT 0,
  message_count INT DEFAULT 0
);

-- 8. A/B experiments
CREATE TABLE coach_experiments (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  variants    JSONB NOT NULL,          -- [{key, prompt_version, weight}]
  metric      TEXT NOT NULL,           -- reply_rate|action_rate|7d_retention
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 10. APIs (new endpoints)

All under `routes/coach.js`, mounted in `server.js`, guarded by your existing `middleware/auth.js`.

**User-facing**
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/coach/settings` | get coach settings |
| `PUT` | `/api/coach/settings` | update personality, budget, quiet hours, mute categories, WhatsApp opt-in |
| `POST` | `/api/coach/chat` | user sends a message → emits `USER_REPLIED` → returns AI reply (streamed) |
| `GET` | `/api/coach/messages` | message history (the Lifestyle Manager thread) |
| `POST` | `/api/coach/messages/:id/feedback` | thumbs up/down, "too many", "wrong tone" |
| `GET` | `/api/coach/score` | health score + breakdown |
| `POST` | `/api/coach/pause` | snooze coach for N days (kill switch, user-controlled) |

**Internal / admin**
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/internal/coach/events` | (or in-process `emitCoachEvent`) ingest event |
| `GET` | `/api/admin/coach/users/:id` | inspect dossier, recent decisions, suppressed events ("why no message?") |
| `PUT` | `/api/admin/coach/users/:id/dossier` | human-edit a dossier (override) |
| `GET` | `/api/admin/coach/metrics` | send volume, reply rate, action rate, cost, suppression breakdown |
| `POST` | `/api/admin/coach/experiments` | create/manage A/B tests |
| `POST` | `/api/admin/coach/kill-switch` | global pause (cost overrun / incident) |

---

## 11. Background jobs (node-cron, IST — reuse `campaignScheduler` pattern)

| Job | Cadence | Does |
|---|---|---|
| **Event drain worker** | every 30–60s | pull `pending`/`scheduled` events due now → Decision Engine → generate → deliver |
| **Coalescing flush** | every 5 min | flush deferred/batched events whose window closed |
| **Budget reset** | daily, per-user morning | reset `coach_budget_ledger` |
| **Health score recompute** | nightly | recompute `coach_user_profile` (batchable across users) |
| **Dossier refresh** | nightly (staggered) | regenerate dossiers for users with activity that day (Batch API — §13) |
| **Inactivity sweep** | daily | emit `NO_ACTIVITY_1D/3D/7D`, `COMEBACK` candidates |
| **Scheduled rituals** | per user's preferred times | morning check-in, evening reflection, reminders |
| **Weekly / monthly reports** | Sun / 1st | Opus 4.8 narrative summary → in-app + (template) WhatsApp |
| **DLQ retry** | every 10 min | retry `failed` events with backoff; escalate to `dead_letter` after N |
| **Cost guard** | hourly | sum `coach_cost_ledger`; if over monthly budget → degrade (Haiku-only / templates) → kill-switch |

> **Scaling note:** node-cron in a single process is fine to ~thousands of active users. Beyond that, the drain worker becomes the bottleneck — move to a dedicated worker process + Redis/BullMQ (§16). Use `SELECT ... FOR UPDATE SKIP LOCKED` on `coach_events` so multiple workers can drain safely when you get there.

---

## 12. Rate limiting, caching, cost optimization

### 12.1 Cost model (grounded, current pricing)
Per-MTok: **Haiku 4.5** $1 in / $5 out · **Sonnet 4.6** $3 / $15 · **Opus 4.8** $5 / $25. Batch API −50%. Cache reads ~0.1× input; cache writes 1.25× (5-min TTL).

A typical proactive message: ~2k input (cached prefix → ~0.1×) + ~1.5k fresh context + ~120 output tokens.
- On **Sonnet 4.6**, with the stable prefix cached, one message ≈ **$0.005–0.015**.
- On **Haiku 4.5** (decision tie-breaks, classification): sub-cent.
- **Reports on Opus 4.8** are rare (1/user/week) and longer, but batchable.

At 2 messages/user/day on Sonnet with caching, **10k active users ≈ $100–300/day** — bounded and predictable. The budget cap + cost ledger make it a *hard* ceiling, not a hope.

### 12.2 Levers (in priority order)
1. **Decision Engine suppression** — the cheapest token is the one never generated. Most cost savings come from *not sending*, not from cheaper models.
2. **Prompt caching** — freeze the base voice + program + data-model prefix; cache it. This is the biggest per-call saving.
3. **Batch API (−50%)** for everything non-real-time: nightly dossier refresh, weekly reports, health-score narratives. Real-time only for `USER_REPLIED` and time-sensitive nudges.
4. **Model tiering** — Haiku for decide/classify, Sonnet for generate, Opus only for reports.
5. **Monthly token budget** (`coach_cost_ledger`) with graceful degradation: at 80% → Haiku-only generation; at 100% → templates only + alert. Never a surprise bill.

### 12.3 Rate limiting
Your current rate limiter is in-memory (won't survive multi-process — flagged in your concerns). For the coach: per-user send limits live in `coach_budget_ledger` (DB-backed, survives restarts) — don't rely on the in-memory limiter for anything that must be durable. Add a per-org Anthropic concurrency cap in `llm.js` (queue + backoff on 429).

---

## 13. Model strategy (recommendation — adjustable)

| Job | Recommended | Why | Max-quality alt |
|---|---|---|---|
| Should-send tie-break, classification, sentiment | **Haiku 4.5** | high volume, simple judgment, cheap | Sonnet 4.6 |
| Coaching message generation | **Sonnet 4.6** | best warmth/quality per dollar; the user-facing voice | Opus 4.8 |
| Weekly/monthly reports, dossier synthesis | **Opus 4.8** | reasoning + long-form narrative quality | — |

> **Note on defaults:** Anthropic's guidance is to default to Opus 4.8. The tiering above is a *cost-optimized* recommendation for a high-volume messaging system — it's your call. If message quality is paramount and budget allows, run generation on **Opus 4.8** too (~5× the generation cost vs Haiku, ~1.7× vs Sonnet). The architecture makes the model a one-line config per job (`TIER` in `llm.js`), so you can A/B Sonnet vs Opus on real reply/action rates and decide with data.

---

## 14. Observability, analytics & A/B testing

- **Provenance:** every message row carries `event_id`, `prompt_version`, `model`, `ab_variant`, tokens, cost → full traceability from "why did this message exist" to "what did it cost and do."
- **Core metrics:** send volume, suppression breakdown (by reason), open rate, reply rate, **action-after rate** (did they log/work out within N hours of the message? — the real ROI), category mute rate, cost/user/day.
- **The north-star metric is action-after rate, not opens.** A message that gets opened but changes nothing is noise.
- **A/B:** assign variants at generation time (`coach_experiments`), compare on `action_rate` / 7-day retention. Start with: comeback framing, protein-nudge tone, reminder timing.
- **Admin "decision inspector":** for any user, show the last N events and *why* each was sent or suppressed. This makes the engine debuggable and builds trust ("the coach went quiet because you'd hit your daily limit, not because it forgot you").
- **Reuse:** your `notify.js` already pings admins on events; extend it to surface coach health (DLQ depth, cost burn, error rate) to the admin WhatsApp.

---

## 15. Failure recovery & fallback

| Failure | Behavior |
|---|---|
| Claude API error / timeout | retry w/ backoff (SDK does 429/5xx); on persistent failure → safe templated message or **suppress** (never send a broken/half message) |
| Refusal (`stop_reason`) | check before reading content; fall back to template; log for review |
| WhatsApp out-of-window (`63016`) | already handled → template, or reroute to in-app + push |
| Worker crash / deploy restart | events are durable in Postgres; worker resumes from `pending`/`scheduled` |
| Dossier generation fails | keep last good dossier; coach still works on structured stats |
| Cost overrun | graceful degradation (§12.2) → kill-switch |
| Bad message detected post-hoc (user "wrong tone" feedback) | log → tune personality fit; never auto-resend |

Guiding rule: **silence is always a safe fallback.** A coach that occasionally says nothing is fine; a coach that sends a broken or repetitive message erodes trust permanently.

---

## 16. Scaling to millions

| Trigger | Change |
|---|---|
| Drain worker can't keep up / >~5k active users | extract coach into a **dedicated worker process**; `coach_events` drained with `FOR UPDATE SKIP LOCKED` |
| Multi-process / horizontal | move queue to **Redis + BullMQ**; move rate-limit/budget counters to Redis (your in-memory limiter already can't scale — flagged) |
| Dossier/report volume | lean harder on **Batch API**; shard nightly jobs across workers by user-id hash |
| Free-text recall needed | add **pgvector** (§6.4) |
| Postgres event-table hot | partition `coach_events`/`coach_messages` by month; archive `sent`/`suppressed` to cold storage |
| Global user base | per-user `timezone` already in `coach_settings` → schedule rituals in local time, not just IST |

The architecture is **horizontally scalable by design**: events are durable and idempotent (dedup keys), workers are stateless, and all per-user state is in Postgres/Redis. Nothing about v1 blocks the path to millions — you just swap the queue and split the worker.

---

## 17. Folder structure

```
services/coach/
  index.js                 # public API: emitCoachEvent, startCoachWorkers
  eventEngine.js           # ingest, dedup, status machine
  decisionEngine.js        # the gates + value score + budget
  valueScore.js            # scoring functions (pure, unit-tested)
  memoryService.js         # structured facts read/write
  dossierService.js        # nightly dossier (re)generation
  contextBuilder.js        # assemble the prompt context pack
  personalityEngine.js     # personality fragments + tone params
  messageGenerator.js      # generate + post-filter (length/repeat/slop)
  deliveryRouter.js        # channel selection + send (whatsapp/in-app/push)
  healthScore.js           # composite score + breakdown
  coachScheduler.js        # node-cron jobs (IST + per-user tz)
  llm.js                   # central Anthropic wrapper (tiers, cache, retry, budget)
  costGuard.js             # token ledger + degradation + kill-switch
  experiments.js           # A/B assignment + readout
  prompts/
    base.js                # shared base voice (lifted from bodybankAiCoachContext values)
    personalities/         # friendly.js, science.js, athletic.js, strict.js, minimal.js, concierge.js
    templates/             # comeback.js, plateau.js, proteinNudge.js, weeklySummary.js, ...
routes/coach.js            # user + admin endpoints
tests/coach/               # decision-engine + value-score + post-filter unit tests
docs/AI_COACH_ARCHITECTURE.md   # this file
```

---

## 18. Implementation phases (maps to your plan)

| Phase | Ships | Done when |
|---|---|---|
| **1 — Event Engine** | `coach_events` table, `emitCoachEvent`, wire 5–6 key events (workout, meal, weight, checkin, inactivity), drain worker skeleton | events flow durably end-to-end; no messages yet, just logged decisions |
| **2 — Decision Engine** | gates, value score, budget ledger, quiet hours, suppression reasons, admin decision inspector | a real "should I send" verdict with full reasons; still no LLM text (use stub templates) |
| **3 — Memory & Profile** | `coach_user_profile`, `coach_dossier`, nightly dossier job, health score | dossier reads well for 10 test users; score breakdown stable |
| **4 — Prompt System** | `llm.js` (tiers+cache+retry), base voice, personality engine, templates, post-filter | generates a handwritten message for any event type, passes anti-repeat/length filters |
| **5 — Delivery** | delivery router, channel routing, in-app thread + push live, WhatsApp in-window + templates, user settings UI | users receive real coach messages in-app; WhatsApp opt-in works |
| **6 — Analytics & Health Score** | metrics dashboard, action-after tracking, cost ledger + guard, kill switch | you can see reply/action rate and cost/user/day; budget cap enforced |
| **7 — A/B & tuning** | `coach_experiments`, variant assignment, first 3 experiments, personality auto-suggest | data-driven prompt/timing iteration loop running |

**Build and review each phase before the next.** Phases 1–2 deliver the hard/novel part (the engine) with *zero LLM risk* — you can validate "is it deciding sensibly?" before spending a token on generation.

---

## 19. Features you didn't ask for (high-leverage additions)

1. **Coalescing / message-merging** (§3.4) — fold multiple same-window events into one message. The biggest single anti-spam lever after the budget. *Strongly recommend for v1.*
2. **Action-after-rate as the north-star** — measure behavior change, not opens. Reframes the whole product around outcomes.
3. **The "comeback" moment as a first-class flow** — the warm, no-shame re-engagement after a lapse is the highest-retention message you'll ever send. Give it its own template, tone, and A/B.
4. **User-controllable everything** — budget slider, "too many messages" button, personality switch, snooze. Users who feel in control don't churn from notification fatigue; they self-tune.
5. **Decision inspector for admins** — "why didn't the coach message me?" is answerable. Builds trust and is invaluable for tuning.
6. **Personality auto-suggest** — detect low engagement with current tone → proactively offer Minimalist/Science. The coach adapting *how* it talks is a stronger "knows me" signal than what it says.
7. **Anti-slop post-filter** — a banned-phrase list + cross-message similarity check catches "robotic" output deterministically, before it reaches the user. Cheaper and more reliable than asking the model to "sound human."
8. **Two-way conversation, not just broadcast** — `USER_REPLIED` makes the Lifestyle Manager thread a real dialogue. A user who can *ask* the coach ("what should I eat tonight to hit protein?") and get a grounded answer is dramatically stickier than one who only receives nudges.
9. **Pre-warm the prompt cache** at the start of each batch window so the first message of a run isn't slow/cold.
10. **Quiet-hours + per-user timezone from day one** (already in `coach_settings`) — you have international users (your memory notes iOS publishing / multi-region); IST-only scheduling would message people at 3am.

---

## 20. Challenges to your assumptions (read this)

1. **"Every meaningful action → decide whether to message."** Correct in spirit, but the answer is *usually no*. Most events should feed memory/score and surface only in the daily/weekly digest. Design for silence as the default; speaking is the exception that must earn its place against the budget.
2. **"Every WhatsApp message feels handwritten."** Only inside the 24h window. Out-of-window you're limited to approved templates. Make in-app chat the primary AI channel; treat WhatsApp as reach, not the canvas. (And move off the Twilio sandbox before launch.)
3. **"Remember every previous conversation / message."** Don't stuff raw history into context — it's expensive and degrades quality. The **dossier** is the memory; raw history is retrieval-on-demand (and only needs pgvector once it's large).
4. **45 event types** is a *menu*, not a *schedule*. Without the budget + value gate, this is a spam cannon. The engine is what turns 45 triggers into ~1 great message a day.
5. **"Increase DAU/WAU/retention."** A coach that messages too much *decreases* these (uninstalls, push-permission revocation). The cap and the action-after metric are how you actually move retention, not raw message volume.
6. **Store-policy / consent risk.** Proactive messaging + (per your memory) the manual-billing access gate are areas reviewers scrutinize. Make consent explicit, opt-out trivial, and never make coaching contingent on payment in a way that reads as pressure.
7. **Model default.** I've recommended Sonnet 4.6 for generation to control cost at volume; Anthropic's default is Opus 4.8. This is a deliberate, reversible tradeoff — validate with an A/B on action-after rate before committing.

---

## 21. Open questions for you (decide before Phase 4–5)

- **Default message budget:** 1, 2, or 3 proactive messages/day? (Recommend start at 2, let users lower.)
- **Generation model:** Sonnet 4.6 (cost-optimized) or Opus 4.8 (max quality)? (Recommend Sonnet + A/B.)
- **WhatsApp production:** are you moving off the Twilio sandbox to an approved Business sender, and do you have template approval bandwidth? (If not, ship in-app + push first, add WhatsApp in a fast-follow.)
- **Languages:** English-only at launch, or multilingual from day one? (`coach_settings.language` is wired either way.)
- **Tough-love personality:** include "Strict Accountability" at launch, or hold it until you've tuned the no-shame guardrails? (Recommend hold — it's the easiest to get wrong.)
```
