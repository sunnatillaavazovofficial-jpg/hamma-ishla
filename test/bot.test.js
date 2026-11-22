// Botni Telegramga ulanmasdan sinash: so'rovlar ushlab olinadi, javoblar soxta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'birqr-test-'));

const { createCanvas } = require('@napi-rs/canvas');
const { createBot, BTN } = require('../src/bot');
const store = require('../src/db');

const BOT_INFO = {
  id: 999, is_bot: true, first_name: 'BirQR', username: 'birqr_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
};

// Fon rasmi o'rniga oddiy rangli rasm
const fakeJpeg = (() => {
  const c = createCanvas(320, 400);
  const x = c.getContext('2d');
  x.fillStyle = '#0ea5e9';
  x.fillRect(0, 0, 320, 400);
  return c.toBuffer('image/jpeg');
})();
const downloaded = [];
const bot = createBot('999:TEST', { botInfo: BOT_INFO }, {
  downloadFile: async (id) => { downloaded.push(id); return fakeJpeg; },
});

let calls = [];
let seq = 1000;
const failures = new Map(); // method -> description (bir martalik xato)
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (failures.has(method)) {
    const description = failures.get(method);
    failures.delete(method);
    return { ok: false, error_code: 403, description };
  }
  const chat = { id: payload.chat_id, type: payload.chat_id < 0 ? 'supergroup' : 'private' };
  if (method === 'sendMediaGroup') {
    return { ok: true, result: payload.media.map(() => ({ message_id: ++seq, date: 0, chat })) };
  }
  if (method === 'copyMessage') return { ok: true, result: { message_id: ++seq } };
  if (method === 'getChatMemberCount') return { ok: true, result: 1 };
  if (method.startsWith('send') && method !== 'sendChatAction' || method.startsWith('edit')) {
    return { ok: true, result: { message_id: ++seq, date: 0, chat, text: payload.text || '' } };
  }
  return { ok: true, result: true };
});

const alice = { id: 111, is_bot: false, first_name: 'Alisa', last_name: 'Karimova' };
const bob = { id: 222, is_bot: false, first_name: 'Bobur' };
const GROUP = { id: -100500, type: 'supergroup', title: 'Mening omborim' };

function update(fields) {
  seq += 1;
  return { update_id: seq, ...fields };
}

async function run(upd) {
  calls = [];
  await bot.handleUpdate(upd);
  return calls;
}

function message(from, fields, chat = { id: from.id, type: 'private' }) {
  seq += 1;
  return update({ message: { message_id: seq, date: 0, chat, from, ...fields } });
}

const send = (from, fields, chat) => run(message(from, fields, chat));

function text(from, t, entities, chat) {
  if (!entities && t.startsWith('/')) {
    entities = [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }];
  }
  return send(from, { text: t, entities }, chat);
}

function press(from, data, msg = {}) {
  return run(update({
    callback_query: {
      id: String(seq), from, chat_instance: 'ci', data,
      message: { message_id: 1, date: 0, chat: { id: from.id, type: 'private' }, from: BOT_INFO, text: '…', ...msg },
    },
  }));
}

function botAdded(from, chat, status = 'administrator', old = 'left') {
  return run(update({
    my_chat_member: {
      chat, from, date: 0,
      old_chat_member: { status: old, user: BOT_INFO },
      new_chat_member: { status, user: BOT_INFO },
    },
  }));
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const sent = (cs, method) => cs.filter((c) => c.method === method);
const texts = (cs) => cs.filter((c) => c.payload.text || c.payload.caption).map((c) => c.payload.text || c.payload.caption).join('\n---\n');
const buttons = (c) => (c.payload.reply_markup?.inline_keyboard || []).flat();
const photo = (id) => ({ photo: [{ file_id: `${id}-small`, file_unique_id: 's', width: 90, height: 90 }, { file_id: id, file_unique_id: id, width: 800, height: 800 }] });

let aliceCode;

test('profil ochish: ism, tavsif va shaxsiy guruh taklifi', async () => {
  let cs = await text(alice, '/start');
  assert.match(texts(cs), /BirQR/);
  assert.strictEqual(cs[0].payload.reply_markup.keyboard[0][0].text, 'Alisa Karimova');

  await text(alice, 'Alisa Karimova');
  cs = await text(alice, 'Fotograf. Toshkent.');
  assert.match(texts(cs), /Shaxsiy guruh/);
  const add = buttons(cs[0]).find((b) => b.url);
  assert.match(add.url, /^https:\/\/t\.me\/birqr_test_bot\?startgroup=[a-z0-9]{8}&admin=/);
  assert.strictEqual(store.getUser(alice.id).state, 'await_group');

  cs = await press(alice, 'skip_group');
  assert.match(texts(cs), /Profilingiz tayyor/);

  const me = store.getUser(alice.id);
  assert.strictEqual(me.name, 'Alisa Karimova');
  assert.strictEqual(me.state, null);
  aliceCode = me.code;
});

test("rasm, audio, video qo'shish (guruh hali yo'q)", async () => {
  let cs = await send(alice, { ...photo('P1'), caption: 'Mening ishim' });
  assert.match(texts(cs), /qo'shildi: 🖼 Rasm — Mening ishim/);
  assert.ok(buttons(cs[0]).some((b) => b.callback_data === 'set:group'), 'guruh ulash taklif qilinadi');
  assert.strictEqual(sent(cs, 'copyMessage').length, 0);

  await send(alice, { audio: { file_id: 'A1', file_unique_id: 'a1', duration: 3 }, caption: "Qo'shiq" });
  cs = await send(alice, { video: { file_id: 'VID1', file_unique_id: 'vid1', width: 1, height: 1, duration: 3, thumbnail: { file_id: 'VID1-T', file_unique_id: 't', width: 320, height: 320 } } });
  assert.match(texts(cs), /🎬 Video/);
  const items = store.listItems(alice.id);
  assert.deepStrictEqual(items.map((i) => i.type), ['photo', 'audio', 'video']);
  assert.strictEqual(items[2].thumb, 'VID1-T');
});

test('ovozli xabar yuborilsa darhol QR karta beriladi', async () => {
  downloaded.length = 0;
  const cs = await send(alice, { voice: { file_id: 'V1', file_unique_id: 'v1', duration: 3 } });
  assert.deepStrictEqual(downloaded, ['P1'], 'fon sifatida profildagi birinchi rasm olinadi');
  const card = sent(cs, 'sendPhoto')[0];
  assert.ok(card, 'QR karta yuborilishi kerak');
  const voice = store.listItems(alice.id).at(-1);
  assert.strictEqual(voice.type, 'voice');
  assert.match(card.payload.caption, new RegExp(`start=i_${voice.code}`));
  assert.match(card.payload.caption, /Ovozli xabar profilingizga qo'shildi/);
  const data = buttons(card).map((b) => b.callback_data);
  for (const d of [`cs:${voice.id}:yurak`, `cs:${voice.id}:doira`, `cs:${voice.id}:kvadrat`, `cw:${voice.id}`, `cb:${voice.id}`, `cf:${voice.id}`, `del:${voice.id}`]) {
    assert.ok(data.includes(d), `${d} tugmasi bo'lishi kerak`);
  }
});

test('dumaloq video uchun ham QR karta, foni — o\'z kadri', async () => {
  downloaded.length = 0;
  const cs = await send(alice, { video_note: { file_id: 'VN1', file_unique_id: 'vn1', length: 240, duration: 3, thumbnail: { file_id: 'VN1-T', file_unique_id: 'vt', width: 240, height: 240 } } });
  assert.ok(sent(cs, 'sendPhoto')[0]);
  assert.match(sent(cs, 'sendPhoto')[0].payload.caption, /Dumaloq video/);
  assert.deepStrictEqual(downloaded, ['VN1-T']);
});

test('albom yuborilganda bitta javob', async () => {
  calls = [];
  await bot.handleUpdate(message(alice, { ...photo('P2'), media_group_id: 'G1' }));
  await bot.handleUpdate(message(alice, { ...photo('P3'), media_group_id: 'G1' }));
  assert.strictEqual(calls.length, 0, 'darhol javob bermasligi kerak');
  await tick(1700);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].payload.text, /2 ta fayl/);
});

test("havolalar, telefon va matn qo'shish", async () => {
  let cs = await text(alice, 'Instagram https://instagram.com/alisa', [{ type: 'url', offset: 10, length: 27 }]);
  assert.match(texts(cs), /Havola qo'shildi:\n📸 Instagram/);
  await text(alice, '+998901234567', [{ type: 'phone_number', offset: 0, length: 13 }]);
  cs = await text(alice, 'Salom, men fotografman!');
  assert.match(texts(cs), /qo'shaymi/);
  cs = await press(alice, 'addtext');
  assert.match(texts(cs), /Matn profilingizga qo'shildi/);
  const links = store.listItems(alice.id).filter((i) => i.type === 'link');
  assert.deepStrictEqual(links.map((l) => l.url), ['https://instagram.com/alisa', 'tel:+998901234567']);
});

test("shaxsiy guruh: ochiq guruh va profilsiz odam rad etiladi", async () => {
  let cs = await botAdded(alice, { ...GROUP, id: -100777, username: 'ochiq_guruh' });
  assert.strictEqual(sent(cs, 'leaveChat').length, 1);
  assert.match(texts(cs), /ochiq \(public\)/);
  assert.strictEqual(store.getUser(alice.id).group_id, null);

  cs = await botAdded(bob, { ...GROUP, id: -100888 });
  assert.strictEqual(sent(cs, 'leaveChat').length, 1);
});

test("shaxsiy guruh ulanadi va eski elementlar guruhga ko'chiriladi", async () => {
  const before = store.listItems(alice.id).length;
  const cs = await botAdded(alice, GROUP);
  assert.strictEqual(store.getUser(alice.id).group_id, GROUP.id);
  assert.match(texts(cs), /Shaxsiy ombor ulandi/);
  assert.match(texts(cs), /guruhi ulandi/);
  await tick(100);
  const toGroup = calls.filter((c) => c.payload.chat_id === GROUP.id && c.method !== 'getChatMemberCount');
  assert.ok(toGroup.length >= before, `kamida ${before} ta xabar guruhga borishi kerak`);
  assert.ok(store.listItems(alice.id).every((i) => i.group_msg_id), "hamma element guruhda bo'lishi kerak");
});

test("guruh ulangach: yangi element guruhga nusxalanadi, o'chirilsa guruhdan ham o'chadi", async () => {
  let cs = await send(alice, photo('P4'));
  const copy = sent(cs, 'copyMessage')[0];
  assert.ok(copy);
  assert.strictEqual(copy.payload.chat_id, GROUP.id);
  assert.match(texts(cs), /shaxsiy guruhingizga saqlandi/);
  const item = store.listItems(alice.id).at(-1);
  assert.ok(item.group_msg_id);

  cs = await press(alice, `del:${item.id}`);
  const del = sent(cs, 'deleteMessage').find((c) => c.payload.chat_id === GROUP.id);
  assert.strictEqual(del.payload.message_id, item.group_msg_id);
});

test("egasi guruhga ovozli xabar yuborsa, profilga qo'shiladi va QR karta guruhga keladi", async () => {
  const n = store.countItems(alice.id);
  let cs = await send(alice, { voice: { file_id: 'GV1', file_unique_id: 'gv1', duration: 2 } }, GROUP);
  assert.strictEqual(store.countItems(alice.id), n + 1);
  const card = sent(cs, 'sendPhoto')[0];
  assert.strictEqual(card.payload.chat_id, GROUP.id);
  assert.ok(card.payload.reply_parameters);
  assert.strictEqual(sent(cs, 'copyMessage').length, 0, 'guruhdagi xabar qayta nusxalanmaydi');

  cs = await send(alice, photo('GP1'), GROUP);
  assert.strictEqual(sent(cs, 'setMessageReaction').length, 1);

  // Begona odamning xabari e'tiborsiz qoladi
  cs = await send(bob, photo('BOB'), GROUP);
  assert.strictEqual(cs.length, 0);
  assert.strictEqual(store.countItems(alice.id), n + 2);
});

test('profil QR kartasi: uslub, tilak, fon va chop etish', async () => {
  let cs = await text(alice, BTN.qr);
  const card = sent(cs, 'sendPhoto')[0];
  assert.match(card.payload.caption, new RegExp(`https://t\\.me/birqr_test_bot\\?start=${aliceCode}`));
  assert.ok(buttons(card).some((b) => b.text === '✅ Yurak'));

  cs = await press(alice, 'cs:p:doira', { photo: [{ file_id: 'x', file_unique_id: 'x', width: 1, height: 1 }], caption: '🔳 Profilingiz QR kartasi' });
  assert.strictEqual(sent(cs, 'editMessageMedia').length, 1);
  assert.strictEqual(store.getUser(alice.id).qr_style, 'doira');
  assert.ok(buttons(sent(cs, 'editMessageMedia')[0]).some((b) => b.text === '✅ Doira'));

  await press(alice, 'cw:p');
  assert.strictEqual(store.getUser(alice.id).state, 'await_wish');
  cs = await text(alice, "Onajonim, tug'ilgan kuningiz bilan! ❤️");
  assert.strictEqual(store.getUser(alice.id).qr_wish, "Onajonim, tug'ilgan kuningiz bilan! ❤️");
  assert.match(sent(cs, 'sendPhoto')[0].payload.caption, /Tilak yozildi/);

  await press(alice, 'cb:p');
  cs = await send(alice, photo('BG1'));
  assert.strictEqual(store.getUser(alice.id).qr_bg, 'BG1');
  assert.match(sent(cs, 'sendPhoto')[0].payload.caption, /Fon yangilandi/);

  cs = await press(alice, 'cf:p');
  const doc = sent(cs, 'sendDocument')[0];
  assert.ok(doc);
});

test("sovg'a: element QR kodi skanerlansa, o'sha xabar ochiladi", async () => {
  const voice = store.listItems(alice.id).find((i) => i.type === 'voice');
  await press(alice, `cw:${voice.id}`);
  await text(alice, 'Bayramingiz muborak!');

  const cs = await text(bob, `/start i_${voice.code}`);
  assert.match(texts(cs), /Alisa Karimova<\/b> sizga ovozli xabar qoldirdi/);
  assert.match(texts(cs), /Bayramingiz muborak!/);
  assert.strictEqual(sent(cs, 'sendVoice')[0].payload.voice, 'V1');
  const data = buttons(cs.at(-1)).map((b) => b.callback_data);
  assert.ok(data.includes(`vp:${aliceCode}`));
  assert.ok(data.includes('new'));
  assert.strictEqual(store.getItem(alice.id, voice.id).views, 1);
});

test("profil QR kodi skanerlansa, butun profil ko'rinadi", async () => {
  const cs = await text(bob, `/start ${aliceCode}`);
  const header = sent(cs, 'sendMessage')[0];
  assert.match(header.payload.text, /<b>Alisa Karimova<\/b>/);
  assert.match(header.payload.text, /📞 \+998901234567/);
  assert.deepStrictEqual(buttons(header).map((b) => b.url), ['https://instagram.com/alisa']);
  assert.ok(sent(cs, 'sendMediaGroup').length >= 1);
  assert.strictEqual(store.getUser(alice.id).views, 1);
});

test("elementlar ro'yxatida har biri uchun QR tugmasi bor", async () => {
  const cs = await text(alice, BTN.items);
  const items = store.listItems(alice.id);
  assert.ok(buttons(cs[0]).some((b) => b.callback_data === `qi:${items[0].id}`));
  const cs2 = await press(alice, `qi:${items[0].id}`);
  assert.match(sent(cs2, 'sendPhoto')[0].payload.caption, /Rasm QR kartasi/);
});

test('guruhga yozib bo\'lmasa (bot chiqarilgan), guruh uziladi', async () => {
  failures.set('copyMessage', 'Forbidden: bot was kicked from the supergroup chat');
  const cs = await send(alice, photo('P5'));
  assert.strictEqual(store.getUser(alice.id).group_id, null);
  assert.match(texts(cs), /guruhingizga yozib bo'lmadi/);
});

test("bot guruhdan chiqarilsa, egasiga xabar beriladi", async () => {
  await botAdded(alice, GROUP);
  assert.strictEqual(store.getUser(alice.id).group_id, GROUP.id);
  await tick(100);
  const cs = await botAdded(alice, GROUP, 'left', 'administrator');
  assert.strictEqual(store.getUser(alice.id).group_id, null);
  assert.match(texts(cs), /guruhidan chiqarildim/);
});

test("profilni o'chirish: QR kodlar endi ishlamaydi", async () => {
  const voice = store.listItems(alice.id).find((i) => i.type === 'voice');
  await press(alice, 'set:delete');
  await press(alice, 'set:delete_yes');
  assert.strictEqual(store.getUser(alice.id), undefined);
  let cs = await text(bob, `/start ${aliceCode}`);
  assert.match(texts(cs), /topilmadi/);
  cs = await text(bob, `/start i_${voice.code}`);
  assert.match(texts(cs), /topilmadi/);
});
