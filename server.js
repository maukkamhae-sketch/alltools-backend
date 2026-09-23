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
const MASTER_KEY = process.env.MASTER_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''; // opsional, kalau nanti mau upgrade ke Claude
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID || '';

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
/* Premium: sekarang beneran lewat Midtrans Snap. Alur:          */
/* 1. App minta token transaksi (create-transaction)             */
/* 2. App buka popup Snap pakai token itu                        */
/* 3. User bayar, Midtrans kirim notifikasi ke /notification     */
/* 4. Baru di situ plan user diaktifkan (bukan langsung dari app)*/
/* ---------------------------------------------------------- */

const crypto = require('crypto');
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const MIDTRANS_IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const MIDTRANS_SNAP_URL = MIDTRANS_IS_PRODUCTION
  ? 'https://app.midtrans.com/snap/v1/transactions'
  : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

const PLAN_PRICES = { basic: 39000, pro: 89000 };

app.post('/api/premium/create-transaction', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Paket tidak dikenali.' });
  if (!MIDTRANS_SERVER_KEY) return res.status(500).json({ error: 'Server belum diisi MIDTRANS_SERVER_KEY.' });

  const orderId = `ORDER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const grossAmount = PLAN_PRICES[plan];

  try {
    const authHeader = 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');
    const r = await fetch(MIDTRANS_SNAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({
        transaction_details: { order_id: orderId, gross_amount: grossAmount },
        customer_details: { first_name: req.user.name, email: req.user.email },
        item_details: [{ id: plan, price: grossAmount, quantity: 1, name: `AllTools Premium ${plan}` }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error_messages?.join(', ') || 'Gagal bikin transaksi.' });

    db.saveTransaction({ orderId, userId: req.user.id, plan, status: 'pending', createdAt: new Date().toISOString() });
    res.json({ token: data.token, orderId, isProduction: MIDTRANS_IS_PRODUCTION });
  } catch (e) {
    res.status(502).json({ error: 'Gagal menghubungi Midtrans.' });
  }
});

// Dipanggil oleh server Midtrans sendiri (bukan oleh app), begitu status
// pembayaran berubah. Verifikasi signature biar gak bisa dipalsuin orang.
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OWNER_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_OWNER_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('Gagal kirim notifikasi Telegram:', e.message);
  }
}

app.post('/api/premium/notification', async (req, res) => {
  const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status } = req.body || {};
  if (!order_id || !signature_key) return res.status(400).json({ error: 'Data notifikasi tidak lengkap.' });

  const expectedSignature = crypto
    .createHash('sha512')
    .update(order_id + status_code + gross_amount + MIDTRANS_SERVER_KEY)
    .digest('hex');
  if (expectedSignature !== signature_key) {
    return res.status(403).json({ error: 'Signature tidak valid.' });
  }

  const isPaid = (transaction_status === 'capture' && fraud_status === 'accept') || transaction_status === 'settlement';
  const isFailed = ['deny', 'cancel', 'expire'].includes(transaction_status);

  // Notifikasi ini dipakai 2 jenis transaksi: Premium ("ORDER-...") dan
  // Pulsa/Paket Data ("PULSA-..."), dibedain dari prefix order_id-nya.
  if (order_id.startsWith('PULSA-')) {
    const order = db.findOrderByOrderId(order_id);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    if (isPaid && order.status !== 'paid') {
      order.status = 'paid';
      db.saveOrder(order);
      const user = db.findUserById(order.userId);
      const operatorLabel = order.operator && order.operator !== 'all'
        ? order.operator.charAt(0).toUpperCase() + order.operator.slice(1)
        : 'Semua operator';
      sendTelegramMessage(
        `🔔 <b>Pesanan Pulsa/Data Baru</b>\n\n` +
        `Produk: ${order.productLabel}\n` +
        `Operator: ${operatorLabel}\n` +
        `Nomor tujuan: ${order.phoneNumber}\n` +
        `Harga pokok: Rp ${(order.basePrice||0).toLocaleString('id-ID')}\n` +
        `Fee: Rp ${(order.fee||0).toLocaleString('id-ID')}\n` +
        `Total dibayar user: Rp ${order.price.toLocaleString('id-ID')}\n` +
        `Pemesan: ${user ? user.name + ' (' + user.email + ')' : order.userId}\n` +
        `Order ID: ${order_id}\n\n` +
        `Status: SUDAH DIBAYAR ✅ — tolong isiin manual ya.`
      );
    } else if (isFailed) {
      order.status = 'failed';
      db.saveOrder(order);
    }
    return res.json({ ok: true });
  }

  const tx = db.findTransactionByOrderId(order_id);
  if (!tx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });

  if (isPaid && tx.status !== 'paid') {
    tx.status = 'paid';
    db.saveTransaction(tx);
    const user = db.findUserById(tx.userId);
    if (user) {
      user.plan = tx.plan;
      db.saveUser(user);
    }
  } else if (isFailed) {
    tx.status = 'failed';
    db.saveTransaction(tx);
  }

  res.json({ ok: true });
});

// Dipanggil app buat ngecek status transaksi (misal abis nutup popup Snap,
// mau tau udah kebayar apa belum — kadang notifikasi Midtrans telat dikit).
app.get('/api/premium/transaction/:orderId', requireAuth, (req, res) => {
  const tx = db.findTransactionByOrderId(req.params.orderId);
  if (!tx || tx.userId !== req.user.id) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  res.json({ status: tx.status });
});

/* ---------------------------------------------------------- */
/* Pulsa & Paket Data: daftar produk statis (harga bisa kamu    */
/* ubah sendiri di bawah). Pembayaran lewat Midtrans, setelah   */
/* lunas detail pesanan otomatis dikirim ke Telegram kamu buat   */
/* diisiin manual.                                              */
/* ---------------------------------------------------------- */

// Deteksi operator dari 4 digit awal nomor HP (prefix umum di Indonesia).
const OPERATOR_PREFIXES = {
  telkomsel: ['0811','0812','0813','0821','0822','0823','0851','0852','0853'],
  indosat:   ['0814','0815','0816','0855','0856','0857','0858'],
  xl:        ['0817','0818','0819','0859','0877','0878'],
  axis:      ['0831','0832','0833','0838'],
  tri:       ['0895','0896','0897','0898','0899'],
  smartfren: ['0881','0882','0883','0884','0885','0886','0887','0888','0889'],
};
function detectOperator(phone) {
  const p = (phone || '').replace(/[^0-9]/g, '');
  const local = p.startsWith('62') ? '0' + p.slice(2) : p;
  const prefix = local.slice(0, 4);
  for (const [op, prefixes] of Object.entries(OPERATOR_PREFIXES)) {
    if (prefixes.includes(prefix)) return op;
  }
  return null;
}

// "fee" = margin layanan yang ditambahin ke harga pokok pulsa/data, ini yang
// jadi profit kamu. Harga & fee dipisah biar transparan ke user.
const PULSA_PRODUCTS = [
  { id: 'pulsa-5k', operator: 'all', label: 'Pulsa Rp 5.000', basePrice: 6000, fee: 500 },
  { id: 'pulsa-10k', operator: 'all', label: 'Pulsa Rp 10.000', basePrice: 10500, fee: 1000 },
  { id: 'pulsa-20k', operator: 'all', label: 'Pulsa Rp 20.000', basePrice: 20000, fee: 1500 },
  { id: 'pulsa-25k', operator: 'all', label: 'Pulsa Rp 25.000', basePrice: 25000, fee: 1500 },
  { id: 'pulsa-50k', operator: 'all', label: 'Pulsa Rp 50.000', basePrice: 49500, fee: 2000 },
  { id: 'pulsa-100k', operator: 'all', label: 'Pulsa Rp 100.000', basePrice: 99000, fee: 2500 },
  { id: 'data-telkomsel-1gb', operator: 'telkomsel', label: 'Data Telkomsel 1GB/30 hari', basePrice: 13000, fee: 2000 },
  { id: 'data-telkomsel-3gb', operator: 'telkomsel', label: 'Data Telkomsel 3GB/30 hari', basePrice: 32000, fee: 3000 },
  { id: 'data-xl-2gb', operator: 'xl', label: 'Data XL 2GB/30 hari', basePrice: 17500, fee: 2500 },
  { id: 'data-xl-5gb', operator: 'xl', label: 'Data XL 5GB/30 hari', basePrice: 33000, fee: 3000 },
  { id: 'data-indosat-3gb', operator: 'indosat', label: 'Data Indosat 3GB/30 hari', basePrice: 22000, fee: 3000 },
  { id: 'data-indosat-6gb', operator: 'indosat', label: 'Data Indosat 6GB/30 hari', basePrice: 38000, fee: 3500 },
  { id: 'data-tri-2gb', operator: 'tri', label: 'Data Tri 2GB/30 hari', basePrice: 12000, fee: 2000 },
  { id: 'data-smartfren-3gb', operator: 'smartfren', label: 'Data Smartfren 3GB/30 hari', basePrice: 15000, fee: 2500 },
].map(p => ({ ...p, price: p.basePrice + p.fee }));

app.get('/api/pulsa/products', (req, res) => {
  res.json({ products: PULSA_PRODUCTS });
});

app.get('/api/pulsa/detect-operator', (req, res) => {
  const { phone } = req.query;
  const operator = detectOperator(phone);
  res.json({ operator });
});

app.post('/api/pulsa/create-transaction', requireAuth, async (req, res) => {
  const { productId, phoneNumber } = req.body || {};
  const product = PULSA_PRODUCTS.find(p => p.id === productId);
  if (!product) return res.status(400).json({ error: 'Produk tidak dikenali.' });
  const phone = (phoneNumber || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 8) return res.status(400).json({ error: 'Nomor HP tujuan tidak valid.' });
  if (!MIDTRANS_SERVER_KEY) return res.status(500).json({ error: 'Server belum diisi MIDTRANS_SERVER_KEY.' });

  const orderId = `PULSA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const authHeader = 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');
    const r = await fetch(MIDTRANS_SNAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({
        transaction_details: { order_id: orderId, gross_amount: product.price },
        customer_details: { first_name: req.user.name, email: req.user.email },
        item_details: [{ id: product.id, price: product.price, quantity: 1, name: product.label }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error_messages?.join(', ') || 'Gagal bikin transaksi.' });

    db.saveOrder({
      orderId, userId: req.user.id, productLabel: product.label, price: product.price,
      basePrice: product.basePrice, fee: product.fee, operator: product.operator,
      phoneNumber: phone, status: 'pending', createdAt: new Date().toISOString(),
    });
    res.json({ token: data.token, orderId });
  } catch (e) {
    res.status(502).json({ error: 'Gagal menghubungi Midtrans.' });
  }
});

app.get('/api/pulsa/orders', requireAuth, (req, res) => {
  res.json({ orders: db.getOrdersForUser(req.user.id) });
});


// Tetap dipertahankan buat testing/manual override oleh Owner lewat kode,
// bukan buat dipanggil langsung dari tombol beli di app lagi.
app.post('/api/premium/activate', requireAuth, (req, res) => {
  if (req.user.plan !== 'owner') {
    return res.status(403).json({ error: 'Aktivasi manual cuma buat Owner. User biasa lewat pembayaran Midtrans.' });
  }
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
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=
