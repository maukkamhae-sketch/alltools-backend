/**
 * Bot Sender — tiap bot sewaan punya nomor WhatsApp (sender) sendiri.
 *
 * Alur user:  sewa -> bayar -> dikonfirmasi -> buka menu Bot -> "Pasang Sender"
 *             (masukkan nomor WA) -> dapat kode pairing -> masukkan kode di
 *             WhatsApp (Perangkat tertaut > Tautkan dengan nomor telepon) -> bot langsung jalan.
 *
 * Pasang di server.js:
 *   const { registerBotSender } = require('./bot-sender');
 *   registerBotSender(app, { db, requireAuth, askAI: askGemini });
 *
 * Dependency:  npm i @whiskeysockets/baileys pino sharp
 * Fitur sticker: sharp (gambar & .brat). Sticker dari video butuh ffmpeg di server.
 * .brat butuh font di server (mis. DejaVu / Liberation) supaya teks tampil.
 * Wajib ada di server untuk fitur downloader: yt-dlp (sudah dipakai fitur Downloader).
 *
 * Endpoint (semua butuh login, hanya pemilik bot):
 *   GET  /api/bots/:id/sender        status sender + config + pesanan terakhir
 *   POST /api/bots/:id/sender/pair   {phone}  -> {code}   minta kode pairing
 *   POST /api/bots/:id/sender/stop   lepas sender (logout WhatsApp + hapus sesi)
 *   PUT  /api/bots/:id/config        simpan pengaturan fitur
 *
 * Semua data sender (sesi, pengaturan, pesanan, reminder) disimpan di
 * DATA_DIR/bot-sessions/<botId>/ supaya tidak bergantung pada bentuk db.js.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(process.env.DATA_DIR || __dirname, 'bot-sessions');
const MAX_SESSIONS = Number(process.env.BOT_MAX_SESSIONS) || 30;
const AI_DAILY_CAP = Number(process.env.BOT_AI_DAILY_CAP) || 200;
const LINK_RE = /(https?:\/\/|www\.|chat\.whatsapp\.com\/)\S+/i;

const ALL_FEATURES = ['autoreply', 'welcome', 'catalog', 'broadcast', 'antilink', 'reminder', 'orderbot', 'faq', 'ai', 'downloader', 'sticker'];

/* ---------------------------------------------------------- */
/* Config & util                                              */
/* ---------------------------------------------------------- */
function defaultConfig() {
  return {
    prefix: '.',
    owners: [],
    aiPrompt: '',
    autoreply: { rules: [], fallback: '' },
    welcome: { text: 'Selamat datang @user di @group! 🎉 Baca deskripsi grup ya.' },
    catalog: { title: 'Katalog', items: [] },
    antilink: { kick: false },
    faq: [],
    orderbot: { keywords: ['order', 'pesan', 'beli', 'mau beli'], reply: 'Terima kasih! Pesananmu sudah kami catat ✅ Admin akan segera menghubungi.' },
  };
}
function defaultData() {
  return { orders: [], reminders: [], contacts: [], absen: {}, warns: {}, ai: { day: '', n: 0 } };
}
const digits = j => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isExpired = meta => !meta.expiresAt || new Date(meta.expiresAt).getTime() <= Date.now();
const rp = v => {
  const n = Number(String(v).replace(/[^\d]/g, ''));
  return n > 0 && /^[\d.,\s]*$|^rp/i.test(String(v).trim()) ? 'Rp ' + n.toLocaleString('id-ID') : String(v || '');
};

function cleanConfig(input, old) {
  const c = { ...defaultConfig(), ...(old || {}) };
  const i = input || {};
  if (i.prefix !== undefined) { const p = clip(i.prefix, 1).trim(); c.prefix = p && !/[a-z0-9\s]/i.test(p) ? p : '.'; }
  if (Array.isArray(i.owners)) c.owners = [...new Set(i.owners.map(digits).filter(n => n.length >= 8 && n.length <= 15))].slice(0, 5);
  if (i.aiPrompt !== undefined) c.aiPrompt = clip(i.aiPrompt, 600);
  if (i.autoreply) {
    const rules = Array.isArray(i.autoreply.rules) ? i.autoreply.rules : c.autoreply.rules;
    c.autoreply = {
      rules: rules.map(r => ({ k: clip(r && r.k, 60).trim(), r: clip(r && r.r, 800).trim() })).filter(r => r.k && r.r).slice(0, 50),
      fallback: i.autoreply.fallback !== undefined ? clip(i.autoreply.fallback, 800) : c.autoreply.fallback,
    };
  }
  if (i.welcome && i.welcome.text !== undefined) c.welcome = { text: clip(i.welcome.text, 800) || defaultConfig().welcome.text };
  if (i.catalog) {
    const items = Array.isArray(i.catalog.items) ? i.catalog.items : c.catalog.items;
    c.catalog = {
      title: clip(i.catalog.title !== undefined ? i.catalog.title : c.catalog.title, 60) || 'Katalog',
      items: items.map(x => ({ name: clip(x && x.name, 80).trim(), price: clip(x && x.price, 30).trim(), desc: clip(x && x.desc, 200).trim() })).filter(x => x.name).slice(0, 60),
    };
  }
  if (i.antilink) c.antilink = { kick: !!i.antilink.kick };
  if (Array.isArray(i.faq)) c.faq = i.faq.map(f => ({ q: clip(f && f.q, 120).trim(), a: clip(f && f.a, 800).trim() })).filter(f => f.q && f.a).slice(0, 60);
  if (i.orderbot) {
    const kw = Array.isArray(i.orderbot.keywords) ? i.orderbot.keywords : c.orderbot.keywords;
    c.orderbot = {
      keywords: kw.map(k => clip(k, 30).trim().toLowerCase()).filter(Boolean).slice(0, 20),
      reply: (i.orderbot.reply !== undefined ? clip(i.orderbot.reply, 800).trim() : c.orderbot.reply) || defaultConfig().orderbot.reply,
    };
  }
  return c;
}

function getText(m) {
  let x = m.message;
  if (!x) return '';
  x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.documentWithCaptionMessage?.message || x;
  return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || '';
}

function parseDuration(s) {
  const m = /^(\d{1,4})(s|m|j|h|d)$/i.exec(String(s || ''));
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = { s: 1000, m: 60000, j: 3600000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  const ms = n * mult;
  return ms >= 10000 && ms <= 30 * 86400000 ? ms : 0;
}

function isSafeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '[::1]') return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
  } catch (e) { return false; }
}

function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}
function findFaq(faq, text) {
  const t = String(text).toLowerCase();
  const tw = new Set(tokens(text));
  let best = null, bestScore = 0;
  for (const f of faq) {
    const q = f.q.toLowerCase();
    if (t.includes(q)) return f;
    const qw = tokens(f.q);
    if (!qw.length) continue;
    const hit = qw.filter(w => tw.has(w)).length / qw.length;
    if (hit > bestScore) { bestScore = hit; best = f; }
  }
  return bestScore >= 0.6 ? best : null;
}

/* ---------------------------------------------------------- */
/* Downloader (yt-dlp)                                         */
/* ---------------------------------------------------------- */
function downloadVideo(url) {
  return new Promise((resolve, reject) => {
    const base = path.join(os.tmpdir(), 'botdl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    const proc = spawn('yt-dlp', ['--no-playlist', '--no-warnings', '--max-filesize', '50M', '-f', 'mp4/best[ext=mp4]/best', '-o', base + '.%(ext)s', '--', url]);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120000);
    proc.on('error', () => { clearTimeout(timer); reject(new Error('yt-dlp belum terpasang di server.')); });
    proc.on('close', code => {
      clearTimeout(timer);
      const dir = path.dirname(base), pre = path.basename(base);
      const f = fs.readdirSync(dir).find(n => n.startsWith(pre) && !n.endsWith('.part'));
      if (code !== 0 || !f) return reject(new Error('Gagal download. Link tidak didukung, privat, atau lebih dari 50MB.'));
      resolve(path.join(dir, f));
    });
  });
}


/* ---------------------------------------------------------- */
/* Sticker & Brat                                              */
/* ---------------------------------------------------------- */
const xmlEsc = t => String(t).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function getSharp() {
  try { return require('sharp'); }
  catch (e) { throw new Error('Library sharp belum terpasang di server (npm i sharp).'); }
}

// cari media (gambar/video/sticker) di pesan itu sendiri atau pesan yang di-reply
function findMedia(m) {
  const unwrap = x => x && (x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x);
  const pick = x => {
    x = unwrap(x);
    if (!x) return null;
    if (x.imageMessage) return { type: 'image', node: { imageMessage: x.imageMessage } };
    if (x.videoMessage) return { type: 'video', node: { videoMessage: x.videoMessage }, seconds: Number(x.videoMessage.seconds) || 0 };
    if (x.stickerMessage) return { type: 'sticker', node: { stickerMessage: x.stickerMessage } };
    return null;
  };
  const own = unwrap(m.message);
  const direct = pick(own);
  if (direct) return { ...direct, msg: m };
  const ci = own && (own.extendedTextMessage?.contextInfo || own.imageMessage?.contextInfo || own.videoMessage?.contextInfo);
  const q = ci && pick(ci.quotedMessage);
  if (q) return { ...q, msg: { key: { remoteJid: m.key.remoteJid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: q.node } };
  return null;
}
function quotedText(m) {
  const x = m.message?.ephemeralMessage?.message || m.message;
  const q = x && x.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q) return '';
  return q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || '';
}

async function imageToSticker(buf) {
  const sharp = getSharp();
  return sharp(buf, { animated: false })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
}

function videoToSticker(buf) {
  return new Promise((resolve, reject) => {
    const base = path.join(os.tmpdir(), 'stk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    const inp = base + '.in', out = base + '.webp';
    fs.writeFileSync(inp, buf);
    const clean = () => { fs.unlink(inp, () => {}); fs.unlink(out, () => {}); };
    const proc = spawn('ffmpeg', ['-y', '-i', inp, '-t', '8', '-an', '-vcodec', 'libwebp',
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=12,pad=512:512:-1:-1:color=0x00000000,format=rgba',
      '-loop', '0', '-preset', 'default', '-q:v', '45', '-fs', '900k', out]);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
    proc.on('error', () => { clearTimeout(timer); clean(); reject(new Error('ffmpeg belum terpasang di server, jadi sticker video belum bisa.')); });
    proc.on('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(out)) throw new Error('Gagal membuat sticker dari video.');
        const r = fs.readFileSync(out); clean(); resolve(r);
      } catch (e) { clean(); reject(e); }
    });
  });
}

// gaya "brat": latar hijau lime, teks hitam huruf kecil, agak blur, rata kiri
function wrapBrat(text, size, maxW) {
  const cw = size * 0.5; // perkiraan lebar karakter
  const perLine = Math.max(1, Math.floor(maxW / cw));
  const lines = []; let cur = '';
  for (let w of text.split(/\s+/)) {
    while (w.length > perLine) { // kata terlalu panjang: potong
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, perLine)); w = w.slice(perLine);
    }
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= perLine) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
async function makeBrat(text) {
  const sharp = getSharp();
  const t = clip(text, 200).toLowerCase().replace(/\s+/g, ' ').trim();
  const W = 512, pad = 28, maxW = W - pad * 2;
  let size = 170, lines = wrapBrat(t, size, maxW);
  while (size > 28 && lines.length * size * 1.08 > W - pad * 2) { size -= 6; lines = wrapBrat(t, size, maxW); }
  const tspans = lines.map((l, i) => `<text x="${pad}" y="${pad + size * 0.85 + i * size * 1.08}" font-size="${size}" font-family="Arial Narrow, Arial, Liberation Sans, DejaVu Sans, sans-serif" fill="#000">${xmlEsc(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="100%" height="100%" fill="#8ACF00"/><g filter="url(#b)">${tspans}</g><defs><filter id="b"><feGaussianBlur stdDeviation="1.4"/></filter></defs></svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
}

async function fetchMediaBuffer(ctx, media) {
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  return downloadMediaMessage(media.msg, 'buffer', {}, { logger: require('pino')({ level: 'silent' }), reuploadRequest: ctx.sock.updateMediaMessage });
}

/* ---------------------------------------------------------- */
/* Handler pesan (dipisah dari koneksi supaya bisa dites)       */
/* ---------------------------------------------------------- */
async function send(ctx, jid, content, quoted) {
  const r = await ctx.sock.sendMessage(jid, content, quoted ? { quoted } : undefined);
  if (r && r.key && r.key.id) {
    ctx.sentIds.add(r.key.id);
    if (ctx.sentIds.size > 500) ctx.sentIds.delete(ctx.sentIds.values().next().value);
  }
  return r;
}

async function groupInfo(ctx, jid) {
  const c = ctx.groupCache.get(jid);
  if (c && Date.now() - c.at < 60000) return c;
  const md = await ctx.sock.groupMetadata(jid);
  const admins = md.participants.filter(p => p.admin).map(p => digits(p.phoneNumber || p.id));
  const info = { at: Date.now(), subject: md.subject, admins, me: digits(ctx.sock.user && ctx.sock.user.id) };
  ctx.groupCache.set(jid, info);
  return info;
}

function menuText(meta) {
  const p = meta.config.prefix, has = f => meta.features.includes(f);
  const L = [`*${meta.name}*`, `Perintah yang tersedia:`, `${p}menu — tampilkan menu ini`, `${p}ping — cek bot hidup`];
  if (has('catalog')) L.push(`${p}katalog — lihat produk & harga`);
  if (has('faq')) L.push(`${p}faq — daftar pertanyaan umum`);
  if (has('ai')) L.push(`${p}ai <pertanyaan> — tanya AI`);
  if (has('downloader')) L.push(`${p}dl <link> — download video (TikTok/IG/YouTube dll)`);
  if (has('sticker')) L.push(`${p}s — kirim/reply gambar atau video jadi stiker`, `${p}brat <teks> — stiker gaya brat`);
  if (has('reminder')) L.push(`${p}ingatkan <10m|2j|1d> <teks> — pengingat`, `${p}absen mulai|selesai, ${p}hadir, ${p}absen — absen grup`);
  if (has('orderbot')) L.push(`Ketik "order ..." untuk memesan`, `${p}pesanan — (owner) daftar pesanan`);
  if (has('broadcast')) L.push(`${p}bc <teks> — (owner) broadcast ke semua yang pernah chat`);
  return L.join('\n');
}

async function onMessage(ctx, m) {
  const { meta, sock } = ctx;
  if (!m || !m.message || !m.key) return;
  const jid = m.key.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
  if (ctx.sentIds.has(m.key.id)) return;
  if (isExpired(meta)) return;

  const cfg = meta.config, d = meta.data, p = cfg.prefix;
  const has = f => meta.features.includes(f);
  const text = getText(m).trim();
  const isGroup = jid.endsWith('@g.us');
  const fromMe = !!m.key.fromMe;
  const sender = digits(isGroup ? (m.key.participant || '') : jid);
  const isOwner = fromMe || cfg.owners.includes(sender);
  const reply = (t, extra) => send(ctx, jid, { text: clip(t, 3500), ...(extra || {}) }, m);

  /* --- Anti-link (grup) --- */
  if (isGroup && has('antilink') && !fromMe && text && LINK_RE.test(text)) {
    try {
      const g = await groupInfo(ctx, jid);
      if (g.admins.includes(sender)) return;
      if (g.admins.includes(g.me)) {
        await sock.sendMessage(jid, { delete: m.key });
        const key = jid + ':' + sender;
        d.warns[key] = (d.warns[key] || 0) + 1;
        const n = d.warns[key];
        if (cfg.antilink.kick && n >= 3) {
          await send(ctx, jid, { text: `@${sender} dikeluarkan karena kirim link 3x.`, mentions: [sender + '@s.whatsapp.net'] });
          await sock.groupParticipantsUpdate(jid, [sender + '@s.whatsapp.net'], 'remove');
          delete d.warns[key];
        } else {
          await send(ctx, jid, { text: `⚠️ @${sender} dilarang kirim link di grup ini${cfg.antilink.kick ? ` (peringatan ${n}/3)` : ''}.`, mentions: [sender + '@s.whatsapp.net'] });
        }
        ctx.save();
      }
    } catch (e) { /* bot bukan admin / gagal ambil info grup: abaikan */ }
    return;
  }

  if (!text) return;
  if (fromMe && !text.startsWith(p)) return;

  /* --- simpan kontak (untuk broadcast) --- */
  if (!isGroup && !fromMe && has('broadcast') && jid.endsWith('@s.whatsapp.net') && !d.contacts.includes(jid)) {
    d.contacts.push(jid);
    if (d.contacts.length > 1000) d.contacts.shift();
    ctx.save();
  }

  /* --- perintah --- */
  if (text.startsWith(p)) {
    const parts = text.slice(p.length).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const rest = parts.join(' ').trim();

    if (cmd === 'menu' || cmd === 'help') return reply(menuText(meta));
    if (cmd === 'ping') return reply('Pong! 🏓 Bot aktif.');

    if ((cmd === 'katalog' || cmd === 'produk') && has('catalog')) {
      const items = cfg.catalog.items;
      if (!items.length) return reply('Katalog belum diisi.');
      return reply(`*${cfg.catalog.title}*\n\n` + items.map((x, i) => `${i + 1}. *${x.name}*${x.price ? ' — ' + rp(x.price) : ''}${x.desc ? '\n   ' + x.desc : ''}`).join('\n'));
    }

    if (cmd === 'faq' && has('faq')) {
      if (!cfg.faq.length) return reply('Belum ada FAQ.');
      return reply('*Pertanyaan umum*\nKetik pertanyaannya langsung, nanti dijawab otomatis:\n\n' + cfg.faq.map((f, i) => `${i + 1}. ${f.q}`).join('\n'));
    }

    if (cmd === 'ai' && has('ai')) {
      if (!rest) return reply(`Contoh: ${p}ai apa itu dropship?`);
      if (d.ai.day !== today()) d.ai = { day: today(), n: 0 };
      if (d.ai.n >= AI_DAILY_CAP) return reply('Kuota AI bot ini hari ini sudah habis. Coba lagi besok ya.');
      const last = ctx.cool.get('ai:' + sender) || 0;
      if (Date.now() - last < 5000) return reply('Pelan-pelan ya, tunggu beberapa detik.');
      ctx.cool.set('ai:' + sender, Date.now());
      d.ai.n++; ctx.save();
      try {
        const persona = cfg.aiPrompt ? cfg.aiPrompt + '\n\n' : 'Jawab singkat, jelas, dan ramah dalam Bahasa Indonesia.\n\n';
        return reply(await ctx.askAI(persona + 'Pertanyaan: ' + clip(rest, 1000)));
      } catch (e) { return reply('AI sedang tidak bisa menjawab. Coba lagi nanti.'); }
    }

    if ((cmd === 'dl' || cmd === 'download') && has('downloader')) {
      if (!rest || !isSafeUrl(rest.split(/\s+/)[0])) return reply(`Kirim link yang valid. Contoh: ${p}dl https://vt.tiktok.com/xxxx`);
      if (ctx.downloading >= 2) return reply('Lagi banyak antrean download, coba sebentar lagi.');
      ctx.downloading++;
      await reply('⏳ Lagi download, tunggu ya...');
      let file;
      try {
        file = await downloadVideo(rest.split(/\s+/)[0]);
        await send(ctx, jid, { video: fs.readFileSync(file), caption: 'Selesai ✅' }, m);
      } catch (e) { await reply('❌ ' + e.message); }
      finally { ctx.downloading--; if (file) fs.unlink(file, () => {}); }
      return;
    }

    if ((cmd === 'brat') && has('sticker')) {
      const txt = (rest || quotedText(m)).trim();
      if (!txt) return reply(`Contoh: ${p}brat halo semuanya\nAtau reply sebuah teks lalu ketik ${p}brat`);
      const last = ctx.cool.get('stk:' + sender) || 0;
      if (Date.now() - last < 3000) return reply('Pelan-pelan ya, tunggu beberapa detik.');
      ctx.cool.set('stk:' + sender, Date.now());
      try { return await send(ctx, jid, { sticker: await makeBrat(txt) }, m); }
      catch (e) { return reply('❌ ' + e.message); }
    }

    if ((cmd === 's' || cmd === 'sticker' || cmd === 'stiker') && has('sticker')) {
      const media = findMedia(m);
      if (!media) return reply(`Kirim gambar/video dengan caption ${p}s, atau reply gambar/video lalu ketik ${p}s`);
      if (media.type === 'video' && media.seconds > 10) return reply('Video maksimal 10 detik ya.');
      const last = ctx.cool.get('stk:' + sender) || 0;
      if (Date.now() - last < 3000) return reply('Pelan-pelan ya, tunggu beberapa detik.');
      ctx.cool.set('stk:' + sender, Date.now());
      try {
        const buf = await fetchMediaBuffer(ctx, media);
        if (buf.length > 15 * 1024 * 1024) return reply('File terlalu besar (maks 15MB).');
        const out = media.type === 'video' ? await videoToSticker(buf) : await imageToSticker(buf);
        return await send(ctx, jid, { sticker: out }, m);
      } catch (e) { return reply('❌ ' + (e.message || 'Gagal membuat stiker.')); }
    }

    if (cmd === 'ingatkan' && has('reminder')) {
      const ms = parseDuration(parts[0]);
      const msg = parts.slice(1).join(' ').trim();
      if (!ms || !msg) return reply(`Format: ${p}ingatkan 10m bayar listrik\nSatuan: m = menit, j = jam, d = hari (maks 30 hari).`);
      if (d.reminders.length >= 50) return reply('Terlalu banyak pengingat aktif.');
      d.reminders.push({ jid, who: sender, text: clip(msg, 300), at: Date.now() + ms });
      ctx.save();
      return reply(`✅ Oke, aku ingatkan ${parts[0]} lagi: "${clip(msg, 100)}"`);
    }

    if ((cmd === 'absen' || cmd === 'hadir') && has('reminder')) {
      if (!isGroup) return reply('Absen hanya bisa di grup.');
      const a = d.absen[jid];
      const sub = (parts[0] || '').toLowerCase();
      if (cmd === 'absen' && (sub === 'mulai' || sub === 'selesai')) {
        let admin = isOwner;
        if (!admin) { try { admin = (await groupInfo(ctx, jid)).admins.includes(sender); } catch (e) {} }
        if (!admin) return reply('Hanya admin grup/owner yang bisa membuka/menutup absen.');
        if (sub === 'mulai') { d.absen[jid] = { title: clip(parts.slice(1).join(' '), 60) || 'Absen', names: {} }; ctx.save(); return reply(`📋 *${d.absen[jid].title}* dibuka!\nKetik ${p}hadir untuk absen.`); }
        if (!a) return reply('Belum ada absen yang dibuka.');
        const n = Object.keys(a.names).length;
        delete d.absen[jid]; ctx.save();
        return reply(`📋 *${a.title}* ditutup. Total hadir: ${n}\n` + Object.values(a.names).map((x, i) => `${i + 1}. ${x}`).join('\n'));
      }
      if (!a) return reply(`Belum ada absen. Admin ketik ${p}absen mulai <judul>.`);
      if (cmd === 'hadir') {
        a.names[sender] = clip(m.pushName || sender, 40); ctx.save();
        return reply(`✅ ${a.names[sender]} tercatat hadir (${Object.keys(a.names).length}).`);
      }
      return reply(`📋 *${a.title}*\n` + (Object.values(a.names).map((x, i) => `${i + 1}. ${x}`).join('\n') || 'Belum ada yang hadir.'));
    }

    if (cmd === 'pesanan' && has('orderbot')) {
      if (!isOwner) return;
      if (parts[0] === 'selesai' && Number(parts[1])) {
        const o = d.orders.find(x => x.no === Number(parts[1]));
        if (!o) return reply('Nomor pesanan tidak ditemukan.');
        o.done = true; ctx.save();
        return reply(`✅ Pesanan #${o.no} ditandai selesai.`);
      }
      const open = d.orders.filter(o => !o.done).slice(-15);
      return reply(open.length ? '*Pesanan belum selesai*\n\n' + open.map(o => `#${o.no} — wa.me/${o.from}\n${o.text}`).join('\n\n') + `\n\nTandai selesai: ${p}pesanan selesai <no>` : 'Tidak ada pesanan yang menunggu. 🎉');
    }

    if ((cmd === 'bc' || cmd === 'broadcast') && has('broadcast')) {
      if (!isOwner) return;
      if (!rest) return reply(`Format: ${p}bc isi pesan`);
      if (ctx.broadcasting) return reply('Broadcast sebelumnya masih berjalan.');
      const targets = d.contacts.slice(-200);
      if (!targets.length) return reply('Belum ada kontak yang pernah chat ke bot ini.');
      ctx.broadcasting = true;
      await reply(`📣 Mengirim ke ${targets.length} kontak (pelan-pelan biar aman)...`);
      let ok = 0;
      for (const t of targets) {
        try { await send(ctx, t, { text: clip(rest, 1500) }); ok++; } catch (e) {}
        await sleep(1500 + Math.floor(Math.random() * 1500));
        if (isExpired(meta) || ctx.stopped) break;
      }
      ctx.broadcasting = false;
      return reply(`Broadcast selesai: ${ok}/${targets.length} terkirim.`);
    }
    return; // perintah tidak dikenal: diam saja
  }

  /* --- pesan biasa (chat pribadi) --- */
  if (isGroup || fromMe) return;

  if (has('faq') && cfg.faq.length) {
    const f = findFaq(cfg.faq, text);
    if (f) return reply(f.a);
  }
  if (has('orderbot')) {
    const t = text.toLowerCase();
    if (cfg.orderbot.keywords.some(k => t.includes(k))) {
      const no = (d.orders.length ? d.orders[d.orders.length - 1].no : 0) + 1;
      d.orders.push({ no, from: sender, name: clip(m.pushName, 40), text: clip(text, 500), ts: Date.now(), done: false });
      if (d.orders.length > 300) d.orders = d.orders.slice(-300);
      ctx.save();
      await reply(`${cfg.orderbot.reply}\nNo. pesanan: *#${no}*`);
      // kabari pemilik bot
      const ownerJid = (cfg.owners[0] || digits(sock.user && sock.user.id)) + '@s.whatsapp.net';
      if (ownerJid.split('@')[0] !== sender) send(ctx, ownerJid, { text: `🛒 Pesanan baru #${no}\nDari: wa.me/${sender}\n${clip(text, 400)}` }).catch(() => {});
      return;
    }
  }
  if (has('autoreply')) {
    const t = text.toLowerCase();
    const rule = cfg.autoreply.rules.find(r => t.includes(r.k.toLowerCase()));
    if (rule) {
      const last = ctx.cool.get('ar:' + sender) || 0;
      if (Date.now() - last < 3000) return;
      ctx.cool.set('ar:' + sender, Date.now());
      return reply(rule.r);
    }
    if (cfg.autoreply.fallback) {
      const last = ctx.cool.get('fb:' + sender) || 0;
      if (Date.now() - last < 6 * 3600000) return; // sapaan default maksimal 1x / 6 jam per orang
      ctx.cool.set('fb:' + sender, Date.now());
      return reply(cfg.autoreply.fallback);
    }
  }
}

async function onGroupUpdate(ctx, ev) {
  const { meta } = ctx;
  if (!meta.features.includes('welcome') || isExpired(meta) || ev.action !== 'add') return;
  let name = '';
  try { name = (await groupInfo(ctx, ev.id)).subject; } catch (e) {}
  for (const part of ev.participants || []) {
    const pj = typeof part === 'string' ? part : (part.phoneNumber || part.id);
    const num = digits(pj);
    if (!num || num === digits(ctx.sock.user && ctx.sock.user.id)) continue;
    const txt = meta.config.welcome.text.replace(/@user/g, '@' + num).replace(/@group/g, name || 'grup ini');
    try { await send(ctx, ev.id, { text: txt, mentions: [num + '@s.whatsapp.net'] }); } catch (e) {}
  }
}

/* ---------------------------------------------------------- */
/* Manajemen sesi                                              */
/* ---------------------------------------------------------- */
const runtimes = new Map(); // botId -> ctx

const dirOf = id => path.join(ROOT, String(id).replace(/[^a-zA-Z0-9_-]/g, ''));
function loadMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'meta.json'), 'utf8')); } catch (e) { return null; }
}
function writeMeta(meta) {
  fs.mkdirSync(dirOf(meta.id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(meta.id), 'meta.json'), JSON.stringify(meta));
}
function makeSaver(meta) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(() => { try { writeMeta(meta); } catch (e) {} }, 400); };
}

function syncMeta(bot) {
  // bot = objek dari db (sumber kebenaran untuk nama, fitur, masa sewa)
  let meta = loadMeta(bot.id);
  if (!meta) meta = { id: bot.id, config: defaultConfig(), data: defaultData(), phone: '' };
  meta.userId = bot.userId;
  meta.name = bot.name;
  meta.features = (bot.features || []).filter(f => ALL_FEATURES.includes(f));
  meta.expiresAt = bot.expiresAt;
  meta.config = cleanConfig(meta.config, null);
  meta.data = { ...defaultData(), ...(meta.data || {}) };
  const rt = runtimes.get(bot.id);
  if (rt) { Object.assign(rt.meta, { name: meta.name, features: meta.features, expiresAt: meta.expiresAt }); return rt.meta; }
  writeMeta(meta);
  return meta;
}

async function startSocket(meta, pairPhone) {
  let baileys, pino;
  try { baileys = require('@whiskeysockets/baileys'); pino = require('pino'); }
  catch (e) {
    console.error('[bot-sender] gagal memuat Baileys/pino:', e && e.code, e && e.message);
    const miss = e && e.code === 'MODULE_NOT_FOUND';
    throw new Error((miss ? 'Library Baileys belum terpasang di server (npm i @whiskeysockets/baileys pino).' : 'Library Baileys gagal dimuat di server.') + ' Detail: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200));
  }
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } = baileys;

  const old = runtimes.get(meta.id);
  if (old) { old.stopped = true; try { old.sock.end(undefined); } catch (e) {} }

  const authDir = path.join(dirOf(meta.id), 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let version; try { version = (await fetchLatestBaileysVersion()).version; } catch (e) {}
  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({
    version, logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: false, syncFullHistory: false,
  });
  const ctx = {
    meta, sock, status: 'connecting', code: '', err: '', stopped: false, save: makeSaver(meta),
    askAI: runtimes.askAI, sentIds: new Set(), cool: new Map(), groupCache: new Map(), downloading: 0, broadcasting: false,
  };
  runtimes.set(meta.id, ctx);

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) onMessage(ctx, m).catch(e => console.error('[bot ' + meta.id + ']', e.message));
  });
  sock.ev.on('group-participants.update', ev => onGroupUpdate(ctx, ev).catch(() => {}));
  sock.ev.on('connection.update', async u => {
    if (ctx.stopped) return;
    if (u.connection === 'open') {
      ctx.status = 'connected'; ctx.code = ''; ctx.err = '';
      meta.phone = digits(sock.user && sock.user.id);
      writeMeta(meta);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) {
        ctx.status = 'idle'; ctx.stopped = true; meta.phone = '';
        fs.rmSync(authDir, { recursive: true, force: true }); writeMeta(meta);
        runtimes.delete(meta.id);
      } else if (isExpired(meta)) {
        ctx.status = 'expired'; ctx.stopped = true;
      } else {
        ctx.status = 'connecting';
        await sleep(3000);
        if (!ctx.stopped) startSocket(meta).catch(e => { ctx.err = e.message; });
      }
    }
  });

  if (pairPhone && !state.creds.registered) {
    await new Promise(r => {
      const t = setTimeout(r, 3000);
      sock.ev.on('connection.update', u => { if (u.connection === 'connecting' || u.qr) { clearTimeout(t); r(); } });
    });
    await sleep(500);
    ctx.code = await sock.requestPairingCode(pairPhone);
    ctx.status = 'pairing';
  }
  return ctx;
}

function stopRuntime(id, logout) {
  const ctx = runtimes.get(id);
  if (!ctx) return;
  ctx.stopped = true;
  const done = () => { try { ctx.sock.end(undefined); } catch (e) {} };
  if (logout) ctx.sock.logout().catch(() => {}).finally(done); else done();
  runtimes.delete(id);
}

function publicState(meta) {
  const ctx = runtimes.get(meta.id);
  const o = (meta.data.orders || []).slice(-20).reverse();
  return {
    status: isExpired(meta) ? 'expired' : (ctx ? ctx.status : (meta.phone ? 'connecting' : 'idle')),
    phone: meta.phone || '', code: ctx && ctx.status === 'pairing' ? ctx.code : '', error: ctx ? ctx.err : '',
    features: meta.features, config: meta.config, orders: o,
    stats: { contacts: meta.data.contacts.length, reminders: meta.data.reminders.length, orders: meta.data.orders.length },
  };
}

/* ---------------------------------------------------------- */
/* Registrasi ke Express                                       */
/* ---------------------------------------------------------- */
function registerBotSender(app, opts) {
  const { db, requireAuth } = opts;
  runtimes.askAI = opts.askAI || (async () => { throw new Error('AI belum aktif'); });
  fs.mkdirSync(ROOT, { recursive: true });

  const mine = (req, res) => {
    const bot = db.getBotsForUser(req.user.id).find(b => b.id === req.params.id);
    if (!bot) { res.status(404).json({ error: 'Bot tidak ditemukan.' }); return null; }
    return bot;
  };

  app.get('/api/bots/:id/sender', requireAuth, (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    res.json(publicState(syncMeta(bot)));
  });

  app.post('/api/bots/:id/sender/pair', requireAuth, async (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    const meta = syncMeta(bot);
    if (isExpired(meta)) return res.status(403).json({ error: 'Masa sewa bot sudah habis.' });
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (phone.length < 9 || phone.length > 15 || phone.startsWith('0')) return res.status(400).json({ error: 'Nomor harus format internasional tanpa 0 di depan, contoh 6281234567890.' });
    for (const [id, c] of runtimes) {
      if (id !== bot.id && c.meta && c.meta.phone === phone) return res.status(400).json({ error: 'Nomor ini sudah dipakai bot lain.' });
    }
    const cur = runtimes.get(bot.id);
    if (cur && cur.status === 'connected') return res.status(400).json({ error: 'Sender sudah terhubung. Lepas dulu kalau mau ganti nomor.' });
    if (!cur && [...runtimes.values()].filter(c => !c.stopped).length >= MAX_SESSIONS) return res.status(503).json({ error: 'Server sedang penuh, coba lagi nanti.' });
    try {
      fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true }); // mulai sesi bersih untuk pairing baru
      const ctx = await startSocket(meta, phone);
      res.json({ code: ctx.code });
    } catch (e) {
      stopRuntime(bot.id, false);
      res.status(500).json({ error: e.message || 'Gagal meminta kode pairing.' });
    }
  });

  app.post('/api/bots/:id/sender/stop', requireAuth, (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    const meta = syncMeta(bot);
    stopRuntime(bot.id, true);
    meta.phone = '';
    setTimeout(() => { fs.rmSync(path.join(dirOf(bot.id), 'auth'), { recursive: true, force: true }); writeMeta(meta); }, 1500);
    res.json({ ok: true });
  });

  app.put('/api/bots/:id/config', requireAuth, (req, res) => {
    const bot = mine(req, res); if (!bot) return;
    const meta = syncMeta(bot);
    meta.config = cleanConfig(req.body && req.body.config, meta.config);
    writeMeta(meta);
    res.json({ ok: true, config: meta.config });
  });

  // Pulihkan sender yang sudah pernah terpasang setelah server restart.
  (async () => {
    let ids = [];
    try { ids = fs.readdirSync(ROOT); } catch (e) {}
    for (const id of ids) {
      const meta = loadMeta(id);
      if (!meta || !meta.phone || isExpired(meta)) continue;
      if (!fs.existsSync(path.join(dirOf(id), 'auth', 'creds.json'))) continue;
      try { await startSocket(meta); } catch (e) { console.error('[bot-sender] gagal pulihkan', id, e.message); }
      await sleep(1500);
    }
  })();

  // Scheduler: pengingat jatuh tempo + hentikan bot yang masa sewanya habis.
  setInterval(async () => {
    for (const [id, ctx] of runtimes) {
      if (!ctx || ctx.stopped) continue;
      if (isExpired(ctx.meta)) { ctx.status = 'expired'; stopRuntime(id, false); continue; }
      if (ctx.status !== 'connected' || !ctx.meta.features.includes('reminder')) continue;
      const due = ctx.meta.data.reminders.filter(r => r.at <= Date.now());
      if (!due.length) continue;
      ctx.meta.data.reminders = ctx.meta.data.reminders.filter(r => r.at > Date.now());
      ctx.save();
      for (const r of due) {
        try { await send(ctx, r.jid, { text: `⏰ Pengingat untuk @${r.who}: ${r.text}`, mentions: [r.who + '@s.whatsapp.net'] }); } catch (e) {}
      }
    }
  }, 15000).unref();
}

module.exports = { registerBotSender, __test: { onMessage, onGroupUpdate, cleanConfig, defaultConfig, defaultData, parseDuration, findFaq, isSafeUrl, getText, menuText, findMedia, makeBrat, imageToSticker } };
