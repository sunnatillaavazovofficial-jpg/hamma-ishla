const { Bot, InlineKeyboard, Keyboard, InputFile } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const QRCode = require('qrcode');
const store = require('./db');
const { escapeHtml, normalizeUrl, linkLabel, linkIcon, clip, itemLabel } = require('./util');

const MAX_ITEMS = Number(process.env.MAX_ITEMS) || 50;
const PAGE_SIZE = 8;

// ───────────────────────── Matnlar va tugmalar ─────────────────────────

const BTN = {
  add: "➕ Qo'shish",
  profile: '👤 Profilim',
  qr: '🔳 QR kod',
  items: '📋 Elementlarim',
  settings: '⚙️ Sozlamalar',
  help: '❓ Yordam',
};

const COMMANDS = [
  { command: 'start', description: 'Boshlash' },
  { command: 'profil', description: "Profilimni ko'rish" },
  { command: 'qr', description: 'QR kodimni olish' },
  { command: 'elementlar', description: 'Elementlarni boshqarish' },
  { command: 'sozlamalar', description: 'Ism, tavsif, profil rasmi' },
  { command: 'yordam', description: 'Yordam' },
  { command: 'bekor', description: 'Amalni bekor qilish' },
];

const DESCRIPTION =
  "BirQR — o'z profilingizni oching, unga rasm, video, audio va havolalaringizni joylang. " +
  'Bot sizga QR kod beradi: kim uni skanerlasa, hammasini bir joyda ko\'radi.';
const SHORT_DESCRIPTION = 'Rasm, video, audio va havolalaringiz — bitta QR kodda.';

const mainKeyboard = new Keyboard()
  .text(BTN.add).text(BTN.profile).row()
  .text(BTN.qr).text(BTN.items).row()
  .text(BTN.settings).text(BTN.help)
  .resized()
  .persistent();

const WELCOME =
  '👋 Salom! Men <b>BirQR</b> botman.\n\n' +
  "Bu yerda o'z profilingizni ochasiz va unga 🖼 rasm, 🎬 video, 🎵 audio, 🔗 havolalarni joylaysiz. " +
  "Men esa sizga <b>QR kod</b> beraman — kim uni skanerlasa, hammasini ko'radi.";

const ADD_HELP =
  "➕ <b>Qanday qo'shiladi?</b>\n\n" +
  'Menga shunchaki yuboring — hammasi profilingizga tushadi:\n\n' +
  '🖼 Rasm\n🎬 Video\n🎞 GIF\n🎵 Audio / musiqa\n🎙 Ovozli xabar\n⭕️ Dumaloq video\n📄 Fayl (PDF va h.k.)\n' +
  '🔗 Havola — masalan <code>instagram.com/ismingiz</code>\n' +
  '📝 Matn\n👤 Kontakt\n📍 Joylashuv\n\n' +
  "💡 Rasm yoki videoga izoh (caption) yozsangiz, u ham saqlanadi.\n" +
  "💡 Havoladan oldin nom yozsangiz, tugmada o'sha nom chiqadi: <code>Mening do'konim https://...</code>\n" +
  "💡 Bir nechta rasmni albom qilib yuborsangiz ham bo'ladi.";

const HELP =
  '❓ <b>Yordam</b>\n\n' +
  "<b>1.</b> Menga rasm, video, audio, havola yoki matn yuboring — ular profilingizga qo'shiladi.\n" +
  '<b>2.</b> «🔳 QR kod» tugmasini bosing — bot sizga QR kod beradi.\n' +
  '<b>3.</b> QR kodni chop eting yoki ulashing. Kim skanerlasa, Telegramda profilingiz ochiladi.\n\n' +
  "👤 <b>Profilim</b> — profilingiz boshqalarga qanday ko'rinishini ko'rsatadi\n" +
  "📋 <b>Elementlarim</b> — tartibini o'zgartirish va o'chirish\n" +
  '⚙️ <b>Sozlamalar</b> — ism, tavsif, profil rasmi\n\n' +
  "Biror amalni to'xtatish uchun: /bekor";

// ───────────────────────── Yordamchi funksiyalar ─────────────────────────

function deepLink(ctx, code) {
  return `https://t.me/${ctx.me.username}?start=${code}`;
}

function parseJson(s) {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function fullName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
}

function hasProfile(u) {
  return Boolean(u && u.name);
}

// Kelgan xabardan profil elementi yasaydi
function itemFromMessage(msg) {
  const base = { caption: msg.caption || '', entities: msg.caption_entities };
  if (msg.photo) return { ...base, type: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id };
  if (msg.video) return { ...base, type: 'video', file_id: msg.video.file_id };
  if (msg.animation) return { ...base, type: 'animation', file_id: msg.animation.file_id };
  if (msg.audio) return { ...base, type: 'audio', file_id: msg.audio.file_id };
  if (msg.voice) return { ...base, type: 'voice', file_id: msg.voice.file_id };
  if (msg.video_note) return { type: 'video_note', file_id: msg.video_note.file_id };
  if (msg.document) return { ...base, type: 'document', file_id: msg.document.file_id };
  if (msg.contact) {
    const { phone_number, first_name, last_name } = msg.contact;
    return { type: 'contact', extra: { phone_number, first_name, last_name } };
  }
  if (msg.location) {
    const { latitude, longitude } = msg.location;
    return { type: 'location', extra: { latitude, longitude } };
  }
  return null;
}

// Matndagi havolalar, @username, email va telefon raqamlarni ajratib oladi
function extractLinks(msg) {
  const text = msg.text || '';
  const found = [];
  for (const e of msg.entities || []) {
    const part = text.slice(e.offset, e.offset + e.length);
    let url = null;
    let label = null;
    if (e.type === 'url') url = normalizeUrl(part);
    else if (e.type === 'text_link') { url = normalizeUrl(e.url); label = part.trim(); }
    else if (e.type === 'mention') url = `https://t.me/${part.slice(1)}`;
    else if (e.type === 'email') url = `mailto:${part}`;
    else if (e.type === 'phone_number') url = `tel:${part.replace(/[^\d+]/g, '')}`;
    if (url) found.push({ url, label, raw: part });
  }
  if (found.length === 1 && !found[0].label) {
    // "Mening do'konim https://..." → tugma nomi "Mening do'konim"
    const rest = text.replace(found[0].raw, ' ').replace(/[\s:–—-]+$/g, '').replace(/^[\s:–—-]+/g, '').trim();
    if (rest) found[0].label = clip(rest, 60);
  }
  return found.map((f) => ({ url: f.url, caption: f.label || '' }));
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

async function sendItem(api, chatId, it) {
  const o = {};
  const entities = parseJson(it.entities);
  if (it.caption) {
    o.caption = it.caption;
    if (entities) o.caption_entities = entities;
  }
  const extra = parseJson(it.extra) || {};
  switch (it.type) {
    case 'photo': return api.sendPhoto(chatId, it.file_id, o);
    case 'video': return api.sendVideo(chatId, it.file_id, o);
    case 'animation': return api.sendAnimation(chatId, it.file_id, o);
    case 'audio': return api.sendAudio(chatId, it.file_id, o);
    case 'voice': return api.sendVoice(chatId, it.file_id, o);
    case 'video_note': return api.sendVideoNote(chatId, it.file_id);
    case 'document': return api.sendDocument(chatId, it.file_id, o);
    case 'text': return api.sendMessage(chatId, it.caption, entities ? { entities } : {});
    case 'contact':
      return api.sendContact(chatId, extra.phone_number, extra.first_name || 'Kontakt', {
        last_name: extra.last_name,
      });
    case 'location': return api.sendLocation(chatId, extra.latitude, extra.longitude);
    case 'link':
      return api.sendMessage(chatId, `${linkIcon(it.url)} ${it.caption || linkLabel(it.url)}\n${it.url}`);
    default: return undefined;
  }
}

// Ketma-ket kelgan rasm/videolarni albom qilib, qolganini bittadan yuboradi
function groupKey(type) {
  if (type === 'photo' || type === 'video') return 'pv';
  if (type === 'audio') return 'audio';
  if (type === 'document') return 'doc';
  return null;
}

async function sendItems(api, chatId, items) {
  let i = 0;
  while (i < items.length) {
    const key = groupKey(items[i].type);
    const group = [items[i++]];
    while (key && i < items.length && groupKey(items[i].type) === key && group.length < 10) group.push(items[i++]);
    try {
      if (group.length === 1) {
        await sendItem(api, chatId, group[0]);
      } else {
        await api.sendMediaGroup(chatId, group.map((g) => ({
          type: g.type,
          media: g.file_id,
          caption: g.caption || undefined,
          caption_entities: g.caption ? parseJson(g.entities) : undefined,
        })));
      }
    } catch (err) {
      console.error('Element yuborilmadi:', err.description || err.message);
    }
  }
}

// ───────────────────────── Bot ─────────────────────────

function createBot(token, botConfig = {}) {
  const bot = new Bot(token, botConfig);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  // Faqat shaxsiy chatlarda ishlaydi
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (!ctx.from) return;
    await next();
  });

  // ── Profil ochish bosqichlari ──

  async function askName(ctx, withWelcome = true) {
    store.ensureUser(ctx.from.id);
    store.setState(ctx.from.id, 'await_name');
    const tgName = clip(fullName(ctx.from), 60);
    const text = (withWelcome ? WELCOME + '\n\n' : '') +
      "✏️ Profilingizda qanday ism ko'rinsin? Yozing" + (tgName ? ' yoki pastdagi tugmani bosing 👇' : ':');
    const reply_markup = tgName
      ? new Keyboard().text(tgName).resized().oneTime()
      : { remove_keyboard: true };
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup });
  }

  async function askBio(ctx) {
    store.setState(ctx.from.id, 'await_bio');
    await ctx.reply(
      "📝 Endi o'zingiz haqingizda qisqacha yozing — kasbingiz, nima bilan shug'ullanasiz va h.k.\n\n" +
      'Masalan: <i>Fotograf. Toshkent. Buyurtmalar uchun yozing.</i>',
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text("⏭ O'tkazib yuborish", 'skip_bio'),
      },
    );
  }

  async function finishOnboarding(ctx) {
    store.setState(ctx.from.id, null);
    await ctx.reply(
      '🎉 <b>Profilingiz tayyor!</b>\n\n' +
      'Endi menga yuboring:\n🖼 rasm   🎬 video   🎵 audio\n🎙 ovozli xabar   🔗 havola   📝 matn\n\n' +
      "Hammasi profilingizga qo'shiladi. QR kodni olish uchun «🔳 QR kod» tugmasini bosing.",
      { parse_mode: 'HTML', reply_markup: mainKeyboard },
    );
  }

  // Profil kerak bo'lgan amallar uchun o'rovchi
  function withProfile(fn) {
    return async (ctx) => {
      const me = store.getUser(ctx.from.id);
      if (!hasProfile(me)) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        return askName(ctx);
      }
      if (me.state && !ctx.callbackQuery) store.setState(me.tg_id, null);
      return fn(ctx, me);
    };
  }

  // ── Profilni ko'rsatish ──

  async function showProfile(ctx, owner) {
    const isOwner = ctx.from.id === owner.tg_id;
    if (!isOwner) store.incViews(owner.tg_id);

    const items = store.listItems(owner.tg_id);
    const links = items.filter((i) => i.type === 'link');
    const webLinks = links.filter((l) => isWebUrl(l.url));
    const contactLinks = links.filter((l) => !isWebUrl(l.url));

    let header = `<b>${escapeHtml(owner.name)}</b>`;
    if (owner.bio) header += `\n\n${escapeHtml(owner.bio)}`;
    if (contactLinks.length) {
      header += '\n\n' + contactLinks.map((l) => {
        const icon = l.url.startsWith('tel:') ? '📞' : '✉️';
        const value = l.url.replace(/^(tel|mailto):/, '');
        return `${icon} ${l.caption ? escapeHtml(l.caption) + ': ' : ''}${escapeHtml(value)}`;
      }).join('\n');
    }

    const kb = new InlineKeyboard();
    for (const l of webLinks) kb.url(`${linkIcon(l.url)} ${clip(l.caption || linkLabel(l.url), 40)}`, l.url).row();
    const opts = { parse_mode: 'HTML', reply_markup: webLinks.length ? kb : undefined };

    if (owner.avatar && header.length <= 1000) {
      await ctx.replyWithPhoto(owner.avatar, { caption: header, ...opts });
    } else {
      if (owner.avatar) await ctx.replyWithPhoto(owner.avatar);
      await ctx.reply(header, opts);
    }

    await sendItems(ctx.api, ctx.chat.id, items.filter((i) => i.type !== 'link'));

    if (isOwner) {
      const empty = items.length === 0
        ? "\n\nHozircha profilingiz bo'sh. Menga rasm, video, audio yoki havola yuboring!"
        : '';
      await ctx.reply(
        `👆 Profilingiz boshqalarga shunday ko'rinadi.\n\n👀 Ko'rishlar: ${owner.views}\n📦 Elementlar: ${items.length}${empty}`,
        { reply_markup: new InlineKeyboard().text('🔳 QR kod', 'qr').text('📋 Boshqarish', 'list:0') },
      );
    } else {
      const viewer = store.getUser(ctx.from.id);
      if (hasProfile(viewer)) {
        await ctx.reply('✨ Bu profil <b>BirQR</b> orqali yaratilgan.', { parse_mode: 'HTML' });
      } else {
        await ctx.reply(
          "✨ Bu profil <b>BirQR</b> orqali yaratilgan.\nSiz ham o'z profilingizni ochib, QR kod oling!",
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✨ Men ham profil ochaman', 'new') },
        );
      }
    }
  }

  // ── QR kod ──

  function qrPng(link, width) {
    return QRCode.toBuffer(link, {
      width,
      margin: 3,
      errorCorrectionLevel: 'Q',
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  }

  async function sendQr(ctx, me) {
    const link = deepLink(ctx, me.code);
    const png = await qrPng(link, 1024);
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`${me.name} — mening profilim`)}`;
    await ctx.replyWithPhoto(new InputFile(png, `birqr-${me.code}.png`), {
      caption:
        `🔳 <b>${escapeHtml(me.name)}</b> — sizning QR kodingiz\n\n` +
        `Kim skanerlasa, profilingiz ochiladi:\n${link}\n\n` +
        "💡 Uni chop etib vizitka, stiker yoki afishaga qo'yishingiz mumkin.",
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('📎 Chop etish uchun fayl', 'qrfile').row()
        .url('📤 Ulashish', share),
    });
  }

  // ── Elementlar ro'yxati ──

  function listView(me, page) {
    const items = store.listItems(me.tg_id);
    if (!items.length) {
      return {
        text: "📋 Profilingiz hozircha bo'sh.\n\nMenga rasm, video, audio yoki havola yuboring — ular shu yerda paydo bo'ladi.",
        reply_markup: undefined,
      };
    }
    const pages = Math.ceil(items.length / PAGE_SIZE);
    const p = Math.min(Math.max(page, 0), pages - 1);
    const start = p * PAGE_SIZE;
    const slice = items.slice(start, start + PAGE_SIZE);

    const lines = slice.map((it, k) => `<b>${start + k + 1}.</b> ${escapeHtml(itemLabel(it))}`);
    const kb = new InlineKeyboard();
    slice.forEach((it, k) => {
      kb.text(`👁 ${start + k + 1}`, `show:${it.id}`).text('⬆️', `up:${it.id}:${p}`).text('🗑', `rm:${it.id}:${p}`).row();
    });
    if (pages > 1) {
      kb.text(p > 0 ? '◀️' : '·', p > 0 ? `list:${p - 1}` : 'noop')
        .text(`${p + 1} / ${pages}`, 'noop')
        .text(p < pages - 1 ? '▶️' : '·', p < pages - 1 ? `list:${p + 1}` : 'noop');
    }
    return {
      text:
        `📋 <b>Elementlaringiz</b> (${items.length} / ${MAX_ITEMS})\n\n${lines.join('\n')}\n\n` +
        "👁 ko'rish  ·  ⬆️ yuqoriga surish  ·  🗑 o'chirish",
      reply_markup: kb,
    };
  }

  async function sendList(ctx, me) {
    const v = listView(me, 0);
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
  }

  async function refreshList(ctx, me, page) {
    const v = listView(me, page);
    try {
      await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
    } catch (err) {
      if (!String(err.description || '').includes('not modified')) throw err;
    }
  }

  // ── Sozlamalar ──

  function settingsView(me) {
    const kb = new InlineKeyboard()
      .text('✏️ Ism', 'set:name').text('📝 Tavsif', 'set:bio').row()
      .text('🖼 Profil rasmi', 'set:avatar');
    if (me.avatar) kb.text("❌ Rasmni o'chirish", 'set:noavatar');
    kb.row().text("🗑 Profilni o'chirish", 'set:delete');
    return {
      text:
        '⚙️ <b>Sozlamalar</b>\n\n' +
        `👤 Ism: ${escapeHtml(me.name)}\n` +
        `📝 Tavsif: ${me.bio ? escapeHtml(clip(me.bio, 120)) : '—'}\n` +
        `🖼 Profil rasmi: ${me.avatar ? 'bor' : "yo'q"}\n` +
        `👀 Ko'rishlar: ${me.views}`,
      reply_markup: kb,
    };
  }

  async function sendSettings(ctx, me) {
    const v = settingsView(me);
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
  }

  const LIMIT_TEXT =
    `⚠️ Profilingizda ${MAX_ITEMS} ta element bor — bu chegara.\n` +
    "Yangisini qo'shish uchun «📋 Elementlarim» orqali keraksizlarini o'chiring.";

  const viewKb = () => new InlineKeyboard().text("👁 Profilni ko'rish", 'view').text('🔳 QR kod', 'qr');

  // Albom (bir nechta rasm birga) kelganda har biriga emas, bitta javob beramiz
  const albums = new Map();
  function albumAck(api, chatId, key, added) {
    let a = albums.get(key);
    if (!a) {
      a = { added: 0, skipped: 0, timer: null };
      albums.set(key, a);
    }
    if (added) a.added += 1; else a.skipped += 1;
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      albums.delete(key);
      let text = a.added ? `✅ ${a.added} ta fayl profilingizga qo'shildi.` : '';
      if (a.skipped) text += (text ? '\n\n' : '') + LIMIT_TEXT;
      api.sendMessage(chatId, text, { reply_markup: a.added ? viewKb() : undefined })
        .catch((err) => console.error('Albom javobi yuborilmadi:', err.description || err.message));
    }, 1500);
  }

  // ───────────── Buyruqlar ─────────────

  bot.command('start', async (ctx) => {
    const payload = String(ctx.match || '').trim();
    const me = store.ensureUser(ctx.from.id);

    // QR kod skanerlangan: t.me/bot?start=<kod>
    if (payload) {
      const owner = store.getByCode(payload);
      if (hasProfile(owner)) return showProfile(ctx, owner);
      await ctx.reply("😕 Bu profil topilmadi — u o'chirilgan bo'lishi mumkin.");
    }

    if (!hasProfile(me)) return askName(ctx);
    if (me.state) store.setState(me.tg_id, null);
    return ctx.reply(
      `👋 Xush kelibsiz, <b>${escapeHtml(me.name)}</b>!\n\nQuyidagi menyudan foydalaning 👇`,
      { parse_mode: 'HTML', reply_markup: mainKeyboard },
    );
  });

  bot.command('bekor', async (ctx) => {
    const me = store.ensureUser(ctx.from.id);
    if (!hasProfile(me)) return askName(ctx, false);
    store.setState(me.tg_id, null);
    await ctx.reply('↩️ Bekor qilindi.', { reply_markup: mainKeyboard });
  });

  bot.command('yordam', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
  bot.command('profil', withProfile((ctx, me) => showProfile(ctx, me)));
  bot.command('qr', withProfile((ctx, me) => sendQr(ctx, me)));
  bot.command('elementlar', withProfile((ctx, me) => sendList(ctx, me)));
  bot.command('sozlamalar', withProfile((ctx, me) => sendSettings(ctx, me)));

  // ───────────── Menyu tugmalari ─────────────

  bot.hears(BTN.add, withProfile((ctx) => ctx.reply(ADD_HELP, { parse_mode: 'HTML' })));
  bot.hears(BTN.profile, withProfile((ctx, me) => showProfile(ctx, me)));
  bot.hears(BTN.qr, withProfile((ctx, me) => sendQr(ctx, me)));
  bot.hears(BTN.items, withProfile((ctx, me) => sendList(ctx, me)));
  bot.hears(BTN.settings, withProfile((ctx, me) => sendSettings(ctx, me)));
  bot.hears(BTN.help, (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  // ───────────── Fayllar (rasm, video, audio ...) ─────────────

  bot.on([
    'message:photo', 'message:video', 'message:animation', 'message:audio', 'message:voice',
    'message:video_note', 'message:document', 'message:contact', 'message:location',
  ], async (ctx) => {
    const msg = ctx.message;
    const me = store.getUser(ctx.from.id);
    if (!hasProfile(me)) {
      await ctx.reply('Avval profil ochib olaylik 🙂');
      return askName(ctx, false);
    }

    if (me.state === 'await_avatar') {
      if (!msg.photo) return ctx.reply('🖼 Profil rasmi uchun rasm yuboring (yoki /bekor).');
      store.setAvatar(me.tg_id, msg.photo[msg.photo.length - 1].file_id);
      store.setState(me.tg_id, null);
      return ctx.reply("✅ Profil rasmi o'rnatildi!", { reply_markup: viewKb() });
    }
    if (me.state) store.setState(me.tg_id, null);

    const item = itemFromMessage(msg);
    if (!item) return undefined;

    const full = store.countItems(me.tg_id) >= MAX_ITEMS;
    if (!full) item.id = store.addItem(me.tg_id, item);

    if (msg.media_group_id) {
      return albumAck(ctx.api, ctx.chat.id, `${me.tg_id}:${msg.media_group_id}`, !full);
    }
    if (full) return ctx.reply(LIMIT_TEXT);

    return ctx.reply(`✅ Profilingizga qo'shildi: ${itemLabel(item)}`, {
      reply_markup: new InlineKeyboard()
        .text("🗑 O'chirish", `del:${item.id}`)
        .text("👁 Profilni ko'rish", 'view'),
    });
  });

  // ───────────── Matnli xabarlar ─────────────

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const me = store.ensureUser(ctx.from.id);

    if (text.startsWith('/')) {
      return ctx.reply("🤔 Bunday buyruq yo'q. Yordam uchun /yordam");
    }

    switch (me.state) {
      case 'await_name':
      case 'edit_name': {
        const name = clip(text, 64);
        if (name.length < 2) return ctx.reply("Ism kamida 2 ta harfdan iborat bo'lsin. Qaytadan yozing:");
        store.setName(me.tg_id, name);
        if (me.state === 'await_name') return askBio(ctx);
        store.setState(me.tg_id, null);
        return ctx.reply('✅ Ism yangilandi!', { reply_markup: mainKeyboard });
      }
      case 'await_bio':
      case 'edit_bio': {
        store.setBio(me.tg_id, text.slice(0, 500));
        if (me.state === 'await_bio') return finishOnboarding(ctx);
        store.setState(me.tg_id, null);
        return ctx.reply('✅ Tavsif yangilandi!', { reply_markup: mainKeyboard });
      }
      case 'await_avatar':
        return ctx.reply('🖼 Profil rasmi uchun rasm yuboring (yoki /bekor).');
      default:
        break;
    }

    if (!hasProfile(me)) return askName(ctx);

    // Havolalar
    const links = extractLinks(ctx.message);
    if (links.length) {
      const room = MAX_ITEMS - store.countItems(me.tg_id);
      if (room <= 0) return ctx.reply(LIMIT_TEXT);
      const toAdd = links.slice(0, room);
      const ids = toAdd.map((l) => store.addItem(me.tg_id, { type: 'link', url: l.url, caption: l.caption }));
      const list = toAdd.map((l) => `${linkIcon(l.url)} ${escapeHtml(l.caption || linkLabel(l.url))}`).join('\n');
      const head = toAdd.length === 1 ? "✅ Havola qo'shildi:" : `✅ ${toAdd.length} ta havola qo'shildi:`;
      const kb = new InlineKeyboard();
      if (ids.length === 1) kb.text("🗑 O'chirish", `del:${ids[0]}`);
      kb.text("👁 Profilni ko'rish", 'view');
      const skipped = links.length - toAdd.length;
      return ctx.reply(`${head}\n${list}${skipped ? `\n\n${LIMIT_TEXT}` : ''}`, { parse_mode: 'HTML', reply_markup: kb });
    }

    // Oddiy matn — qo'shishdan oldin so'raymiz
    store.setState(me.tg_id, null, { text: ctx.message.text, entities: ctx.message.entities });
    return ctx.reply("📝 Bu matnni profilingizga qo'shaymi?", {
      reply_markup: new InlineKeyboard().text("✅ Ha, qo'shish", 'addtext').text("❌ Yo'q", 'notext'),
    });
  });

  // ───────────── Inline tugmalar ─────────────

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery('new', async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = store.ensureUser(ctx.from.id);
    if (hasProfile(me)) return ctx.reply('Sizda allaqachon profil bor 🙂', { reply_markup: mainKeyboard });
    return askName(ctx);
  });

  bot.callbackQuery('skip_bio', async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = store.getUser(ctx.from.id);
    if (me && me.state === 'await_bio') {
      await ctx.editMessageReplyMarkup().catch(() => {});
      return finishOnboarding(ctx);
    }
    return undefined;
  });

  bot.callbackQuery('addtext', withProfile(async (ctx, me) => {
    const p = parseJson(me.pending);
    if (!p) {
      await ctx.answerCallbackQuery({ text: 'Matn topilmadi, qaytadan yuboring' });
      return ctx.editMessageReplyMarkup().catch(() => {});
    }
    if (store.countItems(me.tg_id) >= MAX_ITEMS) {
      await ctx.answerCallbackQuery();
      return ctx.editMessageText(LIMIT_TEXT);
    }
    const id = store.addItem(me.tg_id, { type: 'text', caption: p.text, entities: p.entities });
    store.setState(me.tg_id, null);
    await ctx.answerCallbackQuery({ text: "Qo'shildi ✅" });
    return ctx.editMessageText(`✅ Matn profilingizga qo'shildi: ${clip(p.text, 40)}`, {
      reply_markup: new InlineKeyboard().text("🗑 O'chirish", `del:${id}`).text("👁 Profilni ko'rish", 'view'),
    });
  }));

  bot.callbackQuery('notext', async (ctx) => {
    store.setState(ctx.from.id, null);
    await ctx.answerCallbackQuery();
    return ctx.editMessageText("👌 Qo'shilmadi.");
  });

  bot.callbackQuery(/^del:(\d+)$/, withProfile(async (ctx, me) => {
    const ok = store.deleteItem(me.tg_id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: ok ? "O'chirildi 🗑" : 'Allaqachon o\'chirilgan' });
    return ctx.editMessageText("🗑 Profilingizdan o'chirildi.").catch(() => {});
  }));

  bot.callbackQuery('view', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    return showProfile(ctx, me);
  }));

  bot.callbackQuery('qr', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    return sendQr(ctx, me);
  }));

  bot.callbackQuery('qrfile', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery({ text: 'Tayyorlanmoqda…' });
    const png = await qrPng(deepLink(ctx, me.code), 2048);
    return ctx.replyWithDocument(new InputFile(png, `birqr-${me.code}.png`), {
      caption: '📎 Yuqori sifatli QR kod (2048×2048) — chop etish uchun.',
    });
  }));

  bot.callbackQuery(/^list:(\d+)$/, withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    return refreshList(ctx, me, Number(ctx.match[1]));
  }));

  bot.callbackQuery(/^show:(\d+)$/, withProfile(async (ctx, me) => {
    const it = store.getItem(me.tg_id, Number(ctx.match[1]));
    if (!it) return ctx.answerCallbackQuery({ text: 'Topilmadi' });
    await ctx.answerCallbackQuery();
    return sendItem(ctx.api, ctx.chat.id, it);
  }));

  bot.callbackQuery(/^up:(\d+):(\d+)$/, withProfile(async (ctx, me) => {
    const id = Number(ctx.match[1]);
    let page = Number(ctx.match[2]);
    const items = store.listItems(me.tg_id);
    const idx = items.findIndex((x) => x.id === id);
    const moved = store.moveItem(me.tg_id, id, -1);
    await ctx.answerCallbackQuery({ text: moved ? '⬆️ Surildi' : 'Bu allaqachon eng yuqorida' });
    if (moved && idx % PAGE_SIZE === 0) page -= 1; // sahifaning birinchisi oldingi sahifaga o'tdi
    return refreshList(ctx, me, page);
  }));

  bot.callbackQuery(/^rm:(\d+):(\d+)$/, withProfile(async (ctx, me) => {
    const ok = store.deleteItem(me.tg_id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: ok ? "O'chirildi 🗑" : 'Topilmadi' });
    return refreshList(ctx, me, Number(ctx.match[2]));
  }));

  // Sozlamalar tugmalari
  bot.callbackQuery('set:name', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    store.setState(me.tg_id, 'edit_name');
    return ctx.reply('✏️ Yangi ismni yozing (yoki /bekor):');
  }));

  bot.callbackQuery('set:bio', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    store.setState(me.tg_id, 'edit_bio');
    return ctx.reply('📝 Yangi tavsifni yozing, 500 belgigacha (yoki /bekor):', {
      reply_markup: me.bio ? new InlineKeyboard().text("🧹 Tavsifni o'chirish", 'set:clearbio') : undefined,
    });
  }));

  bot.callbackQuery('set:clearbio', withProfile(async (ctx, me) => {
    store.setBio(me.tg_id, '');
    store.setState(me.tg_id, null);
    await ctx.answerCallbackQuery({ text: "Tavsif o'chirildi" });
    return ctx.editMessageText("🧹 Tavsif o'chirildi.");
  }));

  bot.callbackQuery('set:avatar', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    store.setState(me.tg_id, 'await_avatar');
    return ctx.reply('🖼 Profil rasmi uchun rasm yuboring (yoki /bekor):');
  }));

  bot.callbackQuery('set:noavatar', withProfile(async (ctx, me) => {
    store.setAvatar(me.tg_id, null);
    await ctx.answerCallbackQuery({ text: "Profil rasmi o'chirildi" });
    const v = settingsView(store.getUser(me.tg_id));
    return ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
  }));

  bot.callbackQuery('set:delete', withProfile(async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      "⚠️ <b>Profilingiz va undagi hamma narsa o'chadi.</b>\nQR kodingiz ham ishlamay qoladi.\n\nRostdan o'chirasizmi?",
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text("✅ Ha, o'chirish", 'set:delete_yes').text("↩️ Yo'q", 'set:back'),
      },
    );
  }));

  bot.callbackQuery('set:delete_yes', withProfile(async (ctx, me) => {
    store.deleteUser(me.tg_id);
    await ctx.answerCallbackQuery({ text: "Profil o'chirildi" });
    await ctx.editMessageText("🗑 Profilingiz o'chirildi.");
    return ctx.reply('Qaytadan ochish uchun /start bosing.', { reply_markup: { remove_keyboard: true } });
  }));

  bot.callbackQuery('set:back', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    const v = settingsView(me);
    return ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
  }));

  // Eski yoki noma'lum tugmalar
  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery({ text: 'Bu tugma eskirgan' }));

  bot.catch((err) => {
    const e = err.error;
    console.error(`Xatolik (update ${err.ctx?.update?.update_id}):`, e?.description || e?.message || e);
  });

  return bot;
}

module.exports = { createBot, COMMANDS, DESCRIPTION, SHORT_DESCRIPTION, BTN, MAX_ITEMS };
