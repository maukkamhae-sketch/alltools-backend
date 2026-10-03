/* ---------------------------------------------------------- */
/* Status (24 jam) + Musik Spotify                              */
/*                                                              */
/* Status : teks pendek + (opsional) 1 lagu Spotify. Hilang     */
/*          otomatis setelah 24 jam. Disimpan di settings.statuses */
/* Musik  : cari lagu lewat Spotify Web API (client credentials) */
/*          Pemutaran di app pakai embed resmi Spotify.          */
/*                                                              */
/* Env yang dibutuhkan untuk pencarian lagu (opsional):          */
/*   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET                    */
/* Tanpa env itu, status tetap jalan dan musik tetap bisa        */
/* dipakai lewat tempel link Spotify.                            */
/* ---------------------------------------------------------- */
const fetch = require('node-fetch');

const STATUS_TTL_MS = 24 * 3600 * 1000;
const STATUS_MAX_TOTAL = 300;       // total status aktif yang disimpan
const STATUS_MAX_PER_USER_DAY = 5;  // batas posting per user per 24 jam (Owner bebas)
const TEXT_MAX = 150;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

let spToken = { value: '', exp: 0 };
async function getSpotifyToken() {
  if (spToken.value && Date.now() < spToken.exp - 30_000) return spToken.value;
  const basic = Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Gagal login ke Spotify (cek SPOTIFY_CLIENT_ID / SECRET).');
  spToken = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return spToken.value;
}

// Kunci rate limit sederhana untuk pencarian lagu: userId -> { count, resetAt }
const searchBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of searchBuckets) if (now > b.resetAt) searchBuckets.delete(k);
}, 5 * 60_000).unref();

// Hanya terima ID Spotify yang valid (base62, 22 karakter) supaya tidak bisa disisipi apa pun.
const SP_ID_RE = /^[A-Za-z0-9]{22}$/;
const SP_TYPES = ['track', 'album', 'playlist', 'episode'];

function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const type = SP_TYPES.includes(t.type) ? t.type : 'track';
  const id = String(t.id || '');
  if (!SP_ID_RE.test(id)) return null;
  return {
    type, id,
    title: String(t.title || '').trim().slice(0, 120),
    artist: String(t.artist || '').trim().slice(0, 120),
    cover: /^https:\/\/i\.scdn\.co\//.test(String(t.cover || '')) ? String(t.cover).slice(0, 200) : '',
  };
}

function registerStatusMusic(app, { db, requireAuth }) {
  function allStatuses() {
    const raw = db.getSettings().statuses;
    return Array.isArray(raw) ? raw : [];
  }
  function activeStatuses() {
    const cutoff = Date.now() - STATUS_TTL_MS;
    return allStatuses().filter(s => s && s.ts > cutoff);
  }

  // Daftar status aktif, dikelompokkan per user (terbaru dulu).
  app.get('/api/status', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const items = activeStatuses().sort((a, b) => b.ts - a.ts).map(s => ({
      id: s.id, userId: s.userId, name: s.name, plan: s.plan || 'free',
      text: s.text, track: s.track || null, ts: s.ts,
      mine: String(s.userId) === String(req.user.id),
    }));
    res.json({ items, ttlMs: STATUS_TTL_MS });
  });

  app.post('/api/status', requireAuth, (req, res) => {
    const text = String((req.body && req.body.text) || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
    const track = cleanTrack(req.body && req.body.track);
    if (!text && !track) return res.status(400).json({ error: 'Tulis sesuatu atau pilih lagu dulu.' });

    const list = activeStatuses();
    const mineCount = list.filter(s => String(s.userId) === String(req.user.id)).length;
    if (req.user.plan !== 'owner' && mineCount >= STATUS_MAX_PER_USER_DAY) {
      return res.status(429).json({ error: 'Batas ' + STATUS_MAX_PER_USER_DAY + ' status per 24 jam sudah tercapai. Hapus yang lama atau tunggu dulu.' });
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = {
      id, userId: req.user.id, name: String(req.user.name || 'User').slice(0, 40),
      plan: req.user.plan || 'free', text, track, ts: Date.now(),
    };
    list.push(item);
    db.updateSettings({ statuses: list.slice(-STATUS_MAX_TOTAL) });
    res.json({ ok: true, item: { id, ts: item.ts } });
  });

  app.delete('/api/status/:id', requireAuth, (req, res) => {
    const all = activeStatuses();
    const target = all.find(s => s.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Status tidak ditemukan.' });
    const isMine = String(target.userId) === String(req.user.id);
    if (!isMine && req.user.plan !== 'owner') return res.status(403).json({ error: 'Bukan status kamu.' });
    db.updateSettings({ statuses: all.filter(s => s.id !== req.params.id) });
    res.json({ ok: true });
  });

  // Info apakah pencarian lagu aktif di server ini (frontend pakai ini untuk
  // menampilkan kotak cari atau cukup kotak tempel link).
  app.get('/api/music/config', (req, res) => {
    res.json({ search: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) });
  });

  app.get('/api/music/search', requireAuth, async (req, res) => {
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Pencarian lagu belum aktif di server. Tempel link Spotify saja dulu.' });
    }
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.status(400).json({ error: 'Ketik minimal 2 huruf.' });

    // Maks 20 pencarian / menit / user
    const now = Date.now();
    let b = searchBuckets.get(req.user.id);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60_000 }; searchBuckets.set(req.user.id, b); }
    if (++b.count > 20) return res.status(429).json({ error: 'Terlalu cepat, tunggu sebentar.' });

    try {
      const token = await getSpotifyToken();
      const r = await fetch('https://api.spotify.com/v1/search?type=track&limit=10&q=' + encodeURIComponent(q), {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (r.status === 401) { spToken = { value: '', exp: 0 }; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'Spotify sedang bermasalah, coba lagi.' });
      const items = ((d.tracks && d.tracks.items) || []).map(t => ({
        type: 'track', id: t.id, title: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        cover: (t.album && t.album.images && (t.album.images[1] || t.album.images[0]) || {}).url || '',
      })).filter(t => SP_ID_RE.test(t.id));
      res.json({ items });
    } catch (e) {
      res.status(502).json({ error: e.message || 'Gagal mencari lagu.' });
    }
  });
}

module.exports = { registerStatusMusic };
