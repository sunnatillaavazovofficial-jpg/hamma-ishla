// Botni Telegramga ulanmasdan sinash: so'rovlar ushlab olinadi, javoblar soxta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'birqr-test-'));

const { createBot, BTN } = require('../src/bot');
const store = require('../src/db');

const BOT_INFO = {
  id: 999, is_bot: true, first_name: 'BirQR', username: 'birqr_test_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
};
const bot = createBot('999:TEST', { botInfo: BOT_INFO });

let calls = [];
let seq = 1000;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  const chat = { id: payload.chat_id, type: 'private' };
  if (method === 'sendMediaGroup') {
    return { ok: true, result: payload.media.map(() => ({ message_id: ++seq, date: 0, chat })) };
  }
  if (method.startsWith('send') || method.startsWith('edit')) {
    return { ok: true, result: { message_id: ++seq, date: 0, chat, text: payload.text || '' } };
  }
  return { ok: true, result: true };
});

const alice = { id: 111, is_bot: false, first_name: 'Alisa', last_name: 'Karimova' };
const bob = { id: 222, is_bot: false, first_name: 'Bobur' };

function message(from, fields) {
  seq += 1;
  return {
    update_id: seq,
    message: { message_id: seq, date: 0, chat: { id: from.id, type: 'private' }, from, ...fields },
  };
}

async function send(from, fields) {
  calls = [];
  await bot.handleUpdate(message(from, fields));
  return calls;
}

function text(from, t, entities) {
  if (!entities && t.startsWith('/')) {
    entities = [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }];
  }
  return send(from, { text: t, entities });
}

async function press(from, data) {
  calls = [];
  seq += 1;
  await bot.handleUpdate({
    update_id: seq,
    callback_query: {
      id: String(seq), from, chat_instance: 'ci', data,
      message: { message_id: 1, date: 0, chat: { id: from.id, type: 'private' }, from: BOT_INFO, text: '…' },
    },
  });
  return calls;
}

const sent = (cs, method) => cs.filter((c) => c.method === method);
const texts = (cs) => cs.filter((c) => c.payload.text || c.payload.caption).map((c) => c.payload.text || c.payload.caption).join('\n---\n');
const photo = (id) => ({ photo: [{ file_id: `${id}-small`, file_unique_id: 's', width: 90, height: 90 }, { file_id: id, file_unique_id: id, width: 800, height: 800 }] });

let aliceCode;

test('profil ochish: ism va tavsif', async () => {
  let cs = await text(alice, '/start');
  assert.match(texts(cs), /BirQR/);
  assert.match(texts(cs), /qanday ism/);
  assert.deepStrictEqual(cs[0].payload.reply_markup.keyboard[0][0].text, 'Alisa Karimova');

  cs = await text(alice, 'Alisa Karimova');
  assert.match(texts(cs), /o'zingiz haqingizda/);

  cs = await text(alice, 'Fotograf. Toshkent.');
  assert.match(texts(cs), /Profilingiz tayyor/);

  const me = store.getUser(alice.id);
  assert.strictEqual(me.name, 'Alisa Karimova');
  assert.strictEqual(me.bio, 'Fotograf. Toshkent.');
  assert.strictEqual(me.state, null);
  aliceCode = me.code;
});

test("rasm, video, audio, ovozli xabar qo'shish", async () => {
  let cs = await send(alice, { ...photo('P1'), caption: 'Mening ishim' });
  assert.match(texts(cs), /qo'shildi: 🖼 Rasm — Mening ishim/);
  assert.match(cs[0].payload.reply_markup.inline_keyboard[0][0].callback_data, /^del:\d+$/);

  await send(alice, { audio: { file_id: 'A1', file_unique_id: 'a1', duration: 3 }, caption: 'Qo\'shiq' });
  await send(alice, { voice: { file_id: 'V1', file_unique_id: 'v1', duration: 3 } });
  cs = await send(alice, { video: { file_id: 'VID1', file_unique_id: 'vid1', width: 1, height: 1, duration: 3 } });
  assert.match(texts(cs), /🎬 Video/);

  const types = store.listItems(alice.id).map((i) => i.type);
  assert.deepStrictEqual(types, ['photo', 'audio', 'voice', 'video']);
});

test('albom yuborilganda bitta javob', async () => {
  calls = [];
  await bot.handleUpdate(message(alice, { ...photo('P2'), media_group_id: 'G1' }));
  await bot.handleUpdate(message(alice, { ...photo('P3'), media_group_id: 'G1' }));
  assert.strictEqual(calls.length, 0, 'darhol javob bermasligi kerak');
  await new Promise((r) => setTimeout(r, 1700));
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].payload.text, /2 ta fayl/);
});

test("havolalar, telefon va matn qo'shish", async () => {
  const t = 'Instagram https://instagram.com/alisa';
  let cs = await text(alice, t, [{ type: 'url', offset: 10, length: 27 }]);
  assert.match(texts(cs), /Havola qo'shildi:\n📸 Instagram/);

  cs = await text(alice, 't.me/alisa_photo', [{ type: 'url', offset: 0, length: 16 }]);
  assert.match(texts(cs), /✈️ Telegram/);

  cs = await text(alice, '+998901234567', [{ type: 'phone_number', offset: 0, length: 13 }]);
  assert.match(texts(cs), /Havola qo'shildi/);

  cs = await text(alice, 'Salom, men fotografman!');
  assert.match(texts(cs), /qo'shaymi/);
  cs = await press(alice, 'addtext');
  assert.match(texts(cs), /Matn profilingizga qo'shildi/);

  const items = store.listItems(alice.id);
  const links = items.filter((i) => i.type === 'link');
  assert.deepStrictEqual(links.map((l) => l.url), ['https://instagram.com/alisa', 'https://t.me/alisa_photo', 'tel:+998901234567']);
  assert.strictEqual(items.at(-1).type, 'text');
});

test('QR kod beriladi', async () => {
  const cs = await text(alice, BTN.qr);
  const p = sent(cs, 'sendPhoto')[0];
  assert.ok(p, 'QR rasm yuborilishi kerak');
  assert.match(p.payload.caption, new RegExp(`https://t\\.me/birqr_test_bot\\?start=${aliceCode}`));
  const cs2 = await press(alice, 'qrfile');
  assert.strictEqual(sent(cs2, 'sendDocument').length, 1);
});

test("QR skanerlangan: boshqa odam profilni ko'radi", async () => {
  const cs = await text(bob, `/start ${aliceCode}`);
  const header = sent(cs, 'sendMessage')[0];
  assert.match(header.payload.text, /<b>Alisa Karimova<\/b>/);
  assert.match(header.payload.text, /Fotograf/);
  assert.match(header.payload.text, /📞 \+998901234567/);
  const buttons = header.payload.reply_markup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map((b) => b.url), ['https://instagram.com/alisa', 'https://t.me/alisa_photo']);

  // rasm, audio, ovoz; keyin video + albomdagi 2 rasm bitta albom bo'lib; oxirida matn
  const methods = cs.map((c) => c.method);
  assert.deepStrictEqual(methods.slice(1, -1), ['sendPhoto', 'sendAudio', 'sendVoice', 'sendMediaGroup', 'sendMessage']);
  const group = sent(cs, 'sendMediaGroup')[0];
  assert.deepStrictEqual(group.payload.media.map((m) => m.type), ['video', 'photo', 'photo']);
  // Bobning profili yo'q — unga "Men ham profil ochaman" tugmasi taklif qilinadi
  assert.strictEqual(cs.at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data, 'new');
  assert.strictEqual(store.getUser(alice.id).views, 1);
});

test("egasi o'z profilini ko'rsa ko'rishlar oshmaydi", async () => {
  const cs = await text(alice, BTN.profile);
  assert.match(texts(cs), /shunday ko'rinadi/);
  assert.strictEqual(store.getUser(alice.id).views, 1);
});

test("elementlar ro'yxati: surish va o'chirish", async () => {
  let cs = await text(alice, BTN.items);
  assert.match(texts(cs), /Elementlaringiz<\/b> \(10 \/ 50\)/);
  const items = store.listItems(alice.id);
  cs = await press(alice, `up:${items[1].id}:0`);
  assert.strictEqual(store.listItems(alice.id)[0].id, items[1].id);
  cs = await press(alice, `rm:${items[0].id}:0`);
  assert.strictEqual(store.listItems(alice.id).length, 9);
  assert.strictEqual(sent(cs, 'editMessageText').length, 1);
  cs = await press(alice, 'list:1');
  assert.match(texts(cs), /9\./);
});

test('sozlamalar: ismni almashtirish va profil rasmi', async () => {
  await press(alice, 'set:name');
  let cs = await text(alice, 'Alisa K.');
  assert.match(texts(cs), /Ism yangilandi/);
  assert.strictEqual(store.getUser(alice.id).name, 'Alisa K.');

  await press(alice, 'set:avatar');
  cs = await send(alice, photo('AVATAR'));
  assert.match(texts(cs), /Profil rasmi o'rnatildi/);
  assert.strictEqual(store.getUser(alice.id).avatar, 'AVATAR');

  cs = await text(bob, `/start ${aliceCode}`);
  assert.strictEqual(cs[0].method, 'sendPhoto');
  assert.strictEqual(cs[0].payload.photo, 'AVATAR');
  assert.match(cs[0].payload.caption, /Alisa K\./);
});

test('profilsiz odam fayl yuborsa, profil ochish taklif qilinadi', async () => {
  const cs = await send(bob, photo('X'));
  assert.match(texts(cs), /Avval profil/);
  assert.strictEqual(store.getUser(bob.id).state, 'await_name');
});

test("profilni o'chirish: QR endi ishlamaydi", async () => {
  await press(alice, 'set:delete');
  await press(alice, 'set:delete_yes');
  assert.strictEqual(store.getUser(alice.id), undefined);
  const cs = await text(bob, `/start ${aliceCode}`);
  assert.match(texts(cs), /topilmadi/);
});
