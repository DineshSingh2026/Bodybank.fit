/**
 * Generates PWA icons with safe-zone padding so the logo isn't cropped when displayed as a circle.
 * Maskable icons use only the center ~80% - this script places the logo in that safe zone.
 */
const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, '../public/img/bodybank X fitchef logo.png');
const OUT_DIR = path.join(__dirname, '../public/icons');
const SAFE_RATIO = 0.80; // Logo uses 80% of canvas - leaves 10% padding on each edge

async function generate() {
  const meta = await sharp(SRC).metadata();
  const srcW = meta.width;
  const srcH = meta.height;

  for (const size of [192, 512]) {
    const inner = Math.floor(size * SAFE_RATIO);
    const scale = Math.min(inner / srcW, inner / srcH);
    const logoW = Math.round(srcW * scale);
    const logoH = Math.round(srcH * scale);
    const left = Math.floor((size - logoW) / 2);
    const top = Math.floor((size - logoH) / 2);

    const logo = await sharp(SRC).resize(logoW, logoH).toBuffer();
    const bgImage = await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 6, g: 6, b: 6, alpha: 1 }
      }
    }).png().toBuffer();

    await sharp(bgImage)
      .composite([{ input: logo, left, top }])
      .toFile(path.join(OUT_DIR, `icon-${size}.png`));
    console.log(`Created icon-${size}.png`);
  }
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
