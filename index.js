const fs = require('node:fs');
const path = require('node:path');

// .env faylidan sozlamalarni o'qiymiz (BOT_TOKEN va boshqalar)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error(
    "❌ BOT_TOKEN topilmadi.\n" +
    "   1) Telegramda @BotFather ga /newbot yozib, bot yarating va token oling.\n" +
    "   2) .env.example faylidan nusxa olib .env deb nomlang va tokenni yozing.\n" +
    "   3) Qaytadan ishga tushiring: npm start",
  );
  process.exit(1);
}

const { createBot, COMMANDS, DESCRIPTION, SHORT_DESCRIPTION } = require('./src/bot');

const bot = createBot(token);

async function main() {
  await bot.init();
  // Bot menyusi va tavsifini o'rnatamiz (xato bo'lsa ham bot ishlayveradi)
  await Promise.allSettled([
    bot.api.setMyCommands(COMMANDS),
    bot.api.setMyDescription(DESCRIPTION),
    bot.api.setMyShortDescription(SHORT_DESCRIPTION),
  ]);

  const stop = () => bot.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await bot.start({
    drop_pending_updates: false,
    // my_chat_member — bot shaxsiy guruhga qo'shilgani/chiqarilganini bilish uchun
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    onStart: (me) => console.log(`✅ Bot ishga tushdi: https://t.me/${me.username}`),
  });
}

main().catch((err) => {
  console.error('❌ Botni ishga tushirib bo\'lmadi:', err.description || err.message);
  process.exit(1);
});
