/**
 * Kirim pesan, info grup, dan menu bot.
 */
const fs = require('fs');
const path = require('path');
const { clip, digits } = require('./util');

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
  // jid nomor asli tiap member (member yang hanya punya ID tersembunyi/LID dilewati)
  const members = md.participants
    .map(p => p.phoneNumber ? digits(p.phoneNumber) + '@s.whatsapp.net' : (String(p.id).endsWith('@s.whatsapp.net') ? p.id : null))
    .filter(Boolean);
  const info = { at: Date.now(), subject: md.subject, admins, members, me: digits(ctx.sock.user && ctx.sock.user.id) };
  ctx.groupCache.set(jid, info);
  return info;
}

/* Menu dikelompokkan per kategori; kategori yang kosong (fiturnya tidak disewa) tidak ditampilkan. */
function menuText(meta) {
  const p = meta.config.prefix, has = f => meta.features.includes(f), isGlobal = meta.mode === 'global';
  const sections = [
    ['📌 *UMUM*', [
      [true, `${p}menu`, 'tampilkan menu ini'],
      [true, `${p}ping`, 'cek bot hidup'],
      [isGlobal, '.status', 'masa sewa & jam aktif bot'],
    ]],
    ['🛍️ *TOKO*', [
      [has('catalog'), `${p}katalog`, 'lihat produk & harga'],
      [has('faq'), `${p}faq`, 'daftar pertanyaan umum'],
      [has('orderbot') && !isGlobal, 'order ...', 'ketik untuk memesan'],
    ]],
    ['🤖 *AI & UNDUH*', [
      [has('ai'), `${p}ai <pertanyaan>`, 'tanya AI'],
      [has('downloader'), `${p}dl <link>`, 'download video TikTok/IG/YouTube'],
    ]],
    ['🎨 *STIKER*', [
      [has('sticker'), `${p}s`, 'kirim/reply gambar atau video jadi stiker'],
      [has('sticker'), `${p}brat <teks>`, 'stiker gaya brat'],
    ]],
    ['👥 *GRUP*', [
      [has('reminder'), `${p}ingatkan <10m|2j|1d> <teks>`, 'pengingat'],
      [has('reminder'), `${p}absen mulai|selesai`, 'buka/tutup absen (admin)'],
      [has('reminder'), `${p}hadir`, 'tandai hadir'],
      [has('reminder'), `${p}absen`, 'lihat daftar hadir'],
      [has('antilink'), 'anti-link', 'link yang dikirim member otomatis dihapus'],
    ]],
    ['👑 *OWNER*', [
      [has('orderbot') && !isGlobal, `${p}pesanan`, 'daftar pesanan'],
      [has('broadcast') && !isGlobal, `${p}bc <teks>`, 'broadcast ke semua yang pernah chat'],
      [has('pushkontak'), `${p}pushkontak <teks>`, isGlobal ? 'kirim pesan pribadi ke semua member grup (dikirim dari nomor acak di pool)' : 'kirim pesan pribadi ke semua member grup (di grup)'],
      [!isGlobal, `${p}pool on|off`, 'izinkan nomor bot ini dipakai Sender Global'],
      [isGlobal, '.lepas', 'lepas bot dari grup ini'],
    ]],
  ];
  const L = [`*${meta.name}*`, `Awalan perintah: ${p}`];
  for (const [title, rows] of sections) {
    const items = rows.filter(r => r[0]).map(r => `• ${r[1]} — ${r[2]}`);
    if (items.length) L.push('', title, ...items);
  }
  return L.join('\n');
}

/* Menu bergambar: foto menu.jpg (taruh di folder yang sama dengan bot-sender.js)
   dikirim sebagai gambar dengan teks menu sebagai caption. Kalau file foto tidak
   ada atau gagal terkirim, otomatis kembali ke menu teks biasa. */
const MENU_IMG = path.join(__dirname, '..', 'menu.jpg');
const CAPTION_MAX = 1000; // caption gambar WhatsApp dijaga pendek; kalau menu lebih panjang, teks dikirim terpisah
let menuImgBuf = null;
function getMenuImage() {
  if (menuImgBuf) return menuImgBuf;
  try { menuImgBuf = fs.readFileSync(MENU_IMG); } catch (e) { menuImgBuf = null; }
  return menuImgBuf;
}

async function sendMenu(ctx, jid, quoted) {
  const text = menuText(ctx.meta);
  const img = getMenuImage();
  if (img) {
    try {
      if (text.length <= CAPTION_MAX) {
        await send(ctx, jid, { image: img, mimetype: 'image/jpeg', caption: text }, quoted);
        return;
      }
      await send(ctx, jid, { image: img, mimetype: 'image/jpeg', caption: '*' + clip(ctx.meta.name, 80) + '*' }, quoted);
      await send(ctx, jid, { text: clip(text, 3500) });
      return;
    } catch (e) {
      console.error('[bot ' + ctx.meta.id + '] gagal kirim gambar menu:', e.message);
    }
  }
  await send(ctx, jid, { text: clip(text, 3500) }, quoted);
}

module.exports = { send, groupInfo, menuText, sendMenu };
