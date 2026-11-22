const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'birqr.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    tg_id       INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,      -- QR koddagi havola uchun
    name        TEXT,                      -- NULL bo'lsa profil hali ochilmagan
    bio         TEXT NOT NULL DEFAULT '',
    avatar      TEXT,                      -- Telegram file_id
    views       INTEGER NOT NULL DEFAULT 0,
    state       TEXT,                      -- suhbat bosqichi (ism kutilmoqda va h.k.)
    pending     TEXT,                      -- bosqich uchun qo'shimcha ma'lumot (JSON)
    group_id    INTEGER,                   -- shaxsiy guruh (ma'lumotlar ombori)
    group_title TEXT,
    qr_style    TEXT NOT NULL DEFAULT 'yurak',
    qr_wish     TEXT NOT NULL DEFAULT '',
    qr_bg       TEXT,                      -- QR karta foni (rasm file_id)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
    code         TEXT,                     -- shu elementning o'z QR havolasi uchun
    type         TEXT NOT NULL,            -- photo, video, audio, voice, link, text ...
    file_id      TEXT,
    thumb        TEXT,                     -- video/dumaloq video kadri (file_id)
    caption      TEXT NOT NULL DEFAULT '', -- izoh yoki havola nomi
    entities     TEXT,                     -- matn formatlash (JSON)
    url          TEXT,
    extra        TEXT,                     -- kontakt / joylashuv ma'lumoti (JSON)
    group_msg_id INTEGER,                  -- shaxsiy guruhdagi nusxasi
    style        TEXT,                     -- QR karta sozlamalari (NULL = profilnikidek)
    wish         TEXT,
    bg           TEXT,
    views        INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, position);
`);

// Eski bazaga yangi ustunlarni qo'shamiz
function addMissingColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}
addMissingColumns('users', {
  group_id: 'INTEGER', group_title: 'TEXT', qr_style: "TEXT NOT NULL DEFAULT 'yurak'",
  qr_wish: "TEXT NOT NULL DEFAULT ''", qr_bg: 'TEXT',
});
addMissingColumns('items', {
  code: 'TEXT', thumb: 'TEXT', group_msg_id: 'INTEGER', style: 'TEXT', wish: 'TEXT', bg: 'TEXT',
  views: 'INTEGER NOT NULL DEFAULT 0',
});
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_items_code ON items(code);
  CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id);
`);

const ABC = 'abcdefghijkmnpqrstuvwxyz23456789';
function randomCode() {
  let code = '';
  for (const b of crypto.randomBytes(8)) code += ABC[b % ABC.length];
  return code;
}

const q = {
  getUser: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
  getByCode: db.prepare('SELECT * FROM users WHERE code = ?'),
  getByGroup: db.prepare('SELECT * FROM users WHERE group_id = ?'),
  insertUser: db.prepare('INSERT INTO users (tg_id, code) VALUES (?, ?)'),
  setState: db.prepare('UPDATE users SET state = ?, pending = ? WHERE tg_id = ?'),
  setName: db.prepare('UPDATE users SET name = ? WHERE tg_id = ?'),
  setBio: db.prepare('UPDATE users SET bio = ? WHERE tg_id = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE tg_id = ?'),
  setGroup: db.prepare('UPDATE users SET group_id = ?, group_title = ? WHERE tg_id = ?'),
  migrateGroup: db.prepare('UPDATE users SET group_id = ? WHERE group_id = ?'),
  incViews: db.prepare('UPDATE users SET views = views + 1 WHERE tg_id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE tg_id = ?'),
  listItems: db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY position, id'),
  countItems: db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?'),
  maxPos: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM items WHERE user_id = ?'),
  getItem: db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?'),
  getItemByCode: db.prepare('SELECT * FROM items WHERE code = ?'),
  insertItem: db.prepare(`INSERT INTO items (user_id, code, type, file_id, thumb, caption, entities, url, extra, group_msg_id, position)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?'),
  setPos: db.prepare('UPDATE items SET position = ? WHERE id = ?'),
  setGroupMsg: db.prepare('UPDATE items SET group_msg_id = ? WHERE id = ?'),
  clearGroupMsgs: db.prepare('UPDATE items SET group_msg_id = NULL WHERE user_id = ?'),
  incItemViews: db.prepare('UPDATE items SET views = views + 1 WHERE id = ?'),
  itemsWithoutCode: db.prepare('SELECT id FROM items WHERE code IS NULL'),
  setItemCode: db.prepare('UPDATE items SET code = ? WHERE id = ?'),
};

function newUserCode() {
  for (;;) {
    const code = randomCode();
    if (!q.getByCode.get(code)) return code;
  }
}

function newItemCode() {
  for (;;) {
    const code = randomCode();
    if (!q.getItemByCode.get(code)) return code;
  }
}

for (const { id } of q.itemsWithoutCode.all()) q.setItemCode.run(newItemCode(), id);

function getUser(tgId) {
  return q.getUser.get(tgId);
}

function ensureUser(tgId) {
  let u = q.getUser.get(tgId);
  if (!u) {
    q.insertUser.run(tgId, newUserCode());
    u = q.getUser.get(tgId);
  }
  return u;
}

const getByCode = (code) => q.getByCode.get(String(code || '').toLowerCase());
const getByGroup = (chatId) => q.getByGroup.get(chatId);

function setState(tgId, state, pending = null) {
  q.setState.run(state, pending == null ? null : JSON.stringify(pending), tgId);
}

const setName = (tgId, name) => q.setName.run(name, tgId);
const setBio = (tgId, bio) => q.setBio.run(bio, tgId);
const setAvatar = (tgId, fileId) => q.setAvatar.run(fileId, tgId);
const incViews = (tgId) => q.incViews.run(tgId);
const deleteUser = (tgId) => q.deleteUser.run(tgId);

// Guruh o'zgarsa, eski guruhdagi xabar raqamlari endi yaroqsiz — ularni tozalaymiz
function setGroup(tgId, chatId, title) {
  const prev = q.getUser.get(tgId)?.group_id ?? null;
  q.setGroup.run(chatId, title ?? null, tgId);
  if (prev !== chatId) q.clearGroupMsgs.run(tgId);
}
function migrateGroup(oldId, newId) {
  const owner = q.getByGroup.get(oldId);
  if (!owner) return;
  q.migrateGroup.run(newId, oldId);
  q.clearGroupMsgs.run(owner.tg_id);
}

// QR karta sozlamalari: fields = { style?, wish?, bg? }
const USER_CARD_COLS = { style: 'qr_style', wish: 'qr_wish', bg: 'qr_bg' };
function setUserCard(tgId, fields) {
  for (const [k, v] of Object.entries(fields)) {
    db.prepare(`UPDATE users SET ${USER_CARD_COLS[k]} = ? WHERE tg_id = ?`).run(v ?? (k === 'wish' ? '' : k === 'style' ? 'yurak' : null), tgId);
  }
}
function setItemCard(tgId, id, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (!['style', 'wish', 'bg'].includes(k)) continue;
    db.prepare(`UPDATE items SET ${k} = ? WHERE id = ? AND user_id = ?`).run(v ?? null, id, tgId);
  }
}

const listItems = (tgId) => q.listItems.all(tgId);
const countItems = (tgId) => q.countItems.get(tgId).n;
const getItem = (tgId, id) => q.getItem.get(id, tgId);
const getItemByCode = (code) => q.getItemByCode.get(String(code || '').toLowerCase());
const setGroupMsg = (id, msgId) => q.setGroupMsg.run(msgId, id);
const incItemViews = (id) => q.incItemViews.run(id);

function addItem(tgId, item) {
  const pos = q.maxPos.get(tgId).p + 1;
  const code = newItemCode();
  const r = q.insertItem.run(
    tgId,
    code,
    item.type,
    item.file_id ?? null,
    item.thumb ?? null,
    item.caption ?? '',
    item.entities && item.entities.length ? JSON.stringify(item.entities) : null,
    item.url ?? null,
    item.extra ? JSON.stringify(item.extra) : null,
    item.group_msg_id ?? null,
    pos,
  );
  return { id: Number(r.lastInsertRowid), code };
}

function deleteItem(tgId, id) {
  return q.deleteItem.run(id, tgId).changes > 0;
}

// Elementni bir pog'ona yuqoriga (dir = -1) yoki pastga (dir = 1) suradi
function moveItem(tgId, id, dir) {
  const items = listItems(tgId);
  const i = items.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return false;
  [items[i], items[j]] = [items[j], items[i]];
  db.exec('BEGIN');
  try {
    items.forEach((it, idx) => q.setPos.run(idx + 1, it.id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

module.exports = {
  db, getUser, ensureUser, getByCode, getByGroup, setState, setName, setBio, setAvatar,
  setGroup, migrateGroup, setUserCard, setItemCard, incViews, deleteUser,
  listItems, countItems, getItem, getItemByCode, setGroupMsg, incItemViews,
  addItem, deleteItem, moveItem,
};
