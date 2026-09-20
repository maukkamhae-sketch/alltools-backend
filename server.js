require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-jangan-dipakai-di-production';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''; // opsional, kalau nanti mau upgrade ke Claude
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Batas pemakaian gratis per hari. Owner dan user premium melewati batas ini.
const FREE_LIMITS = { downloads: 9999, ai: 20, enhance: 5, convert: 9999 };

/* ---------------------------------------------------------- */
/* Auth: register, login, dan middleware pengecekan token      */
/* ---------------------------------------------------------- */

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nama, email, dan password wajib diisi.' });
  }
  if (db.findUserByEmail(email)) {
    return res.status(409).json({ error: 'Email sudah terdaftar. Coba masuk saja.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const isOwner = email.toLowerCase() === OWNER_EMAIL && OWNER_EMAIL !== '';
  const user = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name, email, passwordHash,
    plan: isOwner ? 'owner' : 'free', // 'free' | 'basic' | 'pro' | 'owner'
    quota: { date: db.todayStr(), downloads: 0, ai: 0, enhance: 0, convert: 0 },
    createdAt: new Date().toISOString(),
  };
  db.saveUser(user);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.findUserByEmail(email || '');
  if (!user) return res.status(401).json({ error: 'Email atau password salah.' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Email atau password salah.' });
  // Kalau email ini didaftarkan sebagai OWNER_EMAIL belakangan, naikkan otomatis saat login.
  if (OWNER_EMAIL && user.email.toLowerCase() === OWNER_EMAIL && user.plan !== 'owner') {
    user.plan = 'owner';
    db.saveUser(user);
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Belum login.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.findUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan.' });
    db.resetQuotaIfNewDay(user);
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesi login tidak valid, coba masuk lagi.' });
  }
}

function publicUser(user) {
  const unlimited = user.plan === 'owner' || user.plan === 'basic' || user.plan === 'pro';
  return {
    id: user.id, name: user.name, email: user.email, plan: user.plan,
    quota: user.quota,
    limits: unlimited
      ? { downloads: 'unlimited', ai: user.plan === 'pro' || user.plan === 'owner' ? 'unlimited' : 100, enhance: 'unlimited', convert: 'unlimited' }
      : FREE_LIMITS,
  };
}

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ---------------------------------------------------------- */
/* Kuota: cek dan pakai jatah harian sebelum proses fitur berat */
/* ---------------------------------------------------------- */

function hasUnlimitedAccess(user, feature) {
  if (user.plan === 'owner') return true;
  if (user.plan === 'pro') return true;
  if (user.plan === 'basic') return feature !== 'ai'; // Basic: AI masih dibatasi 100/hari
  return false;
}

function useQuota(user, feature) {
  if (hasUnlimitedAccess(user, feature)) return true;
  const limit = FREE_LIMITS[feature];
  if (user.quota[feature] >= limit) return false;
  user.quota[feature]++;
  db.saveUser(user);
  return true;
}

/* ---------------------------------------------------------- */
/* Premium: aktivasi paket (di produksi ini dipanggil oleh      */
/* webhook Midtrans/Xendit setelah pembayaran sukses, bukan     */
/* langsung dari app seperti contoh ini)                       */
/* ---------------------------------------------------------- */

app.post('/api/premium/activate', requireAuth, (req, res) => {
  const { plan } = req.body || {};
  if (!['basic', 'pro'].includes(plan)) {
    return res.status(400).json({ error: 'Paket tidak dikenali.' });
  }
  req.user.plan = plan;
  db.saveUser(req.user);
  res.json({ user: publicUser(req.user) });
});

/* ---------------------------------------------------------- */
/* Downloader: contoh pemakaian yt-dlp untuk ambil link video   */
/* tanpa watermark. yt-dlp harus terinstal di server (bukan npm,*/
/* lihat catatan instalasi di README).                          */
/* ---------------------------------------------------------- */

const { exec, spawn } = require('child_process');

app.post('/api/download', requireAuth, (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Link video wajib diisi.' });
  if (!useQuota(req.user, 'downloads')) {
    return res.status(429).json({ error: 'Kuota download harian habis. Upgrade ke Premium.' });
  }
  // Cukup cek videonya valid & ambil judulnya, video sebenarnya diambil lewat
  // /api/download/stream supaya bisa lewat proxy server (hindari 403 dari TikTok/IG).
  const cmd = `yt-dlp --no-playlist --print "%(title)s" "${url.replace(/"/g, '')}"`;
  exec(cmd, { timeout: 20000 }, (err, stdout) => {
    if (err) {
      return res.status(502).json({ error: 'Gagal ambil video. Link mungkin tidak didukung atau sudah kedaluwarsa.' });
    }
    db.addHistory(req.user.id, 'download', url.length > 60 ? url.slice(0, 60) + '...' : url);
    const streamUrl = `/api/download/stream?url=${encodeURIComponent(url)}&token=${encodeURIComponent(req.headers.authorization.slice(7))}`;
    res.json({ title: stdout.trim() || 'video', streamUrl });
  });
});

// Endpoint ini yang beneran ngirim file video-nya ke app, dibuka lewat link
// biasa (makanya token dikirim lewat query, bukan header Authorization).
// yt-dlp sendiri yang download videonya lalu langsung ditulis ke stdout ("-o -"),
// dan stdout itu langsung disalurkan (pipe) ke response — lebih tahan banting
// daripada kita manual nge-fetch link mentahnya, karena yt-dlp yang paling tau
// header/cookie apa yang dibutuhin tiap platform.
app.get('/api/download/stream', (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).send('Link atau token tidak lengkap.');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.findUserById(payload.id);
    if (!user) throw new Error('no user');
  } catch (e) {
    return res.status(401).send('Sesi login tidak valid.');
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');

  const proc = spawn('yt-dlp', [
    '-f', 'download,best',
    '--no-playlist',
    '-o', '-',
    url,
  ]);

  let sentAnyData = false;
  proc.stdout.on('data', () => { sentAnyData = true; });
  proc.stdout.pipe(res);

  proc.stderr.on('data', () => {}); // biar gak numpuk di buffer, gak perlu ditampilkan

  proc.on('error', () => {
    if (!res.headersSent) res.status(502).send('Gagal menjalankan yt-dlp di server.');
  });
  proc.on('close', (code) => {
    if (!sentAnyData && !res.headersSent) {
      res.status(502).send('Gagal ambil video. Link mungkin tidak didukung atau sudah kedaluwarsa.');
    } else {
      res.end();
    }
  });
});

/* ---------------------------------------------------------- */
/* Asisten AI: proxy ke Anthropic API supaya API key tidak       */
/* pernah dikirim ke aplikasi di HP user.                       */
/* ---------------------------------------------------------- */

async function askGemini(message) {
  if (!GEMINI_API_KEY) throw new Error('Server belum diisi GEMINI_API_KEY.');
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: message }] }] }),
    }
  );
  const data = await r.json();
  if (data.error) throw new Error('Gemini API: ' + data.error.message);
  const reply = (data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts.map(p => p.text || '').join('\n')) || '';
  return reply || 'Maaf, tidak ada jawaban.';
}

app.post('/api/ai/chat', requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
  if (!useQuota(req.user, 'ai')) {
    return res.status(429).json({ error: 'Kuota chat AI harian habis. Upgrade ke Premium.' });
  }
  try {
    const reply = await askGemini(message);
    db.addHistory(req.user.id, 'ai', message.slice(0, 60));
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Gagal menghubungi layanan AI.' });
  }
});

/* ---------------------------------------------------------- */
/* Riwayat: dipakai halaman "Hasil" di app                      */
/* ---------------------------------------------------------- */

app.get('/api/history', requireAuth, (req, res) => {
  res.json({ history: db.getHistoryForUser(req.user.id) });
});

app.post('/api/history', requireAuth, (req, res) => {
  const { type, label } = req.body || {};
  if (!type || !label) return res.status(400).json({ error: 'Data tidak lengkap.' });
  db.addHistory(req.user.id, type, label);
  res.json({ ok: true });
});

/* ---------------------------------------------------------- */
/* Publish ke Web: fitur khusus Premium/Owner, mirip Netlify   */
/* sederhana — user upload 1 file HTML, langsung dapet link     */
/* publik. File disimpan di Volume (DATA_DIR/sites/<slug>).     */
/* ---------------------------------------------------------- */

const multer = require('multer');
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB, cukup buat satu file HTML
  storage: multer.memoryStorage(),
});
const SITES_DIR = path.join(process.env.DATA_DIR || __dirname, 'sites');

function canPublish(user) {
  return user.plan === 'owner' || user.plan === 'pro' || user.plan === 'basic';
}

app.post('/api/publish', requireAuth, upload.single('file'), (req, res) => {
  if (!canPublish(req.user)) {
    return res.status(403).json({ error: 'Fitur Publish ke Web khusus untuk Premium. Upgrade dulu ya.' });
  }
  const file = req.file;
  let { slug } = req.body || {};
  if (!file) return res.status(400).json({ error: 'File HTML wajib diupload.' });
  if (!slug) return res.status(400).json({ error: 'Nama alamat (slug) wajib diisi.' });

  slug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  if (!slug) return res.status(400).json({ error: 'Nama alamat tidak valid.' });

  const existing = db.findSiteBySlug(slug);
  if (existing && existing.userId !== req.user.id) {
    return res.status(409).json({ error: 'Nama alamat itu sudah dipakai orang lain, coba nama lain.' });
  }

  const siteDir = path.join(SITES_DIR, slug);
  try {
    fs.mkdirSync(siteDir, { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'index.html'), file.buffer);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menyimpan file di server.' });
  }

  db.saveSite({
    slug, userId: req.user.id,
    title: (req.body.title || slug).slice(0, 80),
    date: new Date().toISOString(),
  });
  db.addHistory(req.user.id, 'publish', slug);

  res.json({ url: `/site/${slug}/` });
});

app.get('/api/my-sites', requireAuth, (req, res) => {
  res.json({ sites: db.getSitesForUser(req.user.id) });
});

// Serve semua site yang di-publish, publik (siapa aja bisa buka linknya)
app.use('/site', express.static(SITES_DIR));

/* ---------------------------------------------------------- */
/* Sewa Bot WhatsApp: user pilih fitur + durasi, dapet API key  */
/* buat dimasukin ke mesin bot-nya nanti. Bagian ini baru       */
/* ngurus "sewa & manajemen"-nya — mesin bot yang beneran       */
/* konek ke WhatsApp itu servis terpisah (langkah berikutnya).  */
/* ---------------------------------------------------------- */

const BOT_FEATURES = {
  autoreply: 'Auto-reply pesan masuk',
  welcome: 'Welcome message member baru grup',
  catalog: 'Kirim katalog produk otomatis',
  broadcast: 'Broadcast pesan ke banyak kontak',
  antilink: 'Anti-link di grup',
  reminder: 'Reminder/absen otomatis',
  orderbot: 'Deteksi & catat pesanan otomatis',
  faq: 'Auto-jawab FAQ dari daftar tanya-jawab',
  ai: 'Chat AI langsung di WhatsApp',
  downloader: 'Download video TikTok/IG tanpa watermark',
};

function generateApiKey() {
  return 'bot_' + [...Array(32)].map(() => Math.random().toString(36)[2] || '0').join('');
}

app.get('/api/bots/features', (req, res) => {
  res.json({ features: BOT_FEATURES });
});

app.post('/api/bots/rent', requireAuth, (req, res) => {
  const { name, features, durationDays } = req.body || {};
  if (!name || !Array.isArray(features) || features.length === 0) {
    return res.status(400).json({ error: 'Nama bot dan minimal 1 fitur wajib diisi.' });
  }
  const validFeatures = features.filter(f => BOT_FEATURES[f]);
  if (validFeatures.length === 0) {
    return res.status(400).json({ error: 'Fitur yang dipilih tidak valid.' });
  }
  const days = [7, 30, 90].includes(Number(durationDays)) ? Number(durationDays) : 30;

  const bot = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    userId: req.user.id,
    name: name.slice(0, 60),
    apiKey: generateApiKey(),
    features: validFeatures,
    durationDays: days,
    whatsappNumber: '', // diisi belakangan setelah bot dipairing, lewat /api/bots/:id/number
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
  };
  db.saveBot(bot);
  db.addHistory(req.user.id, 'bot', name + ' (' + days + ' hari)');
  res.json({ bot });
});

app.get('/api/bots/mine', requireAuth, (req, res) => {
  const bots = db.getBotsForUser(req.user.id).map(b => ({
    ...b,
    status: new Date(b.expiresAt) < new Date() ? 'expired' : 'active',
  }));
  res.json({ bots });
});

// Isi/update nomor WA yang udah dipairing ke bot ini, biar bisa ditampilin
// sebagai link "Chat langsung" (wa.me) di app — buat dibagiin/dipasang di
// website toko customer.
app.put('/api/bots/:id/number', requireAuth, (req, res) => {
  const bots = db.getBotsForUser(req.user.id);
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot tidak ditemukan.' });
  const number = (req.body.whatsappNumber || '').replace(/[^0-9]/g, '');
  if (!number || number.length < 8) {
    return res.status(400).json({ error: 'Nomor WhatsApp tidak valid.' });
  }
  bot.whatsappNumber = number;
  db.saveBot(bot);
  res.json({ bot });
});

// Dipanggil oleh mesin bot (bukan oleh app di HP user) buat cek API key
// masih aktif dan fitur apa aja yang boleh dijalankan.
app.get('/api/bots/verify', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'API key wajib disertakan.' });
  const bot = db.findBotByApiKey(apiKey);
  if (!bot) return res.status(404).json({ error: 'API key tidak ditemukan.' });
  if (new Date(bot.expiresAt) < new Date()) {
    return res.status(403).json({ error: 'Masa sewa bot sudah habis.' });
  }
  res.json({ valid: true, name: bot.name, features: bot.features, expiresAt: bot.expiresAt });
});

// Middleware auth khusus bot: dipakai endpoint yang dipanggil oleh mesin bot
// (bukan app di HP user), otentikasinya pakai API key bot, bukan token login.
function requireBotAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key wajib disertakan.' });
  const bot = db.findBotByApiKey(apiKey);
  if (!bot) return res.status(401).json({ error: 'API key tidak valid.' });
  if (new Date(bot.expiresAt) < new Date()) {
    return res.status(403).json({ error: 'Masa sewa bot sudah habis.' });
  }
  req.bot = bot;
  next();
}

app.post('/api/bots/ai', requireBotAuth, async (req, res) => {
  if (!req.bot.features.includes('ai')) {
    return res.status(403).json({ error: 'Fitur AI tidak aktif untuk bot ini.' });
  }
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
  try {
    const reply = await askGemini(message);
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Gagal menghubungi layanan AI.' });
  }
});

app.get('/api/bots/download', requireBotAuth, (req, res) => {
  if (!req.bot.features.includes('downloader')) {
    return res.status(403).json({ error: 'Fitur downloader tidak aktif untuk bot ini.' });
  }
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Link video wajib diisi.' });

  res.setHeader('Content-Type', 'video/mp4');
  const proc = spawn('yt-dlp', ['-f', 'download,best', '--no-playlist', '-o', '-', url]);
  let sentAnyData = false;
  proc.stdout.on('data', () => { sentAnyData = true; });
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'Gagal menjalankan yt-dlp di server.' });
  });
  proc.on('close', () => {
    if (!sentAnyData && !res.headersSent) {
      res.status(502).json({ error: 'Gagal ambil video. Link mungkin tidak didukung.' });
    } else {
      res.end();
    }
  });
});

app.listen(PORT, () => {
  console.log(`AllTools backend jalan di http://localhost:${PORT}`);
});

