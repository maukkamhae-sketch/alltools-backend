// Kode redeem AllTools.
// - kind "discount": user klaim kode -> diskon otomatis terpakai di pembelian berikutnya
// - kind "plan"    : user klaim kode -> paket (basic/pro) langsung aktif (PERMANEN)
// Data disimpan di db.getSettings().redeemCodes dan .redeemClaims (ikut volume /data).
const fs = require('fs');
const path = require('path');

const PLAN_RANK = { free: 0, basic: 1, pro: 2, owner: 3 };
const ORDER_TYPES = ['premium', 'antimaling', 'shop', 'bot', 'pulsa'];
const RESERVE_MS = 24 * 3600 * 1000; // diskon "ditahan" untuk 1 pesanan selama 24 jam
const MIN_PRICE = 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa O/0/I/1

function registerRedeem(app, { db, requireAuth, requireOwner }) {
  const codes = () => { const r = db.getSettings().redeemCodes; return Array.isArray(r) ? r : []; };
  const claims = () => { const r = db.getSettings().redeemClaims; return Array.isArray(r) ? r : []; };
  const saveCodes = (l) => db.updateSettings({ redeemCodes: l });
  const saveClaims = (l) => db.updateSettings({ redeemClaims: l.slice(-5000) });
  const norm = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');
  const rupiah = (n) => 'Rp ' + Number(n).toLocaleString('id-ID');

  function genCode() {
    const existing = new Set(codes().map(c => c.code));
    for (let i = 0; i < 50; i++) {
      let s = '';
      for (let j = 0; j < 8; j++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      if (!existing.has(s)) return s;
    }
    return 'X' + Date.now().toString(36).toUpperCase();
  }

  function describe(c) {
    if (c.kind === 'plan') return 'Paket ' + c.plan + ' gratis';
    const parts = [c.percent ? c.percent + '%' : rupiah(c.amount)];
    if (c.percent && c.maxDiscount) parts.push('maks ' + rupiah(c.maxDiscount));
    return 'Diskon ' + parts.join(' ');
  }

  function isExpired(c) { return c.expiresAt && Date.now() > new Date(c.expiresAt).getTime(); }

  // ---- batas percobaan klaim: 10 / menit / user (cegah tebak-tebak kode) ----
  const buckets = new Map();
  function allowAttempt(userId) {
    const now = Date.now();
    let b = buckets.get(userId);
    if (!b || now > b.resetAt) { b = { n: 0, resetAt: now + 60000 }; buckets.set(userId, b); }
    return ++b.n <= 10;
  }

  // ---- klaim ----
  app.post('/api/redeem/claim', requireAuth, (req, res) => {
    if (!allowAttempt(req.user.id)) return res.status(429).json({ error: 'Terlalu banyak percobaan, tunggu semenit.' });
    const code = norm(req.body && req.body.code);
    if (!code) return res.status(400).json({ error: 'Masukkan kode dulu.' });

    const list = codes();
    const c = list.find(x => x.code === code);
    if (!c || !c.active || isExpired(c)) return res.status(404).json({ error: 'Kode tidak valid atau sudah tidak berlaku.' });
    if (c.maxUses > 0 && c.uses >= c.maxUses) return res.status(410).json({ error: 'Kuota kode ini sudah habis.' });
    if ((c.usedBy || []).includes(req.user.id)) return res.status(409).json({ error: 'Kamu sudah pernah memakai kode ini.' });

    if (c.kind === 'plan') {
      const user = db.findUserById(req.user.id);
      if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan.' });
      if (user.plan === 'owner' || (PLAN_RANK[user.plan] || 0) >= (PLAN_RANK[c.plan] || 0)) {
        return res.status(400).json({ error: 'Paketmu sudah sama atau lebih tinggi dari hadiah kode ini.' });
      }
      user.plan = c.plan;
      db.saveUser(user);
      c.uses = (c.uses || 0) + 1; c.usedBy = [...(c.usedBy || []), req.user.id];
      saveCodes(list);
      return res.json({ ok: true, kind: 'plan', message: 'Berhasil! Paket ' + c.plan + ' sudah aktif di akunmu.' });
    }

    // diskon: simpan sebagai klaim, dipakai otomatis saat beli
    const mine = claims().filter(x => x.userId === req.user.id && !x.usedOrderId);
    if (mine.some(x => x.code === code)) return res.status(409).json({ error: 'Kode ini sudah kamu klaim, tinggal dipakai saat beli.' });
    c.uses = (c.uses || 0) + 1; c.usedBy = [...(c.usedBy || []), req.user.id];
    saveCodes(list);
    const all = claims();
    all.push({ userId: req.user.id, code, claimedAt: new Date().toISOString(), usedOrderId: null, reservedOrderId: null, reservedAt: 0 });
    saveClaims(all);
    res.json({ ok: true, kind: 'discount', message: describe(c) + ' berhasil diklaim. Otomatis terpotong di pembelian berikutnya.' });
  });

  // diskon aktif milik user
  app.get('/api/redeem/mine', requireAuth, (req, res) => {
    const byCode = new Map(codes().map(c => [c.code, c]));
    const items = claims()
      .filter(x => x.userId === req.user.id && !x.usedOrderId)
      .map(x => ({ x, c: byCode.get(x.code) }))
      .filter(({ c }) => c && c.active && !isExpired(c))
      .map(({ x, c }) => ({ code: x.code, text: describe(c), appliesTo: c.appliesTo || [], expiresAt: c.expiresAt || null }));
    res.json({ items });
  });

  // ---- dipakai server.js saat membuat order ----
  function claimUsable(cl) {
    if (cl.usedOrderId) return false;
    if (!cl.reservedOrderId) return true;
    const o = db.findOrderByOrderId(cl.reservedOrderId);
    if (!o || o.status === 'failed') return true;
    if (o.status === 'paid') return false;
    return Date.now() - (cl.reservedAt || 0) > RESERVE_MS;
  }

  function calc(c, price) {
    let disc = c.percent ? Math.floor(price * c.percent / 100) : (c.amount || 0);
    if (c.percent && c.maxDiscount) disc = Math.min(disc, c.maxDiscount);
    disc = Math.max(0, Math.min(disc, price - MIN_PRICE));
    return disc;
  }

  function applyPromo(userId, type, price) {
    const byCode = new Map(codes().map(c => [c.code, c]));
    let best = null;
    for (const cl of claims()) {
      if (cl.userId !== userId || !claimUsable(cl)) continue;
      const c = byCode.get(cl.code);
      if (!c || c.kind !== 'discount' || !c.active || isExpired(c)) continue;
      if ((c.appliesTo || []).length && !c.appliesTo.includes(type)) continue;
      const disc = calc(c, price);
      if (disc > 0 && (!best || disc > best.discount)) best = { code: c.code, discount: disc, price: price - disc };
    }
    return best;
  }

  function reserve(userId, code, orderId) {
    const all = claims();
    const cl = all.find(x => x.userId === userId && x.code === code && !x.usedOrderId);
    if (!cl) return;
    cl.reservedOrderId = orderId; cl.reservedAt = Date.now();
    saveClaims(all);
  }

  function onSettle(order, action) {
    if (!order || !order.promoCode) return;
    const all = claims();
    const cl = all.find(x => x.userId === order.userId && x.code === order.promoCode && x.reservedOrderId === order.orderId);
    if (!cl) return;
    if (action === 'ok') cl.usedOrderId = order.orderId;
    else { cl.reservedOrderId = null; cl.reservedAt = 0; } // ditolak -> diskon dikembalikan
    saveClaims(all);
  }

  // ---- admin ----
  app.get('/api/admin/redeem', requireOwner, (req, res) => {
    res.json({ codes: codes().map(c => ({ ...c, usedBy: undefined, usedCount: (c.usedBy || []).length, label: describe(c), expired: !!isExpired(c) })).reverse() });
  });

  app.post('/api/admin/redeem', requireOwner, (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'plan' ? 'plan' : 'discount';
    const list = codes();
    let code = norm(b.code);
    if (code) {
      if (!/^[A-Z0-9_-]{3,24}$/.test(code)) return res.status(400).json({ error: 'Kode 3-24 karakter: huruf, angka, - atau _.' });
      if (list.some(c => c.code === code)) return res.status(409).json({ error: 'Kode itu sudah ada.' });
    } else code = genCode();

    const item = {
      code, kind, active: true, uses: 0, usedBy: [], createdAt: new Date().toISOString(),
      maxUses: Math.max(0, Math.min(1000000, parseInt(b.maxUses, 10) || 0)), // 0 = tanpa batas
      expiresAt: null, note: String(b.note || '').slice(0, 80),
    };
    if (b.expiresAt) {
      const t = new Date(b.expiresAt);
      if (isNaN(t.getTime())) return res.status(400).json({ error: 'Tanggal kedaluwarsa tidak valid.' });
      item.expiresAt = t.toISOString();
    }
    if (kind === 'plan') {
      if (!['basic', 'pro'].includes(b.plan)) return res.status(400).json({ error: 'Pilih paket basic atau pro.' });
      item.plan = b.plan;
    } else {
      const percent = Number(b.percent) || 0, amount = Number(b.amount) || 0;
      if (percent && amount) return res.status(400).json({ error: 'Isi persen ATAU nominal, jangan dua-duanya.' });
      if (percent) {
        if (percent < 1 || percent > 90) return res.status(400).json({ error: 'Persen diskon 1-90.' });
        item.percent = Math.floor(percent);
        item.maxDiscount = Math.max(0, Math.floor(Number(b.maxDiscount) || 0));
      } else if (amount >= 500) item.amount = Math.floor(amount);
      else return res.status(400).json({ error: 'Isi persen diskon atau nominal minimal Rp 500.' });
      const ap = Array.isArray(b.appliesTo) ? b.appliesTo.filter(t => ORDER_TYPES.includes(t)) : [];
      item.appliesTo = ap; // kosong = semua jenis pembelian
    }
    list.push(item);
    saveCodes(list);
    res.json({ ok: true, code: item.code });
  });

  app.put('/api/admin/redeem/:code', requireOwner, (req, res) => {
    const list = codes();
    const c = list.find(x => x.code === norm(req.params.code));
    if (!c) return res.status(404).json({ error: 'Kode tidak ditemukan.' });
    c.active = !!(req.body && req.body.active);
    saveCodes(list);
    res.json({ ok: true });
  });

  app.delete('/api/admin/redeem/:code', requireOwner, (req, res) => {
    const code = norm(req.params.code);
    const list = codes();
    if (!list.some(x => x.code === code)) return res.status(404).json({ error: 'Kode tidak ditemukan.' });
    saveCodes(list.filter(x => x.code !== code));
    res.json({ ok: true });
  });

  // halaman admin sendiri (login dengan akun Owner)
  app.get('/admin/redeem', (req, res) => {
    const f = path.join(__dirname, 'redeem-admin.html');
    if (!fs.existsSync(f)) return res.status(404).send('redeem-admin.html belum diunggah ke repo.');
    res.sendFile(f);
  });

  return { applyPromo, reserve, onSettle };
}

module.exports = { registerRedeem };
