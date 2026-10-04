// Menambal server.js untuk fitur kode redeem. Aman: cek semua titik dulu,
// simpan cadangan server.js.bak, dan berhenti kalau ada yang tidak cocok.
const fs = require('fs');
const FILE = process.argv[2] || 'server.js';
let s = fs.readFileSync(FILE, 'utf8');
if (s.includes('redeem-backend')) { console.log('Sudah ditambal sebelumnya, tidak ada yang diubah.'); process.exit(0); }

const edits = [
  [ "const { registerPush } = require('./push-backend');",
    "const { registerPush } = require('./push-backend');\nconst { registerRedeem } = require('./redeem-backend');\nlet redeemApi = null;" ],
  [ "  const uniqueCode = 1 + Math.floor(Math.random() * 99);\n  const total = price + uniqueCode;",
    "  let promo = null;\n  if (redeemApi) {\n    const r = redeemApi.applyPromo(req.user.id, extra.type, price);\n    if (r) { promo = r; price = r.price; label = `${label} (kode ${r.code})`; }\n  }\n  const uniqueCode = 1 + Math.floor(Math.random() * 99);\n  const total = price + uniqueCode;" ],
  [ "    status: 'awaiting_payment', createdAt: new Date().toISOString(), ...extra,\n  });\n  res.json({ orderId, label, total, dana: getDanaNumber() });",
    "    status: 'awaiting_payment', createdAt: new Date().toISOString(), ...extra,\n    ...(promo ? { promoCode: promo.code, promoDiscount: promo.discount } : {}),\n  });\n  if (promo && redeemApi) redeemApi.reserve(req.user.id, promo.code, orderId);\n  res.json({ orderId, label, total, dana: getDanaNumber(), discount: promo ? promo.discount : 0 });" ],
  [ "  if (action === 'ok') {\n    order.status = 'paid';\n    db.saveOrder(order);",
    "  if (action === 'ok') {\n    order.status = 'paid';\n    db.saveOrder(order);\n    if (redeemApi) redeemApi.onSettle(order, 'ok');" ],
  [ "  order.status = 'failed';\n  db.saveOrder(order);\n  return { ok: true, note: '❌ Pesanan ditolak.' };",
    "  order.status = 'failed';\n  db.saveOrder(order);\n  if (redeemApi) redeemApi.onSettle(order, 'no');\n  return { ok: true, note: '❌ Pesanan ditolak.' };" ],
  [ "registerPush(app, { db, requireAuth, requireOwner });",
    "registerPush(app, { db, requireAuth, requireOwner });\nredeemApi = registerRedeem(app, { db, requireAuth, requireOwner });" ],
];

for (const [from] of edits) {
  const n = s.split(from).length - 1;
  if (n !== 1) {
    console.error('GAGAL: titik tambal tidak cocok (ditemukan ' + n + 'x) untuk:\n' + from.split('\n')[0]);
    console.error('server.js TIDAK diubah. Kirim pesan ini ke Claude.');
    process.exit(1);
  }
}
fs.writeFileSync(FILE + '.bak', s);
for (const [from, to] of edits) s = s.replace(from, () => to);
fs.writeFileSync(FILE, s);
console.log('Berhasil. Cadangan: ' + FILE + '.bak');
