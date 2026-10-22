// Rasterises a PDF with pdf.js inside headless Chrome: node render-pdf.js <repo> <pdf> <outDir>
const path = require('path'); const fs = require('fs');
const REPO = path.resolve(process.argv[2]); const PDF = path.resolve(process.argv[3]); const OUT = path.resolve(process.argv[4]);
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer'));
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  const lib = 'file:///' + path.join(REPO, 'node_modules', 'pdfjs-dist', 'build').split(path.sep).join('/').split(' ').join('%20');
  const html = path.join(OUT, 'r.html');
  fs.writeFileSync(html, `<html><body style="margin:0;background:#888"><script type="module">
    import * as pdfjs from '${lib}/pdf.mjs'; pdfjs.GlobalWorkerOptions.workerSrc = '${lib}/pdf.worker.mjs';
    window.go = async (b64) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data: bytes }).promise; const out = [];
      for (let i = 1; i <= doc.numPages; i++) { const pg = await doc.getPage(i); const vp = pg.getViewport({ scale: 1.6 });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        out.push(c.toDataURL('image/jpeg', .82)); }
      const meta = await doc.getMetadata(); const fonts = new Set();
      return { pages: out, title: meta.info.Title, n: doc.numPages }; };
    window.ready = true;</script></body></html>`);
  await p.goto('file:///' + html.split(path.sep).join('/').split(' ').join('%20'));
  await p.waitForFunction('window.ready');
  const r = await p.evaluate((b64) => window.go(b64), fs.readFileSync(PDF).toString('base64'));
  r.pages.forEach((d, i) => fs.writeFileSync(path.join(OUT, 'pdf' + String(i + 1).padStart(2, '0') + '.jpg'), Buffer.from(d.split(',')[1], 'base64')));
  console.log('rendered', r.n, 'pages; title:', r.title);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
