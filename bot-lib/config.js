/**
 * Pengaturan bot (config) dan data bot (pesanan, pengingat, dll).
 * cleanConfig membersihkan input dari user supaya aman disimpan.
 */
const { clip, digits } = require('./util');

function defaultConfig() {
  return {
    prefix: '.',
    owners: [],
    aiPrompt: '',
    autoreply: { rules: [], fallback: '' },
    welcome: { text: 'Selamat datang @user di @group! 🎉 Baca deskripsi grup ya.' },
    catalog: { title: 'Katalog', items: [] },
    antilink: { kick: false },
    sharePool: false, // izinkan nomor sender Personal ini dipakai Sender Global untuk Push Kontak (opt-in)
    faq: [],
    orderbot: { keywords: ['order', 'pesan', 'beli', 'mau beli'], reply: 'Terima kasih! Pesananmu sudah kami catat ✅ Admin akan segera menghubungi.' },
  };
}

function defaultData() {
  return { orders: [], reminders: [], contacts: [], absen: {}, warns: {}, ai: { day: '', n: 0 } };
}

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
  if (i.sharePool !== undefined) c.sharePool = !!i.sharePool;
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

module.exports = { defaultConfig, defaultData, cleanConfig };
