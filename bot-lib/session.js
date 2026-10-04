/**
 * Koneksi WhatsApp (Baileys) yang dipakai bersama oleh sender Personal dan Global:
 * buat socket, sambungkan event pesan, sambung ulang otomatis, minta kode pairing.
 */
const fs = require('fs');
const { sleep } = require('./util');
const { loadBaileys } = require('./media');

/** State dasar sebuah runtime (satu koneksi WhatsApp). */
function newRuntime(sock, extra) {
  const shared = require('./shared');
  return {
    sock, status: 'connecting', code: '', qr: '', err: '', stopped: false,
    askAI: shared.askAI,
    sentIds: new Set(), cool: new Map(), groupCache: new Map(),
    limits: { downloading: 0, broadcasting: false, pushing: false, pushStop: false },
    ...(extra || {}),
  };
}

async function loadLibs() {
  try { return { baileys: await loadBaileys(), pino: require('pino') }; }
  catch (e) {
    console.error('[bot-sender] gagal memuat Baileys/pino:', e && e.code, e && e.message);
    const miss = e && (e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_MODULE_NOT_FOUND');
    throw new Error((miss ? 'Library Baileys belum terpasang di server (npm i @whiskeysockets/baileys pino).' : 'Library Baileys gagal dimuat di server.') + ' Detail: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200));
  }
}

/**
 * Buka koneksi. Opsi:
 *   authDir, pairPhone?          folder sesi, nomor untuk kode pairing (kalau belum terhubung)
 *   qrLeft?                      angka = mode QR (tanpa nomor), nilainya sisa sambung ulang QR
 *   makeRuntime(sock) -> ctx     buat & daftarkan runtime
 *   onMessage(ctx,m), onGroup(ctx,ev)
 *   onOpen(ctx), onLoggedOut(ctx)
 *   isDead(ctx)                  true kalau tidak boleh sambung ulang (mis. masa sewa habis)
 *   reconnect(ctx, unregistered) dipanggil untuk sambung ulang
 */
async function connect(o) {
  const { baileys, pino } = await loadLibs();
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } = baileys;

  fs.mkdirSync(o.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(o.authDir);
  let version; try { version = (await fetchLatestBaileysVersion()).version; } catch (e) {}
  const logger = pino({ level: 'silent' });
  // Simpan pesan yang baru dikirim supaya bisa dikirim ulang saat penerima gagal mendekripsi
  // ("Menunggu pesan ini..."). Tanpa getMessage, permintaan retry dari WhatsApp tidak bisa dijawab.
  const sentCache = new Map();
  const sock = makeWASocket({
    version, logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: false, syncFullHistory: false,
    getMessage: async key => (key && sentCache.get(key.id)) || undefined,
  });
  const rawSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, opts) => {
    const r = await rawSend(jid, content, opts);
    try {
      if (r && r.key && r.key.id && r.message) {
        sentCache.set(r.key.id, r.message);
        if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value);
      }
    } catch (e) {}
    return r;
  };
  const ctx = o.makeRuntime(sock);

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) o.onMessage(ctx, m).catch(e => console.error('[bot-sender]', e.message));
  });
  sock.ev.on('group-participants.update', ev => o.onGroup(ctx, ev).catch(() => {}));
  const qrMode = typeof o.qrLeft === 'number'; // pairing lewat QR (qrLeft = sisa percobaan sambung ulang)
  sock.ev.on('connection.update', async u => {
    if (ctx.stopped) return;
    if (u.qr && qrMode && !state.creds.registered) { ctx.qr = u.qr; ctx.status = 'pairing'; }
    if (u.connection === 'open') {
      ctx.status = 'connected'; ctx.code = ''; ctx.qr = ''; ctx.err = '';
      o.onOpen(ctx);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) {
        ctx.status = 'idle'; ctx.stopped = true;
        fs.rmSync(o.authDir, { recursive: true, force: true });
        o.onLoggedOut(ctx);
      } else if (o.isDead(ctx)) {
        ctx.status = 'expired'; ctx.stopped = true;
      } else if (qrMode && !state.creds.registered && o.qrLeft <= 0) {
        ctx.status = 'idle'; ctx.stopped = true; ctx.qr = '';
        ctx.err = 'QR kedaluwarsa. Tekan Start Pairing untuk membuat QR baru.';
      } else {
        ctx.status = 'connecting';
        await sleep(3000);
        if (!ctx.stopped) o.reconnect(ctx, !state.creds.registered).catch(e => { ctx.err = e.message; });
      }
    }
  });

  if (o.pairPhone && !state.creds.registered) {
    await new Promise(r => {
      const t = setTimeout(r, 3000);
      sock.ev.on('connection.update', u => { if (u.connection === 'connecting' || u.qr) { clearTimeout(t); r(); } });
    });
    await sleep(500);
    ctx.code = await sock.requestPairingCode(o.pairPhone);
    ctx.status = 'pairing';
  } else if (qrMode && !state.creds.registered) {
    // tunggu QR pertama dari WhatsApp (diperbarui otomatis lewat event connection.update)
    await new Promise(r => {
      const t = setTimeout(r, 15000);
      const h = u => { if (u.qr) { clearTimeout(t); sock.ev.off('connection.update', h); r(); } };
      sock.ev.on('connection.update', h);
    });
    if (!ctx.qr) throw new Error('QR belum siap dari WhatsApp. Coba lagi sebentar.');
    ctx.status = 'pairing';
  }
  return ctx;
}

/** Hentikan sebuah runtime (logout = keluar dari perangkat tertaut WhatsApp). */
function stopSocket(ctx, logout) {
  if (!ctx) return;
  ctx.stopped = true;
  const done = () => { try { ctx.sock.end(undefined); } catch (e) {} };
  if (logout) ctx.sock.logout().catch(() => {}).finally(done); else done();
}

module.exports = { newRuntime, connect, stopSocket };
