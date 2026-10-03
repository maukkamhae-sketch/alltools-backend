/**
 * Shop backend (versi minimal).
 * Katalog titel & pembelian sudah ditangani langsung di server.js
 * (/api/shop/items dan POST order type 'shop'). Modul ini hanya menambah
 * riwayat pembelian item toko milik user: GET /api/shop/mine
 */
function registerShop(app, { db, requireAuth }) {
  app.get('/api/shop/mine', requireAuth, (req, res) => {
    const orders = db.getOrdersForUser(req.user.id, 100)
      .filter(o => o && o.type === 'shop')
      .map(o => ({
        id: o.id || o.orderId || '',
        name: o.itemName || o.label || 'Item toko',
        price: o.price || 0,
        status: o.status || '',
        createdAt: o.createdAt || '',
        note: o.status === 'paid'
          ? (o.itemKind === 'role' ? `Titel ${o.roleBadge} sudah aktif.` : (o.itemNote || 'Sudah dikonfirmasi.'))
          : '',
      }));
    res.json({ orders });
  });
}

module.exports = { registerShop };
