// QR kartochka chizish: yurakchali QR, yurak / doira / kvadrat ramka,
// qo'lda yozilgandek tilak va orqa fonda xira rasm.
const path = require('node:path');
const QRCode = require('qrcode');
const { getPositions: alignmentPositions } = require('qrcode/lib/core/alignment-pattern');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const jsQR = require('jsqr');
const ZX = require('@zxing/library');

GlobalFonts.registerFromPath(path.join(__dirname, '..', 'assets', 'fonts', 'Caveat-SemiBold.ttf'), 'Caveat');

const W = 1080;
const H = 1350;
const FONT = 'Caveat';

const C = {
  ink: '#831843', // QR nuqtalari va yozuv (to'q pushti)
  accent: '#e11d48', // yurakchalar
  soft: '#fb7185',
  blush: '#fecdd3',
  paper: '#ffffff',
};

const STYLES = {
  yurak: { name: 'Yurak', emoji: '❤️' },
  doira: { name: 'Doira', emoji: '⚪️' },
  kvadrat: { name: 'Kvadrat', emoji: '⬛️' },
};

const HEART = '\uE000'; // matndagi yurakcha emojilari uchun belgi

// QR chizish sozlamalari (skanerlanishi sinovlar bilan tekshirilgan)
const TUNE = { ecc: 'H', logo: 0.2, heartK: 1.22, dotK: 1.12 };

// ───────────────────────── Shakllar ─────────────────────────

// (x, y) markazli, kengligi w bo'lgan yurak
function heartPath(ctx, x, y, w) {
  const h = w * 0.95;
  const top = y - h / 2;
  ctx.moveTo(x, top + h * 0.2);
  ctx.bezierCurveTo(x - w * 0.06, top - h * 0.04, x - w * 0.5, top - h * 0.02, x - w * 0.5, top + h * 0.36);
  ctx.bezierCurveTo(x - w * 0.5, top + h * 0.75, x - w * 0.34, top + h * 0.88, x, top + h);
  ctx.bezierCurveTo(x + w * 0.34, top + h * 0.88, x + w * 0.5, top + h * 0.75, x + w * 0.5, top + h * 0.36);
  ctx.bezierCurveTo(x + w * 0.5, top - h * 0.02, x + w * 0.06, top - h * 0.04, x, top + h * 0.2);
  ctx.closePath();
}

function fillHeart(ctx, x, y, w, color) {
  ctx.beginPath();
  heartPath(ctx, x, y, w);
  ctx.fillStyle = color;
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Katta yurak ichiga sig'adigan eng katta kvadratni topadi (bir marta hisoblanadi)
const heartBox = (() => {
  const size = 400;
  const cvs = createCanvas(size, size);
  const ctx = cvs.getContext('2d');
  ctx.beginPath();
  heartPath(ctx, size / 2, size / 2, size * 0.98);
  const inside = (x, y) => ctx.isPointInPath(x, y);
  let best = { s: 0, y: 0 };
  for (let y0 = size * 0.1; y0 < size * 0.7; y0 += 1) {
    let lo = 0;
    let hi = size;
    while (hi - lo > 0.5) {
      const s = (lo + hi) / 2;
      const x0 = size / 2 - s / 2;
      let ok = true;
      for (let k = 0; k <= 24 && ok; k++) {
        const t = (s * k) / 24;
        ok = inside(x0 + t, y0) && inside(x0 + t, y0 + s) && inside(x0, y0 + t) && inside(x0 + s, y0 + t);
      }
      if (ok) lo = s; else hi = s;
    }
    if (lo > best.s) best = { s: lo, y: y0 };
  }
  // yurak kengligiga nisbatan: kvadrat tomoni va markazdan siljishi
  const w = size * 0.98;
  return { side: best.s / w, top: (best.y - size / 2) / w };
})();

// ───────────────────────── Yordamchilar ─────────────────────────

function seeded(seedText) {
  let h = 1779033703;
  for (const ch of String(seedText)) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

const HEART_EMOJI = /(?:❤️|❤|♥️|♥|💕|💖|💗|💓|💞|💘|💝|❣️|❣|🧡|💛|💚|💙|💜|🤍|🖤|🤎|😍|🥰|😘)/gu;

// Shriftda yo'q belgilarni almashtiradi, yurakcha emojilarini chizma yurakka aylantiradi
function cleanText(s) {
  return String(s || '')
    .replace(HEART_EMOJI, HEART)
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/[ʻ`]/g, '‘')
    .replace(/\s+/g, ' ')
    .trim();
}

function textWidth(ctx, s, size) {
  let w = 0;
  for (const part of s.split(HEART)) w += ctx.measureText(part).width;
  w += (s.split(HEART).length - 1) * size * 0.62;
  return w;
}

function wrap(ctx, text, maxWidth, size) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (textWidth(ctx, test, size) <= maxWidth || !line) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function drawRichLine(ctx, line, cx, y, size) {
  const total = textWidth(ctx, line, size);
  let x = cx - total / 2;
  const parts = line.split(HEART);
  parts.forEach((part, i) => {
    if (part) {
      ctx.fillStyle = C.ink;
      ctx.fillText(part, x, y);
      x += ctx.measureText(part).width;
    }
    if (i < parts.length - 1) {
      const hw = size * 0.62;
      fillHeart(ctx, x + hw / 2, y - size * 0.05, hw * 0.85, C.accent);
      x += hw;
    }
  });
}

// ───────────────────────── Qismlar ─────────────────────────

function drawBackground(ctx, img, rand) {
  if (img) {
    // Rasmni kichraytirib qayta kattalashtiramiz — tabiiy xiralik hosil bo'ladi
    const sw = 72;
    const sh = 90;
    const small = createCanvas(sw, sh);
    const sctx = small.getContext('2d');
    const k = Math.max(sw / img.width, sh / img.height);
    const dw = img.width * k;
    const dh = img.height * k;
    sctx.drawImage(img, (sw - dw) / 2, (sh - dh) / 2, dw, dh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, W, H);
    ctx.fillStyle = 'rgba(255, 241, 244, 0.5)';
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#fff1f2');
    g.addColorStop(0.5, '#ffe4e6');
    g.addColorStop(1, '#fbcfe8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Sochilgan mayda yurakchalar
  for (let i = 0; i < 26; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const s = 22 + rand() * 54;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rand() - 0.5) * 0.9);
    ctx.globalAlpha = 0.18 + rand() * 0.3;
    fillHeart(ctx, 0, 0, s, rand() > 0.5 ? C.accent : C.soft);
    ctx.restore();
  }
}

function withShadow(ctx, fn) {
  ctx.save();
  ctx.shadowColor = 'rgba(131, 24, 67, 0.28)';
  ctx.shadowBlur = 44;
  ctx.shadowOffsetY = 14;
  fn();
  ctx.restore();
}

// Ramka chizadi va QR joylashadigan kvadratni qaytaradi
function drawFrame(ctx, style) {
  const cx = W / 2;
  if (style === 'doira') {
    const cy = 540;
    const r = 470;
    withShadow(ctx, () => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = C.paper;
      ctx.fill();
    });
    ctx.beginPath();
    ctx.arc(cx, cy, r - 10, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = C.accent;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 34, 0, Math.PI * 2);
    ctx.setLineDash([2, 18]);
    ctx.lineCap = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = C.soft;
    ctx.stroke();
    ctx.setLineDash([]);
    for (const a of [-90, 0, 90, 180]) {
      const t = (a * Math.PI) / 180;
      fillHeart(ctx, cx + Math.cos(t) * (r - 10), cy + Math.sin(t) * (r - 10), 46, C.accent);
    }
    const side = Math.round((r - 34) * Math.SQRT2 * 0.88);
    return { x: cx - side / 2, y: cy - side / 2, size: side };
  }

  if (style === 'kvadrat') {
    const s = 880;
    const x = cx - s / 2;
    const y = 100;
    withShadow(ctx, () => {
      roundRect(ctx, x, y, s, s, 72);
      ctx.fillStyle = C.paper;
      ctx.fill();
    });
    roundRect(ctx, x + 10, y + 10, s - 20, s - 20, 64);
    ctx.lineWidth = 8;
    ctx.strokeStyle = C.accent;
    ctx.stroke();
    roundRect(ctx, x + 34, y + 34, s - 68, s - 68, 48);
    ctx.setLineDash([2, 18]);
    ctx.lineCap = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = C.soft;
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [hx, hy] of [[x + 10, y + 10], [x + s - 10, y + 10], [x + 10, y + s - 10], [x + s - 10, y + s - 10]]) {
      fillHeart(ctx, hx, hy, 58, C.accent);
    }
    const side = 680;
    return { x: cx - side / 2, y: y + (s - side) / 2, size: side };
  }

  // yurak
  const hw = 1020;
  const cy = 528;
  withShadow(ctx, () => {
    ctx.beginPath();
    heartPath(ctx, cx, cy, hw);
    ctx.fillStyle = C.paper;
    ctx.fill();
  });
  ctx.beginPath();
  heartPath(ctx, cx, cy + 4, hw - 26);
  ctx.lineWidth = 8;
  ctx.strokeStyle = C.accent;
  ctx.stroke();
  ctx.beginPath();
  heartPath(ctx, cx, cy + 10, hw - 84);
  ctx.setLineDash([2, 18]);
  ctx.lineCap = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = C.soft;
  ctx.stroke();
  ctx.setLineDash([]);
  const inner = hw - 84;
  const side = Math.round(heartBox.side * inner * 0.9);
  const top = cy + 10 + heartBox.top * inner + (heartBox.side * inner - side) / 2;
  return { x: cx - side / 2, y: top, size: side };
}

// shape: 'yurak' | 'doira' | 'kvadrat' — nuqtalar shakli; mask: QR maskasi (0–7, yoki avtomatik)
function drawQr(ctx, text, box, shape, mask) {
  const qr = QRCode.create(text, { errorCorrectionLevel: TUNE.ecc, maskPattern: mask });
  const n = qr.modules.size;
  const m = box.size / n;
  const { x: ox, y: oy } = box;

  const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  // Tekislash belgilari yaxlit chiziladi — nuqtalardan iborat bo'lsa ba'zi skanerlar ularni topolmaydi
  const aligns = alignmentPositions(qr.version);
  const inAlign = (r, c) => aligns.some(([ar, ac]) => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2);
  // O'rtadagi yurakcha logotipi uchun joy (katta QR versiyalarida tekislash belgisini yopmaslik uchun qo'yilmaydi)
  const logo = TUNE.logo && n < 45 ? Math.round(n * TUNE.logo) | 1 : 0;
  const lo = (n - logo) / 2;
  const inLogo = (r, c) => logo && r >= lo && r < lo + logo && c >= lo && c < lo + logo;

  ctx.fillStyle = C.ink;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c) || inFinder(r, c) || inAlign(r, c) || inLogo(r, c)) continue;
      const x = ox + c * m;
      const y = oy + r * m;
      ctx.beginPath();
      if (shape === 'yurak') heartPath(ctx, x + m / 2, y + m * 0.5, m * TUNE.heartK);
      else if (shape === 'doira') ctx.arc(x + m / 2, y + m / 2, (m / 2) * TUNE.dotK, 0, Math.PI * 2);
      else ctx.roundRect(x + m * 0.03, y + m * 0.03, m * 0.94, m * 0.94, m * 0.28);
      ctx.fill();
    }
  }

  for (const [ar, ac] of aligns) {
    const x = ox + (ac - 2) * m;
    const y = oy + (ar - 2) * m;
    roundRect(ctx, x, y, 5 * m, 5 * m, 1.3 * m);
    ctx.fillStyle = C.ink;
    ctx.fill();
    roundRect(ctx, x + m, y + m, 3 * m, 3 * m, 0.8 * m);
    ctx.fillStyle = C.paper;
    ctx.fill();
    roundRect(ctx, x + 2 * m, y + 2 * m, m, m, 0.3 * m);
    ctx.fillStyle = C.ink;
    ctx.fill();
  }

  // Burchakdagi "ko'zlar"
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const x = ox + c * m;
    const y = oy + r * m;
    roundRect(ctx, x, y, 7 * m, 7 * m, 2 * m);
    ctx.fillStyle = C.ink;
    ctx.fill();
    roundRect(ctx, x + m, y + m, 5 * m, 5 * m, 1.4 * m);
    ctx.fillStyle = C.paper;
    ctx.fill();
    // Ko'z ichi yurak yoki doira bo'lsa ba'zi skanerlar QR ni topa olmaydi — shuning uchun doim kvadrat
    roundRect(ctx, x + 2 * m, y + 2 * m, 3 * m, 3 * m, 0.8 * m);
    ctx.fillStyle = C.accent;
    ctx.fill();
  }

  if (logo) {
    const cx = ox + box.size / 2;
    const cy = oy + box.size / 2;
    const d = logo * m;
    ctx.beginPath();
    ctx.arc(cx, cy, d * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = C.paper;
    ctx.fill();
    fillHeart(ctx, cx, cy + d * 0.02, d * 0.72, C.accent);
  }
  return qr.maskPattern;
}

function drawWish(ctx, wish) {
  const bx = 80;
  const by = 1062;
  const bw = W - 160;
  const bh = 222;
  withShadow(ctx, () => {
    roundRect(ctx, bx, by, bw, bh, 44);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fill();
  });

  // Yurakcha oldingi so'z bilan bir qatorda qolsin
  const text = cleanText(wish).replace(/ \uE000/g, '\u00A0\uE000');
  ctx.save();
  ctx.translate(W / 2, by + bh / 2);
  ctx.rotate(-0.025);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let size = 92;
  let lines = [];
  // Qisqa tilak biroz kichikroq bo'lsa ham bitta qatorga sig'sa — shunday yozamiz
  for (let s1 = 92; s1 >= 72 && !lines.length; s1 -= 4) {
    ctx.font = `${s1}px ${FONT}`;
    if (textWidth(ctx, text, s1) <= bw - 90) { size = s1; lines = [text]; }
  }
  while (!lines.length) {
    ctx.font = `${size}px ${FONT}`;
    const l = wrap(ctx, text, bw - 90, size);
    const fits = l.every((x) => textWidth(ctx, x, size) <= bw - 90);
    if ((fits && l.length * size * 1.02 <= bh - 30 && l.length <= 3) || size <= 40) lines = l;
    else size -= 4;
  }
  if (lines.length > 3) {
    lines = lines.slice(0, 3);
    lines[2] = lines[2].replace(/\s*\S*$/, '') + '…';
  }
  const lh = size * 1.02;
  lines.forEach((l, i) => drawRichLine(ctx, l, 0, (i - (lines.length - 1) / 2) * lh, size));
  ctx.restore();
}

// ───────────────────────── O'zini tekshirish ─────────────────────────

// Kartani ikki xil skaner algoritmi bilan o'qib ko'radi (jsQR va ko'p Android ilovalaridagi ZXing)
function zxingDecode(lum, w, h) {
  try {
    const src = new ZX.RGBLuminanceSource(lum, w, h);
    return new ZX.QRCodeReader().decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(src))).getText();
  } catch {
    return null;
  }
}

function scansAt(canvas, width, link) {
  const h = Math.round((canvas.height * width) / canvas.width);
  let ctx = canvas.getContext('2d');
  if (width !== canvas.width) {
    const small = createCanvas(width, h);
    ctx = small.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, width, h);
  }
  const { data } = ctx.getImageData(0, 0, width, h);
  const lum = new Uint8ClampedArray(width * h);
  for (let i = 0, k = 0; k < lum.length; i += 4, k++) {
    lum[k] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  if (zxingDecode(lum, width, h) !== link) return false;
  const j = jsQR(data, width, h, { inversionAttempts: 'dontInvert' });
  return Boolean(j && j.data === link);
}

function scans(canvas, link) {
  return scansAt(canvas, W, link) && scansAt(canvas, W / 2, link);
}

// ───────────────────────── Asosiy funksiya ─────────────────────────

function drawCard({ link, style, wish, img, scale, shape, mask }) {
  const canvas = createCanvas(W * scale, H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  drawBackground(ctx, img, seeded(link));
  const box = drawFrame(ctx, style);
  const usedMask = drawQr(ctx, link, box, shape, mask);
  drawWish(ctx, wish || 'Siz uchun ' + HEART);
  return { canvas, mask: usedMask };
}

/**
 * QR kartochka rasmini yasaydi va skanerlanishini o'zi tekshiradi.
 * Agar karta o'qilmasa, boshqa QR maskasini, oxirida oddiy kvadrat nuqtalarni sinaydi.
 * @param {object} o
 * @param {string} o.link         QR ichidagi havola
 * @param {string} [o.style]      'yurak' | 'doira' | 'kvadrat'
 * @param {string} [o.wish]       tilak matni
 * @param {Buffer} [o.background] orqa fon rasmi (jpg/png)
 * @param {number} [o.scale]      1 = 1080×1350, 2 = chop etish uchun
 * @param {string} [o.format]     'png' | 'jpeg'
 * @returns {Promise<{ buffer: Buffer, verified: boolean, shape: string, mask: number }>}
 */
async function renderCardDetailed({ link, style = 'yurak', wish = '', background = null, scale = 1, format = 'png' }) {
  if (!STYLES[style]) style = 'yurak';
  let img = null;
  if (background) {
    try { img = await loadImage(background); } catch { img = null; }
  }
  const base = { link, style, wish, img };

  let chosen = null;
  const first = drawCard({ ...base, scale: 1, shape: style });
  if (scans(first.canvas, link)) {
    chosen = { shape: style, mask: first.mask, canvas: first.canvas, verified: true };
  } else {
    const tries = [0, 1, 2, 3, 4, 5, 6, 7].filter((m) => m !== first.mask).map((mask) => ({ shape: style, mask }));
    if (style !== 'kvadrat') tries.push({ shape: 'kvadrat', mask: undefined });
    for (const t of tries) {
      const r = drawCard({ ...base, scale: 1, ...t });
      if (scans(r.canvas, link)) {
        chosen = { shape: t.shape, mask: r.mask, canvas: r.canvas, verified: true };
        break;
      }
    }
    if (!chosen) chosen = { shape: 'kvadrat', mask: undefined, canvas: null, verified: false };
  }

  const canvas = scale === 1 && chosen.canvas
    ? chosen.canvas
    : drawCard({ ...base, scale, shape: chosen.shape, mask: chosen.mask }).canvas;
  const buffer = format === 'jpeg' ? await canvas.encode('jpeg', 92) : await canvas.encode('png');
  return { buffer, verified: chosen.verified, shape: chosen.shape, mask: chosen.mask };
}

async function renderCard(opts) {
  return (await renderCardDetailed(opts)).buffer;
}

module.exports = { renderCard, renderCardDetailed, STYLES, cleanText, TUNE, W, H };
