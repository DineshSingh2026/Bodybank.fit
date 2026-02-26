const fs = require('fs');
let h = fs.readFileSync('public/index.html', 'utf8');

// Remove the corrupted fragment: ide"> + entire duplicate Unsplash slide
const fragment = 'ide"><div class="tf-img-wrap"><img src="https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=800&q=80" loading="lazy" alt="Transformation"></div><div class="tf-info"><p class="tf-name">Client Transformation</p><p class="tf-detail">16-week program · Complete lifestyle transformation</p></div></div>';

const idx = h.indexOf('ide">');
if (idx === -1) {
  console.log('ide"> not found');
  process.exit(1);
}

// Find the end: after "Client Transformation" find the next </div></div></div>
const rest = h.slice(idx);
const afterClient = rest.indexOf('Client Transformation</p>');
if (afterClient === -1) {
  console.log('Client Transformation not found');
  process.exit(1);
}
const fromClient = rest.slice(afterClient);
const tripleDiv = fromClient.indexOf('</div></div></div>');
if (tripleDiv === -1) {
  console.log('triple div not found');
  process.exit(1);
}
const removeEnd = afterClient + tripleDiv + '</div></div></div>'.length;
const toRemove = rest.slice(0, removeEnd);
h = h.slice(0, idx) + rest.slice(removeEnd);
fs.writeFileSync('public/index.html', h);
console.log('Removed', toRemove.length, 'chars');
