/**
 * Urusan media: download video (yt-dlp), stiker gambar/video, stiker brat,
 * dan pemuat Baileys.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { clip, xmlEsc } = require('./util');

const tmpBase = prefix => path.join(os.tmpdir(), prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));

/* ---------- Downloader (yt-dlp) ---------- */
function downloadVideo(url) {
  return new Promise((resolve, reject) => {
    const base = tmpBase('botdl');
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

/* ---------- Stiker ---------- */
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

async function imageToSticker(buf) {
  return getSharp()(buf, { animated: false })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
}

function videoToSticker(buf) {
  return new Promise((resolve, reject) => {
    const base = tmpBase('stk');
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
  const perLine = Math.max(1, Math.floor(maxW / (size * 0.5))); // perkiraan lebar karakter
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

/* ---------- Baileys ----------
   Baileys versi baru berupa ES Module, yang tidak bisa dimuat dengan require().
   import() dinamis bisa memuat ES Module maupun CommonJS, lalu bentuknya diseragamkan. */
let baileysMod = null;
async function loadBaileys() {
  if (baileysMod) return baileysMod;
  const ns = await import('@whiskeysockets/baileys');
  const d = ns.default;
  const pick = k => (ns[k] !== undefined ? ns[k] : (d && d[k]));
  const makeWASocket = typeof d === 'function' ? d : ((d && typeof d.default === 'function') ? d.default : ns.makeWASocket);
  if (typeof makeWASocket !== 'function') throw new Error('bentuk export Baileys tidak dikenali');
  baileysMod = {
    makeWASocket,
    useMultiFileAuthState: pick('useMultiFileAuthState'),
    DisconnectReason: pick('DisconnectReason'),
    fetchLatestBaileysVersion: pick('fetchLatestBaileysVersion'),
    Browsers: pick('Browsers'),
    makeCacheableSignalKeyStore: pick('makeCacheableSignalKeyStore'),
    downloadMediaMessage: pick('downloadMediaMessage'),
  };
  return baileysMod;
}

async function fetchMediaBuffer(ctx, media) {
  const { downloadMediaMessage } = await loadBaileys();
  return downloadMediaMessage(media.msg, 'buffer', {}, { logger: require('pino')({ level: 'silent' }), reuploadRequest: ctx.sock.updateMediaMessage });
}

module.exports = { downloadVideo, findMedia, imageToSticker, videoToSticker, makeBrat, loadBaileys, fetchMediaBuffer };
