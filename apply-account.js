// Menambal server.js untuk fitur bantuan akun (tab "Akun" di /admin).
// Aman: cek semua titik dulu, simpan cadangan server.js.bak2, dan berhenti kalau ada yang tidak cocok.
// Jalankan setelah apply-redeem.js:  node apply-account.js server.js
const fs = require('fs');
const FILE = process.argv[2] || 'server.js';
let s = fs.readFileSync(FILE, 'utf8');
if (s.includes('account-backend')) { console.log('Sudah ditambal sebelumnya, tidak ada yang diubah.'); process.exit(0); }

const edits = [
  [ "const { registerRedeem } = require('./redeem-backend');",
    "const { registerRedeem } = require('./redeem-backend');\nconst { registerAccountAdmin } = require('./account-backend');" ],
  // sesi yang dikeluarkan Owner (reset password / logout semua) tidak berlaku lagi
  [ "    db.resetQuotaIfNewDay(user);\n    req.user = user;",
    "    if (user.tokensRevokedAt && (payload.iat || 0) < Math.floor(user.tokensRevokedAt / 1000)) {\n      return res.status(401).json({ error: 'Sesi login tidak valid, coba masuk lagi.' });\n    }\n    db.resetQuotaIfNewDay(user);\n    req.user = user;" ],
  [ "redeemApi = registerRedeem(app, { db, requireAuth, requireOwner });",
    "redeemApi = registerRedeem(app, { db, requireAuth, requireOwner });\nregisterAccountAdmin(app, { db, requireOwner });" ],
];

for (const [from] of edits) {
  const n = s.split(from).length - 1;
  if (n !== 1) {
    console.error('GAGAL: titik tambal tidak cocok (ditemukan ' + n + 'x) untuk:\n' + from.split('\n')[0]);
    console.error('server.js TIDAK diubah. Kirim pesan ini ke Claude.');
    process.exit(1);
  }
}
fs.writeFileSync(FILE + '.bak2', s);
for (const [from, to] of edits) s = s.replace(from, () => to);
fs.writeFileSync(FILE, s);
console.log('Berhasil. Cadangan: ' + FILE + '.bak2');
