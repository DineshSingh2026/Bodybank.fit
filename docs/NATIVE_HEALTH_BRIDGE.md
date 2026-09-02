# Native Health Bridge — implementation spec for `bodybank-app`

**Audience:** whoever implements HealthKit (iOS) and Health Connect (Android) reads in the
`bodybank-app` Capacitor repo.
**Server counterparts:** `services/wearables/adapters/healthConnect.js` (Android + the iOS
native path) and `services/wearables/adapters/appleHealth.js` (the file-upload path).
**Contract:** `services/wearables/canonicalDay.js`.

This document is the whole interface. If something here is ambiguous, that is a bug in
this document — raise it rather than guessing, because a guessed number is worse than a
missing one everywhere in this system.

---

## 0. The one rule that governs everything

> **A metric is only ever written into a canonical field when it means the same physical
> thing as every other device writing that field.**

The concrete consequence for you: **HRV is not one number.** Apple reports **SDNN** from a
~60-second spot check. Health Connect reports **RMSSD**. Whoop and Oura report RMSSD
averaged across a whole night. SDNN over a minute runs materially higher than overnight
RMSSD, by a ratio specific to the individual. If a member's Apple HRV were charted on the
same line as their Whoop HRV, every trend, baseline and readiness verdict downstream would
be wrong — and it would still look plausible, which is what makes it dangerous.

So every HRV value crossing this bridge carries a **method tag**, and the client is
required to state it. **Do not infer it. Do not default it to something optimistic.** If
you cannot determine the window a reading came from, send nothing for the window field and
the server tags the day `unknown`, which keeps it out of cross-device comparison.

The same applies to temperature: an *absolute* skin temperature (~33 °C) and a *deviation
from baseline* (~-0.3 °C) are different numbers and live in different fields. Send the
basis explicitly or the server refuses the value.

---

## 1. Which path each platform takes

| Platform | Source | Transport | Server adapter |
|---|---|---|---|
| Android (all brands: Samsung, Amazfit/Zepp, Fitbit app, Garmin Connect, Mi Band, Google Fit) | Health Connect | `POST /api/wearables/native/health-connect`, JSON | `adapters/healthConnect.js` |
| iOS | HealthKit | `POST /api/wearables/native/health-connect`, **the same JSON schema** with `platform: "ios"` | `adapters/healthConnect.js` |
| iOS, historical backfill | `export.zip` the member exports from the Health app | `POST /api/wearables/apple/upload`, **raw bytes, streamed** | `adapters/appleHealth.js` |

The native JSON schema is deliberately shared between HealthKit and Health Connect. It is
a *daily aggregate* schema, not a HealthKit-shaped one, so the same client code path and
the same server adapter serve both. The only per-platform work is reading the samples and
aggregating them.

**Do not use the file-upload path for routine sync.** It exists for one thing: importing a
member's multi-year history the first time they connect an Apple Watch. Everything
afterwards comes through the native JSON bridge.

---

## 2. The JSON payload

`Content-Type: application/json`. One POST covers a window of days.

```jsonc
{
  "schemaVersion": 1,                       // REQUIRED. Integer. See §2.1.
  "provider": "health_connect",             // "health_connect" | "apple_healthkit"
  "timezone": "Asia/Kolkata",               // IANA zone the dates below were computed in
  "exportedAt": "2026-08-03T09:12:00+05:30",

  "device": {
    "platform": "android",                  // "android" | "ios"
    "manufacturer": "Samsung",
    "model": "Galaxy Watch6 Classic",
    "appVersion": "1.8.0",                  // your app's version
    "healthConnectVersion": "1.1.0-alpha07",// or iOS version on Apple
    "originPackages": [                     // who actually wrote the data (see §5)
      "com.samsung.android.wear.shealth"
    ]
  },

  "days": [
    {
      "date": "2026-08-01",                 // REQUIRED. YYYY-MM-DD. See §3 for which day.

      "restingHeartRateBpm": 54,
      "heartRateAvgBpm": 71,
      "heartRateMaxBpm": 158,
      "oxygenSaturationPct": 96.5,          // 0-100, NOT a 0-1 fraction
      "respiratoryRateBrpm": 14.2,

      "hrv": {
        "valueMs": 41.2,
        "metric": "rmssd",                  // "rmssd" | "sdnn"      — REQUIRED if valueMs
        "window": "sleep"                   // "sleep" | "spot"      — REQUIRED if valueMs
      },

      "skinTemperature": {
        "valueC": 33.1,                     // absolute °C ...
        "basis": "absolute_c"               // ... and say so. See §4.
      },

      "sleep": {
        "totalMinutes": 412,                // the NIGHT only. Naps excluded. See §3.
        "remMinutes": 96,
        "deepMinutes": 71,
        "lightMinutes": 245,
        "awakeMinutes": 22,
        "inBedMinutes": 441,
        "napMinutes": 35,                   // all daytime sleep, summed
        "efficiencyPct": 93.4               // optional; derived from inBed if omitted
      },

      "steps": 8123,
      "activeCaloriesKcal": 480,
      "totalCaloriesKcal": 2210,            // active + basal; preferred if you have it
      "basalCaloriesKcal": 1730,
      "exerciseMinutes": 42,

      "providerScores": {                   // device-native, never cross-compared
        "samsung.sleep_score": 78
      }
    }
  ],

  "workouts": [
    {
      "date": "2026-08-01",
      "startedAt": "2026-08-01T18:00:00+05:30",
      "endedAt":   "2026-08-01T18:47:30+05:30",
      "durationMin": 47.5,
      "activity": "STRENGTH_TRAINING",
      "energyKcal": 412,
      "avgHr": 128.4,
      "maxHr": 164
    }
  ]
}
```

### 2.1 Versioning

`schemaVersion` is **required** and must be an integer the server knows. The server's
authoritative list is `SCHEMA_VERSIONS` in `services/wearables/adapters/healthConnect.js`;
today that is `[1]`.

An unknown version is **refused outright** — not best-effort parsed. That is deliberate:
a v2 payload read with v1 rules would silently mean something different. Consequences for
you:

- Ship the version you were built against and never bump it speculatively.
- Old app builds keep working after a server deploy, because the server keeps accepting
  older versions.
- Before you change the *meaning* of any field, bump the version and tell the server team
  so `SCHEMA_VERSIONS` gains the new entry **before** the app ships.

### 2.2 Types

- Every numeric field must be a **JSON number or `null`** — never a string. `"8000"` is
  rejected with a reason, not coerced, because a stringified number is usually a symptom
  (a locale-formatted float, a stringified `NaN`).
- **A missing value is `null` or the key is absent. Never send `0` for "we don't know".**
  Zero is a legitimate reading for steps, calories and awake time, and the difference
  between "no data" and "the member did nothing" drives real member-facing copy.
- Anything outside a physiological range (`canonicalDay.SANITY`) is **nulled and reported**
  server-side, never clamped. A unit bug surfaces as a warning instead of being averaged
  into a report as fact. Send correct units and this never fires.
- Unrecognised keys are surfaced in `summary.unknownColumns`, not dropped silently and not
  fatal. You can add a field before the server understands it without breaking anything.

### 2.3 Size and cadence

- Aggregates only, so a full year is well under 1 MB. Send at most **400 days** per POST;
  the server keeps the most recent 1200 across a payload.
- Sync at most a few times a day. Overlapping windows are fine and expected — the server
  upserts on `(user_id, date, source)`.
- Always re-send the **last 3 days** on every sync. Health Connect and HealthKit both
  backfill late (a watch that syncs hours after the fact, a third-party app writing
  yesterday's workout today), so a day is not final when it ends.

---

## 3. The aggregation you must do before POSTing

**Send daily aggregates, not raw samples.** A day of Apple Watch heart rate is thousands of
samples; a year is millions. The client is the only place with the battery budget, the
incremental read cursor and the OS-side de-duplication to do this well.

### 3.1 Day attribution

- **Non-sleep metrics** belong to the calendar date of the sample's **start**, in the
  member's local timezone (send that zone in `timezone`).
- **Sleep belongs to the calendar date of the WAKE time.** A night running 23:40 → 06:10
  is attributed to the morning, not to the evening. This is non-negotiable — it is rule 2
  of the contract and every other adapter obeys it.

### 3.2 Sleep sessionisation

1. Read the asleep intervals (see §6 for the exact record types).
2. Merge intervals separated by **less than 60 minutes** into one session. Both platforms
   emit one record per stage transition, so a night is dozens of adjacent intervals and a
   bathroom trip is a 10-20 minute gap.
3. **Classify each session.** A session is a **nap** when it is shorter than **180 minutes**
   *and* starts between **08:00 and 20:00** local time.
4. The **longest non-nap session** ending on a date is that date's night → `sleep.totalMinutes`.
5. **Every other session on that date — naps, and any second long sleep — goes into
   `sleep.napMinutes`.** Naps must never inflate nightly sleep. This is rule 3, and it is
   the single most common way a sleep integration produces nonsense.
6. Stage minutes must sum to no more than the night. If two sources staged the same night,
   **pick one source** (prefer the watch) rather than summing both — otherwise the stages
   exceed the night and the server drops the whole breakdown.
7. Compute durations as the **union** of intervals, not the sum. Overlapping intervals from
   two sources are one stretch of sleep, not two.

### 3.3 Cumulative metrics — the double-count trap

Steps and energy are written by **several sources for the same instant**: the phone's
motion coprocessor, the watch, and every third-party app that mirrors into the health
store. Summing naively double- or triple-counts.

- **Android:** use Health Connect's **aggregate APIs** (`aggregateGroupByDuration` /
  `AggregationResult`), not raw record reads. Health Connect de-duplicates across origins
  for you. This is the whole reason the aggregate API exists — use it.
- **iOS:** use `HKStatisticsCollectionQuery` with `.cumulativeSum`. HealthKit applies the
  user's source-priority ordering. Do **not** sum `HKQuantitySample`s yourself.

If you ever do have to merge sources by hand, prefer the watch, and drop any lower-priority
sample whose interval is fully covered by a higher-priority one.

---

## 4. Temperature: absolute vs deviation

These are different numbers in different fields and they are never interchangeable.

| What you have | Send | `basis` |
|---|---|---|
| An absolute skin/wrist temperature, ~33 °C | `skinTemperature.valueC` | `"absolute_c"` |
| A delta from the wearer's own baseline, ~-0.3 °C | `skinTemperature.deviationC` | `"deviation_c"` |

A temperature with a missing or unrecognised `basis` is **rejected**, both fields. That is
intentional: `-0.3` written into the absolute field reads as hypothermia, and `33.1`
written into the deviation field reads as a 33-degree fever.

**Prefer sending the absolute.** `services/wearables/baselineService.js` derives per-member
deviations properly, from a trailing median/MAD window, with method-tag segregation. A
client-side baseline would be worse and would be locked in permanently.

**On iOS specifically:** `HKQuantityTypeIdentifierAppleSleepingWristTemperature` is an
**absolute °C sample**. The Health app's "+0.3" display is computed against a private
per-device baseline that is not exposed through HealthKit at all. So: read the sample, send
`valueC` with `basis: "absolute_c"`, and do not attempt to reproduce Apple's deviation.

---

## 5. Provenance

- `device.originPackages` (Android) / source bundle identifiers (iOS): send the list of
  origins that actually contributed. It is how we explain to a member why their step count
  changed when they installed a new app.
- Prefer the **watch** as the credited device when several sources contributed.
- If the member has granted only some permissions, send what you have and omit the rest.
  **Never send a zero to fill a gap a permission denial created.**

---

## 6. Platform read lists

### 6.1 iOS — HealthKit types to request

Request read access to exactly these. Ask for nothing you do not send: every extra type
appears in the permission sheet and costs you grants.

**Quantity types** (`HKQuantityTypeIdentifier…`)

| Identifier | Unit to read in | Goes to |
|---|---|---|
| `HeartRateVariabilitySDNN` | `ms` | `hrv.valueMs` with **`metric: "sdnn"`** |
| `RestingHeartRate` | `count/min` | `restingHeartRateBpm` |
| `HeartRate` | `count/min` | `heartRateAvgBpm`, `heartRateMaxBpm` |
| `OxygenSaturation` | percent | `oxygenSaturationPct` — **HealthKit gives a 0-1 fraction; multiply by 100** |
| `RespiratoryRate` | `count/min` | `respiratoryRateBrpm` |
| `AppleSleepingWristTemperature` | `degC` | `skinTemperature.valueC`, `basis: "absolute_c"` |
| `ActiveEnergyBurned` | `kcal` | `activeCaloriesKcal` |
| `BasalEnergyBurned` | `kcal` | `basalCaloriesKcal` |
| `StepCount` | `count` | `steps` |
| `AppleExerciseTime` | `min` | `exerciseMinutes` |

**Category type**

| Identifier | Values you must handle |
|---|---|
| `SleepAnalysis` | iOS 16+: `asleepCore` → light, `asleepDeep` → deep, `asleepREM` → rem, `awake` → awake, `inBed` → in-bed. Pre-16 / third-party: `asleepUnspecified` (and the legacy `asleep`) → asleep with **no stage breakdown** |

**Workouts:** `HKWorkoutType`, plus `HKStatistics` for `ActiveEnergyBurned` and `HeartRate`
per workout.

**The SDNN rule, restated because it is the one that matters:** send
`hrv: { valueMs, metric: "sdnn", window: "spot" }`. **Never send `metric: "rmssd"` for an
Apple reading, and never apply any conversion.** No published SDNN→RMSSD factor is valid
per-individual.

**Sleep-window preference:** if you can tell that an SDNN reading fell inside the night's
sleep window, prefer the median of those readings over the median of the whole day. It is
still `window: "spot"` — the tag describes the *measurement*, not which readings you chose.

#### iOS privacy declarations

`Info.plist` — both keys, or the entitlement check fails:

```xml
<key>NSHealthShareUsageDescription</key>
<string>BodyBank reads your sleep, heart rate, HRV and activity from Apple Health so your
coach can see how you are recovering.</string>

<key>NSHealthUpdateUsageDescription</key>
<string>BodyBank writes workouts you log in the app back to Apple Health.</string>
```

Drop `NSHealthUpdateUsageDescription` and the `HKQuantityTypeIdentifierWrite` entitlements
entirely if the app never writes. Apple asks about unused entitlements at review.

Also required:

- **Capability:** HealthKit, in the target's Signing & Capabilities. Do **not** tick
  "Clinical Health Records" — we do not read them, and ticking it triggers extra review.
- **Purpose strings must be specific.** "This app needs health data" is a rejection.
- **App Store Connect → App Privacy:** declare **Health & Fitness** data as *Collected*,
  *Linked to the user* (it is tied to a BodyBank account), used for **App Functionality**,
  and **not** used for tracking or advertising.
- **App Review Notes:** state that health data is used only to generate the member's own
  readiness report, is never sold, never used for advertising, and never shared with third
  parties. Apple rejects HealthKit apps that do not say this.
- **HealthKit data must never be written to iCloud, and must never be sent to a third-party
  analytics SDK.** It leaves the device only on our own POST to our own API.

### 6.2 Android — Health Connect record types and permissions

`AndroidManifest.xml` permissions (read-only; request nothing you do not send):

```
android.permission.health.READ_HEART_RATE
android.permission.health.READ_RESTING_HEART_RATE
android.permission.health.READ_HEART_RATE_VARIABILITY
android.permission.health.READ_OXYGEN_SATURATION
android.permission.health.READ_RESPIRATORY_RATE
android.permission.health.READ_SKIN_TEMPERATURE
android.permission.health.READ_SLEEP
android.permission.health.READ_STEPS
android.permission.health.READ_ACTIVE_CALORIES_BURNED
android.permission.health.READ_TOTAL_CALORIES_BURNED
android.permission.health.READ_BASAL_METABOLIC_RATE
android.permission.health.READ_EXERCISE
android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND   -- only if you sync in the background
```

Plus the privacy-policy intent filter Health Connect requires, or the app is rejected:

```xml
<activity android:name=".PermissionsRationaleActivity" android:exported="true">
  <intent-filter>
    <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" />
  </intent-filter>
</activity>
<!-- Android 14+ also needs the manifest-level alias: -->
<activity-alias android:name="ViewPermissionUsageActivity"
                android:targetActivity=".PermissionsRationaleActivity"
                android:exported="true"
                android:permission="android.permission.START_VIEW_PERMISSION_USAGE">
  <intent-filter>
    <action android:name="android.intent.action.VIEW_PERMISSION_USAGE" />
    <category android:name="android.intent.category.HEALTH_PERMISSIONS" />
  </intent-filter>
</activity-alias>
```

Record types to read:

| Record | Goes to |
|---|---|
| `HeartRateVariabilityRmssdRecord` | `hrv.valueMs` with **`metric: "rmssd"`** and the window you determined |
| `RestingHeartRateRecord` | `restingHeartRateBpm` |
| `HeartRateRecord` | `heartRateAvgBpm`, `heartRateMaxBpm` (via aggregation) |
| `OxygenSaturationRecord` | `oxygenSaturationPct` |
| `RespiratoryRateRecord` | `respiratoryRateBrpm` |
| `SkinTemperatureRecord` | `skinTemperature` — read its `baseline` field: present ⇒ you have a delta, absent ⇒ absolute. Tag accordingly. |
| `SleepSessionRecord` (with `stages`) | the whole `sleep` block; stages `STAGE_TYPE_REM` / `_DEEP` / `_LIGHT` / `_AWAKE` |
| `StepsRecord` | `steps` — **via `aggregate()`**, not raw records |
| `ActiveCaloriesBurnedRecord` | `activeCaloriesKcal` — via `aggregate()` |
| `TotalCaloriesBurnedRecord` | `totalCaloriesKcal` — via `aggregate()` |
| `ExerciseSessionRecord` | `workouts[]` and `exerciseMinutes` |

**The HRV window, on Android:** `HeartRateVariabilityRmssdRecord` carries no window field.
Determine it yourself — if the record's instant falls inside a `SleepSessionRecord` for that
night, send `window: "sleep"`; otherwise `window: "spot"`. **If you cannot determine it,
omit `window` and let the server tag it `unknown`.** Do not default it to `"sleep"`.

Also declare on the **Play Console → Data safety** form: Health & fitness data collected,
linked to the user, used for App functionality, not shared with third parties, encrypted in
transit, and deletable on request.

---

## 7. Apple `export.zip` — the file-upload path

Only for first-time historical backfill.

A multi-year Apple Health export is routinely **200 MB and not rarely 1.5 GB**. It cannot
be base64-encoded into a JSON body, and it cannot be buffered into a string at either end.

```
POST /api/wearables/apple/upload
Content-Type: application/octet-stream
X-BB-Filename: export.zip
<raw bytes, streamed>
```

Client requirements:

- **Stream the file from disk.** Do not read it into memory, do not base64 it, do not put
  it in a JSON body. On iOS, use a `URLSession` **upload task with a file URL**, so the OS
  streams from disk and the transfer survives backgrounding.
- Show real progress; a 700 MB upload on Indian mobile data is a multi-minute operation.
- Expect the response to take tens of seconds after the last byte: the server parses as it
  receives, but finalisation happens at the end.
- Offer this once, at connect time, and never again automatically.

Server side (see the INTEGRATION NOTE block at the foot of `adapters/appleHealth.js`): the
route must be mounted **outside `express.json`**, must never touch `req.body`, and pipes
the request (or the inflated `apple_health_export/export.xml` entry) straight into
`appleHealth.parseStream()`.

---

## 8. What the server will never accept, and why

| You send | What happens | Why |
|---|---|---|
| Apple HRV tagged `rmssd` | The number is mis-segregated and every downstream trend is silently corrupted | SDNN ≠ RMSSD; no valid per-individual conversion exists |
| A converted HRV value | Same, and now unrecoverable | The raw value is the only thing that can be re-interpreted later |
| A recovery or readiness score | Rejected — the field is not yours to fill | Neither HealthKit nor Health Connect has one. A computed stand-in is a BodyBank number wearing a device's name |
| A strain value | Rejected | `strain` is Whoop's 0-21 scale specifically |
| `0` for a metric you could not read | Accepted, and wrong | Zero is a real reading; "unknown" must stay distinguishable. Send `null` |
| A temperature with no `basis` | Rejected, both fields | -0.3 as an absolute reads as hypothermia |
| Naps inside `sleep.totalMinutes` | Accepted, and wrong | The member sees a 7-hour night they did not have |
| Raw samples instead of daily aggregates | No `days` array ⇒ nothing parsed | The payload would be gigabytes and the aggregation belongs on-device |
| An unknown `schemaVersion` | Refused with an explanation | A v2 payload read with v1 rules would silently mean something else |

---

## 9. Checklist before you ship

- [ ] `schemaVersion: 1` sent on every request.
- [ ] Every HRV value carries `metric`, and `window` whenever you can determine it.
- [ ] iOS HRV is tagged `sdnn`. No conversion anywhere in the codebase.
- [ ] Temperature always carries an explicit `basis`.
- [ ] Sleep is attributed to the **wake** date.
- [ ] Naps are in `napMinutes` and excluded from `totalMinutes`.
- [ ] Stage minutes never exceed `totalMinutes`.
- [ ] Steps and calories come from the platform **aggregate** APIs, not summed raw samples.
- [ ] Missing values are `null` or absent — never `0`.
- [ ] Every numeric field is a JSON number, never a string.
- [ ] The last 3 days are re-sent on every sync.
- [ ] `NSHealthShareUsageDescription` is specific; App Privacy declares Health & Fitness,
      linked, App Functionality, not used for tracking.
- [ ] Health Connect privacy-policy rationale activity + Android 14 activity-alias present;
      Play Data safety form filled in.
- [ ] No health data reaches iCloud or any third-party analytics SDK.

---

## 10. Test vectors

`tests/fixtures/devices/healthconnect/payload-v1.json` is a valid v1 payload exercising the
edge cases (unstated HRV window, an implausible value, an ambiguous temperature basis, a
stringified number, an undated entry, an unknown key). Run:

```
node tests/wearables-apple.js
```

That suite asserts the exact server behaviour described here, including that Apple days
carry `hrvMethod: 'sdnn_spot'` and that an unknown `schemaVersion` is refused. If you
change the schema, that file changes with it.
