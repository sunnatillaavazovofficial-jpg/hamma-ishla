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
    tg_id      INTEGER PRIMARY KEY,
    code       TEXT NOT NULL UNIQUE,      -- QR koddagi havola uchun
    name       TEXT,                      -- NULL bo'lsa profil hali ochilmagan
    bio        TEXT NOT NULL DEFAULT '',
    avatar     TEXT,                      -- Telegram file_id
    views      INTEGER NOT NULL DEFAULT 0,
    state      TEXT,                      -- suhbat bosqichi (ism kutilmoqda va h.k.)
    pending    TEXT,                      -- tasdiqlanmagan matn (JSON)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
    type       TEXT NOT NULL,             -- photo, video, audio, voice, link, text ...
    file_id    TEXT,
    caption    TEXT NOT NULL DEFAULT '',  -- izoh yoki havola nomi
    entities   TEXT,                      -- matn formatlash (JSON)
    url        TEXT,
    extra      TEXT,                      -- kontakt / joylashuv ma'lumoti (JSON)
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, position);
`);

const q = {
  getUser: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
  getByCode: db.prepare('SELECT * FROM users WHERE code = ?'),
  insertUser: db.prepare('INSERT INTO users (tg_id, code) VALUES (?, ?)'),
  setState: db.prepare('UPDATE users SET state = ?, pending = ? WHERE tg_id = ?'),
  setName: db.prepare('UPDATE users SET name = ? WHERE tg_id = ?'),
  setBio: db.prepare('UPDATE users SET bio = ? WHERE tg_id = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE tg_id = ?'),
  incViews: db.prepare('UPDATE users SET views = views + 1 WHERE tg_id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE tg_id = ?'),
  listItems: db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY position, id'),
  countItems: db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?'),
  maxPos: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM items WHERE user_id = ?'),
  getItem: db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?'),
  insertItem: db.prepare(`INSERT INTO items (user_id, type, file_id, caption, entities, url, extra, position)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?'),
  setPos: db.prepare('UPDATE items SET position = ? WHERE id = ?'),
};

function newCode() {
  // QR havolasi uchun qisqa tasodifiy kod (masalan "k7f2m9qa")
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (const b of bytes) code += abc[b % abc.length];
    if (!q.getByCode.get(code)) return code;
  }
}

function getUser(tgId) {
  return q.getUser.get(tgId);
}

function ensureUser(tgId) {
  let u = q.getUser.get(tgId);
  if (!u) {
    q.insertUser.run(tgId, newCode());
    u = q.getUser.get(tgId);
  }
  return u;
}

function getByCode(code) {
  return q.getByCode.get(String(code || '').toLowerCase());
}

function setState(tgId, state, pending = null) {
  q.setState.run(state, pending == null ? null : JSON.stringify(pending), tgId);
}

const setName = (tgId, name) => q.setName.run(name, tgId);
const setBio = (tgId, bio) => q.setBio.run(bio, tgId);
const setAvatar = (tgId, fileId) => q.setAvatar.run(fileId, tgId);
const incViews = (tgId) => q.incViews.run(tgId);
const deleteUser = (tgId) => q.deleteUser.run(tgId);

const listItems = (tgId) => q.listItems.all(tgId);
const countItems = (tgId) => q.countItems.get(tgId).n;
const getItem = (tgId, id) => q.getItem.get(id, tgId);

function addItem(tgId, item) {
  const pos = q.maxPos.get(tgId).p + 1;
  const r = q.insertItem.run(
    tgId,
    item.type,
    item.file_id ?? null,
    item.caption ?? '',
    item.entities && item.entities.length ? JSON.stringify(item.entities) : null,
    item.url ?? null,
    item.extra ? JSON.stringify(item.extra) : null,
    pos,
  );
  return Number(r.lastInsertRowid);
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
  db, getUser, ensureUser, getByCode, setState, setName, setBio, setAvatar,
  incViews, deleteUser, listItems, countItems, getItem, addItem, deleteItem, moveItem,
};
