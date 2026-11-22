// Havola nomlari va ikonkalari
const SITES = {
  'instagram.com': ['Instagram', '📸'],
  't.me': ['Telegram', '✈️'],
  'telegram.me': ['Telegram', '✈️'],
  'youtube.com': ['YouTube', '▶️'],
  'youtu.be': ['YouTube', '▶️'],
  'tiktok.com': ['TikTok', '🎵'],
  'facebook.com': ['Facebook', '📘'],
  'fb.com': ['Facebook', '📘'],
  'x.com': ['X (Twitter)', '✖️'],
  'twitter.com': ['X (Twitter)', '✖️'],
  'linkedin.com': ['LinkedIn', '💼'],
  'github.com': ['GitHub', '💻'],
  'wa.me': ['WhatsApp', '💬'],
  'api.whatsapp.com': ['WhatsApp', '💬'],
  'spotify.com': ['Spotify', '🎧'],
  'open.spotify.com': ['Spotify', '🎧'],
};

const TYPE_INFO = {
  photo:      ['🖼', 'Rasm'],
  video:      ['🎬', 'Video'],
  animation:  ['🎞', 'GIF'],
  audio:      ['🎵', 'Audio'],
  voice:      ['🎙', 'Ovozli xabar'],
  video_note: ['⭕️', 'Dumaloq video'],
  document:   ['📄', 'Fayl'],
  link:       ['🔗', 'Havola'],
  text:       ['📝', 'Matn'],
  contact:    ['👤', 'Kontakt'],
  location:   ['📍', 'Joylashuv'],
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// "instagram.com/men" -> "https://instagram.com/men"; noto'g'ri bo'lsa null
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!/\.[a-z0-9-]{2,}$/i.test(u.hostname)) return null;
  return u.toString();
}

function siteOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, '');
    return SITES[host] || null;
  } catch { return null; }
}

function linkLabel(url) {
  const site = siteOf(url);
  if (site) return site[0];
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function linkIcon(url) {
  const site = siteOf(url);
  return site ? site[1] : '🌐';
}

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function itemLabel(item) {
  const [icon, name] = TYPE_INFO[item.type] || ['•', item.type];
  let extra = item.caption;
  if (item.type === 'link' && !extra) extra = item.url;
  if (item.type === 'contact' && item.extra) {
    const c = JSON.parse(item.extra);
    extra = [c.first_name, c.last_name].filter(Boolean).join(' ');
  }
  return extra ? `${icon} ${name} — ${clip(extra, 28)}` : `${icon} ${name}`;
}

module.exports = { TYPE_INFO, escapeHtml, normalizeUrl, linkLabel, linkIcon, clip, itemLabel };
