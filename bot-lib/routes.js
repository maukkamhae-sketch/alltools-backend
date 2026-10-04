/**
 * Endpoint Express untuk bot sewaan.
 *
 * Pemilik bot (login):
 *   GET  /api/bots/:id/sender        status sender + config (Personal atau Global)
 *   POST /api/bots/:id/sender/pair   {phone} -> {code}   (Personal saja)
 *   POST /api/bots/:id/sender/stop   lepas sender        (Personal saja)
 *   PUT  /api/bots/:id/config        simpan pengaturan fitur
 * Owner aplikasi:
 *   GET  /api/admin/global-sender         status nomor pusat
 *   POST /api/admin/global-sender/pair    {phone} -> {code}
 *   POST /api/admin/global-sender/stop    lepas nomor pusat
 */
const fs = require('fs');
const path = require('path');
const { MAX_SESSIONS } = require('./util');
const { cleanConfig } = require('./config');
const { dirOf, getMeta, writeMeta } = require('./store');
const personal = require('./personal');
const global = require('./global');

function registerRoutes(app, { db, requireAuth, requireOwner }) {
  const mine = (req, res) => {
    const bot = db.getBotsForUser(req.user.id).find(b => b.id === req.params.id);
    if (!bot) { res.status(404).json({ error: 'Bot tidak ditemukan.' }); return null; }
    return bot;
  };
  const isGlobal = bot => bot.senderMode === 'global';
  const GLOBAL_MSG = 'Bot Sender Global memakai nomor pusat, jadi tidak perlu pasang atau lepas sender. Pakai .daftar <PIN> lalu .pasang di grup.';

  app.get('/api/bots/:id/sender', requireAuth, (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    const meta = getMeta(bot);
    res.json(isGlobal(bot) ? global.publicState(meta, bot) : personal.publicState(meta));
  });

  app.post('/api/bots/:id/sender/pair', requireAuth, async (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    if (isGlobal(bot)) return res.status(400).json({ error: GLOBAL_MSG });
    const meta = getMeta(bot);
    if (new Date(meta.expiresAt).getTime() <= Date.now()) return res.status(403).json({ error: 'Masa sewa bot sudah habis.' });
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (phone.length < 9 || phone.length > 15 || phone.startsWith('0')) return res.status(400).json({ error: 'Nomor harus format internasional tanpa 0 di depan, contoh 6281234567890.' });
    if (personal.phoneInUse(phone, bot.id) || phone === global.getState().phone) return res.status(400).json({ error: 'Nomor ini sudah dipakai bot lain.' });
    const cur = personal.runtimeOf ? personal.runtimeOf(bot.id) : null;
    if (cur && cur.status === 'connected') return res.status(400).json({ error: 'Sender sudah terhubung. Lepas dulu kalau mau ganti nomor.' });
    if (!cur && personal.activeCount() >= MAX_SESSIONS) return res.status(503).json({ error: 'Server sedang penuh, coba lagi nanti.' });
    try {
      fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true }); // mulai sesi bersih untuk pairing baru
      const ctx = await personal.start(meta, phone);
      res.json({ code: ctx.code });
    } catch (e) {
      personal.stop(bot.id, false);
      res.status(500).json({ error: e.message || 'Gagal meminta kode pairing.' });
    }
  });

  app.post('/api/bots/:id/sender/stop', requireAuth, (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    if (isGlobal(bot)) return res.status(400).json({ error: GLOBAL_MSG });
    const meta = getMeta(bot);
    personal.stop(bot.id, true);
    meta.phone = '';
    setTimeout(() => { fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true }); writeMeta(meta); }, 1500);
    res.json({ ok: true });
  });

  app.put('/api/bots/:id/config', requireAuth, (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    const meta = getMeta(bot);
    meta.config = cleanConfig(req.body && req.body.config, meta.config);
    writeMeta(meta);
    res.json({ ok: true, config: meta.config });
  });

  /* ---- nomor pusat (Owner) ---- */
  if (requireOwner) {
    app.get('/api/admin/global-sender', requireOwner, (req, res) => res.json(global.adminState()));

    app.post('/api/admin/global-sender/pair', requireOwner, async (req, res) => {
      const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
      if (phone.length < 9 || phone.length > 15 || phone.startsWith('0')) return res.status(400).json({ error: 'Nomor harus format internasional tanpa 0 di depan, contoh 6281234567890.' });
      if (personal.phoneInUse(phone, null)) return res.status(400).json({ error: 'Nomor ini sudah dipakai bot Personal.' });
      try {
        fs.rmSync(path.join(dirOf(global.GLOBAL_ID), 'auth'), { recursive: true, force: true });
        const ctx = await global.start(phone);
        res.json({ code: ctx.code });
      } catch (e) { res.status(500).json({ error: e.message || 'Gagal meminta kode pairing.' }); }
    });

    app.post('/api/admin/global-sender/stop', requireOwner, (req, res) => { global.stop(); res.json({ ok: true }); });
  }
}

module.exports = { registerRoutes };
