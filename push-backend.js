/* ---------------------------------------------------------- */
/* Notifikasi Push (promo/diskon dari Owner)                    */
/*                                                              */
/* Pakai Web Push standar (VAPID), bukan Firebase, jadi tidak   */
/* butuh akun Google/Firebase. Kunci VAPID dibuat otomatis      */
/* sekali lalu disimpan permanen di settings, supaya langganan  */
/* yang sudah ada tidak rusak tiap kali server redeploy.        */
/* ---------------------------------------------------------- */
const webpush = require('web-push');
const crypto = require('crypto');

const SUB_MAX = 20000; // batas wajar jumlah langganan yang disimpan

function ensureVapid(db) {
  const s = db.getSettings();
  if (s.vapidPublicKey && s.vapidPrivateKey) {
    return { publicKey: s.vapidPublicKey, privateKey: s.vapidPrivateKey };
  }
  const keys = webpush.generateVAPIDKeys();
  db.updateSettings({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

function cleanSub(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const endpoint = String(raw.endpoint || '');
  const k = raw.keys || {};
  const p256dh = String(k.p256dh || '');
  const auth = String(k.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return null;
  if (!p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function registerPush(app, { db, requireAuth, requireOwner }) {
  const vapid = ensureVapid(db);
  webpush.setVapidDetails('mailto:support@alltools.app', vapid.publicKey, vapid.privateKey);

  function allSubs() {
    const raw = db.getSettings().pushSubs;
    return Array.isArray(raw) ? raw : [];
  }
  function saveSubs(list) { db.updateSettings({ pushSubs: list.slice(-SUB_MAX) }); }

  // Riwayat pengumuman (maks 30). Dibaca apk Android lewat /api/push/latest karena
  // WebView tidak mendukung Web Push. ID = waktu server (ms), selalu naik.
  function allNotices() {
    const raw = db.getSettings().pushNotices;
    return Array.isArray(raw) ? raw : [];
  }
  function addNotice(n) {
    const list = allNotices();
    let id = Date.now();
    const last = list.length ? list[list.length - 1].id : 0;
    if (id <= last) id = last + 1;
    const item = { id, title: n.title, body: n.body, url: n.url || '' };
    list.push(item);
    db.updateSettings({ pushNotices: list.slice(-30) });
    return item;
  }

  // Publik: apk Android mengecek pengumuman baru tiap beberapa menit.
  // since=0 -> tidak ada pengumuman, hanya mengembalikan 'now' sebagai titik awal.
  app.get('/api/push/latest', (req, res) => {
    const since = Math.max(parseInt(req.query.since, 10) || 0, 0);
    const notices = since > 0 ? allNotices().filter(n => n.id > since).slice(0, 5) : [];
    res.set('Cache-Control', 'no-store');
    res.json({ now: Date.now(), notices });
  });

  // Public: kunci publik VAPID, dibutuhkan browser sebelum subscribe.
  app.get('/api/push/vapid-public-key', (req, res) => {
    res.json({ key: vapid.publicKey });
  });

  app.post('/api/push/subscribe', requireAuth, (req, res) => {
    const sub = cleanSub(req.body && req.body.subscription);
    if (!sub) return res.status(400).json({ error: 'Data langganan tidak valid.' });
    const list = allSubs().filter(s => s.endpoint !== sub.endpoint); // dedupe by endpoint
    list.push({ ...sub, userId: req.user.id, ts: Date.now() });
    saveSubs(list);
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
    const endpoint = String((req.body && req.body.endpoint) || '');
    saveSubs(allSubs().filter(s => s.endpoint !== endpoint));
    res.json({ ok: true });
  });

  app.get('/api/admin/push/count', requireOwner, (req, res) => {
    res.json({ count: allSubs().length });
  });

  // Kirim notifikasi promo ke semua yang sudah subscribe.
  app.post('/api/admin/push/send', requireOwner, async (req, res) => {
    const title = String((req.body && req.body.title) || '').trim().slice(0, 80);
    const body = String((req.body && req.body.body) || '').trim().slice(0, 200);
    const url = String((req.body && req.body.url) || '').trim().slice(0, 300);
    if (!title || !body) return res.status(400).json({ error: 'Judul dan isi notifikasi wajib diisi.' });
    if (url && !/^https:\/\//.test(url)) return res.status(400).json({ error: 'Link harus diawali https://' });

    addNotice({ title, body, url });
    const payload = JSON.stringify({ title, body, url: url || undefined, tag: 'promo-' + Date.now() });
    const list = allSubs();
    let sent = 0, dead = [];
    await Promise.allSettled(list.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
        sent++;
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint); // langganan sudah tidak berlaku
      }
    }));
    if (dead.length) saveSubs(list.filter(s => !dead.includes(s.endpoint)));
    res.json({ ok: true, sent, total: list.length, removed: dead.length });
  });
}

module.exports = { registerPush };
