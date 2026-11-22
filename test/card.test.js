// QR kartalar haqiqatan skanerlanishini ikki xil skaner bilan tekshiramiz
const test = require('node:test');
const assert = require('node:assert');
const jsQR = require('jsqr');
const Z = require('@zxing/library');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { renderCard, renderCardDetailed, STYLES, cleanText } = require('../src/card');

const LINK = 'https://t.me/birqr_test_bot?start=i_k7f2m9qa';

async function decode(buf, width) {
  const img = await loadImage(buf);
  const w = width || img.width;
  const h = Math.round((img.height * w) / img.width);
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, w, h);
  const { data } = x.getImageData(0, 0, w, h);
  const j = jsQR(data, w, h);
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  let z = null;
  try {
    z = new Z.QRCodeReader().decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, w, h)))).getText();
  } catch { /* o'qilmadi */ }
  return { jsqr: j && j.data, zxing: z };
}

function photo() {
  const c = createCanvas(640, 800);
  const x = c.getContext('2d');
  for (let i = 0; i < 30; i++) {
    x.fillStyle = `hsl(${i * 37},70%,${30 + (i % 5) * 10}%)`;
    x.fillRect((i * 97) % 640, (i * 151) % 800, 120, 160);
  }
  return c.toBuffer('image/jpeg');
}

for (const style of Object.keys(STYLES)) {
  test(`${style} uslubidagi karta skanerlanadi`, async () => {
    const bg = photo();
    for (const wish of ['', "Onajonim, tug'ilgan kuningiz bilan! ❤️ Sizni juda yaxshi ko'raman", 'Сизни яхши кўраман 💕']) {
      for (const background of [null, bg]) {
        const r = await renderCardDetailed({ link: LINK, style, wish, background, format: 'jpeg' });
        assert.ok(r.verified, `karta o'zini tekshirishdan o'tishi kerak: ${style}, "${wish}"`);
        const img = r.buffer;
        for (const width of [1080, 540]) {
          const r = await decode(img, width);
          assert.strictEqual(r.jsqr, LINK, `jsQR: ${style}, ${width}px, "${wish}"`);
          assert.strictEqual(r.zxing, LINK, `ZXing: ${style}, ${width}px, "${wish}"`);
        }
      }
    }
  });
}

test('chop etish uchun katta karta ham skanerlanadi', async () => {
  const img = await renderCard({ link: LINK, style: 'yurak', wish: 'Rahmat!', scale: 2 });
  const r = await decode(img);
  assert.strictEqual(r.zxing, LINK);
});

test('matn tozalash: emojilar, yurakchalar va oʻ harfi', () => {
  assert.strictEqual(cleanText('Salom 😀 dunyo'), 'Salom dunyo');
  assert.strictEqual(cleanText('Sevaman ❤️'), 'Sevaman ');
  assert.strictEqual(cleanText('Oʻzbekiston'), 'O‘zbekiston');
});
