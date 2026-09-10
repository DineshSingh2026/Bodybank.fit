/**
 * Boot test for the AI Trainer page.
 * Run: node tests/ai-trainer-boot.js      (no dependencies, no server, no DB)
 *
 * `tests/html-scripts-parse.js` only COMPILES each inline <script>. That cannot
 * catch a temporal-dead-zone error — using a `const` before its declaration
 * parses perfectly and throws only when the line runs. One such line shipped and
 * killed the entire trainer: the whole inline script aborted at load, so every
 * exercise stopped working, not just the one that was touched.
 *
 * This test EXECUTES the page's module-level code against a minimal DOM stub.
 * Anything that throws while the script initialises fails the test.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'public', 'ai-trainer.html');
const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

// ── A DOM stub broad enough for module-level initialisation ──
function makeElement(id) {
  const el = {
    id,
    _v: '',
    tagName: 'DIV',
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    checked: false,
    readyState: 4,
    options: [],
    selectedIndex: 0,
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    appendChild(c) { return c; },
    removeChild(c) { return c; },
    insertBefore(c) { return c; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    querySelector() { return makeElement('q'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { width: 640, height: 480, top: 0, left: 0, right: 640, bottom: 480 }; },
    getContext() { return makeCtx(); },
    play() { return Promise.resolve(); },
    requestFullscreen() { return Promise.resolve(); },
    scrollIntoView() {},
    cloneNode() { return makeElement(id); },
    children: [],
    firstChild: null,
    lastChild: null,
    parentNode: null,
    width: 640,
    height: 480,
    clientWidth: 640,
    clientHeight: 480,
  };
  return el;
}

function makeCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get(_, p) {
      if (p === 'measureText') return () => ({ width: 40 });
      if (p === 'canvas') return { width: 640, height: 480 };
      if (p === 'createLinearGradient') return () => ({ addColorStop: noop });
      return noop;
    },
    set() { return true; },
  });
}

function run() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const blocks = [];
  let m;
  while ((m = re.exec(html))) {
    blocks.push({ code: m[1], line: html.slice(0, m.index).split('\n').length });
  }
  assert(blocks.length > 0, 'ai-trainer.html has no inline <script> to boot');

  const store = {
    // a logged-in member, so the page does not bail out to the login redirect
    bodybank_session: JSON.stringify({ id: 'u1', role: 'user', token: 't', first_name: 'Test' }),
  };
  const storage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };

  const redirects = [];
  const doc = {
    getElementById: makeElement,
    querySelector: () => makeElement('q'),
    querySelectorAll: () => [],
    createElement: makeElement,
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    hidden: false,
    visibilityState: 'visible',
    cookie: '',
    fullscreenElement: null,
    exitFullscreen() { return Promise.resolve(); },
  };

  const win = {
    document: doc,
    localStorage: storage,
    sessionStorage: storage,
    location: {
      href: 'https://bodybank.fit/ai-trainer.html',
      pathname: '/ai-trainer.html',
      search: '',
      hash: '',
      replace: u => redirects.push(u),
      assign: u => redirects.push(u),
    },
    navigator: { userAgent: 'node', mediaDevices: { getUserMedia: () => Promise.resolve({}) }, language: 'en' },
    performance: { now: () => Date.now() },
    speechSynthesis: {
      getVoices: () => [], speak() {}, cancel() {}, resume() {}, pause() {},
      addEventListener() {}, removeEventListener() {},
    },
    SpeechSynthesisUtterance: function () { return {}; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    alert() {},
    currentUser: { id: 'u1', role: 'user', token: 't' },
    // MediaPipe globals come from CDN <script src>; only used after Start
    Pose: function () { return { setOptions() {}, onResults() {}, send() { return Promise.resolve(); } }; },
    Camera: function () { return { start() {}, stop() {} }; },
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.globalThis = win;

  blocks.forEach((b, i) => {
    const label = `inline block #${i + 1} (line ${b.line})`;
    try {
      const fn = new Function(
        'window', 'document', 'localStorage', 'sessionStorage', 'navigator',
        'performance', 'location', 'speechSynthesis', 'SpeechSynthesisUtterance',
        'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame',
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'fetch', 'alert', 'Pose', 'Camera', 'self', 'globalThis',
        b.code
      );
      fn(
        win, doc, storage, storage, win.navigator,
        win.performance, win.location, win.speechSynthesis, win.SpeechSynthesisUtterance,
        win.matchMedia, win.requestAnimationFrame, win.cancelAnimationFrame,
        win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval,
        win.fetch, win.alert, win.Pose, win.Camera, win, win
      );
      assert(true, label);
      console.log(`  OK   ${label} boots without throwing`);
    } catch (e) {
      assert(false, `${label} threw at load: ${e.name}: ${e.message}`);
      console.log(`  FAIL ${label} threw at load`);
      console.log(`       ${e.name}: ${e.message}`);
    }
  });

  // A dead-zone error would have redirected nowhere and simply died; a healthy
  // page with a valid session must not bounce the member to login either.
  assert(
    redirects.length === 0,
    `page redirected away during boot: ${redirects.join(', ')}`
  );

  report();
}

function report() {
  if (failures.length) {
    console.error(`\nai-trainer-boot: ${failures.length} of ${checks} checks FAILED\n`);
    failures.forEach(f => console.error('  x ' + f));
    console.error('');
    process.exit(1);
  }
  console.log(`\nai-trainer-boot: ${checks} checks passed — the trainer initialises cleanly`);
}

run();
