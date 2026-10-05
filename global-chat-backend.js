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
 *   });
 *
 * Endpoint:
 *   GET  /api/chat/global?after=<id>   -> { messages: [...] }  (after=0 -> 50 pesan terakhir)
 *   POST /api/chat/global {text}       -> { message }
 *
 * Pesan disimpan di file JSON (global-chat.json), maksimal 200 pesan terakhir.
 */
const fs = require('fs');
const path = require('path');

// Kata kasar yang dicek (huruf kecil, tanpa simbol). Cocok walau ditulis miring/disambung
// angka (mis. "anj1ng", "k0ntol") karena dibandingkan setelah dinormalkan.
const BAD_WORDS = [
  'anjing', 'anjg', 'anj', 'bangsat', 'bgsat', 'kontol', 'kntl', 'memek', 'ngentot',
  'ngewe', 'kimak', 'jancok', 'jancuk', 'goblok', 'tolol', 'tolol', 'babi', 'bego',
  'bajingan', 'keparat', 'brengsek', 'asu', 'jembut', 'pepek', 'pukimak', 'kampret',
  'setan', 'laknat', 'sundal', 'lonte', 'pelacur',
];
const MUTE_MS = 2 * 60 * 1000; // 1-2 menit, dibulatkan ke 2 menit
function normalizeForFilter(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
}
function hasBadWord(text) {
  const norm = normalizeForFilter(text);
  return BAD_WORDS.some(w => norm.includes(w));
}

function registerGlobalChat(app, opts) {
  const authUser = opts.authUser;
  const file = opts.file || path.join(process.env.DATA_DIR || __dirname, 'global-chat.json');
  const mw = opts.middleware ? [opts.middleware] : [];
  const MAX_KEEP = 200, MAX_LEN = 300, COOLDOWN_MS = 1500;
  let msgs = [], nextId = 1;
  try {
    msgs = JSON.parse(fs.readFileSync(file, 'utf8'));
    nextId = (msgs.length ? msgs[msgs.length - 1].id : 0) + 1;
  } catch (e) {}
  const lastSend = new Map();
  const mutedUntil = new Map(); // user_id -> timestamp selesai mute
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(file, JSON.stringify(msgs), () => {}), 500);
  };

  app.get('/api/chat/global', ...mw, (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: 'Masuk dulu.' });
    const after = parseInt(req.query.after, 10) || 0;
    const out = after > 0 ? msgs.filter(m => m.id > after) : msgs.slice(-50);
    res.json({ messages: out });
  });

  app.post('/api/chat/global', ...mw, (req, res) => {
    const u = authUser(req);
    if (!u) return res.status(401).json({ error: 'Masuk dulu.' });
    const text = String((req.body && req.body.text) || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!text) return res.status(400).json({ error: 'Pesan kosong.' });
    const now = Date.now();
    const muteEnds = mutedUntil.get(u.id) || 0;
    if (now < muteEnds) {
      const sisa = Math.ceil((muteEnds - now) / 1000);
      return res.status(403).json({ error: `Kamu di-mute karena kata kasar. Coba lagi dalam ${sisa} detik.` });
    }
    if (hasBadWord(text)) {
      mutedUntil.set(u.id, now + MUTE_MS);
      return res.status(403).json({ error: 'Pesan mengandung kata kasar. Kamu di-mute 2 menit dari Global Chat.' });
    }
    if (now - (lastSend.get(u.id) || 0) < COOLDOWN_MS) return res.status(429).json({ error: 'Pelan-pelan, jangan spam.' });
    lastSend.set(u.id, now);
    const message = { id: nextId++, user_id: u.id, name: u.name || 'User', plan: u.plan || 'free', badge: u.roleBadge || '', text, ts: now };
    msgs.push(message);
    if (msgs.length > MAX_KEEP) msgs = msgs.slice(-MAX_KEEP);
    save();
    res.json({ message });
  });
}

module.exports = { registerGlobalChat };
