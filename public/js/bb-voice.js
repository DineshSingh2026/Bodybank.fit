/*!
 * bb-voice.js — BodyBank free voice input for long-form fields.
 *
 * Zero cost, zero vendors, zero server calls. Transcription runs entirely on the
 * speech engine already built into the user's device or browser:
 *
 *   Web (Chrome/Edge/Safari) : window.SpeechRecognition / webkitSpeechRecognition
 *   Android app (Capacitor)  : @capacitor-community/speech-recognition -> android.speech.SpeechRecognizer
 *   iOS app (Capacitor)      : same plugin -> SFSpeechRecognizer
 *
 * No audio ever leaves this file. These engines hand back text only, so there is
 * no blob to upload, store or retain — and nothing is written into a form field
 * until the member has read it and pressed "Use this answer".
 *
 * Typing is completely untouched: the mic is purely additive, and when no engine
 * is available the button is never rendered and the form behaves as before.
 */
(function () {
'use strict';

if (window.BBVoice) return;

/* ------------------------------------------------------------------ *
 * Language                                                            *
 * ------------------------------------------------------------------ */

var LANGS = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-AU', label: 'English (Australia)' }
];
var LANG_KEY = 'bb_voice_lang';

function lang() {
  try {
    var v = localStorage.getItem(LANG_KEY);
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === v) return v;
  } catch (e) {}
  return 'en-IN';
}
function setLang(v) { try { localStorage.setItem(LANG_KEY, v); } catch (e) {} }

/* ------------------------------------------------------------------ *
 * Correction glossary                                                 *
 *                                                                     *
 * Free engines have no vocabulary boosting, so domain words come back *
 * mangled. This is the fix. Discipline: only multi-word phrases and   *
 * letter-spelled acronyms go in here — never a single common English  *
 * word, which would cause false positives. Every correction made is   *
 * surfaced to the member as a chip to verify, so nothing is silently  *
 * changed behind their back.                                          *
 * ------------------------------------------------------------------ */

var GLOSSARY = {
  /* --- training --- */
  'r d l': 'RDL', 'r d ls': 'RDLs', 'rdls': 'RDLs',
  'dead lift': 'deadlift', 'dead lifts': 'deadlifts',
  'romanian dead lift': 'Romanian deadlift',
  'over head press': 'overhead press',
  'lat pull down': 'lat pulldown', 'lat pull downs': 'lat pulldowns',
  'super set': 'superset', 'super sets': 'supersets',
  'drop set': 'drop set', 'giant set': 'giant set',
  'dumb bell': 'dumbbell', 'dumb bells': 'dumbbells',
  'dumbell': 'dumbbell', 'dumbells': 'dumbbells',
  'bar bell': 'barbell', 'bar bells': 'barbells',
  'kettle bell': 'kettlebell', 'kettle bells': 'kettlebells',
  'pull up': 'pull-up', 'pull ups': 'pull-ups',
  'push up': 'push-up', 'push ups': 'push-ups',
  'chin up': 'chin-up', 'chin ups': 'chin-ups',
  'sit up': 'sit-up', 'sit ups': 'sit-ups',
  'warm up': 'warm-up', 'cool down': 'cool-down',
  'tread mill': 'treadmill',
  'de load': 'deload',
  'p r': 'PR', 'p rs': 'PRs',
  'one r m': '1RM', '1 r m': '1RM',
  'h i i t': 'HIIT', 'hiit': 'HIIT',
  'l i s s': 'LISS', 'liss': 'LISS',
  'd o m s': 'DOMS', 'doms': 'DOMS',
  'a m r a p': 'AMRAP', 'amrap': 'AMRAP',
  'e m o m': 'EMOM', 'emom': 'EMOM',
  'r p e': 'RPE', 'rpe': 'RPE',
  'progressive over load': 'progressive overload',
  'body weight': 'bodyweight',

  /* --- supplements --- */
  'way protein': 'whey protein', 'wave protein': 'whey protein',
  'way isolate': 'whey isolate', 'way powder': 'whey powder',
  'crea teen': 'creatine', 'cree a teen': 'creatine', 'cria tin': 'creatine',
  'b c a a': 'BCAA', 'b c a as': 'BCAAs', 'bcaa': 'BCAA', 'bcaas': 'BCAAs',
  'e a a': 'EAA', 'e a as': 'EAAs', 'eaa': 'EAA',
  'multi vitamin': 'multivitamin', 'multi vitamins': 'multivitamins',
  'omega three': 'omega-3', 'omega 3': 'omega-3',
  'vitamin d three': 'vitamin D3', 'vitamin d 3': 'vitamin D3',
  'vitamin b twelve': 'vitamin B12', 'vitamin b 12': 'vitamin B12',
  'vitamin c': 'vitamin C', 'vitamin d': 'vitamin D', 'vitamin e': 'vitamin E',
  'ashwaganda': 'ashwagandha',
  'pre workout': 'pre-workout', 'post workout': 'post-workout',
  'l carnitine': 'L-carnitine', 'l glutamine': 'L-glutamine',

  /* --- Indian food --- */
  'rotty': 'roti', 'rothi': 'roti',
  'chapatti': 'chapati', 'chappati': 'chapati', 'chapathi': 'chapati',
  'dahl': 'dal', 'daal': 'dal', 'dhal': 'dal',
  'moong dahl': 'moong dal', 'toor dahl': 'toor dal', 'chana dahl': 'chana dal',
  'panner': 'paneer', 'panir': 'paneer',
  'sabji': 'sabzi', 'subzi': 'sabzi', 'subji': 'sabzi',
  'khichadi': 'khichdi', 'kichdi': 'khichdi',
  'biriyani': 'biryani', 'briyani': 'biryani',
  'butter milk': 'buttermilk',
  'idly': 'idli', 'idlys': 'idlis', 'dosai': 'dosa',
  'egg white': 'egg white', 'egg whites': 'egg whites',

  /* --- health / bloodwork --- */
  'h b a one c': 'HbA1c', 'h b a 1 c': 'HbA1c', 'hba1c': 'HbA1c', 'hb a1c': 'HbA1c',
  'l d l': 'LDL', 'h d l': 'HDL', 'v l d l': 'VLDL',
  't s h': 'TSH',
  's g p t': 'SGPT', 's g o t': 'SGOT',
  'c r p': 'CRP', 'hs c r p': 'hs-CRP',
  'b p': 'BP', 'b m i': 'BMI', 'b m r': 'BMR', 't d e e': 'TDEE',

  /* --- units --- */
  'k g': 'kg', 'kgs': 'kg', 'k gs': 'kg',
  'c m': 'cm', 'm l': 'ml', 'k cal': 'kcal', 'k c a l': 'kcal',
  'g m': 'g', 'gms': 'g'
};

/* Longest phrases first, so "moong dahl" wins over "dahl". */
var GLOSSARY_RULES = (function () {
  var keys = [];
  for (var k in GLOSSARY) if (Object.prototype.hasOwnProperty.call(GLOSSARY, k)) keys.push(k);
  keys.sort(function (a, b) { return b.length - a.length; });
  return keys.map(function (k) {
    return {
      re: new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'),
      to: GLOSSARY[k]
    };
  });
})();

/* ------------------------------------------------------------------ *
 * Spoken punctuation + number handling                                *
 * ------------------------------------------------------------------ */

var SPOKEN_PUNCT = [
  [/\b(full stop|period)\b/gi, '.'],
  [/\bcomma\b/gi, ','],
  [/\bquestion mark\b/gi, '?'],
  [/\bexclamation (mark|point)\b/gi, '!'],
  [/\b(new line|next line|newline)\b/gi, '\n'],
  [/\b(new paragraph|next paragraph)\b/gi, '\n\n'],
  [/\bcolon\b/gi, ':'],
  [/\bsemi colon\b/gi, ';']
];

var NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90
};

var UNIT_WORDS = 'kg|kgs|kilo|kilos|kilogram|kilograms|lb|lbs|pound|pounds|cm|inch|inches|' +
  'ml|litre|litres|liter|liters|gram|grams|kcal|calorie|calories|cal|cals|' +
  'hour|hours|hr|hrs|minute|minutes|min|mins|rep|reps|set|sets|km|mile|miles|' +
  'step|steps|day|days|week|weeks|month|months|year|years|time|times|percent';

var NUM_TOKENS = Object.keys(NUM_WORDS).join('|');

/*
 * Spelled numbers become digits ONLY when a unit follows, so "one of my goals"
 * is left alone while "one hundred kgs" becomes "100 kg". Conservative on
 * purpose — a wrong number is the worst failure this feature could have.
 */
var NUM_RUN_RE = new RegExp(
  '\\b((?:' + NUM_TOKENS + '|hundred)(?:[\\s-]+(?:' + NUM_TOKENS + '|hundred|and))*)\\s+(' + UNIT_WORDS + ')\\b',
  'gi'
);

function numbersBeforeUnits(text) {
  return text.replace(NUM_RUN_RE, function (whole, run, unit) {
    var value = parseSpokenNumber(run);
    return value === null ? whole : value + ' ' + unit;
  });
}

function parseSpokenNumber(run) {
  var parts = String(run).toLowerCase().split(/[\s-]+/).filter(Boolean);
  var current = 0, sawDigit = false;
  for (var i = 0; i < parts.length; i++) {
    var w = parts[i];
    if (w === 'and') continue;
    if (w === 'hundred') {
      if (!sawDigit) return null;
      current = (current || 1) * 100;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(NUM_WORDS, w)) return null;
    sawDigit = true;
    current += NUM_WORDS[w];
  }
  return sawDigit ? current : null;
}

/* ------------------------------------------------------------------ *
 * Cleanup pipeline                                                    *
 * ------------------------------------------------------------------ */

function tidy(chunks) {
  /* Each chunk is one final result from the engine — i.e. one natural pause.
     Joining them with a full stop gives us free, roughly-correct sentences.
     Spoken punctuation is resolved per chunk FIRST, so a chunk that already
     ends in a dictated "full stop" does not also get a terminator appended. */
  var joined = (chunks || [])
    .map(function (c) { return String(c == null ? '' : c).trim(); })
    .filter(Boolean)
    .map(function (c) {
      SPOKEN_PUNCT.forEach(function (pair) { c = c.replace(pair[0], pair[1]); });
      c = c.replace(/\s+$/, '');
      return /[.!?,:;]$/.test(c) ? c : c + '.';
    })
    .filter(function (c) { return c.replace(/[.!?,:;\s]/g, '').length > 0; })
    .join(' ');

  if (!joined) return { text: '', corrected: [] };

  var applied = [];

  joined = numbersBeforeUnits(joined);

  GLOSSARY_RULES.forEach(function (rule) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(joined)) return;
    rule.re.lastIndex = 0;
    joined = joined.replace(rule.re, rule.to);
    if (applied.indexOf(rule.to) === -1) applied.push(rule.to);
  });

  joined = joined
    .replace(/\s+([.,!?;:])/g, '$1')            /* no space before punctuation  */
    .replace(/([.!?])[.,;:]+/g, '$1')           /* "?." -> "?",  ".." -> "."    */
    .replace(/([,;:])[.,;:]+/g, '$1')           /* ",." -> ","                  */
    .replace(/([.,!?;:])(?=[^\s\d])/g, '$1 ')   /* space after, but not in 3.5  */
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();

  return { text: capitalise(joined), corrected: applied };
}

/* Weekdays and months only — unambiguous proper nouns that these engines
   reliably return in lower case, and that check-in answers are full of. */
/* "may" and "march" are left out on purpose — both are far more often a verb
   than a month in a check-in answer, and a wrong capital is a visible error. */
var PROPER_NOUNS = ('monday|tuesday|wednesday|thursday|friday|saturday|sunday|' +
  'january|february|april|june|july|august|september|october|november|december').split('|');

var PROPER_RE = new RegExp('\\b(' + PROPER_NOUNS.join('|') + ')\\b', 'gi');

function capitalise(text) {
  return text
    .replace(/(^|[.!?]\s+|\n)([a-z])/g, function (m, pre, ch) { return pre + ch.toUpperCase(); })
    .replace(/\bi\b/g, 'I')
    .replace(/\bi'(m|ve|ll|d)\b/gi, function (m, tail) { return "I'" + tail.toLowerCase(); })
    .replace(PROPER_RE, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
}

/*
 * Confidence, for free.
 *
 * These engines give no per-word score, but they do give ranked alternatives.
 * Where the top alternative disagrees with the runners-up, the engine was
 * genuinely unsure — which is exactly the word worth showing the member.
 * Bag-of-words rather than positional, so a shifted alignment does not flag
 * the whole sentence.
 */
function disagreements(alternatives) {
  if (!alternatives || alternatives.length < 2) return [];
  var words = function (s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^\w\s']/g, ' ').split(/\s+/).filter(Boolean);
  };
  var best = words(alternatives[0]);
  var others = alternatives.slice(1).map(function (a) {
    var set = {};
    words(a).forEach(function (w) { set[w] = true; });
    return set;
  });
  var out = [], seen = {};
  best.forEach(function (w) {
    if (w.length < 3 || seen[w]) return;
    var inAll = others.every(function (set) { return set[w] === true; });
    if (inAll) return;
    seen[w] = true;
    out.push(w);
  });
  return out.slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * Engines                                                             *
 * ------------------------------------------------------------------ */

function nativePlugin() {
  var C = window.Capacitor;
  if (!C || !C.Plugins) return null;
  var isNative = typeof C.isNativePlatform === 'function'
    ? C.isNativePlatform()
    : !!window.IS_BODYBANK_APP;
  if (!isNative) return null;
  return C.Plugins.SpeechRecognition || null;
}

function webCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function isSupported() { return !!(nativePlugin() || webCtor()); }

var ERRORS = {
  'no-speech': 'We did not hear anything. Tap record and speak clearly into the mic.',
  'not-allowed': 'Microphone access is blocked. Allow the mic for this site in your browser settings, then try again.',
  'service-not-allowed': 'Microphone access is blocked. Allow the mic for this site in your browser settings, then try again.',
  'audio-capture': 'No microphone found. Check that one is connected and not in use by another app.',
  'network': 'Voice typing needs an internet connection. Check your connection and try again.',
  'language-not-supported': 'That language is not available on this device. Try switching to English (US).'
};

/*
 * A single interface over both engines.
 *
 * Both stop by themselves on silence (Chrome also caps a session at roughly a
 * minute), which would truncate exactly the long answers this feature exists
 * for. So both paths auto-restart until the member taps Stop.
 */
function createRecogniser(handlers) {
  var plugin = nativePlugin();
  return plugin ? nativeRecogniser(plugin, handlers) : webRecogniser(handlers);
}

function webRecogniser(handlers) {
  var Ctor = webCtor();
  var rec = new Ctor();
  var live = false, manualStop = false, starting = false;
  var idleRestarts = 0;

  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 3;

  rec.onresult = function (event) {
    var interim = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var result = event.results[i];
      if (result.isFinal) {
        var alts = [];
        for (var j = 0; j < result.length && j < 3; j++) alts.push(result[j].transcript);
        idleRestarts = 0;
        handlers.onFinal(alts[0] || '', alts);
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) { idleRestarts = 0; handlers.onInterim(interim); }
  };

  rec.onerror = function (event) {
    var code = event && event.error;
    if (code === 'aborted') return;    /* we caused it          */
    if (code === 'no-speech') return;  /* onend will restart us */
    handlers.onError(ERRORS[code] || 'Voice typing hit a problem. Please try again, or type your answer.');
  };

  rec.onend = function () {
    live = false;
    if (manualStop) { handlers.onStopped(); return; }
    if (++idleRestarts > 4) {
      handlers.onError('We did not hear anything. Tap record and speak clearly into the mic.');
      manualStop = true;
      handlers.onStopped();
      return;
    }
    /* Chrome throws network errors if restarted too tightly. */
    setTimeout(function () { if (!manualStop) begin(); }, 250);
  };

  function begin() {
    if (live || starting) return;
    starting = true;
    try {
      rec.lang = lang();
      rec.start();
      live = true;
    } catch (e) {
      /* InvalidStateError means it is already running — harmless. */
      if (!e || e.name !== 'InvalidStateError') {
        handlers.onError('Could not start the microphone. Please try again, or type your answer.');
      }
    }
    starting = false;
  }

  return {
    start: function () { manualStop = false; idleRestarts = 0; begin(); },
    stop: function () {
      manualStop = true;
      try { rec.stop(); } catch (e) {}
      /* Safari occasionally never fires onend after stop(). */
      setTimeout(function () { handlers.onStopped(); }, 700);
    },
    abort: function () {
      manualStop = true;
      try { rec.abort(); } catch (e) {}
    }
  };
}

function nativeRecogniser(plugin, handlers) {
  var manualStop = false, running = false, idleRestarts = 0;
  var lastPartial = null;
  var subs = [];

  function commitPartial() {
    if (!lastPartial || !lastPartial.length) return;
    handlers.onFinal(lastPartial[0] || '', lastPartial.slice(0, 3));
    lastPartial = null;
  }

  function track(handle) {
    /* Capacitor 7 resolves a handle; older shapes return it directly. */
    if (handle && typeof handle.then === 'function') {
      handle.then(function (h) { subs.push(h); }, function () {});
    } else if (handle) {
      subs.push(handle);
    }
  }

  function attachListeners() {
    track(plugin.addListener('partialResults', function (data) {
      var matches = (data && data.matches) || [];
      if (!matches.length) return;
      idleRestarts = 0;
      lastPartial = matches;
      handlers.onInterim(matches[0] || '');
    }));
    track(plugin.addListener('listeningState', function (data) {
      if (!data || data.status !== 'stopped') return;
      running = false;
      commitPartial();
      if (manualStop) { handlers.onStopped(); return; }
      if (++idleRestarts > 4) {
        handlers.onError('We did not hear anything. Tap record and speak clearly into the mic.');
        manualStop = true;
        handlers.onStopped();
        return;
      }
      setTimeout(function () { if (!manualStop) begin(); }, 250);
    }));
  }

  function detach() {
    subs.forEach(function (s) { try { if (s && typeof s.remove === 'function') s.remove(); } catch (e) {} });
    subs = [];
  }

  function begin() {
    if (running) return;
    running = true;
    plugin.start({
      language: lang(),
      maxResults: 3,
      partialResults: true,
      popup: false
    }).catch(function (err) {
      running = false;
      if (manualStop) return;
      manualStop = true;
      handlers.onError(friendlyNativeError(err));
      handlers.onStopped();
    });
  }

  return {
    start: function () {
      manualStop = false;
      idleRestarts = 0;
      nativeAvailable(plugin).then(function (ready) {
        if (manualStop) return;
        if (!ready) {
          handlers.onError('Voice typing is not available on this phone. Its speech service may be switched off — check that Google (or your device’s speech service) is enabled, then try again.');
          handlers.onStopped();
          return;
        }
        return ensureNativePermission(plugin).then(function (ok) {
          if (manualStop) return;
          if (!ok) {
            handlers.onError('Microphone access was denied. Enable the microphone for BodyBank in your phone settings, then try again.');
            handlers.onStopped();
            return;
          }
          attachListeners();
          begin();
        });
      });
    },
    stop: function () {
      manualStop = true;
      commitPartial();
      var done = function () { detach(); handlers.onStopped(); };
      try { plugin.stop().then(done, done); } catch (e) { done(); }
    },
    abort: function () {
      manualStop = true;
      lastPartial = null;
      try { var p = plugin.stop(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      detach();
    }
  };
}

function friendlyNativeError(err) {
  var msg = String((err && (err.message || err.errorMessage)) || '').toLowerCase();
  if (msg.indexOf('permission') > -1 || msg.indexOf('denied') > -1) {
    return 'Microphone access was denied. Enable the microphone for BodyBank in your phone settings, then try again.';
  }
  if (msg.indexOf('network') > -1) {
    return 'Voice typing needs an internet connection. Check your connection and try again.';
  }
  if (msg.indexOf('busy') > -1) {
    return 'The microphone is busy. Close any other app using it and try again.';
  }
  return 'Voice typing hit a problem. Please try again, or type your answer.';
}

/*
 * Some Android devices ship with no speech recognition service at all (and on
 * API 30+ it also reads as unavailable without the <queries> RecognitionService
 * entry the plugin's manifest supplies). Treat a missing available() as ready,
 * since older plugin builds did not expose it.
 */
function nativeAvailable(plugin) {
  return new Promise(function (resolve) {
    if (typeof plugin.available !== 'function') return resolve(true);
    plugin.available().then(function (r) {
      resolve(!r || r.available !== false);
    }, function () { resolve(false); });
  });
}

function ensureNativePermission(plugin) {
  return new Promise(function (resolve) {
    var granted = function (r) {
      var v = r && (r.speechRecognition || r.permission || r.state);
      return v === 'granted' || v === true;
    };
    var ask = function () {
      if (typeof plugin.requestPermissions !== 'function') return resolve(true);
      plugin.requestPermissions().then(function (r) { resolve(granted(r)); }, function () { resolve(false); });
    };
    if (typeof plugin.checkPermissions !== 'function') return ask();
    plugin.checkPermissions().then(function (r) {
      if (granted(r)) return resolve(true);
      ask();
    }, ask);
  });
}

/* ------------------------------------------------------------------ *
 * Styles                                                              *
 * ------------------------------------------------------------------ */

var CSS = [
'.bbv-btn{display:inline-flex;align-items:center;gap:8px;margin-top:8px;padding:9px 16px;border-radius:999px;',
'border:1px solid var(--gold,#c8a44e);background:rgba(200,164,78,0.10);color:var(--gold,#c8a44e);',
'font-family:inherit;font-size:13px;font-weight:600;letter-spacing:.3px;cursor:pointer;',
'transition:background .2s,transform .12s;-webkit-tap-highlight-color:transparent}',
'.bbv-btn:hover{background:rgba(200,164,78,0.20)}',
'.bbv-btn:active{transform:scale(.97)}',
'.bbv-btn svg{width:15px;height:15px;flex:0 0 auto}',
'.bbv-wrap{position:relative;min-width:0}',

'.bbv-sheet{position:fixed;inset:0;z-index:100000;display:flex;align-items:flex-end;justify-content:center;',
'background:rgba(0,0,0,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);opacity:0;transition:opacity .18s}',
'.bbv-sheet.bbv-in{opacity:1}',
'.bbv-card{width:100%;max-width:520px;max-height:92vh;overflow-y:auto;-webkit-overflow-scrolling:touch;',
'background:#0e0e0e;border:1px solid var(--bdr,rgba(200,164,78,0.2));border-bottom:0;',
'border-radius:20px 20px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));',
'color:var(--cream,#f2ece0);font-family:inherit;transform:translateY(14px);transition:transform .2s}',
'.bbv-sheet.bbv-in .bbv-card{transform:translateY(0)}',
'@media(min-width:600px){.bbv-sheet{align-items:center}',
'.bbv-card{border-radius:20px;border-bottom:1px solid var(--bdr,rgba(200,164,78,0.2))}}',

'.bbv-q{font-size:12px;line-height:1.45;color:var(--creamd,#bfb9ab);margin-bottom:16px;',
'padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.08)}',
'.bbv-title{font-size:15px;font-weight:700;color:var(--gold,#c8a44e);margin-bottom:12px;letter-spacing:.4px}',

'.bbv-rec{text-align:center;padding:6px 0 14px}',
'.bbv-dot{display:inline-flex;align-items:center;gap:8px;font-size:22px;font-weight:700;',
'font-variant-numeric:tabular-nums;color:var(--cream,#f2ece0)}',
'.bbv-dot i{width:10px;height:10px;border-radius:50%;background:#e05050;animation:bbvpulse 1.1s ease-in-out infinite}',
'@keyframes bbvpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}',
'.bbv-bars{display:flex;align-items:flex-end;justify-content:center;gap:3px;height:34px;margin:14px 0 10px}',
'.bbv-bars span{width:3px;border-radius:2px;background:var(--gold,#c8a44e);opacity:.85;animation:bbvbar 1s ease-in-out infinite}',
'@keyframes bbvbar{0%,100%{height:6px}50%{height:30px}}',
'.bbv-bars.bbv-idle span{animation-play-state:paused;height:6px;opacity:.3}',

'.bbv-live{min-height:62px;max-height:150px;overflow-y:auto;padding:12px 14px;border-radius:12px;',
'background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);font-size:14px;line-height:1.55;',
'color:var(--cream,#f2ece0);text-align:left;white-space:pre-wrap;word-break:break-word}',
'.bbv-live em{color:var(--muted,#8a8a8a);font-style:normal}',

'.bbv-ta{width:100%;box-sizing:border-box;min-height:170px;max-height:44vh;padding:13px 15px;border-radius:12px;',
'background:rgba(255,255,255,.05);border:1px solid var(--bdr,rgba(200,164,78,0.2));color:var(--cream,#f2ece0);',
'font-family:inherit;font-size:16px;line-height:1.6;resize:vertical;outline:none}',
'.bbv-ta:focus{border-color:var(--gold,#c8a44e)}',

'.bbv-chips{margin:0 0 12px}',
'.bbv-chips-lbl{font-size:11.5px;color:var(--creamd,#bfb9ab);margin-bottom:7px;line-height:1.4}',
'.bbv-chip{display:inline-block;margin:0 6px 6px 0;padding:5px 11px;border-radius:999px;font-size:12px;',
'font-family:inherit;cursor:pointer;border:1px dashed rgba(224,180,80,.55);background:rgba(224,180,80,.10);color:#e6c87a}',
'.bbv-chip:hover{background:rgba(224,180,80,.22)}',

'.bbv-mode{display:flex;gap:8px;margin:0 0 12px}',
'.bbv-mode button{flex:1;padding:9px 6px;border-radius:10px;font-family:inherit;font-size:12px;font-weight:600;',
'cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:var(--creamd,#bfb9ab)}',
'.bbv-mode button.bbv-on{border-color:var(--gold,#c8a44e);background:rgba(200,164,78,.16);color:var(--gold,#c8a44e)}',

'.bbv-row{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}',
'.bbv-act{flex:1;min-width:130px;padding:13px 14px;border-radius:11px;font-family:inherit;font-size:14px;',
'font-weight:700;letter-spacing:.4px;cursor:pointer;border:1px solid transparent;',
'display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:transform .12s,opacity .2s}',
'.bbv-act svg{width:15px;height:15px}',
'.bbv-act:active{transform:scale(.98)}',
'.bbv-act:disabled{opacity:.5;cursor:not-allowed}',
'.bbv-primary{background:var(--goldg,linear-gradient(135deg,#d0b058,#c8a44e 50%,#a68c3e));color:#0a0a0a}',
'.bbv-ghost{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.16);color:var(--cream,#f2ece0)}',
'.bbv-link{display:block;width:100%;margin-top:10px;padding:9px;background:none;border:0;',
'color:var(--muted,#8a8a8a);font-family:inherit;font-size:13px;cursor:pointer;text-align:center}',
'.bbv-link:hover{color:var(--cream,#f2ece0)}',

'.bbv-lang{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;font-size:12px;color:var(--muted,#8a8a8a)}',
'.bbv-lang select{padding:6px 10px;border-radius:8px;background:#141414;color:var(--cream,#f2ece0);',
'border:1px solid rgba(255,255,255,.14);font-family:inherit;font-size:12px}',

'.bbv-err{margin-top:12px;padding:11px 13px;border-radius:10px;background:rgba(224,80,80,.12);',
'border:1px solid rgba(224,80,80,.34);color:#ff9b9b;font-size:12.5px;line-height:1.5}',
'.bbv-hint{margin-top:10px;font-size:11.5px;color:var(--muted,#8a8a8a);line-height:1.5;text-align:center}',
'.bbv-count{margin-top:8px;font-size:11.5px;color:var(--muted,#8a8a8a);text-align:right}',
'.bbv-count.bbv-over{color:#ff8f8f}',

'.bbv-done{text-align:center;padding:10px 0 4px}',
'.bbv-done-ic{width:46px;height:46px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;',
'justify-content:center;background:rgba(61,214,140,.16);border:1px solid rgba(61,214,140,.45)}',
'.bbv-done-ic svg{width:22px;height:22px;stroke:#3dd68c;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}',
'.bbv-done p{font-size:14px;color:var(--cream,#f2ece0);margin-bottom:4px;font-weight:600}',
'.bbv-done small{font-size:12px;color:var(--muted,#8a8a8a)}',

'@media (prefers-reduced-motion:reduce){.bbv-dot i,.bbv-bars span{animation:none}',
'.bbv-sheet,.bbv-card{transition:none}}'
].join('');

var stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  var el = document.createElement('style');
  el.id = 'bb-voice-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ------------------------------------------------------------------ *
 * Sheet                                                               *
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>' +
  '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

var registry = [];   /* every voice-enabled field, kept in document order */
var openSheet = null;

function nextFieldAfter(entry) {
  var i = registry.indexOf(entry);
  if (i === -1) return null;
  for (var j = i + 1; j < registry.length; j++) {
    var e = registry[j];
    if (e.textarea.offsetParent !== null && !e.textarea.disabled && !e.textarea.readOnly) return e;
  }
  return null;
}

function launch(entry) {
  if (openSheet) return;
  injectStyles();

  var chunks = [];            /* final transcripts, one per pause      */
  var altPool = [];           /* alternatives, for the "check" chips   */
  var recogniser = null;
  var seconds = 0, timer = null;
  var lastFocus = document.activeElement;
  var closed = false;

  var overlay = document.createElement('div');
  overlay.className = 'bbv-sheet';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Voice input');
  var card = document.createElement('div');
  card.className = 'bbv-card';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(function () { overlay.classList.add('bbv-in'); });

  openSheet = { close: close };

  function close() {
    if (closed) return;
    closed = true;
    openSheet = null;
    if (recogniser) { try { recogniser.abort(); } catch (e) {} recogniser = null; }
    stopTimer();
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('bbv-in');
    setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 190);
    if (lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus(); } catch (e) {} }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = card.querySelectorAll('button,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  function header() { return '<div class="bbv-q">' + esc(entry.label) + '</div>'; }

  /* ---------------- recording ---------------- */

  function showRecording() {
    seconds = 0;
    card.innerHTML =
      header() +
      '<div class="bbv-title">Listening…</div>' +
      '<div class="bbv-rec">' +
        '<div class="bbv-dot"><i></i><span id="bbvTime">0:00</span></div>' +
        '<div class="bbv-bars" id="bbvBars">' +
          '<span style="animation-delay:0s"></span><span style="animation-delay:.12s"></span>' +
          '<span style="animation-delay:.24s"></span><span style="animation-delay:.36s"></span>' +
          '<span style="animation-delay:.48s"></span><span style="animation-delay:.36s"></span>' +
          '<span style="animation-delay:.24s"></span><span style="animation-delay:.12s"></span>' +
        '</div>' +
        '<div class="bbv-live" id="bbvLive" aria-live="polite"><em>Start speaking — your words appear here.</em></div>' +
      '</div>' +
      '<div class="bbv-row">' +
        '<button type="button" class="bbv-act bbv-primary" id="bbvStop">Stop &amp; review</button>' +
      '</div>' +
      '<button type="button" class="bbv-link" id="bbvCancel">Cancel</button>' +
      '<div class="bbv-lang"><label for="bbvLang">Accent</label><select id="bbvLang">' +
        LANGS.map(function (l) {
          return '<option value="' + l.code + '"' + (l.code === lang() ? ' selected' : '') + '>' + esc(l.label) + '</option>';
        }).join('') +
      '</select></div>' +
      '<div class="bbv-hint">Speak in English. Say “full stop”, “comma” or “new line” to punctuate. ' +
        'Pause as long as you like — we keep listening until you tap stop.</div>' +
      '<div id="bbvErr"></div>';

    card.querySelector('#bbvStop').onclick = function () {
      if (recogniser) recogniser.stop(); else showReview();
    };
    card.querySelector('#bbvCancel').onclick = close;
    card.querySelector('#bbvLang').onchange = function () {
      setLang(this.value);
      showError('Accent updated. Tap “Stop & review”, then “Record again” to use it.');
    };
    card.querySelector('#bbvStop').focus();

    timer = setInterval(function () {
      seconds++;
      var t = card.querySelector('#bbvTime');
      if (t) t.textContent = Math.floor(seconds / 60) + ':' + ('0' + (seconds % 60)).slice(-2);
    }, 1000);

    startEngine();
  }

  function renderLive(interim) {
    var live = card.querySelector('#bbvLive');
    if (!live) return;
    var text = (chunks.join(' ') + ' ' + (interim || '')).trim();
    live.innerHTML = text ? esc(text) : '<em>Start speaking — your words appear here.</em>';
    live.scrollTop = live.scrollHeight;
    var bars = card.querySelector('#bbvBars');
    if (bars) bars.classList.toggle('bbv-idle', !interim);
  }

  function showError(msg) {
    var box = card.querySelector('#bbvErr');
    if (box) box.innerHTML = '<div class="bbv-err">' + esc(msg) + '</div>';
  }

  function startEngine() {
    try {
      recogniser = createRecogniser({
        onInterim: function (text) { if (!closed) renderLive(text); },
        onFinal: function (text, alts) {
          if (closed || !text || !String(text).trim()) return;
          chunks.push(String(text).trim());
          if (alts && alts.length > 1) altPool.push(alts);
          renderLive('');
        },
        onError: function (msg) { if (!closed) showError(msg); },
        onStopped: function () { stopTimer(); if (!closed) showReview(); }
      });
      recogniser.start();
    } catch (e) {
      showError('Voice typing could not start on this device. Please type your answer instead.');
    }
  }

  /* ---------------- review ---------------- */

  var reviewShown = false;

  function showReview() {
    if (closed || reviewShown) return;
    reviewShown = true;
    stopTimer();
    recogniser = null;

    if (!chunks.length) {
      card.innerHTML =
        header() +
        '<div class="bbv-title">Nothing recorded</div>' +
        '<div class="bbv-err">We did not catch any speech. Check your mic, then try again — or just type your answer.</div>' +
        '<div class="bbv-row">' +
          '<button type="button" class="bbv-act bbv-primary" id="bbvAgain">Try again</button>' +
          '<button type="button" class="bbv-act bbv-ghost" id="bbvClose">Close</button>' +
        '</div>';
      card.querySelector('#bbvAgain').onclick = restart;
      card.querySelector('#bbvClose').onclick = close;
      card.querySelector('#bbvAgain').focus();
      return;
    }

    var result = tidy(chunks);
    var unsure = [];
    altPool.forEach(function (alts) {
      disagreements(alts).forEach(function (w) { if (unsure.indexOf(w) === -1) unsure.push(w); });
    });
    /* Show each chip with the casing it actually has in the text, and drop any
       word that is no longer in it. The uncertain list is built from the RAW
       transcript, so a word the glossary has since replaced ("way" -> "whey")
       would otherwise show a chip that jumps nowhere. */
    var asWritten = function (w) {
      var m = result.text.match(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
      return m ? m[0] : null;
    };
    var flagged = result.corrected
      .concat(unsure.filter(function (w) { return result.corrected.indexOf(w) === -1; }))
      .map(asWritten)
      .filter(function (w, i, all) { return w && all.indexOf(w) === i; })
      .slice(0, 10);

    var existing = String(entry.textarea.value || '').trim();
    var cap = entry.textarea.maxLength > 0 ? entry.textarea.maxLength : 0;

    card.innerHTML =
      header() +
      '<div class="bbv-title">Check your answer before saving</div>' +
      (flagged.length
        ? '<div class="bbv-chips">' +
            '<div class="bbv-chips-lbl">Worth a quick check — tap a word to jump to it:</div>' +
            flagged.map(function (w) {
              return '<button type="button" class="bbv-chip" data-w="' + esc(w) + '">' + esc(w) + '</button>';
            }).join('') +
          '</div>'
        : '') +
      (existing
        ? '<div class="bbv-mode">' +
            '<button type="button" id="bbvAppend">Add to what is there</button>' +
            '<button type="button" id="bbvReplace" class="bbv-on">Replace it</button>' +
          '</div>'
        : '') +
      '<textarea class="bbv-ta" id="bbvText" spellcheck="true" aria-label="Your transcribed answer"></textarea>' +
      '<div class="bbv-count" id="bbvCount"></div>' +
      '<div class="bbv-row">' +
        '<button type="button" class="bbv-act bbv-ghost" id="bbvAgain">Record again</button>' +
        '<button type="button" class="bbv-act bbv-primary" id="bbvUse">Use this answer</button>' +
      '</div>' +
      '<button type="button" class="bbv-link" id="bbvCancel">Cancel — keep my field as it was</button>' +
      '<div class="bbv-hint">Edit anything above by typing. Nothing is saved to the form until you tap “Use this answer”.</div>';

    var ta = card.querySelector('#bbvText');
    ta.value = result.text;

    var mode = 'replace';
    var appendBtn = card.querySelector('#bbvAppend');
    var replaceBtn = card.querySelector('#bbvReplace');
    if (appendBtn && replaceBtn) {
      appendBtn.onclick = function () {
        mode = 'append'; appendBtn.classList.add('bbv-on'); replaceBtn.classList.remove('bbv-on'); updateCount();
      };
      replaceBtn.onclick = function () {
        mode = 'replace'; replaceBtn.classList.add('bbv-on'); appendBtn.classList.remove('bbv-on'); updateCount();
      };
    }

    function finalText() {
      var v = ta.value.trim();
      if (mode === 'append' && existing) v = existing + '\n\n' + v;
      return v;
    }

    function updateCount() {
      var box = card.querySelector('#bbvCount');
      var use = card.querySelector('#bbvUse');
      if (!box || !use) return;
      var len = finalText().length;
      if (!cap) { box.textContent = len + ' characters'; box.classList.remove('bbv-over'); return; }
      box.textContent = len + ' / ' + cap;
      var over = len > cap;
      box.classList.toggle('bbv-over', over);
      use.disabled = over;
    }

    ta.addEventListener('input', updateCount);
    updateCount();

    Array.prototype.forEach.call(card.querySelectorAll('.bbv-chip'), function (chip) {
      chip.onclick = function () {
        var w = chip.getAttribute('data-w') || '';
        var idx = ta.value.toLowerCase().indexOf(w.toLowerCase());
        ta.focus();
        if (idx > -1) { try { ta.setSelectionRange(idx, idx + w.length); } catch (e) {} }
      };
    });

    card.querySelector('#bbvAgain').onclick = restart;
    card.querySelector('#bbvCancel').onclick = close;
    card.querySelector('#bbvUse').onclick = function () {
      var text = finalText();
      if (cap && text.length > cap) return;
      commit(entry.textarea, text);
      showDone();
    };
    card.querySelector('#bbvUse').focus();
  }

  function restart() {
    chunks = [];
    altPool = [];
    reviewShown = false;
    showRecording();
  }

  /* ---------------- saved ---------------- */

  function showDone() {
    var next = nextFieldAfter(entry);
    card.innerHTML =
      '<div class="bbv-done">' +
        '<div class="bbv-done-ic"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>' +
        '<p>Saved to this field</p>' +
        '<small>You can still edit it by typing. Submit the form as normal when you are done.</small>' +
      '</div>' +
      '<div class="bbv-row">' +
        (next ? '<button type="button" class="bbv-act bbv-primary" id="bbvNext">' + MIC_SVG + 'Next question</button>' : '') +
        '<button type="button" class="bbv-act ' + (next ? 'bbv-ghost' : 'bbv-primary') + '" id="bbvDone">Done</button>' +
      '</div>' +
      (next ? '<div class="bbv-hint">Next: ' + esc(next.label) + '</div>' : '');

    card.querySelector('#bbvDone').onclick = close;
    var nextBtn = card.querySelector('#bbvNext');
    if (nextBtn) {
      nextBtn.onclick = function () {
        close();
        setTimeout(function () { launch(next); }, 220);
      };
      nextBtn.focus();
    } else {
      card.querySelector('#bbvDone').focus();
    }
  }

  showRecording();
}

/*
 * Write into the real field the same way a person typing would, so every
 * existing listener (char counters, autosave, validation) sees it.
 */
function commit(textarea, text) {
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

/*
 * The question shown at the top of the sheet. Markup varies across the app —
 * .form-group here, .wk-field there, a label[for] somewhere else — so this
 * tries the reliable associations first and only then falls back to the
 * placeholder. Getting this wrong is visible: the member sees the wrong
 * question above the text they are about to save.
 */
function labelFor(ta) {
  var text = '';

  /* 1. explicit association — <label for="wkNotes">Notes / feedback</label> */
  if (!text && ta.id) {
    try {
      var l = document.querySelector('label[for="' + ta.id.replace(/["\\]/g, '\\$&') + '"]');
      if (l) text = l.textContent;
    } catch (e) {}
  }

  /* 2. a <label> wrapping the field */
  if (!text && ta.closest) {
    var wrapping = ta.closest('label');
    if (wrapping) text = wrapping.textContent;
  }

  /* 3. a label immediately before it — the common <label><textarea> pattern.
        Sibling-scoped on purpose: searching a whole container can pick up the
        label belonging to a different input sitting next to this one. */
  if (!text) {
    var prev = ta.previousElementSibling, hops = 0;
    while (prev && hops++ < 3) {
      if (prev.tagName === 'LABEL') { text = prev.textContent; break; }
      prev = prev.previousElementSibling;
    }
  }

  /* 4. the surrounding form group */
  if (!text && ta.closest) {
    var group = ta.closest('.form-group, .wk-field, .fc-field, .bbody-form-field');
    var gl = group ? group.querySelector('label') : null;
    if (gl) text = gl.textContent;
  }

  if (!text) text = ta.getAttribute('aria-label') || '';
  if (!text) text = ta.getAttribute('placeholder') || '';

  text = String(text || '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
  return text || 'Your answer';
}

function attach(textarea, label) {
  if (!textarea || textarea.getAttribute('data-bbv') === '1') return null;
  if (!isSupported()) return null;
  textarea.setAttribute('data-bbv', '1');
  injectStyles();

  var entry = { textarea: textarea, label: label || labelFor(textarea) };

  var wrap = document.createElement('div');
  wrap.className = 'bbv-wrap';
  textarea.parentNode.insertBefore(wrap, textarea);
  wrap.appendChild(textarea);

  var btn = document.createElement('button');
  btn.type = 'button';                       /* never submits the form */
  btn.className = 'bbv-btn';
  btn.innerHTML = MIC_SVG + '<span>Speak your answer</span>';
  btn.setAttribute('aria-label', 'Speak your answer for: ' + entry.label);
  btn.onclick = function () { launch(entry); };
  wrap.appendChild(btn);

  /* In the app, availability is an async question. Rather than leave a button
     that can only ever show an error, drop it on devices with no speech service. */
  var plugin = nativePlugin();
  if (plugin) {
    nativeAvailable(plugin).then(function (ok) { if (!ok) btn.style.display = 'none'; });
  }

  registry.push(entry);
  registry.sort(function (a, b) {
    var pos = a.textarea.compareDocumentPosition(b.textarea);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return entry;
}

function wire(ids) {
  if (!isSupported()) return 0;
  var n = 0;
  (ids || []).forEach(function (id) {
    var el = typeof id === 'string' ? document.getElementById(id) : id;
    if (el && attach(el)) n++;
  });
  return n;
}

function wireAll(selector, root) {
  if (!isSupported()) return 0;
  var n = 0;
  Array.prototype.forEach.call((root || document).querySelectorAll(selector), function (el) {
    if (attach(el)) n++;
  });
  return n;
}

/* ------------------------------------------------------------------ *
 * Auto-wiring: "wherever there is a big box"                          *
 *                                                                     *
 * Listing ids by hand does not survive — half the long boxes in this  *
 * app are rendered by JS (meal notes per meal, coach chat, the blood  *
 * and graded report editors) and a new one would silently miss out.   *
 * So the rule lives here instead:                                     *
 *                                                                     *
 *   data-bb-voice="off"  never, whatever else is true                 *
 *   data-bb-voice="on"   always — for short boxes that are still      *
 *                        long-form, e.g. a rows=2 message to a coach  *
 *   rows >= 3            a big box                                    *
 *   a known long-form class                                           *
 *                                                                     *
 * Anything else is left alone, which keeps single-line AI prompt and  *
 * command inputs out of it.                                           *
 * ------------------------------------------------------------------ */

var LONG_FORM_CLASSES = [
  'p2-textarea',          /* Part-2 "your story" answers        */
  'wk-textarea',          /* workout details + notes/feedback   */
  'manual-textarea',      /* nutrition meal description         */
  'fc-textarea',          /* FitChef assessment free text       */
  'bbre-ta',              /* blood report editor                */
  'op-cm-textarea',       /* operator <-> admin message         */
  'bbody-form-textarea'   /* weekly body snapshot notes         */
];

function isLongForm(ta) {
  if (!ta || ta.tagName !== 'TEXTAREA') return false;
  if (ta.disabled || ta.readOnly) return false;
  /* never the review box inside our own sheet */
  if (ta.closest && ta.closest('.bbv-card')) return false;

  var flag = ta.getAttribute('data-bb-voice');
  if (flag === 'off') return false;
  if (flag === 'on') return true;

  if ((parseInt(ta.getAttribute('rows'), 10) || 0) >= 3) return true;

  for (var i = 0; i < LONG_FORM_CLASSES.length; i++) {
    if (ta.classList && ta.classList.contains(LONG_FORM_CLASSES[i])) return true;
  }
  return false;
}

function autoWire(root) {
  if (!isSupported()) return 0;
  var n = 0;
  Array.prototype.forEach.call((root || document).querySelectorAll('textarea'), function (ta) {
    if (isLongForm(ta) && attach(ta)) n++;
  });
  return n;
}

/* Catches boxes rendered after load. Our own inserted nodes carry
   data-bbv="1", so re-entering on them is filtered out and the pass
   settles instead of looping. */
function needsWiring(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.tagName === 'TEXTAREA') return node.getAttribute('data-bbv') !== '1';
  return !!(node.querySelector && node.querySelector('textarea:not([data-bbv="1"])'));
}

var observing = false;
function observe() {
  if (observing || !isSupported()) return;
  if (typeof MutationObserver !== 'function' || !document.body) return;
  observing = true;
  var queued = false;
  new MutationObserver(function (records) {
    if (queued) return;
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (!needsWiring(added[j])) continue;
        queued = true;
        setTimeout(function () { queued = false; autoWire(document); }, 120);
        return;
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/* One call per page: wire what is here now, then keep watching. */
function start(root) {
  var n = autoWire(root);
  observe();
  return n;
}

window.BBVoice = {
  isSupported: isSupported,
  attach: attach,
  wire: wire,
  wireAll: wireAll,
  autoWire: autoWire,
  observe: observe,
  start: start,
  isLongForm: isLongForm,
  languages: LANGS,
  getLanguage: lang,
  setLanguage: setLang,
  /* exposed for the test harness */
  _tidy: tidy,
  _disagreements: disagreements
};

})();
