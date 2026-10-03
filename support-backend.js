/**
 * Customer Service — modul backend
 *
 *   const { registerSupport } = require('./support-backend');
 *   registerSupport(app, { middleware: requireAuth, authUser: (req) => req.user });
 *
 * Alur:
 *  - User membuka halaman Bantuan, memilih topik -> bot langsung menjawab.
 *  - Topik "Bicara dengan Live Admin" -> status tiket jadi 'live', user bisa chat bebas,
 *    Owner membalas dari tab Bantuan di /admin.
 *
 * Endpoint user (harus login):
 *   GET  /api/support/me?after=<id>   -> { status, topics, messages }
 *   POST /api/support/topic {topic}   -> pilih topik (bot menjawab)
 *   POST /api/support/message {text}  -> kirim pesan (hanya saat status 'live')
 *   POST /api/support/end             -> akhiri chat Live Admin
 * Endpoint Owner:
 *   GET  /api/admin/support                    -> daftar tiket
 *   GET  /api/admin/support/:userId?after=<id> -> isi percakapan
 *   POST /api/admin/support/:userId/reply {text}
 *   POST /api/admin/support/:userId/close
 *
 * Data disimpan di support.json (DATA_DIR kalau diset, supaya awet di Volume Railway).
 */
const fs = require('fs');
const path = require('path');

/* ---------------- Isi topik & jawaban bot (silakan edit teksnya) ---------------- */
const TOPICS = [
  {
    id: 'pembayaran', label: '💳 Error pembayaran',
    answer:
      'Kalau pembayaranmu bermasalah, cek dulu:\n' +
      '1. Transfer harus sesuai nominal yang tampil, ke nomor DANA / QRIS resmi yang ada di halaman Premium.\n' +
      '2. Setelah bayar, tunggu verifikasi. Status pesanan bisa dilihat di halaman Premium atau Hasil.\n' +
      '3. Kalau sudah bayar tapi belum aktif setelah beberapa saat, pilih "Bicara dengan Live Admin" dan kirim bukti transfer.\n\n' +
      '⚠️ Jangan transfer ke nomor lain yang mengaku admin.',
  },
  {
    id: 'premium', label: '👑 Status Premium / role hilang',
    answer:
      'Kalau status Premium atau role akunmu hilang:\n' +
      '1. Keluar lalu masuk lagi memakai email yang sama dengan saat membeli.\n' +
      '2. Buka halaman Premium dan lihat status paketmu.\n' +
      '3. Kalau masih berstatus Free, pilih "Bicara dengan Live Admin" dan sebutkan email akun serta bukti pembayaran.',
  },
  {
    id: 'akun', label: '👤 Akun hilang',
    answer:
      'Kalau akunmu tidak bisa ditemukan:\n' +
      '1. Pastikan mengetik email yang benar (huruf kecil semua).\n' +
      '2. Coba daftar ulang dengan email tersebut. Kalau muncul "Email sudah terdaftar", berarti akunmu ada, coba Masuk.\n' +
      '3. Kalau data benar-benar hilang, pilih "Bicara dengan Live Admin" dan sebutkan email yang dipakai.',
  },
  {
    id: 'login', label: '🔐 Masalah login',
    answer:
      'Masalah login yang sering terjadi:\n' +
      '• "Failed to fetch": server sedang sibuk atau maintenance, atau koneksi internetmu bermasalah. Tunggu sebentar lalu coba lagi.\n' +
      '• "Email atau password salah": cek ulang penulisan, huruf besar-kecil berpengaruh pada password.\n' +
      '• Layar maintenance muncul: app sedang diperbaiki, coba lagi nanti.\n\n' +
      'Kalau masih gagal, pilih "Bicara dengan Live Admin".',
  },
  {
    id: 'antimaling', label: '📱 Masalah AntiMaling',
    answer:
      'Kalau perangkat AntiMaling bermasalah:\n' +
      '1. Pastikan kode pairing dari app dimasukkan ke HP yang dilindungi, lalu tunggu sampai statusnya "Sudah pairing".\n' +
      '2. Beri izin lokasi dan biarkan aplikasi berjalan di latar belakang (matikan penghemat baterai untuk aplikasinya).\n' +
      '3. Pastikan HP yang dilindungi terhubung internet.\n\n' +
      'Kalau perangkat tetap tidak muncul, pilih "Bicara dengan Live Admin".',
  },
  {
    id: 'bot', label: '🤖 Masalah Bot WhatsApp',
    answer:
      'Kalau bot WhatsApp belum tersambung:\n' +
      '1. Buka menu Bot dan ikuti petunjuk PIN yang tampil di layar.\n' +
      '2. Kirim PIN tersebut ke nomor bot pusat yang tertera di app, tanpa mengubah isinya.\n' +
      '3. Pastikan masa sewa botmu masih aktif.\n\n' +
      'Kalau tetap gagal, pilih "Bicara dengan Live Admin".',
  },
  {
    id: 'tos', label: '📜 TOS & Rules',
    answer:
      'Aturan singkat AllTools:\n' +
      '• Gunakan fitur dengan bijak dan sesuai hukum yang berlaku.\n' +
      '• Di Global Chat dilarang kata kasar, spam, dan mengirim link. Pelanggaran mendapat peringatan, lalu dibisukan sementara.\n' +
      '• Dilarang membagikan akun atau menyalahgunakan fitur (misalnya melacak orang tanpa izin).\n' +
      '• Pembayaran dilakukan hanya ke rekening / DANA resmi yang tertera di app.\n\n' +
      'Pelanggaran berat dapat membuat akun dibatasi.',
  },
  {
    id: 'admin', label: '🧑‍💻 Bicara dengan Live Admin', live: true,
    answer:
      'Kamu terhubung ke Live Admin. Tulis masalahmu selengkap mungkin (email akun, apa yang terjadi, dan bukti kalau ada). ' +
      'Admin akan membalas secepatnya, tapi mungkin tidak langsung, jadi tidak perlu menutup halaman ini.',
  },
];

function registerSupport(app, opts) {
  const authUser = opts.authUser;
  const mw = opts.middleware ? [opts.middleware] : [];
  const file = opts.file || path.join(process.env.DATA_DIR || __dirname, 'support.json');
  const MAX_LEN = 500, MAX_KEEP = 300, COOLDOWN_MS = 1000;

  let db = { tickets: {}, nextId: 1 };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(file, JSON.stringify(db), () => {}), 400);
  };
  const lastSend = new Map();
  const isOwner = u => u && u.plan === 'owner';

  function ticketFor(u) {
    let t = db.tickets[u.id];
    if (!t) {
      t = db.tickets[u.id] = { userId: u.id, name: u.name || 'User', email: u.email || '', plan: u.plan || 'free', status: 'bot', messages: [], unreadAdmin: false, updatedAt: Date.now() };
    }
    // data profil bisa berubah (nama/paket), selalu segarkan
    t.name = u.name || t.name; t.email = u.email || t.email; t.plan = u.plan || t.plan;
    return t;
  }
  function addMsg(t, from, text) {
    const m = { id: db.nextId++, from, text, ts: Date.now() };
    t.messages.push(m);
    if (t.messages.length > MAX_KEEP) t.messages = t.messages.slice(-MAX_KEEP);
    t.updatedAt = m.ts;
    return m;
  }
  const cleanText = v => String(v || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_LEN);
  const after = q => parseInt(q, 10) || 0;
  const topicList = () => TOPICS.map(({ id, label, live }) => ({ id, label, live: !!live }));

  /* ---------------- sisi user ---------------- */
  app.get('/api/support/me', ...mw, (req, res) => {
    const u = authUser(req);
    if (!u) return res.status(401).json({ error: 'Masuk dulu.' });
    const t = ticketFor(u);
    const a = after(req.query.after);
    res.json({ status: t.status, topics: topicList(), messages: a > 0 ? t.messages.filter(m => m.id > a) : t.messages.slice(-60) });
  });

  app.post('/api/support/topic', ...mw, (req, res) => {
    const u = authUser(req);
    if (!u) return res.status(401).json({ error: 'Masuk dulu.' });
    const topic = TOPICS.find(x => x.id === (req.body && req.body.topic));
    if (!topic) return res.status(400).json({ error: 'Topik tidak dikenal.' });
    const t = ticketFor(u);
    const out = [addMsg(t, 'user', topic.label), addMsg(t, 'bot', topic.answer)];
    if (topic.live) {
      if (t.status !== 'live') addMsg(t, 'bot', '🟢 Live Admin aktif. Silakan ketik pesanmu di bawah.');
      t.status = 'live';
      t.unreadAdmin = true;
      out.push(t.messages[t.messages.length - 1]);
    }
    save();
    res.json({ status: t.status, messages: out.filter((m, i, a) => a.indexOf(m) === i) });
  });

  app.post('/api/support/message', ...mw, (req, res) => {
    const u = authUser(req);
    if (!u) return res.status(401).json({ error: 'Masuk dulu.' });
    const t = ticketFor(u);
    if (t.status !== 'live') return res.status(400).json({ error: 'Pilih "Bicara dengan Live Admin" dulu untuk chat dengan admin.' });
    const text = cleanText(req.body && req.body.text);
    if (!text) return res.status(400).json({ error: 'Pesan kosong.' });
    const now = Date.now();
    if (now - (lastSend.get(u.id) || 0) < COOLDOWN_MS) return res.status(429).json({ error: 'Pelan-pelan, jangan spam.' });
    lastSend.set(u.id, now);
    const message = addMsg(t, 'user', text);
    t.unreadAdmin = true;
    save();
    res.json({ message });
  });

  app.post('/api/support/end', ...mw, (req, res) => {
    const u = authUser(req);
    if (!u) return res.status(401).json({ error: 'Masuk dulu.' });
    const t = ticketFor(u);
    if (t.status === 'live') {
      addMsg(t, 'bot', 'Chat dengan Live Admin diakhiri. Pilih topik lagi kalau masih butuh bantuan.');
      t.status = 'bot';
      t.unreadAdmin = false;
      save();
    }
    res.json({ status: t.status });
  });

  /* ---------------- sisi Owner ---------------- */
  const ownerOnly = (req, res) => {
    const u = authUser(req);
    if (!u) { res.status(401).json({ error: 'Masuk dulu.' }); return false; }
    if (!isOwner(u)) { res.status(403).json({ error: 'Khusus Owner.' }); return false; }
    return true;
  };

  app.get('/api/admin/support', ...mw, (req, res) => {
    if (!ownerOnly(req, res)) return;
    const list = Object.values(db.tickets)
      .filter(t => t.messages.length)
      .sort((a, b) => (b.status === 'live') - (a.status === 'live') || b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map(t => {
        const last = t.messages[t.messages.length - 1];
        return { userId: t.userId, name: t.name, email: t.email, plan: t.plan, status: t.status, unread: !!t.unreadAdmin, updatedAt: t.updatedAt, last: last ? last.text.slice(0, 80) : '' };
      });
    res.json({ tickets: list, liveCount: list.filter(x => x.status === 'live').length, unreadCount: list.filter(x => x.unread).length });
  });

  app.get('/api/admin/support/:userId', ...mw, (req, res) => {
    if (!ownerOnly(req, res)) return;
    const t = db.tickets[req.params.userId];
    if (!t) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
    const a = after(req.query.after);
    if (t.unreadAdmin) { t.unreadAdmin = false; save(); }
    res.json({ userId: t.userId, name: t.name, email: t.email, plan: t.plan, status: t.status, messages: a > 0 ? t.messages.filter(m => m.id > a) : t.messages.slice(-100) });
  });

  app.post('/api/admin/support/:userId/reply', ...mw, (req, res) => {
    if (!ownerOnly(req, res)) return;
    const t = db.tickets[req.params.userId];
    if (!t) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
    const text = cleanText(req.body && req.body.text);
    if (!text) return res.status(400).json({ error: 'Pesan kosong.' });
    if (t.status !== 'live') t.status = 'live'; // balasan admin membuka chat supaya user bisa menjawab
    const message = addMsg(t, 'admin', text);
    t.unreadAdmin = false;
    save();
    res.json({ message, status: t.status });
  });

  app.post('/api/admin/support/:userId/close', ...mw, (req, res) => {
    if (!ownerOnly(req, res)) return;
    const t = db.tickets[req.params.userId];
    if (!t) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
    addMsg(t, 'bot', 'Admin menutup chat ini. Terima kasih! Pilih topik lagi kalau masih butuh bantuan.');
    t.status = 'bot';
    t.unreadAdmin = false;
    save();
    res.json({ status: t.status });
  });
}

module.exports = { registerSupport, TOPICS };
