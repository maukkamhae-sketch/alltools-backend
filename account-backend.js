// Bantuan akun untuk Owner (dipakai dari tab "Akun" di /admin):
// cari akun, lihat detail, reset password, ganti nama/email, atur paket/titel,
// keluarkan dari semua perangkat, dan buat ulang akun yang datanya hilang.
// Semua endpoint khusus Owner dan setiap perubahan dicatat di riwayat tindakan.
const bcrypt = require('bcryptjs');

const PLANS = ['free', 'basic', 'pro'];
const TITLES = ['PREMIUM', 'VIP', 'RESELLER', 'CO-ADMIN', 'ADMIN']; // sama dengan TITLE_META di server.js
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
const ownerEmail = () => (process.env.OWNER_EMAIL || '').toLowerCase();

function registerAccountAdmin(app, { db, requireOwner }) {
  const safe = (u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, roleBadge: u.roleBadge || '', createdAt: u.createdAt || null });
  const list = (v) => (Array.isArray(v) ? v : []);

  function audit(action, userId, note) {
    const l = list(db.getSettings().accountAudit);
    l.push({ ts: Date.now(), action, userId, note: String(note || '').slice(0, 200) });
    db.updateSettings({ accountAudit: l.slice(-300) });
  }

  // Trial dari kode redeem dihapus kalau Owner mengatur manual, supaya tidak "dikembalikan" otomatis nanti.
  function dropGrants(userId, type) {
    const g = list(db.getSettings().redeemGrants);
    const rest = g.filter(x => !(x.userId === userId && x.type === type));
    if (rest.length !== g.length) db.updateSettings({ redeemGrants: rest });
  }

  // Akun Owner tidak boleh diubah lewat panel ini.
  function target(req, res) {
    const u = db.findUserById(req.params.id);
    if (!u) { res.status(404).json({ error: 'Akun tidak ditemukan.' }); return null; }
    if (u.plan === 'owner') { res.status(403).json({ error: 'Akun Owner tidak bisa diubah dari sini.' }); return null; }
    return u;
  }

  // ---- cari akun: nama / email / ID akun / ID pesanan ----
  app.get('/api/admin/accounts', requireOwner, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.status(400).json({ error: 'Ketik minimal 2 huruf.' });
    const users = db.getAllUsers();
    const hits = users.filter(u => [u.id, u.name, u.email].some(v => String(v || '').toLowerCase().includes(q)));
    try {
      const o = list(db.readDb().orders).find(x => String(x.orderId || '').toLowerCase() === q);
      const u = o && db.findUserById(o.userId);
      if (u && !hits.some(h => h.id === u.id)) hits.unshift(u);
    } catch (e) { /* abaikan, pencarian biasa tetap jalan */ }
    res.json({ total: users.length, accounts: hits.slice(0, 20).map(safe) });
  });

  // ---- buat ulang akun (data benar-benar hilang) ----
  app.post('/api/admin/accounts/create', requireOwner, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    const email = String(b.email || '').trim();
    const password = String(b.password || '');
    const plan = PLANS.includes(b.plan) ? b.plan : 'free';
    const title = String(b.roleBadge || '').toUpperCase();
    if (!name) return res.status(400).json({ error: 'Nama wajib diisi.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Format email tidak valid.' });
    if (email.toLowerCase() === ownerEmail()) return res.status(400).json({ error: 'Email itu dicadangkan untuk Owner. Daftar biasa lewat app.' });
    if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'Password 6-72 karakter.' });
    if (title && !TITLES.includes(title)) return res.status(400).json({ error: 'Titel tidak dikenali.' });
    const passwordHash = await bcrypt.hash(password, 10);
    if (db.findUserByEmail(email)) return res.status(409).json({ error: 'Email itu sudah terdaftar. Cari akunnya di kotak pencarian, lalu reset passwordnya.' });
    const user = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name, email, passwordHash, plan,
      quota: { date: db.todayStr(), downloads: 0, ai: 0, enhance: 0, convert: 0 },
      createdAt: new Date().toISOString(),
    };
    if (title) user.roleBadge = title;
    db.saveUser(user);
    audit('buat-ulang', user.id, 'Akun dibuat ulang: ' + email + ', paket ' + plan + (title ? ', titel ' + title : ''));
    res.json({ ok: true, account: safe(user) });
  });

  // ---- detail ----
  app.get('/api/admin/accounts/:id', requireOwner, (req, res) => {
    const u = db.findUserById(req.params.id);
    if (!u) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    let orders = [];
    try { orders = list(db.getOrdersForUser(u.id)); } catch (e) {}
    orders = [...orders]
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 15)
      .map(o => ({ orderId: o.orderId, type: o.type, status: o.status, price: o.price, createdAt: o.createdAt,
        label: o.productLabel || o.itemName || o.botName || o.deviceLabel || o.plan || o.type }));
    let bots = 0, devices = 0;
    try { bots = list(db.getBotsForUser(u.id)).length; } catch (e) {}
    try { devices = list(db.getAmDevicesForUser(u.id)).length; } catch (e) {}
    const s = db.getSettings();
    const grants = list(s.redeemGrants).filter(g => g.userId === u.id).map(g => ({ type: g.type, value: g.value, expiresAt: g.expiresAt }));
    const log = list(s.accountAudit).filter(a => a.userId === u.id).slice(-10).reverse();
    res.json({ account: safe(u), isOwner: u.plan === 'owner', orders, bots, devices, grants, log });
  });

  // ---- reset password (sekaligus keluarkan semua perangkat) ----
  app.post('/api/admin/accounts/:id/password', requireOwner, async (req, res) => {
    const pw = String((req.body || {}).password || '');
    if (pw.length < 6 || pw.length > 72) return res.status(400).json({ error: 'Password 6-72 karakter.' });
    const hash = await bcrypt.hash(pw, 10);
    const u = target(req, res); if (!u) return;
    u.passwordHash = hash;
    u.tokensRevokedAt = Date.now();
    db.saveUser(u);
    audit('password', u.id, 'Password direset, semua perangkat dikeluarkan');
    res.json({ ok: true });
  });

  // ---- ganti nama / email ----
  app.post('/api/admin/accounts/:id/profile', requireOwner, (req, res) => {
    const u = target(req, res); if (!u) return;
    const b = req.body || {};
    const notes = [];
    if (b.name !== undefined) {
      const n = String(b.name).trim().slice(0, 60);
      if (!n) return res.status(400).json({ error: 'Nama tidak boleh kosong.' });
      if (n !== u.name) { notes.push('nama "' + u.name + '" → "' + n + '"'); u.name = n; }
    }
    if (b.email !== undefined) {
      const e = String(b.email).trim();
      if (!isEmail(e)) return res.status(400).json({ error: 'Format email tidak valid.' });
      if (e.toLowerCase() === ownerEmail()) return res.status(400).json({ error: 'Email itu dicadangkan untuk Owner.' });
      const other = db.findUserByEmail(e);
      if (other && other.id !== u.id) return res.status(409).json({ error: 'Email itu sudah dipakai akun lain.' });
      if (e !== u.email) { notes.push('email ' + u.email + ' → ' + e); u.email = e; }
    }
    if (!notes.length) return res.json({ ok: true, unchanged: true, account: safe(u) });
    db.saveUser(u);
    audit('profil', u.id, 'Ubah ' + notes.join('; '));
    res.json({ ok: true, account: safe(u) });
  });

  // ---- atur paket (permanen) ----
  app.post('/api/admin/accounts/:id/plan', requireOwner, (req, res) => {
    const u = target(req, res); if (!u) return;
    const plan = String((req.body || {}).plan || '');
    if (!PLANS.includes(plan)) return res.status(400).json({ error: 'Paket harus free, basic, atau pro.' });
    const before = u.plan;
    u.plan = plan;
    db.saveUser(u);
    dropGrants(u.id, 'plan');
    audit('paket', u.id, 'Paket ' + before + ' → ' + plan + ' (permanen)');
    res.json({ ok: true, account: safe(u) });
  });

  // ---- atur titel (permanen; kosong = lepas titel) ----
  app.post('/api/admin/accounts/:id/title', requireOwner, (req, res) => {
    const u = target(req, res); if (!u) return;
    const t = String((req.body || {}).roleBadge || '').toUpperCase();
    if (t && !TITLES.includes(t)) return res.status(400).json({ error: 'Titel tidak dikenali.' });
    const before = u.roleBadge || '-';
    u.roleBadge = t;
    db.saveUser(u);
    dropGrants(u.id, 'role');
    audit('titel', u.id, 'Titel ' + before + ' → ' + (t || '-') + ' (permanen)');
    res.json({ ok: true, account: safe(u) });
  });

  // ---- keluarkan dari semua perangkat (akun dibobol / HP hilang) ----
  app.post('/api/admin/accounts/:id/logout', requireOwner, (req, res) => {
    const u = target(req, res); if (!u) return;
    u.tokensRevokedAt = Date.now();
    db.saveUser(u);
    audit('logout-semua', u.id, 'Semua perangkat dikeluarkan');
    res.json({ ok: true });
  });
}

module.exports = { registerAccountAdmin };
