/**
 * Multi-server sender (Server 1-5).
 *
 * Server utama menyimpan akun, database, dan pembayaran. Server 1-5 adalah deploy lain dari
 * kode yang SAMA yang hanya menjalankan koneksi WhatsApp sender Personal. Server utama
 * meneruskan perintah pasang / lepas / atur ke server yang dipilih user.
 *
 * Env:
 *   WORKER_SECRET   kode rahasia yang sama di server utama dan semua server sender (wajib).
 *   WORKER_URLS     hanya di server utama: url server 1,2,3,4,5 dipisah koma (maks 5), contoh
 *                   https://s1.up.railway.app,https://s2.up.railway.app,https://s3.up.railway.app
 *   BOT_MAX_SESSIONS  kapasitas sender per server (default 20).
 *
 * Endpoint /w/* (hanya aktif kalau WORKER_SECRET diisi, dan wajib header x-worker-secret):
 *   GET /w/health   POST /w/state   POST /w/pair   POST /w/stop   PUT /w/config
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MAX_SESSIONS, isExpired } = require('./util');
const { cleanConfig } = require('./config');
const { dirOf, getMeta, writeMeta, allMetas } = require('./store');
const personal = require('./personal');
const shared = require('./shared');

const SECRET = () => String(process.env.WORKER_SECRET || '');
const URLS = () => (SECRET() ? String(process.env.WORKER_URLS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean).slice(0, 5) : []);
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const workerOf = meta => (Number.isInteger(meta && meta.server) && meta.server >= 1 ? meta.server : 0);

/* Hanya field yang perlu yang dikirim ke server sender (tanpa apiKey, PIN, dll). */
const snap = b => ({ id: b.id, userId: b.userId, name: b.name, features: b.features, expiresAt: b.expiresAt });
function cleanBot(b) {
  if (!b || typeof b.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(b.id)) return null;
  return { id: b.id, userId: b.userId, name: String(b.name || '').slice(0, 60), features: Array.isArray(b.features) ? b.features : [], expiresAt: b.expiresAt, senderMode: 'personal' };
}
const sameSecret = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ---------- sisi server sender: endpoint /w/* ---------- */
function registerWorkerRoutes(app) {
  if (!SECRET()) return;
  app.use('/w', (req, res, next) => {
    if (!sameSecret(req.get('x-worker-secret') || '', SECRET())) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  const botOf = (req, res) => { const b = cleanBot(req.body && req.body.bot); if (!b) res.status(400).json({ error: 'Data bot tidak valid.' }); return b; };

  app.get('/w/health', (req, res) => res.json({ ok: true, used: personal.activeCount(), max: MAX_SESSIONS }));

  app.post('/w/state', (req, res) => {
    const bot = botOf(req, res); if (!bot) return;
    res.json(personal.publicState(getMeta(bot)));
  });

  app.post('/w/pair', async (req, res) => {
    const bot = botOf(req, res); if (!bot) return;
    const meta = getMeta(bot);
    if (req.body.config) meta.config = cleanConfig(req.body.config, meta.config);
    if (isExpired(meta)) return res.status(403).json({ error: 'Masa sewa bot sudah habis.' });
    const method = req.body.method === 'qr' ? 'qr' : 'code';
    const phone = method === 'qr' ? '' : String(req.body.phone || '').replace(/\D/g, '');
    if (method === 'code' && (phone.length < 9 || phone.length > 15 || phone.startsWith('0'))) return res.status(400).json({ error: 'Nomor harus format internasional tanpa 0 di depan, contoh 6281234567890.' });
    if (method === 'code' && personal.phoneInUse(phone, bot.id)) return res.status(400).json({ error: 'Nomor ini sudah dipakai bot lain.' });
    const cur = personal.runtimeOf(bot.id);
    if (cur && cur.status === 'connected') return res.status(400).json({ error: 'Sender sudah terhubung. Lepas dulu kalau mau ganti nomor.' });
    if (!cur && personal.activeCount() >= MAX_SESSIONS) return res.status(503).json({ error: 'Server ini penuh.', full: true });
    try {
      fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true });
      const ctx = await personal.start(meta, method === 'qr' ? undefined : phone, method === 'qr' ? 4 : undefined);
      res.json({ code: ctx.code, qr: ctx.qr });
    } catch (e) {
      personal.stop(bot.id, false);
      res.status(500).json({ error: e.message || 'Gagal meminta kode pairing.' });
    }
  });

  app.post('/w/stop', (req, res) => {
    const bot = botOf(req, res); if (!bot) return;
    const meta = getMeta(bot);
    personal.stop(bot.id, true);
    meta.phone = '';
    setTimeout(() => { fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true }); writeMeta(meta); }, 1500);
    res.json({ ok: true, config: meta.config });
  });

  app.put('/w/config', (req, res) => {
    const bot = botOf(req, res); if (!bot) return;
    const meta = getMeta(bot);
    meta.config = cleanConfig(req.body.config, meta.config);
    writeMeta(meta);
    res.json({ ok: true, config: meta.config });
  });
}

/* ---------- sisi server utama: memanggil server sender ---------- */
async function callWorker(n, method, p, body, timeoutMs) {
  const base = URLS()[n - 1];
  if (!base || typeof fetch !== 'function') throw Object.assign(new Error('Server ' + n + ' sedang offline.'), { offline: true });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  let r;
  try {
    r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET() }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
  } catch (e) {
    throw Object.assign(new Error('Server ' + n + ' sedang offline.'), { offline: true });
  } finally { clearTimeout(t); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 5xx tanpa pesan (mis. server sedang restart) dianggap offline
    if (r.status >= 502 && !data.error) throw Object.assign(new Error('Server ' + n + ' sedang offline.'), { offline: true });
    throw httpErr(r.status, data.error || 'Server ' + n + ' error (HTTP ' + r.status + ').');
  }
  return data;
}

let cache = { at: 0, list: [] };
/* Daftar server beserta status: active (masih muat), full (penuh), offline (tidak menjawab). */
async function serverList(force) {
  if (!force && Date.now() - cache.at < 8000) return cache.list;
  const list = await Promise.all(URLS().map(async (u, i) => {
    try {
      const h = await callWorker(i + 1, 'GET', '/w/health', null, 4000);
      return { id: i + 1, status: h.used >= h.max ? 'full' : 'active', used: h.used, max: h.max };
    } catch (e) { return { id: i + 1, status: 'offline', used: 0, max: 0 }; }
  }));
  cache = { at: Date.now(), list };
  return list;
}

/* Pilih server tujuan. pick: 'auto' atau 1..3. Hasil: {n} server sender, atau {local:true} server utama. */
async function chooseTarget(pick, localRoom) {
  const list = await serverList(true);
  if (!pick || String(pick) === 'auto') {
    const ok = list.filter(s => s.status === 'active').sort((a, b) => a.used / a.max - b.used / b.max || a.id - b.id);
    if (ok.length) return { n: ok[0].id };
    if (localRoom) return { local: true };
    throw httpErr(503, list.length ? 'Semua server sedang penuh atau offline. Coba lagi nanti.' : 'Server sedang penuh, coba lagi nanti.');
  }
  const n = Number(pick), s = list.find(x => x.id === n);
  if (!s) throw httpErr(400, 'Server tidak tersedia.');
  if (s.status === 'offline') throw httpErr(503, `Server ${n} sedang offline. Pilih server lain atau AUTO.`);
  if (s.status === 'full') throw httpErr(409, `Server ${n} penuh (${s.used}/${s.max}). Pilih server lain atau AUTO.`);
  return { n };
}

/* Server utama mengirim ulang data bot (nama, fitur, masa sewa) ke server sender tiap 5 menit,
   supaya perpanjangan sewa ikut terbaca dan sender tidak berhenti karena data lama. */
function startSync() {
  if (!URLS().length) return;
  setInterval(async () => {
    for (const meta of allMetas()) {
      const n = workerOf(meta);
      if (!n || !meta.userId || !shared.db) continue;
      const bot = shared.db.getBotsForUser(meta.userId).find(b => b.id === meta.id);
      if (!bot) continue;
      try { await callWorker(n, 'POST', '/w/state', { bot: snap(bot) }, 8000); } catch (e) {}
    }
  }, 5 * 60000).unref();
}

module.exports = { registerWorkerRoutes, callWorker, serverList, chooseTarget, startSync, workerOf, snap };
