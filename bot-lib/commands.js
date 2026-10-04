/**
 * Semua perintah bot (.menu, .ai, .dl, .s, ...), satu fungsi per perintah.
 * Daftar COMMANDS di bagian bawah memetakan nama perintah -> fungsi + fitur yang dibutuhkan.
 *
 * Tiap fungsi menerima satu objek `c`:
 *   c.ctx, c.m, c.jid, c.sender, c.isGroup, c.isOwner, c.isGlobal
 *   c.cfg, c.d (data bot), c.p (prefix), c.parts, c.rest, c.reply(teks)
 */
const fs = require('fs');
const { clip, today, sleep, isExpired, isSafeUrl, parseDuration, rp, quotedText, isCooling, markCool, AI_DAILY_CAP } = require('./util');
const { send, groupInfo, sendMenu } = require('./messaging');
const { downloadVideo, findMedia, imageToSticker, videoToSticker, makeBrat, fetchMediaBuffer } = require('./media');

const COOLDOWN_MSG = 'Pelan-pelan ya, tunggu beberapa detik.';

/* ---------- info & katalog ---------- */
const menu = c => sendMenu(c.ctx, c.jid, c.m);
const ping = c => c.reply('Pong! 🏓 Bot aktif.');

function katalog(c) {
  const { items, title } = c.cfg.catalog;
  if (!items.length) return c.reply('Katalog belum diisi.');
  return c.reply(`*${title}*\n\n` + items.map((x, i) => `${i + 1}. *${x.name}*${x.price ? ' — ' + rp(x.price) : ''}${x.desc ? '\n   ' + x.desc : ''}`).join('\n'));
}

function faq(c) {
  if (!c.cfg.faq.length) return c.reply('Belum ada FAQ.');
  return c.reply('*Pertanyaan umum*\nKetik pertanyaannya langsung, nanti dijawab otomatis:\n\n' + c.cfg.faq.map((f, i) => `${i + 1}. ${f.q}`).join('\n'));
}

/* ---------- AI ---------- */
async function ai(c) {
  const { ctx, d, cfg, p, rest, sender } = c;
  if (!rest) return c.reply(`Contoh: ${p}ai apa itu dropship?`);
  if (d.ai.day !== today()) d.ai = { day: today(), n: 0 };
  if (d.ai.n >= AI_DAILY_CAP) return c.reply('Kuota AI bot ini hari ini sudah habis. Coba lagi besok ya.');
  if (isCooling(ctx, 'ai:' + sender, 5000)) return c.reply(COOLDOWN_MSG);
  markCool(ctx, 'ai:' + sender);
  d.ai.n++; ctx.save();
  try {
    const persona = cfg.aiPrompt ? cfg.aiPrompt + '\n\n' : 'Jawab singkat, jelas, dan ramah dalam Bahasa Indonesia.\n\n';
    return c.reply(await ctx.askAI(persona + 'Pertanyaan: ' + clip(rest, 1000)));
  } catch (e) { return c.reply('AI sedang tidak bisa menjawab. Coba lagi nanti.'); }
}

/* ---------- downloader ---------- */
async function download(c) {
  const { ctx, jid, m, p, rest } = c;
  const url = rest.split(/\s+/)[0];
  if (!rest || !isSafeUrl(url)) return c.reply(`Kirim link yang valid. Contoh: ${p}dl https://vt.tiktok.com/xxxx`);
  if (ctx.limits.downloading >= 2) return c.reply('Lagi banyak antrean download, coba sebentar lagi.');
  ctx.limits.downloading++;
  await c.reply('⏳ Lagi download, tunggu ya...');
  let file;
  try {
    file = await downloadVideo(url);
    await send(ctx, jid, { video: fs.readFileSync(file), caption: 'Selesai ✅' }, m);
  } catch (e) { await c.reply('❌ ' + e.message); }
  finally { ctx.limits.downloading--; if (file) fs.unlink(file, () => {}); }
}

/* ---------- stiker ---------- */
async function brat(c) {
  const { ctx, jid, m, p, rest, sender } = c;
  const txt = (rest || quotedText(m)).trim();
  if (!txt) return c.reply(`Contoh: ${p}brat halo semuanya\nAtau reply sebuah teks lalu ketik ${p}brat`);
  if (isCooling(ctx, 'stk:' + sender, 3000)) return c.reply(COOLDOWN_MSG);
  markCool(ctx, 'stk:' + sender);
  try { return await send(ctx, jid, { sticker: await makeBrat(txt) }, m); }
  catch (e) { return c.reply('❌ ' + e.message); }
}

async function sticker(c) {
  const { ctx, jid, m, p, sender } = c;
  const media = findMedia(m);
  if (!media) return c.reply(`Kirim gambar/video dengan caption ${p}s, atau reply gambar/video lalu ketik ${p}s`);
  if (media.type === 'video' && media.seconds > 10) return c.reply('Video maksimal 10 detik ya.');
  if (isCooling(ctx, 'stk:' + sender, 3000)) return c.reply(COOLDOWN_MSG);
  markCool(ctx, 'stk:' + sender);
  try {
    const buf = await fetchMediaBuffer(ctx, media);
    if (buf.length > 15 * 1024 * 1024) return c.reply('File terlalu besar (maks 15MB).');
    const out = media.type === 'video' ? await videoToSticker(buf) : await imageToSticker(buf);
    return await send(ctx, jid, { sticker: out }, m);
  } catch (e) { return c.reply('❌ ' + (e.message || 'Gagal membuat stiker.')); }
}

/* ---------- pengingat & absen ---------- */
function remind(c) {
  const { d, ctx, jid, sender, p, parts } = c;
  const ms = parseDuration(parts[0]);
  const msg = parts.slice(1).join(' ').trim();
  if (!ms || !msg) return c.reply(`Format: ${p}ingatkan 10m bayar listrik\nSatuan: m = menit, j = jam, d = hari (maks 30 hari).`);
  if (d.reminders.length >= 50) return c.reply('Terlalu banyak pengingat aktif.');
  d.reminders.push({ jid, who: sender, text: clip(msg, 300), at: Date.now() + ms });
  ctx.save();
  return c.reply(`✅ Oke, aku ingatkan ${parts[0]} lagi: "${clip(msg, 100)}"`);
}

async function absen(c) {
  const { d, ctx, m, jid, sender, p, parts, cmd, isGroup, isOwner } = c;
  if (!isGroup) return c.reply('Absen hanya bisa di grup.');
  const a = d.absen[jid];
  const sub = (parts[0] || '').toLowerCase();
  const names = x => Object.values(x.names).map((n, i) => `${i + 1}. ${n}`).join('\n');

  if (cmd === 'absen' && (sub === 'mulai' || sub === 'selesai')) {
    let admin = isOwner;
    if (!admin) { try { admin = (await groupInfo(ctx, jid)).admins.includes(sender); } catch (e) {} }
    if (!admin) return c.reply('Hanya admin grup/owner yang bisa membuka/menutup absen.');
    if (sub === 'mulai') {
      d.absen[jid] = { title: clip(parts.slice(1).join(' '), 60) || 'Absen', names: {} };
      ctx.save();
      return c.reply(`📋 *${d.absen[jid].title}* dibuka!\nKetik ${p}hadir untuk absen.`);
    }
    if (!a) return c.reply('Belum ada absen yang dibuka.');
    delete d.absen[jid]; ctx.save();
    return c.reply(`📋 *${a.title}* ditutup. Total hadir: ${Object.keys(a.names).length}\n` + names(a));
  }
  if (!a) return c.reply(`Belum ada absen. Admin ketik ${p}absen mulai <judul>.`);
  if (cmd === 'hadir') {
    a.names[sender] = clip(m.pushName || sender, 40); ctx.save();
    return c.reply(`✅ ${a.names[sender]} tercatat hadir (${Object.keys(a.names).length}).`);
  }
  return c.reply(`📋 *${a.title}*\n` + (names(a) || 'Belum ada yang hadir.'));
}

/* ---------- khusus owner ---------- */
function orders(c) {
  const { d, ctx, p, parts } = c;
  if (!c.isOwner) return;
  if (parts[0] === 'selesai' && Number(parts[1])) {
    const o = d.orders.find(x => x.no === Number(parts[1]));
    if (!o) return c.reply('Nomor pesanan tidak ditemukan.');
    o.done = true; ctx.save();
    return c.reply(`✅ Pesanan #${o.no} ditandai selesai.`);
  }
  const open = d.orders.filter(o => !o.done).slice(-15);
  return c.reply(open.length ? '*Pesanan belum selesai*\n\n' + open.map(o => `#${o.no} — wa.me/${o.from}\n${o.text}`).join('\n\n') + `\n\nTandai selesai: ${p}pesanan selesai <no>` : 'Tidak ada pesanan yang menunggu. 🎉');
}

async function broadcast(c) {
  const { ctx, d, meta, rest, p } = c;
  if (!c.isOwner) return;
  if (c.isGlobal) return c.reply('Broadcast hanya tersedia di Sender Personal (nomor WhatsApp sendiri).');
  if (!rest) return c.reply(`Format: ${p}bc isi pesan`);
  if (ctx.limits.broadcasting) return c.reply('Broadcast sebelumnya masih berjalan.');
  const targets = d.contacts.slice(-200);
  if (!targets.length) return c.reply('Belum ada kontak yang pernah chat ke bot ini.');
  ctx.limits.broadcasting = true;
  await c.reply(`📣 Mengirim ke ${targets.length} kontak (pelan-pelan biar aman)...`);
  let ok = 0;
  for (const t of targets) {
    try { await send(ctx, t, { text: clip(rest, 1500) }); ok++; } catch (e) {}
    await sleep(1500 + Math.floor(Math.random() * 1500));
    if (isExpired(meta) || ctx.stopped) break;
  }
  ctx.limits.broadcasting = false;
  return c.reply(`Broadcast selesai: ${ok}/${targets.length} terkirim.`);
}

/* Push kontak: kirim pesan pribadi ke semua member sebuah grup, pelan-pelan supaya nomor tidak mudah kena blokir. */
const PUSH_MAX = 100;
const PUSH_DELAY = Number(process.env.BOT_PUSH_DELAY_MS) || 4000; // jeda dasar; ditambah acak 0–PUSH_DELAY
async function pushKontak(c) {
  const { ctx, jid, p, rest } = c;
  if (!c.isOwner) return;
  if (!c.isGroup) return c.reply(`Perintah ini dipakai di dalam grup yang membernya mau dikirimi pesan.\nFormat: ${p}pushkontak isi pesan`);
  if ((c.parts[0] || '').toLowerCase() === 'stop') {
    if (!ctx.limits.pushing) return c.reply('Tidak ada push kontak yang sedang berjalan.');
    ctx.limits.pushStop = true;
    return c.reply('⏹️ Push kontak akan dihentikan setelah pesan yang sedang dikirim.');
  }
  if (!rest) return c.reply(`Format: ${p}pushkontak isi pesan\nHentikan: ${p}pushkontak stop`);
  const personal = c.isGlobal ? require('./personal') : null; // lazy: hindari import melingkar
  if (c.isGlobal && !personal.poolRuntimes().length) return c.reply('Push kontak belum bisa dipakai: belum ada nomor sender yang tersedia di pool. Coba lagi nanti.');
  if (ctx.limits.pushing) return c.reply('Push kontak sebelumnya masih berjalan.');

  let g;
  try { g = await groupInfo(ctx, jid); } catch (e) { return c.reply('Gagal mengambil daftar member grup.'); }
  const skip = new Set([g.me, c.sender, ...c.cfg.owners]);
  const targets = [...new Set(g.members)].filter(j => !skip.has(j.split('@')[0])).slice(0, PUSH_MAX);
  if (!targets.length) return c.reply('Tidak ada member yang bisa dikirimi pesan.');

  ctx.limits.pushing = true; ctx.limits.pushStop = false;
  await c.reply(`📤 Mengirim ke ${targets.length} member (maks ${PUSH_MAX} per perintah). Jeda 4–8 detik per pesan, perkiraan ${Math.ceil(targets.length * 6 / 60)} menit.\nHentikan: ${p}pushkontak stop`);
  let ok = 0;
  try {
    for (const t of targets) {
      try {
        // Global: tiap pesan dikirim dari nomor acak di pool (bukan dari nomor pusat, supaya nomor pusat aman)
        const via = c.isGlobal ? personal.pickFromPool(t.split('@')[0]) : ctx;
        if (!via) break; // pool habis di tengah jalan
        await send(via, t, { text: clip(rest, 1500) }); ok++;
      } catch (e) {}
      await sleep(PUSH_DELAY + Math.floor(Math.random() * PUSH_DELAY));
      if (isExpired(c.meta) || ctx.stopped || ctx.limits.pushStop) break;
    }
  } finally { ctx.limits.pushing = false; ctx.limits.pushStop = false; }
  return c.reply(`Push kontak selesai: ${ok}/${targets.length} terkirim.`);
}

/* .pool on|off — izinkan/cabut nomor Personal ini dipakai Sender Global (Push Kontak). Hanya owner, hanya Personal. */
function pool(c) {
  const { cfg, ctx, p, parts } = c;
  if (!c.isOwner || c.isGlobal) return;
  if (process.env.WORKER_SECRET && !process.env.WORKER_URLS) return c.reply('Pool Sender Global belum tersedia untuk sender di server ini.');
  const a = (parts[0] || '').toLowerCase();
  if (a === 'on' || a === 'off') { cfg.sharePool = a === 'on'; ctx.save(); }
  return c.reply(cfg.sharePool
    ? `🔄 Pool Sender Global: *AKTIF*. Nomor bot ini boleh dipakai acak untuk Push Kontak bot Global.\nMatikan: ${p}pool off`
    : `🔄 Pool Sender Global: *MATI*. Nomor bot ini tidak dipakai bot lain.\nAktifkan: ${p}pool on`);
}

/* ---------- daftar perintah ---------- */
const COMMANDS = [
  { names: ['menu', 'help', 'start', 'star'], run: menu },
  { names: ['ping'], run: ping },
  { names: ['katalog', 'produk'], feature: 'catalog', run: katalog },
  { names: ['faq'], feature: 'faq', run: faq },
  { names: ['ai'], feature: 'ai', run: ai },
  { names: ['dl', 'download'], feature: 'downloader', run: download },
  { names: ['brat'], feature: 'sticker', run: brat },
  { names: ['s', 'sticker', 'stiker'], feature: 'sticker', run: sticker },
  { names: ['ingatkan'], feature: 'reminder', run: remind },
  { names: ['absen', 'hadir'], feature: 'reminder', run: absen },
  { names: ['pesanan'], feature: 'orderbot', run: orders },
  { names: ['bc', 'broadcast'], feature: 'broadcast', run: broadcast },
  { names: ['pushkontak', 'push'], feature: 'pushkontak', run: pushKontak },
  { names: ['pool'], run: pool },
];

function findCommand(cmd, has) {
  return COMMANDS.find(x => x.names.includes(cmd) && (!x.feature || has(x.feature)));
}

module.exports = { COMMANDS, findCommand };
