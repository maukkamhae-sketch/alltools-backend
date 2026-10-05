/**
 * Global Chat — modul backend (drop-in untuk server Express kamu)
 *
 * Cara pasang di file server utama:
 *
 *   const express = require('express');
 *   const { registerGlobalChat } = require('./global-chat-backend');
 *   ...
 *   registerGlobalChat(app, {
 *     middleware: requireAuth,        // cek token, mengisi req.user
 *     authUser: (req) => req.user,    // balikin {id, name, plan, roleBadge}
 *     // isExempt: (u) => u.roleBadge === 'ADMIN',   // opsional: kebal dari bot
 *   });
 *
 * Endpoint:
 *   GET  /api/chat/global?after=<id>   -> { messages: [...] }  (after=0 -> 50 pesan terakhir)
 *   POST /api/chat/global {text}       -> { message }
 *
 * Bot Keamanan:
 *   - Pesan kasar DIBLOKIR (tidak tampil di chat)
 *   - Pelanggaran ke-1 -> mute 1 menit, ke-2 dan seterusnya -> mute 3 menit
 *   - Hitungan pelanggaran di-reset kalau 30 menit tidak melanggar
 *   - Bot mengumumkan mute di Global Chat (name "Bot Keamanan", badge "BOT")
 *
 * Pesan disimpan di file JSON (global-chat.json), maksimal 200 pesan terakhir.
 */
const fs = require('fs');
const path = require('path');

// ---------- Bot Keamanan: daftar kata ----------
// Kata pendek (<5 huruf) hanya cocok kalau berdiri sendiri sebagai satu kata,
// supaya "kasur", "asumsi", "tanjung" tidak ikut kena.
const BAD_WORDS = [
  'anjing', 'anjg', 'anjink', 'bangsat', 'bgsat', 'kontol', 'kntl', 'memek', 'ngentot',
  'ngewe', 'kimak', 'jancok', 'jancuk', 'goblok', 'tolol', 'babi', 'bego',
  'bajingan', 'keparat', 'brengsek', 'asu', 'jembut', 'pepek', 'pukimak', 'kampret',
  'setan', 'laknat', 'sundal', 'lonte', 'pelacur', 'tai',
];
const LONG_MIN = 5;
const MUTE_STEPS_MS = [60 * 1000, 3 * 60 * 1000]; // 1 menit, lalu 3 menit
const STRIKE_RESET_MS = 30 * 60 * 1000;

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
const squash = (s) => s.replace(/(.)\1+/g, '$1'); // anjiiing -> anjing
const clean = (s) => squash(s.toLowerCase().replace(/[01345 7@$]/g, (c) => LEET[c] || '').replace(/[^a-z]/g, ''));

const BAD_N = BAD_WORDS.map(squash);
const BAD_SHORT = new Set(BAD_N.filter((w) => w.length < LONG_MIN));
const BAD_LONG = BAD_N.filter((w) => w.length >= LONG_MIN);

function hasBadWord(text) {
  // 1) per kata (cocok persis untuk kata pendek, atau mengandung kata panjang)
  const tokens = text.toLowerCase().split(/[^a-z0-9@$]+/).filter(Boolean).map(clean);
  for (const t of tokens) {
    if (BAD_SHORT.has(t)) return true;
    if (BAD_LONG.some((w) => t.includes(w))) return true;
  }
  // 2) digabung (menangkap k.o.n.t.o.l / a n j i n g), hanya kata panjang
  const joined = clean(text);
  return BAD_LONG.some((w) => joined.includes(w));
}

function registerGlobalChat(app, opts) {
  const authUser = opts.authUser;
  const isExempt = opts.isExempt || (() => false);
  const file = opts.file || path.join(process.env.DATA_DIR || __dirname, 'global-chat.json');
  const mw = opts.middleware ? [opts.middleware] : [];
  const MAX_KEEP = 200, MAX_LEN = 300, COOLDOWN_MS = 1500;
  let msgs = [], nextId = 1;
  try {
    msgs = JSON.parse(fs.readFileSync(file, 'utf8'));
    nextId = (msgs.length ? msgs[msgs.length - 1].id : 0) + 1;
  } catch (e) {}
  const lastSend = new Map();
  const mutes = new Map(); // user_id -> { until, strikes, last }
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(file, JSON.stringify(msgs), () => {}), 500);
  };
  const pushMsg = (m) => {
    const message = { id: nextId++, ts: Date.now(), ...m };
    msgs.push(message);
    if (msgs.length > MAX_KEEP) msgs = msgs.slice(-MAX_KEEP);
    save();
    return message;
  };
  const fmtDur = (ms) => (ms / 60000) + ' menit';

  app.get('/api/chat/global', ...mw, (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: 'Masuk dulu.' });
    const after = parseInt(req.query.after, 10) || 0;
    const out = after > 0 ? msgs.filter((m) => m.id > after) : msgs.slice(-50);
    res.json({ messages: out });
  });

  app.post('/api/chat/global', ...mw, (req, res) => {
    const u = authUser(req);
    if (!u) return res.status(401).json({ error: 'Masuk dulu.' });
    const text = String((req.body && req.body.text) || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!text) return res.status(400).json({ error: 'Pesan kosong.' });
    const now = Date.now();

    // Masih di-mute?
    const st = mutes.get(u.id);
    if (st && now < st.until) {
      const sisa = Math.ceil((st.until - now) / 1000);
      return res.status(403).json({ error: `🔇 Kamu di-mute Bot Keamanan. Coba lagi dalam ${sisa} detik.` });
    }

    // Cek kata kasar
    if (!isExempt(u) && hasBadWord(text)) {
      const prev = st && now - st.last < STRIKE_RESET_MS ? st.strikes : 0;
      const dur = MUTE_STEPS_MS[Math.min(prev, MUTE_STEPS_MS.length - 1)];
      mutes.set(u.id, { until: now + dur, strikes: prev + 1, last: now });
      pushMsg({
        user_id: 'bot-keamanan', name: 'Bot Keamanan', plan: 'free', badge: 'BOT',
        text: `🤖 ${u.name || 'User'} di-mute ${fmtDur(dur)} karena bahasa kasar. Mari jaga Global Chat tetap nyaman.`,
      });
      return res.status(403).json({ error: `🤖 Bot Keamanan: bahasa kasar tidak diizinkan. Kamu di-mute ${fmtDur(dur)}.` });
    }

    if (now - (lastSend.get(u.id) || 0) < COOLDOWN_MS) return res.status(429).json({ error: 'Pelan-pelan, jangan spam.' });
    lastSend.set(u.id, now);
    const message = pushMsg({ user_id: u.id, name: u.name || 'User', plan: u.plan || 'free', badge: u.roleBadge || '', text });
    res.json({ message });
  });
}

module.exports = { registerGlobalChat };
