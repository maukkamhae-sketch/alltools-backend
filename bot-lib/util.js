/**
 * Konstanta & fungsi kecil yang dipakai banyak modul bot.
 */
const path = require('path');

const ROOT = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'bot-sessions');
const MAX_SESSIONS = Number(process.env.BOT_MAX_SESSIONS) || 30;       // sender Personal aktif bersamaan
const AI_DAILY_CAP = Number(process.env.BOT_AI_DAILY_CAP) || 200;      // batas .ai per bot per hari
const MAX_GLOBAL_CHATS = Number(process.env.BOT_MAX_GLOBAL_CHATS) || 5; // grup per bot Global
const LINK_RE = /(https?:\/\/|www\.|chat\.whatsapp\.com\/)\S+/i;

const ALL_FEATURES = ['autoreply', 'welcome', 'catalog', 'broadcast', 'antilink', 'reminder', 'orderbot', 'faq', 'ai', 'downloader', 'sticker', 'pushkontak'];

const digits = j => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isExpired = meta => !meta.expiresAt || new Date(meta.expiresAt).getTime() <= Date.now();
const xmlEsc = t => String(t).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const rp = v => {
  const n = Number(String(v).replace(/[^\d]/g, ''));
  return n > 0 && /^[\d.,\s]*$|^rp/i.test(String(v).trim()) ? 'Rp ' + n.toLocaleString('id-ID') : String(v || '');
};

/* ---- baca isi pesan WhatsApp ---- */
function getText(m) {
  let x = m.message;
  if (!x) return '';
  x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.documentWithCaptionMessage?.message || x;
  return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || '';
}
function quotedText(m) {
  const x = m.message?.ephemeralMessage?.message || m.message;
  const q = x && x.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q) return '';
  return q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || '';
}

/* ---- parser & validasi ---- */
function parseDuration(s) {
  const m = /^(\d{1,4})(s|m|j|h|d)$/i.exec(String(s || ''));
  if (!m) return 0;
  const mult = { s: 1000, m: 60000, j: 3600000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  const ms = Number(m[1]) * mult;
  return ms >= 10000 && ms <= 30 * 86400000 ? ms : 0;
}

function isSafeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '[::1]') return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
  } catch (e) { return false; }
}

/* ---- pencocokan FAQ ---- */
function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}
function findFaq(faq, text) {
  const t = String(text).toLowerCase();
  const tw = new Set(tokens(text));
  let best = null, bestScore = 0;
  for (const f of faq) {
    if (t.includes(f.q.toLowerCase())) return f;
    const qw = tokens(f.q);
    if (!qw.length) continue;
    const hit = qw.filter(w => tw.has(w)).length / qw.length;
    if (hit > bestScore) { bestScore = hit; best = f; }
  }
  return bestScore >= 0.6 ? best : null;
}

/* ---- jeda antar pemakaian (anti-spam) ---- */
const isCooling = (ctx, key, ms) => Date.now() - (ctx.cool.get(key) || 0) < ms;
const markCool = (ctx, key) => ctx.cool.set(key, Date.now());

module.exports = {
  ROOT, MAX_SESSIONS, AI_DAILY_CAP, MAX_GLOBAL_CHATS, LINK_RE, ALL_FEATURES,
  digits, clip, today, sleep, isExpired, xmlEsc, rp,
  getText, quotedText, parseDuration, isSafeUrl, tokens, findFaq, isCooling, markCool,
};
