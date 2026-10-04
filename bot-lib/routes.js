/**
 * Endpoint Express untuk bot sewaan.
 *
 * Pemilik bot (login):
 *   GET  /api/bots/:id/sender        status sender + config (Personal atau Global)
 *   GET  /api/bots/servers           daftar Server 1-3 + status (active/full/offline)
 *   POST /api/bots/:id/sender/pair   {phone, server:'auto'|1|2|3} -> {code}   (Personal saja)
 *   POST /api/bots/:id/sender/stop   lepas sender        (Personal saja)
 *   PUT  /api/bots/:id/config        simpan pengaturan fitur
 * Owner aplikasi:
 *   GET  /api/admin/global-sender         status nomor pusat
 *   POST /api/admin/global-sender/pair    {phone} -> {code}
 *   POST /api/admin/global-sender/stop    lepas nomor pusat
 */
const fs = require('fs');
const path = require('path');
const { MAX_SESSIONS, isExpired } = require('./util');
const { cleanConfig } = require('./config');
const { dirOf, getMeta, writeMeta, allMetas } = require('./store');
const personal = require('./personal');
const global = require('./global');
const worker = require('./worker');

function registerRoutes(app, { db, requireAuth, requireOwner }) {
  const mine = (req, res) => {
    const bot = db.getBotsForUser(req.user.id).find(b => b.id === req.params.id);
    if (!bot) { res.status(404).json({ error: 'Bot tidak ditemukan.' }); return null; }
    return bot;
  };
  const isGlobal = bot => bot.senderMode === 'global';
  const GLOBAL_MSG = 'Bot Sender Global memakai nomor pusat, jadi tidak perlu pasang atau lepas sender. Pakai .daftar <PIN> lalu .pasang di grup.';

  /* Server 1-3 (kalau WORKER_URLS diisi): daftar + status active / full / offline untuk layar pasang sender. */
  app.get('/api/bots/servers', requireAuth, async (req, res) => {
    try { res.json({ servers: await worker.serverList() }); } catch (e) { res.json({ servers: [] }); }
  });

  /* Status sender yang dipasang di server sender (1-3). Kalau servernya mati, balas status server_offline. */
  async function remoteState(bot, meta) {
    const n = meta.server;
    try {
      const s = await worker.callWorker(n, 'POST', '/w/state', { bot: worker.snap(bot) });
      if (s.config) meta.config = s.config;
      if (s.status === 'connected' && s.phone && meta.phone !== s.phone) { meta.phone = s.phone; writeMeta(meta); }
      return { ...s, server: n };
    } catch (e) {
      return {
        mode: 'personal', status: 'server_offline', server: n, phone: meta.phone || '', code: '',
        error: e.offline ? `Server ${n} sedang offline. Sender-mu aman dan tersambung lagi otomatis saat server hidup.` : e.message,
        features: meta.features, config: meta.config, orders: [], stats: { contacts: 0, reminders: 0, orders: 0 },
      };
    }
  }

  app.get('/api/bots/:id/sender', requireAuth, async (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    const meta = getMeta(bot);
    if (isGlobal(bot)) return res.json(global.publicState(meta, bot));
    if (worker.workerOf(meta)) return res.json(await remoteState(bot, meta));
    res.json({ ...personal.publicState(meta), server: 0 });
  });

  app.post('/api/bots/:id/sender/pair', requireAuth, async (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    if (isGlobal(bot)) return res.status(400).json({ error: GLOBAL_MSG });
    const meta = getMeta(bot);
    if (new Date(meta.expiresAt).getTime() <= Date.now()) return res.status(403).json({ error: 'Masa sewa bot sudah habis.' });
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (phone.length < 9 || phone.length > 15 || phone.startsWith('0')) return res.status(400).json({ error: 'Nomor harus format internasional tanpa 0 di depan, contoh 6281234567890.' });
    if (personal.phoneInUse(phone, bot.id) || phone === global.getState().phone || allMetas().some(m => m.id !== bot.id && m.server >= 1 && m.phone === phone && !isExpired(m))) return res.status(400).json({ error: 'Nomor ini sudah dipakai bot lain.' });

    // sudah terhubung? (di server utama atau di server sender)
    const oldN = worker.workerOf(meta);
    const cur = personal.runtimeOf(bot.id);
    if (oldN) {
      try { const s = await worker.callWorker(oldN, 'POST', '/w/state', { bot: worker.snap(bot) }); if (s.status === 'connected') return res.status(400).json({ error: 'Sender sudah terhubung. Lepas dulu kalau mau ganti nomor atau server.' }); }
      catch (e) { return res.status(503).json({ error: `Server ${oldN} sedang offline. Tunggu sampai hidup lagi sebelum ganti nomor atau server.` }); }
    } else if (cur && cur.status === 'connected') return res.status(400).json({ error: 'Sender sudah terhubung. Lepas dulu kalau mau ganti nomor.' });

    let target;
    try { target = await worker.chooseTarget(req.body && req.body.server, !!cur || personal.activeCount() < MAX_SESSIONS); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

    try {
      if (oldN && oldN !== target.n) { // pindah server: bersihkan sesi di server lama
        try { const r = await worker.callWorker(oldN, 'POST', '/w/stop', { bot: worker.snap(bot) }); if (r.config) meta.config = cleanConfig(r.config, meta.config); } catch (e) {}
      }
      if (target.n) {
        if (cur) personal.stop(bot.id, false);
        const d = await worker.callWorker(target.n, 'POST', '/w/pair', { bot: worker.snap(bot), phone, config: meta.config }, 45000);
        meta.server = target.n; writeMeta(meta);
        return res.json({ code: d.code, server: target.n });
      }
      meta.server = 0; writeMeta(meta);
      fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true }); // mulai sesi bersih untuk pairing baru
      const ctx = await personal.start(meta, phone);
      res.json({ code: ctx.code, server: 0 });
    } catch (e) {
      if (!target.n) personal.stop(bot.id, false);
      res.status(e.offline ? 503 : (e.status || 500)).json({ error: e.message || 'Gagal meminta kode pairing.' });
    }
  });

  app.post('/api/bots/:id/sender/stop', requireAuth, async (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    if (isGlobal(bot)) return res.status(400).json({ error: GLOBAL_MSG });
    const meta = getMeta(bot);
    const n = worker.workerOf(meta);
    if (n) {
      try { const r = await worker.callWorker(n, 'POST', '/w/stop', { bot: worker.snap(bot) }); if (r.config) meta.config = cleanConfig(r.config, meta.config); }
      catch (e) { return res.status(503).json({ error: e.offline ? `Server ${n} sedang offline, sender belum bisa dilepas. Coba lagi setelah server hidup.` : e.message }); }
      meta.phone = ''; meta.server = 0; writeMeta(meta);
      return res.json({ ok: true });
    }
    personal.stop(bot.id, true);
    meta.phone = '';
    setTimeout(() => { fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true }); writeMeta(meta); }, 1500);
    res.json({ ok: true });
  });

  app.put('/api/bots/:id/config', requireAuth, async (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    const meta = getMeta(bot);
    const n = worker.workerOf(meta);
    if (n) { // sender ada di server sender: pengaturan disimpan di sana
      try {
        const r = await worker.callWorker(n, 'PUT', '/w/config', { bot: worker.snap(bot), config: req.body && req.body.config });
        meta.config = r.config; writeMeta(meta);
        return res.json({ ok: true, config: r.config });
      } catch (e) { return res.status(503).json({ error: e.offline ? `Server ${n} sedang offline, pengaturan belum bisa disimpan. Coba lagi nanti.` : e.message }); }
    }
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
