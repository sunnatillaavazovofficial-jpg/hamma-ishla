const { Bot, InlineKeyboard, Keyboard, InputFile, InputMediaBuilder } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const store = require('./db');
const { renderCardDetailed, STYLES } = require('./card');
const { escapeHtml, normalizeUrl, linkLabel, linkIcon, clip, itemLabel, TYPE_INFO } = require('./util');

const MAX_ITEMS = Number(process.env.MAX_ITEMS) || 50;
const PAGE_SIZE = 8;
const WISH_MAX = 120;

// ───────────────────────── Matnlar va tugmalar ─────────────────────────

const BTN = {
  add: "➕ Qo'shish",
  profile: '👤 Profilim',
  qr: '🔳 QR karta',
  items: '📋 Elementlarim',
  settings: '⚙️ Sozlamalar',
  help: '❓ Yordam',
};

const COMMANDS = [
  { command: 'start', description: 'Boshlash' },
  { command: 'qr', description: 'QR kartamni olish' },
  { command: 'profil', description: "Profilimni ko'rish" },
  { command: 'elementlar', description: 'Elementlarni boshqarish' },
  { command: 'sozlamalar', description: 'Ism, tavsif, shaxsiy guruh' },
  { command: 'yordam', description: 'Yordam' },
  { command: 'bekor', description: 'Amalni bekor qilish' },
];

const DESCRIPTION =
  "BirQR — o'z profilingizni oching, unga rasm, video, ovozli xabar va havolalaringizni joylang. " +
  "Bot ularni shaxsiy guruhingizga saqlab boradi va yurakchali QR karta beradi: kim skanerlasa, hammasini ko'radi.";
const SHORT_DESCRIPTION = 'Rasm, video, ovoz va havolalaringiz — yurakchali QR kartada.';

const mainKeyboard = new Keyboard()
  .text(BTN.add).text(BTN.qr).row()
  .text(BTN.profile).text(BTN.items).row()
  .text(BTN.settings).text(BTN.help)
  .resized()
  .persistent();

const WELCOME =
  '👋 Salom! Men <b>BirQR</b> botman.\n\n' +
  "Bu yerda o'z profilingizni ochasiz va unga 🖼 rasm, 🎬 video, 🎙 ovozli xabar, 🔗 havolalarni joylaysiz. " +
  "Men esa sizga <b>yurakchali QR karta</b> beraman — kim uni skanerlasa, hammasini ko'radi.";

const ADD_HELP =
  "➕ <b>Qanday qo'shiladi?</b>\n\n" +
  'Menga shunchaki yuboring — hammasi profilingizga tushadi:\n\n' +
  '🖼 Rasm   🎬 Video   🎞 GIF\n🎵 Audio   📄 Fayl   📝 Matn\n👤 Kontakt   📍 Joylashuv\n' +
  '🔗 Havola — masalan <code>instagram.com/ismingiz</code>\n\n' +
  "🎙 <b>Ovozli xabar</b> yoki ⭕️ <b>dumaloq video</b> yuborsangiz, men darhol uning <b>alohida QR kartasini</b> beraman — " +
  "sovg'aga yopishtirsangiz bo'ladi, skanerlagan odam ovozingizni eshitadi.\n\n" +
  "💡 Rasm yoki videoga izoh (caption) yozsangiz, u ham saqlanadi.\n" +
  "💡 Havoladan oldin nom yozsangiz, tugmada o'sha nom chiqadi: <code>Mening do'konim https://...</code>";

const HELP =
  '❓ <b>Yordam</b>\n\n' +
  "<b>1.</b> Menga rasm, video, ovozli xabar, havola yoki matn yuboring — ular profilingizga qo'shiladi " +
  'va shaxsiy guruhingizga saqlanadi.\n' +
  '<b>2.</b> «🔳 QR karta» tugmasini bosing — yurakchali QR karta olasiz.\n' +
  "<b>3.</b> Kartada uslubni (❤️ yurak, ⚪️ doira, ⬛️ kvadrat) tanlang, ✍️ tilak yozing va 🖼 fon uchun rasm yoki video yuboring.\n" +
  "<b>4.</b> Kartani chop eting yoki ulashing. Kim skanerlasa, Telegramda profilingiz ochiladi.\n\n" +
  "🎙 Ovozli xabar va ⭕️ dumaloq video uchun bot darhol alohida QR karta beradi.\n\n" +
  "👤 <b>Profilim</b> — profilingiz boshqalarga qanday ko'rinishi\n" +
  "📋 <b>Elementlarim</b> — har biri uchun QR, tartiblash, o'chirish\n" +
  '⚙️ <b>Sozlamalar</b> — ism, tavsif, profil rasmi, shaxsiy guruh\n\n' +
  "Biror amalni to'xtatish uchun: /bekor";

// Element turi — "sizga ... qoldirdi" jumlasi uchun
const GIFT_NAME = {
  voice: 'ovozli xabar', video_note: 'video xabar', photo: 'rasm', video: 'video', animation: 'GIF',
  audio: 'audio', document: 'fayl', text: 'xat', link: 'havola', contact: 'kontakt', location: 'manzil',
};

// ───────────────────────── Yordamchi funksiyalar ─────────────────────────

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

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

// Fon uchun o'rtacha o'lchamdagi rasmni tanlaymiz (yuklab olish tez bo'lsin)
function pickPhoto(sizes) {
  return (sizes.find((p) => p.width >= 600) || sizes[sizes.length - 1]).file_id;
}

// Kelgan xabardan profil elementi yasaydi
function itemFromMessage(msg) {
  const base = { caption: msg.caption || '', entities: msg.caption_entities };
  if (msg.photo) return { ...base, type: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id, thumb: pickPhoto(msg.photo) };
  if (msg.video) return { ...base, type: 'video', file_id: msg.video.file_id, thumb: msg.video.thumbnail?.file_id };
  if (msg.animation) return { ...base, type: 'animation', file_id: msg.animation.file_id, thumb: msg.animation.thumbnail?.file_id };
  if (msg.audio) return { ...base, type: 'audio', file_id: msg.audio.file_id, thumb: msg.audio.thumbnail?.file_id };
  if (msg.voice) return { ...base, type: 'voice', file_id: msg.voice.file_id };
  if (msg.video_note) return { type: 'video_note', file_id: msg.video_note.file_id, thumb: msg.video_note.thumbnail?.file_id };
  if (msg.document) return { ...base, type: 'document', file_id: msg.document.file_id, thumb: msg.document.thumbnail?.file_id };
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

// Bazadagi (yoki endi saqlanayotgan) elementni chatga yuboradi
async function sendItem(api, chatId, it, other = {}) {
  const o = { ...other };
  const entities = typeof it.entities === 'string' ? parseJson(it.entities) : it.entities;
  if (it.caption) {
    o.caption = it.caption;
    if (entities) o.caption_entities = entities;
  }
  const extra = (typeof it.extra === 'string' ? parseJson(it.extra) : it.extra) || {};
  switch (it.type) {
    case 'photo': return api.sendPhoto(chatId, it.file_id, o);
    case 'video': return api.sendVideo(chatId, it.file_id, o);
    case 'animation': return api.sendAnimation(chatId, it.file_id, o);
    case 'audio': return api.sendAudio(chatId, it.file_id, o);
    case 'voice': return api.sendVoice(chatId, it.file_id, o);
    case 'video_note': return api.sendVideoNote(chatId, it.file_id, other);
    case 'document': return api.sendDocument(chatId, it.file_id, o);
    case 'text': return api.sendMessage(chatId, it.caption, { ...other, ...(entities ? { entities } : {}) });
    case 'contact':
      return api.sendContact(chatId, extra.phone_number, extra.first_name || 'Kontakt', {
        ...other, last_name: extra.last_name,
      });
    case 'location': return api.sendLocation(chatId, extra.latitude, extra.longitude, other);
    case 'link':
      return api.sendMessage(chatId, `${linkIcon(it.url)} ${it.caption || linkLabel(it.url)}\n${it.url}`, other);
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

/**
 * @param {string} token
 * @param {object} [botConfig]  grammY sozlamalari (testlarda botInfo)
 * @param {object} [options]
 * @param {(fileId: string) => Promise<Buffer|null>} [options.downloadFile]
 */
function createBot(token, botConfig = {}, options = {}) {
  const bot = new Bot(token, botConfig);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  const pm = bot.chatType('private');
  const grp = bot.chatType(['group', 'supergroup']);

  const username = () => bot.botInfo.username;
  const profileLink = (code) => `https://t.me/${username()}?start=${code}`;
  const itemLink = (code) => `https://t.me/${username()}?start=i_${code}`;
  const groupAddLink = (code) => `https://t.me/${username()}?startgroup=${code}&admin=delete_messages+pin_messages`;

  // ── Telegram'dan rasm yuklab olish (QR karta foni uchun) ──

  const imageCache = new Map();
  const downloadFile = options.downloadFile || (async (fileId) => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  });

  async function getImage(fileId) {
    if (!fileId) return null;
    if (imageCache.has(fileId)) return imageCache.get(fileId);
    let buf = null;
    try {
      buf = await downloadFile(fileId);
    } catch (err) {
      console.error('Fon rasmi yuklanmadi:', err.description || err.message);
    }
    if (buf) {
      imageCache.set(fileId, buf);
      if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
    }
    return buf;
  }

  // ── Shaxsiy guruh bilan ishlash ──

  // Guruhga biror narsa yuboradi; guruh o'chgan yoki bot chiqarilgan bo'lsa, ulanishni uzadi
  async function toGroup(ownerId, fn) {
    let owner = store.getUser(ownerId);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!owner || !owner.group_id) return null;
      try {
        return await fn(owner.group_id);
      } catch (err) {
        const newId = err.parameters?.migrate_to_chat_id;
        if (newId) {
          store.migrateGroup(owner.group_id, newId);
          owner = store.getUser(ownerId);
          continue;
        }
        const d = String(err.description || err.message);
        if (/chat not found|kicked|not a member|CHAT_WRITE_FORBIDDEN|have no rights|deactivated/i.test(d)) {
          store.setGroup(ownerId, null, null);
          await bot.api.sendMessage(ownerId,
            "⚠️ Shaxsiy guruhingizga yozib bo'lmadi — meni guruhdan chiqargan bo'lsangiz kerak.\n" +
            "Ma'lumotlaringiz saqlanib borishi uchun guruhni qaytadan ulang: ⚙️ Sozlamalar.").catch(() => {});
        } else {
          console.error('Guruhga yuborilmadi:', d);
        }
        return null;
      }
    }
    return null;
  }

  // Avval guruhga tushmagan elementlarni guruhga yuboradi
  async function backfillGroup(ownerId) {
    for (const it of store.listItems(ownerId)) {
      if (it.group_msg_id) continue;
      const msg = await toGroup(ownerId, (gid) => sendItem(bot.api, gid, it));
      if (!msg) return;
      store.setGroupMsg(it.id, msg.message_id);
    }
  }

  function groupLine(me) {
    return me.group_id
      ? `🔒 Shaxsiy guruh: «${escapeHtml(me.group_title || 'guruh')}»`
      : '🔒 Shaxsiy guruh: ulanmagan ⚠️';
  }

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
    await ctx.api.sendMessage(ctx.from.id, text, { parse_mode: 'HTML', reply_markup });
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

  function groupInstructions(me) {
    return {
      text:
        '🔒 <b>Shaxsiy guruh</b>\n\n' +
        "Ma'lumotlaringiz tarqab ketmasligi uchun o'zingizga <b>yopiq guruh</b> oching va meni unga qo'shing. " +
        "Yuborgan hamma narsangizni o'sha guruhga saqlab boraman — bu sizning shaxsiy omboringiz bo'ladi.\n\n" +
        '<b>Qanday qilinadi:</b>\n' +
        "1️⃣ «➕ Guruhga qo'shish» tugmasini bosing\n" +
        '2️⃣ Yangi guruh yarating yoki bor yopiq guruhingizni tanlang\n' +
        '3️⃣ Menga admin huquqini bering\n\n' +
        `<i>Yoki: Telegramda «Yangi guruh» yarating va a'zo sifatida @${username()} ni qo'shing.</i>\n\n` +
        "⚠️ Guruhga boshqa odam qo'shmang va uni ochiq (public) qilmang.",
      reply_markup: new InlineKeyboard().url("➕ Guruhga qo'shish", groupAddLink(me.code)),
    };
  }

  async function askGroup(ctx, me) {
    store.setState(me.tg_id, 'await_group');
    const g = groupInstructions(me);
    g.reply_markup.row().text('⏭ Keyinroq', 'skip_group');
    await ctx.api.sendMessage(me.tg_id, g.text, { parse_mode: 'HTML', reply_markup: g.reply_markup });
  }

  async function finishOnboarding(chatId) {
    store.setState(chatId, null);
    const me = store.getUser(chatId);
    await bot.api.sendMessage(chatId,
      '🎉 <b>Profilingiz tayyor!</b>\n\n' +
      'Endi menga yuboring:\n🖼 rasm   🎬 video   🎵 audio\n🎙 ovozli xabar   ⭕️ dumaloq video\n🔗 havola   📝 matn\n\n' +
      "Hammasi profilingizga qo'shiladi" + (me.group_id ? ' va shaxsiy guruhingizga saqlanadi' : '') + '.\n' +
      'Yurakchali QR kartani olish uchun «🔳 QR karta» tugmasini bosing.' +
      (me.group_id ? '' : '\n\n🔒 Shaxsiy guruhni keyinroq ⚙️ Sozlamalar orqali ulashingiz mumkin.'),
      { parse_mode: 'HTML', reply_markup: mainKeyboard });
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

  async function sendViewerFooter(ctx, kb = new InlineKeyboard()) {
    const viewer = store.getUser(ctx.from.id);
    let text = '✨ <b>BirQR</b> orqali yaratilgan.';
    if (!hasProfile(viewer)) {
      text += "\nSiz ham o'z profilingizni ochib, yurakchali QR karta oling!";
      kb.row().text('✨ Men ham ochaman', 'new');
    }
    const hasButtons = kb.inline_keyboard.some((row) => row.length);
    await ctx.api.sendMessage(ctx.chat.id, text, { parse_mode: 'HTML', reply_markup: hasButtons ? kb : undefined });
  }

  async function showProfile(ctx, owner) {
    const chatId = ctx.chat.id;
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
      await ctx.api.sendPhoto(chatId, owner.avatar, { caption: header, ...opts });
    } else {
      if (owner.avatar) await ctx.api.sendPhoto(chatId, owner.avatar);
      await ctx.api.sendMessage(chatId, header, opts);
    }

    await sendItems(ctx.api, chatId, items.filter((i) => i.type !== 'link'));

    if (isOwner) {
      const empty = items.length === 0
        ? "\n\nHozircha profilingiz bo'sh. Menga rasm, video, ovozli xabar yoki havola yuboring!"
        : '';
      await ctx.api.sendMessage(chatId,
        `👆 Profilingiz boshqalarga shunday ko'rinadi.\n\n👀 Ko'rishlar: ${owner.views}\n📦 Elementlar: ${items.length}${empty}`,
        { reply_markup: new InlineKeyboard().text('🔳 QR karta', 'qr').text('📋 Boshqarish', 'list:0') });
    } else {
      await sendViewerFooter(ctx);
    }
  }

  // QR orqali bitta element ochilganda (masalan sovg'adagi ovozli xabar)
  async function showGiftItem(ctx, it) {
    const owner = store.getUser(it.user_id);
    if (!hasProfile(owner)) return ctx.reply("😕 Bu xabar topilmadi — u o'chirilgan bo'lishi mumkin.");
    if (ctx.from.id !== owner.tg_id) store.incItemViews(it.id);
    let text = `🎁 <b>${escapeHtml(owner.name)}</b> sizga ${GIFT_NAME[it.type] || 'xabar'} qoldirdi`;
    if (it.wish) text += `:\n\n<i>${escapeHtml(it.wish)}</i>`;
    await ctx.reply(text, { parse_mode: 'HTML' });
    try {
      await sendItem(ctx.api, ctx.chat.id, it);
    } catch (err) {
      console.error('Element yuborilmadi:', err.description || err.message);
    }
    await sendViewerFooter(ctx, new InlineKeyboard().text("👤 Profilini ko'rish", `vp:${owner.code}`));
    return undefined;
  }

  // ── QR karta ──

  // t = 'p' (profil) yoki element raqami (matn ko'rinishida)
  function cardTarget(me, t) {
    if (t === 'p') {
      return {
        t, kind: 'profile', style: me.qr_style, link: profileLink(me.code),
        wish: me.qr_wish || `${me.name} ♥`, ownWish: me.qr_wish, bg: me.qr_bg,
      };
    }
    const it = store.getItem(me.tg_id, Number(t));
    if (!it) return null;
    const def = it.type === 'voice' ? 'Sizga ovozli xabarim bor ♥'
      : it.type === 'video_note' ? 'Sizga video xabarim bor ♥'
        : `${me.name} ♥`;
    return {
      t: String(it.id), kind: 'item', item: it, style: it.style || me.qr_style, link: itemLink(it.code),
      wish: it.wish || def, ownWish: it.wish, bg: it.bg,
    };
  }

  // Fon tartibi: tanlangan fon → elementning o'z kadri → profil foni → profil rasmi → birinchi rasm/video
  function backgroundFor(me, target) {
    if (target.bg) return target.bg;
    if (target.kind === 'item' && target.item.thumb) return target.item.thumb;
    if (me.qr_bg) return me.qr_bg;
    if (me.avatar) return me.avatar;
    const withThumb = store.listItems(me.tg_id).find((i) => i.thumb);
    return withThumb ? withThumb.thumb : null;
  }

  async function buildCard(me, target, scale = 1) {
    const background = await getImage(backgroundFor(me, target));
    const r = await renderCardDetailed({
      link: target.link, style: target.style, wish: target.wish, background, scale,
      format: scale > 1 ? 'png' : 'jpeg',
    });
    if (!r.verified) console.warn(`QR karta skanerlanishini tasdiqlab bo'lmadi: ${target.link}`);
    return r.buffer;
  }

  function cardCaption(target, intro) {
    const title = target.kind === 'profile' ? 'Profilingiz QR kartasi' : `${TYPE_INFO[target.item.type][1]} QR kartasi`;
    const what = target.kind === 'profile'
      ? 'Kim skanerlasa, profilingiz ochiladi'
      : `Kim skanerlasa, shu ${GIFT_NAME[target.item.type] || 'element'}ni ko'radi`;
    return (intro ? `${intro}\n\n` : '') +
      `🔳 <b>${title}</b>\n${what}:\n${target.link}\n\n` +
      "✍️ Tilak va 🖼 fonni pastdagi tugmalar bilan o'zgartiring.";
  }

  function cardKeyboard(target, me, { withDelete = false } = {}) {
    const { t } = target;
    const share = `https://t.me/share/url?url=${encodeURIComponent(target.link)}&text=${encodeURIComponent(`${me.name} — siz uchun ♥`)}`;
    const kb = new InlineKeyboard();
    for (const [key, s] of Object.entries(STYLES)) kb.text(`${target.style === key ? '✅' : s.emoji} ${s.name}`, `cs:${t}:${key}`);
    kb.row().text('✍️ Tilak yozish', `cw:${t}`).text('🖼 Fon', `cb:${t}`);
    kb.row().text('📎 Chop etish uchun', `cf:${t}`).url('📤 Ulashish', share);
    if (withDelete) kb.row().text("🗑 O'chirish", `del:${t}`);
    return kb;
  }

  async function sendCard(ctx, me, t, { chatId, intro, replyTo, withDelete } = {}) {
    const to = chatId || ctx.chat.id;
    const target = cardTarget(me, t);
    if (!target) return ctx.api.sendMessage(to, 'Topilmadi 🤷');
    await ctx.api.sendChatAction(to, 'upload_photo').catch(() => {});
    const img = await buildCard(me, target);
    return ctx.api.sendPhoto(to, new InputFile(img, `birqr-${target.t}.jpg`), {
      caption: cardCaption(target, intro),
      parse_mode: 'HTML',
      reply_markup: cardKeyboard(target, me, { withDelete }),
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });
  }

  // ── Elementlar ro'yxati ──

  function listView(me, page) {
    const items = store.listItems(me.tg_id);
    if (!items.length) {
      return {
        text: "📋 Profilingiz hozircha bo'sh.\n\nMenga rasm, video, ovozli xabar yoki havola yuboring — ular shu yerda paydo bo'ladi.",
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
      kb.text(`👁 ${start + k + 1}`, `show:${it.id}`)
        .text('🔳', `qi:${it.id}`)
        .text('⬆️', `up:${it.id}:${p}`)
        .text('🗑', `rm:${it.id}:${p}`)
        .row();
    });
    if (pages > 1) {
      kb.text(p > 0 ? '◀️' : '·', p > 0 ? `list:${p - 1}` : 'noop')
        .text(`${p + 1} / ${pages}`, 'noop')
        .text(p < pages - 1 ? '▶️' : '·', p < pages - 1 ? `list:${p + 1}` : 'noop');
    }
    return {
      text:
        `📋 <b>Elementlaringiz</b> (${items.length} / ${MAX_ITEMS})\n\n${lines.join('\n')}\n\n` +
        "👁 ko'rish  ·  🔳 QR karta  ·  ⬆️ yuqoriga  ·  🗑 o'chirish",
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
    kb.row();
    if (me.group_id) kb.text('🔌 Guruhni uzish', 'set:unlink');
    else kb.text('🔒 Shaxsiy guruh ulash', 'set:group');
    kb.row().text("🗑 Profilni o'chirish", 'set:delete');
    return {
      text:
        '⚙️ <b>Sozlamalar</b>\n\n' +
        `👤 Ism: ${escapeHtml(me.name)}\n` +
        `📝 Tavsif: ${me.bio ? escapeHtml(clip(me.bio, 120)) : '—'}\n` +
        `🖼 Profil rasmi: ${me.avatar ? 'bor' : "yo'q"}\n` +
        `${groupLine(me)}\n` +
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

  const viewKb = () => new InlineKeyboard().text("👁 Profilni ko'rish", 'view').text('🔳 QR karta', 'qr');

  // Albom (bir nechta rasm birga) kelganda har biriga emas, bitta javob beramiz
  const albums = new Map();
  function albumAck(chatId, key, added) {
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
      bot.api.sendMessage(chatId, text, { reply_markup: a.added ? viewKb() : undefined })
        .catch((err) => console.error('Albom javobi yuborilmadi:', err.description || err.message));
    }, 1500);
  }

  /**
   * Elementni saqlaydi va shaxsiy guruhga nusxasini yuboradi.
   * copyFrom — asl xabar (guruhga aynan o'zi nusxalanadi); skipGroup — guruhga yubormaslik.
   */
  async function saveItem(me, item, { copyFrom = null, skipGroup = false } = {}) {
    const { id } = store.addItem(me.tg_id, item);
    if (!item.group_msg_id && !skipGroup && me.group_id) {
      const msg = await toGroup(me.tg_id, (gid) => (copyFrom
        ? bot.api.copyMessage(gid, copyFrom.chatId, copyFrom.messageId)
        : sendItem(bot.api, gid, item)));
      if (msg) store.setGroupMsg(id, msg.message_id);
    }
    return id;
  }

  async function removeItem(me, id) {
    const it = store.getItem(me.tg_id, id);
    if (!it) return false;
    store.deleteItem(me.tg_id, id);
    if (it.group_msg_id && me.group_id) {
      await bot.api.deleteMessage(me.group_id, it.group_msg_id).catch(() => {});
    }
    return true;
  }

  // ───────────── Buyruqlar (shaxsiy chat) ─────────────

  pm.command('start', async (ctx) => {
    const payload = String(ctx.match || '').trim();
    const me = store.ensureUser(ctx.from.id);

    if (payload.startsWith('i_')) {
      // Element QR kartasi skanerlangan: t.me/bot?start=i_<kod>
      const it = store.getItemByCode(payload.slice(2));
      if (it) return showGiftItem(ctx, it);
      await ctx.reply("😕 Bu xabar topilmadi — u o'chirilgan bo'lishi mumkin.");
    } else if (payload) {
      // Profil QR kartasi skanerlangan: t.me/bot?start=<kod>
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

  pm.command('bekor', async (ctx) => {
    const me = store.ensureUser(ctx.from.id);
    if (!hasProfile(me)) return askName(ctx, false);
    store.setState(me.tg_id, null);
    await ctx.reply('↩️ Bekor qilindi.', { reply_markup: mainKeyboard });
  });

  pm.command('yordam', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
  pm.command('profil', withProfile((ctx, me) => showProfile(ctx, me)));
  pm.command('qr', withProfile((ctx, me) => sendCard(ctx, me, 'p')));
  pm.command('elementlar', withProfile((ctx, me) => sendList(ctx, me)));
  pm.command('sozlamalar', withProfile((ctx, me) => sendSettings(ctx, me)));

  // ───────────── Menyu tugmalari ─────────────

  pm.hears(BTN.add, withProfile((ctx) => ctx.reply(ADD_HELP, { parse_mode: 'HTML' })));
  pm.hears(BTN.profile, withProfile((ctx, me) => showProfile(ctx, me)));
  pm.hears([BTN.qr, '🔳 QR kod'], withProfile((ctx, me) => sendCard(ctx, me, 'p')));
  pm.hears(BTN.items, withProfile((ctx, me) => sendList(ctx, me)));
  pm.hears(BTN.settings, withProfile((ctx, me) => sendSettings(ctx, me)));
  pm.hears(BTN.help, (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  // ───────────── Fayllar (rasm, video, audio ...) ─────────────

  const MEDIA = [
    'message:photo', 'message:video', 'message:animation', 'message:audio', 'message:voice',
    'message:video_note', 'message:document', 'message:contact', 'message:location',
  ];

  pm.on(MEDIA, async (ctx) => {
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

    // QR karta foni
    if (me.state === 'await_bg') {
      const p = parseJson(me.pending) || {};
      const fileId = msg.photo
        ? pickPhoto(msg.photo)
        : (msg.video || msg.video_note || msg.animation || msg.document)?.thumbnail?.file_id;
      if (!fileId) return ctx.reply('🖼 Fon uchun rasm yoki video yuboring (yoki /bekor).');
      if (p.t === 'p') store.setUserCard(me.tg_id, { bg: fileId });
      else store.setItemCard(me.tg_id, Number(p.t), { bg: fileId });
      store.setState(me.tg_id, null);
      return sendCard(ctx, store.getUser(me.tg_id), p.t, { intro: '✅ Fon yangilandi!' });
    }
    if (me.state) store.setState(me.tg_id, null);

    const item = itemFromMessage(msg);
    if (!item) return undefined;

    const full = store.countItems(me.tg_id) >= MAX_ITEMS;
    const id = full ? null : await saveItem(me, item, { copyFrom: { chatId: ctx.chat.id, messageId: msg.message_id } });

    if (msg.media_group_id) return albumAck(ctx.chat.id, `${me.tg_id}:${msg.media_group_id}`, !full);
    if (full) return ctx.reply(LIMIT_TEXT);

    const saved = store.getUser(me.tg_id);
    const where = saved.group_id ? ' va shaxsiy guruhingizga saqlandi' : '';

    // Ovozli xabar va dumaloq video uchun darhol QR karta
    if (item.type === 'voice' || item.type === 'video_note') {
      return sendCard(ctx, saved, String(id), {
        intro: `✅ ${TYPE_INFO[item.type][1]} profilingizga qo'shildi${where}.\nMana uning QR kartasi 👇`,
        withDelete: true,
      });
    }

    const kb = new InlineKeyboard()
      .text("🗑 O'chirish", `del:${id}`)
      .text('🔳 QR karta', `qi:${id}`)
      .row()
      .text("👁 Profilni ko'rish", 'view');
    if (!saved.group_id) kb.text('🔒 Guruh ulash', 'set:group');
    return ctx.reply(`✅ Profilingizga qo'shildi${where}: ${itemLabel(item)}`, { reply_markup: kb });
  });

  // ───────────── Matnli xabarlar ─────────────

  pm.on('message:text', async (ctx) => {
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
        if (me.state === 'await_bio') return askGroup(ctx, store.getUser(me.tg_id));
        store.setState(me.tg_id, null);
        return ctx.reply('✅ Tavsif yangilandi!', { reply_markup: mainKeyboard });
      }
      case 'await_wish': {
        const p = parseJson(me.pending) || {};
        const wish = text.slice(0, WISH_MAX);
        if (p.t === 'p') store.setUserCard(me.tg_id, { wish });
        else store.setItemCard(me.tg_id, Number(p.t), { wish });
        store.setState(me.tg_id, null);
        return sendCard(ctx, store.getUser(me.tg_id), p.t, { intro: '✅ Tilak yozildi!' });
      }
      case 'await_avatar':
        return ctx.reply('🖼 Profil rasmi uchun rasm yuboring (yoki /bekor).');
      case 'await_bg':
        return ctx.reply('🖼 Fon uchun rasm yoki video yuboring (yoki /bekor).');
      case 'await_group':
        return ctx.reply("🔒 Meni shaxsiy guruhingizga qo'shing yoki «⏭ Keyinroq» tugmasini bosing.");
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
      const ids = [];
      for (const [i, l] of toAdd.entries()) {
        // Guruhga asl xabarning bitta nusxasi yetarli
        ids.push(await saveItem(me, { type: 'link', url: l.url, caption: l.caption }, {
          copyFrom: { chatId: ctx.chat.id, messageId: ctx.message.message_id },
          skipGroup: i > 0,
        }));
      }
      const list = toAdd.map((l) => `${linkIcon(l.url)} ${escapeHtml(l.caption || linkLabel(l.url))}`).join('\n');
      const head = toAdd.length === 1 ? "✅ Havola qo'shildi:" : `✅ ${toAdd.length} ta havola qo'shildi:`;
      const kb = new InlineKeyboard();
      if (ids.length === 1) kb.text("🗑 O'chirish", `del:${ids[0]}`);
      kb.text("👁 Profilni ko'rish", 'view');
      const skipped = links.length - toAdd.length;
      return ctx.reply(`${head}\n${list}${skipped ? `\n\n${LIMIT_TEXT}` : ''}`, { parse_mode: 'HTML', reply_markup: kb });
    }

    // Oddiy matn — qo'shishdan oldin so'raymiz
    store.setState(me.tg_id, null, { text: ctx.message.text, entities: ctx.message.entities, mid: ctx.message.message_id });
    return ctx.reply("📝 Bu matnni profilingizga qo'shaymi?", {
      reply_markup: new InlineKeyboard().text("✅ Ha, qo'shish", 'addtext').text("❌ Yo'q", 'notext'),
    });
  });

  // ───────────── Shaxsiy guruh ─────────────

  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return undefined;
    const upd = ctx.myChatMember;
    const now = upd.new_chat_member.status;
    const before = upd.old_chat_member.status;
    const inside = (s) => s === 'member' || s === 'administrator';

    // Bot guruhdan chiqarildi
    if (!inside(now)) {
      const owner = store.getByGroup(chat.id);
      if (owner) {
        store.setGroup(owner.tg_id, null, null);
        await bot.api.sendMessage(owner.tg_id,
          `🔌 «${escapeHtml(chat.title)}» guruhidan chiqarildim — ma'lumotlaringiz endi guruhga saqlanmaydi.\n` +
          'Qaytadan ulash: ⚙️ Sozlamalar → 🔒 Shaxsiy guruh ulash.', { parse_mode: 'HTML' }).catch(() => {});
      }
      return undefined;
    }

    // Bot allaqachon guruhda edi (masalan admin qilindi)
    if (inside(before)) {
      const owner = store.getByGroup(chat.id);
      if (owner && now === 'administrator' && before === 'member') {
        await ctx.api.sendMessage(chat.id,
          "👍 Rahmat! Endi shu guruhga o'zingiz yuborgan rasm, video va ovozli xabarlar ham profilingizga qo'shiladi.").catch(() => {});
      }
      return undefined;
    }

    // Bot guruhga qo'shildi
    const owner = store.getUser(upd.from.id);
    const leave = () => ctx.api.leaveChat(chat.id).catch(() => {});

    if (!hasProfile(owner)) {
      await ctx.api.sendMessage(chat.id, `Avval botda profil oching: https://t.me/${username()}`).catch(() => {});
      return leave();
    }
    if (chat.username) {
      const warn = "⚠️ Bu guruh <b>ochiq (public)</b> — ma'lumotlaringiz tarqab ketadi.\n" +
        "Guruhni yopiq (private) qiling yoki yangi yopiq guruh oching, keyin meni qaytadan qo'shing.";
      await ctx.api.sendMessage(chat.id, warn, { parse_mode: 'HTML' }).catch(() => {});
      await bot.api.sendMessage(owner.tg_id, warn, { parse_mode: 'HTML' }).catch(() => {});
      return leave();
    }
    const taken = store.getByGroup(chat.id);
    if (taken && taken.tg_id !== owner.tg_id) {
      await ctx.api.sendMessage(chat.id, '⚠️ Bu guruh boshqa odamning profiliga ulangan.').catch(() => {});
      return leave();
    }

    store.setGroup(owner.tg_id, chat.id, chat.title);
    const count = await ctx.api.getChatMemberCount(chat.id).catch(() => null);
    const crowded = count && count > 2
      ? "\n\n⚠️ Guruhda boshqa odamlar ham bor — ular ma'lumotlaringizni ko'radi. Shaxsiy saqlash uchun ularni chiqaring."
      : '';
    const adminHint = now === 'administrator' ? ''
      : "\n\n💡 Meni <b>admin</b> qilsangiz, shu guruhga o'zingiz yuborgan rasm/videolar ham profilingizga qo'shiladi.";
    await ctx.api.sendMessage(chat.id,
      `📦 <b>Shaxsiy ombor ulandi</b>\n\nBu guruh — <b>${escapeHtml(owner.name)}</b>ning shaxsiy guruhi. ` +
      "Botga yuborgan hamma narsangiz shu yerga saqlanadi.\n🔒 Guruhga hech kimni qo'shmang — ma'lumotlaringiz tarqab ketmasin." +
      crowded + adminHint,
      { parse_mode: 'HTML' }).catch(() => {});

    await bot.api.sendMessage(owner.tg_id,
      `✅ «${escapeHtml(chat.title)}» guruhi ulandi! Endi hamma ma'lumotlaringiz o'sha yerda saqlanadi.${crowded}`,
      { parse_mode: 'HTML' }).catch(() => {});
    if (owner.state === 'await_group') await finishOnboarding(owner.tg_id);

    // Oldin qo'shilgan elementlarni fonda guruhga ko'chiramiz
    backfillGroup(owner.tg_id).catch((err) => console.error("Guruhga ko'chirishda xato:", err.message));
    return undefined;
  });

  // Oddiy guruh superguruhga aylanganda ID o'zgaradi
  grp.on('message:migrate_to_chat_id', (ctx) => {
    store.migrateGroup(ctx.chat.id, ctx.message.migrate_to_chat_id);
  });

  // Egasi guruhga o'zi yuborgan narsalar ham profilga qo'shiladi
  grp.on(MEDIA, async (ctx) => {
    const owner = store.getByGroup(ctx.chat.id);
    if (!owner || ctx.from?.id !== owner.tg_id) return undefined;
    const msg = ctx.message;
    const item = itemFromMessage(msg);
    if (!item) return undefined;
    if (store.countItems(owner.tg_id) >= MAX_ITEMS) return ctx.reply(LIMIT_TEXT);
    item.group_msg_id = msg.message_id;
    const id = await saveItem(owner, item);
    if (item.type === 'voice' || item.type === 'video_note') {
      return sendCard(ctx, owner, String(id), {
        replyTo: msg.message_id,
        intro: `✅ ${TYPE_INFO[item.type][1]} profilingizga qo'shildi. Mana QR kartasi 👇`,
      });
    }
    return ctx.react('❤').catch(() => ctx.reply("✅ Profilga qo'shildi", { reply_parameters: { message_id: msg.message_id } }));
  });

  grp.on('message:text', async (ctx) => {
    const owner = store.getByGroup(ctx.chat.id);
    if (!owner || ctx.from?.id !== owner.tg_id || ctx.message.text.startsWith('/')) return undefined;
    const links = extractLinks(ctx.message);
    if (!links.length) return undefined;
    const room = Math.max(MAX_ITEMS - store.countItems(owner.tg_id), 0);
    for (const l of links.slice(0, room)) {
      store.addItem(owner.tg_id, { type: 'link', url: l.url, caption: l.caption, group_msg_id: ctx.message.message_id });
    }
    return ctx.react('❤').catch(() => {});
  });

  // ───────────── Inline tugmalar ─────────────

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery('new', async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = store.ensureUser(ctx.from.id);
    if (hasProfile(me)) return ctx.api.sendMessage(ctx.from.id, 'Sizda allaqachon profil bor 🙂', { reply_markup: mainKeyboard });
    return askName(ctx);
  });

  bot.callbackQuery(/^vp:([a-z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const owner = store.getByCode(ctx.match[1]);
    if (!hasProfile(owner)) return ctx.reply('😕 Profil topilmadi.');
    return showProfile(ctx, owner);
  });

  bot.callbackQuery('skip_bio', async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = store.getUser(ctx.from.id);
    if (me && me.state === 'await_bio') {
      await ctx.editMessageReplyMarkup().catch(() => {});
      return askGroup(ctx, me);
    }
    return undefined;
  });

  bot.callbackQuery('skip_group', async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = store.getUser(ctx.from.id);
    if (me && me.state === 'await_group') {
      await ctx.editMessageReplyMarkup().catch(() => {});
      return finishOnboarding(me.tg_id);
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
    const id = await saveItem(me, { type: 'text', caption: p.text, entities: p.entities }, {
      copyFrom: p.mid ? { chatId: ctx.from.id, messageId: p.mid } : null,
    });
    store.setState(me.tg_id, null);
    await ctx.answerCallbackQuery({ text: "Qo'shildi ✅" });
    return ctx.editMessageText(`✅ Matn profilingizga qo'shildi: ${clip(p.text, 40)}`, {
      reply_markup: new InlineKeyboard()
        .text("🗑 O'chirish", `del:${id}`).text('🔳 QR karta', `qi:${id}`).row()
        .text("👁 Profilni ko'rish", 'view'),
    });
  }));

  bot.callbackQuery('notext', async (ctx) => {
    store.setState(ctx.from.id, null);
    await ctx.answerCallbackQuery();
    return ctx.editMessageText("👌 Qo'shilmadi.");
  });

  bot.callbackQuery(/^del:(\d+)$/, withProfile(async (ctx, me) => {
    const ok = await removeItem(me, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: ok ? "O'chirildi 🗑" : "Allaqachon o'chirilgan" });
    const m = ctx.callbackQuery.message;
    if (m && (m.photo || m.caption)) return ctx.deleteMessage().catch(() => {});
    return ctx.editMessageText("🗑 Profilingizdan o'chirildi.").catch(() => {});
  }));

  bot.callbackQuery('view', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    return showProfile(ctx, me);
  }));

  bot.callbackQuery('qr', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    return sendCard(ctx, me, 'p');
  }));

  bot.callbackQuery(/^qi:(\d+)$/, withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery({ text: 'Tayyorlanmoqda…' });
    return sendCard(ctx, me, ctx.match[1]);
  }));

  // QR karta: uslubni almashtirish (rasm o'sha xabarning o'zida yangilanadi)
  bot.callbackQuery(/^cs:(p|\d+):(\w+)$/, withProfile(async (ctx, me) => {
    const [, t, style] = ctx.match;
    if (!STYLES[style]) return ctx.answerCallbackQuery();
    const before = cardTarget(me, t);
    if (!before) return ctx.answerCallbackQuery({ text: 'Topilmadi' });
    if (before.style === style) return ctx.answerCallbackQuery({ text: 'Shu uslub tanlangan ✅' });
    if (t === 'p') store.setUserCard(me.tg_id, { style });
    else store.setItemCard(me.tg_id, Number(t), { style });
    await ctx.answerCallbackQuery({ text: `${STYLES[style].emoji} ${STYLES[style].name}` });

    const fresh = store.getUser(me.tg_id);
    const target = cardTarget(fresh, t);
    const img = await buildCard(fresh, target);
    const m = ctx.callbackQuery.message;
    const withDelete = Boolean(m?.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === `del:${t}`));
    const oldCaption = m?.caption || '';
    const intro = oldCaption.includes('\n\n🔳') ? escapeHtml(oldCaption.split('\n\n🔳')[0]) : '';
    return ctx.editMessageMedia(
      InputMediaBuilder.photo(new InputFile(img, `birqr-${t}.jpg`), {
        caption: cardCaption(target, intro),
        parse_mode: 'HTML',
      }),
      { reply_markup: cardKeyboard(target, fresh, { withDelete }) },
    );
  }));

  // QR karta: tilak yozish
  bot.callbackQuery(/^cw:(p|\d+)$/, withProfile(async (ctx, me) => {
    const t = ctx.match[1];
    const target = cardTarget(me, t);
    if (!target) return ctx.answerCallbackQuery({ text: 'Topilmadi' });
    store.setState(me.tg_id, 'await_wish', { t });
    const inGroup = ctx.chat?.type !== 'private';
    await ctx.answerCallbackQuery({ text: inGroup ? "✍️ Botning o'ziga yozing" : undefined });
    return ctx.api.sendMessage(me.tg_id,
      `✍️ Kartaning oq joyiga yoziladigan tilakni yozing (${WISH_MAX} belgigacha).\n` +
      "Qo'lda yozilgandek chiroyli yozuv bilan chiqadi, ❤️ emojisi yurakcha bo'lib chiziladi.\n\n" +
      "Masalan: <i>Onajonim, tug'ilgan kuningiz bilan! ❤️</i>\n\nBekor qilish: /bekor",
      {
        parse_mode: 'HTML',
        reply_markup: target.ownWish ? new InlineKeyboard().text("🧹 Tilakni o'chirish", `cwx:${t}`) : undefined,
      });
  }));

  bot.callbackQuery(/^cwx:(p|\d+)$/, withProfile(async (ctx, me) => {
    const t = ctx.match[1];
    if (t === 'p') store.setUserCard(me.tg_id, { wish: '' });
    else store.setItemCard(me.tg_id, Number(t), { wish: null });
    store.setState(me.tg_id, null);
    await ctx.answerCallbackQuery({ text: "Tilak o'chirildi" });
    await ctx.editMessageReplyMarkup().catch(() => {});
    return sendCard(ctx, store.getUser(me.tg_id), t, { chatId: me.tg_id, intro: "🧹 Tilak o'chirildi." });
  }));

  // QR karta: orqa fon
  bot.callbackQuery(/^cb:(p|\d+)$/, withProfile(async (ctx, me) => {
    const t = ctx.match[1];
    const target = cardTarget(me, t);
    if (!target) return ctx.answerCallbackQuery({ text: 'Topilmadi' });
    store.setState(me.tg_id, 'await_bg', { t });
    const inGroup = ctx.chat?.type !== 'private';
    await ctx.answerCallbackQuery({ text: inGroup ? "🖼 Botning o'ziga yuboring" : undefined });
    return ctx.api.sendMessage(me.tg_id,
      "🖼 Kartaning orqa foni uchun <b>rasm</b> yoki <b>video</b> yuboring — u xira bo'lib ko'rinadi.\n" +
      'Video yuborsangiz, undan bir kadr olinadi.\n\nBekor qilish: /bekor',
      {
        parse_mode: 'HTML',
        reply_markup: target.bg ? new InlineKeyboard().text('🧹 Fonni olib tashlash', `cbx:${t}`) : undefined,
      });
  }));

  bot.callbackQuery(/^cbx:(p|\d+)$/, withProfile(async (ctx, me) => {
    const t = ctx.match[1];
    if (t === 'p') store.setUserCard(me.tg_id, { bg: null });
    else store.setItemCard(me.tg_id, Number(t), { bg: null });
    store.setState(me.tg_id, null);
    await ctx.answerCallbackQuery({ text: 'Fon olib tashlandi' });
    await ctx.editMessageReplyMarkup().catch(() => {});
    return sendCard(ctx, store.getUser(me.tg_id), t, { chatId: me.tg_id, intro: '🧹 Fon olib tashlandi.' });
  }));

  // QR karta: chop etish uchun katta fayl
  bot.callbackQuery(/^cf:(p|\d+)$/, withProfile(async (ctx, me) => {
    const target = cardTarget(me, ctx.match[1]);
    if (!target) return ctx.answerCallbackQuery({ text: 'Topilmadi' });
    await ctx.answerCallbackQuery({ text: 'Tayyorlanmoqda…' });
    await ctx.api.sendChatAction(ctx.chat.id, 'upload_document').catch(() => {});
    const img = await buildCard(me, target, 2);
    return ctx.api.sendDocument(ctx.chat.id, new InputFile(img, `birqr-karta-${target.t}.png`), {
      caption: '📎 Yuqori sifatli QR karta (2160×2700) — chop etish uchun.',
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
    const ok = await removeItem(me, Number(ctx.match[1]));
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

  bot.callbackQuery('set:group', withProfile(async (ctx, me) => {
    await ctx.answerCallbackQuery();
    const g = groupInstructions(me);
    return ctx.api.sendMessage(me.tg_id, g.text, { parse_mode: 'HTML', reply_markup: g.reply_markup });
  }));

  bot.callbackQuery('set:unlink', withProfile(async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      "🔌 Shaxsiy guruhni uzsangiz, yangi ma'lumotlar u yerga saqlanmaydi (eskilari guruhda qoladi).\n\nUzaymi?",
      { reply_markup: new InlineKeyboard().text('✅ Ha, uzish', 'set:unlink_yes').text("↩️ Yo'q", 'set:back') },
    );
  }));

  bot.callbackQuery('set:unlink_yes', withProfile(async (ctx, me) => {
    const gid = me.group_id;
    store.setGroup(me.tg_id, null, null);
    if (gid) {
      await ctx.api.sendMessage(gid, '🔌 Bu guruh profildan uzildi. Xayr! 👋').catch(() => {});
      await ctx.api.leaveChat(gid).catch(() => {});
    }
    await ctx.answerCallbackQuery({ text: 'Guruh uzildi' });
    const v = settingsView(store.getUser(me.tg_id));
    return ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
  }));

  bot.callbackQuery('set:delete', withProfile(async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      "⚠️ <b>Profilingiz va undagi hamma narsa o'chadi.</b>\nQR kartalaringiz ham ishlamay qoladi.\n\nRostdan o'chirasizmi?",
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text("✅ Ha, o'chirish", 'set:delete_yes').text("↩️ Yo'q", 'set:back'),
      },
    );
  }));

  bot.callbackQuery('set:delete_yes', withProfile(async (ctx, me) => {
    if (me.group_id) await ctx.api.leaveChat(me.group_id).catch(() => {});
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
