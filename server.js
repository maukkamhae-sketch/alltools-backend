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
  if (!getPlanPrices()[plan]) return res.status(400).json({ error: 'Paket tidak dikenali.' });
  if (!MIDTRANS_SERVER_KEY) return res.status(500).json({ error: 'Server belum diisi MIDTRANS_SERVER_KEY.' });

  const orderId = `ORDER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const grossAmount = getPlanPrices()[plan];

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
const DEFAULT_PULSA_PRODUCTS = [
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


/* ---------------------------------------------------------- */
/* Pengaturan yang bisa diubah dari Web Admin (/admin):          */
/* daftar produk pulsa/data, harga Premium, nomor DANA.          */
/* Kalau belum pernah diubah, dipakai nilai bawaan di kode.      */
/* ---------------------------------------------------------- */

const OPERATORS = ['all', 'telkomsel', 'indosat', 'xl', 'axis', 'tri', 'smartfren'];

function getRawProducts() {
  const s = db.getSettings();
  if (Array.isArray(s.pulsaProducts)) return s.pulsaProducts;
  return DEFAULT_PULSA_PRODUCTS.map(({ price, ...rest }) => ({ ...rest, active: true }));
}
function getPulsaProducts() {
  return getRawProducts()
    .filter(p => p.active !== false)
    .map(p => ({ ...p, price: p.basePrice + p.fee }));
}
function getPlanPrices() {
  const s = db.getSettings();
  return { ...PLAN_PRICES, ...(s.planPrices || {}) };
}
// Nomor WhatsApp bot pusat. Bisa diganti dari Web Admin atau dari halaman Sewa Bot (Owner).
const DEFAULT_BOT_NUMBER = '62881012484500';
function getBotNumber() {
  return db.getSettings().platformBotNumber || DEFAULT_BOT_NUMBER;
}
const BOT_FEATURES = ['autoreply','welcome','catalog','broadcast','antilink','reminder','orderbot','faq','ai','downloader'];
function getBotPrices() {
  return { week: 25000, month: 75000, ...(db.getSettings().botPrices || {}) };
}
function getAmPrice() {
  return db.getSettings().amPrice || 49000; // sekali bayar, per HP, berlaku selamanya
}
function getDanaNumber() {
  return db.getSettings().dana || PAYMENT_DANA_NUMBER;
}

app.get('/api/bots/prices', (req, res) => {
  res.json({ prices: getBotPrices() });
});

app.get('/api/antimaling/price', (req, res) => {
  res.json({ price: getAmPrice() });
});

app.get('/api/bots/mine', requireAuth, (req, res) => {
  const now = Date.now();
  const bots = db.getBotsForUser(req.user.id).map(b => ({
    ...b, apiKey: undefined,
    status: new Date(b.expiresAt).getTime() > now ? 'active' : 'expired',
  }));
  const pending = db.getOrdersForUser(req.user.id, 100)
    .filter(o => o.type === 'bot' && ['awaiting_payment', 'waiting_confirmation'].includes(o.status))
    .map(o => ({ orderId: o.orderId, name: o.botName, durationDays: o.durationDays, price: o.price, status: o.status }));
  res.json({ bots, pending });
});

app.get('/api/premium/plans', (req, res) => {
  res.json({ prices: getPlanPrices() });
});

app.get('/api/pulsa/products', (req, res) => {
  res.json({ products: getPulsaProducts() });
});

app.get('/api/pulsa/detect-operator', (req, res) => {
  const { phone } = req.query;
  const operator = detectOperator(phone);
  res.json({ operator });
});

app.post('/api/pulsa/create-transaction', requireAuth, async (req, res) => {
  const { productId, phoneNumber } = req.body || {};
  const product = getPulsaProducts().find(p => p.id === productId);
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
    res.json({ token: data.token, orderId, isProduction: MIDTRANS_IS_PRODUCTION });
  } catch (e) {
    res.status(502).json({ error: 'Gagal menghubungi Midtrans.' });
  }
});

app.get('/api/pulsa/orders', requireAuth, (req, res) => {
  res.json({ orders: db.getOrdersForUser(req.user.id).filter(o => !['premium', 'bot', 'antimaling'].includes(o.type)) });
});


/* ---------------------------------------------------------- */
/* Pembayaran manual (tanpa payment gateway): user bayar lewat  */
/* QRIS / DANA, tekan "Sudah bayar", lalu bot Telegram kirim    */
/* notifikasi dengan tombol Konfirmasi / Tolak ke kamu.         */
/* ---------------------------------------------------------- */

const PAYMENT_DANA_NUMBER = process.env.PAYMENT_DANA_NUMBER || '6288211062271';

function escapeHtml(t) {
  return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Kode unik 1-99 rupiah ditambahkan ke nominal supaya kamu gampang mencocokkan
// pembayaran yang masuk di DANA/QRIS dengan pesanan yang mana.
app.post('/api/manual/create', requireAuth, (req, res) => {
  const { type, productId, plan, phoneNumber, name, features, durationDays } = req.body || {};
  let label, price, extra;
  if (type === 'premium') {
    const p = String(plan || '').toLowerCase();
    if (!getPlanPrices()[p]) return res.status(400).json({ error: 'Paket tidak dikenali.' });
    label = `AllTools Premium ${p}`;
    price = getPlanPrices()[p];
    extra = { type: 'premium', plan: p };
  } else if (type === 'antimaling') {
    const devName = String(name || '').trim().slice(0, 40) || 'HP saya';
    label = `Proteksi AntiMaling — ${devName}`;
    price = getAmPrice();
    extra = { type: 'antimaling', deviceLabel: devName };
  } else if (type === 'bot') {
    const days = Number(durationDays);
    if (![7, 30].includes(days)) return res.status(400).json({ error: 'Durasi sewa tidak valid.' });
    const botName = String(name || '').trim().slice(0, 60);
    if (!botName) return res.status(400).json({ error: 'Nama bot wajib diisi.' });
    const feats = Array.isArray(features) ? [...new Set(features.filter(f => BOT_FEATURES.includes(f)))] : [];
    if (!feats.length) return res.status(400).json({ error: 'Pilih minimal 1 fitur.' });
    const prices = getBotPrices();
    label = `Sewa Bot "${botName}" (${days} hari)`;
    price = days === 7 ? prices.week : prices.month;
    extra = { type: 'bot', botName, features: feats, durationDays: days };
  } else {
    const product = getPulsaProducts().find(x => x.id === productId);
    if (!product) return res.status(400).json({ error: 'Produk tidak dikenali.' });
    const phone = (phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone || phone.length < 8) return res.status(400).json({ error: 'Nomor HP tujuan tidak valid.' });
    label = product.label;
    price = product.price;
    extra = { type: 'pulsa', basePrice: product.basePrice, fee: product.fee, operator: product.operator, phoneNumber: phone };
  }
  const uniqueCode = 1 + Math.floor(Math.random() * 99);
  const total = price + uniqueCode;
  const orderId = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.saveOrder({
    orderId, userId: req.user.id, productLabel: label, price: total, uniqueCode,
    status: 'awaiting_payment', createdAt: new Date().toISOString(), ...extra,
  });
  res.json({ orderId, label, total, dana: getDanaNumber() });
});

// User menekan "Sudah bayar": kirim notifikasi ke Telegram dengan tombol konfirmasi.
app.post('/api/manual/claim', requireAuth, async (req, res) => {
  const { orderId } = req.body || {};
  const order = db.findOrderByOrderId(orderId || '');
  if (!order || order.userId !== req.user.id) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  if (order.status === 'paid') return res.json({ status: 'paid' });
  if (order.status === 'awaiting_payment') {
    order.status = 'waiting_confirmation';
    db.saveOrder(order);
    const detail = order.type === 'premium'
      ? `Paket: ${escapeHtml(order.plan)}`
      : order.type === 'bot'
        ? `Sewa bot: ${escapeHtml(order.botName)}\nDurasi: ${order.durationDays} hari\nFitur: ${escapeHtml(order.features.join(', '))}`
        : order.type === 'antimaling'
          ? `Proteksi AntiMaling untuk: ${escapeHtml(order.deviceLabel)}`
          : `Produk: ${escapeHtml(order.productLabel)}\nNomor tujuan: ${escapeHtml(order.phoneNumber)}`;
    await tgApi('sendMessage', {
      chat_id: TELEGRAM_OWNER_CHAT_ID,
      parse_mode: 'HTML',
      text:
        `🔔 <b>Pembayaran Manual Baru</b>\n\n${detail}\n` +
        `Nominal: <b>Rp ${order.price.toLocaleString('id-ID')}</b> (sudah termasuk kode unik ${order.uniqueCode})\n` +
        `Pemesan: ${escapeHtml(req.user.name)} (${escapeHtml(req.user.email)})\n` +
        `Order ID: ${escapeHtml(order.orderId)}\n\n` +
        `Cek dulu uangnya sudah masuk di DANA, lalu tekan tombol di bawah.`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Konfirmasi', callback_data: 'ok:' + order.orderId },
        { text: '❌ Tolak', callback_data: 'no:' + order.orderId },
      ]] },
    });
  }
  res.json({ status: order.status });
});

async function tgApi(method, body) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) {
    console.error('Telegram error:', e.message);
    return null;
  }
}

// Dipakai bersama oleh tombol Telegram dan Web Admin.
function createAmDeviceFromOrder(order) {
  let pairCode;
  do { pairCode = String(Math.floor(100000 + Math.random() * 900000)); } while (db.findAmDeviceByPairCode(pairCode));
  const now = new Date().toISOString();
  const dev = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    userId: order.userId, name: order.deviceLabel, orderId: order.orderId,
    pairCode, paired: false, apiKey: null,
    lockPin: String(Math.floor(1000 + Math.random() * 9000)), // PIN kunci kustom, beda dari PIN asli HP
    battery: null, lastSeen: null, lastLocation: null, lastPhotoAt: null, createdAt: now,
  };
  db.saveAmDevice(dev);
  return dev;
}

function createBotFromOrder(order) {
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); } while (db.findBotByPin(pin));
  const now = Date.now();
  const bot = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 7),
    userId: order.userId, name: order.botName, features: order.features,
    apiKey: crypto.randomBytes(16).toString('hex'), pin, orderId: order.orderId,
    status: 'active', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + order.durationDays * 86400000).toISOString(),
  };
  db.saveBot(bot);
  return bot;
}

function settleOrder(order, action) {
  if (order.status === 'paid' || order.status === 'failed') {
    return { ok: false, note: 'Pesanan ini sudah diproses.' };
  }
  if (action === 'ok') {
    order.status = 'paid';
    db.saveOrder(order);
    if (order.type === 'premium') {
      const user = db.findUserById(order.userId);
      if (user) { user.plan = order.plan; db.saveUser(user); }
      return { ok: true, note: `✅ Dikonfirmasi. Paket ${order.plan} sudah diaktifkan.` };
    }
    if (order.type === 'bot') {
      const bot = createBotFromOrder(order);
      return { ok: true, note: `✅ Dikonfirmasi. Bot "${bot.name}" aktif ${order.durationDays} hari. PIN aktivasi: ${bot.pin} (user sudah bisa lihat di app).` };
    }
    if (order.type === 'antimaling') {
      const dev = createAmDeviceFromOrder(order);
      return { ok: true, note: `✅ Dikonfirmasi. Proteksi AntiMaling untuk "${dev.name}" aktif. Kode pairing: ${dev.pairCode} (user sudah bisa lihat di app).` };
    }
    return { ok: true, note: `✅ Dikonfirmasi. Tolong isikan ${order.productLabel} ke ${order.phoneNumber} ya.` };
  }
  order.status = 'failed';
  db.saveOrder(order);
  return { ok: true, note: '❌ Pesanan ditolak.' };
}

async function handleTelegramUpdate(u) {
  const cb = u.callback_query;
  if (!cb || !cb.data) return;
  if (String(cb.message?.chat?.id) !== String(TELEGRAM_OWNER_CHAT_ID)) {
    return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Bukan admin.' });
  }
  const [action, ...rest] = cb.data.split(':');
  const order = db.findOrderByOrderId(rest.join(':'));
  if (!order) return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Pesanan tidak ditemukan.' });
  const result = settleOrder(order, action);
  await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: result.note.slice(0, 190) });
  if (!result.ok) return;
  await tgApi('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  await tgApi('sendMessage', { chat_id: cb.message.chat.id, text: `${result.note}\nOrder ID: ${order.orderId}` });
}

// Long polling: server menanyakan update ke Telegram, jadi tidak perlu setWebhook.
// Pakai bot yang khusus untuk AllTools (jangan dipakai bareng program lain yang juga polling/webhook).
async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OWNER_CHAT_ID) {
    console.log('Telegram belum dikonfigurasi, tombol konfirmasi tidak aktif.');
    return;
  }
  let offset = 0;
  for (;;) {
    const data = await tgApi('getUpdates', { offset, timeout: 25, allowed_updates: ['callback_query'] });
    if (data && data.ok) {
      for (const u of data.result) {
        offset = u.update_id + 1;
        try { await handleTelegramUpdate(u); } catch (e) { console.error('Gagal proses update Telegram:', e.message); }
      }
    } else {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

/* ---------------------------------------------------------- */
/* Web Admin: halaman /admin + API khusus akun Owner.            */
/* ---------------------------------------------------------- */

function requireOwner(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.plan !== 'owner') return res.status(403).json({ error: 'Khusus Owner.' });
    next();
  });
}

// Aset gambar/video untuk halaman /admin (file harus ada di folder yang sama dengan server.js).
const ADMIN_ASSETS = ['loading.webp', 'banner.mp4', 'banner-poster.jpg', 'rasengan.mp4'];
app.get(ADMIN_ASSETS.map(f => '/' + f), (req, res) => {
  const file = path.join(__dirname, path.basename(req.path));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.get('/admin', (req, res) => {
  const file = path.join(__dirname, 'admin.html');
  if (!fs.existsSync(file)) return res.status(404).send('admin.html belum diunggah ke repo.');
  res.sendFile(file);
});

app.get('/api/admin/config', requireOwner, (req, res) => {
  res.json({ products: getRawProducts(), planPrices: getPlanPrices(), botPrices: getBotPrices(), botNumber: getBotNumber(), amPrice: getAmPrice(), dana: getDanaNumber() });
});

app.put('/api/admin/config', requireOwner, (req, res) => {
  const { products, planPrices, botPrices, botNumber, amPrice, dana } = req.body || {};
  const toInt = v => Math.round(Number(v));
  const patch = {};

  if (products !== undefined) {
    if (!Array.isArray(products)) return res.status(400).json({ error: 'Format produk salah.' });
    const seen = new Set();
    const clean = [];
    for (const p of products) {
      const id = String((p && p.id) || '').trim();
      const label = String((p && p.label) || '').trim();
      const basePrice = toInt(p && p.basePrice);
      const fee = toInt(p && p.fee);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'ID produk tidak valid: ' + id });
      if (seen.has(id)) return res.status(400).json({ error: 'ID produk ganda: ' + id });
      if (!label) return res.status(400).json({ error: 'Nama produk tidak boleh kosong.' });
      if (!Number.isFinite(basePrice) || basePrice < 0 || !Number.isFinite(fee) || fee < 0) {
        return res.status(400).json({ error: 'Harga pokok/fee tidak valid di: ' + label });
      }
      seen.add(id);
      clean.push({
        id, label,
        operator: OPERATORS.includes(p.operator) ? p.operator : 'all',
        basePrice, fee, active: p.active !== false,
      });
    }
    patch.pulsaProducts = clean;
  }

  if (planPrices !== undefined) {
    const basic = toInt(planPrices && planPrices.basic);
    const pro = toInt(planPrices && planPrices.pro);
    if (!(basic > 0) || !(pro > 0)) return res.status(400).json({ error: 'Harga Premium harus lebih dari 0.' });
    patch.planPrices = { basic, pro };
  }

  if (botPrices !== undefined) {
    const week = toInt(botPrices && botPrices.week);
    const month = toInt(botPrices && botPrices.month);
    if (!(week > 0) || !(month > 0)) return res.status(400).json({ error: 'Harga sewa bot harus lebih dari 0.' });
    patch.botPrices = { week, month };
  }

  if (botNumber !== undefined) {
    const n = String(botNumber).replace(/[^0-9]/g, '');
    if (n.length < 8) return res.status(400).json({ error: 'Nomor bot tidak valid.' });
    patch.platformBotNumber = n;
  }

  if (amPrice !== undefined) {
    const p = toInt(amPrice);
    if (!(p > 0)) return res.status(400).json({ error: 'Harga AntiMaling harus lebih dari 0.' });
    patch.amPrice = p;
  }

  if (dana !== undefined) {
    const d = String(dana).replace(/[^0-9]/g, '');
    if (d.length < 8) return res.status(400).json({ error: 'Nomor DANA tidak valid.' });
    patch.dana = d;
  }

  db.updateSettings(patch);
  res.json({ ok: true, products: getRawProducts(), planPrices: getPlanPrices(), botPrices: getBotPrices(), botNumber: getBotNumber(), amPrice: getAmPrice(), dana: getDanaNumber() });
});

app.get('/api/admin/antimaling-devices', requireOwner, (req, res) => {
  const all = db.readDb();
  const users = new Map(all.users.map(u => [u.id, u]));
  const devices = [...all.amDevices].reverse().map(d => {
    const u = users.get(d.userId);
    return { ...d, apiKey: undefined, userName: u ? u.name : '(akun tidak ditemukan: ' + d.userId + ')', userEmail: u ? u.email : '-' };
  });
  res.json({ devices, totalUsers: all.users.length });
});

app.get('/api/admin/orders', requireOwner, (req, res) => {
  const all = db.readDb();
  const users = new Map(all.users.map(u => [u.id, u]));
  const orders = [...all.orders]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 100)
    .map(o => {
      const u = users.get(o.userId);
      return { ...o, userName: u ? u.name : '-', userEmail: u ? u.email : '-' };
    });
  res.json({ orders });
});

app.post('/api/admin/orders/settle', requireOwner, (req, res) => {
  const { orderId, action } = req.body || {};
  if (!['ok', 'no'].includes(action)) return res.status(400).json({ error: 'Aksi tidak dikenali.' });
  const order = db.findOrderByOrderId(orderId || '');
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  const result = settleOrder(order, action);
  if (!result.ok) return res.status(409).json({ error: result.note });
  res.json({ ok: true, note: result.note, order });
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
/* AntiMaling: dashboard user (butuh login) + endpoint apk       */
/* (pakai X-Api-Key hasil pairing, BUKAN cookie/token login).    */
/* ---------------------------------------------------------- */

app.get('/api/antimaling/devices', requireAuth, (req, res) => {
  const now = Date.now();
  const devices = db.getAmDevicesForUser(req.user.id).map(d => ({
    ...d, apiKey: undefined,
    online: !!(d.lastSeen && now - new Date(d.lastSeen).getTime() < 10 * 60000),
  }));
  res.json({ devices });
});

app.post('/api/antimaling/devices/remove', requireAuth, (req, res) => {
  const { deviceId } = req.body || {};
  const dev = db.findAmDeviceById(deviceId);
  if (!dev || dev.userId !== req.user.id) return res.status(404).json({ error: 'Device tidak ditemukan.' });
  db.deleteAmDevice(deviceId);
  res.json({ ok: true });
});

app.post('/api/antimaling/command', requireAuth, (req, res) => {
  const { deviceId, type, pin } = req.body || {};
  if (!['lock', 'alarm', 'stop_alarm', 'locate', 'photo', 'wipe'].includes(type)) {
    return res.status(400).json({ error: 'Perintah tidak dikenali.' });
  }
  const dev = db.findAmDeviceById(deviceId);
  if (!dev || dev.userId !== req.user.id || !dev.paired) {
    return res.status(404).json({ error: 'Device tidak ditemukan atau belum pairing.' });
  }
  const cmd = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    deviceId, type, status: 'pending', createdAt: new Date().toISOString(),
  };
  // Perintah "lock" butuh PIN yang dikirim balik ke HP biar bisa dipakai
  // buka kuncinya lagi. Pakai PIN yang diketik di dashboard; kalau kosong,
  // pakai PIN otomatis yang sudah dibuat waktu pairing.
  if (type === 'lock') {
    const typedPin = String(pin || '').trim();
    cmd.pin = typedPin || dev.lockPin || '';
    if (!cmd.pin) return res.status(400).json({ error: 'PIN kunci belum ada untuk device ini.' });
  }
  db.saveAmCommand(cmd);
  res.json({ ok: true });
});

app.get('/api/antimaling/history', requireAuth, (req, res) => {
  const dev = db.findAmDeviceById(req.query.deviceId);
  if (!dev || dev.userId !== req.user.id) return res.status(404).json({ error: 'Device tidak ditemukan.' });
  res.json({ locations: db.getAmLocationsForDevice(dev.id, 100), commands: db.getAmCommandsForDevice(dev.id, 50) });
});

// ----- dipanggil dari apk (HP yang dilindungi), pakai X-Api-Key -----
function findAmByApiKey(req) {
  return db.findAmDeviceByApiKey(req.headers['x-api-key'] || '');
}

app.post('/api/antimaling/pair/claim', (req, res) => {
  const { code } = req.body || {};
  const dev = db.findAmDeviceByPairCode(String(code || ''));
  if (!dev) return res.status(404).json({ error: 'Kode salah, sudah dipakai, atau belum dibayar.' });
  dev.paired = true;
  dev.apiKey = crypto.randomBytes(20).toString('hex');
  dev.pairCode = null;
  if (!dev.lockPin) dev.lockPin = String(Math.floor(1000 + Math.random() * 9000)); // device lama sebelum fitur PIN ada
  dev.lastSeen = new Date().toISOString();
  db.saveAmDevice(dev);
  res.json({ deviceId: dev.id, apiKey: dev.apiKey, name: dev.name, lockPin: dev.lockPin });
});

app.get('/api/antimaling/device/commands', (req, res) => {
  const dev = findAmByApiKey(req);
  if (!dev) return res.status(401).json({ error: 'apiKey tidak valid.' });
  dev.lastSeen = new Date().toISOString(); db.saveAmDevice(dev);
  res.json({ commands: db.getPendingAmCommands(dev.id) });
});

app.post('/api/antimaling/device/ack', (req, res) => {
  const dev = findAmByApiKey(req);
  if (!dev) return res.status(401).json({ error: 'apiKey tidak valid.' });
  const { commandId, result } = req.body || {};
  db.ackAmCommand(commandId, result);
  res.json({ ok: true });
});

app.post('/api/antimaling/device/location', (req, res) => {
  const dev = findAmByApiKey(req);
  if (!dev) return res.status(401).json({ error: 'apiKey tidak valid.' });
  const { lat, lng, accuracy } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Koordinat tidak valid.' });
  const point = { deviceId: dev.id, lat, lng, accuracy: accuracy || null, at: new Date().toISOString() };
  db.addAmLocation(point);
  dev.lastLocation = point; dev.lastSeen = point.at; db.saveAmDevice(dev);
  res.json({ ok: true });
});

app.post('/api/antimaling/device/battery', (req, res) => {
  const dev = findAmByApiKey(req);
  if (!dev) return res.status(401).json({ error: 'apiKey tidak valid.' });
  const { percent, charging } = req.body || {};
  dev.battery = { percent, charging: !!charging, at: new Date().toISOString() };
  dev.lastSeen = dev.battery.at; db.saveAmDevice(dev);
  res.json({ ok: true });
});

const AM_PHOTOS_DIR = path.join(process.env.DATA_DIR || __dirname, 'am-photos');

// Dipanggil apk setelah berhasil ambil foto kamera depan diam-diam (perintah "photo").
// Fotonya ditimpa tiap kali ambil baru, jadi cuma foto terakhir yang tersimpan
// per device — bukan galeri, supaya penyimpanan server tidak membengkak.
app.post('/api/antimaling/device/photo', express.json({ limit: '8mb' }), (req, res) => {
  const dev = findAmByApiKey(req);
  if (!dev) return res.status(401).json({ error: 'apiKey tidak valid.' });
  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'Data foto kosong.' });
  try {
    fs.mkdirSync(AM_PHOTOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(AM_PHOTOS_DIR, dev.id + '.jpg'), Buffer.from(imageBase64, 'base64'));
    dev.lastPhotoAt = new Date().toISOString();
    dev.lastSeen = dev.lastPhotoAt;
    db.saveAmDevice(dev);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Gagal menyimpan foto di server.' });
  }
});

// Dipanggil dashboard (app AllTools) untuk menampilkan foto terakhir. Pakai
// requireAuth (bukan apiKey) supaya cuma pemilik device yang bisa melihatnya.
app.get('/api/antimaling/device/photo/:deviceId', requireAuth, (req, res) => {
  const dev = db.findAmDeviceById(req.params.deviceId);
  if (!dev || dev.userId !== req.user.id) return res.status(404).json({ error: 'Device tidak ditemukan.' });
  const file = path.join(AM_PHOTOS_DIR, dev.id + '.jpg');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Belum ada foto.' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
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
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: message }] }],
      }),
    }
  );
  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error?.message || 'Gagal menghubungi Gemini.');
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return text.trim() || 'Maaf, AI tidak memberi jawaban.';
}

async function handleAiChat(req, res) {
  const { message } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'Pesan wajib diisi.' });
  }
  if (!useQuota(req.user, 'ai')) {
    return res.status(429).json({ error: 'Kuota AI harian habis. Upgrade ke Premium.' });
  }
  try {
    const reply = await askGemini(String(message));
    db.addHistory(req.user.id, 'ai', String(message).slice(0, 60));
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Gagal memproses AI.' });
  }
}
app.post('/api/ai/chat', requireAuth, handleAiChat); // dipakai frontend
app.post('/api/ai', requireAuth, handleAiChat);      // alias

/* ---------------------------------------------------------- */
/* Riwayat (halaman Hasil) dan pengaturan platform              */
/* ---------------------------------------------------------- */

app.get('/api/history', requireAuth, (req, res) => {
  res.json({ history: db.getHistoryForUser(req.user.id, 50) });
});

app.post('/api/history', requireAuth, (req, res) => {
  const { type, label } = req.body || {};
  if (!['download', 'ai', 'enhance', 'convert'].includes(type) || !label) {
    return res.status(400).json({ error: 'Data riwayat tidak valid.' });
  }
  db.addHistory(req.user.id, type, String(label).slice(0, 120));
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => {
  res.json({ settings: { platformBotNumber: getBotNumber() } });
});

app.put('/api/settings', requireOwner, (req, res) => {
  const number = String((req.body || {}).platformBotNumber || '').replace(/[^0-9]/g, '');
  if (number.length < 8) return res.status(400).json({ error: 'Nomor tidak valid.' });
  db.updateSettings({ platformBotNumber: number });
  res.json({ ok: true });
});

/* ---------------------------------------------------------- */
/* Publish website (khusus Premium/Owner): upload 1 file HTML,  */
/* dilayani di /site/<slug>/. Disajikan dengan CSP sandbox      */
/* supaya script di dalamnya tidak bisa menyentuh data server   */
/* ini (misalnya token login admin).                            */
/* ---------------------------------------------------------- */

const SITES_DIR = path.join(process.env.DATA_DIR || __dirname, 'sites');

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {};
  let file = null;
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buf.slice(pos + boundary.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.slice(0, headEnd).toString('utf8');
      const body = part.slice(headEnd + 4);
      const name = /name="([^"]*)"/.exec(head);
      const filename = /filename="([^"]*)"/.exec(head);
      if (name) {
        if (filename) file = { filename: filename[1], data: body };
        else fields[name[1]] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, file };
}

app.post('/api/publish', requireAuth, express.raw({ type: 'multipart/form-data', limit: '2mb' }), (req, res) => {
  if (!['owner', 'pro', 'basic'].includes(req.user.plan)) {
    return res.status(403).json({ error: 'Fitur ini khusus Premium/Owner. Upgrade dulu di halaman Premium.' });
  }
  const parsed = Buffer.isBuffer(req.body) ? parseMultipart(req.body, req.headers['content-type']) : null;
  if (!parsed || !parsed.file) return res.status(400).json({ error: 'File HTML tidak ditemukan.' });
  const slug = String(parsed.fields.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) {
    return res.status(400).json({ error: 'Nama alamat 3-40 karakter: huruf kecil, angka, dan tanda minus.' });
  }
  const existing = db.findSiteBySlug(slug);
  if (existing && existing.userId !== req.user.id) {
    return res.status(409).json({ error: 'Nama alamat sudah dipakai orang lain.' });
  }
  const html = parsed.file.data.toString('utf8');
  if (!html.trim()) return res.status(400).json({ error: 'File kosong.' });
  try {
    fs.mkdirSync(SITES_DIR, { recursive: true });
    fs.writeFileSync(path.join(SITES_DIR, slug + '.html'), html);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menyimpan file di server.' });
  }
  const now = new Date().toISOString();
  db.saveSite({
    slug, userId: req.user.id,
    title: String(parsed.fields.title || slug).slice(0, 80),
    createdAt: existing ? existing.createdAt : now, updatedAt: now,
  });
  res.json({ ok: true, slug, url: '/site/' + slug + '/' });
});

app.get('/api/my-sites', requireAuth, (req, res) => {
  res.json({ sites: db.getSitesForUser(req.user.id) });
});

app.get('/site/:slug', (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) return res.status(404).send('Tidak ditemukan.');
  const file = path.join(SITES_DIR, slug + '.html');
  if (!fs.existsSync(file)) return res.status(404).send('Website tidak ditemukan.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
});

/* ---------------------------------------------------------- */
/* Cek server hidup + jalankan server                          */
/* ---------------------------------------------------------- */

app.get('/', (req, res) => {
  res.json({ ok: true, name: 'alltools-backend' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('alltools-backend jalan di port', PORT);
  pollTelegram();
});
