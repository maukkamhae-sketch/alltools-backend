/**
 * Bot Sender — pintu masuk. Kode aslinya ada di folder bot-lib/:
 *
 *   util.js       konstanta & fungsi kecil
 *   config.js     pengaturan bot (default + pembersih input)
 *   store.js      simpan/muat data tiap bot
 *   media.js      downloader, stiker, brat, Baileys
 *   messaging.js  kirim pesan, info grup, menu
 *   commands.js   semua perintah (.menu .ai .dl .s ...)
 *   handler.js    alur pemrosesan pesan masuk
 *   session.js    koneksi WhatsApp (dipakai Personal & Global)
 *   personal.js   Sender Personal (nomor WA sendiri)
 *   global.js     Sender Global (nomor pusat, .daftar/.pasang/.lepas, jadwal jeda)
 *   routes.js     endpoint Express
 *
 * Pasang di server.js:
 *   const { registerBotSender } = require('./bot-sender');
 *   registerBotSender(app, { db, requireAuth, requireOwner, askAI: askGemini, globalBotStatus });
 *
 * Dependency:  npm i @whiskeysockets/baileys pino sharp
 * Fitur sticker: sharp (gambar & .brat). Sticker dari video butuh ffmpeg di server.
 * .brat butuh font di server (mis. DejaVu / Liberation) supaya teks tampil.
 * Fitur downloader butuh yt-dlp di server.
 * Menu bergambar: taruh menu.jpg di folder yang sama dengan file ini.
 *
 * Data (sesi, pengaturan, pesanan, pengingat) disimpan di DATA_DIR/bot-sessions/<botId>/
 * supaya tidak bergantung pada bentuk db.js.
 */
const fs = require('fs');
const shared = require('./bot-lib/shared');
const { ROOT } = require('./bot-lib/util');
const personal = require('./bot-lib/personal');
const global = require('./bot-lib/global');
const { registerRoutes } = require('./bot-lib/routes');

function registerBotSender(app, opts) {
  shared.db = opts.db;
  if (opts.askAI) shared.askAI = opts.askAI;
  if (opts.globalBotStatus) shared.globalStatus = opts.globalBotStatus;
  fs.mkdirSync(ROOT, { recursive: true });

  registerRoutes(app, opts);

  // Pulihkan sender yang sudah pernah terpasang setelah server restart.
  (async () => {
    await global.restore();
    await personal.restoreAll([global.GLOBAL_ID]);
  })();

  // Scheduler: pengingat jatuh tempo + hentikan bot yang masa sewanya habis.
  setInterval(() => {
    personal.tick().catch(e => console.error('[bot-sender] tick personal:', e.message));
    global.tick().catch(e => console.error('[bot-sender] tick global:', e.message));
  }, 15000).unref();
}

/* __test: dipakai untuk uji otomatis tanpa koneksi WhatsApp */
const { onMessage, onGroupUpdate } = require('./bot-lib/handler');
const { cleanConfig, defaultConfig, defaultData } = require('./bot-lib/config');
const { parseDuration, findFaq, isSafeUrl, getText } = require('./bot-lib/util');
const { menuText, sendMenu } = require('./bot-lib/messaging');
const { loadBaileys, findMedia, makeBrat, imageToSticker } = require('./bot-lib/media');

module.exports = {
  registerBotSender,
  __test: { onMessage, onGroupUpdate, cleanConfig, defaultConfig, defaultData, parseDuration, findFaq, isSafeUrl, getText, menuText, sendMenu, loadBaileys, findMedia, makeBrat, imageToSticker, global },
};
