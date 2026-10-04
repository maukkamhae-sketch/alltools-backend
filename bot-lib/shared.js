/**
 * Ketergantungan dari server.js yang diisi sekali saat registerBotSender dipanggil.
 */
module.exports = {
  db: null,
  askAI: async () => { throw new Error('AI belum aktif'); },
  // dari server.js: () => ({ online, windows, nextOnAt, offMessage })
  globalStatus: () => ({ online: true, windows: [], nextOnAt: null, offMessage: '' }),
};
