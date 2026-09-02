/**
 * Every script the browser loads must actually parse.
 * Run: node tests/html-scripts-parse.js    (no dependencies, no server, no DB)
 *
 * WHY THIS EXISTS
 * ---------------
 * A single syntax error in one inline <script> block takes out every function
 * declared in it. index.html carries its whole admin and member console inline,
 * so one bad string literal does not break one feature — it breaks LOGIN, and
 * every button on the page silently does nothing. The page still renders, the
 * network is fine, and nothing in the UI says why.
 *
 * That has now happened, from a literal newline landing inside a single-quoted
 * string. Nothing in the previous suites could catch it: they extract one
 * function at a time and check that, which is exactly the blind spot.
 *
 * This walks every <script> WITHOUT a src in every HTML file, plus every file
 * under public/js, and parses it the way the browser would. It is deliberately
 * dumb and total: no extraction, no slicing, no cleverness.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const failures = [];
let checks = 0;
function check(ok, msg, detail) {
  checks += 1;
  if (ok) { console.log('  OK   ' + msg); return true; }
  failures.push(msg + (detail ? '\n         ' + detail : ''));
  console.log('  FAIL ' + msg);
  if (detail) console.log('         ' + detail);
  return false;
}

/** Parse without executing. Throws on a syntax error, exactly like the browser. */
function parses(code, filename) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(code, { filename });
    return null;
  } catch (e) {
    return e && e.message ? String(e.message).split('\n')[0] : 'unknown syntax error';
  }
}

/** Line number of a byte offset, for a useful error message. */
function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

function htmlFiles() {
  return fs.readdirSync(PUBLIC)
    .filter((f) => /\.html$/i.test(f))
    .map((f) => path.join(PUBLIC, f));
}

console.log('\n=== inline <script> blocks in every public HTML page ===');
let inlineCount = 0;
htmlFiles().forEach((file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const html = fs.readFileSync(file, 'utf8');
  let m;
  SCRIPT_RE.lastIndex = 0;
  let idx = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc=/i.test(attrs)) continue; // external, checked below
    // Skip templates and JSON blobs — they are not JavaScript.
    const type = (/type\s*=\s*["']([^"']+)["']/i.exec(attrs) || [])[1];
    if (type && !/javascript|module/i.test(type)) continue;
    const code = m[2];
    if (!code.trim()) continue;
    idx += 1;
    inlineCount += 1;
    const line = lineAt(html, m.index);
    const err = parses(code, rel + ' inline#' + idx);
    check(!err, rel + ' — inline block #' + idx + ' (line ' + line + ') parses', err || '');
  }
});
check(inlineCount > 0, 'inline blocks were found and checked (' + inlineCount + ')');

console.log('\n=== every file under public/js ===');
function walk(dir) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push.apply(out, walk(p));
    else if (/\.js$/i.test(e.name)) out.push(p);
  });
  return out;
}
const jsDir = path.join(PUBLIC, 'js');
const jsFiles = fs.existsSync(jsDir) ? walk(jsDir) : [];
jsFiles.forEach((file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const err = parses(fs.readFileSync(file, 'utf8'), rel);
  check(!err, rel + ' parses', err || '');
});
check(jsFiles.length > 0, 'public/js files were found and checked (' + jsFiles.length + ')');

console.log('\n=== the service worker ===');
const sw = path.join(PUBLIC, 'sw.js');
if (fs.existsSync(sw)) {
  const err = parses(fs.readFileSync(sw, 'utf8'), 'public/sw.js');
  check(!err, 'public/sw.js parses', err || '');
}

/* ------------------------------------------------------------------ *
 * The specific shape that caused the outage: a raw newline inside a
 * single- or double-quoted JS string. It is legal in a template literal
 * and nowhere else, and it is what generated edits get wrong.
 * ------------------------------------------------------------------ */

console.log('\n=== login is reachable ===');
{
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  // Whatever the login control is called, the handler it names must be defined
  // somewhere in the page. A parse error is the usual reason it is not.
  const handlers = [];
  // Any handler an onclick names, anywhere in the attribute — the login button is
  // `onclick="event.preventDefault();adminLogin()"`, so the name is not first.
  const onclickRe = /onclick\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = onclickRe.exec(html)) !== null) {
    const calls = m[1].match(/([a-zA-Z_$][\w$]*)\s*\(/g) || [];
    calls.forEach((c) => {
      const fn = c.replace(/\s*\($/, '');
      if (/login|signin|sign_in/i.test(fn) && handlers.indexOf(fn) === -1) handlers.push(fn);
    });
  }
  if (!handlers.length) {
    console.log('  SKIP no inline login handler found (it may be bound by addEventListener)');
  } else {
    handlers.forEach((fn) => {
      const declared = new RegExp('(?:function\\s+' + fn + '\\s*\\(|(?:var|let|const)\\s+' + fn + '\\s*=|window\\.' + fn + '\\s*=)').test(html);
      check(declared, 'login handler `' + fn + '()` is defined in the page');
    });
  }
}

console.log('\n' + '-'.repeat(62));
if (failures.length) {
  console.log('FAILED ' + failures.length + ' of ' + checks + ' checks:');
  failures.forEach((f) => console.log('  x ' + f));
  process.exit(1);
}
console.log('--- All ' + checks + ' script-parse checks passed ---');
