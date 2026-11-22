# BirQR — Telegram bot

Har kim botda **o'z profilini ochadi**, unga **rasm, video, audio, ovozli xabar, havola, matn** va boshqalarni joylaydi.
Bot esa unga **QR kod** beradi. Kim QR kodni skanerlasa, Telegramda o'sha odamning profili ochiladi va hammasini ko'radi.

## Qanday ishlaydi

1. Foydalanuvchi botga `/start` yozadi → ismi va o'zi haqida qisqacha yozadi → profil tayyor.
2. Botga istalgan narsani yuboradi — hammasi profiliga qo'shiladi:
   🖼 rasm · 🎬 video · 🎞 GIF · 🎵 audio · 🎙 ovozli xabar · ⭕️ dumaloq video · 📄 fayl · 🔗 havola · 📝 matn · 👤 kontakt · 📍 joylashuv
3. «🔳 QR kod» tugmasini bosadi → bot QR kod rasmini beradi (chop etish uchun 2048×2048 fayl ham bor).
4. Boshqa odam QR kodni telefon kamerasi bilan skanerlaydi → bot ochiladi va profilni ko'rsatadi:
   ism, tavsif, havolalar (tugma ko'rinishida), so'ng rasm/video/audiolar.

Qo'shimcha imkoniyatlar:

- 📋 **Elementlarim** — har bir elementni ko'rish, tartibini o'zgartirish (⬆️) va o'chirish (🗑)
- ⚙️ **Sozlamalar** — ism, tavsif, profil rasmini o'zgartirish, profilni o'chirish
- 👀 Profil necha marta ko'rilganini hisoblaydi
- Havoladan oldin nom yozilsa (`Mening do'konim https://...`), tugmada o'sha nom chiqadi
- Instagram, Telegram, YouTube, TikTok va boshqa saytlar avtomatik taniladi

Fayllar serverga yuklab olinmaydi — Telegram'ning o'zida saqlanadi, bot faqat ularning ID'sini eslab qoladi.
Shuning uchun katta videolar ham muammosiz ishlaydi va server joyi tejaladi.

## Ishga tushirish

### 1. Bot yaratish

Telegramda [@BotFather](https://t.me/BotFather) ga yozing → `/newbot` → bot nomi va username kiriting.
BotFather sizga **token** beradi (masalan `123456789:AAH...`).

### 2. Kompyuterda yoki serverda

[Node.js](https://nodejs.org) **22.13** yoki undan yangi versiyasi kerak.

```bash
npm install
```

```bash
cp .env.example .env
```

`.env` faylini oching va `BOT_TOKEN=` dan keyin tokeningizni yozing. So'ng:

```bash
npm start
```

Konsolda `✅ Bot ishga tushdi: https://t.me/...` chiqsa — tayyor. Botingizga kirib `/start` bosing.

### 3. Doimiy ishlashi uchun (server)

Bot 24/7 ishlashi uchun uni serverda (VPS, Railway, Render va h.k.) ishga tushiring.

**pm2 bilan:**

```bash
npm install -g pm2
```

```bash
pm2 start index.js --name birqr --node-args="--disable-warning=ExperimentalWarning"
```

**Docker bilan:**

```bash
docker build -t birqr .
```

```bash
docker run -d --name birqr --restart unless-stopped -e BOT_TOKEN=TOKENINGIZ -v birqr-data:/app/data birqr
```

> ⚠️ `data/` papkasida ma'lumotlar bazasi saqlanadi. Server qayta ishga tushganda o'chib ketmasligi kerak
> (Docker'da `-v` bilan volume ulang, Railway/Render'da "persistent disk/volume" qo'shing).

## Sozlamalar (`.env`)

| O'zgaruvchi | Tavsif | Standart |
|---|---|---|
| `BOT_TOKEN` | @BotFather bergan token | — (majburiy) |
| `DATA_DIR` | Ma'lumotlar bazasi papkasi | `./data` |
| `MAX_ITEMS` | Bitta profilga nechta element qo'shish mumkin | `50` |

## Tuzilishi

```
index.js        — ishga tushirish (token, bot menyusi)
src/bot.js      — botning barcha xabarlari va tugmalari
src/db.js       — SQLite ma'lumotlar bazasi (profillar va elementlar)
src/util.js     — havolalarni tekshirish, ikonkalar
test/           — botni Telegramsiz sinash: npm test
```
